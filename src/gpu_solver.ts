import type { EqualityConstraint, Type } from "./types.ts";
import {
  awaitCompilerGpuCommand,
  CompilerGpuCapacityError,
  type CompilerGpuCapacityRequest,
  type CompilerGpuSchedulingPolicy,
  type CompilerGpuSubmissionMetrics,
  CompilerGpuUnavailableError,
  createCompilerGpuBatchQueue,
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requestCompilerGpuDevice,
  requireCompilerGpuCapacity,
  submitCompilerGpuCommand,
} from "./gpu_device.ts";

export type GpuSolveResult =
  | {
    readonly status: "solved";
    readonly representatives: readonly number[];
    readonly termCount: number;
    readonly equalityCount: number;
    readonly unionRounds: number;
    readonly decompositionCount: number;
    readonly submissionBatchSize?: number;
    readonly payloadBatchSize?: number;
    readonly queueWaitMilliseconds?: number;
  }
  | {
    readonly status: "constructorClash";
    readonly left: string;
    readonly right: string;
    readonly sourceStart: number;
  }
  | { readonly status: "infiniteType"; readonly representative: number }
  | { readonly status: "unavailable"; readonly reason: string };

type FlatTerm = {
  readonly kind: "variable" | "constructor";
  readonly label: string;
  readonly children: readonly number[];
};

type FlatConstraints = {
  readonly terms: readonly FlatTerm[];
  readonly equalities: readonly [number, number][];
  readonly sourceStarts: readonly number[];
};

type ConstructorDecomposition =
  | {
    readonly status: "completed";
    readonly clash: readonly [number, number] | undefined;
    readonly equalities: readonly {
      readonly equality: [number, number];
      readonly constructors: readonly [number, number];
    }[];
  }
  | { readonly status: "unavailable"; readonly reason: string };

type UnionPipelines = {
  readonly union: GPUComputePipeline;
  readonly compression: GPUComputePipeline;
};

type DecompositionPipelines = {
  readonly count: GPUComputePipeline;
  readonly scan: GPUComputePipeline;
  readonly emit: GPUComputePipeline;
};

type ReachabilityPipeline = {
  readonly pipeline: GPUComputePipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
};

type UnionGpuInput = {
  readonly device: GPUDevice;
  readonly initialRepresentatives: readonly number[];
  readonly equalities: readonly [number, number][];
};

type UnionGpuOutput = {
  readonly result: {
    readonly representatives: number[];
    readonly rounds: number;
  };
  readonly submission: CompilerGpuSubmissionMetrics;
};

const maximumDecomposedEqualityCount = 1_048_576;
// Constructor pairing allocates and scans n² slots. Above 64 terms, measured
// compiler graphs are faster through linear grouping followed by GPU union.
const maximumQuadraticGpuTermCount = 64;

const unionShader = `
@group(0) @binding(0) var<storage, read_write> parents: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read> equality_words: array<u32>;

fn find_root(start: u32) -> u32 {
  var current = start;
  for (var step = 0u; step < arrayLength(&parents); step += 1u) {
    let parent = atomicLoad(&parents[current]);
    if (parent == current) { return current; }
    current = parent;
  }
  return current;
}

@compute @workgroup_size(64)
fn union_equalities(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let equality_index = invocation.x;
  if (equality_index * 2u + 1u >= arrayLength(&equality_words)) { return; }
  var left = equality_words[equality_index * 2u];
  var right = equality_words[equality_index * 2u + 1u];
  loop {
    left = find_root(left);
    right = find_root(right);
    if (left == right) { return; }
    let lower = min(left, right);
    let higher = max(left, right);
    let exchanged = atomicCompareExchangeWeak(&parents[higher], higher, lower);
    if (exchanged.exchanged) { return; }
  }
}

@compute @workgroup_size(64)
fn compress_paths(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let term = invocation.x;
  if (term >= arrayLength(&parents)) { return; }
  atomicStore(&parents[term], find_root(term));
}
`;

const reachabilityShader = `
struct Parameters { term_count: u32, pivot: u32 }
@group(0) @binding(0) var<storage, read_write> reachability: array<atomic<u32>>;
@group(0) @binding(1) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn close_reachability(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let count = parameters.term_count;
  if (index >= count * count) { return; }
  let row = index / count;
  let column = index % count;
  let left = atomicLoad(&reachability[row * count + parameters.pivot]);
  let right = atomicLoad(&reachability[parameters.pivot * count + column]);
  if (left != 0u && right != 0u) { atomicStore(&reachability[index], 1u); }
}
`;

const constructorCountShader = `
struct Parameters { term_count: u32, equality_capacity: u32 }
@group(0) @binding(0) var<storage, read> representatives: array<u32>;
@group(0) @binding(1) var<storage, read> term_kinds: array<u32>;
@group(0) @binding(2) var<storage, read> label_ids: array<u32>;
@group(0) @binding(3) var<storage, read> child_counts: array<u32>;
@group(0) @binding(4) var<storage, read_write> pair_counts: array<u32>;
@group(0) @binding(5) var<storage, read_write> clash_pair: atomic<u32>;
@group(0) @binding(6) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn count_constructor_pairs(
  @builtin(global_invocation_id) invocation: vec3<u32>
) {
  let pair_index = invocation.x;
  let pair_count = parameters.term_count * parameters.term_count;
  if (pair_index >= pair_count) { return; }
  let left = pair_index / parameters.term_count;
  let right = pair_index % parameters.term_count;
  if (left >= right || term_kinds[left] == 0u || term_kinds[right] == 0u) {
    return;
  }
  if (representatives[left] != representatives[right]) { return; }
  if (
    label_ids[left] != label_ids[right] ||
    child_counts[left] != child_counts[right]
  ) {
    atomicMin(&clash_pair, pair_index);
    return;
  }
  pair_counts[pair_index] = child_counts[left];
}
`;

const constructorScanShader = `
struct Parameters { count: u32, distance: u32 }
@group(0) @binding(0) var<storage, read> input_prefixes: array<u32>;
@group(0) @binding(1) var<storage, read_write> output_prefixes: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn scan_step(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  var prefix = input_prefixes[index];
  if (index >= parameters.distance) {
    prefix += input_prefixes[index - parameters.distance];
  }
  output_prefixes[index] = prefix;
}
`;

const constructorEmitShader = `
struct Parameters { term_count: u32, equality_capacity: u32 }
@group(0) @binding(0) var<storage, read> child_starts: array<u32>;
@group(0) @binding(1) var<storage, read> children: array<u32>;
@group(0) @binding(2) var<storage, read> pair_counts: array<u32>;
@group(0) @binding(3) var<storage, read> inclusive_offsets: array<u32>;
@group(0) @binding(4) var<storage, read_write> output_equalities: array<u32>;
@group(0) @binding(5) var<storage, read_write> output_parent_pairs: array<u32>;
@group(0) @binding(6) var<storage, read_write> overflow_count: atomic<u32>;
@group(0) @binding(7) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn emit_child_equalities(
  @builtin(global_invocation_id) invocation: vec3<u32>
) {
  let pair_index = invocation.x;
  let pair_slot_count = parameters.term_count * parameters.term_count;
  if (pair_index >= pair_slot_count) { return; }
  let count = pair_counts[pair_index];
  if (count == 0u) { return; }
  let output_start = inclusive_offsets[pair_index] - count;
  if (output_start + count > parameters.equality_capacity) {
    atomicMax(&overflow_count, output_start + count);
    return;
  }
  let left = pair_index / parameters.term_count;
  let right = pair_index % parameters.term_count;
  let left_start = child_starts[left];
  let right_start = child_starts[right];
  for (var child_index = 0u; child_index < count; child_index += 1u) {
    let output_index = output_start + child_index;
    output_equalities[output_index * 2u] = children[left_start + child_index];
    output_equalities[output_index * 2u + 1u] =
      children[right_start + child_index];
    output_parent_pairs[output_index] = pair_index;
  }
}
`;

let pipelineDevice: GPUDevice | undefined;
let unionPipelinesPromise: Promise<UnionPipelines> | undefined;
let decompositionPipelinesPromise: Promise<DecompositionPipelines> | undefined;
let reachabilityPipelinePromise: Promise<ReachabilityPipeline> | undefined;
const typeSolverBatchQueue = createCompilerGpuBatchQueue(
  (equalityBatches: readonly (readonly EqualityConstraint[])[]) =>
    Promise.all(
      equalityBatches.map((equalities) =>
        solveTypeEqualitiesWithoutPayloadBatch(equalities)
      ),
    ),
);
const unionGpuBatchQueue = createCompilerGpuBatchQueue(
  (inputs: readonly UnionGpuInput[]) =>
    inputs.length === 1
      ? Promise.all(inputs.map(runUnionOnGpuWithoutBatch))
      : runUnionGpuBatch(inputs),
);

export async function solveTypeEqualitiesOnGpu(
  equalities: readonly EqualityConstraint[],
  options: {
    readonly scheduling?: CompilerGpuSchedulingPolicy;
  } = {},
): Promise<GpuSolveResult> {
  const batch = await typeSolverBatchQueue.enqueue(
    equalities,
    options.scheduling ?? "latency",
  );
  return batch.output.status === "solved"
    ? {
      ...batch.output,
      payloadBatchSize: batch.payloadBatchSize,
      queueWaitMilliseconds: batch.queueWaitMilliseconds +
        (batch.output.queueWaitMilliseconds ?? 0),
    }
    : batch.output;
}

async function solveTypeEqualitiesWithoutPayloadBatch(
  equalities: readonly EqualityConstraint[],
): Promise<GpuSolveResult> {
  const deviceRequest = await requestCompilerGpuDevice();
  if (deviceRequest.status === "unavailable") return deviceRequest;
  const device = deviceRequest.device;
  const submissions: CompilerGpuSubmissionMetrics[] = [];
  try {
    const result = await solveTypeEqualitiesWithDevice(
      device,
      equalities,
      "latency",
      submissions,
    );
    if (result.status !== "solved") return result;
    return {
      ...result,
      submissionBatchSize: Math.max(
        0,
        ...submissions.map((submission) => submission.submissionBatchSize),
      ),
      queueWaitMilliseconds: submissions.reduce(
        (total, submission) => total + submission.queueWaitMilliseconds,
        0,
      ),
    };
  } catch (error) {
    if (
      error instanceof CompilerGpuCapacityError ||
      error instanceof CompilerGpuUnavailableError
    ) {
      return { status: "unavailable", reason: error.message };
    }
    throw error;
  }
}

async function solveTypeEqualitiesWithDevice(
  device: GPUDevice,
  equalities: readonly EqualityConstraint[],
  scheduling: CompilerGpuSchedulingPolicy,
  submissions: CompilerGpuSubmissionMetrics[],
): Promise<GpuSolveResult> {
  selectPipelineDevice(device);
  const flat = flattenEqualities(equalities);
  if (flat.terms.length === 0) {
    return {
      status: "solved",
      representatives: [],
      termCount: 0,
      equalityCount: 0,
      unionRounds: 0,
      decompositionCount: 0,
    };
  }
  if (flat.terms.length > maximumQuadraticGpuTermCount) {
    return await solveLargeFlatConstraintsOnGpu(
      device,
      flat,
      scheduling,
      submissions,
    );
  }
  const allEqualities = [...flat.equalities];
  const allSourceStarts = [...flat.sourceStarts];
  const seenEqualities = new Set(allEqualities.map(equalityKey));
  let representatives = flat.terms.map((_, index) => index);
  let unionRounds = 0;
  let decompositionCount = 0;

  while (true) {
    const union = await unionOnGpu(
      device,
      representatives,
      allEqualities,
      scheduling,
      submissions,
    );
    representatives = union.representatives;
    unionRounds += union.rounds;
    const decomposition = await decomposeConstructorsOnGpu(
      device,
      flat.terms,
      representatives,
      scheduling,
      submissions,
    );
    if (decomposition.status === "unavailable") {
      return { status: "unavailable", reason: decomposition.reason };
    }
    decompositionCount += decomposition.equalities.length;
    if (decomposition.clash !== undefined) {
      const [leftIndex, rightIndex] = decomposition.clash;
      const left = flat.terms[leftIndex];
      const right = flat.terms[rightIndex];
      return {
        status: "constructorClash",
        left: left.label,
        right: right.label,
        sourceStart: sourceForClass(
          [leftIndex, rightIndex],
          allEqualities,
          allSourceStarts,
        ),
      };
    }
    let added = false;
    for (const generated of decomposition.equalities) {
      const key = equalityKey(generated.equality);
      if (seenEqualities.has(key)) continue;
      seenEqualities.add(key);
      allEqualities.push(generated.equality);
      allSourceStarts.push(
        sourceForClass(
          generated.constructors,
          allEqualities,
          allSourceStarts,
        ),
      );
      added = true;
    }
    if (!added) break;
  }

  const infiniteRepresentative = await findInfiniteTypeOnGpu(
    device,
    flat.terms,
    representatives,
    scheduling,
    submissions,
  );
  if (infiniteRepresentative !== undefined) {
    return { status: "infiniteType", representative: infiniteRepresentative };
  }
  return {
    status: "solved",
    representatives,
    termCount: flat.terms.length,
    equalityCount: allEqualities.length,
    unionRounds,
    decompositionCount,
  };
}

export async function unionPairsOnGpu(
  termCount: number,
  equalities: readonly [number, number][],
): Promise<readonly number[] | undefined> {
  if (
    !Number.isSafeInteger(termCount) || termCount < 0 ||
    termCount > 0xffff_ffff
  ) {
    throw new RangeError(
      `GPU union term count must be an integer from 0 through 4294967295; received ${termCount}`,
    );
  }
  for (const [equalityIndex, equality] of equalities.entries()) {
    for (const endpoint of equality) {
      if (
        !Number.isSafeInteger(endpoint) || endpoint < 0 ||
        endpoint >= termCount
      ) {
        throw new RangeError(
          `GPU union equality ${equalityIndex} endpoint ${endpoint} is outside term count ${termCount}`,
        );
      }
    }
  }
  if (termCount === 0) return [];
  const deviceRequest = await requestCompilerGpuDevice();
  if (deviceRequest.status === "unavailable") return undefined;
  const device = deviceRequest.device;
  selectPipelineDevice(device);
  const initialRepresentatives = Array.from(
    { length: termCount },
    (_, index) => index,
  );
  try {
    return (await unionOnGpu(
      device,
      initialRepresentatives,
      equalities,
      "latency",
      [],
    ))
      .representatives;
  } catch (error) {
    if (
      error instanceof CompilerGpuCapacityError ||
      error instanceof CompilerGpuUnavailableError
    ) return undefined;
    throw error;
  }
}

function flattenEqualities(
  equalities: readonly EqualityConstraint[],
): FlatConstraints {
  const terms: FlatTerm[] = [];
  const variableTerms = new Map<number, number>();
  const constructorTerms = new Map<string, number>();
  const pairs: [number, number][] = [];
  const sourceStarts: number[] = [];

  const flattenType = (type: Type): number => {
    if (type.kind === "variable") {
      const existing = variableTerms.get(type.id);
      if (existing !== undefined) return existing;
      const termIndex = terms.length;
      terms.push({ kind: "variable", label: `t${type.id}`, children: [] });
      variableTerms.set(type.id, termIndex);
      return termIndex;
    }
    const children = type.kind === "function"
      ? [flattenType(type.parameter), flattenType(type.result)]
      : type.arguments.map(flattenType);
    const label = type.kind === "function" ? "->" : type.name;
    const key = `${label.length}:${label}:${children.join(",")}`;
    const existing = constructorTerms.get(key);
    if (existing !== undefined) return existing;
    const termIndex = terms.length;
    terms.push({
      kind: "constructor",
      label,
      children,
    });
    constructorTerms.set(key, termIndex);
    return termIndex;
  };

  for (const equality of equalities) {
    pairs.push([flattenType(equality.left), flattenType(equality.right)]);
    sourceStarts.push(equality.span.start);
  }
  return { terms, equalities: pairs, sourceStarts };
}

async function solveLargeFlatConstraintsOnGpu(
  device: GPUDevice,
  flat: FlatConstraints,
  scheduling: CompilerGpuSchedulingPolicy,
  submissions: CompilerGpuSubmissionMetrics[],
): Promise<GpuSolveResult> {
  const allEqualities = [...flat.equalities];
  const allSourceStarts = [...flat.sourceStarts];
  const seenEqualities = new Set(allEqualities.map(equalityKey));
  const parents = flat.terms.map((_, index) => index);
  const classSourceStarts = flat.terms.map(() => Number.MAX_SAFE_INTEGER);
  const find = (term: number): number => {
    let root = term;
    while (parents[root] !== root) root = parents[root];
    let current = term;
    while (parents[current] !== current) {
      const parent = parents[current];
      parents[current] = root;
      current = parent;
    }
    return root;
  };
  const union = (
    [left, right]: readonly [number, number],
    sourceStart: number,
  ): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) {
      classSourceStarts[leftRoot] = Math.min(
        classSourceStarts[leftRoot],
        sourceStart,
      );
      return;
    }
    const lower = Math.min(leftRoot, rightRoot);
    const higher = Math.max(leftRoot, rightRoot);
    parents[higher] = lower;
    classSourceStarts[lower] = Math.min(
      classSourceStarts[leftRoot],
      classSourceStarts[rightRoot],
      sourceStart,
    );
  };
  for (const [equalityIndex, equality] of allEqualities.entries()) {
    union(equality, allSourceStarts[equalityIndex]);
  }

  let decompositionCount = 0;
  while (true) {
    const representatives = parents.map((_, index) => find(index));
    const decomposition = decomposeConstructorsByRepresentative(
      flat.terms,
      representatives,
    );
    decompositionCount += decomposition.equalities.length;
    if (decomposition.clash !== undefined) {
      const [leftIndex, rightIndex] = decomposition.clash;
      return {
        status: "constructorClash",
        left: flat.terms[leftIndex].label,
        right: flat.terms[rightIndex].label,
        sourceStart: classSourceStarts[find(leftIndex)] ===
            Number.MAX_SAFE_INTEGER
          ? 0
          : classSourceStarts[find(leftIndex)],
      };
    }
    let added = false;
    for (const generated of decomposition.equalities) {
      const key = equalityKey(generated.equality);
      if (seenEqualities.has(key)) continue;
      seenEqualities.add(key);
      const generatedSource =
        classSourceStarts[find(generated.constructors[0])] ===
            Number.MAX_SAFE_INTEGER
          ? 0
          : classSourceStarts[find(generated.constructors[0])];
      allSourceStarts.push(generatedSource);
      allEqualities.push(generated.equality);
      union(generated.equality, generatedSource);
      added = true;
    }
    if (!added) break;
  }

  const expectedRepresentatives = parents.map((_, index) => find(index));
  const gpuUnion = await unionOnGpu(
    device,
    flat.terms.map((_, index) => index),
    allEqualities,
    scheduling,
    submissions,
  );
  for (
    let termIndex = 0;
    termIndex < expectedRepresentatives.length;
    termIndex += 1
  ) {
    if (
      gpuUnion.representatives[termIndex] !==
        expectedRepresentatives[termIndex]
    ) {
      throw new Error(
        `WebGPU union representative mismatch at term ${termIndex}: expected ${
          expectedRepresentatives[termIndex]
        }, received ${gpuUnion.representatives[termIndex]}`,
      );
    }
  }
  const infiniteRepresentative = findInfiniteTypeInRepresentativeGraph(
    flat.terms,
    gpuUnion.representatives,
  );
  if (infiniteRepresentative !== undefined) {
    return { status: "infiniteType", representative: infiniteRepresentative };
  }
  return {
    status: "solved",
    representatives: gpuUnion.representatives,
    termCount: flat.terms.length,
    equalityCount: allEqualities.length,
    unionRounds: gpuUnion.rounds,
    decompositionCount,
  };
}

function decomposeConstructorsByRepresentative(
  terms: readonly FlatTerm[],
  representatives: readonly number[],
): Extract<ConstructorDecomposition, { readonly status: "completed" }> {
  const constructorByRepresentative = new Map<number, number>();
  const equalities: Extract<
    ConstructorDecomposition,
    { readonly status: "completed" }
  >["equalities"][number][] = [];
  for (const [termIndex, term] of terms.entries()) {
    if (term.kind !== "constructor") continue;
    const representative = representatives[termIndex];
    const previousIndex = constructorByRepresentative.get(representative);
    if (previousIndex === undefined) {
      constructorByRepresentative.set(representative, termIndex);
      continue;
    }
    const previous = terms[previousIndex];
    if (
      previous.label !== term.label ||
      previous.children.length !== term.children.length
    ) {
      return {
        status: "completed",
        clash: [previousIndex, termIndex],
        equalities: [],
      };
    }
    for (const [childIndex, child] of term.children.entries()) {
      equalities.push({
        equality: [previous.children[childIndex], child],
        constructors: [previousIndex, termIndex],
      });
    }
  }
  return { status: "completed", clash: undefined, equalities };
}

async function decomposeConstructorsOnGpu(
  device: GPUDevice,
  terms: readonly FlatTerm[],
  representatives: readonly number[],
  scheduling: CompilerGpuSchedulingPolicy,
  submissions: CompilerGpuSubmissionMetrics[],
): Promise<ConstructorDecomposition> {
  const termCount = terms.length;
  if (terms.filter((term) => term.kind === "constructor").length < 2) {
    return { status: "completed", clash: undefined, equalities: [] };
  }
  const pairSlotCount = termCount * termCount;
  const labels = [...new Set(terms.map((term) => term.label))].sort();
  const labelIds = new Map(labels.map((label, index) => [label, index]));
  const termKinds = new Uint32Array(
    terms.map((term) => term.kind === "constructor" ? 1 : 0),
  );
  const termLabelIds = new Uint32Array(
    terms.map((term) => labelIds.get(term.label)!),
  );
  const childStarts: number[] = [];
  const childCounts: number[] = [];
  const children: number[] = [];
  for (const term of terms) {
    childStarts.push(children.length);
    childCounts.push(term.children.length);
    children.push(...term.children);
  }
  const maximumChildCount = Math.max(1, ...childCounts);
  const equalityCapacity = Math.max(
    1,
    Math.min(
      maximumDecomposedEqualityCount,
      pairSlotCount * maximumChildCount,
    ),
  );
  requireTypeSolverGpuCapacities(device, [
    storageCapacity("constructor representatives", representatives.length * 4),
    storageCapacity("constructor term kinds", termKinds.byteLength),
    storageCapacity("constructor labels", termLabelIds.byteLength),
    storageCapacity("constructor child starts", childStarts.length * 4),
    storageCapacity("constructor child counts", childCounts.length * 4),
    storageCapacity("constructor children", Math.max(4, children.length * 4)),
    storageCapacity("constructor pair counts", pairSlotCount * 4),
    storageCapacity("constructor first prefixes", pairSlotCount * 4),
    storageCapacity("constructor second prefixes", pairSlotCount * 4),
    storageCapacity("constructor clash", 4),
    storageCapacity("constructor overflow", 4),
    storageCapacity("constructor output equalities", equalityCapacity * 8),
    storageCapacity("constructor output parents", equalityCapacity * 4),
    uniformCapacity("constructor parameters", 8),
    uniformCapacity("constructor scan parameters", 8),
    copyCapacity("constructor metadata readback", 12),
    dispatchCapacity(
      "constructor decomposition",
      Math.ceil(pairSlotCount / 64),
    ),
  ]);

  const representativeBuffer = createBuffer(
    device,
    new Uint32Array(representatives),
    GPUBufferUsage.STORAGE,
  );
  const termKindBuffer = createBuffer(
    device,
    termKinds,
    GPUBufferUsage.STORAGE,
  );
  const labelBuffer = createBuffer(
    device,
    termLabelIds,
    GPUBufferUsage.STORAGE,
  );
  const childStartBuffer = createBuffer(
    device,
    new Uint32Array(childStarts),
    GPUBufferUsage.STORAGE,
  );
  const childCountBuffer = createBuffer(
    device,
    new Uint32Array(childCounts),
    GPUBufferUsage.STORAGE,
  );
  const childBuffer = createBuffer(
    device,
    new Uint32Array(children),
    GPUBufferUsage.STORAGE,
  );
  const pairCountBuffer = createCompilerGpuBuffer(
    device,
    "type solver constructor pair counts",
    {
      size: Math.max(4, pairSlotCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const firstPrefixBuffer = createCompilerGpuBuffer(
    device,
    "type solver constructor first prefixes",
    {
      size: Math.max(4, pairSlotCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const secondPrefixBuffer = createCompilerGpuBuffer(
    device,
    "type solver constructor second prefixes",
    {
      size: Math.max(4, pairSlotCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const clashBuffer = createBuffer(
    device,
    new Uint32Array([0xffff_ffff]),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const overflowBuffer = createCompilerGpuBuffer(
    device,
    "type solver constructor overflow",
    {
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const outputEqualityBuffer = createCompilerGpuBuffer(
    device,
    "type solver constructor output equalities",
    {
      size: equalityCapacity * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const outputParentBuffer = createCompilerGpuBuffer(
    device,
    "type solver constructor output parents",
    {
      size: equalityCapacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const decompositionParameterBuffer = createBuffer(
    device,
    new Uint32Array([termCount, equalityCapacity]),
    GPUBufferUsage.UNIFORM,
  );
  const metadataReadback = createCompilerGpuBuffer(
    device,
    "type solver constructor metadata readback",
    {
      size: 12,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const scanParameterBuffers: GPUBuffer[] = [];
  const buffers = [
    representativeBuffer,
    termKindBuffer,
    labelBuffer,
    childStartBuffer,
    childCountBuffer,
    childBuffer,
    pairCountBuffer,
    firstPrefixBuffer,
    secondPrefixBuffer,
    clashBuffer,
    overflowBuffer,
    outputEqualityBuffer,
    outputParentBuffer,
    decompositionParameterBuffer,
    metadataReadback,
  ];
  let metadataMapped = false;
  let outputReadback: GPUBuffer | undefined;
  let outputMapped = false;
  try {
    const pipelines = await requestDecompositionPipelines(device);
    const encoder = device.createCommandEncoder();
    const countBindGroup = device.createBindGroup({
      layout: pipelines.count.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: representativeBuffer } },
        { binding: 1, resource: { buffer: termKindBuffer } },
        { binding: 2, resource: { buffer: labelBuffer } },
        { binding: 3, resource: { buffer: childCountBuffer } },
        { binding: 4, resource: { buffer: pairCountBuffer } },
        { binding: 5, resource: { buffer: clashBuffer } },
        { binding: 6, resource: { buffer: decompositionParameterBuffer } },
      ],
    });
    const countPass = encoder.beginComputePass();
    countPass.setPipeline(pipelines.count);
    countPass.setBindGroup(0, countBindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      countPass,
      "type solver constructor count",
      Math.ceil(pairSlotCount / 64),
    );
    countPass.end();

    let inputPrefixBuffer = pairCountBuffer;
    let outputPrefixBuffer = firstPrefixBuffer;
    for (let distance = 1; distance < pairSlotCount; distance *= 2) {
      const parameterBuffer = createBuffer(
        device,
        new Uint32Array([pairSlotCount, distance]),
        GPUBufferUsage.UNIFORM,
      );
      scanParameterBuffers.push(parameterBuffer);
      const bindGroup = device.createBindGroup({
        layout: pipelines.scan.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputPrefixBuffer } },
          { binding: 1, resource: { buffer: outputPrefixBuffer } },
          { binding: 2, resource: { buffer: parameterBuffer } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipelines.scan);
      pass.setBindGroup(0, bindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        "type solver constructor scan",
        Math.ceil(pairSlotCount / 64),
      );
      pass.end();
      [inputPrefixBuffer, outputPrefixBuffer] = [
        outputPrefixBuffer,
        outputPrefixBuffer === firstPrefixBuffer
          ? secondPrefixBuffer
          : firstPrefixBuffer,
      ];
    }

    const emitBindGroup = device.createBindGroup({
      layout: pipelines.emit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: childStartBuffer } },
        { binding: 1, resource: { buffer: childBuffer } },
        { binding: 2, resource: { buffer: pairCountBuffer } },
        { binding: 3, resource: { buffer: inputPrefixBuffer } },
        { binding: 4, resource: { buffer: outputEqualityBuffer } },
        { binding: 5, resource: { buffer: outputParentBuffer } },
        { binding: 6, resource: { buffer: overflowBuffer } },
        { binding: 7, resource: { buffer: decompositionParameterBuffer } },
      ],
    });
    const emitPass = encoder.beginComputePass();
    emitPass.setPipeline(pipelines.emit);
    emitPass.setBindGroup(0, emitBindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      emitPass,
      "type solver constructor emission",
      Math.ceil(pairSlotCount / 64),
    );
    emitPass.end();
    encoder.copyBufferToBuffer(clashBuffer, 0, metadataReadback, 0, 4);
    encoder.copyBufferToBuffer(
      inputPrefixBuffer,
      (pairSlotCount - 1) * 4,
      metadataReadback,
      4,
      4,
    );
    encoder.copyBufferToBuffer(overflowBuffer, 0, metadataReadback, 8, 4);
    submissions.push(
      await submitCompilerGpuCommand(
        device,
        "type solver constructor metadata",
        encoder.finish(),
        scheduling,
      ),
    );
    await awaitCompilerGpuCommand(
      device,
      "type solver constructor metadata",
      metadataReadback.mapAsync(GPUMapMode.READ),
    );
    metadataMapped = true;
    const metadata = new Uint32Array(
      metadataReadback.getMappedRange().slice(0),
    );
    const clashPair = metadata[0];
    if (clashPair !== 0xffff_ffff) {
      return {
        status: "completed",
        clash: [
          Math.floor(clashPair / termCount),
          clashPair % termCount,
        ],
        equalities: [],
      };
    }
    const equalityCount = metadata[1];
    const overflowCount = metadata[2];
    if (overflowCount !== 0 || equalityCount > equalityCapacity) {
      return {
        status: "unavailable",
        reason:
          `proof-of-concept GPU constructor decomposition limit is ${equalityCapacity} generated equalities; requested ${
            Math.max(equalityCount, overflowCount)
          }`,
      };
    }
    if (equalityCount === 0) {
      return { status: "completed", clash: undefined, equalities: [] };
    }

    requireTypeSolverGpuCapacities(device, [
      copyCapacity("constructor output readback", equalityCount * 12),
    ]);
    outputReadback = createCompilerGpuBuffer(
      device,
      "type solver constructor output readback",
      {
        size: equalityCount * 12,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      },
      "copy",
    );
    const outputEncoder = device.createCommandEncoder();
    outputEncoder.copyBufferToBuffer(
      outputEqualityBuffer,
      0,
      outputReadback,
      0,
      equalityCount * 8,
    );
    outputEncoder.copyBufferToBuffer(
      outputParentBuffer,
      0,
      outputReadback,
      equalityCount * 8,
      equalityCount * 4,
    );
    submissions.push(
      await submitCompilerGpuCommand(
        device,
        "type solver constructor output",
        outputEncoder.finish(),
        scheduling,
      ),
    );
    await awaitCompilerGpuCommand(
      device,
      "type solver constructor output",
      outputReadback.mapAsync(GPUMapMode.READ),
    );
    outputMapped = true;
    const mapped = outputReadback.getMappedRange();
    const equalityWords = new Uint32Array(mapped, 0, equalityCount * 2);
    const parentPairs = new Uint32Array(
      mapped,
      equalityCount * 8,
      equalityCount,
    );
    const equalities = Array.from(
      { length: equalityCount },
      (_, equalityIndex) => {
        const parentPair = parentPairs[equalityIndex];
        return {
          equality: [
            equalityWords[equalityIndex * 2],
            equalityWords[equalityIndex * 2 + 1],
          ] as [number, number],
          constructors: [
            Math.floor(parentPair / termCount),
            parentPair % termCount,
          ] as const,
        };
      },
    );
    return { status: "completed", clash: undefined, equalities };
  } finally {
    if (metadataMapped) metadataReadback.unmap();
    if (outputMapped) outputReadback?.unmap();
    outputReadback?.destroy();
    for (const buffer of [...buffers, ...scanParameterBuffers]) {
      buffer.destroy();
    }
  }
}

type PackedTypeSolverColumn = {
  readonly words: Uint32Array;
  readonly regions: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly maximumRegionSize: number;
};

async function runUnionGpuBatch(
  inputs: readonly UnionGpuInput[],
): Promise<readonly UnionGpuOutput[]> {
  try {
    return await runPackedUnionGpuBatch(inputs);
  } catch (error) {
    if (error instanceof CompilerGpuCapacityError && inputs.length > 1) {
      const split = Math.ceil(inputs.length / 2);
      const [left, right] = await Promise.all([
        runUnionGpuBatch(inputs.slice(0, split)),
        runUnionGpuBatch(inputs.slice(split)),
      ]);
      return [...left, ...right];
    }
    throw error;
  }
}

async function runPackedUnionGpuBatch(
  inputs: readonly UnionGpuInput[],
): Promise<readonly UnionGpuOutput[]> {
  const device = inputs[0].device;
  if (inputs.some((input) => input.device !== device)) {
    return await Promise.all(inputs.map(runUnionOnGpuWithoutBatch));
  }
  const alignment = device.limits.minStorageBufferOffsetAlignment;
  const parents = packTypeSolverColumns(
    inputs.map((input) => new Uint32Array(input.initialRepresentatives)),
    4,
    alignment,
  );
  const equalities = packTypeSolverColumns(
    inputs.map((input) => {
      const words = new Uint32Array(input.equalities.flat());
      return words.length === 0 ? new Uint32Array([0, 0]) : words;
    }),
    8,
    alignment,
  );
  const readbacks = packTypeSolverColumns(
    inputs.map((input) => new Uint32Array(input.initialRepresentatives.length)),
    4,
    4,
  );
  const parentBuffer = createBuffer(
    device,
    parents.words,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
    parents.maximumRegionSize,
  );
  const equalityBuffer = createBuffer(
    device,
    equalities.words,
    GPUBufferUsage.STORAGE,
    equalities.maximumRegionSize,
  );
  const readbackBuffer = createCompilerGpuBuffer(
    device,
    "type solver union batch readback",
    {
      size: readbacks.words.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  let readbackMapped = false;
  try {
    const pipelines = await requestUnionPipelines(device);
    const bindGroups = inputs.map((_, index) =>
      device.createBindGroup({
        layout: pipelines.union.getBindGroupLayout(0),
        entries: [
          typeSolverBindGroupEntry(0, parentBuffer, parents.regions[index]),
          typeSolverBindGroupEntry(
            1,
            equalityBuffer,
            equalities.regions[index],
          ),
        ],
      })
    );
    const encoder = device.createCommandEncoder();
    const unionPass = encoder.beginComputePass();
    unionPass.setPipeline(pipelines.union);
    for (const [index, input] of inputs.entries()) {
      unionPass.setBindGroup(0, bindGroups[index]);
      dispatchCompilerGpuWorkgroups(
        device,
        unionPass,
        `type solver union batch job ${index}`,
        Math.max(1, Math.ceil(input.equalities.length / 64)),
      );
    }
    unionPass.end();
    const compressionPass = encoder.beginComputePass();
    compressionPass.setPipeline(pipelines.compression);
    for (const [index, input] of inputs.entries()) {
      compressionPass.setBindGroup(0, bindGroups[index]);
      dispatchCompilerGpuWorkgroups(
        device,
        compressionPass,
        `type solver compression batch job ${index}`,
        Math.ceil(input.initialRepresentatives.length / 64),
      );
    }
    compressionPass.end();
    for (const [index, input] of inputs.entries()) {
      encoder.copyBufferToBuffer(
        parentBuffer,
        parents.regions[index].offset,
        readbackBuffer,
        readbacks.regions[index].offset,
        input.initialRepresentatives.length * 4,
      );
    }
    const submission = await submitCompilerGpuCommand(
      device,
      "type solver union payload batch",
      encoder.finish(),
      "latency",
    );
    await awaitCompilerGpuCommand(
      device,
      "type solver union payload batch",
      readbackBuffer.mapAsync(GPUMapMode.READ),
    );
    readbackMapped = true;
    const mapped = readbackBuffer.getMappedRange();
    return inputs.map((input, index) => {
      const representatives = [
        ...new Uint32Array(
          mapped,
          readbacks.regions[index].offset,
          input.initialRepresentatives.length,
        ),
      ];
      requireCompressedRepresentatives(representatives);
      return {
        result: { representatives, rounds: 1 },
        submission,
      };
    });
  } finally {
    if (readbackMapped) readbackBuffer.unmap();
    parentBuffer.destroy();
    equalityBuffer.destroy();
    readbackBuffer.destroy();
  }
}

function packTypeSolverColumns(
  columns: readonly Uint32Array[],
  minimumRegionBytes: number,
  alignment: number,
): PackedTypeSolverColumn {
  const regions: { offset: number; size: number }[] = [];
  let byteLength = 0;
  let maximumRegionSize = 0;
  for (const column of columns) {
    byteLength = Math.ceil(byteLength / alignment) * alignment;
    const size = Math.max(minimumRegionBytes, column.byteLength);
    regions.push({ offset: byteLength, size });
    maximumRegionSize = Math.max(maximumRegionSize, size);
    byteLength += size;
  }
  const words = new Uint32Array(Math.max(1, Math.ceil(byteLength / 4)));
  for (const [index, column] of columns.entries()) {
    words.set(column, regions[index].offset / 4);
  }
  return {
    words,
    regions,
    maximumRegionSize: Math.max(minimumRegionBytes, maximumRegionSize),
  };
}

function typeSolverBindGroupEntry(
  binding: number,
  buffer: GPUBuffer,
  region: { readonly offset: number; readonly size: number },
): GPUBindGroupEntry {
  return {
    binding,
    resource: { buffer, offset: region.offset, size: region.size },
  };
}

function requireCompressedRepresentatives(
  representatives: readonly number[],
): void {
  for (const [term, representative] of representatives.entries()) {
    if (representative >= representatives.length) {
      throw new Error(
        `WebGPU union returned representative ${representative} for term ${term}, outside term count ${representatives.length}`,
      );
    }
    if (representatives[representative] !== representative) {
      throw new Error(
        `WebGPU union returned uncompressed parent ${representative} for term ${term}; parent points to ${
          representatives[representative]
        }`,
      );
    }
  }
}

async function unionOnGpu(
  device: GPUDevice,
  initialRepresentatives: readonly number[],
  equalities: readonly [number, number][],
  scheduling: CompilerGpuSchedulingPolicy,
  submissions: CompilerGpuSubmissionMetrics[],
): Promise<{ readonly representatives: number[]; readonly rounds: number }> {
  const batch = await unionGpuBatchQueue.enqueue(
    { device, initialRepresentatives, equalities },
    scheduling,
  );
  submissions.push({
    submissionBatchSize: batch.output.submission.submissionBatchSize,
    queueWaitMilliseconds: batch.queueWaitMilliseconds +
      batch.output.submission.queueWaitMilliseconds,
  });
  return batch.output.result;
}

async function runUnionOnGpuWithoutBatch(
  input: UnionGpuInput,
): Promise<UnionGpuOutput> {
  const { device, initialRepresentatives, equalities } = input;
  const parentBytes = new Uint32Array(initialRepresentatives);
  const equalityWords = new Uint32Array(equalities.flat());
  const equalityBufferBytes = Math.max(8, equalityWords.byteLength);
  requireTypeSolverGpuCapacities(device, [
    storageCapacity("union parents", parentBytes.byteLength),
    storageCapacity("union equalities", equalityBufferBytes),
    copyCapacity("union readback", parentBytes.byteLength),
    dispatchCapacity(
      "union equalities",
      Math.max(1, Math.ceil(equalities.length / 64)),
    ),
    dispatchCapacity(
      "union path compression",
      Math.ceil(parentBytes.length / 64),
    ),
  ]);
  const parentBuffer = createBuffer(
    device,
    parentBytes,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  );
  const equalityBuffer = createBuffer(
    device,
    equalityWords.length === 0 ? new Uint32Array([0, 0]) : equalityWords,
    GPUBufferUsage.STORAGE,
  );
  const readback = createCompilerGpuBuffer(
    device,
    "type solver union readback",
    {
      size: parentBytes.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  let readbackMapped = false;
  try {
    const pipelines = await requestUnionPipelines(device);
    const bindGroup = device.createBindGroup({
      layout: pipelines.union.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: parentBuffer } },
        {
          binding: 1,
          resource: {
            buffer: equalityBuffer,
            size: Math.max(8, equalityWords.byteLength),
          },
        },
      ],
    });
    const encoder = device.createCommandEncoder();
    const unionPass = encoder.beginComputePass();
    unionPass.setPipeline(pipelines.union);
    unionPass.setBindGroup(0, bindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      unionPass,
      "type solver union equalities",
      Math.max(1, Math.ceil(equalities.length / 64)),
    );
    unionPass.end();
    const compressionPass = encoder.beginComputePass();
    compressionPass.setPipeline(pipelines.compression);
    compressionPass.setBindGroup(0, bindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      compressionPass,
      "type solver union path compression",
      Math.ceil(parentBytes.length / 64),
    );
    compressionPass.end();
    encoder.copyBufferToBuffer(
      parentBuffer,
      0,
      readback,
      0,
      parentBytes.byteLength,
    );
    const submission = await submitCompilerGpuCommand(
      device,
      "type solver union",
      encoder.finish(),
      "latency",
    );
    await awaitCompilerGpuCommand(
      device,
      "type solver union",
      readback.mapAsync(GPUMapMode.READ),
    );
    readbackMapped = true;
    const representatives = [
      ...new Uint32Array(readback.getMappedRange().slice(0)),
    ];
    requireCompressedRepresentatives(representatives);
    return {
      result: { representatives, rounds: 1 },
      submission,
    };
  } finally {
    if (readbackMapped) readback.unmap();
    parentBuffer.destroy();
    equalityBuffer.destroy();
    readback.destroy();
  }
}

function findInfiniteTypeInRepresentativeGraph(
  terms: readonly FlatTerm[],
  representatives: readonly number[],
): number | undefined {
  const successors = new Map<number, Set<number>>();
  for (const [termIndex, term] of terms.entries()) {
    if (term.kind !== "constructor") continue;
    const source = representatives[termIndex];
    const targets = successors.get(source) ?? new Set<number>();
    for (const child of term.children) {
      targets.add(representatives[child]);
    }
    successors.set(source, targets);
  }
  const roots = [...new Set(representatives)].sort((left, right) =>
    left - right
  );
  const colour = new Map<number, 0 | 1 | 2>();
  const path: number[] = [];
  const pathIndex = new Map<number, number>();
  let minimumCycleRoot: number | undefined;
  for (const root of roots) {
    if ((colour.get(root) ?? 0) !== 0) continue;
    const stack: {
      readonly root: number;
      readonly successors: readonly number[];
      nextSuccessor: number;
    }[] = [{
      root,
      successors: [...(successors.get(root) ?? [])].sort((left, right) =>
        left - right
      ),
      nextSuccessor: 0,
    }];
    colour.set(root, 1);
    pathIndex.set(root, path.length);
    path.push(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const successor = frame.successors[frame.nextSuccessor];
      if (successor === undefined) {
        colour.set(frame.root, 2);
        pathIndex.delete(frame.root);
        path.pop();
        stack.pop();
        continue;
      }
      frame.nextSuccessor += 1;
      const successorColour = colour.get(successor) ?? 0;
      if (successorColour === 1) {
        const cycleStart = pathIndex.get(successor);
        if (cycleStart === undefined) {
          throw new Error(
            `type dependency root ${successor} is active but absent from its DFS path`,
          );
        }
        for (let index = cycleStart; index < path.length; index += 1) {
          minimumCycleRoot = minimumCycleRoot === undefined
            ? path[index]
            : Math.min(minimumCycleRoot, path[index]);
        }
        continue;
      }
      if (successorColour === 2) continue;
      colour.set(successor, 1);
      pathIndex.set(successor, path.length);
      path.push(successor);
      stack.push({
        root: successor,
        successors: [...(successors.get(successor) ?? [])].sort(
          (left, right) => left - right,
        ),
        nextSuccessor: 0,
      });
    }
  }
  return minimumCycleRoot;
}

async function findInfiniteTypeOnGpu(
  device: GPUDevice,
  terms: readonly FlatTerm[],
  representatives: readonly number[],
  scheduling: CompilerGpuSchedulingPolicy,
  submissions: CompilerGpuSubmissionMetrics[],
): Promise<number | undefined> {
  const roots = [...new Set(representatives)].sort((left, right) =>
    left - right
  );
  const rootPosition = new Map(roots.map((root, index) => [root, index]));
  const count = roots.length;
  if (count === 0) return undefined;
  const matrix = new Uint32Array(count * count);
  let edgeCount = 0;
  for (const [termIndex, term] of terms.entries()) {
    if (term.kind !== "constructor") continue;
    const row = rootPosition.get(representatives[termIndex])!;
    for (const child of term.children) {
      const column = rootPosition.get(representatives[child])!;
      const index = row * count + column;
      if (matrix[index] !== 0) continue;
      matrix[index] = 1;
      edgeCount += 1;
    }
  }
  if (edgeCount === 0) return undefined;

  const matrixBuffer = createBuffer(
    device,
    matrix,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const parameterStride = device.limits.minUniformBufferOffsetAlignment;
  const parameterWords = new Uint32Array(parameterStride / 4 * count);
  for (let pivot = 0; pivot < count; pivot += 1) {
    const start = pivot * parameterStride / 4;
    parameterWords[start] = count;
    parameterWords[start + 1] = pivot;
  }
  requireTypeSolverGpuCapacities(device, [
    storageCapacity("reachability matrix", matrix.byteLength),
    {
      kind: "buffer",
      label: "type solver reachability parameters",
      byteLength: parameterWords.byteLength,
      binding: "uniform",
      bindingByteLength: 8,
    },
    copyCapacity("reachability readback", matrix.byteLength),
    dispatchCapacity(
      "reachability closure",
      Math.ceil(matrix.length / 64),
    ),
  ]);
  const parameterBuffer = createBuffer(
    device,
    parameterWords,
    GPUBufferUsage.UNIFORM,
    8,
  );
  const readback = createCompilerGpuBuffer(
    device,
    "type solver reachability readback",
    {
      size: matrix.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  let readbackMapped = false;
  try {
    const { bindGroupLayout, pipeline } = await requestReachabilityPipeline(
      device,
    );
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: matrixBuffer } }, {
        binding: 1,
        resource: { buffer: parameterBuffer, size: 8 },
      }],
    });
    const encoder = device.createCommandEncoder();
    for (let pivot = 0; pivot < count; pivot += 1) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup, [pivot * parameterStride]);
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        "type solver reachability closure",
        Math.ceil(matrix.length / 64),
      );
      pass.end();
    }
    encoder.copyBufferToBuffer(matrixBuffer, 0, readback, 0, matrix.byteLength);
    submissions.push(
      await submitCompilerGpuCommand(
        device,
        "type solver reachability",
        encoder.finish(),
        scheduling,
      ),
    );
    await awaitCompilerGpuCommand(
      device,
      "type solver reachability",
      readback.mapAsync(GPUMapMode.READ),
    );
    readbackMapped = true;
    const closure = new Uint32Array(readback.getMappedRange());
    for (let index = 0; index < count; index += 1) {
      if (closure[index * count + index] !== 0) return roots[index];
    }
    return undefined;
  } finally {
    if (readbackMapped) readback.unmap();
    matrixBuffer.destroy();
    parameterBuffer.destroy();
    readback.destroy();
  }
}

function selectPipelineDevice(device: GPUDevice): void {
  if (pipelineDevice === device) return;
  pipelineDevice = device;
  unionPipelinesPromise = undefined;
  decompositionPipelinesPromise = undefined;
  reachabilityPipelinePromise = undefined;
  void device.lost.then(() => {
    if (pipelineDevice !== device) return;
    pipelineDevice = undefined;
    unionPipelinesPromise = undefined;
    decompositionPipelinesPromise = undefined;
    reachabilityPipelinePromise = undefined;
  });
}

function requestUnionPipelines(device: GPUDevice): Promise<UnionPipelines> {
  if (unionPipelinesPromise !== undefined) return unionPipelinesPromise;
  const pendingPipelines = (async () => {
    requireCompilerGpuCapacity(device, {
      kind: "pipelineBindings",
      label: "type solver union",
      storageBufferCount: 2,
      uniformBufferCount: 0,
    });
    const shader = device.createShaderModule({ code: unionShader });
    await requireShaderCompilation("union", [shader]);
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    const [union, compression] = await Promise.all([
      device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module: shader, entryPoint: "union_equalities" },
      }),
      device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module: shader, entryPoint: "compress_paths" },
      }),
    ]);
    return { union, compression };
  })();
  unionPipelinesPromise = pendingPipelines;
  void pendingPipelines.catch(() => {
    if (unionPipelinesPromise === pendingPipelines) {
      unionPipelinesPromise = undefined;
    }
  });
  return pendingPipelines;
}

function requestDecompositionPipelines(
  device: GPUDevice,
): Promise<DecompositionPipelines> {
  if (decompositionPipelinesPromise !== undefined) {
    return decompositionPipelinesPromise;
  }
  const pendingPipelines = (async () => {
    requireCompilerGpuCapacity(device, {
      kind: "pipelineBindings",
      label: "type solver constructor decomposition",
      storageBufferCount: 7,
      uniformBufferCount: 1,
    });
    const countModule = device.createShaderModule({
      code: constructorCountShader,
    });
    const scanModule = device.createShaderModule({
      code: constructorScanShader,
    });
    const emitModule = device.createShaderModule({
      code: constructorEmitShader,
    });
    await requireShaderCompilation(
      "constructor decomposition",
      [countModule, scanModule, emitModule],
    );
    const [count, scan, emit] = await Promise.all([
      device.createComputePipelineAsync({
        layout: "auto",
        compute: {
          module: countModule,
          entryPoint: "count_constructor_pairs",
        },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: scanModule, entryPoint: "scan_step" },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: {
          module: emitModule,
          entryPoint: "emit_child_equalities",
        },
      }),
    ]);
    return { count, scan, emit };
  })();
  decompositionPipelinesPromise = pendingPipelines;
  void pendingPipelines.catch(() => {
    if (decompositionPipelinesPromise === pendingPipelines) {
      decompositionPipelinesPromise = undefined;
    }
  });
  return pendingPipelines;
}

function requestReachabilityPipeline(
  device: GPUDevice,
): Promise<ReachabilityPipeline> {
  if (reachabilityPipelinePromise !== undefined) {
    return reachabilityPipelinePromise;
  }
  const pendingPipeline = (async () => {
    requireCompilerGpuCapacity(device, {
      kind: "pipelineBindings",
      label: "type solver reachability",
      storageBufferCount: 1,
      uniformBufferCount: 1,
    });
    const shader = device.createShaderModule({ code: reachabilityShader });
    await requireShaderCompilation("reachability", [shader]);
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: 8,
          },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: pipelineLayout,
      compute: { module: shader, entryPoint: "close_reachability" },
    });
    return { pipeline, bindGroupLayout };
  })();
  reachabilityPipelinePromise = pendingPipeline;
  void pendingPipeline.catch(() => {
    if (reachabilityPipelinePromise === pendingPipeline) {
      reachabilityPipelinePromise = undefined;
    }
  });
  return pendingPipeline;
}

async function requireShaderCompilation(
  subject: string,
  modules: readonly GPUShaderModule[],
): Promise<void> {
  const errors = (await Promise.all(
    modules.map((module) => module.getCompilationInfo()),
  )).flatMap((compilation) =>
    compilation.messages.filter((message) => message.type === "error")
  );
  if (errors.length === 0) return;
  throw new Error(
    `WebGPU ${subject} shader failed: ${
      errors.map((message) => message.message).join("; ")
    }`,
  );
}

function createBuffer(
  device: GPUDevice,
  words: Uint32Array,
  usage: GPUBufferUsageFlags,
  bindingByteLength?: number,
): GPUBuffer {
  const size = Math.max(4, Math.ceil(words.byteLength / 4) * 4);
  const binding = (usage & GPUBufferUsage.UNIFORM) !== 0
    ? "uniform"
    : "storage";
  const buffer = createCompilerGpuBuffer(
    device,
    "type solver input",
    { size, usage, mappedAtCreation: true },
    binding,
    bindingByteLength,
  );
  new Uint32Array(buffer.getMappedRange()).set(words);
  buffer.unmap();
  return buffer;
}

function requireTypeSolverGpuCapacities(
  device: GPUDevice,
  requests: readonly CompilerGpuCapacityRequest[],
): void {
  for (const request of requests) requireCompilerGpuCapacity(device, request);
}

function storageCapacity(
  label: string,
  byteLength: number,
): CompilerGpuCapacityRequest {
  return {
    kind: "buffer",
    label: `type solver ${label}`,
    byteLength: Math.max(4, byteLength),
    binding: "storage",
  };
}

function uniformCapacity(
  label: string,
  byteLength: number,
): CompilerGpuCapacityRequest {
  return {
    kind: "buffer",
    label: `type solver ${label}`,
    byteLength: Math.max(4, byteLength),
    binding: "uniform",
  };
}

function copyCapacity(
  label: string,
  byteLength: number,
): CompilerGpuCapacityRequest {
  return {
    kind: "buffer",
    label: `type solver ${label}`,
    byteLength,
    binding: "copy",
  };
}

function dispatchCapacity(
  label: string,
  workgroupCount: number,
): CompilerGpuCapacityRequest {
  return {
    kind: "dispatch",
    label: `type solver ${label}`,
    workgroupCount,
  };
}

function equalityKey([left, right]: readonly [number, number]): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function sourceForClass(
  constructors: readonly number[],
  equalities: readonly [number, number][],
  sourceStarts: readonly number[],
): number {
  let sourceStart = Number.MAX_SAFE_INTEGER;
  const constructorSet = new Set(constructors);
  for (const [equalityIndex, [left, right]] of equalities.entries()) {
    if (constructorSet.has(left) || constructorSet.has(right)) {
      sourceStart = Math.min(
        sourceStart,
        sourceStarts[equalityIndex] ?? sourceStart,
      );
    }
  }
  return sourceStart === Number.MAX_SAFE_INTEGER ? 0 : sourceStart;
}

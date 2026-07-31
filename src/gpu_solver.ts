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
    readonly constructorComparisonCount: number;
    readonly decompositionCount: number;
    readonly flattenMilliseconds: number;
    readonly closureMilliseconds: number;
    readonly unionMilliseconds: number;
    readonly cycleCheckMilliseconds: number;
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

type FlatConstraintClosure =
  | {
    readonly status: "completed";
    readonly representatives: readonly number[];
    readonly equalities: readonly [number, number][];
    readonly constructorComparisonCount: number;
    readonly decompositionCount: number;
  }
  | {
    readonly status: "constructorClash";
    readonly left: string;
    readonly right: string;
    readonly sourceStart: number;
  };

type UnionPipelines = {
  readonly union: GPUComputePipeline;
  readonly compression: GPUComputePipeline;
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

let pipelineDevice: GPUDevice | undefined;
let unionPipelinesPromise: Promise<UnionPipelines> | undefined;
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
  if (equalities.length === 0) {
    return {
      status: "solved",
      representatives: [],
      termCount: 0,
      equalityCount: 0,
      unionRounds: 0,
      constructorComparisonCount: 0,
      decompositionCount: 0,
      flattenMilliseconds: 0,
      closureMilliseconds: 0,
      unionMilliseconds: 0,
      cycleCheckMilliseconds: 0,
      submissionBatchSize: 0,
      queueWaitMilliseconds: 0,
    };
  }
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
  const flattenStart = performance.now();
  const flat = flattenEqualities(equalities);
  const flattenMilliseconds = performance.now() - flattenStart;
  const closureStart = performance.now();
  const cpuClosure = closeFlatConstraintsOnCpu(flat);
  const closureMilliseconds = performance.now() - closureStart;
  return await validateFlatConstraintClosureOnGpu(
    device,
    flat,
    cpuClosure,
    scheduling,
    submissions,
    { flattenMilliseconds, closureMilliseconds },
  );
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

async function validateFlatConstraintClosureOnGpu(
  device: GPUDevice,
  flat: FlatConstraints,
  cpuClosure: FlatConstraintClosure,
  scheduling: CompilerGpuSchedulingPolicy,
  submissions: CompilerGpuSubmissionMetrics[],
  cpuTimings: {
    readonly flattenMilliseconds: number;
    readonly closureMilliseconds: number;
  },
): Promise<GpuSolveResult> {
  if (cpuClosure.status === "constructorClash") return cpuClosure;
  const unionStart = performance.now();
  const gpuUnion = await unionOnGpu(
    device,
    flat.terms.map((_, index) => index),
    cpuClosure.equalities,
    scheduling,
    submissions,
  );
  const unionMilliseconds = performance.now() - unionStart;
  requireRepresentativeAgreement(
    cpuClosure.representatives,
    gpuUnion.representatives,
  );
  const cycleCheckStart = performance.now();
  const infiniteRepresentative = findInfiniteTypeInRepresentativeGraph(
    flat.terms,
    gpuUnion.representatives,
  );
  const cycleCheckMilliseconds = performance.now() - cycleCheckStart;
  if (infiniteRepresentative !== undefined) {
    return { status: "infiniteType", representative: infiniteRepresentative };
  }
  return {
    status: "solved",
    representatives: gpuUnion.representatives,
    termCount: flat.terms.length,
    equalityCount: cpuClosure.equalities.length,
    unionRounds: gpuUnion.rounds,
    constructorComparisonCount: cpuClosure.constructorComparisonCount,
    decompositionCount: cpuClosure.decompositionCount,
    ...cpuTimings,
    unionMilliseconds,
    cycleCheckMilliseconds,
  };
}

function closeFlatConstraintsOnCpu(
  flat: FlatConstraints,
): FlatConstraintClosure {
  const allEqualities = [...flat.equalities];
  const allSourceStarts = [...flat.sourceStarts];
  const seenEqualities = new Set(allEqualities.map(equalityKey));
  const parents = flat.terms.map((_, index) => index);
  const classSourceStarts = flat.terms.map(() => Number.MAX_SAFE_INTEGER);
  const classConstructors = flat.terms.map((term, index) =>
    term.kind === "constructor" ? index : undefined
  );
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
  let decompositionCount = 0;
  let constructorComparisonCount = 0;
  for (
    let equalityIndex = 0;
    equalityIndex < allEqualities.length;
    equalityIndex += 1
  ) {
    const [left, right] = allEqualities[equalityIndex];
    const sourceStart = allSourceStarts[equalityIndex];
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) {
      classSourceStarts[leftRoot] = Math.min(
        classSourceStarts[leftRoot],
        sourceStart,
      );
      continue;
    }

    const lower = Math.min(leftRoot, rightRoot);
    const higher = Math.max(leftRoot, rightRoot);
    const lowerConstructor = classConstructors[lower];
    const higherConstructor = classConstructors[higher];
    parents[higher] = lower;
    classSourceStarts[lower] = Math.min(
      classSourceStarts[leftRoot],
      classSourceStarts[rightRoot],
      sourceStart,
    );

    if (lowerConstructor === undefined) {
      classConstructors[lower] = higherConstructor;
      continue;
    }
    if (higherConstructor === undefined) continue;

    const firstConstructor = Math.min(lowerConstructor, higherConstructor);
    const secondConstructor = Math.max(lowerConstructor, higherConstructor);
    const first = flat.terms[firstConstructor];
    const second = flat.terms[secondConstructor];
    constructorComparisonCount += 1;
    if (
      first.label !== second.label ||
      first.children.length !== second.children.length
    ) {
      return {
        status: "constructorClash",
        left: first.label,
        right: second.label,
        sourceStart: classSourceStarts[lower] === Number.MAX_SAFE_INTEGER
          ? 0
          : classSourceStarts[lower],
      };
    }

    classConstructors[lower] = firstConstructor;
    for (const [childIndex, child] of first.children.entries()) {
      decompositionCount += 1;
      const generated: [number, number] = [
        child,
        second.children[childIndex],
      ];
      const key = equalityKey(generated);
      if (seenEqualities.has(key)) continue;
      seenEqualities.add(key);
      allEqualities.push(generated);
      allSourceStarts.push(classSourceStarts[lower]);
    }
  }

  return {
    status: "completed",
    representatives: parents.map((_, index) => find(index)),
    equalities: allEqualities,
    constructorComparisonCount,
    decompositionCount,
  };
}

function requireRepresentativeAgreement(
  expected: readonly number[],
  received: readonly number[],
): void {
  if (received.length !== expected.length) {
    throw new Error(
      `CPU and WebGPU type solvers disagree on term count: CPU returned ${expected.length} representatives; GPU returned ${received.length}`,
    );
  }
  for (const [termIndex, expectedRepresentative] of expected.entries()) {
    if (received[termIndex] === expectedRepresentative) continue;
    throw new Error(
      `CPU and WebGPU type solvers disagree at term ${termIndex}: CPU representative ${expectedRepresentative}; GPU representative ${
        received[termIndex]
      }`,
    );
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

function selectPipelineDevice(device: GPUDevice): void {
  if (pipelineDevice === device) return;
  pipelineDevice = device;
  unionPipelinesPromise = undefined;
  void device.lost.then(() => {
    if (pipelineDevice !== device) return;
    pipelineDevice = undefined;
    unionPipelinesPromise = undefined;
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

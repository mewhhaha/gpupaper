import type { EqualityConstraint, Type } from "./types.ts";

export type GpuSolveResult =
  | {
    readonly status: "solved";
    readonly representatives: readonly number[];
    readonly termCount: number;
    readonly equalityCount: number;
    readonly unionRounds: number;
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

let devicePromise: Promise<GPUDevice | undefined> | undefined;

export async function solveTypeEqualitiesOnGpu(
  equalities: readonly EqualityConstraint[],
): Promise<GpuSolveResult> {
  const device = await requestDevice();
  if (device === undefined) {
    return { status: "unavailable", reason: "WebGPU adapter is unavailable" };
  }
  const flat = flattenEqualities(equalities);
  if (flat.terms.length === 0) {
    return {
      status: "solved",
      representatives: [],
      termCount: 0,
      equalityCount: 0,
      unionRounds: 0,
    };
  }
  if (flat.terms.length > 512) {
    return {
      status: "unavailable",
      reason:
        `proof-of-concept GPU solver limit is 512 terms; received ${flat.terms.length}`,
    };
  }

  const allEqualities = [...flat.equalities];
  const allSourceStarts = [...flat.sourceStarts];
  const seenEqualities = new Set(allEqualities.map(equalityKey));
  let representatives = flat.terms.map((_, index) => index);
  let unionRounds = 0;

  while (true) {
    const union = await unionOnGpu(device, representatives, allEqualities);
    representatives = union.representatives;
    unionRounds += union.rounds;
    const constructorByRepresentative = new Map<number, number[]>();
    for (const [termIndex, term] of flat.terms.entries()) {
      if (term.kind !== "constructor") continue;
      const representative = representatives[termIndex];
      const constructors = constructorByRepresentative.get(representative) ??
        [];
      constructors.push(termIndex);
      constructorByRepresentative.set(representative, constructors);
    }

    let added = false;
    for (const constructors of constructorByRepresentative.values()) {
      const first = flat.terms[constructors[0]];
      for (const constructorIndex of constructors.slice(1)) {
        const next = flat.terms[constructorIndex];
        if (
          first.label !== next.label ||
          first.children.length !== next.children.length
        ) {
          const sourceStart = sourceForClass(
            constructors,
            allEqualities,
            allSourceStarts,
          );
          return {
            status: "constructorClash",
            left: first.label,
            right: next.label,
            sourceStart,
          };
        }
        for (
          let childIndex = 0;
          childIndex < first.children.length;
          childIndex += 1
        ) {
          const equality: [number, number] = [
            first.children[childIndex],
            next.children[childIndex],
          ];
          const key = equalityKey(equality);
          if (seenEqualities.has(key)) continue;
          seenEqualities.add(key);
          allEqualities.push(equality);
          allSourceStarts.push(
            sourceForClass(constructors, allEqualities, allSourceStarts),
          );
          added = true;
        }
      }
    }
    if (!added) break;
  }

  const infiniteRepresentative = await findInfiniteTypeOnGpu(
    device,
    flat.terms,
    representatives,
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
  };
}

export async function unionPairsOnGpu(
  termCount: number,
  equalities: readonly [number, number][],
): Promise<readonly number[] | undefined> {
  const device = await requestDevice();
  if (device === undefined) return undefined;
  const initialRepresentatives = Array.from(
    { length: termCount },
    (_, index) => index,
  );
  return (await unionOnGpu(device, initialRepresentatives, equalities))
    .representatives;
}

async function requestDevice(): Promise<GPUDevice | undefined> {
  if (devicePromise !== undefined) return await devicePromise;
  devicePromise = (async () => {
    if (navigator.gpu === undefined) return undefined;
    const adapter = await navigator.gpu.requestAdapter();
    return await adapter?.requestDevice();
  })();
  return await devicePromise;
}

function flattenEqualities(
  equalities: readonly EqualityConstraint[],
): FlatConstraints {
  const terms: FlatTerm[] = [];
  const variableTerms = new Map<number, number>();
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
    const termIndex = terms.length;
    terms.push({
      kind: "constructor",
      label: type.kind === "function" ? "->" : type.name,
      children,
    });
    return termIndex;
  };

  for (const equality of equalities) {
    pairs.push([flattenType(equality.left), flattenType(equality.right)]);
    sourceStarts.push(equality.span.start);
  }
  return { terms, equalities: pairs, sourceStarts };
}

async function unionOnGpu(
  device: GPUDevice,
  initialRepresentatives: readonly number[],
  equalities: readonly [number, number][],
): Promise<{ readonly representatives: number[]; readonly rounds: number }> {
  const parentBytes = new Uint32Array(initialRepresentatives);
  const equalityWords = new Uint32Array(equalities.flat());
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
  const readback = device.createBuffer({
    size: parentBytes.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let readbackMapped = false;
  try {
    const shader = device.createShaderModule({ code: unionShader });
    const compilation = await shader.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((message) =>
      message.type === "error"
    );
    if (shaderErrors.length > 0) {
      throw new Error(
        `WebGPU union shader failed: ${
          shaderErrors.map((message) => message.message).join("; ")
        }`,
      );
    }
    device.pushErrorScope("validation");
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
    const unionPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: shader, entryPoint: "union_equalities" },
    });
    const compressionPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: shader, entryPoint: "compress_paths" },
    });
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
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
    const rounds = Math.max(1, Math.min(parentBytes.length, 512));
    for (let round = 0; round < rounds; round += 1) {
      const unionPass = encoder.beginComputePass();
      unionPass.setPipeline(unionPipeline);
      unionPass.setBindGroup(0, bindGroup);
      unionPass.dispatchWorkgroups(
        Math.max(1, Math.ceil(equalities.length / 64)),
      );
      unionPass.end();
      const compressionPass = encoder.beginComputePass();
      compressionPass.setPipeline(compressionPipeline);
      compressionPass.setBindGroup(0, bindGroup);
      compressionPass.dispatchWorkgroups(Math.ceil(parentBytes.length / 64));
      compressionPass.end();
    }
    encoder.copyBufferToBuffer(
      parentBuffer,
      0,
      readback,
      0,
      parentBytes.byteLength,
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    readbackMapped = true;
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU union validation failed: ${validationError.message}`,
      );
    }
    const representatives = [
      ...new Uint32Array(readback.getMappedRange().slice(0)),
    ];
    return { representatives, rounds };
  } finally {
    if (readbackMapped) readback.unmap();
    parentBuffer.destroy();
    equalityBuffer.destroy();
    readback.destroy();
  }
}

async function findInfiniteTypeOnGpu(
  device: GPUDevice,
  terms: readonly FlatTerm[],
  representatives: readonly number[],
): Promise<number | undefined> {
  const roots = [...new Set(representatives)].sort((left, right) =>
    left - right
  );
  const rootPosition = new Map(roots.map((root, index) => [root, index]));
  const count = roots.length;
  if (count === 0) return undefined;
  const matrix = new Uint32Array(count * count);
  for (const [termIndex, term] of terms.entries()) {
    if (term.kind !== "constructor") continue;
    const row = rootPosition.get(representatives[termIndex])!;
    for (const child of term.children) {
      const column = rootPosition.get(representatives[child])!;
      matrix[row * count + column] = 1;
    }
  }

  const matrixBuffer = createBuffer(
    device,
    matrix,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const parameterBuffer = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: matrix.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let readbackMapped = false;
  try {
    const shader = device.createShaderModule({ code: reachabilityShader });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: shader, entryPoint: "close_reachability" },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: matrixBuffer } }, {
        binding: 1,
        resource: { buffer: parameterBuffer },
      }],
    });
    for (let pivot = 0; pivot < count; pivot += 1) {
      device.queue.writeBuffer(
        parameterBuffer,
        0,
        new Uint32Array([count, pivot]),
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(matrix.length / 64));
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(matrixBuffer, 0, readback, 0, matrix.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
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

function createBuffer(
  device: GPUDevice,
  words: Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const size = Math.max(4, Math.ceil(words.byteLength / 4) * 4);
  const buffer = device.createBuffer({ size, usage, mappedAtCreation: true });
  new Uint32Array(buffer.getMappedRange()).set(words);
  buffer.unmap();
  return buffer;
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

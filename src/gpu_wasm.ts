import {
  awaitCompilerGpuCommand,
  CompilerGpuCapacityError,
  compilerGpuCapacityViolation,
  type CompilerGpuSchedulingPolicy,
  compilerGpuUnavailabilityReason,
  createCompilerGpuBatchQueue,
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requestCompilerGpuDevice,
  requireCompilerGpuCapacity,
  submitCompilerGpuCommand,
} from "./gpu_device.ts";
import {
  type WasmAtom,
  type WasmBinaryPlan,
  wasmBinaryPlanByteLength,
} from "./wasm.ts";

export type GpuWasmEmissionResult =
  | {
    readonly status: "completed";
    readonly bytes: Uint8Array;
    readonly atomCount: number;
    readonly byteCount: number;
    readonly outputBufferBytes: number;
    readonly lengthRounds: number;
    readonly scanDispatchCount: number;
    readonly dispatchedInvocationCount: number;
    readonly submissionBatchSize: number;
    readonly payloadBatchSize: number;
    readonly queueWaitMilliseconds: number;
  }
  | { readonly status: "unavailable"; readonly reason: string };

type GpuWasmContextRequest =
  | {
    readonly status: "available";
    readonly device: GPUDevice;
    readonly sizePipeline: GPUComputePipeline;
    readonly lengthPipeline: GPUComputePipeline;
    readonly scanPipeline: GPUComputePipeline;
    readonly scanAddPipeline: GPUComputePipeline;
    readonly emissionPipeline: GPUComputePipeline;
  }
  | { readonly status: "unavailable"; readonly reason: string };

const atomByte = 0;
const atomUnsigned = 1;
const atomSigned32 = 2;
const atomSigned64 = 3;
const atomLength = 4;
const wasmWorkgroupSize = 64;
let contextPromise: Promise<GpuWasmContextRequest> | undefined;
const wasmBatchQueue = createCompilerGpuBatchQueue(
  (plans: readonly WasmBinaryPlan[]) =>
    plans.length === 1
      ? Promise.all(
        plans.map((plan) => emitWasmPlanWithGpu(plan, "latency")),
      )
      : emitPackedWasmPlansOnGpu(plans),
);

const encodingFunctions = `
fn unsigned_size(value: u32) -> u32 {
  var remaining = value;
  var size = 1u;
  while (remaining >= 128u) {
    remaining >>= 7u;
    size += 1u;
  }
  return size;
}

fn signed32_size(value_bits: u32) -> u32 {
  var remaining = bitcast<i32>(value_bits);
  var size = 0u;
  loop {
    let encoded_byte = u32(remaining) & 127u;
    remaining >>= 7;
    size += 1u;
    let sign_set = (encoded_byte & 64u) != 0u;
    if ((remaining == 0 && !sign_set) || (remaining == -1 && sign_set)) {
      return size;
    }
  }
  return size;
}

fn signed64_size(low_value: u32, high_value: u32) -> u32 {
  var low = low_value;
  var high = high_value;
  var size = 0u;
  loop {
    let encoded_byte = low & 127u;
    let next_low = (low >> 7u) | (high << 25u);
    let next_high = bitcast<u32>(bitcast<i32>(high) >> 7);
    size += 1u;
    let sign_set = (encoded_byte & 64u) != 0u;
    let positive_end = next_low == 0u && next_high == 0u && !sign_set;
    let negative_end =
      next_low == 0xffffffffu && next_high == 0xffffffffu && sign_set;
    if (positive_end || negative_end) { return size; }
    low = next_low;
    high = next_high;
  }
  return size;
}
`;

const sizeShader = `
${encodingFunctions}
struct Parameters { count: u32 }
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read> low_words: array<u32>;
@group(0) @binding(2) var<storage, read> high_words: array<u32>;
@group(0) @binding(3) var<storage, read_write> atom_sizes: array<u32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn calculate_sizes(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  let kind = atom_kinds[index];
  if (kind == ${atomByte}u) {
    atom_sizes[index] = 1u;
  } else if (kind == ${atomUnsigned}u) {
    atom_sizes[index] = unsigned_size(low_words[index]);
  } else if (kind == ${atomSigned32}u) {
    atom_sizes[index] = signed32_size(low_words[index]);
  } else if (kind == ${atomSigned64}u) {
    atom_sizes[index] = signed64_size(low_words[index], high_words[index]);
  } else {
    atom_sizes[index] = 0u;
  }
}
`;

const lengthShader = `
${encodingFunctions}
struct Parameters { count: u32, level: u32 }
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read_write> low_words: array<u32>;
@group(0) @binding(2) var<storage, read> range_starts: array<u32>;
@group(0) @binding(3) var<storage, read> range_counts: array<u32>;
@group(0) @binding(4) var<storage, read> dependency_levels: array<u32>;
@group(0) @binding(5) var<storage, read_write> atom_sizes: array<u32>;
@group(0) @binding(6) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn calculate_lengths(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (
    index >= parameters.count ||
    atom_kinds[index] != ${atomLength}u ||
    dependency_levels[index] != parameters.level
  ) {
    return;
  }
  let range_start = range_starts[index];
  let range_end = range_start + range_counts[index];
  var byte_length = 0u;
  for (
    var dependency = range_start;
    dependency < range_end;
    dependency += 1u
  ) {
    byte_length += atom_sizes[dependency];
  }
  low_words[index] = byte_length;
  atom_sizes[index] = unsigned_size(byte_length);
}
`;

const scanShader = `
struct Parameters {
  count: u32,
  input_offset: u32,
  output_offset: u32,
  block_sum_offset: u32,
}
@group(0) @binding(0) var<storage, read> input_prefixes: array<u32>;
@group(0) @binding(1) var<storage, read_write> output_prefixes: array<u32>;
@group(0) @binding(2) var<storage, read_write> block_sums: array<u32>;
@group(0) @binding(3) var<uniform> parameters: Parameters;
var<workgroup> block_values: array<u32, ${wasmWorkgroupSize}>;

@compute @workgroup_size(${wasmWorkgroupSize})
fn scan_blocks(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) workgroup: vec3<u32>,
) {
  let index = invocation.x;
  var value = 0u;
  if (index < parameters.count) {
    value = input_prefixes[parameters.input_offset + index];
  }
  block_values[local.x] = value;
  workgroupBarrier();
  for (var distance = 1u; distance < ${wasmWorkgroupSize}u; distance *= 2u) {
    var addend = 0u;
    if (local.x >= distance) {
      addend = block_values[local.x - distance];
    }
    workgroupBarrier();
    block_values[local.x] += addend;
    workgroupBarrier();
  }
  if (index < parameters.count) {
    output_prefixes[parameters.output_offset + index] =
      block_values[local.x];
  }
  if (local.x == ${wasmWorkgroupSize - 1}u) {
    block_sums[parameters.block_sum_offset + workgroup.x] =
      block_values[local.x];
  }
}

struct AddParameters {
  count: u32,
  child_offset: u32,
  parent_offset: u32,
}
@group(0) @binding(0) var<storage, read_write> child_prefixes: array<u32>;
@group(0) @binding(1) var<storage, read> parent_prefixes: array<u32>;
@group(0) @binding(2) var<uniform> add_parameters: AddParameters;

@compute @workgroup_size(${wasmWorkgroupSize})
fn add_block_prefixes(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= add_parameters.count) { return; }
  let block = index / ${wasmWorkgroupSize}u;
  if (block > 0u) {
    child_prefixes[add_parameters.child_offset + index] +=
      parent_prefixes[add_parameters.parent_offset + block - 1u];
  }
}
`;

const emissionShader = `
struct Parameters { count: u32 }
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read> low_words: array<u32>;
@group(0) @binding(2) var<storage, read> high_words: array<u32>;
@group(0) @binding(3) var<storage, read> atom_sizes: array<u32>;
@group(0) @binding(4) var<storage, read> inclusive_offsets: array<u32>;
@group(0) @binding(5) var<storage, read_write> output_words: array<atomic<u32>>;
@group(0) @binding(6) var<uniform> parameters: Parameters;

fn emit_byte(offset: u32, value: u32) {
  let word_index = offset >> 2u;
  let shift = (offset & 3u) << 3u;
  atomicOr(&output_words[word_index], (value & 255u) << shift);
}

@compute @workgroup_size(64)
fn emit_atoms(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  let kind = atom_kinds[index];
  let size = atom_sizes[index];
  let output_start = inclusive_offsets[index] - size;
  if (kind == ${atomByte}u) {
    emit_byte(output_start, low_words[index]);
    return;
  }
  if (kind == ${atomUnsigned}u || kind == ${atomLength}u) {
    var remaining = low_words[index];
    for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
      var encoded_byte = remaining & 127u;
      remaining >>= 7u;
      if (byte_index + 1u < size) { encoded_byte |= 128u; }
      emit_byte(output_start + byte_index, encoded_byte);
    }
    return;
  }
  if (kind == ${atomSigned32}u) {
    var remaining = bitcast<i32>(low_words[index]);
    for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
      var encoded_byte = u32(remaining) & 127u;
      remaining >>= 7;
      if (byte_index + 1u < size) { encoded_byte |= 128u; }
      emit_byte(output_start + byte_index, encoded_byte);
    }
    return;
  }
  var low = low_words[index];
  var high = high_words[index];
  for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
    var encoded_byte = low & 127u;
    let next_low = (low >> 7u) | (high << 25u);
    let next_high = bitcast<u32>(bitcast<i32>(high) >> 7);
    if (byte_index + 1u < size) { encoded_byte |= 128u; }
    emit_byte(output_start + byte_index, encoded_byte);
    low = next_low;
    high = next_high;
  }
}
`;

export async function emitWasmPlanOnGpu(
  plan: WasmBinaryPlan,
  options: {
    readonly scheduling?: CompilerGpuSchedulingPolicy;
  } = {},
): Promise<GpuWasmEmissionResult> {
  try {
    const batch = await wasmBatchQueue.enqueue(
      plan,
      options.scheduling ?? "latency",
    );
    return batch.output.status === "completed"
      ? {
        ...batch.output,
        payloadBatchSize: batch.payloadBatchSize,
        queueWaitMilliseconds: batch.queueWaitMilliseconds +
          batch.output.queueWaitMilliseconds,
      }
      : batch.output;
  } catch (error) {
    const reason = compilerGpuUnavailabilityReason("Wasm emission", error);
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  }
}

type PreparedWasmGpuJob = {
  readonly plan: WasmBinaryPlan;
  readonly columns: ReturnType<typeof atomColumns>;
  readonly expectedByteCount: number;
  readonly outputWordCount: number;
  readonly workgroupCount: number;
  readonly scan: HierarchicalScanPlan;
};

type HierarchicalScanPlan = {
  readonly levelCounts: readonly number[];
  readonly hierarchyOffsets: readonly number[];
  readonly hierarchyWordCounts: readonly [number, number];
  readonly scratchOffsets: readonly [number, number];
  readonly dispatchCount: number;
  readonly dispatchedInvocationCount: number;
};

type PackedWasmColumn = {
  readonly words: Uint32Array;
  readonly regions: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly maximumRegionSize: number;
};

async function emitPackedWasmPlansOnGpu(
  plans: readonly WasmBinaryPlan[],
): Promise<readonly GpuWasmEmissionResult[]> {
  try {
    return await emitPackedWasmPlanBatch(plans);
  } catch (error) {
    if (error instanceof CompilerGpuCapacityError && plans.length > 1) {
      const split = Math.ceil(plans.length / 2);
      const [left, right] = await Promise.all([
        emitPackedWasmPlansOnGpu(plans.slice(0, split)),
        emitPackedWasmPlansOnGpu(plans.slice(split)),
      ]);
      return [...left, ...right];
    }
    throw error;
  }
}

async function emitPackedWasmPlanBatch(
  plans: readonly WasmBinaryPlan[],
): Promise<readonly GpuWasmEmissionResult[]> {
  const jobs = plans.map(prepareWasmGpuJob);
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return plans.map(() => context);
  const {
    device,
    emissionPipeline,
    lengthPipeline,
    scanAddPipeline,
    scanPipeline,
    sizePipeline,
  } = context;
  const storageAlignment = device.limits.minStorageBufferOffsetAlignment;
  const uniformAlignment = device.limits.minUniformBufferOffsetAlignment;
  const kinds = packWasmColumns(
    jobs.map((job) => job.columns.kinds),
    4,
    storageAlignment,
  );
  const lowWords = packWasmColumns(
    jobs.map((job) => job.columns.lowWords),
    4,
    storageAlignment,
  );
  const highWords = packWasmColumns(
    jobs.map((job) => job.columns.highWords),
    4,
    storageAlignment,
  );
  const rangeStarts = packWasmColumns(
    jobs.map((job) => job.columns.rangeStarts),
    4,
    storageAlignment,
  );
  const rangeCounts = packWasmColumns(
    jobs.map((job) => job.columns.rangeCounts),
    4,
    storageAlignment,
  );
  const dependencyLevels = packWasmColumns(
    jobs.map((job) => job.columns.dependencyLevels),
    4,
    storageAlignment,
  );
  const sizes = packWasmColumns(
    jobs.map((job) => new Uint32Array(job.plan.atoms.length)),
    4,
    storageAlignment,
  );
  const prefixes = packWasmColumns(
    jobs.map((job) => new Uint32Array(job.plan.atoms.length)),
    4,
    storageAlignment,
  );
  const hierarchySums = ([0, 1] as const).map((bufferIndex) =>
    packWasmColumns(
      jobs.map((job) =>
        new Uint32Array(job.scan.hierarchyWordCounts[bufferIndex])
      ),
      4,
      storageAlignment,
    )
  );
  const hierarchyPrefixes = ([0, 1] as const).map((bufferIndex) =>
    packWasmColumns(
      jobs.map((job) =>
        new Uint32Array(job.scan.hierarchyWordCounts[bufferIndex])
      ),
      4,
      storageAlignment,
    )
  );
  const outputs = packWasmColumns(
    jobs.map((job) => new Uint32Array(job.outputWordCount)),
    4,
    storageAlignment,
  );
  const countParameters = packWasmColumns(
    jobs.map((job) => new Uint32Array([job.plan.atoms.length])),
    4,
    uniformAlignment,
  );
  const passParameterWords: Uint32Array[] = [];
  const lengthParameterIndices = jobs.map((job) =>
    Array.from(
      { length: job.plan.maximumDependencyLevel },
      (_, index) => {
        passParameterWords.push(
          new Uint32Array([job.plan.atoms.length, index + 1, 0, 0]),
        );
        return passParameterWords.length - 1;
      },
    )
  );
  const scanParameterIndices = jobs.map((job) =>
    job.scan.levelCounts.map((count, levelIndex) => {
      const hierarchyOffset = levelIndex === 0
        ? 0
        : job.scan.hierarchyOffsets[levelIndex - 1];
      const hasParentLevel = levelIndex + 1 < job.scan.levelCounts.length;
      passParameterWords.push(
        new Uint32Array([
          count,
          hierarchyOffset,
          hierarchyOffset,
          hasParentLevel
            ? job.scan.hierarchyOffsets[levelIndex]
            : job.scan.scratchOffsets[levelIndex % 2],
        ]),
      );
      return passParameterWords.length - 1;
    })
  );
  const scanAddParameterIndices = jobs.map((job) =>
    job.scan.levelCounts.slice(0, -1).map((count, childLevel) => {
      passParameterWords.push(
        new Uint32Array([
          count,
          childLevel === 0 ? 0 : job.scan.hierarchyOffsets[childLevel - 1],
          job.scan.hierarchyOffsets[childLevel],
          0,
        ]),
      );
      return passParameterWords.length - 1;
    })
  );
  const passParameters = packWasmColumns(
    passParameterWords,
    16,
    uniformAlignment,
  );
  const readbacks = packWasmColumns(
    jobs.map((job) => new Uint32Array(1 + job.outputWordCount)),
    4,
    4,
  );

  const kindBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch atom kinds",
    kinds,
    GPUBufferUsage.STORAGE,
  );
  const lowWordBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch low words",
    lowWords,
    GPUBufferUsage.STORAGE,
  );
  const highWordBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch high words",
    highWords,
    GPUBufferUsage.STORAGE,
  );
  const rangeStartBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch range starts",
    rangeStarts,
    GPUBufferUsage.STORAGE,
  );
  const rangeCountBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch range counts",
    rangeCounts,
    GPUBufferUsage.STORAGE,
  );
  const dependencyLevelBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch dependency levels",
    dependencyLevels,
    GPUBufferUsage.STORAGE,
  );
  const sizeBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch atom sizes",
    sizes,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const prefixBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch prefixes",
    prefixes,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  );
  const hierarchySumBuffers = hierarchySums.map((column, index) =>
    createPackedWasmBuffer(
      device,
      `Wasm batch scan hierarchy sums ${index}`,
      column,
      GPUBufferUsage.STORAGE,
    )
  );
  const hierarchyPrefixBuffers = hierarchyPrefixes.map((column, index) =>
    createPackedWasmBuffer(
      device,
      `Wasm batch scan hierarchy prefixes ${index}`,
      column,
      GPUBufferUsage.STORAGE,
    )
  );
  const outputBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch packed output",
    outputs,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const countParameterBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch count parameters",
    countParameters,
    GPUBufferUsage.UNIFORM,
  );
  const passParameterBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch pass parameters",
    passParameters,
    GPUBufferUsage.UNIFORM,
  );
  const readbackBuffer = createCompilerGpuBuffer(
    device,
    "Wasm batch readback",
    {
      size: readbacks.words.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const buffers = [
    kindBuffer,
    lowWordBuffer,
    highWordBuffer,
    rangeStartBuffer,
    rangeCountBuffer,
    dependencyLevelBuffer,
    sizeBuffer,
    prefixBuffer,
    ...hierarchySumBuffers,
    ...hierarchyPrefixBuffers,
    outputBuffer,
    countParameterBuffer,
    passParameterBuffer,
    readbackBuffer,
  ];
  let readbackMapped = false;
  try {
    const encoder = device.createCommandEncoder();
    const sizePass = encoder.beginComputePass();
    sizePass.setPipeline(sizePipeline);
    for (const [index, job] of jobs.entries()) {
      sizePass.setBindGroup(
        0,
        device.createBindGroup({
          layout: sizePipeline.getBindGroupLayout(0),
          entries: [
            wasmBindGroupEntry(0, kindBuffer, kinds.regions[index]),
            wasmBindGroupEntry(1, lowWordBuffer, lowWords.regions[index]),
            wasmBindGroupEntry(2, highWordBuffer, highWords.regions[index]),
            wasmBindGroupEntry(3, sizeBuffer, sizes.regions[index]),
            wasmBindGroupEntry(
              4,
              countParameterBuffer,
              countParameters.regions[index],
            ),
          ],
        }),
      );
      dispatchCompilerGpuWorkgroups(
        device,
        sizePass,
        `Wasm batch size calculation job ${index}`,
        job.workgroupCount,
      );
    }
    sizePass.end();

    const lengthPass = encoder.beginComputePass();
    lengthPass.setPipeline(lengthPipeline);
    for (const [jobIndex, job] of jobs.entries()) {
      for (
        let level = 1;
        level <= job.plan.maximumDependencyLevel;
        level += 1
      ) {
        const parameterIndex = lengthParameterIndices[jobIndex][level - 1];
        lengthPass.setBindGroup(
          0,
          device.createBindGroup({
            layout: lengthPipeline.getBindGroupLayout(0),
            entries: [
              wasmBindGroupEntry(0, kindBuffer, kinds.regions[jobIndex]),
              wasmBindGroupEntry(
                1,
                lowWordBuffer,
                lowWords.regions[jobIndex],
              ),
              wasmBindGroupEntry(
                2,
                rangeStartBuffer,
                rangeStarts.regions[jobIndex],
              ),
              wasmBindGroupEntry(
                3,
                rangeCountBuffer,
                rangeCounts.regions[jobIndex],
              ),
              wasmBindGroupEntry(
                4,
                dependencyLevelBuffer,
                dependencyLevels.regions[jobIndex],
              ),
              wasmBindGroupEntry(5, sizeBuffer, sizes.regions[jobIndex]),
              wasmBindGroupEntry(
                6,
                passParameterBuffer,
                passParameters.regions[parameterIndex],
              ),
            ],
          }),
        );
        dispatchCompilerGpuWorkgroups(
          device,
          lengthPass,
          `Wasm batch length job ${jobIndex} level ${level}`,
          job.workgroupCount,
        );
      }
    }
    lengthPass.end();

    const scanPass = encoder.beginComputePass();
    scanPass.setPipeline(scanPipeline);
    for (const [jobIndex, job] of jobs.entries()) {
      for (const [levelIndex, count] of job.scan.levelCounts.entries()) {
        const inputBuffer = levelIndex === 0
          ? sizeBuffer
          : hierarchySumBuffers[(levelIndex - 1) % 2];
        const inputRegion = levelIndex === 0
          ? sizes.regions[jobIndex]
          : hierarchySums[(levelIndex - 1) % 2].regions[jobIndex];
        const outputBuffer = levelIndex === 0
          ? prefixBuffer
          : hierarchyPrefixBuffers[(levelIndex - 1) % 2];
        const outputRegion = levelIndex === 0
          ? prefixes.regions[jobIndex]
          : hierarchyPrefixes[(levelIndex - 1) % 2].regions[jobIndex];
        const blockSumBufferIndex = levelIndex % 2;
        const parameterIndex = scanParameterIndices[jobIndex][levelIndex];
        scanPass.setBindGroup(
          0,
          device.createBindGroup({
            layout: scanPipeline.getBindGroupLayout(0),
            entries: [
              wasmBindGroupEntry(0, inputBuffer, inputRegion),
              wasmBindGroupEntry(1, outputBuffer, outputRegion),
              wasmBindGroupEntry(
                2,
                hierarchySumBuffers[blockSumBufferIndex],
                hierarchySums[blockSumBufferIndex].regions[jobIndex],
              ),
              wasmBindGroupEntry(
                3,
                passParameterBuffer,
                passParameters.regions[parameterIndex],
              ),
            ],
          }),
        );
        dispatchCompilerGpuWorkgroups(
          device,
          scanPass,
          `Wasm batch scan job ${jobIndex} level ${levelIndex}`,
          Math.ceil(count / wasmWorkgroupSize),
        );
      }
    }
    scanPass.end();

    const scanAddPass = encoder.beginComputePass();
    scanAddPass.setPipeline(scanAddPipeline);
    for (const [jobIndex, job] of jobs.entries()) {
      for (
        let childLevel = job.scan.levelCounts.length - 2;
        childLevel >= 0;
        childLevel -= 1
      ) {
        const childCount = job.scan.levelCounts[childLevel];
        const childBuffer = childLevel === 0
          ? prefixBuffer
          : hierarchyPrefixBuffers[(childLevel - 1) % 2];
        const childRegion = childLevel === 0
          ? prefixes.regions[jobIndex]
          : hierarchyPrefixes[(childLevel - 1) % 2].regions[jobIndex];
        const parentBufferIndex = childLevel % 2;
        const parameterIndex = scanAddParameterIndices[jobIndex][childLevel];
        scanAddPass.setBindGroup(
          0,
          device.createBindGroup({
            layout: scanAddPipeline.getBindGroupLayout(0),
            entries: [
              wasmBindGroupEntry(0, childBuffer, childRegion),
              wasmBindGroupEntry(
                1,
                hierarchyPrefixBuffers[parentBufferIndex],
                hierarchyPrefixes[parentBufferIndex].regions[jobIndex],
              ),
              wasmBindGroupEntry(
                2,
                passParameterBuffer,
                passParameters.regions[parameterIndex],
              ),
            ],
          }),
        );
        dispatchCompilerGpuWorkgroups(
          device,
          scanAddPass,
          `Wasm batch scan propagation job ${jobIndex} level ${childLevel}`,
          Math.ceil(childCount / wasmWorkgroupSize),
        );
      }
    }
    scanAddPass.end();

    const emissionPass = encoder.beginComputePass();
    emissionPass.setPipeline(emissionPipeline);
    for (const [index, job] of jobs.entries()) {
      emissionPass.setBindGroup(
        0,
        device.createBindGroup({
          layout: emissionPipeline.getBindGroupLayout(0),
          entries: [
            wasmBindGroupEntry(0, kindBuffer, kinds.regions[index]),
            wasmBindGroupEntry(1, lowWordBuffer, lowWords.regions[index]),
            wasmBindGroupEntry(2, highWordBuffer, highWords.regions[index]),
            wasmBindGroupEntry(3, sizeBuffer, sizes.regions[index]),
            wasmBindGroupEntry(4, prefixBuffer, prefixes.regions[index]),
            wasmBindGroupEntry(5, outputBuffer, outputs.regions[index]),
            wasmBindGroupEntry(
              6,
              countParameterBuffer,
              countParameters.regions[index],
            ),
          ],
        }),
      );
      dispatchCompilerGpuWorkgroups(
        device,
        emissionPass,
        `Wasm batch emission job ${index}`,
        job.workgroupCount,
      );
    }
    emissionPass.end();

    for (const [index, job] of jobs.entries()) {
      encoder.copyBufferToBuffer(
        prefixBuffer,
        prefixes.regions[index].offset +
          (job.plan.atoms.length - 1) * 4,
        readbackBuffer,
        readbacks.regions[index].offset,
        4,
      );
      encoder.copyBufferToBuffer(
        outputBuffer,
        outputs.regions[index].offset,
        readbackBuffer,
        readbacks.regions[index].offset + 4,
        job.outputWordCount * 4,
      );
    }

    const submission = await submitCompilerGpuCommand(
      device,
      "Wasm payload batch",
      encoder.finish(),
      "latency",
    );
    await awaitCompilerGpuCommand(
      device,
      "Wasm payload batch",
      readbackBuffer.mapAsync(GPUMapMode.READ),
    );
    readbackMapped = true;
    const mapped = readbackBuffer.getMappedRange();
    return jobs.map((job, index) => {
      const readbackOffset = readbacks.regions[index].offset;
      const byteCount = new Uint32Array(mapped, readbackOffset, 1)[0];
      if (byteCount !== job.expectedByteCount) {
        throw new Error(
          `WebGPU Wasm batch job ${index} returned ${byteCount} bytes; CPU plan measure is ${job.expectedByteCount}`,
        );
      }
      return {
        status: "completed",
        bytes: new Uint8Array(mapped, readbackOffset + 4, byteCount).slice(),
        atomCount: job.plan.atoms.length,
        byteCount,
        outputBufferBytes: job.outputWordCount * 4,
        lengthRounds: job.plan.maximumDependencyLevel,
        scanDispatchCount: job.scan.dispatchCount,
        dispatchedInvocationCount: job.workgroupCount * wasmWorkgroupSize *
            (2 + job.plan.maximumDependencyLevel) +
          job.scan.dispatchedInvocationCount,
        submissionBatchSize: submission.submissionBatchSize,
        payloadBatchSize: jobs.length,
        queueWaitMilliseconds: submission.queueWaitMilliseconds,
      };
    });
  } finally {
    if (readbackMapped) readbackBuffer.unmap();
    buffers.forEach((buffer) => buffer.destroy());
  }
}

function prepareWasmGpuJob(plan: WasmBinaryPlan): PreparedWasmGpuJob {
  const expectedByteCount = wasmBinaryPlanByteLength(plan);
  const levelCounts = [plan.atoms.length];
  while (levelCounts.at(-1)! > wasmWorkgroupSize) {
    levelCounts.push(
      Math.ceil(levelCounts.at(-1)! / wasmWorkgroupSize),
    );
  }
  const hierarchyOffsets: number[] = [];
  const hierarchyWordCounts: [number, number] = [0, 0];
  for (const [hierarchyIndex, count] of levelCounts.slice(1).entries()) {
    const bufferIndex = hierarchyIndex % 2;
    hierarchyOffsets.push(hierarchyWordCounts[bufferIndex]);
    hierarchyWordCounts[bufferIndex] += count;
  }
  const scratchOffsets: [number, number] = [
    hierarchyWordCounts[0],
    hierarchyWordCounts[1],
  ];
  hierarchyWordCounts[0] += 1;
  hierarchyWordCounts[1] += 1;
  const upwardInvocationCount = levelCounts.reduce(
    (total, count) =>
      total + Math.ceil(count / wasmWorkgroupSize) * wasmWorkgroupSize,
    0,
  );
  const downwardInvocationCount = levelCounts.slice(0, -1).reduce(
    (total, count) =>
      total + Math.ceil(count / wasmWorkgroupSize) * wasmWorkgroupSize,
    0,
  );
  return {
    plan,
    columns: atomColumns(plan.atoms),
    expectedByteCount,
    outputWordCount: Math.ceil(expectedByteCount / 4),
    workgroupCount: Math.ceil(plan.atoms.length / wasmWorkgroupSize),
    scan: {
      levelCounts,
      hierarchyOffsets,
      hierarchyWordCounts,
      scratchOffsets,
      dispatchCount: levelCounts.length * 2 - 1,
      dispatchedInvocationCount: upwardInvocationCount +
        downwardInvocationCount,
    },
  };
}

function packWasmColumns(
  columns: readonly Uint32Array[],
  minimumRegionBytes: number,
  alignment: number,
): PackedWasmColumn {
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
  const words = new Uint32Array(
    Math.max(1, Math.ceil(byteLength / 4)),
  );
  for (const [index, column] of columns.entries()) {
    words.set(column, regions[index].offset / 4);
  }
  return {
    words,
    regions,
    maximumRegionSize: Math.max(minimumRegionBytes, maximumRegionSize),
  };
}

function createPackedWasmBuffer(
  device: GPUDevice,
  label: string,
  column: PackedWasmColumn,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const binding = (usage & GPUBufferUsage.UNIFORM) !== 0
    ? "uniform"
    : "storage";
  const buffer = createCompilerGpuBuffer(
    device,
    label,
    {
      size: column.words.byteLength,
      usage,
      mappedAtCreation: true,
    },
    binding,
    column.maximumRegionSize,
  );
  new Uint32Array(buffer.getMappedRange()).set(column.words);
  buffer.unmap();
  return buffer;
}

function wasmBindGroupEntry(
  binding: number,
  buffer: GPUBuffer,
  region: { readonly offset: number; readonly size: number },
): GPUBindGroupEntry {
  return {
    binding,
    resource: { buffer, offset: region.offset, size: region.size },
  };
}

async function emitWasmPlanWithGpu(
  plan: WasmBinaryPlan,
  scheduling: CompilerGpuSchedulingPolicy,
): Promise<GpuWasmEmissionResult> {
  const job = prepareWasmGpuJob(plan);
  const {
    columns,
    expectedByteCount,
    outputWordCount,
    scan,
    workgroupCount,
  } = job;
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return context;
  const {
    device,
    emissionPipeline,
    lengthPipeline,
    scanAddPipeline,
    scanPipeline,
    sizePipeline,
  } = context;
  const atomBytes = Math.max(4, columns.kinds.byteLength);
  const hierarchyBytes = scan.hierarchyWordCounts.map((count) => count * 4);
  const outputBytes = outputWordCount * 4;
  const capacityRequests = [
    ["atom kinds", atomBytes, "storage"],
    ["atom low words", atomBytes, "storage"],
    ["atom high words", atomBytes, "storage"],
    ["range starts", atomBytes, "storage"],
    ["range counts", atomBytes, "storage"],
    ["dependency levels", atomBytes, "storage"],
    ["atom sizes", atomBytes, "storage"],
    ["prefixes", atomBytes, "storage"],
    ["scan hierarchy sums 0", hierarchyBytes[0], "storage"],
    ["scan hierarchy sums 1", hierarchyBytes[1], "storage"],
    ["scan hierarchy prefixes 0", hierarchyBytes[0], "storage"],
    ["scan hierarchy prefixes 1", hierarchyBytes[1], "storage"],
    ["packed output", outputBytes, "storage"],
    ["count parameters", 4, "uniform"],
    ["pass parameters", 16, "uniform"],
    ["readback", 4 + outputBytes, "copy"],
  ] as const;
  for (const [label, byteLength, binding] of capacityRequests) {
    const reason = compilerGpuCapacityViolation(device.limits, {
      kind: "buffer",
      label: `Wasm ${label}`,
      byteLength,
      binding,
    });
    if (reason !== undefined) return { status: "unavailable", reason };
  }
  const dispatchReason = compilerGpuCapacityViolation(device.limits, {
    kind: "dispatch",
    label: "Wasm emission",
    workgroupCount,
  });
  if (dispatchReason !== undefined) {
    return { status: "unavailable", reason: dispatchReason };
  }

  const kindBuffer = createBuffer(
    device,
    "Wasm atom kinds",
    columns.kinds,
    GPUBufferUsage.STORAGE,
  );
  const lowWordBuffer = createBuffer(
    device,
    "Wasm atom low words",
    columns.lowWords,
    GPUBufferUsage.STORAGE,
  );
  const highWordBuffer = createBuffer(
    device,
    "Wasm atom high words",
    columns.highWords,
    GPUBufferUsage.STORAGE,
  );
  const rangeStartBuffer = createBuffer(
    device,
    "Wasm range starts",
    columns.rangeStarts,
    GPUBufferUsage.STORAGE,
  );
  const rangeCountBuffer = createBuffer(
    device,
    "Wasm range counts",
    columns.rangeCounts,
    GPUBufferUsage.STORAGE,
  );
  const dependencyLevelBuffer = createBuffer(
    device,
    "Wasm dependency levels",
    columns.dependencyLevels,
    GPUBufferUsage.STORAGE,
  );
  const sizeBuffer = createCompilerGpuBuffer(
    device,
    "Wasm atom sizes",
    {
      size: atomBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const prefixBuffer = createCompilerGpuBuffer(
    device,
    "Wasm prefixes",
    {
      size: atomBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const hierarchySumBuffers = hierarchyBytes.map((size, index) =>
    createCompilerGpuBuffer(
      device,
      `Wasm scan hierarchy sums ${index}`,
      { size, usage: GPUBufferUsage.STORAGE },
      "storage",
    )
  );
  const hierarchyPrefixBuffers = hierarchyBytes.map((size, index) =>
    createCompilerGpuBuffer(
      device,
      `Wasm scan hierarchy prefixes ${index}`,
      { size, usage: GPUBufferUsage.STORAGE },
      "storage",
    )
  );
  const outputBuffer = createCompilerGpuBuffer(
    device,
    "Wasm packed output",
    {
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const countParameterBuffer = createBuffer(
    device,
    "Wasm count parameters",
    new Uint32Array([plan.atoms.length]),
    GPUBufferUsage.UNIFORM,
  );
  const readback = createCompilerGpuBuffer(
    device,
    "Wasm readback",
    {
      size: 4 + outputBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const transientParameterBuffers: GPUBuffer[] = [];
  const buffers = [
    kindBuffer,
    lowWordBuffer,
    highWordBuffer,
    rangeStartBuffer,
    rangeCountBuffer,
    dependencyLevelBuffer,
    sizeBuffer,
    prefixBuffer,
    ...hierarchySumBuffers,
    ...hierarchyPrefixBuffers,
    outputBuffer,
    countParameterBuffer,
    readback,
  ];
  let readbackMapped = false;
  try {
    const encoder = device.createCommandEncoder();
    const sizeBindGroup = device.createBindGroup({
      layout: sizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: kindBuffer } },
        { binding: 1, resource: { buffer: lowWordBuffer } },
        { binding: 2, resource: { buffer: highWordBuffer } },
        { binding: 3, resource: { buffer: sizeBuffer } },
        { binding: 4, resource: { buffer: countParameterBuffer } },
      ],
    });
    const sizePass = encoder.beginComputePass();
    sizePass.setPipeline(sizePipeline);
    sizePass.setBindGroup(0, sizeBindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      sizePass,
      "Wasm size calculation",
      workgroupCount,
    );
    sizePass.end();

    for (
      let level = 1;
      level <= plan.maximumDependencyLevel;
      level += 1
    ) {
      const parameterBuffer = createBuffer(
        device,
        `Wasm length parameters ${level}`,
        new Uint32Array([plan.atoms.length, level]),
        GPUBufferUsage.UNIFORM,
      );
      transientParameterBuffers.push(parameterBuffer);
      const bindGroup = device.createBindGroup({
        layout: lengthPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: kindBuffer } },
          { binding: 1, resource: { buffer: lowWordBuffer } },
          { binding: 2, resource: { buffer: rangeStartBuffer } },
          { binding: 3, resource: { buffer: rangeCountBuffer } },
          { binding: 4, resource: { buffer: dependencyLevelBuffer } },
          { binding: 5, resource: { buffer: sizeBuffer } },
          { binding: 6, resource: { buffer: parameterBuffer } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(lengthPipeline);
      pass.setBindGroup(0, bindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        `Wasm length level ${level}`,
        workgroupCount,
      );
      pass.end();
    }

    const scanPass = encoder.beginComputePass();
    scanPass.setPipeline(scanPipeline);
    for (const [levelIndex, count] of scan.levelCounts.entries()) {
      const hierarchyOffset = levelIndex === 0
        ? 0
        : scan.hierarchyOffsets[levelIndex - 1];
      const hasParentLevel = levelIndex + 1 < scan.levelCounts.length;
      const parameterBuffer = createBuffer(
        device,
        `Wasm scan parameters ${levelIndex}`,
        new Uint32Array([
          count,
          hierarchyOffset,
          hierarchyOffset,
          hasParentLevel
            ? scan.hierarchyOffsets[levelIndex]
            : scan.scratchOffsets[levelIndex % 2],
        ]),
        GPUBufferUsage.UNIFORM,
      );
      transientParameterBuffers.push(parameterBuffer);
      const bindGroup = device.createBindGroup({
        layout: scanPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: levelIndex === 0
                ? sizeBuffer
                : hierarchySumBuffers[(levelIndex - 1) % 2],
            },
          },
          {
            binding: 1,
            resource: {
              buffer: levelIndex === 0
                ? prefixBuffer
                : hierarchyPrefixBuffers[(levelIndex - 1) % 2],
            },
          },
          {
            binding: 2,
            resource: { buffer: hierarchySumBuffers[levelIndex % 2] },
          },
          { binding: 3, resource: { buffer: parameterBuffer } },
        ],
      });
      scanPass.setBindGroup(0, bindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        scanPass,
        `Wasm scan level ${levelIndex}`,
        Math.ceil(count / wasmWorkgroupSize),
      );
    }
    scanPass.end();

    const scanAddPass = encoder.beginComputePass();
    scanAddPass.setPipeline(scanAddPipeline);
    for (
      let childLevel = scan.levelCounts.length - 2;
      childLevel >= 0;
      childLevel -= 1
    ) {
      const childCount = scan.levelCounts[childLevel];
      const parameterBuffer = createBuffer(
        device,
        `Wasm scan propagation parameters ${childLevel}`,
        new Uint32Array([
          childCount,
          childLevel === 0 ? 0 : scan.hierarchyOffsets[childLevel - 1],
          scan.hierarchyOffsets[childLevel],
          0,
        ]),
        GPUBufferUsage.UNIFORM,
      );
      transientParameterBuffers.push(parameterBuffer);
      const bindGroup = device.createBindGroup({
        layout: scanAddPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: childLevel === 0
                ? prefixBuffer
                : hierarchyPrefixBuffers[(childLevel - 1) % 2],
            },
          },
          {
            binding: 1,
            resource: { buffer: hierarchyPrefixBuffers[childLevel % 2] },
          },
          { binding: 2, resource: { buffer: parameterBuffer } },
        ],
      });
      scanAddPass.setBindGroup(0, bindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        scanAddPass,
        `Wasm scan propagation level ${childLevel}`,
        Math.ceil(childCount / wasmWorkgroupSize),
      );
    }
    scanAddPass.end();

    const emissionBindGroup = device.createBindGroup({
      layout: emissionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: kindBuffer } },
        { binding: 1, resource: { buffer: lowWordBuffer } },
        { binding: 2, resource: { buffer: highWordBuffer } },
        { binding: 3, resource: { buffer: sizeBuffer } },
        { binding: 4, resource: { buffer: prefixBuffer } },
        { binding: 5, resource: { buffer: outputBuffer } },
        { binding: 6, resource: { buffer: countParameterBuffer } },
      ],
    });
    const emissionPass = encoder.beginComputePass();
    emissionPass.setPipeline(emissionPipeline);
    emissionPass.setBindGroup(0, emissionBindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      emissionPass,
      "Wasm byte emission",
      workgroupCount,
    );
    emissionPass.end();
    encoder.copyBufferToBuffer(
      prefixBuffer,
      (plan.atoms.length - 1) * 4,
      readback,
      0,
      4,
    );
    encoder.copyBufferToBuffer(
      outputBuffer,
      0,
      readback,
      4,
      outputWordCount * 4,
    );
    const submission = await submitCompilerGpuCommand(
      device,
      "Wasm emission",
      encoder.finish(),
      scheduling,
    );
    await awaitCompilerGpuCommand(
      device,
      "Wasm emission",
      readback.mapAsync(GPUMapMode.READ),
    );
    readbackMapped = true;
    const mapped = readback.getMappedRange();
    const byteCount = new Uint32Array(mapped, 0, 1)[0];
    if (byteCount !== expectedByteCount) {
      throw new Error(
        `WebGPU Wasm emitter returned ${byteCount} bytes; CPU plan measure is ${expectedByteCount}`,
      );
    }
    const bytes = new Uint8Array(mapped, 4, byteCount).slice();
    return {
      status: "completed",
      bytes,
      atomCount: plan.atoms.length,
      byteCount,
      outputBufferBytes: outputWordCount * 4,
      lengthRounds: plan.maximumDependencyLevel,
      scanDispatchCount: scan.dispatchCount,
      dispatchedInvocationCount: workgroupCount * wasmWorkgroupSize *
          (2 + plan.maximumDependencyLevel) +
        scan.dispatchedInvocationCount,
      submissionBatchSize: submission.submissionBatchSize,
      payloadBatchSize: 1,
      queueWaitMilliseconds: submission.queueWaitMilliseconds,
    };
  } catch (error) {
    const reason = compilerGpuUnavailabilityReason("Wasm emission", error);
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  } finally {
    if (readbackMapped) readback.unmap();
    for (const buffer of [...buffers, ...transientParameterBuffers]) {
      buffer.destroy();
    }
  }
}

function atomColumns(atoms: readonly WasmAtom[]): {
  readonly kinds: Uint32Array;
  readonly lowWords: Uint32Array;
  readonly highWords: Uint32Array;
  readonly rangeStarts: Uint32Array;
  readonly rangeCounts: Uint32Array;
  readonly dependencyLevels: Uint32Array;
} {
  const kinds = new Uint32Array(atoms.length);
  const lowWords = new Uint32Array(atoms.length);
  const highWords = new Uint32Array(atoms.length);
  const rangeStarts = new Uint32Array(atoms.length);
  const rangeCounts = new Uint32Array(atoms.length);
  const dependencyLevels = new Uint32Array(atoms.length);
  for (const [index, atom] of atoms.entries()) {
    if (atom.kind === "byte") {
      kinds[index] = atomByte;
      lowWords[index] = atom.value;
      continue;
    }
    if (atom.kind === "unsigned") {
      kinds[index] = atomUnsigned;
      lowWords[index] = atom.value;
      continue;
    }
    if (atom.kind === "signed32") {
      kinds[index] = atomSigned32;
      lowWords[index] = atom.value >>> 0;
      continue;
    }
    if (atom.kind === "signed64") {
      kinds[index] = atomSigned64;
      lowWords[index] = Number(BigInt.asUintN(32, atom.value));
      highWords[index] = Number(BigInt.asUintN(32, atom.value >> 32n));
      continue;
    }
    kinds[index] = atomLength;
    rangeStarts[index] = atom.rangeStart;
    rangeCounts[index] = atom.rangeCount;
    dependencyLevels[index] = atom.dependencyLevel;
  }
  return {
    kinds,
    lowWords,
    highWords,
    rangeStarts,
    rangeCounts,
    dependencyLevels,
  };
}

function requestGpuWasmContext(): Promise<GpuWasmContextRequest> {
  if (contextPromise !== undefined) return contextPromise;
  const pendingContext: Promise<GpuWasmContextRequest> = (async () => {
    try {
      const request = await requestCompilerGpuDevice();
      if (request.status === "unavailable") return request;
      const device = request.device;
      requireCompilerGpuCapacity(device, {
        kind: "pipelineBindings",
        label: "Wasm emission",
        storageBufferCount: 6,
        uniformBufferCount: 1,
      });
      const modules = [
        device.createShaderModule({ code: sizeShader }),
        device.createShaderModule({ code: lengthShader }),
        device.createShaderModule({ code: scanShader }),
        device.createShaderModule({ code: emissionShader }),
      ];
      const compilationMessages = (await Promise.all(
        modules.map((module) => module.getCompilationInfo()),
      )).flatMap((info) => info.messages).filter((message) =>
        message.type === "error"
      );
      if (compilationMessages.length > 0) {
        throw new Error(
          `WebGPU Wasm emitter shader failed: ${
            compilationMessages.map((message) => message.message).join("; ")
          }`,
        );
      }
      const [
        sizePipeline,
        lengthPipeline,
        scanPipeline,
        scanAddPipeline,
        emissionPipeline,
      ] = await Promise.all(
        [
          [modules[0], "calculate_sizes"],
          [modules[1], "calculate_lengths"],
          [modules[2], "scan_blocks"],
          [modules[2], "add_block_prefixes"],
          [modules[3], "emit_atoms"],
        ].map(([module, entryPoint]) =>
          device.createComputePipelineAsync({
            layout: "auto",
            compute: {
              module: module as GPUShaderModule,
              entryPoint: entryPoint as string,
            },
          })
        ),
      );
      return {
        status: "available",
        device,
        sizePipeline,
        lengthPipeline,
        scanPipeline,
        scanAddPipeline,
        emissionPipeline,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: `WebGPU Wasm emitter initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  })();
  contextPromise = pendingContext;
  void pendingContext.then((context) => {
    if (context.status === "unavailable") {
      if (contextPromise === pendingContext) contextPromise = undefined;
      return;
    }
    void context.device.lost.then(() => {
      if (contextPromise === pendingContext) contextPromise = undefined;
    });
  });
  return pendingContext;
}

function createBuffer(
  device: GPUDevice,
  label: string,
  words: Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const binding = (usage & GPUBufferUsage.UNIFORM) !== 0
    ? "uniform"
    : "storage";
  const buffer = createCompilerGpuBuffer(
    device,
    label,
    {
      size: Math.max(4, words.byteLength),
      usage,
      mappedAtCreation: true,
    },
    binding,
  );
  new Uint32Array(buffer.getMappedRange()).set(words);
  buffer.unmap();
  return buffer;
}

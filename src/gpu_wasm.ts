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
  validateWasmBinaryPlan,
  type WasmAtom,
  type WasmBinaryPlan,
} from "./wasm.ts";

export type GpuWasmEmissionResult =
  | {
    readonly status: "completed";
    readonly bytes: Uint8Array;
    readonly atomCount: number;
    readonly byteCount: number;
    readonly outputBufferBytes: number;
    readonly lengthRounds: number;
    readonly scanRounds: number;
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
    readonly emissionPipeline: GPUComputePipeline;
  }
  | { readonly status: "unavailable"; readonly reason: string };

const atomByte = 0;
const atomUnsigned = 1;
const atomSigned32 = 2;
const atomSigned64 = 3;
const atomLength = 4;
const maximumEncodedAtomSize = 10;
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
  readonly maximumByteCount: number;
  readonly maximumOutputWordCount: number;
  readonly workgroupCount: number;
  readonly scanDistances: readonly number[];
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
  const alternatePrefixes = packWasmColumns(
    jobs.map((job) => new Uint32Array(job.plan.atoms.length)),
    4,
    storageAlignment,
  );
  const outputs = packWasmColumns(
    jobs.map((job) => new Uint32Array(job.maximumOutputWordCount)),
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
          new Uint32Array([job.plan.atoms.length, index + 1]),
        );
        return passParameterWords.length - 1;
      },
    )
  );
  const scanParameterIndices = jobs.map((job) =>
    job.scanDistances.map((distance) => {
      passParameterWords.push(
        new Uint32Array([job.plan.atoms.length, distance]),
      );
      return passParameterWords.length - 1;
    })
  );
  const passParameters = packWasmColumns(
    passParameterWords,
    8,
    uniformAlignment,
  );
  const readbacks = packWasmColumns(
    jobs.map((job) => new Uint32Array(1 + job.maximumOutputWordCount)),
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
  const alternatePrefixBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch alternate prefixes",
    alternatePrefixes,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
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
    alternatePrefixBuffer,
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

    for (const [index, job] of jobs.entries()) {
      encoder.copyBufferToBuffer(
        sizeBuffer,
        sizes.regions[index].offset,
        prefixBuffer,
        prefixes.regions[index].offset,
        job.columns.kinds.byteLength,
      );
    }

    const finalPrefixBuffers: GPUBuffer[] = [];
    const scanPass = encoder.beginComputePass();
    scanPass.setPipeline(scanPipeline);
    for (const [jobIndex, job] of jobs.entries()) {
      let inputPrefixBuffer = prefixBuffer;
      let outputPrefixBuffer = alternatePrefixBuffer;
      for (
        const [round, distance] of job.scanDistances.entries()
      ) {
        const parameterIndex = scanParameterIndices[jobIndex][round];
        scanPass.setBindGroup(
          0,
          device.createBindGroup({
            layout: scanPipeline.getBindGroupLayout(0),
            entries: [
              wasmBindGroupEntry(
                0,
                inputPrefixBuffer,
                inputPrefixBuffer === prefixBuffer
                  ? prefixes.regions[jobIndex]
                  : alternatePrefixes.regions[jobIndex],
              ),
              wasmBindGroupEntry(
                1,
                outputPrefixBuffer,
                outputPrefixBuffer === prefixBuffer
                  ? prefixes.regions[jobIndex]
                  : alternatePrefixes.regions[jobIndex],
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
          scanPass,
          `Wasm batch scan job ${jobIndex} distance ${distance}`,
          job.workgroupCount,
        );
        [inputPrefixBuffer, outputPrefixBuffer] = [
          outputPrefixBuffer,
          inputPrefixBuffer,
        ];
      }
      finalPrefixBuffers.push(inputPrefixBuffer);
    }
    scanPass.end();

    const emissionPass = encoder.beginComputePass();
    emissionPass.setPipeline(emissionPipeline);
    for (const [index, job] of jobs.entries()) {
      const finalPrefixBuffer = finalPrefixBuffers[index];
      emissionPass.setBindGroup(
        0,
        device.createBindGroup({
          layout: emissionPipeline.getBindGroupLayout(0),
          entries: [
            wasmBindGroupEntry(0, kindBuffer, kinds.regions[index]),
            wasmBindGroupEntry(1, lowWordBuffer, lowWords.regions[index]),
            wasmBindGroupEntry(2, highWordBuffer, highWords.regions[index]),
            wasmBindGroupEntry(3, sizeBuffer, sizes.regions[index]),
            wasmBindGroupEntry(
              4,
              finalPrefixBuffer,
              finalPrefixBuffer === prefixBuffer
                ? prefixes.regions[index]
                : alternatePrefixes.regions[index],
            ),
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
      const finalPrefixBuffer = finalPrefixBuffers[index];
      const finalPrefixRegion = finalPrefixBuffer === prefixBuffer
        ? prefixes.regions[index]
        : alternatePrefixes.regions[index];
      encoder.copyBufferToBuffer(
        finalPrefixBuffer,
        finalPrefixRegion.offset + (job.plan.atoms.length - 1) * 4,
        readbackBuffer,
        readbacks.regions[index].offset,
        4,
      );
      encoder.copyBufferToBuffer(
        outputBuffer,
        outputs.regions[index].offset,
        readbackBuffer,
        readbacks.regions[index].offset + 4,
        job.maximumOutputWordCount * 4,
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
      if (byteCount > job.maximumByteCount) {
        throw new RangeError(
          `WebGPU Wasm batch job ${index} returned ${byteCount} bytes; plan maximum is ${job.maximumByteCount}`,
        );
      }
      return {
        status: "completed",
        bytes: new Uint8Array(mapped, readbackOffset + 4, byteCount).slice(),
        atomCount: job.plan.atoms.length,
        byteCount,
        outputBufferBytes: job.maximumOutputWordCount * 4,
        lengthRounds: job.plan.maximumDependencyLevel,
        scanRounds: job.scanDistances.length,
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
  validateWasmBinaryPlan(plan);
  const maximumByteCount = plan.atoms.length * maximumEncodedAtomSize;
  if (
    !Number.isSafeInteger(maximumByteCount) || maximumByteCount > 0xffff_ffff
  ) {
    throw new RangeError(
      `GPU Wasm plan contains ${plan.atoms.length} atoms; its maximum encoded size exceeds u32`,
    );
  }
  const scanDistances: number[] = [];
  for (let distance = 1; distance < plan.atoms.length; distance *= 2) {
    scanDistances.push(distance);
  }
  return {
    plan,
    columns: atomColumns(plan.atoms),
    maximumByteCount,
    maximumOutputWordCount: Math.ceil(maximumByteCount / 4),
    workgroupCount: Math.ceil(plan.atoms.length / 64),
    scanDistances,
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
  validateWasmBinaryPlan(plan);
  const columns = atomColumns(plan.atoms);
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return context;
  const {
    device,
    emissionPipeline,
    lengthPipeline,
    scanPipeline,
    sizePipeline,
  } = context;
  const maximumByteCount = plan.atoms.length * maximumEncodedAtomSize;
  if (
    !Number.isSafeInteger(maximumByteCount) || maximumByteCount > 0xffff_ffff
  ) {
    throw new RangeError(
      `GPU Wasm plan contains ${plan.atoms.length} atoms; its maximum encoded size exceeds u32`,
    );
  }
  const maximumOutputWordCount = Math.ceil(maximumByteCount / 4);
  const atomBytes = Math.max(4, columns.kinds.byteLength);
  const outputBytes = maximumOutputWordCount * 4;
  const capacityRequests = [
    ["atom kinds", atomBytes, "storage"],
    ["atom low words", atomBytes, "storage"],
    ["atom high words", atomBytes, "storage"],
    ["range starts", atomBytes, "storage"],
    ["range counts", atomBytes, "storage"],
    ["dependency levels", atomBytes, "storage"],
    ["atom sizes", atomBytes, "storage"],
    ["prefixes", atomBytes, "storage"],
    ["alternate prefixes", atomBytes, "storage"],
    ["packed output", outputBytes, "storage"],
    ["count parameters", 4, "uniform"],
    ["pass parameters", 8, "uniform"],
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
  const workgroupCount = Math.ceil(plan.atoms.length / 64);
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
  const alternatePrefixBuffer = createCompilerGpuBuffer(
    device,
    "Wasm alternate prefixes",
    {
      size: atomBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
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
    alternatePrefixBuffer,
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

    encoder.copyBufferToBuffer(
      sizeBuffer,
      0,
      prefixBuffer,
      0,
      columns.kinds.byteLength,
    );
    let inputPrefixBuffer = prefixBuffer;
    let outputPrefixBuffer = alternatePrefixBuffer;
    let scanRounds = 0;
    for (let distance = 1; distance < plan.atoms.length; distance *= 2) {
      const parameterBuffer = createBuffer(
        device,
        `Wasm scan parameters ${distance}`,
        new Uint32Array([plan.atoms.length, distance]),
        GPUBufferUsage.UNIFORM,
      );
      transientParameterBuffers.push(parameterBuffer);
      const bindGroup = device.createBindGroup({
        layout: scanPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputPrefixBuffer } },
          { binding: 1, resource: { buffer: outputPrefixBuffer } },
          { binding: 2, resource: { buffer: parameterBuffer } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(scanPipeline);
      pass.setBindGroup(0, bindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        `Wasm scan distance ${distance}`,
        workgroupCount,
      );
      pass.end();
      [inputPrefixBuffer, outputPrefixBuffer] = [
        outputPrefixBuffer,
        inputPrefixBuffer,
      ];
      scanRounds += 1;
    }

    const emissionBindGroup = device.createBindGroup({
      layout: emissionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: kindBuffer } },
        { binding: 1, resource: { buffer: lowWordBuffer } },
        { binding: 2, resource: { buffer: highWordBuffer } },
        { binding: 3, resource: { buffer: sizeBuffer } },
        { binding: 4, resource: { buffer: inputPrefixBuffer } },
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
      inputPrefixBuffer,
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
      maximumOutputWordCount * 4,
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
    if (byteCount > maximumByteCount) {
      throw new RangeError(
        `WebGPU Wasm emitter returned ${byteCount} bytes; plan maximum is ${maximumByteCount}`,
      );
    }
    const bytes = new Uint8Array(mapped, 4, byteCount).slice();
    return {
      status: "completed",
      bytes,
      atomCount: plan.atoms.length,
      byteCount,
      outputBufferBytes: maximumOutputWordCount * 4,
      lengthRounds: plan.maximumDependencyLevel,
      scanRounds,
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
        emissionPipeline,
      ] = await Promise.all(
        [
          [modules[0], "calculate_sizes"],
          [modules[1], "calculate_lengths"],
          [modules[2], "scan_step"],
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

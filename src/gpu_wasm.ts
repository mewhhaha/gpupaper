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
  analyzeWasmBinaryPlan,
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
    readonly lengthAtomCount: number;
    readonly resolvedOffsetBytes: number;
    readonly resolvedOffsetBitWidth: 16 | 32;
    readonly atomInputBytes: number;
    readonly signed64AtomCount: number;
    readonly signed64HighWordBytes: number;
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

const emissionShader = `
struct Parameters {
  count: u32,
  signed64_count: u32,
  sparse_signed64_high_words: u32,
  packed_u16_offsets: u32,
}
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read> low_words: array<u32>;
@group(0) @binding(2) var<storage, read> high_words: array<u32>;
@group(0) @binding(3) var<storage, read> atom_offsets: array<u32>;
@group(0) @binding(4) var<storage, read_write> output_words: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> parameters: Parameters;

fn emit_byte(offset: u32, value: u32) {
  let word_index = offset >> 2u;
  let shift = (offset & 3u) << 3u;
  atomicOr(&output_words[word_index], (value & 255u) << shift);
}

fn atom_offset(index: u32) -> u32 {
  if (parameters.packed_u16_offsets == 0u) {
    return atom_offsets[index];
  }
  let word = atom_offsets[index >> 1u];
  return (word >> ((index & 1u) << 4u)) & 0xffffu;
}

fn signed64_high_word(atom_index: u32) -> u32 {
  if (parameters.sparse_signed64_high_words == 0u) {
    return high_words[atom_index];
  }
  var lower = 0u;
  var upper = parameters.signed64_count;
  while (lower < upper) {
    let middle = lower + (upper - lower) / 2u;
    let candidate = high_words[middle * 2u];
    if (candidate < atom_index) {
      lower = middle + 1u;
    } else {
      upper = middle;
    }
  }
  if (
    lower >= parameters.signed64_count ||
    high_words[lower * 2u] != atom_index
  ) {
    return 0u;
  }
  return high_words[lower * 2u + 1u];
}

@compute @workgroup_size(64)
fn emit_atoms(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  let kind_word = atom_kinds[index >> 3u];
  let kind = (kind_word >> ((index & 7u) << 2u)) & 15u;
  let output_start = atom_offset(index);
  let size = atom_offset(index + 1u) - output_start;
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
  if (kind != ${atomSigned64}u) { return; }
  var low = low_words[index];
  var high = signed64_high_word(index);
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
  readonly atomByteOffsets: Uint32Array;
  readonly resolvedOffsetBitWidth: 16 | 32;
  readonly lengthAtomCount: number;
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
  const { device, emissionPipeline } = context;
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
  const atomByteOffsets = packWasmColumns(
    jobs.map((job) => job.atomByteOffsets),
    4,
    storageAlignment,
  );
  const outputs = packWasmColumns(
    jobs.map((job) => new Uint32Array(job.outputWordCount)),
    4,
    storageAlignment,
  );
  const countParameters = packWasmColumns(
    jobs.map((job) =>
      new Uint32Array([
        job.plan.atoms.length,
        job.columns.signed64AtomCount,
        job.columns.sparseSigned64HighWords ? 1 : 0,
        job.resolvedOffsetBitWidth === 16 ? 1 : 0,
      ])
    ),
    16,
    uniformAlignment,
  );
  const readbacks = packWasmColumns(
    jobs.map((job) => new Uint32Array(job.outputWordCount)),
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
  const atomByteOffsetBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch atom byte offsets",
    atomByteOffsets,
    GPUBufferUsage.STORAGE,
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
    atomByteOffsetBuffer,
    outputBuffer,
    countParameterBuffer,
    readbackBuffer,
  ];
  let readbackMapped = false;
  try {
    const encoder = device.createCommandEncoder();
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
            wasmBindGroupEntry(
              3,
              atomByteOffsetBuffer,
              atomByteOffsets.regions[index],
            ),
            wasmBindGroupEntry(4, outputBuffer, outputs.regions[index]),
            wasmBindGroupEntry(
              5,
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
        outputBuffer,
        outputs.regions[index].offset,
        readbackBuffer,
        readbacks.regions[index].offset,
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
      return {
        status: "completed",
        bytes: new Uint8Array(
          mapped,
          readbackOffset,
          job.expectedByteCount,
        ).slice(),
        atomCount: job.plan.atoms.length,
        byteCount: job.expectedByteCount,
        outputBufferBytes: job.outputWordCount * 4,
        lengthAtomCount: job.lengthAtomCount,
        resolvedOffsetBytes: job.atomByteOffsets.byteLength,
        resolvedOffsetBitWidth: job.resolvedOffsetBitWidth,
        atomInputBytes: job.columns.kinds.byteLength +
          job.columns.lowWords.byteLength +
          job.columns.highWords.byteLength +
          job.atomByteOffsets.byteLength,
        signed64AtomCount: job.columns.signed64AtomCount,
        signed64HighWordBytes: job.columns.highWords.byteLength,
        dispatchedInvocationCount: job.workgroupCount * wasmWorkgroupSize,
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
  const analysis = analyzeWasmBinaryPlan(plan);
  const resolvedOffsetBitWidth = analysis.byteLength <= 0xffff ? 16 : 32;
  let atomByteOffsets = analysis.atomByteOffsets;
  if (resolvedOffsetBitWidth === 16) {
    atomByteOffsets = new Uint32Array(
      Math.ceil(analysis.atomByteOffsets.length / 2),
    );
    for (
      let offsetIndex = 0;
      offsetIndex < analysis.atomByteOffsets.length;
      offsetIndex += 1
    ) {
      atomByteOffsets[offsetIndex >> 1] |=
        analysis.atomByteOffsets[offsetIndex] <<
        ((offsetIndex & 1) << 4);
    }
  }
  return {
    plan,
    columns: atomColumns(plan.atoms, analysis.atomByteOffsets),
    expectedByteCount: analysis.byteLength,
    outputWordCount: Math.ceil(analysis.byteLength / 4),
    workgroupCount: Math.ceil(plan.atoms.length / wasmWorkgroupSize),
    atomByteOffsets,
    resolvedOffsetBitWidth,
    lengthAtomCount: analysis.lengthLevels.reduce(
      (count, level) => count + level.atoms.length,
      0,
    ),
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
    atomByteOffsets,
    columns,
    expectedByteCount,
    lengthAtomCount,
    outputWordCount,
    resolvedOffsetBitWidth,
    workgroupCount,
  } = job;
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return context;
  const { device, emissionPipeline } = context;
  const kindBytes = Math.max(4, columns.kinds.byteLength);
  const atomWordBytes = Math.max(4, columns.lowWords.byteLength);
  const signed64HighWordBytes = Math.max(4, columns.highWords.byteLength);
  const outputBytes = outputWordCount * 4;
  const capacityRequests = [
    ["atom kinds", kindBytes, "storage"],
    ["atom low words", atomWordBytes, "storage"],
    ["signed64 high words", signed64HighWordBytes, "storage"],
    ["atom byte offsets", atomByteOffsets.byteLength, "storage"],
    ["packed output", outputBytes, "storage"],
    ["count parameters", 16, "uniform"],
    ["readback", outputBytes, "copy"],
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
  const atomByteOffsetBuffer = createBuffer(
    device,
    "Wasm atom byte offsets",
    atomByteOffsets,
    GPUBufferUsage.STORAGE,
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
    new Uint32Array([
      plan.atoms.length,
      columns.signed64AtomCount,
      columns.sparseSigned64HighWords ? 1 : 0,
      resolvedOffsetBitWidth === 16 ? 1 : 0,
    ]),
    GPUBufferUsage.UNIFORM,
  );
  const readback = createCompilerGpuBuffer(
    device,
    "Wasm readback",
    {
      size: outputBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const buffers = [
    kindBuffer,
    lowWordBuffer,
    highWordBuffer,
    atomByteOffsetBuffer,
    outputBuffer,
    countParameterBuffer,
    readback,
  ];
  let readbackMapped = false;
  try {
    const encoder = device.createCommandEncoder();
    const emissionBindGroup = device.createBindGroup({
      layout: emissionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: kindBuffer } },
        { binding: 1, resource: { buffer: lowWordBuffer } },
        { binding: 2, resource: { buffer: highWordBuffer } },
        { binding: 3, resource: { buffer: atomByteOffsetBuffer } },
        { binding: 4, resource: { buffer: outputBuffer } },
        { binding: 5, resource: { buffer: countParameterBuffer } },
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
      outputBuffer,
      0,
      readback,
      0,
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
    const bytes = new Uint8Array(mapped, 0, expectedByteCount).slice();
    return {
      status: "completed",
      bytes,
      atomCount: plan.atoms.length,
      byteCount: expectedByteCount,
      outputBufferBytes: outputWordCount * 4,
      lengthAtomCount,
      resolvedOffsetBytes: atomByteOffsets.byteLength,
      resolvedOffsetBitWidth,
      atomInputBytes: columns.kinds.byteLength +
        columns.lowWords.byteLength +
        columns.highWords.byteLength +
        atomByteOffsets.byteLength,
      signed64AtomCount: columns.signed64AtomCount,
      signed64HighWordBytes: columns.highWords.byteLength,
      dispatchedInvocationCount: workgroupCount * wasmWorkgroupSize,
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
    buffers.forEach((buffer) => buffer.destroy());
  }
}

function atomColumns(
  atoms: readonly WasmAtom[],
  atomByteOffsets: Uint32Array,
): {
  readonly kinds: Uint32Array;
  readonly lowWords: Uint32Array;
  readonly highWords: Uint32Array;
  readonly signed64AtomCount: number;
  readonly sparseSigned64HighWords: boolean;
} {
  const signed64AtomCount = atoms.reduce(
    (count, atom) => count + (atom.kind === "signed64" ? 1 : 0),
    0,
  );
  const sparseSigned64HighWords = signed64AtomCount * 2 < atoms.length;
  const kinds = new Uint32Array(Math.ceil(atoms.length / 8));
  const lowWords = new Uint32Array(atoms.length);
  const highWords = new Uint32Array(
    sparseSigned64HighWords ? signed64AtomCount * 2 : atoms.length,
  );
  let signed64Index = 0;
  for (const [index, atom] of atoms.entries()) {
    if (atom.kind === "byte") {
      writeAtomKind(kinds, index, atomByte);
      lowWords[index] = atom.value;
      continue;
    }
    if (atom.kind === "unsigned") {
      writeAtomKind(kinds, index, atomUnsigned);
      lowWords[index] = atom.value;
      continue;
    }
    if (atom.kind === "signed32") {
      writeAtomKind(kinds, index, atomSigned32);
      lowWords[index] = atom.value >>> 0;
      continue;
    }
    if (atom.kind === "signed64") {
      writeAtomKind(kinds, index, atomSigned64);
      lowWords[index] = Number(BigInt.asUintN(32, atom.value));
      const highWord = Number(BigInt.asUintN(32, atom.value >> 32n));
      if (sparseSigned64HighWords) {
        highWords[signed64Index * 2] = index;
        highWords[signed64Index * 2 + 1] = highWord;
        signed64Index += 1;
      } else {
        highWords[index] = highWord;
      }
      continue;
    }
    writeAtomKind(kinds, index, atomLength);
    lowWords[index] = atomByteOffsets[atom.rangeStart + atom.rangeCount] -
      atomByteOffsets[atom.rangeStart];
  }
  return {
    kinds,
    lowWords,
    highWords,
    signed64AtomCount,
    sparseSigned64HighWords,
  };
}

function writeAtomKind(
  words: Uint32Array,
  atomIndex: number,
  kind: number,
): void {
  const wordIndex = atomIndex >> 3;
  words[wordIndex] |= kind << ((atomIndex & 7) << 2);
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
        storageBufferCount: 5,
        uniformBufferCount: 1,
      });
      const module = device.createShaderModule({ code: emissionShader });
      const compilationMessages = (await module.getCompilationInfo()).messages
        .filter((message) => message.type === "error");
      if (compilationMessages.length > 0) {
        throw new Error(
          `WebGPU Wasm emitter shader failed: ${
            compilationMessages.map((message) => message.message).join("; ")
          }`,
        );
      }
      const emissionPipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "emit_atoms" },
      });
      return {
        status: "available",
        device,
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

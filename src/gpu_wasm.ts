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
  type WasmBinaryPlanAnalysis,
} from "./wasm.ts";

export type GpuWasmEmissionResult =
  | {
    readonly status: "completed";
    readonly bytes: Uint8Array;
    readonly atomCount: number;
    readonly byteCount: number;
    readonly outputBufferBytes: number;
    readonly lengthAtomCount: number;
    readonly sparseLengthSizing: boolean;
    readonly lengthSizingDependencyAtomCount: number;
    readonly lengthSizingWorkEstimate: number;
    readonly resolvedOffsetBytes: number;
    readonly resolvedOffsetBitWidth: 16 | 32;
    readonly atomInputBytes: number;
    readonly lowWordLayout: "dense" | "ranked";
    readonly lowWordBytes: number;
    readonly byteAtomCount: number;
    readonly byteRankBitWidth: 0 | 16 | 32;
    readonly byteRankBytes: number;
    readonly maximumByteRank: number;
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
export type GpuWasmLowWordLayout = "adaptive" | "dense" | "ranked";
let contextPromise: Promise<GpuWasmContextRequest> | undefined;
type WasmGpuRequest = {
  readonly plan: WasmBinaryPlan;
  readonly lowWordLayout: GpuWasmLowWordLayout;
};
const wasmBatchQueue = createCompilerGpuBatchQueue(
  (requests: readonly WasmGpuRequest[]) =>
    requests.length === 1
      ? Promise.all(
        requests.map((request) =>
          emitWasmPlanWithGpu(
            request.plan,
            "latency",
            request.lowWordLayout,
          )
        ),
      )
      : emitPackedWasmPlansOnGpu(requests),
);

const emissionShader = `
struct Parameters {
  count: u32,
  signed64_count: u32,
  representation_flags: u32,
  reserved: u32,
}
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read> primary_low_words: array<u32>;
@group(0) @binding(2) var<storage, read> non_byte_low_words: array<u32>;
@group(0) @binding(3) var<storage, read> byte_ranks: array<u32>;
@group(0) @binding(4) var<storage, read> high_words: array<u32>;
@group(0) @binding(5) var<storage, read> atom_offsets: array<u32>;
@group(0) @binding(6) var<storage, read_write> output_words: array<atomic<u32>>;
@group(0) @binding(7) var<uniform> parameters: Parameters;

fn emit_byte(offset: u32, value: u32) {
  let word_index = offset >> 2u;
  let shift = (offset & 3u) << 3u;
  atomicOr(&output_words[word_index], (value & 255u) << shift);
}

fn atom_offset(index: u32) -> u32 {
  if ((parameters.representation_flags & 2u) == 0u) {
    return atom_offsets[index];
  }
  let word = atom_offsets[index >> 1u];
  return (word >> ((index & 1u) << 4u)) & 0xffffu;
}

fn signed64_high_word(atom_index: u32) -> u32 {
  if ((parameters.representation_flags & 1u) == 0u) {
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

fn atom_low_word(index: u32, kind: u32, kind_word: u32) -> u32 {
  if ((parameters.representation_flags & 4u) == 0u) {
    return primary_low_words[index];
  }
  let rank_index = index >> 3u;
  var byte_rank = byte_ranks[rank_index];
  if ((parameters.representation_flags & 8u) != 0u) {
    let packed_rank = byte_ranks[rank_index >> 1u];
    byte_rank = (packed_rank >> ((rank_index & 1u) << 4u)) & 0xffffu;
  }
  let nonzero_nibbles =
    kind_word |
    (kind_word >> 1u) |
    (kind_word >> 2u) |
    (kind_word >> 3u);
  let byte_nibbles = (~nonzero_nibbles) & 0x11111111u;
  let preceding_bits = (1u << ((index & 7u) << 2u)) - 1u;
  byte_rank += countOneBits(byte_nibbles & preceding_bits);
  if (kind == ${atomByte}u) {
    let packed = primary_low_words[byte_rank >> 2u];
    return (packed >> ((byte_rank & 3u) << 3u)) & 255u;
  }
  return non_byte_low_words[index - byte_rank];
}

@compute @workgroup_size(64)
fn emit_atoms(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  let kind_word = atom_kinds[index >> 3u];
  let kind = (kind_word >> ((index & 7u) << 2u)) & 15u;
  let low_word = atom_low_word(index, kind, kind_word);
  let output_start = atom_offset(index);
  if (kind == ${atomByte}u) {
    emit_byte(output_start, low_word);
    return;
  }
  let size = atom_offset(index + 1u) - output_start;
  if (kind == ${atomUnsigned}u || kind == ${atomLength}u) {
    var remaining = low_word;
    for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
      var encoded_byte = remaining & 127u;
      remaining >>= 7u;
      if (byte_index + 1u < size) { encoded_byte |= 128u; }
      emit_byte(output_start + byte_index, encoded_byte);
    }
    return;
  }
  if (kind == ${atomSigned32}u) {
    var remaining = bitcast<i32>(low_word);
    for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
      var encoded_byte = u32(remaining) & 127u;
      remaining >>= 7;
      if (byte_index + 1u < size) { encoded_byte |= 128u; }
      emit_byte(output_start + byte_index, encoded_byte);
    }
    return;
  }
  if (kind != ${atomSigned64}u) { return; }
  var low = low_word;
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
    readonly lowWordLayout?: GpuWasmLowWordLayout;
  } = {},
): Promise<GpuWasmEmissionResult> {
  try {
    const batch = await wasmBatchQueue.enqueue(
      {
        plan,
        lowWordLayout: options.lowWordLayout ?? "adaptive",
      },
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
  readonly sparseLengthSizing: boolean;
  readonly lengthSizingDependencyAtomCount: number;
  readonly lengthSizingWorkEstimate: number;
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
  requests: readonly WasmGpuRequest[],
): Promise<readonly GpuWasmEmissionResult[]> {
  try {
    return await emitPackedWasmPlanBatch(requests);
  } catch (error) {
    if (error instanceof CompilerGpuCapacityError && requests.length > 1) {
      const split = Math.ceil(requests.length / 2);
      const [left, right] = await Promise.all([
        emitPackedWasmPlansOnGpu(requests.slice(0, split)),
        emitPackedWasmPlansOnGpu(requests.slice(split)),
      ]);
      return [...left, ...right];
    }
    throw error;
  }
}

async function emitPackedWasmPlanBatch(
  requests: readonly WasmGpuRequest[],
): Promise<readonly GpuWasmEmissionResult[]> {
  const jobs = requests.map((request) =>
    prepareWasmGpuJob(request.plan, request.lowWordLayout)
  );
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return requests.map(() => context);
  const { device, emissionPipeline } = context;
  const storageAlignment = device.limits.minStorageBufferOffsetAlignment;
  const uniformAlignment = device.limits.minUniformBufferOffsetAlignment;
  const kinds = packWasmColumns(
    jobs.map((job) => job.columns.kinds),
    4,
    storageAlignment,
  );
  const primaryLowWords = packWasmColumns(
    jobs.map((job) => job.columns.primaryLowWords),
    4,
    storageAlignment,
  );
  const nonByteLowWords = packWasmColumns(
    jobs.map((job) => job.columns.nonByteLowWords),
    4,
    storageAlignment,
  );
  const byteRanks = packWasmColumns(
    jobs.map((job) => job.columns.byteRanks),
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
        representationFlags(job),
        0,
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
    "Wasm batch primary low words",
    primaryLowWords,
    GPUBufferUsage.STORAGE,
  );
  const nonByteLowWordBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch non-byte low words",
    nonByteLowWords,
    GPUBufferUsage.STORAGE,
  );
  const byteRankBuffer = createPackedWasmBuffer(
    device,
    "Wasm batch byte ranks",
    byteRanks,
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
    nonByteLowWordBuffer,
    byteRankBuffer,
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
            wasmBindGroupEntry(
              1,
              lowWordBuffer,
              primaryLowWords.regions[index],
            ),
            wasmBindGroupEntry(
              2,
              nonByteLowWordBuffer,
              nonByteLowWords.regions[index],
            ),
            wasmBindGroupEntry(3, byteRankBuffer, byteRanks.regions[index]),
            wasmBindGroupEntry(4, highWordBuffer, highWords.regions[index]),
            wasmBindGroupEntry(
              5,
              atomByteOffsetBuffer,
              atomByteOffsets.regions[index],
            ),
            wasmBindGroupEntry(6, outputBuffer, outputs.regions[index]),
            wasmBindGroupEntry(
              7,
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
        sparseLengthSizing: job.sparseLengthSizing,
        lengthSizingDependencyAtomCount: job.lengthSizingDependencyAtomCount,
        lengthSizingWorkEstimate: job.lengthSizingWorkEstimate,
        resolvedOffsetBytes: job.atomByteOffsets.byteLength,
        resolvedOffsetBitWidth: job.resolvedOffsetBitWidth,
        atomInputBytes: job.columns.kinds.byteLength +
          job.columns.primaryLowWords.byteLength +
          job.columns.nonByteLowWords.byteLength +
          job.columns.byteRanks.byteLength +
          job.columns.highWords.byteLength +
          job.atomByteOffsets.byteLength,
        lowWordLayout: job.columns.lowWordLayout,
        lowWordBytes: job.columns.primaryLowWords.byteLength +
          job.columns.nonByteLowWords.byteLength +
          job.columns.byteRanks.byteLength,
        byteAtomCount: job.columns.byteAtomCount,
        byteRankBitWidth: job.columns.byteRankBitWidth,
        byteRankBytes: job.columns.byteRanks.byteLength,
        maximumByteRank: job.columns.maximumByteRank,
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

function prepareWasmGpuJob(
  plan: WasmBinaryPlan,
  lowWordLayout: GpuWasmLowWordLayout,
): PreparedWasmGpuJob {
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
      offsetIndex += 2
    ) {
      const upper = analysis.atomByteOffsets[offsetIndex + 1] ?? 0;
      atomByteOffsets[offsetIndex >> 1] =
        analysis.atomByteOffsets[offsetIndex] | (upper << 16);
    }
  }
  return {
    plan,
    columns: atomColumns(
      plan.atoms,
      analysis,
      lowWordLayout,
    ),
    expectedByteCount: analysis.byteLength,
    outputWordCount: Math.ceil(analysis.byteLength / 4),
    workgroupCount: Math.ceil(plan.atoms.length / wasmWorkgroupSize),
    atomByteOffsets,
    resolvedOffsetBitWidth,
    lengthAtomCount: analysis.lengthLevels.reduce(
      (count, level) => count + level.atoms.length,
      0,
    ),
    sparseLengthSizing: analysis.lengthSizing === "sparse",
    lengthSizingDependencyAtomCount: analysis.lengthSizingDependencyAtomCount,
    lengthSizingWorkEstimate: analysis.lengthSizingWorkEstimate,
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
  lowWordLayout: GpuWasmLowWordLayout,
): Promise<GpuWasmEmissionResult> {
  const job = prepareWasmGpuJob(plan, lowWordLayout);
  const {
    atomByteOffsets,
    columns,
    expectedByteCount,
    lengthAtomCount,
    lengthSizingDependencyAtomCount,
    lengthSizingWorkEstimate,
    outputWordCount,
    resolvedOffsetBitWidth,
    sparseLengthSizing,
    workgroupCount,
  } = job;
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return context;
  const { device, emissionPipeline } = context;
  const kindBytes = Math.max(4, columns.kinds.byteLength);
  const primaryLowWordBytes = Math.max(
    4,
    columns.primaryLowWords.byteLength,
  );
  const nonByteLowWordBytes = Math.max(
    4,
    columns.nonByteLowWords.byteLength,
  );
  const byteRankBytes = Math.max(4, columns.byteRanks.byteLength);
  const signed64HighWordBytes = Math.max(4, columns.highWords.byteLength);
  const outputBytes = outputWordCount * 4;
  const capacityRequests = [
    ["atom kinds", kindBytes, "storage"],
    ["atom primary low words", primaryLowWordBytes, "storage"],
    ["atom non-byte low words", nonByteLowWordBytes, "storage"],
    ["atom byte ranks", byteRankBytes, "storage"],
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
    "Wasm atom primary low words",
    columns.primaryLowWords,
    GPUBufferUsage.STORAGE,
  );
  const nonByteLowWordBuffer = createBuffer(
    device,
    "Wasm atom non-byte low words",
    columns.nonByteLowWords,
    GPUBufferUsage.STORAGE,
  );
  const byteRankBuffer = createBuffer(
    device,
    "Wasm atom byte ranks",
    columns.byteRanks,
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
      representationFlags(job),
      0,
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
    nonByteLowWordBuffer,
    byteRankBuffer,
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
        { binding: 2, resource: { buffer: nonByteLowWordBuffer } },
        { binding: 3, resource: { buffer: byteRankBuffer } },
        { binding: 4, resource: { buffer: highWordBuffer } },
        { binding: 5, resource: { buffer: atomByteOffsetBuffer } },
        { binding: 6, resource: { buffer: outputBuffer } },
        { binding: 7, resource: { buffer: countParameterBuffer } },
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
      sparseLengthSizing,
      lengthSizingDependencyAtomCount,
      lengthSizingWorkEstimate,
      resolvedOffsetBytes: atomByteOffsets.byteLength,
      resolvedOffsetBitWidth,
      atomInputBytes: columns.kinds.byteLength +
        columns.primaryLowWords.byteLength +
        columns.nonByteLowWords.byteLength +
        columns.byteRanks.byteLength +
        columns.highWords.byteLength +
        atomByteOffsets.byteLength,
      lowWordLayout: columns.lowWordLayout,
      lowWordBytes: columns.primaryLowWords.byteLength +
        columns.nonByteLowWords.byteLength +
        columns.byteRanks.byteLength,
      byteAtomCount: columns.byteAtomCount,
      byteRankBitWidth: columns.byteRankBitWidth,
      byteRankBytes: columns.byteRanks.byteLength,
      maximumByteRank: columns.maximumByteRank,
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
  analysis: WasmBinaryPlanAnalysis,
  requestedLowWordLayout: GpuWasmLowWordLayout,
): {
  readonly kinds: Uint32Array;
  readonly primaryLowWords: Uint32Array;
  readonly nonByteLowWords: Uint32Array;
  readonly byteRanks: Uint32Array;
  readonly lowWordLayout: "dense" | "ranked";
  readonly byteAtomCount: number;
  readonly byteRankBitWidth: 0 | 16 | 32;
  readonly maximumByteRank: number;
  readonly highWords: Uint32Array;
  readonly signed64AtomCount: number;
  readonly sparseSigned64HighWords: boolean;
} {
  const {
    atomByteOffsets,
    byteAtomCount,
    maximumByteRank,
    signed64AtomCount,
  } = analysis;
  const byteRankBitWidth = maximumByteRank <= 0xffff ? 16 : 32;
  const byteRankCount = Math.ceil(atoms.length / 8);
  const byteRankWords = byteRankBitWidth === 16
    ? Math.ceil(byteRankCount / 2)
    : byteRankCount;
  const rankedLowWordWords = Math.ceil(byteAtomCount / 4) +
    atoms.length - byteAtomCount +
    byteRankWords;
  const lowWordLayout = requestedLowWordLayout === "adaptive"
    ? rankedLowWordWords < atoms.length ? "ranked" : "dense"
    : requestedLowWordLayout;
  const sparseSigned64HighWords = signed64AtomCount * 2 < atoms.length;
  const kinds = new Uint32Array(Math.ceil(atoms.length / 8));
  const primaryLowWords = new Uint32Array(
    lowWordLayout === "ranked" ? Math.ceil(byteAtomCount / 4) : atoms.length,
  );
  const nonByteLowWords = new Uint32Array(
    lowWordLayout === "ranked" ? atoms.length - byteAtomCount : 0,
  );
  const byteRanks = new Uint32Array(
    lowWordLayout === "ranked" ? byteRankWords : 0,
  );
  const highWords = new Uint32Array(
    sparseSigned64HighWords ? signed64AtomCount * 2 : atoms.length,
  );
  let byteIndex = 0;
  let nonByteIndex = 0;
  let signed64Index = 0;
  let kindWord = 0;
  let byteRankWord = 0;
  let packedByteWord = 0;
  for (const [index, atom] of atoms.entries()) {
    if (lowWordLayout === "ranked" && (index & 7) === 0) {
      const rankIndex = index >> 3;
      if (byteRankBitWidth === 16) {
        byteRankWord |= byteIndex << ((rankIndex & 1) << 4);
        if ((rankIndex & 1) === 1 || rankIndex + 1 === byteRankCount) {
          byteRanks[rankIndex >> 1] = byteRankWord;
          byteRankWord = 0;
        }
      } else {
        byteRanks[rankIndex] = byteIndex;
      }
    }
    let lowWord: number;
    let encodedKind: number;
    if (atom.kind === "byte") {
      encodedKind = atomByte;
      lowWord = atom.value;
    } else if (atom.kind === "unsigned") {
      encodedKind = atomUnsigned;
      lowWord = atom.value;
    } else if (atom.kind === "signed32") {
      encodedKind = atomSigned32;
      lowWord = atom.value >>> 0;
    } else if (atom.kind === "signed64") {
      encodedKind = atomSigned64;
      lowWord = Number(BigInt.asUintN(32, atom.value));
      const highWord = Number(BigInt.asUintN(32, atom.value >> 32n));
      if (sparseSigned64HighWords) {
        highWords[signed64Index * 2] = index;
        highWords[signed64Index * 2 + 1] = highWord;
        signed64Index += 1;
      } else {
        highWords[index] = highWord;
      }
    } else {
      encodedKind = atomLength;
      lowWord = atomByteOffsets[atom.rangeStart + atom.rangeCount] -
        atomByteOffsets[atom.rangeStart];
    }
    kindWord |= encodedKind << ((index & 7) << 2);
    if ((index & 7) === 7 || index + 1 === atoms.length) {
      kinds[index >> 3] = kindWord;
      kindWord = 0;
    }
    if (lowWordLayout === "dense") {
      primaryLowWords[index] = lowWord;
    } else if (atom.kind === "byte") {
      packedByteWord |= lowWord << ((byteIndex & 3) << 3);
      if ((byteIndex & 3) === 3 || byteIndex + 1 === byteAtomCount) {
        primaryLowWords[byteIndex >> 2] = packedByteWord;
        packedByteWord = 0;
      }
      byteIndex += 1;
    } else {
      nonByteLowWords[nonByteIndex] = lowWord;
      nonByteIndex += 1;
    }
  }
  return {
    kinds,
    primaryLowWords,
    nonByteLowWords,
    byteRanks,
    lowWordLayout,
    byteAtomCount,
    byteRankBitWidth: lowWordLayout === "ranked" ? byteRankBitWidth : 0,
    maximumByteRank: lowWordLayout === "ranked" ? maximumByteRank : 0,
    highWords,
    signed64AtomCount,
    sparseSigned64HighWords,
  };
}

function representationFlags(job: PreparedWasmGpuJob): number {
  return (job.columns.sparseSigned64HighWords ? 1 : 0) |
    (job.resolvedOffsetBitWidth === 16 ? 2 : 0) |
    (job.columns.lowWordLayout === "ranked" ? 4 : 0) |
    (job.columns.byteRankBitWidth === 16 ? 8 : 0);
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
        storageBufferCount: 7,
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

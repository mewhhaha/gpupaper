import {
  acquireCompilerGpuBuffer,
  type CompilerGpuBufferLease,
  compilerGpuCapacityViolation,
  type CompilerGpuLimits,
  type CompilerGpuSchedulingPolicy,
  compilerGpuUnavailabilityReason,
  createCompilerGpuBatchQueue,
  dispatchCompilerGpuWorkgroups,
  requestCompilerGpuDevice,
  requireCompilerGpuCapacity,
  submitCompilerGpuCommandWithReadback,
} from "./gpu_device.ts";
export type {
  CompilerGpuLimits,
  CompilerGpuSchedulingPolicy,
} from "./gpu_device.ts";
import {
  encodeGpuExclusiveScan,
  type GpuExclusiveScanEncoding,
  type GpuExclusiveScanPipelines,
  requestGpuExclusiveScanPipelines,
} from "./gpu_segmented_work.ts";
import {
  inspectWasmBinaryPlanStructure,
  type WasmAtom,
  type WasmBinaryPlan,
  type WasmBinaryPlanStructure,
} from "./wasm.ts";

export type GpuWasmEmissionResult =
  | {
    readonly status: "completed";
    readonly bytes: Uint8Array;
    readonly atomCount: number;
    readonly byteCount: number;
    readonly outputBufferBytes: number;
    readonly readbackMode: "capacity-single-map";
    readonly physicalReadbackBytes: number;
    readonly logicalReadbackBytes: number;
    readonly readbackPaddingBytes: number;
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
    readonly leasedBufferBytes: number;
    readonly resources: GpuWasmPlanResources;
    readonly adapterLimits: CompilerGpuLimits;
    readonly dispatchedInvocationCount: number;
    readonly payloadByteOffsets: readonly number[];
    readonly submissionBatchSize: number;
    readonly payloadBatchSize: number;
    readonly queueWaitMilliseconds: number;
    readonly timings: GpuWasmEmissionTimings;
  }
  | { readonly status: "unavailable"; readonly reason: string };

export type GpuWasmBatchEmissionResult =
  | {
    readonly status: "completed";
    readonly bytes: readonly Uint8Array[];
    readonly physicalEmissions: readonly Extract<
      GpuWasmEmissionResult,
      { readonly status: "completed" }
    >[];
    readonly physicalPlans: readonly GpuWasmPhysicalPlan[];
    readonly adapterLimits: CompilerGpuLimits;
    readonly timings: GpuWasmBatchEmissionTimings;
  }
  | { readonly status: "unavailable"; readonly reason: string };

export type GpuWasmBatchEmissionTimings = {
  readonly totalMilliseconds: number;
  readonly deviceRequestMilliseconds: number;
  readonly partitioningMilliseconds: number;
  readonly gpuEmissionWallMilliseconds: number;
  readonly artifactIsolationMilliseconds: number;
  readonly unaccountedMilliseconds: number;
};

export type GpuResidentWasmPlanCertificate = {
  readonly payloadCount: number;
  readonly atomCount: number;
  readonly maximumOutputBytes: number;
  readonly lengthAtomCount: number;
  readonly lengthSizingDependencyAtomCount: number;
  readonly physicalPlanCount: number;
  readonly retainedInputBytes: number;
};

export type GpuResidentWasmPlanPreparationTimings = {
  readonly totalMilliseconds: number;
  readonly deviceRequestMilliseconds: number;
  readonly partitioningMilliseconds: number;
  readonly planInspectionMilliseconds: number;
  readonly columnConstructionMilliseconds: number;
  readonly allocationAndUploadMilliseconds: number;
  readonly unaccountedMilliseconds: number;
};

export type GpuResidentWasmPlans = {
  readonly certificate: GpuResidentWasmPlanCertificate;
  readonly physicalPlans: readonly GpuWasmPhysicalPlan[];
  readonly adapterLimits: CompilerGpuLimits;
  readonly preparationTimings: GpuResidentWasmPlanPreparationTimings;
  readonly released: boolean;
  release(): void;
};

export type GpuResidentWasmPlanCreationResult =
  | { readonly status: "completed"; readonly resident: GpuResidentWasmPlans }
  | { readonly status: "unavailable"; readonly reason: string };

export type GpuWasmPlanResources = {
  readonly payloadCount: number;
  readonly atomCount: number;
  readonly maximumOutputBytes: number;
  readonly lengthAtomCount: number;
  readonly lengthSizingDependencyAtomCount: number;
  readonly maximumStorageBindingBytes: number;
  readonly readbackBytes: number;
  readonly workgroupCount: number;
};

export type GpuWasmPhysicalPlan = {
  readonly firstPayloadIndex: number;
  readonly payloadCount: number;
  readonly resources: GpuWasmPlanResources;
};

export type PackedWasmBinaryPlans = {
  readonly plan: WasmBinaryPlan;
  readonly endAtomIndices: readonly number[];
};

export type PartitionedWasmBinaryPlans =
  & PackedWasmBinaryPlans
  & GpuWasmPhysicalPlan;

type WasmPlanPartition = GpuWasmPhysicalPlan & {
  readonly plans: readonly WasmBinaryPlan[];
  readonly structures: readonly WasmBinaryPlanStructure[];
};

type WasmPlanResourceContribution = {
  readonly atomCount: number;
  readonly maximumOutputBytes: number;
  readonly lengthAtomCount: number;
  readonly lengthSizingDependencyAtomCount: number;
};

export type GpuWasmEmissionTimings = {
  readonly totalMilliseconds: number;
  readonly planInspectionMilliseconds: number;
  readonly columnConstructionMilliseconds: number;
  readonly planAnalysisAndColumnMilliseconds: number;
  readonly contextMilliseconds: number;
  readonly allocationAndUploadMilliseconds: number;
  readonly commandEncodingMilliseconds: number;
  readonly submissionMilliseconds: number;
  readonly queueWaitMilliseconds: number;
  readonly deviceCompletionMilliseconds: number;
  readonly mappingCompletionMilliseconds: number;
  readonly readbackCopyMilliseconds: number;
  readonly scope: "payload" | "batch";
  readonly completionWitness: "mapping";
};

type GpuWasmContextRequest =
  | {
    readonly status: "available";
    readonly device: GPUDevice;
    readonly emissionPipeline: GPUComputePipeline;
    readonly initialSizingPipeline: GPUComputePipeline;
    readonly lengthSizingPipeline: GPUComputePipeline;
    readonly scanPipelines: GpuExclusiveScanPipelines;
  }
  | { readonly status: "unavailable"; readonly reason: string };

const atomByte = 0;
const atomUnsigned = 1;
const atomSigned32 = 2;
const atomSigned64 = 3;
const atomLength = 4;
const denseKindRepresentationFlag = 16;
const wasmWorkgroupSize = 64;
export type GpuWasmLowWordLayout = "adaptive" | "dense" | "ranked";
let contextPromise: Promise<GpuWasmContextRequest> | undefined;
type WasmGpuRequest = {
  readonly plan: WasmBinaryPlan;
  readonly lowWordLayout: GpuWasmLowWordLayout;
};
const wasmBatchQueue = createCompilerGpuBatchQueue(
  (requests: readonly WasmGpuRequest[]) =>
    Promise.all(
      requests.map((request) =>
        emitWasmPlanWithGpu(
          request.plan,
          requests.length === 1 ? "latency" : "throughput",
          request.lowWordLayout,
        )
      ),
    ),
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
@group(0) @binding(7) var<storage, read> length_values: array<u32>;
@group(0) @binding(8) var<uniform> parameters: Parameters;

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
  var kind_word = atom_kinds[index >> 3u];
  var kind = (kind_word >> ((index & 7u) << 2u)) & 15u;
  if ((parameters.representation_flags & ${denseKindRepresentationFlag}u) != 0u) {
    kind = atom_kinds[index];
    kind_word = kind;
  }
  var low_word = 0u;
  if (kind == ${atomLength}u) {
    low_word = length_values[index];
  } else {
    low_word = atom_low_word(index, kind, kind_word);
  }
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

const sizingShader = `
struct Parameters {
  count: u32,
  signed64_count: u32,
  representation_flags: u32,
  reserved: u32,
}

struct LengthParameters {
  first_length_rank: u32,
  length_count: u32,
  reserved_0: u32,
  reserved_1: u32,
}

@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read> primary_low_words: array<u32>;
@group(0) @binding(2) var<storage, read> non_byte_low_words: array<u32>;
@group(0) @binding(3) var<storage, read> byte_ranks: array<u32>;
@group(0) @binding(4) var<storage, read> high_words: array<u32>;
@group(0) @binding(5) var<storage, read_write> atom_sizes: array<u32>;
@group(0) @binding(6) var<uniform> parameters: Parameters;

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
  if (lower >= parameters.signed64_count || high_words[lower * 2u] != atom_index) {
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
  let nonzero_nibbles = kind_word | (kind_word >> 1u) | (kind_word >> 2u) | (kind_word >> 3u);
  let byte_nibbles = (~nonzero_nibbles) & 0x11111111u;
  let preceding_bits = (1u << ((index & 7u) << 2u)) - 1u;
  byte_rank += countOneBits(byte_nibbles & preceding_bits);
  if (kind == ${atomByte}u) {
    let packed = primary_low_words[byte_rank >> 2u];
    return (packed >> ((byte_rank & 3u) << 3u)) & 255u;
  }
  return non_byte_low_words[index - byte_rank];
}

fn unsigned_size(value: u32) -> u32 {
  var remaining = value;
  var size = 1u;
  while (remaining >= 128u) {
    remaining >>= 7u;
    size += 1u;
  }
  return size;
}

fn signed32_size(value: u32) -> u32 {
  var remaining = bitcast<i32>(value);
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

fn signed64_size(low_word: u32, high_word: u32) -> u32 {
  var low = low_word;
  var high = high_word;
  var size = 0u;
  loop {
    let encoded_byte = low & 127u;
    let next_low = (low >> 7u) | (high << 25u);
    let next_high = bitcast<u32>(bitcast<i32>(high) >> 7);
    size += 1u;
    let sign_set = (encoded_byte & 64u) != 0u;
    if (
      (next_low == 0u && next_high == 0u && !sign_set) ||
      (next_low == 0xffffffffu && next_high == 0xffffffffu && sign_set)
    ) {
      return size;
    }
    low = next_low;
    high = next_high;
  }
  return size;
}

@compute @workgroup_size(${wasmWorkgroupSize})
fn size_scalar_atoms(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  var kind_word = atom_kinds[index >> 3u];
  var kind = (kind_word >> ((index & 7u) << 2u)) & 15u;
  if ((parameters.representation_flags & ${denseKindRepresentationFlag}u) != 0u) {
    kind = atom_kinds[index];
    kind_word = kind;
  }
  var low_word = 0u;
  if (kind != ${atomLength}u) {
    low_word = atom_low_word(index, kind, kind_word);
  }
  if (kind == ${atomByte}u) {
    atom_sizes[index] = 1u;
  } else if (kind == ${atomUnsigned}u) {
    atom_sizes[index] = unsigned_size(low_word);
  } else if (kind == ${atomSigned32}u) {
    atom_sizes[index] = signed32_size(low_word);
  } else if (kind == ${atomSigned64}u) {
    atom_sizes[index] = signed64_size(low_word, signed64_high_word(index));
  } else {
    atom_sizes[index] = 0u;
  }
}

@group(1) @binding(0) var<storage, read> local_length_atom_indices: array<u32>;
@group(1) @binding(1) var<storage, read> length_payload_indices: array<u32>;
@group(1) @binding(2) var<storage, read> local_length_range_starts: array<u32>;
@group(1) @binding(3) var<storage, read> length_range_counts: array<u32>;
@group(1) @binding(4) var<storage, read> payload_atom_bases: array<u32>;
@group(1) @binding(5) var<storage, read_write> resolved_atom_sizes: array<u32>;
@group(1) @binding(6) var<storage, read_write> resolved_length_values: array<u32>;
@group(1) @binding(7) var<uniform> length_parameters: LengthParameters;

@compute @workgroup_size(${wasmWorkgroupSize})
fn size_length_atoms(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= length_parameters.length_count) { return; }
  let rank = length_parameters.first_length_rank + invocation.x;
  let atom_base = payload_atom_bases[length_payload_indices[rank]];
  let atom_index = atom_base + local_length_atom_indices[rank];
  let range_start = atom_base + local_length_range_starts[rank];
  let range_end = range_start + length_range_counts[rank];
  var payload_size = 0u;
  for (var dependency = range_start; dependency < range_end; dependency += 1u) {
    payload_size += resolved_atom_sizes[dependency];
  }
  resolved_length_values[atom_index] = payload_size;
  resolved_atom_sizes[atom_index] = unsigned_size(payload_size);
}
`;

export function packWasmBinaryPlans(
  plans: readonly WasmBinaryPlan[],
): PackedWasmBinaryPlans {
  if (plans.length === 0) {
    throw new TypeError("a packed Wasm batch requires at least one plan");
  }
  for (const plan of plans) inspectWasmBinaryPlanStructure(plan);
  return packValidatedWasmBinaryPlans(plans);
}

function packValidatedWasmBinaryPlans(
  plans: readonly WasmBinaryPlan[],
): PackedWasmBinaryPlans {
  const atoms: WasmAtom[] = [];
  const endAtomIndices: number[] = [];
  let maximumDependencyLevel = 0;
  for (const plan of plans) {
    const atomBase = atoms.length;
    for (const atom of plan.atoms) {
      atoms.push(
        atom.kind === "length"
          ? { ...atom, rangeStart: atomBase + atom.rangeStart }
          : atom,
      );
    }
    endAtomIndices.push(atoms.length);
    maximumDependencyLevel = Math.max(
      maximumDependencyLevel,
      plan.maximumDependencyLevel,
    );
  }
  return {
    plan: { atoms, maximumDependencyLevel },
    endAtomIndices,
  };
}

export function partitionWasmBinaryPlans(
  plans: readonly WasmBinaryPlan[],
  limits: CompilerGpuLimits,
  options: { readonly maximumPayloadCount?: number } = {},
): readonly PartitionedWasmBinaryPlans[] {
  return partitionWasmPlanReferences(plans, limits, options).map((
    partition,
  ) => {
    const packed = partition.plans.length === 1
      ? {
        plan: partition.plans[0]!,
        endAtomIndices: [partition.plans[0]!.atoms.length],
      }
      : packValidatedWasmBinaryPlans(partition.plans);
    return {
      ...packed,
      firstPayloadIndex: partition.firstPayloadIndex,
      payloadCount: partition.payloadCount,
      resources: partition.resources,
    };
  });
}

function partitionWasmPlanReferences(
  plans: readonly WasmBinaryPlan[],
  limits: CompilerGpuLimits,
  options: { readonly maximumPayloadCount?: number } = {},
): readonly WasmPlanPartition[] {
  if (plans.length === 0) return [];
  const maximumPayloadCount = requireMaximumWasmPayloadCount(
    options.maximumPayloadCount ?? plans.length,
  );
  const structures = plans.map(inspectWasmBinaryPlanStructure);
  const contributions = plans.map((plan, index) =>
    wasmPlanResourceContribution(plan, structures[index]!)
  );
  const partitions: WasmPlanPartition[] = [];
  let firstPayloadIndex = 0;
  while (firstPayloadIndex < plans.length) {
    let aggregate = emptyWasmPlanResourceContribution();
    let endPayloadIndex = firstPayloadIndex;
    while (
      endPayloadIndex < plans.length &&
      endPayloadIndex - firstPayloadIndex < maximumPayloadCount
    ) {
      const candidate = addWasmPlanResourceContribution(
        aggregate,
        contributions[endPayloadIndex]!,
      );
      const resources = gpuWasmPlanResources(
        candidate,
        endPayloadIndex - firstPayloadIndex + 1,
      );
      if (
        endPayloadIndex > firstPayloadIndex &&
        gpuWasmPlanCapacityViolation(resources, limits) !== undefined
      ) {
        break;
      }
      aggregate = candidate;
      endPayloadIndex += 1;
    }
    const partitionPlans = plans.slice(firstPayloadIndex, endPayloadIndex);
    const partitionStructures = structures.slice(
      firstPayloadIndex,
      endPayloadIndex,
    );
    const resources = gpuWasmPlanResources(
      aggregate,
      partitionPlans.length,
    );
    partitions.push({
      plans: partitionPlans,
      structures: partitionStructures,
      firstPayloadIndex,
      payloadCount: partitionPlans.length,
      resources,
    });
    firstPayloadIndex = endPayloadIndex;
  }
  return partitions;
}

function requireMaximumWasmPayloadCount(value: number): number {
  if (Number.isSafeInteger(value) && value >= 1) return value;
  throw new RangeError(
    `maximum Wasm payload count must be a positive safe integer; received ${value}`,
  );
}

function wasmPlanResourceContribution(
  plan: WasmBinaryPlan,
  structure: WasmBinaryPlanStructure,
): WasmPlanResourceContribution {
  return {
    atomCount: plan.atoms.length,
    maximumOutputBytes: structure.maximumEncodedByteLength,
    lengthAtomCount: structure.lengthAtomIndices.length,
    lengthSizingDependencyAtomCount: structure.dependencyAtomCount,
  };
}

function emptyWasmPlanResourceContribution(): WasmPlanResourceContribution {
  return {
    atomCount: 0,
    maximumOutputBytes: 0,
    lengthAtomCount: 0,
    lengthSizingDependencyAtomCount: 0,
  };
}

function addWasmPlanResourceContribution(
  left: WasmPlanResourceContribution,
  right: WasmPlanResourceContribution,
): WasmPlanResourceContribution {
  return {
    atomCount: safeResourceSum("atom count", left.atomCount, right.atomCount),
    maximumOutputBytes: safeResourceSum(
      "maximum output bytes",
      left.maximumOutputBytes,
      right.maximumOutputBytes,
    ),
    lengthAtomCount: safeResourceSum(
      "length atom count",
      left.lengthAtomCount,
      right.lengthAtomCount,
    ),
    lengthSizingDependencyAtomCount: safeResourceSum(
      "length dependency count",
      left.lengthSizingDependencyAtomCount,
      right.lengthSizingDependencyAtomCount,
    ),
  };
}

function safeResourceSum(
  subject: string,
  left: number,
  right: number,
): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(
      `packed Wasm ${subject} exceeds the safe-integer range: ${left} + ${right}`,
    );
  }
  return sum;
}

function gpuWasmPlanResources(
  contribution: WasmPlanResourceContribution,
  payloadCount: number,
): GpuWasmPlanResources {
  const atomBytes = contribution.atomCount * Uint32Array.BYTES_PER_ELEMENT;
  const offsetBytes = (contribution.atomCount + 1) *
    Uint32Array.BYTES_PER_ELEMENT;
  const kindBytes = Math.max(
    Uint32Array.BYTES_PER_ELEMENT,
    Math.ceil(contribution.atomCount / 8) * Uint32Array.BYTES_PER_ELEMENT,
  );
  const lengthColumnBytes = Math.max(
    Uint32Array.BYTES_PER_ELEMENT,
    contribution.lengthAtomCount * Uint32Array.BYTES_PER_ELEMENT,
  );
  const maximumOutputBytes = Math.ceil(
    contribution.maximumOutputBytes / Uint32Array.BYTES_PER_ELEMENT,
  ) * Uint32Array.BYTES_PER_ELEMENT;
  const maximumStorageBindingBytes = Math.max(
    kindBytes,
    atomBytes,
    offsetBytes,
    lengthColumnBytes,
    maximumOutputBytes,
  );
  const readbackBytes = safeResourceSum(
    "readback bytes",
    maximumOutputBytes,
    payloadCount * Uint32Array.BYTES_PER_ELEMENT,
  );
  return {
    payloadCount,
    atomCount: contribution.atomCount,
    maximumOutputBytes,
    lengthAtomCount: contribution.lengthAtomCount,
    lengthSizingDependencyAtomCount:
      contribution.lengthSizingDependencyAtomCount,
    maximumStorageBindingBytes,
    readbackBytes,
    workgroupCount: Math.ceil(contribution.atomCount / wasmWorkgroupSize),
  };
}

function gpuWasmPlanCapacityViolation(
  resources: GpuWasmPlanResources,
  limits: CompilerGpuLimits,
): string | undefined {
  if (resources.atomCount > 0xffff_ffff) {
    return `Wasm atom count ${resources.atomCount} exceeds the u32 index domain`;
  }
  if (resources.maximumOutputBytes > 0xffff_ffff) {
    return `Wasm maximum output ${resources.maximumOutputBytes} exceeds the u32 offset domain`;
  }
  return compilerGpuCapacityViolation(limits, {
    kind: "buffer",
    label: "Wasm maximum storage binding",
    byteLength: resources.maximumStorageBindingBytes,
    binding: "storage",
  }) ?? compilerGpuCapacityViolation(limits, {
    kind: "buffer",
    label: "Wasm readback",
    byteLength: resources.readbackBytes,
    binding: "copy",
  }) ?? compilerGpuCapacityViolation(limits, {
    kind: "dispatch",
    label: "Wasm emission",
    workgroupCount: resources.workgroupCount,
  });
}

export async function emitWasmPlansOnGpu(
  plans: readonly WasmBinaryPlan[],
  options: {
    readonly scheduling?: CompilerGpuSchedulingPolicy;
    readonly lowWordLayout?: GpuWasmLowWordLayout;
    readonly maximumPhysicalPayloadCount?: number;
  } = {},
): Promise<GpuWasmBatchEmissionResult> {
  if (plans.length === 0) {
    throw new TypeError("GPU Wasm batch emission requires at least one plan");
  }
  if (options.maximumPhysicalPayloadCount !== undefined) {
    requireMaximumWasmPayloadCount(options.maximumPhysicalPayloadCount);
  }
  const totalStart = performance.now();
  if (plans.length === 1) {
    const gpuEmissionStart = performance.now();
    const emission = await emitWasmPlanOnGpu(plans[0]!, {
      scheduling: options.scheduling ?? "latency",
      lowWordLayout: options.lowWordLayout,
    });
    const gpuEmissionWallMilliseconds = performance.now() - gpuEmissionStart;
    if (emission.status === "unavailable") return emission;
    const totalMilliseconds = performance.now() - totalStart;
    const physicalEmission = {
      ...emission,
      payloadBatchSize: 1,
      timings: { ...emission.timings, scope: "batch" as const },
    };
    return {
      status: "completed",
      bytes: [emission.bytes],
      physicalEmissions: [physicalEmission],
      physicalPlans: [{
        firstPayloadIndex: 0,
        payloadCount: 1,
        resources: emission.resources,
      }],
      adapterLimits: emission.adapterLimits,
      timings: {
        totalMilliseconds,
        deviceRequestMilliseconds: 0,
        partitioningMilliseconds: 0,
        gpuEmissionWallMilliseconds,
        artifactIsolationMilliseconds: 0,
        unaccountedMilliseconds: Math.max(
          0,
          totalMilliseconds - gpuEmissionWallMilliseconds,
        ),
      },
    };
  }
  const deviceRequestStart = performance.now();
  const deviceRequest = await requestCompilerGpuDevice();
  const deviceRequestMilliseconds = performance.now() - deviceRequestStart;
  if (deviceRequest.status === "unavailable") return deviceRequest;
  const adapterLimits = compilerGpuLimits(deviceRequest.device.limits);
  const partitioningStart = performance.now();
  const physicalPlans = partitionWasmPlanReferences(plans, adapterLimits, {
    maximumPayloadCount: options.maximumPhysicalPayloadCount,
  });
  const partitioningMilliseconds = performance.now() - partitioningStart;
  const gpuEmissionStart = performance.now();
  const emissions = await Promise.all(physicalPlans.map(async (packed) => {
    const emission = await emitPreparedWasmJobWithGpu(
      prepareWasmGpuBatch(packed.plans, packed.structures),
      options.scheduling ?? "throughput",
    );
    if (emission.status === "unavailable") return emission;
    return {
      ...emission,
      payloadBatchSize: packed.payloadCount,
      timings: { ...emission.timings, scope: "batch" as const },
    };
  }));
  const gpuEmissionWallMilliseconds = performance.now() - gpuEmissionStart;
  const unavailable = emissions.find((emission) =>
    emission.status === "unavailable"
  );
  if (unavailable?.status === "unavailable") return unavailable;
  const physicalEmissions = emissions as Extract<
    GpuWasmEmissionResult,
    { readonly status: "completed" }
  >[];
  const artifactIsolationStart = performance.now();
  const bytes = physicalEmissions.flatMap((emission, physicalIndex) => {
    const physicalPlan = physicalPlans[physicalIndex]!;
    if (physicalPlan.payloadCount === 1) return [emission.bytes];
    return emission.payloadByteOffsets.slice(1).map((end, index) =>
      emission.bytes.slice(emission.payloadByteOffsets[index], end)
    );
  });
  const artifactIsolationMilliseconds = performance.now() -
    artifactIsolationStart;
  if (bytes.length !== plans.length) {
    throw new Error(
      `GPU Wasm batch emitted ${bytes.length} artifacts for ${plans.length} plans`,
    );
  }
  const totalMilliseconds = performance.now() - totalStart;
  const accountedMilliseconds = deviceRequestMilliseconds +
    partitioningMilliseconds + gpuEmissionWallMilliseconds +
    artifactIsolationMilliseconds;
  return {
    status: "completed",
    bytes,
    physicalEmissions,
    physicalPlans: physicalPlans.map((physical) => ({
      firstPayloadIndex: physical.firstPayloadIndex,
      payloadCount: physical.payloadCount,
      resources: physical.resources,
    })),
    adapterLimits,
    timings: {
      totalMilliseconds,
      deviceRequestMilliseconds,
      partitioningMilliseconds,
      gpuEmissionWallMilliseconds,
      artifactIsolationMilliseconds,
      unaccountedMilliseconds: Math.max(
        0,
        totalMilliseconds - accountedMilliseconds,
      ),
    },
  };
}

export async function createGpuResidentWasmPlans(
  plans: readonly WasmBinaryPlan[],
  options: { readonly maximumPhysicalPayloadCount?: number } = {},
): Promise<GpuResidentWasmPlanCreationResult> {
  if (plans.length === 0) {
    throw new TypeError(
      "resident GPU Wasm preparation requires at least one plan",
    );
  }
  if (options.maximumPhysicalPayloadCount !== undefined) {
    requireMaximumWasmPayloadCount(options.maximumPhysicalPayloadCount);
  }
  const totalStart = performance.now();
  const deviceRequestStart = performance.now();
  const context = await requestGpuWasmContext();
  const deviceRequestMilliseconds = performance.now() - deviceRequestStart;
  if (context.status === "unavailable") return context;
  const adapterLimits = compilerGpuLimits(context.device.limits);
  const partitioningStart = performance.now();
  const partitions = partitionWasmPlanReferences(plans, adapterLimits, {
    maximumPayloadCount: options.maximumPhysicalPayloadCount,
  });
  const partitioningMilliseconds = performance.now() - partitioningStart;
  const capacityViolation = partitions.map((partition) =>
    gpuWasmPlanCapacityViolation(partition.resources, adapterLimits)
  ).find((reason) => reason !== undefined);
  if (capacityViolation !== undefined) {
    return { status: "unavailable", reason: capacityViolation };
  }
  let planInspectionMilliseconds = 0;
  let columnConstructionMilliseconds = 0;
  let allocationAndUploadMilliseconds = 0;
  const physical: ResidentWasmPhysicalPlan[] = [];
  try {
    for (const partition of partitions) {
      const prepared = prepareWasmGpuBatch(
        partition.plans,
        partition.structures,
      );
      planInspectionMilliseconds += prepared.planInspectionMilliseconds;
      columnConstructionMilliseconds += prepared.columnConstructionMilliseconds;
      const uploadStart = performance.now();
      const inputs = uploadWasmGpuResidentInputs(context.device, prepared);
      allocationAndUploadMilliseconds += performance.now() - uploadStart;
      physical.push({
        job: discardWasmGpuHostInputColumns({
          ...prepared,
          planInspectionMilliseconds: 0,
          columnConstructionMilliseconds: 0,
        }),
        inputs,
        physicalPlan: {
          firstPayloadIndex: partition.firstPayloadIndex,
          payloadCount: partition.payloadCount,
          resources: partition.resources,
        },
      });
    }
  } catch (error) {
    for (const prepared of physical) {
      prepared.inputs.leases.forEach((lease) => lease.release());
    }
    const reason = compilerGpuUnavailabilityReason(
      "resident Wasm plan preparation",
      error,
    );
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  }
  const certificate: GpuResidentWasmPlanCertificate = {
    payloadCount: plans.length,
    atomCount: physical.reduce(
      (sum, prepared) =>
        safeResourceSum("resident atom count", sum, prepared.job.atomCount),
      0,
    ),
    maximumOutputBytes: physical.reduce((sum, prepared) =>
      safeResourceSum(
        "resident maximum output bytes",
        sum,
        prepared.job.maximumEncodedByteLength,
      ), 0),
    lengthAtomCount: physical.reduce((sum, prepared) =>
      safeResourceSum(
        "resident length atom count",
        sum,
        prepared.job.lengthAtomCount,
      ), 0),
    lengthSizingDependencyAtomCount: physical.reduce(
      (sum, prepared) =>
        safeResourceSum(
          "resident length dependency count",
          sum,
          prepared.job.lengthSizingDependencyAtomCount,
        ),
      0,
    ),
    physicalPlanCount: physical.length,
    retainedInputBytes: physical.reduce(
      (sum, prepared) =>
        prepared.inputs.leases.reduce(
          (physicalSum, lease) =>
            safeResourceSum(
              "resident retained input bytes",
              physicalSum,
              lease.byteLength,
            ),
          sum,
        ),
      0,
    ),
  };
  const totalMilliseconds = performance.now() - totalStart;
  const accountedMilliseconds = deviceRequestMilliseconds +
    partitioningMilliseconds + planInspectionMilliseconds +
    columnConstructionMilliseconds + allocationAndUploadMilliseconds;
  const preparationTimings: GpuResidentWasmPlanPreparationTimings = {
    totalMilliseconds,
    deviceRequestMilliseconds,
    partitioningMilliseconds,
    planInspectionMilliseconds,
    columnConstructionMilliseconds,
    allocationAndUploadMilliseconds,
    unaccountedMilliseconds: Math.max(
      0,
      totalMilliseconds - accountedMilliseconds,
    ),
  };
  const state: ResidentWasmPlanState = {
    physical,
    released: false,
    leasesReleased: false,
    activeBorrows: 0,
  };
  const resident: GpuResidentWasmPlans = Object.freeze({
    certificate,
    physicalPlans: physical.map((prepared) => prepared.physicalPlan),
    adapterLimits,
    preparationTimings,
    get released(): boolean {
      return state.released;
    },
    release(): void {
      if (state.released) {
        throw new Error("resident GPU Wasm plans have already been released");
      }
      state.released = true;
      if (state.activeBorrows === 0) releaseResidentWasmInputs(state);
    },
  });
  residentWasmPlanStates.set(resident, state);
  return { status: "completed", resident };
}

export async function emitResidentWasmPlansOnGpu(
  resident: GpuResidentWasmPlans,
  options: { readonly scheduling?: CompilerGpuSchedulingPolicy } = {},
): Promise<GpuWasmBatchEmissionResult> {
  const state = residentWasmPlanStates.get(resident);
  if (state === undefined) {
    throw new TypeError(
      "resident GPU Wasm plan handle was not created by this compiler",
    );
  }
  if (state.released) {
    throw new Error("resident GPU Wasm plans cannot be emitted after release");
  }
  state.activeBorrows += 1;
  const totalStart = performance.now();
  try {
    const gpuEmissionStart = performance.now();
    const emissions = await Promise.all(state.physical.map(async (prepared) => {
      const emission = await emitPreparedWasmJobWithGpu(
        prepared.job,
        options.scheduling ?? "throughput",
        prepared.inputs,
      );
      if (emission.status === "unavailable") return emission;
      return {
        ...emission,
        payloadBatchSize: prepared.physicalPlan.payloadCount,
        timings: { ...emission.timings, scope: "batch" as const },
      };
    }));
    const gpuEmissionWallMilliseconds = performance.now() - gpuEmissionStart;
    const unavailable = emissions.find((emission) =>
      emission.status === "unavailable"
    );
    if (unavailable?.status === "unavailable") return unavailable;
    const physicalEmissions = emissions as Extract<
      GpuWasmEmissionResult,
      { readonly status: "completed" }
    >[];
    const artifactIsolationStart = performance.now();
    const bytes = physicalEmissions.flatMap((emission, physicalIndex) => {
      const physicalPlan = resident.physicalPlans[physicalIndex]!;
      if (physicalPlan.payloadCount === 1) return [emission.bytes];
      return emission.payloadByteOffsets.slice(1).map((end, index) =>
        emission.bytes.slice(emission.payloadByteOffsets[index], end)
      );
    });
    const artifactIsolationMilliseconds = performance.now() -
      artifactIsolationStart;
    if (bytes.length !== resident.certificate.payloadCount) {
      throw new Error(
        `resident GPU Wasm batch emitted ${bytes.length} artifacts for ${resident.certificate.payloadCount} plans`,
      );
    }
    const totalMilliseconds = performance.now() - totalStart;
    const accountedMilliseconds = gpuEmissionWallMilliseconds +
      artifactIsolationMilliseconds;
    return {
      status: "completed",
      bytes,
      physicalEmissions,
      physicalPlans: resident.physicalPlans,
      adapterLimits: resident.adapterLimits,
      timings: {
        totalMilliseconds,
        deviceRequestMilliseconds: 0,
        partitioningMilliseconds: 0,
        gpuEmissionWallMilliseconds,
        artifactIsolationMilliseconds,
        unaccountedMilliseconds: Math.max(
          0,
          totalMilliseconds - accountedMilliseconds,
        ),
      },
    };
  } finally {
    state.activeBorrows -= 1;
    if (state.released && state.activeBorrows === 0) {
      releaseResidentWasmInputs(state);
    }
  }
}

function compilerGpuLimits(limits: GPUSupportedLimits): CompilerGpuLimits {
  return {
    maxBufferSize: limits.maxBufferSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
    maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
    maxUniformBuffersPerShaderStage: limits.maxUniformBuffersPerShaderStage,
  };
}

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
  readonly columns: ReturnType<typeof atomColumns>;
  readonly inputByteLengths: {
    readonly kinds: number;
    readonly primaryLowWords: number;
    readonly nonByteLowWords: number;
    readonly byteRanks: number;
    readonly highWords: number;
    readonly lengthAtomIndices: number;
    readonly lengthPayloadIndices: number;
    readonly lengthRangeStarts: number;
    readonly lengthRangeCounts: number;
    readonly payloadAtomBases: number;
  };
  readonly atomCount: number;
  readonly payloadEndAtomIndices: readonly number[];
  readonly workgroupCount: number;
  readonly lengthAtomCount: number;
  readonly lengthSizingDependencyAtomCount: number;
  readonly lengthLevelRegions: readonly {
    readonly firstLengthRank: number;
    readonly lengthCount: number;
  }[];
  readonly lengthAtomIndices: Uint32Array;
  readonly lengthPayloadIndices: Uint32Array;
  readonly lengthRangeStarts: Uint32Array;
  readonly lengthRangeCounts: Uint32Array;
  readonly payloadAtomBases: Uint32Array;
  readonly planInspectionMilliseconds: number;
  readonly columnConstructionMilliseconds: number;
  readonly maximumEncodedByteLength: number;
};

type WasmGpuResidentInputs = {
  readonly device: GPUDevice;
  readonly leases: readonly CompilerGpuBufferLease[];
  readonly kindBuffer: GPUBuffer;
  readonly lowWordBuffer: GPUBuffer;
  readonly nonByteLowWordBuffer: GPUBuffer;
  readonly byteRankBuffer: GPUBuffer;
  readonly highWordBuffer: GPUBuffer;
  readonly lengthAtomIndexBuffer: GPUBuffer;
  readonly lengthPayloadIndexBuffer: GPUBuffer;
  readonly lengthRangeStartBuffer: GPUBuffer;
  readonly lengthRangeCountBuffer: GPUBuffer;
  readonly payloadAtomBaseBuffer: GPUBuffer;
  readonly countParameterBuffer: GPUBuffer;
  readonly lengthParameterBuffers: readonly GPUBuffer[];
};

type ResidentWasmPhysicalPlan = {
  readonly job: PreparedWasmGpuJob;
  readonly inputs: WasmGpuResidentInputs;
  readonly physicalPlan: GpuWasmPhysicalPlan;
};

type ResidentWasmPlanState = {
  readonly physical: readonly ResidentWasmPhysicalPlan[];
  released: boolean;
  leasesReleased: boolean;
  activeBorrows: number;
};

const residentWasmPlanStates = new WeakMap<
  GpuResidentWasmPlans,
  ResidentWasmPlanState
>();

function releaseResidentWasmInputs(state: ResidentWasmPlanState): void {
  if (state.leasesReleased) return;
  state.leasesReleased = true;
  for (const physical of state.physical) {
    physical.inputs.leases.forEach((lease) => lease.release());
  }
}

function prepareWasmGpuJob(
  plan: WasmBinaryPlan,
  lowWordLayout: GpuWasmLowWordLayout,
  payloadEndAtomIndices: readonly number[] = [plan.atoms.length],
): PreparedWasmGpuJob {
  requirePayloadAtomBoundaries(payloadEndAtomIndices, plan.atoms.length);
  const inspectionStart = performance.now();
  const analysis = inspectWasmBinaryPlanStructure(plan);
  const planInspectionMilliseconds = performance.now() - inspectionStart;
  const lengthAtoms = analysis.lengthLevels.flatMap((level) => level.atoms);
  let firstLengthRank = 0;
  const columnStart = performance.now();
  const columns = atomColumns(
    plan.atoms,
    analysis,
    lowWordLayout,
  );
  const columnConstructionMilliseconds = performance.now() - columnStart;
  const lengthAtomIndices = Uint32Array.from(
    lengthAtoms.map((atom) => atom.atomIndex),
  );
  const lengthPayloadIndices = new Uint32Array(lengthAtoms.length);
  const lengthRangeStarts = Uint32Array.from(
    lengthAtoms.map((atom) => atom.rangeStart),
  );
  const lengthRangeCounts = Uint32Array.from(
    lengthAtoms.map((atom) => atom.rangeCount),
  );
  const payloadAtomBases = new Uint32Array([0]);
  return {
    columns,
    inputByteLengths: wasmGpuInputByteLengths(
      columns,
      lengthAtomIndices,
      lengthPayloadIndices,
      lengthRangeStarts,
      lengthRangeCounts,
      payloadAtomBases,
    ),
    atomCount: plan.atoms.length,
    payloadEndAtomIndices,
    workgroupCount: Math.ceil(plan.atoms.length / wasmWorkgroupSize),
    lengthAtomCount: analysis.lengthLevels.reduce(
      (count, level) => count + level.atoms.length,
      0,
    ),
    lengthSizingDependencyAtomCount: analysis.dependencyAtomCount,
    lengthLevelRegions: analysis.lengthLevels.map((level) => {
      const region = {
        firstLengthRank,
        lengthCount: level.atoms.length,
      };
      firstLengthRank += level.atoms.length;
      return region;
    }),
    lengthAtomIndices,
    lengthPayloadIndices,
    lengthRangeStarts,
    lengthRangeCounts,
    payloadAtomBases,
    planInspectionMilliseconds,
    columnConstructionMilliseconds,
    maximumEncodedByteLength: analysis.maximumEncodedByteLength,
  };
}

function prepareWasmGpuBatch(
  plans: readonly WasmBinaryPlan[],
  validatedStructures?: readonly WasmBinaryPlanStructure[],
): PreparedWasmGpuJob {
  if (plans.length === 0) {
    throw new TypeError("resident Wasm preparation requires at least one plan");
  }
  const inspectionStart = performance.now();
  const structures = validatedStructures ??
    plans.map(inspectWasmBinaryPlanStructure);
  const planInspectionMilliseconds = validatedStructures === undefined
    ? performance.now() - inspectionStart
    : 0;
  if (structures.length !== plans.length) {
    throw new RangeError(
      `Wasm batch has ${plans.length} plans but ${structures.length} structure witnesses`,
    );
  }
  const columnStart = performance.now();
  const payloadAtomBases = new Uint32Array(plans.length);
  const payloadEndAtomIndices: number[] = [];
  let atomCount = 0;
  let maximumEncodedByteLength = 0;
  let lengthSizingDependencyAtomCount = 0;
  for (const [payload, plan] of plans.entries()) {
    payloadAtomBases[payload] = atomCount;
    atomCount = safeResourceSum("atom count", atomCount, plan.atoms.length);
    payloadEndAtomIndices.push(atomCount);
    maximumEncodedByteLength = safeResourceSum(
      "maximum output bytes",
      maximumEncodedByteLength,
      structures[payload]!.maximumEncodedByteLength,
    );
    lengthSizingDependencyAtomCount = safeResourceSum(
      "length dependency count",
      lengthSizingDependencyAtomCount,
      structures[payload]!.dependencyAtomCount,
    );
  }
  const columns = denseAtomColumns(plans, structures, atomCount);
  const levels = new Map<
    number,
    {
      readonly payload: number;
      readonly atomIndex: number;
      readonly rangeStart: number;
      readonly rangeCount: number;
    }[]
  >();
  for (const [payload, structure] of structures.entries()) {
    for (const level of structure.lengthLevels) {
      const retained = levels.get(level.dependencyLevel) ?? [];
      retained.push(...level.atoms.map((atom) => ({
        payload,
        atomIndex: atom.atomIndex,
        rangeStart: atom.rangeStart,
        rangeCount: atom.rangeCount,
      })));
      levels.set(level.dependencyLevel, retained);
    }
  }
  const orderedLevels = [...levels.entries()].sort(([left], [right]) =>
    left - right
  );
  const lengthAtoms = orderedLevels.flatMap(([, atoms]) => atoms);
  let firstLengthRank = 0;
  const lengthLevelRegions = orderedLevels.map(([, atoms]) => {
    const region = { firstLengthRank, lengthCount: atoms.length };
    firstLengthRank += atoms.length;
    return region;
  });
  const columnConstructionMilliseconds = performance.now() - columnStart;
  const lengthAtomIndices = Uint32Array.from(
    lengthAtoms.map((atom) => atom.atomIndex),
  );
  const lengthPayloadIndices = Uint32Array.from(
    lengthAtoms.map((atom) => atom.payload),
  );
  const lengthRangeStarts = Uint32Array.from(
    lengthAtoms.map((atom) => atom.rangeStart),
  );
  const lengthRangeCounts = Uint32Array.from(
    lengthAtoms.map((atom) => atom.rangeCount),
  );
  return {
    columns,
    inputByteLengths: wasmGpuInputByteLengths(
      columns,
      lengthAtomIndices,
      lengthPayloadIndices,
      lengthRangeStarts,
      lengthRangeCounts,
      payloadAtomBases,
    ),
    atomCount,
    payloadEndAtomIndices,
    workgroupCount: Math.ceil(atomCount / wasmWorkgroupSize),
    lengthAtomCount: lengthAtoms.length,
    lengthSizingDependencyAtomCount,
    lengthLevelRegions,
    lengthAtomIndices,
    lengthPayloadIndices,
    lengthRangeStarts,
    lengthRangeCounts,
    payloadAtomBases,
    planInspectionMilliseconds,
    columnConstructionMilliseconds,
    maximumEncodedByteLength,
  };
}

function wasmGpuInputByteLengths(
  columns: ReturnType<typeof atomColumns>,
  lengthAtomIndices: Uint32Array,
  lengthPayloadIndices: Uint32Array,
  lengthRangeStarts: Uint32Array,
  lengthRangeCounts: Uint32Array,
  payloadAtomBases: Uint32Array,
): PreparedWasmGpuJob["inputByteLengths"] {
  return {
    kinds: columns.kinds.byteLength,
    primaryLowWords: columns.primaryLowWords.byteLength,
    nonByteLowWords: columns.nonByteLowWords.byteLength,
    byteRanks: columns.byteRanks.byteLength,
    highWords: columns.highWords.byteLength,
    lengthAtomIndices: lengthAtomIndices.byteLength,
    lengthPayloadIndices: lengthPayloadIndices.byteLength,
    lengthRangeStarts: lengthRangeStarts.byteLength,
    lengthRangeCounts: lengthRangeCounts.byteLength,
    payloadAtomBases: payloadAtomBases.byteLength,
  };
}

function discardWasmGpuHostInputColumns(
  job: PreparedWasmGpuJob,
): PreparedWasmGpuJob {
  return {
    ...job,
    columns: {
      ...job.columns,
      kinds: new Uint32Array(),
      primaryLowWords: new Uint32Array(),
      nonByteLowWords: new Uint32Array(),
      byteRanks: new Uint32Array(),
      highWords: new Uint32Array(),
    },
    lengthAtomIndices: new Uint32Array(),
    lengthPayloadIndices: new Uint32Array(),
    lengthRangeStarts: new Uint32Array(),
    lengthRangeCounts: new Uint32Array(),
    payloadAtomBases: new Uint32Array(),
  };
}

function denseAtomColumns(
  plans: readonly WasmBinaryPlan[],
  structures: readonly WasmBinaryPlanStructure[],
  atomCount: number,
): ReturnType<typeof atomColumns> {
  const kinds = new Uint32Array(atomCount);
  const primaryLowWords = new Uint32Array(atomCount);
  const highWords = new Uint32Array(atomCount);
  let atomBase = 0;
  for (const plan of plans) {
    for (const [localIndex, atom] of plan.atoms.entries()) {
      const index = atomBase + localIndex;
      if (atom.kind === "byte") {
        kinds[index] = atomByte;
        primaryLowWords[index] = atom.value;
      } else if (atom.kind === "unsigned") {
        kinds[index] = atomUnsigned;
        primaryLowWords[index] = atom.value;
      } else if (atom.kind === "signed32") {
        kinds[index] = atomSigned32;
        primaryLowWords[index] = atom.value >>> 0;
      } else if (atom.kind === "signed64") {
        kinds[index] = atomSigned64;
        primaryLowWords[index] = Number(BigInt.asUintN(32, atom.value));
        highWords[index] = Number(BigInt.asUintN(32, atom.value >> 32n));
      } else {
        kinds[index] = atomLength;
      }
    }
    atomBase += plan.atoms.length;
  }
  return {
    kinds,
    primaryLowWords,
    nonByteLowWords: new Uint32Array(),
    byteRanks: new Uint32Array(),
    lowWordLayout: "dense",
    byteAtomCount: structures.reduce(
      (sum, structure) => sum + structure.byteAtomCount,
      0,
    ),
    byteRankBitWidth: 0,
    maximumByteRank: 0,
    highWords,
    signed64AtomCount: structures.reduce(
      (sum, structure) => sum + structure.signed64AtomCount,
      0,
    ),
    sparseSigned64HighWords: false,
    denseKinds: true,
  };
}

function uploadWasmGpuResidentInputs(
  device: GPUDevice,
  job: PreparedWasmGpuJob,
): WasmGpuResidentInputs {
  const retainedLeases: CompilerGpuBufferLease[] = [];
  const retain = (lease: CompilerGpuBufferLease): CompilerGpuBufferLease => {
    retainedLeases.push(lease);
    return lease;
  };
  try {
    const kindLease = acquireUploadedBuffer(
      device,
      "Wasm atom kinds",
      job.columns.kinds,
      GPUBufferUsage.STORAGE,
    );
    retain(kindLease);
    const lowWordLease = acquireUploadedBuffer(
      device,
      "Wasm atom primary low words",
      job.columns.primaryLowWords,
      GPUBufferUsage.STORAGE,
    );
    retain(lowWordLease);
    const nonByteLowWordLease = acquireUploadedBuffer(
      device,
      "Wasm atom non-byte low words",
      job.columns.nonByteLowWords,
      GPUBufferUsage.STORAGE,
    );
    retain(nonByteLowWordLease);
    const byteRankLease = acquireUploadedBuffer(
      device,
      "Wasm atom byte ranks",
      job.columns.byteRanks,
      GPUBufferUsage.STORAGE,
    );
    retain(byteRankLease);
    const highWordLease = acquireUploadedBuffer(
      device,
      "Wasm atom high words",
      job.columns.highWords,
      GPUBufferUsage.STORAGE,
    );
    retain(highWordLease);
    const lengthAtomIndexLease = acquireUploadedBuffer(
      device,
      "Wasm length atom indices",
      job.lengthAtomIndices,
      GPUBufferUsage.STORAGE,
    );
    retain(lengthAtomIndexLease);
    const lengthPayloadIndexLease = acquireUploadedBuffer(
      device,
      "Wasm length payload indices",
      job.lengthPayloadIndices,
      GPUBufferUsage.STORAGE,
    );
    retain(lengthPayloadIndexLease);
    const lengthRangeStartLease = acquireUploadedBuffer(
      device,
      "Wasm length range starts",
      job.lengthRangeStarts,
      GPUBufferUsage.STORAGE,
    );
    retain(lengthRangeStartLease);
    const lengthRangeCountLease = acquireUploadedBuffer(
      device,
      "Wasm length range counts",
      job.lengthRangeCounts,
      GPUBufferUsage.STORAGE,
    );
    retain(lengthRangeCountLease);
    const payloadAtomBaseLease = acquireUploadedBuffer(
      device,
      "Wasm payload atom bases",
      job.payloadAtomBases,
      GPUBufferUsage.STORAGE,
    );
    retain(payloadAtomBaseLease);
    const countParameterLease = acquireUploadedBuffer(
      device,
      "Wasm count parameters",
      new Uint32Array([
        job.atomCount,
        job.columns.signed64AtomCount,
        representationFlags(job),
        0,
      ]),
      GPUBufferUsage.UNIFORM,
    );
    retain(countParameterLease);
    const lengthParameterLeases = job.lengthLevelRegions.map((region, index) =>
      retain(acquireUploadedBuffer(
        device,
        `Wasm length level ${index} parameters`,
        new Uint32Array([
          region.firstLengthRank,
          region.lengthCount,
          0,
          0,
        ]),
        GPUBufferUsage.UNIFORM,
      ))
    );
    return {
      device,
      leases: retainedLeases,
      kindBuffer: kindLease.buffer,
      lowWordBuffer: lowWordLease.buffer,
      nonByteLowWordBuffer: nonByteLowWordLease.buffer,
      byteRankBuffer: byteRankLease.buffer,
      highWordBuffer: highWordLease.buffer,
      lengthAtomIndexBuffer: lengthAtomIndexLease.buffer,
      lengthPayloadIndexBuffer: lengthPayloadIndexLease.buffer,
      lengthRangeStartBuffer: lengthRangeStartLease.buffer,
      lengthRangeCountBuffer: lengthRangeCountLease.buffer,
      payloadAtomBaseBuffer: payloadAtomBaseLease.buffer,
      countParameterBuffer: countParameterLease.buffer,
      lengthParameterBuffers: lengthParameterLeases.map((lease) =>
        lease.buffer
      ),
    };
  } catch (error) {
    retainedLeases.forEach((lease) => lease.release());
    throw error;
  }
}

function requirePayloadAtomBoundaries(
  payloadEndAtomIndices: readonly number[],
  atomCount: number,
): void {
  if (payloadEndAtomIndices.length === 0) {
    throw new TypeError("Wasm emission requires one terminal atom boundary");
  }
  let precedingAtomIndex = 0;
  for (const [index, atomIndex] of payloadEndAtomIndices.entries()) {
    if (
      !Number.isSafeInteger(atomIndex) || atomIndex <= precedingAtomIndex ||
      atomIndex > atomCount
    ) {
      throw new RangeError(
        `Wasm payload boundary ${index} uses atom ${atomIndex} after ${precedingAtomIndex}; plan has ${atomCount} atoms`,
      );
    }
    precedingAtomIndex = atomIndex;
  }
  if (precedingAtomIndex !== atomCount) {
    throw new RangeError(
      `Wasm final payload boundary ${precedingAtomIndex} does not cover ${atomCount} atoms`,
    );
  }
}

async function emitWasmPlanWithGpu(
  plan: WasmBinaryPlan,
  scheduling: CompilerGpuSchedulingPolicy,
  lowWordLayout: GpuWasmLowWordLayout,
  payloadEndAtomIndices: readonly number[] = [plan.atoms.length],
): Promise<GpuWasmEmissionResult> {
  const job = prepareWasmGpuJob(
    plan,
    lowWordLayout,
    payloadEndAtomIndices,
  );
  return await emitPreparedWasmJobWithGpu(job, scheduling);
}

async function emitPreparedWasmJobWithGpu(
  job: PreparedWasmGpuJob,
  scheduling: CompilerGpuSchedulingPolicy,
  residentInputs?: WasmGpuResidentInputs,
): Promise<GpuWasmEmissionResult> {
  const totalStart = performance.now();
  const planAnalysisAndColumnMilliseconds = job.planInspectionMilliseconds +
    job.columnConstructionMilliseconds;
  const planInspectionMilliseconds = job.planInspectionMilliseconds;
  const columnConstructionMilliseconds = job.columnConstructionMilliseconds;
  const {
    columns,
    lengthAtomCount,
    lengthLevelRegions,
    lengthSizingDependencyAtomCount,
    maximumEncodedByteLength,
    atomCount,
    inputByteLengths,
    payloadEndAtomIndices,
    workgroupCount,
  } = job;
  const contextStart = performance.now();
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return context;
  const contextMilliseconds = performance.now() - contextStart;
  const allocationAndUploadStart = performance.now();
  const {
    device,
    emissionPipeline,
    initialSizingPipeline,
    lengthSizingPipeline,
    scanPipelines,
  } = context;
  const kindBytes = Math.max(4, inputByteLengths.kinds);
  const primaryLowWordBytes = Math.max(
    4,
    inputByteLengths.primaryLowWords,
  );
  const nonByteLowWordBytes = Math.max(
    4,
    inputByteLengths.nonByteLowWords,
  );
  const byteRankBytes = Math.max(4, inputByteLengths.byteRanks);
  const signed64HighWordBytes = Math.max(4, inputByteLengths.highWords);
  const atomSizeBytes = atomCount * Uint32Array.BYTES_PER_ELEMENT;
  const resolvedOffsetBytes = (atomCount + 1) *
    Uint32Array.BYTES_PER_ELEMENT;
  const outputWordCount = Math.ceil(
    maximumEncodedByteLength / Uint32Array.BYTES_PER_ELEMENT,
  );
  const outputBytes = outputWordCount * Uint32Array.BYTES_PER_ELEMENT;
  const boundaryBytes = payloadEndAtomIndices.length *
    Uint32Array.BYTES_PER_ELEMENT;
  const readbackBytes = outputBytes + boundaryBytes;
  const capacityRequests = [
    ["atom kinds", kindBytes, "storage"],
    ["atom primary low words", primaryLowWordBytes, "storage"],
    ["atom non-byte low words", nonByteLowWordBytes, "storage"],
    ["atom byte ranks", byteRankBytes, "storage"],
    ["signed64 high words", signed64HighWordBytes, "storage"],
    ["atom sizes", atomSizeBytes, "storage"],
    ["resolved atom offsets", resolvedOffsetBytes, "storage"],
    ["length values", atomSizeBytes, "storage"],
    [
      "length atom indices",
      Math.max(4, inputByteLengths.lengthAtomIndices),
      "storage",
    ],
    [
      "length range starts",
      Math.max(4, inputByteLengths.lengthRangeStarts),
      "storage",
    ],
    [
      "length payload indices",
      Math.max(4, inputByteLengths.lengthPayloadIndices),
      "storage",
    ],
    [
      "length range counts",
      Math.max(4, inputByteLengths.lengthRangeCounts),
      "storage",
    ],
    [
      "payload atom bases",
      Math.max(4, inputByteLengths.payloadAtomBases),
      "storage",
    ],
    ["packed output", outputBytes, "storage"],
    ["count parameters", 16, "uniform"],
    ["readback", readbackBytes, "copy"],
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
  if (residentInputs !== undefined && residentInputs.device !== device) {
    return {
      status: "unavailable",
      reason:
        "resident Wasm plan belongs to a GPU device that is no longer active",
    };
  }
  const inputs = residentInputs ?? uploadWasmGpuResidentInputs(device, job);
  const {
    kindBuffer,
    lowWordBuffer,
    nonByteLowWordBuffer,
    byteRankBuffer,
    highWordBuffer,
    lengthAtomIndexBuffer,
    lengthPayloadIndexBuffer,
    lengthRangeStartBuffer,
    lengthRangeCountBuffer,
    payloadAtomBaseBuffer,
    countParameterBuffer,
    lengthParameterBuffers,
  } = inputs;
  const atomSizeLease = acquireCompilerGpuBuffer(
    device,
    "Wasm atom sizes",
    { size: atomSizeBytes, usage: GPUBufferUsage.STORAGE },
    "storage",
  );
  const atomSizeBuffer = atomSizeLease.buffer;
  const lengthValueLease = acquireCompilerGpuBuffer(
    device,
    "Wasm resolved length values",
    { size: atomSizeBytes, usage: GPUBufferUsage.STORAGE },
    "storage",
  );
  const lengthValueBuffer = lengthValueLease.buffer;
  const outputLease = acquireCompilerGpuBuffer(
    device,
    "Wasm packed output",
    {
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    },
    "storage",
  );
  const outputBuffer = outputLease.buffer;
  const readbackLease = acquireCompilerGpuBuffer(
    device,
    "Wasm readback",
    {
      size: readbackBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const readback = readbackLease.buffer;
  const scratchLeases = [
    atomSizeLease,
    lengthValueLease,
    outputLease,
    readbackLease,
  ];
  const allocationAndUploadMilliseconds = performance.now() -
    allocationAndUploadStart;
  let readbackMapped = false;
  let resolvedOffsets: GpuExclusiveScanEncoding | undefined;
  try {
    const commandEncodingStart = performance.now();
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(outputBuffer, 0, outputBytes);
    const initialSizingPass = encoder.beginComputePass({
      label: "Wasm scalar atom sizing",
    });
    initialSizingPass.setPipeline(initialSizingPipeline);
    initialSizingPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: initialSizingPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: kindBuffer } },
          { binding: 1, resource: { buffer: lowWordBuffer } },
          { binding: 2, resource: { buffer: nonByteLowWordBuffer } },
          { binding: 3, resource: { buffer: byteRankBuffer } },
          { binding: 4, resource: { buffer: highWordBuffer } },
          { binding: 5, resource: { buffer: atomSizeBuffer } },
          { binding: 6, resource: { buffer: countParameterBuffer } },
        ],
      }),
    );
    dispatchCompilerGpuWorkgroups(
      device,
      initialSizingPass,
      "Wasm scalar atom sizing",
      workgroupCount,
    );
    initialSizingPass.end();
    for (const [levelIndex, region] of lengthLevelRegions.entries()) {
      const lengthSizingPass = encoder.beginComputePass({
        label: `Wasm length level ${levelIndex} sizing`,
      });
      lengthSizingPass.setPipeline(lengthSizingPipeline);
      lengthSizingPass.setBindGroup(
        1,
        device.createBindGroup({
          layout: lengthSizingPipeline.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: { buffer: lengthAtomIndexBuffer } },
            { binding: 1, resource: { buffer: lengthPayloadIndexBuffer } },
            { binding: 2, resource: { buffer: lengthRangeStartBuffer } },
            { binding: 3, resource: { buffer: lengthRangeCountBuffer } },
            { binding: 4, resource: { buffer: payloadAtomBaseBuffer } },
            { binding: 5, resource: { buffer: atomSizeBuffer } },
            { binding: 6, resource: { buffer: lengthValueBuffer } },
            {
              binding: 7,
              resource: { buffer: lengthParameterBuffers[levelIndex]! },
            },
          ],
        }),
      );
      dispatchCompilerGpuWorkgroups(
        device,
        lengthSizingPass,
        `Wasm length level ${levelIndex} sizing`,
        Math.ceil(region.lengthCount / wasmWorkgroupSize),
      );
      lengthSizingPass.end();
    }
    resolvedOffsets = encodeGpuExclusiveScan(
      device,
      encoder,
      scanPipelines,
      atomSizeBuffer,
      atomCount,
    );
    const emissionBindGroup = device.createBindGroup({
      layout: emissionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: kindBuffer } },
        { binding: 1, resource: { buffer: lowWordBuffer } },
        { binding: 2, resource: { buffer: nonByteLowWordBuffer } },
        { binding: 3, resource: { buffer: byteRankBuffer } },
        { binding: 4, resource: { buffer: highWordBuffer } },
        { binding: 5, resource: { buffer: resolvedOffsets.offsets } },
        { binding: 6, resource: { buffer: outputBuffer } },
        { binding: 7, resource: { buffer: lengthValueBuffer } },
        { binding: 8, resource: { buffer: countParameterBuffer } },
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
      outputBytes,
    );
    for (const [index, atomIndex] of payloadEndAtomIndices.entries()) {
      encoder.copyBufferToBuffer(
        resolvedOffsets.offsets,
        atomIndex * Uint32Array.BYTES_PER_ELEMENT,
        readback,
        outputBytes + index * Uint32Array.BYTES_PER_ELEMENT,
        Uint32Array.BYTES_PER_ELEMENT,
      );
    }
    const command = encoder.finish();
    const commandEncodingMilliseconds = performance.now() -
      commandEncodingStart;
    const submissionStart = performance.now();
    const submission = await submitCompilerGpuCommandWithReadback(
      device,
      "Wasm emission",
      command,
      readback,
      scheduling,
    );
    const submissionWallMilliseconds = performance.now() - submissionStart;
    const submissionMilliseconds = Math.max(
      0,
      submissionWallMilliseconds - submission.queueWaitMilliseconds -
        Math.max(
          submission.deviceCompletionMilliseconds,
          submission.completionWitnessMilliseconds,
        ),
    );
    const mappingCompletionMilliseconds =
      submission.completionWitnessMilliseconds;
    readbackMapped = true;
    const mapped = readback.getMappedRange();
    const readbackCopyStart = performance.now();
    const payloadEnds = Array.from(
      new Uint32Array(mapped, outputBytes, payloadEndAtomIndices.length),
    );
    let precedingEnd = 0;
    for (const [index, end] of payloadEnds.entries()) {
      if (end < precedingEnd || end > outputBytes) {
        throw new RangeError(
          `GPU Wasm payload boundary ${index} resolved ${end} after ${precedingEnd} into ${outputBytes} bytes of output capacity`,
        );
      }
      precedingEnd = end;
    }
    const byteCount = payloadEnds.at(-1)!;
    if (byteCount > outputBytes) {
      throw new RangeError(
        `GPU Wasm layout resolved ${byteCount} bytes into ${outputBytes} bytes of output capacity`,
      );
    }
    const bytes = new Uint8Array(mapped, 0, byteCount).slice();
    const readbackCopyMilliseconds = performance.now() - readbackCopyStart;
    return {
      status: "completed",
      bytes,
      atomCount,
      byteCount,
      outputBufferBytes: outputBytes,
      readbackMode: "capacity-single-map",
      physicalReadbackBytes: readbackBytes,
      logicalReadbackBytes: byteCount + boundaryBytes,
      readbackPaddingBytes: outputBytes - byteCount,
      lengthAtomCount,
      sparseLengthSizing: false,
      lengthSizingDependencyAtomCount,
      lengthSizingWorkEstimate: lengthSizingDependencyAtomCount,
      resolvedOffsetBytes,
      resolvedOffsetBitWidth: 32,
      atomInputBytes: inputByteLengths.kinds +
        inputByteLengths.primaryLowWords +
        inputByteLengths.nonByteLowWords + inputByteLengths.byteRanks +
        inputByteLengths.highWords + inputByteLengths.lengthAtomIndices +
        inputByteLengths.lengthPayloadIndices +
        inputByteLengths.lengthRangeStarts +
        inputByteLengths.lengthRangeCounts +
        inputByteLengths.payloadAtomBases,
      lowWordLayout: columns.lowWordLayout,
      lowWordBytes: inputByteLengths.primaryLowWords +
        inputByteLengths.nonByteLowWords + inputByteLengths.byteRanks,
      byteAtomCount: columns.byteAtomCount,
      byteRankBitWidth: columns.byteRankBitWidth,
      byteRankBytes: inputByteLengths.byteRanks,
      maximumByteRank: columns.maximumByteRank,
      signed64AtomCount: columns.signed64AtomCount,
      signed64HighWordBytes: inputByteLengths.highWords,
      leasedBufferBytes: [...inputs.leases, ...scratchLeases].reduce(
        (sum, lease) => sum + lease.byteLength,
        0,
      ) + resolvedOffsets.ownedBuffers.reduce(
        (sum, buffer) => sum + Number(buffer.size),
        0,
      ),
      resources: gpuWasmPlanResources({
        atomCount,
        maximumOutputBytes: maximumEncodedByteLength,
        lengthAtomCount,
        lengthSizingDependencyAtomCount,
      }, payloadEndAtomIndices.length),
      adapterLimits: compilerGpuLimits(device.limits),
      dispatchedInvocationCount: workgroupCount * wasmWorkgroupSize * 2 +
        lengthLevelRegions.reduce(
          (count, region) =>
            count + Math.ceil(region.lengthCount / wasmWorkgroupSize) *
              wasmWorkgroupSize,
          0,
        ) + resolvedOffsets.scheduledInvocationCount,
      payloadByteOffsets: [0, ...payloadEnds],
      submissionBatchSize: submission.submissionBatchSize,
      payloadBatchSize: 1,
      queueWaitMilliseconds: submission.queueWaitMilliseconds,
      timings: {
        totalMilliseconds: performance.now() - totalStart,
        planInspectionMilliseconds,
        columnConstructionMilliseconds,
        planAnalysisAndColumnMilliseconds,
        contextMilliseconds,
        allocationAndUploadMilliseconds,
        commandEncodingMilliseconds,
        submissionMilliseconds,
        queueWaitMilliseconds: submission.queueWaitMilliseconds,
        deviceCompletionMilliseconds: submission.deviceCompletionMilliseconds,
        mappingCompletionMilliseconds,
        readbackCopyMilliseconds,
        scope: "payload",
        completionWitness: "mapping",
      },
    };
  } catch (error) {
    const reason = compilerGpuUnavailabilityReason("Wasm emission", error);
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  } finally {
    if (readbackMapped) readback.unmap();
    resolvedOffsets?.ownedBuffers.forEach((buffer) => buffer.destroy());
    scratchLeases.forEach((lease) => lease.release());
    if (residentInputs === undefined) {
      inputs.leases.forEach((lease) => lease.release());
    }
  }
}

function atomColumns(
  atoms: readonly WasmAtom[],
  analysis: WasmBinaryPlanStructure,
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
  readonly denseKinds: boolean;
} {
  const { byteAtomCount, maximumByteRank, signed64AtomCount } = analysis;
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
      lowWord = 0;
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
    denseKinds: false,
  };
}

function representationFlags(job: PreparedWasmGpuJob): number {
  return (job.columns.sparseSigned64HighWords ? 1 : 0) |
    (job.columns.lowWordLayout === "ranked" ? 4 : 0) |
    (job.columns.byteRankBitWidth === 16 ? 8 : 0) |
    (job.columns.denseKinds ? denseKindRepresentationFlag : 0);
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
        storageBufferCount: 8,
        uniformBufferCount: 1,
      });
      requireCompilerGpuCapacity(device, {
        kind: "pipelineBindings",
        label: "Wasm sizing",
        storageBufferCount: 7,
        uniformBufferCount: 1,
      });
      const emissionModule = device.createShaderModule({
        code: emissionShader,
      });
      const sizingModule = device.createShaderModule({ code: sizingShader });
      const compilationMessages = [
        ...(await emissionModule.getCompilationInfo()).messages,
        ...(await sizingModule.getCompilationInfo()).messages,
      ].filter((message) => message.type === "error");
      if (compilationMessages.length > 0) {
        throw new Error(
          `WebGPU Wasm emitter shader failed: ${
            compilationMessages.map((message) => message.message).join("; ")
          }`,
        );
      }
      const [
        emissionPipeline,
        initialSizingPipeline,
        lengthSizingPipeline,
        scanPipelines,
      ] = await Promise.all([
        device.createComputePipelineAsync({
          layout: "auto",
          compute: { module: emissionModule, entryPoint: "emit_atoms" },
        }),
        device.createComputePipelineAsync({
          layout: "auto",
          compute: { module: sizingModule, entryPoint: "size_scalar_atoms" },
        }),
        device.createComputePipelineAsync({
          layout: "auto",
          compute: { module: sizingModule, entryPoint: "size_length_atoms" },
        }),
        requestGpuExclusiveScanPipelines(device),
      ]);
      return {
        status: "available",
        device,
        emissionPipeline,
        initialSizingPipeline,
        lengthSizingPipeline,
        scanPipelines,
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

function acquireUploadedBuffer(
  device: GPUDevice,
  label: string,
  words: Uint32Array,
  usage: GPUBufferUsageFlags,
): CompilerGpuBufferLease {
  const binding = (usage & GPUBufferUsage.UNIFORM) !== 0
    ? "uniform"
    : "storage";
  const lease = acquireCompilerGpuBuffer(
    device,
    label,
    {
      size: Math.max(4, words.byteLength),
      usage: usage | GPUBufferUsage.COPY_DST,
    },
    binding,
  );
  if (words.byteLength > 0) {
    device.queue.writeBuffer(lease.buffer, 0, Uint32Array.from(words));
  }
  return lease;
}

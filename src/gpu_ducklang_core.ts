import {
  commitValidatedDucklangCoreRewrites,
  type DucklangCoreRewriteProposal,
} from "./ducklang_core_rewrite.ts";
import {
  type FlatDucklangCore,
  FlatDucklangCoreKind,
  type ValidatedFlatDucklangCore,
  validateFlatDucklangCore,
} from "./flat_ducklang_core.ts";
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

export type GpuDucklangCoreResult =
  | {
    readonly status: "completed";
    readonly package: FlatDucklangCore;
    readonly proposals: readonly DucklangCoreRewriteProposal[];
    readonly accepted: readonly DucklangCoreRewriteProposal[];
    readonly validationRecordCount: number;
    readonly validationDispatchedInvocationCount: number;
    readonly rewriteCandidateCount: number;
    readonly rewriteDispatchedInvocationCount: number;
    readonly initializationMilliseconds: number;
    readonly gpuMilliseconds: number;
    readonly transferMilliseconds: number;
    readonly commitMilliseconds: number;
    readonly submissionBatchSize: number;
    readonly payloadBatchSize: number;
    readonly queueWaitMilliseconds: number;
  }
  | {
    readonly status: "invalid";
    readonly reason: string;
    readonly validationRecordCount: number;
  }
  | {
    readonly status: "unavailable";
    readonly reason: string;
  };

type GpuCoreContext =
  | {
    readonly status: "available";
    readonly device: GPUDevice;
    readonly validationPipeline: GPUComputePipeline;
    readonly rewritePipeline: GPUComputePipeline;
  }
  | { readonly status: "unavailable"; readonly reason: string };

const validationShader = `
struct Parameters { record_count: u32 }
@group(0) @binding(0) var<storage, read> records: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read_write> errors: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn validate_records(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.record_count) { return; }
  let record = records[index];
  var valid = false;
  if (record.x == 0u) {
    valid = record.y < record.z;
  } else if (record.x == 1u) {
    valid = record.y == record.z;
  } else if (record.x == 2u) {
    valid = record.y <= record.w && record.z <= record.w - record.y;
  }
  if (!valid) {
    atomicAdd(&errors[0], 1u);
    atomicMin(&errors[1], index);
  }
}
`;

const rewriteShader = `
struct Parameters {
  candidate_count: u32,
  operation_count: u32,
  operand_count: u32,
  attribute_count: u32,
  value_count: u32,
  type_count: u32,
}
@group(0) @binding(0) var<storage, read> operations: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> operation_ranges: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> operands: array<u32>;
@group(0) @binding(3) var<storage, read> attributes: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> values: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read> types: array<vec2<u32>>;
@group(0) @binding(6) var<storage, read_write> rules: array<u32>;
@group(0) @binding(7) var<storage, read_write> replacements: array<u32>;
@group(0) @binding(8) var<uniform> parameters: Parameters;

fn has_integer_scalar_result(operation: vec4<u32>) -> bool {
  let type_id = operation.w;
  if (
    type_id >= parameters.type_count ||
    types[type_id].x != ${FlatDucklangCoreKind.type.scalar}u
  ) {
    return false;
  }
  let scalar = types[type_id].y;
  return
    scalar == ${FlatDucklangCoreKind.scalar.i32}u ||
    scalar == ${FlatDucklangCoreKind.scalar.i64}u;
}

fn constant_equals(value_id: u32, expected_high: u32) -> bool {
  if (value_id >= parameters.value_count) { return false; }
  let value = values[value_id];
  if (value.z != ${FlatDucklangCoreKind.valueDefinition.operation}u) {
    return false;
  }
  let operation_id = value.w;
  if (operation_id >= parameters.operation_count) { return false; }
  let operation = operations[operation_id];
  let ranges = operation_ranges[operation_id];
  if (
    operation.x != ${FlatDucklangCoreKind.operation.constant}u ||
    ranges.z >= parameters.attribute_count ||
    ranges.w != 1u
  ) {
    return false;
  }
  let operation_attribute = attributes[ranges.z];
  return
    operation_attribute.x == ${FlatDucklangCoreKind.attribute.number}u &&
    operation_attribute.y == 0u &&
    operation_attribute.z == expected_high;
}

@compute @workgroup_size(64)
fn propose_rewrites(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let candidate_id = invocation.x;
  if (candidate_id >= parameters.candidate_count) { return; }
  let operation_id = rules[candidate_id];
  rules[candidate_id] = 0u;
  replacements[candidate_id] = 0xffffffffu;
  let operation = operations[operation_id];
  let ranges = operation_ranges[operation_id];
  if (
    operation.x != ${FlatDucklangCoreKind.operation.scalarBinary}u ||
    ranges.y != 2u ||
    ranges.w != 1u ||
    ranges.x > parameters.operand_count ||
    ranges.y > parameters.operand_count - ranges.x ||
    ranges.z >= parameters.attribute_count ||
    !has_integer_scalar_result(operation)
  ) {
    return;
  }
  let operation_attribute = attributes[ranges.z];
  if (operation_attribute.x != ${FlatDucklangCoreKind.attribute.unsigned}u) {
    return;
  }
  let left = operands[ranges.x];
  let right = operands[ranges.x + 1u];
  if (operation_attribute.y == ${FlatDucklangCoreKind.binaryOperator.add}u) {
    if (constant_equals(right, 0u)) {
      rules[candidate_id] = 1u;
      replacements[candidate_id] = left;
    } else if (constant_equals(left, 0u)) {
      rules[candidate_id] = 1u;
      replacements[candidate_id] = right;
    }
  } else if (
    operation_attribute.y == ${FlatDucklangCoreKind.binaryOperator.multiply}u
  ) {
    if (constant_equals(right, 0x3ff00000u)) {
      rules[candidate_id] = 2u;
      replacements[candidate_id] = left;
    } else if (constant_equals(left, 0x3ff00000u)) {
      rules[candidate_id] = 2u;
      replacements[candidate_id] = right;
    }
  }
}
`;

let contextPromise: Promise<GpuCoreContext> | undefined;
const coreBatchQueue = createCompilerGpuBatchQueue(
  (snapshots: readonly FlatDucklangCore[]) =>
    snapshots.length === 1
      ? Promise.all(
        snapshots.map((snapshot) =>
          runDucklangCoreWithGpu(snapshot, "latency")
        ),
      )
      : runDucklangCoreGpuBatch(snapshots),
);

export async function runDucklangCoreGpuPass(
  snapshot: FlatDucklangCore,
  options: {
    readonly scheduling?: CompilerGpuSchedulingPolicy;
  } = {},
): Promise<GpuDucklangCoreResult> {
  try {
    const batch = await coreBatchQueue.enqueue(
      snapshot,
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
    const reason = compilerGpuUnavailabilityReason(
      "Ducklang Core pass",
      error,
    );
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  }
}

type CoreCpuValidation =
  | {
    readonly status: "valid";
    readonly snapshot: ValidatedFlatDucklangCore;
  }
  | { readonly status: "invalid"; readonly reason: string };

type PreparedCoreGpuJob = {
  readonly snapshot: FlatDucklangCore;
  readonly records: Uint32Array;
  readonly cpuValidation: CoreCpuValidation;
  readonly operationColumns: Uint32Array;
  readonly operationRanges: Uint32Array;
  readonly attributes: Uint32Array;
  readonly values: Uint32Array;
  readonly types: Uint32Array;
  readonly rewriteCandidateOperationIds: Uint32Array;
};

type PackedCoreColumn = {
  readonly words: Uint32Array;
  readonly regions: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly maximumRegionSize: number;
};

async function runDucklangCoreGpuBatch(
  snapshots: readonly FlatDucklangCore[],
): Promise<readonly GpuDucklangCoreResult[]> {
  try {
    return await runPackedDucklangCoreGpuBatch(snapshots);
  } catch (error) {
    if (error instanceof CompilerGpuCapacityError && snapshots.length > 1) {
      const split = Math.ceil(snapshots.length / 2);
      const [left, right] = await Promise.all([
        runDucklangCoreGpuBatch(snapshots.slice(0, split)),
        runDucklangCoreGpuBatch(snapshots.slice(split)),
      ]);
      return [...left, ...right];
    }
    throw error;
  }
}

async function runPackedDucklangCoreGpuBatch(
  snapshots: readonly FlatDucklangCore[],
): Promise<readonly GpuDucklangCoreResult[]> {
  const initializationStart = performance.now();
  const context = await requestGpuCoreContext();
  if (context.status === "unavailable") {
    return snapshots.map(() => context);
  }
  const initializationMilliseconds = performance.now() - initializationStart;
  const { device, validationPipeline, rewritePipeline } = context;
  const jobs = snapshots.map(prepareCoreGpuJob);
  const storageAlignment = device.limits.minStorageBufferOffsetAlignment;
  const uniformAlignment = device.limits.minUniformBufferOffsetAlignment;
  const records = packCoreColumns(
    jobs.map((job) => job.records),
    4,
    storageAlignment,
  );
  const errors = packCoreColumns(
    jobs.map(() => new Uint32Array([0, 0xffff_ffff])),
    8,
    storageAlignment,
  );
  const validationParameters = packCoreColumns(
    jobs.map((job) => new Uint32Array([job.records.length / 4])),
    4,
    uniformAlignment,
  );
  const operations = packCoreColumns(
    jobs.map((job) => job.operationColumns),
    4,
    storageAlignment,
  );
  const operationRanges = packCoreColumns(
    jobs.map((job) => job.operationRanges),
    4,
    storageAlignment,
  );
  const operands = packCoreColumns(
    jobs.map((job) => job.snapshot.operandValueIds),
    4,
    storageAlignment,
  );
  const attributes = packCoreColumns(
    jobs.map((job) => job.attributes),
    4,
    storageAlignment,
  );
  const values = packCoreColumns(
    jobs.map((job) => job.values),
    4,
    storageAlignment,
  );
  const types = packCoreColumns(
    jobs.map((job) => job.types),
    8,
    storageAlignment,
  );
  const rules = packCoreColumns(
    jobs.map((job) => job.rewriteCandidateOperationIds),
    4,
    storageAlignment,
  );
  const replacements = packCoreColumns(
    jobs.map((job) => new Uint32Array(job.rewriteCandidateOperationIds.length)),
    4,
    storageAlignment,
  );
  const rewriteParameters = packCoreColumns(
    jobs.map((job) =>
      new Uint32Array([
        job.rewriteCandidateOperationIds.length,
        job.snapshot.operationKinds.length,
        job.snapshot.operandValueIds.length,
        job.snapshot.attributeKinds.length,
        job.snapshot.valueLocalIds.length,
        job.snapshot.typeKinds.length,
      ])
    ),
    24,
    uniformAlignment,
  );
  const readback = packCoreColumns(
    jobs.map((job) =>
      new Uint32Array(2 + job.rewriteCandidateOperationIds.length * 2)
    ),
    8,
    4,
  );

  const transferStart = performance.now();
  const recordBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch validation records",
    records,
    GPUBufferUsage.STORAGE,
  );
  const errorBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch validation errors",
    errors,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const validationParameterBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch validation parameters",
    validationParameters,
    GPUBufferUsage.UNIFORM,
  );
  const operationBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch operations",
    operations,
    GPUBufferUsage.STORAGE,
  );
  const operationRangeBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch operation ranges",
    operationRanges,
    GPUBufferUsage.STORAGE,
  );
  const operandBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch operands",
    operands,
    GPUBufferUsage.STORAGE,
  );
  const attributeBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch attributes",
    attributes,
    GPUBufferUsage.STORAGE,
  );
  const valueBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch values",
    values,
    GPUBufferUsage.STORAGE,
  );
  const typeBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch types",
    types,
    GPUBufferUsage.STORAGE,
  );
  const ruleBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch rewrite rules",
    rules,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const replacementBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch rewrite replacements",
    replacements,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const rewriteParameterBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch rewrite parameters",
    rewriteParameters,
    GPUBufferUsage.UNIFORM,
  );
  const readbackBuffer = createCompilerGpuBuffer(
    device,
    "Ducklang Core batch readback",
    {
      size: readback.words.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const transferMilliseconds = performance.now() - transferStart;
  const buffers = [
    recordBuffer,
    errorBuffer,
    validationParameterBuffer,
    operationBuffer,
    operationRangeBuffer,
    operandBuffer,
    attributeBuffer,
    valueBuffer,
    typeBuffer,
    ruleBuffer,
    replacementBuffer,
    rewriteParameterBuffer,
    readbackBuffer,
  ];
  let mapped = false;
  try {
    const encoder = device.createCommandEncoder();
    const validationPass = encoder.beginComputePass();
    validationPass.setPipeline(validationPipeline);
    for (const [index, job] of jobs.entries()) {
      validationPass.setBindGroup(
        0,
        device.createBindGroup({
          layout: validationPipeline.getBindGroupLayout(0),
          entries: [
            coreBindGroupEntry(0, recordBuffer, records.regions[index]),
            coreBindGroupEntry(1, errorBuffer, errors.regions[index]),
            coreBindGroupEntry(
              2,
              validationParameterBuffer,
              validationParameters.regions[index],
            ),
          ],
        }),
      );
      dispatchCompilerGpuWorkgroups(
        device,
        validationPass,
        `Ducklang Core batch validation job ${index}`,
        Math.max(1, Math.ceil(job.records.length / 256)),
      );
    }
    validationPass.end();

    const rewritePass = encoder.beginComputePass();
    rewritePass.setPipeline(rewritePipeline);
    for (const [index, job] of jobs.entries()) {
      if (job.rewriteCandidateOperationIds.length === 0) continue;
      rewritePass.setBindGroup(
        0,
        device.createBindGroup({
          layout: rewritePipeline.getBindGroupLayout(0),
          entries: [
            coreBindGroupEntry(0, operationBuffer, operations.regions[index]),
            coreBindGroupEntry(
              1,
              operationRangeBuffer,
              operationRanges.regions[index],
            ),
            coreBindGroupEntry(2, operandBuffer, operands.regions[index]),
            coreBindGroupEntry(
              3,
              attributeBuffer,
              attributes.regions[index],
            ),
            coreBindGroupEntry(4, valueBuffer, values.regions[index]),
            coreBindGroupEntry(5, typeBuffer, types.regions[index]),
            coreBindGroupEntry(6, ruleBuffer, rules.regions[index]),
            coreBindGroupEntry(
              7,
              replacementBuffer,
              replacements.regions[index],
            ),
            coreBindGroupEntry(
              8,
              rewriteParameterBuffer,
              rewriteParameters.regions[index],
            ),
          ],
        }),
      );
      dispatchCompilerGpuWorkgroups(
        device,
        rewritePass,
        `Ducklang Core batch rewrite job ${index}`,
        Math.ceil(job.rewriteCandidateOperationIds.length / 64),
      );
    }
    rewritePass.end();

    for (const [index, job] of jobs.entries()) {
      const output = readback.regions[index].offset;
      encoder.copyBufferToBuffer(
        errorBuffer,
        errors.regions[index].offset,
        readbackBuffer,
        output,
        8,
      );
      if (job.rewriteCandidateOperationIds.byteLength === 0) continue;
      encoder.copyBufferToBuffer(
        ruleBuffer,
        rules.regions[index].offset,
        readbackBuffer,
        output + 8,
        job.rewriteCandidateOperationIds.byteLength,
      );
      encoder.copyBufferToBuffer(
        replacementBuffer,
        replacements.regions[index].offset,
        readbackBuffer,
        output + 8 + job.rewriteCandidateOperationIds.byteLength,
        job.rewriteCandidateOperationIds.byteLength,
      );
    }
    const gpuStart = performance.now();
    const submission = await submitCompilerGpuCommand(
      device,
      "Ducklang Core payload batch",
      encoder.finish(),
      "latency",
    );
    await awaitCompilerGpuCommand(
      device,
      "Ducklang Core payload batch",
      readbackBuffer.mapAsync(GPUMapMode.READ),
    );
    mapped = true;
    const gpuMilliseconds = performance.now() - gpuStart;
    const range = readbackBuffer.getMappedRange();
    return jobs.map((job, index) => {
      const output = readback.regions[index].offset;
      const errorWords = new Uint32Array(range, output, 2);
      const gpuValid = errorWords[0] === 0;
      const cpuValid = job.cpuValidation.status === "valid";
      if (gpuValid !== cpuValid) {
        const cpuDescription = cpuValid
          ? "accepted"
          : `rejected ${job.cpuValidation.reason}`;
        throw new Error(
          `CPU and GPU flat Core validation disagree for batch job ${index}: CPU ${cpuDescription}; GPU found ${
            errorWords[0]
          } invalid records, first ${errorWords[1]}`,
        );
      }
      if (job.cpuValidation.status === "invalid") {
        return {
          status: "invalid",
          reason: job.cpuValidation.reason,
          validationRecordCount: job.records.length / 4,
        };
      }
      const candidateCount = job.rewriteCandidateOperationIds.length;
      const ruleWords = new Uint32Array(range, output + 8, candidateCount);
      const replacementWords = new Uint32Array(
        range,
        output + 8 + job.rewriteCandidateOperationIds.byteLength,
        candidateCount,
      );
      const proposals = gpuRewriteProposals(
        job.snapshot,
        job.rewriteCandidateOperationIds,
        ruleWords,
        replacementWords,
      );
      const commitStart = performance.now();
      const committed = commitValidatedDucklangCoreRewrites(
        job.cpuValidation.snapshot,
        proposals,
      );
      return {
        status: "completed",
        package: committed.package,
        proposals,
        accepted: committed.accepted,
        validationRecordCount: job.records.length / 4,
        validationDispatchedInvocationCount:
          Math.ceil((job.records.length / 4) / 64) * 64,
        rewriteCandidateCount: candidateCount,
        rewriteDispatchedInvocationCount: Math.ceil(candidateCount / 64) * 64,
        initializationMilliseconds,
        gpuMilliseconds,
        transferMilliseconds,
        commitMilliseconds: performance.now() - commitStart,
        submissionBatchSize: submission.submissionBatchSize,
        payloadBatchSize: jobs.length,
        queueWaitMilliseconds: submission.queueWaitMilliseconds,
      };
    });
  } finally {
    if (mapped) readbackBuffer.unmap();
    buffers.forEach((buffer) => buffer.destroy());
  }
}

function prepareCoreGpuJob(snapshot: FlatDucklangCore): PreparedCoreGpuJob {
  const rewriteCandidateOperationIds: number[] = [];
  for (
    const [operationId, operationKind] of snapshot.operationKinds.entries()
  ) {
    if (operationKind === FlatDucklangCoreKind.operation.scalarBinary) {
      rewriteCandidateOperationIds.push(operationId);
    }
  }
  return {
    snapshot,
    records: gpuValidationRecords(snapshot),
    cpuValidation: validateCoreSnapshotForGpu(snapshot),
    operationColumns: interleaveColumns(
      snapshot.operationKinds,
      snapshot.operationResultValueIds,
      snapshot.operationBlockIds,
      snapshot.operationTypeIds,
    ),
    operationRanges: interleaveColumns(
      snapshot.operationOperandStarts,
      snapshot.operationOperandCounts,
      snapshot.operationAttributeStarts,
      snapshot.operationAttributeCounts,
    ),
    attributes: interleaveColumns(
      snapshot.attributeKinds,
      snapshot.attributeLowWords,
      snapshot.attributeHighWords,
      new Uint32Array(snapshot.attributeKinds.length),
    ),
    values: interleaveColumns(
      snapshot.valueFunctionIds,
      snapshot.valueTypeIds,
      snapshot.valueDefinitionKinds,
      snapshot.valueDefinitionIds,
    ),
    types: interleavePairs(snapshot.typeKinds, snapshot.typeAuxiliaries),
    rewriteCandidateOperationIds: new Uint32Array(
      rewriteCandidateOperationIds,
    ),
  };
}

function validateCoreSnapshotForGpu(
  snapshot: FlatDucklangCore,
): CoreCpuValidation {
  try {
    return {
      status: "valid",
      snapshot: validateFlatDucklangCore(snapshot),
    };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function packCoreColumns(
  columns: readonly Uint32Array[],
  minimumRegionBytes: number,
  alignment: number,
): PackedCoreColumn {
  const regions: { offset: number; size: number }[] = [];
  let byteLength = 0;
  let maximumRegionSize = 0;
  for (const column of columns) {
    byteLength = alignCoreByteLength(byteLength, alignment);
    const size = Math.max(minimumRegionBytes, column.byteLength);
    regions.push({ offset: byteLength, size });
    maximumRegionSize = Math.max(maximumRegionSize, size);
    byteLength += size;
  }
  const words = new Uint32Array(Math.ceil(byteLength / 4));
  for (const [index, column] of columns.entries()) {
    words.set(column, regions[index].offset / 4);
  }
  return { words, regions, maximumRegionSize };
}

function alignCoreByteLength(byteLength: number, alignment: number): number {
  return Math.ceil(byteLength / alignment) * alignment;
}

function createPackedCoreBuffer(
  device: GPUDevice,
  label: string,
  column: PackedCoreColumn,
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

function coreBindGroupEntry(
  binding: number,
  buffer: GPUBuffer,
  region: { readonly offset: number; readonly size: number },
): GPUBindGroupEntry {
  return {
    binding,
    resource: { buffer, offset: region.offset, size: region.size },
  };
}

async function runDucklangCoreWithGpu(
  snapshot: FlatDucklangCore,
  scheduling: CompilerGpuSchedulingPolicy,
): Promise<GpuDucklangCoreResult> {
  const job = prepareCoreGpuJob(snapshot);
  const {
    attributes,
    cpuValidation,
    operationColumns,
    operationRanges,
    records,
    rewriteCandidateOperationIds,
    types,
    values,
  } = job;

  const initializationStart = performance.now();
  const context = await requestGpuCoreContext();
  if (context.status === "unavailable") return context;
  const initializationMilliseconds = performance.now() - initializationStart;
  const { device, validationPipeline, rewritePipeline } = context;
  const outputSize = 8 + rewriteCandidateOperationIds.byteLength * 2;
  const capacityRequests = [
    ["validation records", Math.max(4, records.byteLength), "storage"],
    ["validation errors", 8, "storage"],
    ["validation parameters", 4, "uniform"],
    ["operations", Math.max(4, operationColumns.byteLength), "storage"],
    ["operation ranges", Math.max(4, operationRanges.byteLength), "storage"],
    ["operands", Math.max(4, snapshot.operandValueIds.byteLength), "storage"],
    ["attributes", Math.max(4, attributes.byteLength), "storage"],
    ["values", Math.max(4, values.byteLength), "storage"],
    ["types", Math.max(8, types.byteLength), "storage"],
    [
      "rewrite rules",
      Math.max(4, rewriteCandidateOperationIds.byteLength),
      "storage",
    ],
    [
      "rewrite replacements",
      Math.max(4, rewriteCandidateOperationIds.byteLength),
      "storage",
    ],
    ["rewrite parameters", 24, "uniform"],
    ["readback", Math.max(8, outputSize), "copy"],
  ] as const;
  for (const [label, byteLength, binding] of capacityRequests) {
    const reason = compilerGpuCapacityViolation(device.limits, {
      kind: "buffer",
      label: `Ducklang Core ${label}`,
      byteLength,
      binding,
    });
    if (reason !== undefined) return { status: "unavailable", reason };
  }
  const dispatchRequests: [string, number][] = [
    ["validation", Math.max(1, Math.ceil(records.length / 256))],
  ];
  if (rewriteCandidateOperationIds.length > 0) {
    dispatchRequests.push([
      "rewrite",
      Math.ceil(rewriteCandidateOperationIds.length / 64),
    ]);
  }
  for (const [label, workgroupCount] of dispatchRequests) {
    const reason = compilerGpuCapacityViolation(device.limits, {
      kind: "dispatch",
      label: `Ducklang Core ${label}`,
      workgroupCount,
    });
    if (reason !== undefined) return { status: "unavailable", reason };
  }
  const transferStart = performance.now();
  const recordBuffer = createBuffer(
    device,
    "Ducklang Core validation records",
    records,
    GPUBufferUsage.STORAGE,
  );
  const errorBuffer = createBuffer(
    device,
    "Ducklang Core validation errors",
    new Uint32Array([0, 0xffff_ffff]),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const validationParameters = createBuffer(
    device,
    "Ducklang Core validation parameters",
    new Uint32Array([records.length / 4]),
    GPUBufferUsage.UNIFORM,
  );
  const operationBuffer = createBuffer(
    device,
    "Ducklang Core operations",
    operationColumns,
    GPUBufferUsage.STORAGE,
  );
  const operationRangeBuffer = createBuffer(
    device,
    "Ducklang Core operation ranges",
    operationRanges,
    GPUBufferUsage.STORAGE,
  );
  const operandBuffer = createBuffer(
    device,
    "Ducklang Core operands",
    snapshot.operandValueIds,
    GPUBufferUsage.STORAGE,
  );
  const attributeBuffer = createBuffer(
    device,
    "Ducklang Core attributes",
    attributes,
    GPUBufferUsage.STORAGE,
  );
  const valueBuffer = createBuffer(
    device,
    "Ducklang Core values",
    values,
    GPUBufferUsage.STORAGE,
  );
  const typeBuffer = createBuffer(
    device,
    "Ducklang Core types",
    types,
    GPUBufferUsage.STORAGE,
  );
  const ruleBuffer = createBuffer(
    device,
    "Ducklang Core rewrite rules",
    rewriteCandidateOperationIds,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  const replacementBuffer = createCompilerGpuBuffer(
    device,
    "Ducklang Core rewrite replacements",
    {
      size: Math.max(4, rewriteCandidateOperationIds.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const rewriteParameters = createBuffer(
    device,
    "Ducklang Core rewrite parameters",
    new Uint32Array([
      rewriteCandidateOperationIds.length,
      snapshot.operationKinds.length,
      snapshot.operandValueIds.length,
      snapshot.attributeKinds.length,
      snapshot.valueLocalIds.length,
      snapshot.typeKinds.length,
    ]),
    GPUBufferUsage.UNIFORM,
  );
  const readback = createCompilerGpuBuffer(
    device,
    "Ducklang Core readback",
    {
      size: Math.max(8, outputSize),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const transferMilliseconds = performance.now() - transferStart;
  const buffers = [
    recordBuffer,
    errorBuffer,
    validationParameters,
    operationBuffer,
    operationRangeBuffer,
    operandBuffer,
    attributeBuffer,
    valueBuffer,
    typeBuffer,
    ruleBuffer,
    replacementBuffer,
    rewriteParameters,
    readback,
  ];
  let mapped = false;
  try {
    const encoder = device.createCommandEncoder();
    const validationBindGroup = device.createBindGroup({
      layout: validationPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: recordBuffer } },
        { binding: 1, resource: { buffer: errorBuffer } },
        { binding: 2, resource: { buffer: validationParameters } },
      ],
    });
    const validationPass = encoder.beginComputePass();
    validationPass.setPipeline(validationPipeline);
    validationPass.setBindGroup(0, validationBindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      validationPass,
      "Ducklang Core validation",
      Math.max(1, Math.ceil(records.length / 256)),
    );
    validationPass.end();

    if (rewriteCandidateOperationIds.length > 0) {
      const rewriteBindGroup = device.createBindGroup({
        layout: rewritePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: operationBuffer } },
          { binding: 1, resource: { buffer: operationRangeBuffer } },
          { binding: 2, resource: { buffer: operandBuffer } },
          { binding: 3, resource: { buffer: attributeBuffer } },
          { binding: 4, resource: { buffer: valueBuffer } },
          { binding: 5, resource: { buffer: typeBuffer } },
          { binding: 6, resource: { buffer: ruleBuffer } },
          { binding: 7, resource: { buffer: replacementBuffer } },
          { binding: 8, resource: { buffer: rewriteParameters } },
        ],
      });
      const rewritePass = encoder.beginComputePass();
      rewritePass.setPipeline(rewritePipeline);
      rewritePass.setBindGroup(0, rewriteBindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        rewritePass,
        "Ducklang Core rewrite",
        Math.ceil(rewriteCandidateOperationIds.length / 64),
      );
      rewritePass.end();
    }
    encoder.copyBufferToBuffer(errorBuffer, 0, readback, 0, 8);
    if (rewriteCandidateOperationIds.byteLength > 0) {
      encoder.copyBufferToBuffer(
        ruleBuffer,
        0,
        readback,
        8,
        rewriteCandidateOperationIds.byteLength,
      );
      encoder.copyBufferToBuffer(
        replacementBuffer,
        0,
        readback,
        8 + rewriteCandidateOperationIds.byteLength,
        rewriteCandidateOperationIds.byteLength,
      );
    }
    const gpuStart = performance.now();
    const submission = await submitCompilerGpuCommand(
      device,
      "Ducklang Core pass",
      encoder.finish(),
      scheduling,
    );
    await awaitCompilerGpuCommand(
      device,
      "Ducklang Core pass",
      readback.mapAsync(GPUMapMode.READ),
    );
    mapped = true;
    const gpuMilliseconds = performance.now() - gpuStart;
    const range = readback.getMappedRange();
    const errorWords = new Uint32Array(range, 0, 2);
    const gpuValid = errorWords[0] === 0;
    const cpuValid = cpuValidation.status === "valid";
    if (gpuValid !== cpuValid) {
      const cpuDescription = cpuValidation.status === "valid"
        ? "accepted"
        : `rejected ${cpuValidation.reason}`;
      throw new Error(
        `CPU and GPU flat Core validation disagree: CPU ${cpuDescription}; GPU found ${
          errorWords[0]
        } invalid records, first ${errorWords[1]}`,
      );
    }
    if (cpuValidation.status === "invalid") {
      return {
        status: "invalid",
        reason: cpuValidation.reason,
        validationRecordCount: records.length / 4,
      };
    }

    const ruleWords = new Uint32Array(
      range,
      8,
      rewriteCandidateOperationIds.length,
    );
    const replacementWords = new Uint32Array(
      range,
      8 + rewriteCandidateOperationIds.byteLength,
      rewriteCandidateOperationIds.length,
    );
    const gpuProposals = gpuRewriteProposals(
      snapshot,
      rewriteCandidateOperationIds,
      ruleWords,
      replacementWords,
    );
    const commitStart = performance.now();
    const committed = commitValidatedDucklangCoreRewrites(
      cpuValidation.snapshot,
      gpuProposals,
    );
    const commitMilliseconds = performance.now() - commitStart;
    return {
      status: "completed",
      package: committed.package,
      proposals: gpuProposals,
      accepted: committed.accepted,
      validationRecordCount: records.length / 4,
      validationDispatchedInvocationCount:
        Math.ceil((records.length / 4) / 64) * 64,
      rewriteCandidateCount: rewriteCandidateOperationIds.length,
      rewriteDispatchedInvocationCount:
        Math.ceil(rewriteCandidateOperationIds.length / 64) * 64,
      initializationMilliseconds,
      gpuMilliseconds,
      transferMilliseconds,
      commitMilliseconds,
      submissionBatchSize: submission.submissionBatchSize,
      payloadBatchSize: 1,
      queueWaitMilliseconds: submission.queueWaitMilliseconds,
    };
  } catch (error) {
    const reason = compilerGpuUnavailabilityReason(
      "Ducklang Core pass",
      error,
    );
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  } finally {
    if (mapped) readback.unmap();
    buffers.forEach((buffer) => buffer.destroy());
  }
}

function gpuRewriteProposals(
  snapshot: FlatDucklangCore,
  candidateOperationIds: Uint32Array,
  rules: Uint32Array,
  replacements: Uint32Array,
): readonly DucklangCoreRewriteProposal[] {
  return Array.from(rules.entries()).flatMap(([candidateId, ruleId]) => {
    if (ruleId === 0) return [];
    const operationId = candidateOperationIds[candidateId];
    const rule = ruleId === 1
      ? "addZero"
      : ruleId === 2
      ? "multiplyOne"
      : undefined;
    if (rule === undefined) {
      throw new TypeError(
        `GPU proposed unknown Ducklang Core rewrite rule ${ruleId} at operation ${operationId}`,
      );
    }
    const blockId = snapshot.operationBlockIds[operationId];
    return [{
      rule,
      functionId: snapshot.blockFunctionIds[blockId],
      operationId,
      resultValueId: snapshot.operationResultValueIds[operationId],
      replacementValueId: replacements[candidateId],
      profit: 1,
    }];
  });
}

function gpuValidationRecords(package_: FlatDucklangCore): Uint32Array {
  const words: number[] = [];
  const lessThan = (value: number, limit: number): void => {
    words.push(0, value, limit, 0);
  };
  const equal = (left: number, right: number): void => {
    words.push(1, left, right, 0);
  };
  const range = (start: number, count: number, limit: number): void => {
    words.push(2, start, count, limit);
  };
  equal(package_.schemaVersion, 1);
  lessThan(package_.moduleFileId, package_.stringStarts.length);
  lessThan(package_.entryFunctionId, package_.functionNameIds.length);

  const equalColumnLengths = (...columns: readonly ArrayLike<unknown>[]) => {
    for (const column of columns.slice(1)) {
      equal(columns[0].length, column.length);
    }
  };
  equalColumnLengths(
    package_.stringStarts,
    package_.stringLengths,
  );
  equalColumnLengths(
    package_.sourceLocationFileIds,
    package_.sourceLocationStarts,
    package_.sourceLocationEnds,
  );
  equalColumnLengths(
    package_.typeKinds,
    package_.typePayloadStarts,
    package_.typePayloadCounts,
    package_.typeAuxiliaries,
    package_.typeLayoutIds,
  );
  equalColumnLengths(
    package_.signatureParameterStarts,
    package_.signatureParameterCounts,
    package_.signatureResultTypeIds,
  );
  equalColumnLengths(
    package_.functionNameIds,
    package_.functionSourceSymbolIds,
    package_.functionSignatureIds,
    package_.functionEntryBlockIds,
    package_.functionBlockStarts,
    package_.functionBlockCounts,
    package_.functionSourceLocationIds,
  );
  equalColumnLengths(
    package_.blockFunctionIds,
    package_.blockLocalIds,
    package_.blockParameterStarts,
    package_.blockParameterCounts,
    package_.blockOperationStarts,
    package_.blockOperationCounts,
    package_.blockTerminatorIds,
  );
  equalColumnLengths(
    package_.valueFunctionIds,
    package_.valueLocalIds,
    package_.valueTypeIds,
    package_.valueDefinitionKinds,
    package_.valueDefinitionIds,
  );
  equalColumnLengths(
    package_.operationBlockIds,
    package_.operationKinds,
    package_.operationResultValueIds,
    package_.operationTypeIds,
    package_.operationOperandStarts,
    package_.operationOperandCounts,
    package_.operationAttributeStarts,
    package_.operationAttributeCounts,
    package_.operationSourceLocationIds,
  );
  equalColumnLengths(
    package_.attributeKinds,
    package_.attributeLowWords,
    package_.attributeHighWords,
  );
  equalColumnLengths(
    package_.terminatorBlockIds,
    package_.terminatorKinds,
    package_.terminatorConditionValueIds,
    package_.terminatorEdgeStarts,
    package_.terminatorEdgeCounts,
    package_.terminatorReturnStarts,
    package_.terminatorReturnCounts,
    package_.terminatorSourceLocationIds,
  );
  equalColumnLengths(
    package_.edgeTargetBlockIds,
    package_.edgeArgumentStarts,
    package_.edgeArgumentCounts,
    package_.edgeSourceLocationIds,
  );
  equalColumnLengths(
    package_.layoutKinds,
    package_.layoutSizes,
    package_.layoutAlignments,
    package_.layoutComponentStarts,
    package_.layoutComponentCounts,
    package_.layoutTagOffsets,
    package_.layoutTagSizes,
    package_.layoutPayloadOffsets,
  );

  for (
    let index = 0;
    index < package_.sourceLocationFileIds.length;
    index += 1
  ) {
    lessThan(
      package_.sourceLocationFileIds[index],
      package_.stringStarts.length,
    );
    range(
      package_.sourceLocationStarts[index],
      package_.sourceLocationEnds[index] - package_.sourceLocationStarts[index],
      0xffff_ffff,
    );
  }
  addIdRecords(words, package_.typeKinds, 5);
  addRangeRecords(
    words,
    package_.stringStarts,
    package_.stringLengths,
    package_.stringBytes.length,
  );
  addRangeRecords(
    words,
    package_.typePayloadStarts,
    package_.typePayloadCounts,
    package_.typePayloads.length,
  );
  addIdRecords(words, package_.typePayloads, package_.typeKinds.length);
  addRangeRecords(
    words,
    package_.signatureParameterStarts,
    package_.signatureParameterCounts,
    package_.signatureParameterTypeIds.length,
  );
  addIdRecords(
    words,
    package_.signatureParameterTypeIds,
    package_.typeKinds.length,
  );
  addIdRecords(
    words,
    package_.signatureResultTypeIds,
    package_.typeKinds.length,
  );
  addIdRecords(words, package_.functionNameIds, package_.stringStarts.length);
  addIdRecords(
    words,
    package_.functionSignatureIds,
    package_.signatureResultTypeIds.length,
  );
  addIdRecords(
    words,
    package_.functionSourceLocationIds,
    package_.sourceLocationFileIds.length,
  );
  addRangeRecords(
    words,
    package_.functionBlockStarts,
    package_.functionBlockCounts,
    package_.blockFunctionIds.length,
  );
  addIdRecords(
    words,
    package_.functionEntryBlockIds,
    package_.blockFunctionIds.length,
  );
  addIdRecords(
    words,
    package_.blockFunctionIds,
    package_.functionNameIds.length,
  );
  addRangeRecords(
    words,
    package_.blockParameterStarts,
    package_.blockParameterCounts,
    package_.blockParameterValueIds.length,
  );
  addRangeRecords(
    words,
    package_.blockOperationStarts,
    package_.blockOperationCounts,
    package_.operationKinds.length,
  );
  addIdRecords(
    words,
    package_.blockTerminatorIds,
    package_.terminatorKinds.length,
  );
  addIdRecords(
    words,
    package_.blockParameterValueIds,
    package_.valueLocalIds.length,
  );
  addIdRecords(
    words,
    package_.blockParameterTypeIds,
    package_.typeKinds.length,
  );
  addIdRecords(
    words,
    package_.blockParameterSourceLocationIds,
    package_.sourceLocationFileIds.length,
  );
  addIdRecords(
    words,
    package_.valueFunctionIds,
    package_.functionNameIds.length,
  );
  addIdRecords(words, package_.valueTypeIds, package_.typeKinds.length);
  addIdRecords(
    words,
    package_.operationBlockIds,
    package_.blockFunctionIds.length,
  );
  addIdRecords(words, package_.operationKinds, 20);
  addIdRecords(
    words,
    package_.operationResultValueIds,
    package_.valueLocalIds.length,
  );
  addIdRecords(words, package_.operationTypeIds, package_.typeKinds.length);
  addRangeRecords(
    words,
    package_.operationOperandStarts,
    package_.operationOperandCounts,
    package_.operandValueIds.length,
  );
  addRangeRecords(
    words,
    package_.operationAttributeStarts,
    package_.operationAttributeCounts,
    package_.attributeKinds.length,
  );
  addIdRecords(
    words,
    package_.operationSourceLocationIds,
    package_.sourceLocationFileIds.length,
  );
  addIdRecords(words, package_.operandValueIds, package_.valueLocalIds.length);
  addIdRecords(words, package_.attributeKinds, 6);
  addIdRecords(
    words,
    package_.terminatorBlockIds,
    package_.blockFunctionIds.length,
  );
  addIdRecords(words, package_.terminatorKinds, 4);
  addRangeRecords(
    words,
    package_.terminatorEdgeStarts,
    package_.terminatorEdgeCounts,
    package_.edgeTargetBlockIds.length,
  );
  addRangeRecords(
    words,
    package_.terminatorReturnStarts,
    package_.terminatorReturnCounts,
    package_.returnValueIds.length,
  );
  addIdRecords(
    words,
    package_.terminatorSourceLocationIds,
    package_.sourceLocationFileIds.length,
  );
  addIdRecords(words, package_.returnValueIds, package_.valueLocalIds.length);
  addIdRecords(
    words,
    package_.edgeTargetBlockIds,
    package_.blockFunctionIds.length,
  );
  addRangeRecords(
    words,
    package_.edgeArgumentStarts,
    package_.edgeArgumentCounts,
    package_.edgeArgumentValueIds.length,
  );
  addIdRecords(
    words,
    package_.edgeSourceLocationIds,
    package_.sourceLocationFileIds.length,
  );
  addIdRecords(
    words,
    package_.edgeArgumentValueIds,
    package_.valueLocalIds.length,
  );
  addIdRecords(words, package_.layoutKinds, 4);
  addRangeRecords(
    words,
    package_.layoutComponentStarts,
    package_.layoutComponentCounts,
    package_.layoutComponentIds.length,
  );
  addIdRecords(words, package_.layoutComponentIds, package_.layoutKinds.length);
  addIdRecords(words, package_.typeLayoutIds, package_.layoutKinds.length);
  return new Uint32Array(words);
}

function addIdRecords(
  words: number[],
  ids: Uint32Array,
  limit: number,
): void {
  for (const id of ids) words.push(0, id, limit, 0);
}

function addRangeRecords(
  words: number[],
  starts: Uint32Array,
  counts: Uint32Array,
  limit: number,
): void {
  const length = Math.min(starts.length, counts.length);
  let expectedStart = 0;
  for (let index = 0; index < length; index += 1) {
    words.push(1, starts[index], expectedStart, 0);
    words.push(2, starts[index], counts[index], limit);
    expectedStart += counts[index];
  }
  words.push(1, expectedStart, limit, 0);
}

function interleaveColumns(
  first: Uint32Array,
  second: Uint32Array,
  third: Uint32Array,
  fourth: Uint32Array,
): Uint32Array {
  const length = Math.max(
    first.length,
    second.length,
    third.length,
    fourth.length,
  );
  const words = new Uint32Array(length * 4);
  for (let index = 0; index < length; index += 1) {
    words[index * 4] = first[index] ?? 0;
    words[index * 4 + 1] = second[index] ?? 0;
    words[index * 4 + 2] = third[index] ?? 0;
    words[index * 4 + 3] = fourth[index] ?? 0;
  }
  return words;
}

function interleavePairs(
  first: Uint32Array,
  second: Uint32Array,
): Uint32Array {
  const length = Math.max(first.length, second.length);
  const words = new Uint32Array(length * 2);
  for (let index = 0; index < length; index += 1) {
    words[index * 2] = first[index] ?? 0;
    words[index * 2 + 1] = second[index] ?? 0;
  }
  return words;
}

async function requestGpuCoreContext(): Promise<GpuCoreContext> {
  if (contextPromise !== undefined) return await contextPromise;
  const pending = (async (): Promise<GpuCoreContext> => {
    const deviceRequest = await requestCompilerGpuDevice();
    if (deviceRequest.status === "unavailable") return deviceRequest;
    const device = deviceRequest.device;
    try {
      requireCompilerGpuCapacity(device, {
        kind: "pipelineBindings",
        label: "Ducklang Core validation",
        storageBufferCount: 2,
        uniformBufferCount: 1,
      });
      requireCompilerGpuCapacity(device, {
        kind: "pipelineBindings",
        label: "Ducklang Core rewrite",
        storageBufferCount: 8,
        uniformBufferCount: 1,
      });
      const validationModule = device.createShaderModule({
        code: validationShader,
      });
      const rewriteModule = device.createShaderModule({ code: rewriteShader });
      const errors = (await Promise.all([
        validationModule.getCompilationInfo(),
        rewriteModule.getCompilationInfo(),
      ])).flatMap((info) =>
        info.messages.filter((message) => message.type === "error")
      );
      if (errors.length > 0) {
        throw new Error(errors.map((error) => error.message).join("; "));
      }
      const [validationPipeline, rewritePipeline] = await Promise.all([
        device.createComputePipelineAsync({
          layout: "auto",
          compute: {
            module: validationModule,
            entryPoint: "validate_records",
          },
        }),
        device.createComputePipelineAsync({
          layout: "auto",
          compute: {
            module: rewriteModule,
            entryPoint: "propose_rewrites",
          },
        }),
      ]);
      return {
        status: "available",
        device,
        validationPipeline,
        rewritePipeline,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: `WebGPU Ducklang Core initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  })();
  contextPromise = pending;
  void pending.then((context) => {
    if (context.status === "unavailable") {
      if (contextPromise === pending) contextPromise = undefined;
      return;
    }
    void context.device.lost.then(() => {
      if (contextPromise === pending) contextPromise = undefined;
    });
  });
  return await pending;
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

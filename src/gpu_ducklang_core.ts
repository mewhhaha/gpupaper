import {
  commitTrustedDucklangCoreRewrites,
  type DucklangCoreRewriteProposal,
} from "./ducklang_core_rewrite.ts";
import {
  type FlatDucklangCore,
  FlatDucklangCoreKind,
  type TrustedFlatDucklangCore,
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
    readonly backend: "gpu" | "identity";
    readonly inputProvenance: "construction" | "validation";
    readonly package: FlatDucklangCore;
    readonly proposals: readonly DucklangCoreRewriteProposal[];
    readonly accepted: readonly DucklangCoreRewriteProposal[];
    readonly rewriteCandidateCount: number;
    readonly candidateDescriptorBytes: number;
    readonly logicalDeviceBufferBytes: number;
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
  }
  | {
    readonly status: "unavailable";
    readonly reason: string;
  };

type GpuCoreContext =
  | {
    readonly status: "available";
    readonly device: GPUDevice;
    readonly rewritePipeline: GPUComputePipeline;
  }
  | { readonly status: "unavailable"; readonly reason: string };

const rewriteShader = `
struct ConstantDescriptor {
  value_id: u32,
  definition_kind: u32,
  operation_kind: u32,
  attribute_count: u32,
  attribute_kind: u32,
  attribute_low: u32,
  attribute_high: u32,
}
struct CandidateDescriptor {
  operand_count: u32,
  attribute_count: u32,
  operator_kind: u32,
  operator_value: u32,
  result_type_kind: u32,
  result_scalar: u32,
  left: ConstantDescriptor,
  right: ConstantDescriptor,
}
struct Parameters {
  candidate_count: u32,
}
@group(0) @binding(0) var<storage, read> candidates: array<CandidateDescriptor>;
@group(0) @binding(1) var<storage, read_write> rules: array<u32>;
@group(0) @binding(2) var<storage, read_write> replacements: array<u32>;
@group(0) @binding(3) var<uniform> parameters: Parameters;

fn constant_equals(value: ConstantDescriptor, expected_high: u32) -> bool {
  if (
    value.definition_kind !=
      ${FlatDucklangCoreKind.valueDefinition.operation}u
  ) {
    return false;
  }
  if (
    value.operation_kind != ${FlatDucklangCoreKind.operation.constant}u ||
    value.attribute_count != 1u
  ) {
    return false;
  }
  return
    value.attribute_kind == ${FlatDucklangCoreKind.attribute.number}u &&
    value.attribute_low == 0u &&
    value.attribute_high == expected_high;
}

@compute @workgroup_size(64)
fn propose_rewrites(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let candidate_id = invocation.x;
  if (candidate_id >= parameters.candidate_count) { return; }
  rules[candidate_id] = 0u;
  replacements[candidate_id] = 0xffffffffu;
  let candidate = candidates[candidate_id];
  if (
    candidate.operand_count != 2u ||
    candidate.attribute_count != 1u ||
    candidate.result_type_kind != ${FlatDucklangCoreKind.type.scalar}u ||
    (
      candidate.result_scalar != ${FlatDucklangCoreKind.scalar.i32}u &&
      candidate.result_scalar != ${FlatDucklangCoreKind.scalar.i64}u
    )
  ) {
    return;
  }
  if (
    candidate.operator_kind !=
      ${FlatDucklangCoreKind.attribute.unsigned}u
  ) {
    return;
  }
  if (
    candidate.operator_value ==
      ${FlatDucklangCoreKind.binaryOperator.add}u
  ) {
    if (constant_equals(candidate.right, 0u)) {
      rules[candidate_id] = 1u;
      replacements[candidate_id] = candidate.left.value_id;
    } else if (constant_equals(candidate.left, 0u)) {
      rules[candidate_id] = 1u;
      replacements[candidate_id] = candidate.right.value_id;
    }
  } else if (
    candidate.operator_value ==
      ${FlatDucklangCoreKind.binaryOperator.multiply}u
  ) {
    if (constant_equals(candidate.right, 0x3ff00000u)) {
      rules[candidate_id] = 2u;
      replacements[candidate_id] = candidate.left.value_id;
    } else if (constant_equals(candidate.left, 0x3ff00000u)) {
      rules[candidate_id] = 2u;
      replacements[candidate_id] = candidate.right.value_id;
    }
  }
}
`;

let contextPromise: Promise<GpuCoreContext> | undefined;
type CoreGpuInput =
  | {
    readonly kind: "raw";
    readonly package: FlatDucklangCore;
  }
  | {
    readonly kind: "trusted";
    readonly snapshot: TrustedFlatDucklangCore;
  };

const coreBatchQueue = createCompilerGpuBatchQueue(
  (inputs: readonly CoreGpuInput[]) =>
    inputs.length === 1
      ? Promise.all(
        inputs.map((input) => runDucklangCoreWithGpu(input, "latency")),
      )
      : runDucklangCoreGpuBatch(inputs),
);

export async function runDucklangCoreGpuPass(
  snapshot: FlatDucklangCore,
  options: {
    readonly scheduling?: CompilerGpuSchedulingPolicy;
  } = {},
): Promise<GpuDucklangCoreResult> {
  return await enqueueDucklangCoreGpuPass(
    { kind: "raw", package: snapshot },
    options.scheduling ?? "latency",
  );
}

export async function runTrustedDucklangCoreGpuPass(
  snapshot: TrustedFlatDucklangCore,
  options: {
    readonly scheduling?: CompilerGpuSchedulingPolicy;
  } = {},
): Promise<GpuDucklangCoreResult> {
  return await enqueueDucklangCoreGpuPass(
    { kind: "trusted", snapshot },
    options.scheduling ?? "latency",
  );
}

async function enqueueDucklangCoreGpuPass(
  input: CoreGpuInput,
  scheduling: CompilerGpuSchedulingPolicy,
): Promise<GpuDucklangCoreResult> {
  try {
    const batch = await coreBatchQueue.enqueue(
      input,
      scheduling,
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
    readonly snapshot: TrustedFlatDucklangCore;
  }
  | { readonly status: "invalid"; readonly reason: string };

type PreparedCoreJob =
  | {
    readonly status: "invalid";
    readonly reason: string;
  }
  | {
    readonly status: "identity";
    readonly snapshot: TrustedFlatDucklangCore;
  }
  | {
    readonly status: "rewrite";
    readonly snapshot: TrustedFlatDucklangCore;
    readonly candidateDescriptors: Uint32Array;
    readonly rewriteCandidateOperationIds: Uint32Array;
  };

type PreparedCoreRewriteJob = Extract<
  PreparedCoreJob,
  { readonly status: "rewrite" }
>;

type PackedCoreColumn = {
  readonly words: Uint32Array;
  readonly regions: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly maximumRegionSize: number;
};

async function runDucklangCoreGpuBatch(
  inputs: readonly CoreGpuInput[],
): Promise<readonly GpuDucklangCoreResult[]> {
  try {
    return await runPackedDucklangCoreGpuBatch(inputs);
  } catch (error) {
    if (error instanceof CompilerGpuCapacityError && inputs.length > 1) {
      const split = Math.ceil(inputs.length / 2);
      const [left, right] = await Promise.all([
        runDucklangCoreGpuBatch(inputs.slice(0, split)),
        runDucklangCoreGpuBatch(inputs.slice(split)),
      ]);
      return [...left, ...right];
    }
    throw error;
  }
}

async function runPackedDucklangCoreGpuBatch(
  inputs: readonly CoreGpuInput[],
): Promise<readonly GpuDucklangCoreResult[]> {
  const jobs = inputs.map(prepareCoreJob);
  if (jobs.some((job) => job.status === "invalid")) {
    return await Promise.all(
      jobs.map((job) =>
        job.status === "invalid"
          ? {
            status: "invalid" as const,
            reason: job.reason,
          }
          : job.status === "identity"
          ? completeEmptyCoreRewriteFrontier(job.snapshot)
          : runDucklangCoreWithGpu(
            { kind: "trusted", snapshot: job.snapshot },
            "latency",
          )
      ),
    );
  }
  const rewriteJobs = jobs.filter(
    (job): job is PreparedCoreRewriteJob => job.status === "rewrite",
  );
  if (rewriteJobs.length !== jobs.length) {
    const rewriteResults = rewriteJobs.length === 0
      ? []
      : rewriteJobs.length === 1
      ? [
        await runDucklangCoreWithGpu(
          { kind: "trusted", snapshot: rewriteJobs[0].snapshot },
          "latency",
        ),
      ]
      : await runDucklangCoreGpuBatch(
        rewriteJobs.map((job) => ({
          kind: "trusted" as const,
          snapshot: job.snapshot,
        })),
      );
    let rewriteResultIndex = 0;
    return jobs.map((job, index) => {
      if (job.status === "rewrite") {
        const result = rewriteResults[rewriteResultIndex];
        rewriteResultIndex += 1;
        if (result === undefined) {
          throw new Error(
            `Ducklang Core batch omitted rewrite result for job ${index}`,
          );
        }
        return result;
      }
      if (job.status !== "identity") {
        throw new Error(
          `Ducklang Core batch identity job ${index} has status ${job.status}`,
        );
      }
      return completeEmptyCoreRewriteFrontier(job.snapshot);
    });
  }
  const gpuJobs = rewriteJobs;
  const initializationStart = performance.now();
  const context = await requestGpuCoreContext();
  if (context.status === "unavailable") {
    return inputs.map(() => context);
  }
  const initializationMilliseconds = performance.now() - initializationStart;
  const { device, rewritePipeline } = context;
  const storageAlignment = device.limits.minStorageBufferOffsetAlignment;
  const uniformAlignment = device.limits.minUniformBufferOffsetAlignment;
  const candidateDescriptors = packCoreColumns(
    gpuJobs.map((job) => job.candidateDescriptors),
    80,
    storageAlignment,
  );
  const rules = packCoreColumns(
    gpuJobs.map((job) =>
      new Uint32Array(job.rewriteCandidateOperationIds.length)
    ),
    4,
    storageAlignment,
  );
  const replacements = packCoreColumns(
    gpuJobs.map((job) =>
      new Uint32Array(job.rewriteCandidateOperationIds.length)
    ),
    4,
    storageAlignment,
  );
  const rewriteParameters = packCoreColumns(
    gpuJobs.map((job) =>
      new Uint32Array([job.rewriteCandidateOperationIds.length])
    ),
    4,
    uniformAlignment,
  );
  const readback = packCoreColumns(
    gpuJobs.map((job) =>
      new Uint32Array(job.rewriteCandidateOperationIds.length * 2)
    ),
    8,
    4,
  );

  const transferStart = performance.now();
  const candidateDescriptorBuffer = createPackedCoreBuffer(
    device,
    "Ducklang Core batch candidate descriptors",
    candidateDescriptors,
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
    candidateDescriptorBuffer,
    ruleBuffer,
    replacementBuffer,
    rewriteParameterBuffer,
    readbackBuffer,
  ];
  let mapped = false;
  try {
    const encoder = device.createCommandEncoder();
    const rewritePass = encoder.beginComputePass();
    rewritePass.setPipeline(rewritePipeline);
    for (const [index, job] of gpuJobs.entries()) {
      rewritePass.setBindGroup(
        0,
        device.createBindGroup({
          layout: rewritePipeline.getBindGroupLayout(0),
          entries: [
            coreBindGroupEntry(
              0,
              candidateDescriptorBuffer,
              candidateDescriptors.regions[index],
            ),
            coreBindGroupEntry(1, ruleBuffer, rules.regions[index]),
            coreBindGroupEntry(
              2,
              replacementBuffer,
              replacements.regions[index],
            ),
            coreBindGroupEntry(
              3,
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

    for (const [index, job] of gpuJobs.entries()) {
      const output = readback.regions[index].offset;
      encoder.copyBufferToBuffer(
        ruleBuffer,
        rules.regions[index].offset,
        readbackBuffer,
        output,
        job.rewriteCandidateOperationIds.byteLength,
      );
      encoder.copyBufferToBuffer(
        replacementBuffer,
        replacements.regions[index].offset,
        readbackBuffer,
        output + job.rewriteCandidateOperationIds.byteLength,
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
    return gpuJobs.map((job, index) => {
      const output = readback.regions[index].offset;
      const candidateCount = job.rewriteCandidateOperationIds.length;
      const ruleWords = new Uint32Array(range, output, candidateCount);
      const replacementWords = new Uint32Array(
        range,
        output + job.rewriteCandidateOperationIds.byteLength,
        candidateCount,
      );
      const proposals = gpuRewriteProposals(
        job.snapshot.package,
        job.rewriteCandidateOperationIds,
        ruleWords,
        replacementWords,
      );
      const commitStart = performance.now();
      const committed = commitTrustedDucklangCoreRewrites(
        job.snapshot,
        proposals,
      );
      return {
        status: "completed",
        backend: "gpu",
        inputProvenance: job.snapshot.provenance,
        package: committed.package,
        proposals,
        accepted: committed.accepted,
        rewriteCandidateCount: candidateCount,
        candidateDescriptorBytes: job.candidateDescriptors.byteLength,
        logicalDeviceBufferBytes: candidateCount * 96 + 4,
        rewriteDispatchedInvocationCount: Math.ceil(candidateCount / 64) * 64,
        initializationMilliseconds,
        gpuMilliseconds,
        transferMilliseconds,
        commitMilliseconds: performance.now() - commitStart,
        submissionBatchSize: submission.submissionBatchSize,
        payloadBatchSize: gpuJobs.length,
        queueWaitMilliseconds: submission.queueWaitMilliseconds,
      };
    });
  } finally {
    if (mapped) readbackBuffer.unmap();
    buffers.forEach((buffer) => buffer.destroy());
  }
}

function prepareCoreJob(input: CoreGpuInput): PreparedCoreJob {
  const cpuValidation = input.kind === "trusted"
    ? { status: "valid" as const, snapshot: input.snapshot }
    : validateCoreSnapshotForGpu(input.package);
  if (cpuValidation.status === "invalid") {
    return { status: "invalid", reason: cpuValidation.reason };
  }
  const snapshot = cpuValidation.snapshot.package;
  const rewriteCandidateOperationIds: number[] = [];
  // This is the common structural head of every shader rule. A new rule must
  // widen this necessary condition; exact constants remain a GPU decision.
  for (
    const [operationId, operationKind] of snapshot.operationKinds.entries()
  ) {
    if (operationKind !== FlatDucklangCoreKind.operation.scalarBinary) continue;
    if (snapshot.operationOperandCounts[operationId] !== 2) continue;
    if (snapshot.operationAttributeCounts[operationId] !== 1) continue;

    const attributeId = snapshot.operationAttributeStarts[operationId];
    if (
      snapshot.attributeKinds[attributeId] !==
        FlatDucklangCoreKind.attribute.unsigned
    ) continue;
    const operator = snapshot.attributeLowWords[attributeId];
    if (
      operator !== FlatDucklangCoreKind.binaryOperator.add &&
      operator !== FlatDucklangCoreKind.binaryOperator.multiply
    ) continue;

    const typeId = snapshot.operationTypeIds[operationId];
    if (snapshot.typeKinds[typeId] !== FlatDucklangCoreKind.type.scalar) {
      continue;
    }
    const scalar = snapshot.typeAuxiliaries[typeId];
    if (
      scalar !== FlatDucklangCoreKind.scalar.i32 &&
      scalar !== FlatDucklangCoreKind.scalar.i64
    ) continue;

    const operandStart = snapshot.operationOperandStarts[operationId];
    const leftValueId = snapshot.operandValueIds[operandStart];
    const rightValueId = snapshot.operandValueIds[operandStart + 1];
    const leftIsConstant = snapshot.valueDefinitionKinds[leftValueId] ===
        FlatDucklangCoreKind.valueDefinition.operation &&
      snapshot.operationKinds[snapshot.valueDefinitionIds[leftValueId]] ===
        FlatDucklangCoreKind.operation.constant;
    const rightIsConstant = snapshot.valueDefinitionKinds[rightValueId] ===
        FlatDucklangCoreKind.valueDefinition.operation &&
      snapshot.operationKinds[snapshot.valueDefinitionIds[rightValueId]] ===
        FlatDucklangCoreKind.operation.constant;
    if (!leftIsConstant && !rightIsConstant) continue;

    rewriteCandidateOperationIds.push(operationId);
  }
  if (rewriteCandidateOperationIds.length === 0) {
    return { status: "identity", snapshot: cpuValidation.snapshot };
  }
  return {
    status: "rewrite",
    snapshot: cpuValidation.snapshot,
    candidateDescriptors: coreRewriteCandidateDescriptors(
      snapshot,
      rewriteCandidateOperationIds,
    ),
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

function coreRewriteCandidateDescriptors(
  snapshot: FlatDucklangCore,
  candidateOperationIds: readonly number[],
): Uint32Array {
  const descriptorWordCount = 20;
  const constantWordCount = 7;
  const words = new Uint32Array(
    candidateOperationIds.length * descriptorWordCount,
  );
  const writeConstant = (
    valueId: number | undefined,
    wordOffset: number,
  ): void => {
    if (valueId === undefined) {
      words[wordOffset] = 0xffff_ffff;
      return;
    }
    words[wordOffset] = valueId;
    const definitionKind = snapshot.valueDefinitionKinds[valueId];
    words[wordOffset + 1] = definitionKind;
    if (
      definitionKind !== FlatDucklangCoreKind.valueDefinition.operation
    ) return;
    const operationId = snapshot.valueDefinitionIds[valueId];
    words[wordOffset + 2] = snapshot.operationKinds[operationId];
    const attributeCount = snapshot.operationAttributeCounts[operationId];
    words[wordOffset + 3] = attributeCount;
    if (attributeCount === 0) return;
    const attributeId = snapshot.operationAttributeStarts[operationId];
    words[wordOffset + 4] = snapshot.attributeKinds[attributeId];
    words[wordOffset + 5] = snapshot.attributeLowWords[attributeId];
    words[wordOffset + 6] = snapshot.attributeHighWords[attributeId];
  };

  for (
    let candidateId = 0;
    candidateId < candidateOperationIds.length;
    candidateId += 1
  ) {
    const operationId = candidateOperationIds[candidateId];
    const wordOffset = candidateId * descriptorWordCount;
    const operandCount = snapshot.operationOperandCounts[operationId];
    const attributeCount = snapshot.operationAttributeCounts[operationId];
    words[wordOffset] = operandCount;
    words[wordOffset + 1] = attributeCount;
    if (attributeCount > 0) {
      const attributeId = snapshot.operationAttributeStarts[operationId];
      words[wordOffset + 2] = snapshot.attributeKinds[attributeId];
      words[wordOffset + 3] = snapshot.attributeLowWords[attributeId];
    }
    const typeId = snapshot.operationTypeIds[operationId];
    words[wordOffset + 4] = snapshot.typeKinds[typeId];
    words[wordOffset + 5] = snapshot.typeAuxiliaries[typeId];
    const operandStart = snapshot.operationOperandStarts[operationId];
    writeConstant(
      operandCount > 0 ? snapshot.operandValueIds[operandStart] : undefined,
      wordOffset + 6,
    );
    writeConstant(
      operandCount > 1 ? snapshot.operandValueIds[operandStart + 1] : undefined,
      wordOffset + 6 + constantWordCount,
    );
  }
  return words;
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
  input: CoreGpuInput,
  scheduling: CompilerGpuSchedulingPolicy,
): Promise<GpuDucklangCoreResult> {
  const job = prepareCoreJob(input);
  if (job.status === "invalid") {
    return { status: "invalid", reason: job.reason };
  }
  if (job.status === "identity") {
    return completeEmptyCoreRewriteFrontier(job.snapshot);
  }
  const {
    candidateDescriptors,
    rewriteCandidateOperationIds,
  } = job;
  const validatedSnapshot = job.snapshot;
  const snapshot = validatedSnapshot.package;

  const initializationStart = performance.now();
  const context = await requestGpuCoreContext();
  if (context.status === "unavailable") return context;
  const initializationMilliseconds = performance.now() - initializationStart;
  const { device, rewritePipeline } = context;
  const outputSize = rewriteCandidateOperationIds.byteLength * 2;
  const capacityRequests = [
    ["candidate descriptors", candidateDescriptors.byteLength, "storage"],
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
    ["rewrite parameters", 4, "uniform"],
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
  const dispatchReason = compilerGpuCapacityViolation(device.limits, {
    kind: "dispatch",
    label: "Ducklang Core rewrite",
    workgroupCount: Math.ceil(rewriteCandidateOperationIds.length / 64),
  });
  if (dispatchReason !== undefined) {
    return { status: "unavailable", reason: dispatchReason };
  }
  const transferStart = performance.now();
  const candidateDescriptorBuffer = createBuffer(
    device,
    "Ducklang Core candidate descriptors",
    candidateDescriptors,
    GPUBufferUsage.STORAGE,
  );
  const ruleBuffer = createCompilerGpuBuffer(
    device,
    "Ducklang Core rewrite rules",
    {
      size: rewriteCandidateOperationIds.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
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
    new Uint32Array([rewriteCandidateOperationIds.length]),
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
    candidateDescriptorBuffer,
    ruleBuffer,
    replacementBuffer,
    rewriteParameters,
    readback,
  ];
  let mapped = false;
  try {
    const encoder = device.createCommandEncoder();
    const rewriteBindGroup = device.createBindGroup({
      layout: rewritePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: candidateDescriptorBuffer } },
        { binding: 1, resource: { buffer: ruleBuffer } },
        { binding: 2, resource: { buffer: replacementBuffer } },
        { binding: 3, resource: { buffer: rewriteParameters } },
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
    encoder.copyBufferToBuffer(
      ruleBuffer,
      0,
      readback,
      0,
      rewriteCandidateOperationIds.byteLength,
    );
    encoder.copyBufferToBuffer(
      replacementBuffer,
      0,
      readback,
      rewriteCandidateOperationIds.byteLength,
      rewriteCandidateOperationIds.byteLength,
    );
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
    const ruleWords = new Uint32Array(
      range,
      0,
      rewriteCandidateOperationIds.length,
    );
    const replacementWords = new Uint32Array(
      range,
      rewriteCandidateOperationIds.byteLength,
      rewriteCandidateOperationIds.length,
    );
    const gpuProposals = gpuRewriteProposals(
      snapshot,
      rewriteCandidateOperationIds,
      ruleWords,
      replacementWords,
    );
    const commitStart = performance.now();
    const committed = commitTrustedDucklangCoreRewrites(
      validatedSnapshot,
      gpuProposals,
    );
    const commitMilliseconds = performance.now() - commitStart;
    return {
      status: "completed",
      backend: "gpu",
      inputProvenance: validatedSnapshot.provenance,
      package: committed.package,
      proposals: gpuProposals,
      accepted: committed.accepted,
      rewriteCandidateCount: rewriteCandidateOperationIds.length,
      candidateDescriptorBytes: candidateDescriptors.byteLength,
      logicalDeviceBufferBytes: rewriteCandidateOperationIds.length * 96 + 4,
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

function completeEmptyCoreRewriteFrontier(
  snapshot: TrustedFlatDucklangCore,
): GpuDucklangCoreResult {
  return {
    status: "completed",
    backend: "identity",
    inputProvenance: snapshot.provenance,
    package: snapshot.package,
    proposals: [],
    accepted: [],
    rewriteCandidateCount: 0,
    candidateDescriptorBytes: 0,
    logicalDeviceBufferBytes: 0,
    rewriteDispatchedInvocationCount: 0,
    initializationMilliseconds: 0,
    gpuMilliseconds: 0,
    transferMilliseconds: 0,
    commitMilliseconds: 0,
    submissionBatchSize: 0,
    payloadBatchSize: 1,
    queueWaitMilliseconds: 0,
  };
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

async function requestGpuCoreContext(): Promise<GpuCoreContext> {
  if (contextPromise !== undefined) return await contextPromise;
  const pending = (async (): Promise<GpuCoreContext> => {
    const deviceRequest = await requestCompilerGpuDevice();
    if (deviceRequest.status === "unavailable") return deviceRequest;
    const device = deviceRequest.device;
    try {
      requireCompilerGpuCapacity(device, {
        kind: "pipelineBindings",
        label: "Ducklang Core rewrite",
        storageBufferCount: 3,
        uniformBufferCount: 1,
      });
      const rewriteModule = device.createShaderModule({ code: rewriteShader });
      const errors = (await rewriteModule.getCompilationInfo()).messages
        .filter((message) => message.type === "error");
      if (errors.length > 0) {
        throw new Error(errors.map((error) => error.message).join("; "));
      }
      const rewritePipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: {
          module: rewriteModule,
          entryPoint: "propose_rewrites",
        },
      });
      return {
        status: "available",
        device,
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

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
  acquireCompilerGpuErrorScope,
  awaitCompilerGpuCommand,
  compilerGpuCapacityViolation,
  compilerGpuUnavailabilityReason,
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requestCompilerGpuDevice,
  requireCompilerGpuCapacity,
} from "./gpu_device.ts";

export type GpuDucklangCoreResult =
  | {
    readonly status: "completed";
    readonly package: FlatDucklangCore;
    readonly proposals: readonly DucklangCoreRewriteProposal[];
    readonly accepted: readonly DucklangCoreRewriteProposal[];
    readonly validationRecordCount: number;
    readonly initializationMilliseconds: number;
    readonly gpuMilliseconds: number;
    readonly transferMilliseconds: number;
    readonly commitMilliseconds: number;
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
  let operation_id = invocation.x;
  if (operation_id >= parameters.operation_count) { return; }
  rules[operation_id] = 0u;
  replacements[operation_id] = 0xffffffffu;
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
      rules[operation_id] = 1u;
      replacements[operation_id] = left;
    } else if (constant_equals(left, 0u)) {
      rules[operation_id] = 1u;
      replacements[operation_id] = right;
    }
  } else if (
    operation_attribute.y == ${FlatDucklangCoreKind.binaryOperator.multiply}u
  ) {
    if (constant_equals(right, 0x3ff00000u)) {
      rules[operation_id] = 2u;
      replacements[operation_id] = left;
    } else if (constant_equals(left, 0x3ff00000u)) {
      rules[operation_id] = 2u;
      replacements[operation_id] = right;
    }
  }
}
`;

let contextPromise: Promise<GpuCoreContext> | undefined;

export async function runDucklangCoreGpuPass(
  snapshot: FlatDucklangCore,
): Promise<GpuDucklangCoreResult> {
  try {
    return await runDucklangCoreWithGpu(snapshot);
  } catch (error) {
    const reason = compilerGpuUnavailabilityReason(
      "Ducklang Core pass",
      error,
    );
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  }
}

async function runDucklangCoreWithGpu(
  snapshot: FlatDucklangCore,
): Promise<GpuDucklangCoreResult> {
  const records = gpuValidationRecords(snapshot);
  let cpuValidation:
    | {
      readonly status: "valid";
      readonly snapshot: ValidatedFlatDucklangCore;
    }
    | { readonly status: "invalid"; readonly reason: string };
  try {
    cpuValidation = {
      status: "valid",
      snapshot: validateFlatDucklangCore(snapshot),
    };
  } catch (error) {
    cpuValidation = {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const initializationStart = performance.now();
  const context = await requestGpuCoreContext();
  if (context.status === "unavailable") return context;
  const initializationMilliseconds = performance.now() - initializationStart;
  const { device, validationPipeline, rewritePipeline } = context;
  const operationColumns = interleaveColumns(
    snapshot.operationKinds,
    snapshot.operationResultValueIds,
    snapshot.operationBlockIds,
    snapshot.operationTypeIds,
  );
  const operationRanges = interleaveColumns(
    snapshot.operationOperandStarts,
    snapshot.operationOperandCounts,
    snapshot.operationAttributeStarts,
    snapshot.operationAttributeCounts,
  );
  const attributes = interleaveColumns(
    snapshot.attributeKinds,
    snapshot.attributeLowWords,
    snapshot.attributeHighWords,
    new Uint32Array(snapshot.attributeKinds.length),
  );
  const values = interleaveColumns(
    snapshot.valueFunctionIds,
    snapshot.valueTypeIds,
    snapshot.valueDefinitionKinds,
    snapshot.valueDefinitionIds,
  );
  const types = interleavePairs(
    snapshot.typeKinds,
    snapshot.typeAuxiliaries,
  );
  const outputSize = 8 + snapshot.operationKinds.byteLength * 2;
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
      Math.max(4, snapshot.operationKinds.byteLength),
      "storage",
    ],
    [
      "rewrite replacements",
      Math.max(4, snapshot.operationKinds.byteLength),
      "storage",
    ],
    ["rewrite parameters", 20, "uniform"],
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
  for (
    const [label, workgroupCount] of [
      ["validation", Math.max(1, Math.ceil(records.length / 256))],
      [
        "rewrite",
        Math.max(1, Math.ceil(snapshot.operationKinds.length / 64)),
      ],
    ] as const
  ) {
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
  const ruleBuffer = createCompilerGpuBuffer(
    device,
    "Ducklang Core rewrite rules",
    {
      size: Math.max(4, snapshot.operationKinds.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const replacementBuffer = createCompilerGpuBuffer(
    device,
    "Ducklang Core rewrite replacements",
    {
      size: Math.max(4, snapshot.operationKinds.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const rewriteParameters = createBuffer(
    device,
    "Ducklang Core rewrite parameters",
    new Uint32Array([
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
  const release = await acquireCompilerGpuErrorScope();
  let mapped = false;
  let scopePending = false;
  try {
    device.pushErrorScope("validation");
    scopePending = true;
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
      Math.max(1, Math.ceil(snapshot.operationKinds.length / 64)),
    );
    rewritePass.end();
    encoder.copyBufferToBuffer(errorBuffer, 0, readback, 0, 8);
    if (snapshot.operationKinds.byteLength > 0) {
      encoder.copyBufferToBuffer(
        ruleBuffer,
        0,
        readback,
        8,
        snapshot.operationKinds.byteLength,
      );
      encoder.copyBufferToBuffer(
        replacementBuffer,
        0,
        readback,
        8 + snapshot.operationKinds.byteLength,
        snapshot.operationKinds.byteLength,
      );
    }
    const gpuStart = performance.now();
    device.queue.submit([encoder.finish()]);
    await awaitCompilerGpuCommand(
      device,
      "Ducklang Core pass",
      readback.mapAsync(GPUMapMode.READ),
    );
    mapped = true;
    const gpuMilliseconds = performance.now() - gpuStart;
    const validationError = await device.popErrorScope();
    scopePending = false;
    if (validationError !== null) {
      throw new Error(
        `WebGPU Ducklang Core pass validation failed: ${validationError.message}`,
      );
    }
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
      snapshot.operationKinds.length,
    );
    const replacementWords = new Uint32Array(
      range,
      8 + snapshot.operationKinds.byteLength,
      snapshot.operationKinds.length,
    );
    const gpuProposals = gpuRewriteProposals(
      snapshot,
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
      initializationMilliseconds,
      gpuMilliseconds,
      transferMilliseconds,
      commitMilliseconds,
    };
  } catch (error) {
    const reason = compilerGpuUnavailabilityReason(
      "Ducklang Core pass",
      error,
    );
    if (reason !== undefined) return { status: "unavailable", reason };
    throw error;
  } finally {
    if (scopePending) await device.popErrorScope();
    if (mapped) readback.unmap();
    buffers.forEach((buffer) => buffer.destroy());
    release();
  }
}

function gpuRewriteProposals(
  snapshot: FlatDucklangCore,
  rules: Uint32Array,
  replacements: Uint32Array,
): readonly DucklangCoreRewriteProposal[] {
  return Array.from(rules.entries()).flatMap(([operationId, ruleId]) => {
    if (ruleId === 0) return [];
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
      replacementValueId: replacements[operationId],
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

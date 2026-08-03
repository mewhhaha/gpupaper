import {
  type FlatCore,
  FlatCoreKind,
  type TrustedFlatCore,
  validateFlatCore,
} from "./flat_core.ts";

export type CoreRewriteRule = "addZero" | "multiplyOne";

export type CoreRewriteProposal = {
  readonly rule: CoreRewriteRule;
  readonly functionId: number;
  readonly operationId: number;
  readonly resultValueId: number;
  readonly replacementValueId: number;
  readonly profit: number;
};

export type CoreRewriteResult = {
  readonly package: FlatCore;
  readonly proposals: readonly CoreRewriteProposal[];
  readonly accepted: readonly CoreRewriteProposal[];
  readonly timings: CoreRewriteTimings;
};

export type CoreRewriteTimings = {
  readonly validationMilliseconds: number;
  readonly matchingMilliseconds: number;
  readonly conflictResolutionMilliseconds: number;
  readonly rebuildMilliseconds: number;
};

export type CoreRewriteCommit = {
  readonly package: FlatCore;
  readonly accepted: readonly CoreRewriteProposal[];
};

const ruleIds: Readonly<Record<CoreRewriteRule, number>> = {
  addZero: 0,
  multiplyOne: 1,
};
const absentFlatId = 0xffff_ffff;

export function rewriteFlatCore(
  snapshot: FlatCore,
): CoreRewriteResult {
  const validationStart = performance.now();
  validateFlatCore(snapshot);
  const validationMilliseconds = performance.now() - validationStart;
  return rewriteTrustedSnapshot(snapshot, validationMilliseconds);
}

export function rewriteTrustedFlatCore(
  trusted: TrustedFlatCore,
): CoreRewriteResult {
  return rewriteTrustedSnapshot(trusted.package, 0);
}

function rewriteTrustedSnapshot(
  snapshot: FlatCore,
  validationMilliseconds: number,
): CoreRewriteResult {
  const matchingStart = performance.now();
  const proposals = proposeTrustedCoreRewritesFromSnapshot(snapshot);
  const matchingMilliseconds = performance.now() - matchingStart;
  const conflictResolutionStart = performance.now();
  const accepted = resolveValidatedCoreRewriteConflicts(
    snapshot,
    proposals,
  );
  const conflictResolutionMilliseconds = performance.now() -
    conflictResolutionStart;
  if (accepted.length === 0) {
    return {
      package: snapshot,
      proposals,
      accepted,
      timings: {
        validationMilliseconds,
        matchingMilliseconds,
        conflictResolutionMilliseconds,
        rebuildMilliseconds: 0,
      },
    };
  }
  const rebuildStart = performance.now();
  const rewritten = rebuildTrustedFlatCore(snapshot, accepted);
  validateFlatCore(rewritten);
  const rebuildMilliseconds = performance.now() - rebuildStart;
  return {
    package: rewritten,
    proposals,
    accepted,
    timings: {
      validationMilliseconds,
      matchingMilliseconds,
      conflictResolutionMilliseconds,
      rebuildMilliseconds,
    },
  };
}

export function proposeCoreRewrites(
  snapshot: FlatCore,
): readonly CoreRewriteProposal[] {
  validateFlatCore(snapshot);
  return proposeTrustedCoreRewritesFromSnapshot(snapshot);
}

export function proposeTrustedCoreRewrites(
  trusted: TrustedFlatCore,
): readonly CoreRewriteProposal[] {
  return proposeTrustedCoreRewritesFromSnapshot(trusted.package);
}

function proposeTrustedCoreRewritesFromSnapshot(
  snapshot: FlatCore,
): readonly CoreRewriteProposal[] {
  const proposals: CoreRewriteProposal[] = [];
  for (
    let operationId = 0;
    operationId < snapshot.operationKinds.length;
    operationId += 1
  ) {
    const proposal = matchValidatedCoreRewrite(snapshot, operationId);
    if (proposal !== undefined) proposals.push(proposal);
  }
  return proposals;
}

function matchValidatedCoreRewrite(
  snapshot: FlatCore,
  operationId: number,
): CoreRewriteProposal | undefined {
  if (
    snapshot.operationKinds[operationId] !==
      FlatCoreKind.operation.scalarBinary ||
    snapshot.operationOperandCounts[operationId] !== 2 ||
    snapshot.operationAttributeCounts[operationId] !== 1 ||
    !hasIntegerScalarResult(snapshot, operationId)
  ) {
    return undefined;
  }
  const attributeId = snapshot.operationAttributeStarts[operationId];
  if (
    snapshot.attributeKinds[attributeId] !==
      FlatCoreKind.attribute.unsigned
  ) {
    return undefined;
  }
  const operator = snapshot.attributeLowWords[attributeId];
  const operandStart = snapshot.operationOperandStarts[operationId];
  const left = snapshot.operandValueIds[operandStart];
  const right = snapshot.operandValueIds[operandStart + 1];
  const rule = operator === FlatCoreKind.binaryOperator.add
    ? "addZero"
    : operator === FlatCoreKind.binaryOperator.multiply
    ? "multiplyOne"
    : undefined;
  if (rule === undefined) return undefined;
  const identity = rule === "addZero" ? 0 : 1;
  const replacement = coreConstantEquals(snapshot, right, identity)
    ? left
    : coreConstantEquals(snapshot, left, identity)
    ? right
    : undefined;
  if (replacement === undefined) return undefined;
  return {
    rule,
    functionId:
      snapshot.blockFunctionIds[snapshot.operationBlockIds[operationId]],
    operationId,
    resultValueId: snapshot.operationResultValueIds[operationId],
    replacementValueId: replacement,
    profit: 1,
  };
}

function hasIntegerScalarResult(
  snapshot: FlatCore,
  operationId: number,
): boolean {
  const typeId = snapshot.operationTypeIds[operationId];
  if (
    snapshot.typeKinds[typeId] !== FlatCoreKind.type.scalar
  ) {
    return false;
  }
  const scalar = snapshot.typeAuxiliaries[typeId];
  return scalar === FlatCoreKind.scalar.i32 ||
    scalar === FlatCoreKind.scalar.i64;
}

export function resolveCoreRewriteConflicts(
  snapshot: FlatCore,
  proposals: readonly CoreRewriteProposal[],
): readonly CoreRewriteProposal[] {
  validateFlatCore(snapshot);
  return resolveValidatedCoreRewriteConflicts(snapshot, proposals);
}

function resolveValidatedCoreRewriteConflicts(
  snapshot: FlatCore,
  proposals: readonly CoreRewriteProposal[],
): readonly CoreRewriteProposal[] {
  const claimedOperations = new Set<number>();
  const accepted: CoreRewriteProposal[] = [];
  const ordered = [...proposals].sort((left, right) =>
    right.profit - left.profit ||
    left.functionId - right.functionId ||
    left.operationId - right.operationId ||
    left.resultValueId - right.resultValueId ||
    ruleIds[left.rule] - ruleIds[right.rule]
  );
  for (const proposal of ordered) {
    validateProposal(snapshot, proposal);
    if (claimedOperations.has(proposal.operationId)) continue;
    claimedOperations.add(proposal.operationId);
    accepted.push(proposal);
  }
  return accepted.sort((left, right) =>
    left.operationId - right.operationId ||
    ruleIds[left.rule] - ruleIds[right.rule]
  );
}

export function rebuildFlatCore(
  snapshot: FlatCore,
  accepted: readonly CoreRewriteProposal[],
): FlatCore {
  validateFlatCore(snapshot);
  if (accepted.length === 0) return snapshot;
  const rebuilt = rebuildTrustedFlatCore(snapshot, accepted);
  validateFlatCore(rebuilt);
  return rebuilt;
}

export function commitTrustedCoreRewrites(
  trusted: TrustedFlatCore,
  proposals: readonly CoreRewriteProposal[],
): CoreRewriteCommit {
  const snapshot = trusted.package;
  const accepted = resolveValidatedCoreRewriteConflicts(
    snapshot,
    proposals,
  );
  if (accepted.length === 0) return { package: snapshot, accepted };
  const rewritten = rebuildTrustedFlatCore(snapshot, accepted);
  validateFlatCore(rewritten);
  return { package: rewritten, accepted };
}

function rebuildTrustedFlatCore(
  snapshot: FlatCore,
  accepted: readonly CoreRewriteProposal[],
): FlatCore {
  const removedOperations = new Uint8Array(snapshot.operationKinds.length);
  const replacementValueIds = new Uint32Array(snapshot.valueLocalIds.length);
  replacementValueIds.fill(absentFlatId);
  for (const proposal of accepted) {
    validateProposal(snapshot, proposal);
    if (removedOperations[proposal.operationId] !== 0) {
      throw new TypeError(
        `accepted Core rewrites repeat operation ${proposal.operationId}`,
      );
    }
    removedOperations[proposal.operationId] = 1;
    replacementValueIds[proposal.resultValueId] = proposal.replacementValueId;
  }

  const resolveReplacement = (valueId: number): number => {
    const visited = new Set<number>();
    let current = valueId;
    while (true) {
      if (visited.has(current)) {
        throw new TypeError(
          `Core rewrite replacements form a cycle at function ${
            snapshot.valueFunctionIds[current]
          } value ${snapshot.valueLocalIds[current]}`,
        );
      }
      visited.add(current);
      const replacement = replacementValueIds[current];
      if (replacement === absentFlatId) return current;
      current = replacement;
    }
  };

  const valueIdRemap = new Uint32Array(snapshot.valueLocalIds.length);
  valueIdRemap.fill(absentFlatId);
  let retainedValueCount = 0;
  for (let valueId = 0; valueId < snapshot.valueLocalIds.length; valueId += 1) {
    if (replacementValueIds[valueId] !== absentFlatId) continue;
    valueIdRemap[valueId] = retainedValueCount;
    retainedValueCount += 1;
  }
  const remapValue = (valueId: number): number => {
    const resolved = resolveReplacement(valueId);
    const remapped = valueIdRemap[resolved];
    if (remapped !== absentFlatId) return remapped;
    throw new TypeError(
      `Core rewrite left function ${snapshot.valueFunctionIds[valueId]} value ${
        snapshot.valueLocalIds[valueId]
      } without a retained replacement`,
    );
  };

  const operationIdRemap = new Uint32Array(
    snapshot.operationKinds.length,
  );
  operationIdRemap.fill(absentFlatId);
  const operationBlockIds: number[] = [];
  const operationKinds: number[] = [];
  const operationResultValueIds: number[] = [];
  const operationTypeIds: number[] = [];
  const operationOperandStarts: number[] = [];
  const operationOperandCounts: number[] = [];
  const operationAttributeStarts: number[] = [];
  const operationAttributeCounts: number[] = [];
  const operationSourceLocationIds: number[] = [];
  const operandValueIds: number[] = [];
  const attributeKinds: number[] = [];
  const attributeLowWords: number[] = [];
  const attributeHighWords: number[] = [];

  for (
    let operationId = 0;
    operationId < snapshot.operationKinds.length;
    operationId += 1
  ) {
    if (removedOperations[operationId] !== 0) continue;
    operationIdRemap[operationId] = operationKinds.length;
    operationBlockIds.push(snapshot.operationBlockIds[operationId]);
    operationKinds.push(snapshot.operationKinds[operationId]);
    operationResultValueIds.push(
      remapValue(snapshot.operationResultValueIds[operationId]),
    );
    operationTypeIds.push(snapshot.operationTypeIds[operationId]);
    operationSourceLocationIds.push(
      snapshot.operationSourceLocationIds[operationId],
    );

    operationOperandStarts.push(operandValueIds.length);
    const operandStart = snapshot.operationOperandStarts[operationId];
    const operandCount = snapshot.operationOperandCounts[operationId];
    operationOperandCounts.push(operandCount);
    for (
      let operandId = operandStart;
      operandId < operandStart + operandCount;
      operandId += 1
    ) {
      operandValueIds.push(remapValue(snapshot.operandValueIds[operandId]));
    }

    operationAttributeStarts.push(attributeKinds.length);
    const attributeStart = snapshot.operationAttributeStarts[operationId];
    const attributeCount = snapshot.operationAttributeCounts[operationId];
    operationAttributeCounts.push(attributeCount);
    for (
      let attributeId = attributeStart;
      attributeId < attributeStart + attributeCount;
      attributeId += 1
    ) {
      attributeKinds.push(snapshot.attributeKinds[attributeId]);
      attributeLowWords.push(snapshot.attributeLowWords[attributeId]);
      attributeHighWords.push(snapshot.attributeHighWords[attributeId]);
    }
  }

  const blockOperationStarts: number[] = [];
  const blockOperationCounts: number[] = [];
  let retainedOperationStart = 0;
  for (
    let blockId = 0;
    blockId < snapshot.blockFunctionIds.length;
    blockId += 1
  ) {
    blockOperationStarts.push(retainedOperationStart);
    const operationStart = snapshot.blockOperationStarts[blockId];
    const operationCount = snapshot.blockOperationCounts[blockId];
    let retainedOperationCount = 0;
    for (
      let operationId = operationStart;
      operationId < operationStart + operationCount;
      operationId += 1
    ) {
      if (removedOperations[operationId] === 0) {
        retainedOperationCount += 1;
      }
    }
    blockOperationCounts.push(retainedOperationCount);
    retainedOperationStart += retainedOperationCount;
  }

  const valueFunctionIds: number[] = [];
  const valueLocalIds: number[] = [];
  const valueTypeIds: number[] = [];
  const valueDefinitionKinds: number[] = [];
  const valueDefinitionIds: number[] = [];
  for (let valueId = 0; valueId < snapshot.valueLocalIds.length; valueId += 1) {
    if (replacementValueIds[valueId] !== absentFlatId) continue;
    valueFunctionIds.push(snapshot.valueFunctionIds[valueId]);
    valueLocalIds.push(snapshot.valueLocalIds[valueId]);
    valueTypeIds.push(snapshot.valueTypeIds[valueId]);
    const definitionKind = snapshot.valueDefinitionKinds[valueId];
    valueDefinitionKinds.push(definitionKind);
    if (
      definitionKind ===
        FlatCoreKind.valueDefinition.operation
    ) {
      const remapped = operationIdRemap[
        snapshot.valueDefinitionIds[valueId]
      ];
      if (remapped === absentFlatId) {
        throw new TypeError(
          `Core rewrite retained function ${
            snapshot.valueFunctionIds[valueId]
          } value ${
            snapshot.valueLocalIds[valueId]
          } but removed its definition`,
        );
      }
      valueDefinitionIds.push(remapped);
    } else {
      valueDefinitionIds.push(snapshot.valueDefinitionIds[valueId]);
    }
  }

  const rebuilt: FlatCore = {
    schemaVersion: snapshot.schemaVersion,
    entryFunctionId: snapshot.entryFunctionId,
    moduleFileId: snapshot.moduleFileId,
    memoryMinimumPages: snapshot.memoryMinimumPages,
    memoryMaximumPages: snapshot.memoryMaximumPages,
    memoryExportNameId: snapshot.memoryExportNameId,

    stringBytes: snapshot.stringBytes.slice(),
    stringStarts: snapshot.stringStarts.slice(),
    stringLengths: snapshot.stringLengths.slice(),

    sourceLocationFileIds: snapshot.sourceLocationFileIds.slice(),
    sourceLocationStarts: snapshot.sourceLocationStarts.slice(),
    sourceLocationEnds: snapshot.sourceLocationEnds.slice(),

    typeKinds: snapshot.typeKinds.slice(),
    typePayloadStarts: snapshot.typePayloadStarts.slice(),
    typePayloadCounts: snapshot.typePayloadCounts.slice(),
    typeAuxiliaries: snapshot.typeAuxiliaries.slice(),
    typePayloads: snapshot.typePayloads.slice(),

    signatureParameterStarts: snapshot.signatureParameterStarts.slice(),
    signatureParameterCounts: snapshot.signatureParameterCounts.slice(),
    signatureResultTypeIds: snapshot.signatureResultTypeIds.slice(),
    signatureParameterTypeIds: snapshot.signatureParameterTypeIds.slice(),

    functionNameIds: snapshot.functionNameIds.slice(),
    functionSourceSymbolIds: snapshot.functionSourceSymbolIds.slice(),
    functionSignatureIds: snapshot.functionSignatureIds.slice(),
    functionEntryBlockIds: snapshot.functionEntryBlockIds.slice(),
    functionBlockStarts: snapshot.functionBlockStarts.slice(),
    functionBlockCounts: snapshot.functionBlockCounts.slice(),
    functionSourceLocationIds: snapshot.functionSourceLocationIds.slice(),

    blockFunctionIds: snapshot.blockFunctionIds.slice(),
    blockLocalIds: snapshot.blockLocalIds.slice(),
    blockParameterStarts: snapshot.blockParameterStarts.slice(),
    blockParameterCounts: snapshot.blockParameterCounts.slice(),
    blockOperationStarts: new Uint32Array(blockOperationStarts),
    blockOperationCounts: new Uint32Array(blockOperationCounts),
    blockTerminatorIds: snapshot.blockTerminatorIds.slice(),

    blockParameterValueIds: Uint32Array.from(
      snapshot.blockParameterValueIds,
      remapValue,
    ),
    blockParameterTypeIds: snapshot.blockParameterTypeIds.slice(),
    blockParameterSourceLocationIds: snapshot.blockParameterSourceLocationIds
      .slice(),

    valueFunctionIds: new Uint32Array(valueFunctionIds),
    valueLocalIds: new Uint32Array(valueLocalIds),
    valueTypeIds: new Uint32Array(valueTypeIds),
    valueDefinitionKinds: new Uint32Array(valueDefinitionKinds),
    valueDefinitionIds: new Uint32Array(valueDefinitionIds),

    operationBlockIds: new Uint32Array(operationBlockIds),
    operationKinds: new Uint32Array(operationKinds),
    operationResultValueIds: new Uint32Array(operationResultValueIds),
    operationTypeIds: new Uint32Array(operationTypeIds),
    operationOperandStarts: new Uint32Array(operationOperandStarts),
    operationOperandCounts: new Uint32Array(operationOperandCounts),
    operationAttributeStarts: new Uint32Array(operationAttributeStarts),
    operationAttributeCounts: new Uint32Array(operationAttributeCounts),
    operationSourceLocationIds: new Uint32Array(operationSourceLocationIds),
    operandValueIds: new Uint32Array(operandValueIds),
    attributeKinds: new Uint32Array(attributeKinds),
    attributeLowWords: new Uint32Array(attributeLowWords),
    attributeHighWords: new Uint32Array(attributeHighWords),

    terminatorBlockIds: snapshot.terminatorBlockIds.slice(),
    terminatorKinds: snapshot.terminatorKinds.slice(),
    terminatorConditionValueIds: Uint32Array.from(
      snapshot.terminatorConditionValueIds,
      (valueId) =>
        valueId === absentFlatId ? absentFlatId : remapValue(valueId),
    ),
    terminatorEdgeStarts: snapshot.terminatorEdgeStarts.slice(),
    terminatorEdgeCounts: snapshot.terminatorEdgeCounts.slice(),
    terminatorReturnStarts: snapshot.terminatorReturnStarts.slice(),
    terminatorReturnCounts: snapshot.terminatorReturnCounts.slice(),
    terminatorSourceLocationIds: snapshot.terminatorSourceLocationIds.slice(),
    returnValueIds: Uint32Array.from(snapshot.returnValueIds, remapValue),

    edgeTargetBlockIds: snapshot.edgeTargetBlockIds.slice(),
    edgeArgumentStarts: snapshot.edgeArgumentStarts.slice(),
    edgeArgumentCounts: snapshot.edgeArgumentCounts.slice(),
    edgeSourceLocationIds: snapshot.edgeSourceLocationIds.slice(),
    edgeArgumentValueIds: Uint32Array.from(
      snapshot.edgeArgumentValueIds,
      remapValue,
    ),

    layoutKinds: snapshot.layoutKinds.slice(),
    layoutSizes: snapshot.layoutSizes.slice(),
    layoutAlignments: snapshot.layoutAlignments.slice(),
    layoutComponentStarts: snapshot.layoutComponentStarts.slice(),
    layoutComponentCounts: snapshot.layoutComponentCounts.slice(),
    layoutTagOffsets: snapshot.layoutTagOffsets.slice(),
    layoutTagSizes: snapshot.layoutTagSizes.slice(),
    layoutPayloadOffsets: snapshot.layoutPayloadOffsets.slice(),
    layoutComponentIds: snapshot.layoutComponentIds.slice(),
    layoutComponentOffsets: snapshot.layoutComponentOffsets.slice(),
    typeLayoutIds: snapshot.typeLayoutIds.slice(),
  };
  return rebuilt;
}

function coreConstantEquals(
  snapshot: FlatCore,
  valueId: number,
  expected: 0 | 1,
): boolean {
  if (
    snapshot.valueDefinitionKinds[valueId] !==
      FlatCoreKind.valueDefinition.operation
  ) {
    return false;
  }
  const operationId = snapshot.valueDefinitionIds[valueId];
  if (
    snapshot.operationKinds[operationId] !==
      FlatCoreKind.operation.constant ||
    snapshot.operationAttributeCounts[operationId] !== 1
  ) {
    return false;
  }
  const attributeId = snapshot.operationAttributeStarts[operationId];
  if (
    snapshot.attributeKinds[attributeId] !==
      FlatCoreKind.attribute.number ||
    snapshot.attributeLowWords[attributeId] !== 0
  ) {
    return false;
  }
  return snapshot.attributeHighWords[attributeId] ===
    (expected === 0 ? 0 : 0x3ff0_0000);
}

function validateProposal(
  snapshot: FlatCore,
  proposal: CoreRewriteProposal,
): void {
  if (
    !Number.isSafeInteger(proposal.operationId) ||
    proposal.operationId < 0 ||
    proposal.operationId >= snapshot.operationKinds.length
  ) {
    throw new RangeError(
      `Core rewrite ${proposal.rule} uses operation ${proposal.operationId}; package contains ${snapshot.operationKinds.length}`,
    );
  }
  const blockId = snapshot.operationBlockIds[proposal.operationId];
  const functionId = snapshot.blockFunctionIds[blockId];
  if (proposal.functionId !== functionId) {
    throw new TypeError(
      `Core rewrite ${proposal.rule} claims function ${proposal.functionId}; operation ${proposal.operationId} belongs to ${functionId}`,
    );
  }
  if (
    snapshot.operationResultValueIds[proposal.operationId] !==
      proposal.resultValueId
  ) {
    throw new TypeError(
      `Core rewrite ${proposal.rule} result ${proposal.resultValueId} disagrees with operation ${proposal.operationId}`,
    );
  }
  for (
    const [subject, valueId] of [
      ["result", proposal.resultValueId],
      ["replacement", proposal.replacementValueId],
    ] as const
  ) {
    if (
      !Number.isSafeInteger(valueId) || valueId < 0 ||
      valueId >= snapshot.valueLocalIds.length
    ) {
      throw new RangeError(
        `Core rewrite ${proposal.rule} ${subject} value ${valueId} is outside table length ${snapshot.valueLocalIds.length}`,
      );
    }
    if (snapshot.valueFunctionIds[valueId] !== functionId) {
      throw new TypeError(
        `Core rewrite ${proposal.rule} ${subject} value ${valueId} belongs to function ${
          snapshot.valueFunctionIds[valueId]
        }; expected ${functionId}`,
      );
    }
  }
  if (
    !Number.isSafeInteger(proposal.profit) ||
    proposal.profit < 0
  ) {
    throw new RangeError(
      `Core rewrite ${proposal.rule} profit must be a non-negative integer; received ${proposal.profit}`,
    );
  }
  const expected = matchValidatedCoreRewrite(
    snapshot,
    proposal.operationId,
  );
  if (
    expected === undefined ||
    proposal.rule !== expected.rule ||
    proposal.replacementValueId !== expected.replacementValueId ||
    proposal.profit !== expected.profit
  ) {
    throw new TypeError(
      `Core rewrite ${proposal.rule} for operation ${proposal.operationId} does not match the validated snapshot`,
    );
  }
}

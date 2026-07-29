import type {
  CoreValueId,
  DucklangCoreOperation,
  DucklangCoreTerminator,
} from "./ducklang_core.ts";
import {
  type FlatDucklangCore,
  FlatDucklangCoreKind,
  flattenDucklangCore,
  inflateFlatDucklangCore,
  validateFlatDucklangCore,
} from "./flat_ducklang_core.ts";

export type DucklangCoreRewriteRule = "addZero" | "multiplyOne";

export type DucklangCoreRewriteProposal = {
  readonly rule: DucklangCoreRewriteRule;
  readonly functionId: number;
  readonly operationId: number;
  readonly resultValueId: number;
  readonly replacementValueId: number;
  readonly profit: number;
};

export type DucklangCoreRewriteResult = {
  readonly package: FlatDucklangCore;
  readonly proposals: readonly DucklangCoreRewriteProposal[];
  readonly accepted: readonly DucklangCoreRewriteProposal[];
};

const ruleIds: Readonly<Record<DucklangCoreRewriteRule, number>> = {
  addZero: 0,
  multiplyOne: 1,
};

export function rewriteFlatDucklangCore(
  snapshot: FlatDucklangCore,
): DucklangCoreRewriteResult {
  const proposals = proposeDucklangCoreRewrites(snapshot);
  const accepted = resolveDucklangCoreRewriteConflicts(snapshot, proposals);
  return {
    package: rebuildFlatDucklangCore(snapshot, accepted),
    proposals,
    accepted,
  };
}

export function proposeDucklangCoreRewrites(
  snapshot: FlatDucklangCore,
): readonly DucklangCoreRewriteProposal[] {
  validateFlatDucklangCore(snapshot);
  const proposals: DucklangCoreRewriteProposal[] = [];
  for (
    let operationId = 0;
    operationId < snapshot.operationKinds.length;
    operationId += 1
  ) {
    if (
      snapshot.operationKinds[operationId] !==
        FlatDucklangCoreKind.operation.scalarBinary ||
      snapshot.operationOperandCounts[operationId] !== 2 ||
      snapshot.operationAttributeCounts[operationId] !== 1
    ) {
      continue;
    }
    const attributeId = snapshot.operationAttributeStarts[operationId];
    if (
      snapshot.attributeKinds[attributeId] !==
        FlatDucklangCoreKind.attribute.unsigned
    ) {
      continue;
    }
    const operator = snapshot.attributeLowWords[attributeId];
    const operandStart = snapshot.operationOperandStarts[operationId];
    const left = snapshot.operandValueIds[operandStart];
    const right = snapshot.operandValueIds[operandStart + 1];
    const rule = operator === FlatDucklangCoreKind.binaryOperator.add
      ? "addZero"
      : operator === FlatDucklangCoreKind.binaryOperator.multiply
      ? "multiplyOne"
      : undefined;
    if (rule === undefined) continue;
    const identity = rule === "addZero" ? 0 : 1;
    const replacement = coreConstantEquals(snapshot, right, identity)
      ? left
      : coreConstantEquals(snapshot, left, identity)
      ? right
      : undefined;
    if (replacement === undefined) continue;
    proposals.push({
      rule,
      functionId:
        snapshot.blockFunctionIds[snapshot.operationBlockIds[operationId]],
      operationId,
      resultValueId: snapshot.operationResultValueIds[operationId],
      replacementValueId: replacement,
      profit: 1,
    });
  }
  return proposals;
}

export function resolveDucklangCoreRewriteConflicts(
  snapshot: FlatDucklangCore,
  proposals: readonly DucklangCoreRewriteProposal[],
): readonly DucklangCoreRewriteProposal[] {
  validateFlatDucklangCore(snapshot);
  const claimedOperations = new Set<number>();
  const accepted: DucklangCoreRewriteProposal[] = [];
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

export function rebuildFlatDucklangCore(
  snapshot: FlatDucklangCore,
  accepted: readonly DucklangCoreRewriteProposal[],
): FlatDucklangCore {
  validateFlatDucklangCore(snapshot);
  accepted.forEach((proposal) => validateProposal(snapshot, proposal));
  const acceptedOperations = new Set<number>();
  const replacements = new Map<string, CoreValueId>();
  for (const proposal of accepted) {
    if (acceptedOperations.has(proposal.operationId)) {
      throw new TypeError(
        `accepted Ducklang Core rewrites repeat operation ${proposal.operationId}`,
      );
    }
    acceptedOperations.add(proposal.operationId);
    replacements.set(
      valueKey(
        proposal.functionId,
        snapshot.valueLocalIds[proposal.resultValueId],
      ),
      snapshot.valueLocalIds[proposal.replacementValueId] as CoreValueId,
    );
  }
  const resolveValue = (
    functionId: number,
    value: CoreValueId,
  ): CoreValueId => {
    const visited = new Set<number>();
    let current = value;
    while (true) {
      if (visited.has(current)) {
        throw new TypeError(
          `Ducklang Core rewrite replacements form a cycle at function ${functionId} value ${current}`,
        );
      }
      visited.add(current);
      const replacement = replacements.get(valueKey(functionId, current));
      if (replacement === undefined) return current;
      current = replacement;
    }
  };
  const module = inflateFlatDucklangCore(snapshot);
  let operationId = 0;
  const functions = module.functions.map((function_) => ({
    ...function_,
    blocks: function_.blocks.map((block) => {
      const operations: DucklangCoreOperation[] = [];
      for (const operation of block.operations) {
        const retained = !acceptedOperations.has(operationId);
        operationId += 1;
        if (!retained) continue;
        operations.push({
          ...operation,
          operands: operation.operands.map((value) =>
            resolveValue(function_.id, value)
          ),
        });
      }
      return {
        ...block,
        operations,
        terminator: rewriteTerminator(
          block.terminator,
          (value) => resolveValue(function_.id, value),
        ),
      };
    }),
  }));
  return flattenDucklangCore({ ...module, functions });
}

function coreConstantEquals(
  snapshot: FlatDucklangCore,
  valueId: number,
  expected: 0 | 1,
): boolean {
  if (
    snapshot.valueDefinitionKinds[valueId] !==
      FlatDucklangCoreKind.valueDefinition.operation
  ) {
    return false;
  }
  const operationId = snapshot.valueDefinitionIds[valueId];
  if (
    snapshot.operationKinds[operationId] !==
      FlatDucklangCoreKind.operation.constant ||
    snapshot.operationAttributeCounts[operationId] !== 1
  ) {
    return false;
  }
  const attributeId = snapshot.operationAttributeStarts[operationId];
  if (
    snapshot.attributeKinds[attributeId] !==
      FlatDucklangCoreKind.attribute.number ||
    snapshot.attributeLowWords[attributeId] !== 0
  ) {
    return false;
  }
  return snapshot.attributeHighWords[attributeId] ===
    (expected === 0 ? 0 : 0x3ff0_0000);
}

function rewriteTerminator(
  terminator: DucklangCoreTerminator,
  rewriteValue: (value: CoreValueId) => CoreValueId,
): DucklangCoreTerminator {
  if (terminator.kind === "branch") {
    return {
      ...terminator,
      arguments: terminator.arguments.map(rewriteValue),
    };
  }
  if (terminator.kind === "conditional_branch") {
    return {
      ...terminator,
      condition: rewriteValue(terminator.condition),
      trueArguments: terminator.trueArguments.map(rewriteValue),
      falseArguments: terminator.falseArguments.map(rewriteValue),
    };
  }
  return terminator.kind === "return"
    ? { ...terminator, values: terminator.values.map(rewriteValue) }
    : terminator;
}

function validateProposal(
  snapshot: FlatDucklangCore,
  proposal: DucklangCoreRewriteProposal,
): void {
  if (
    !Number.isSafeInteger(proposal.operationId) ||
    proposal.operationId < 0 ||
    proposal.operationId >= snapshot.operationKinds.length
  ) {
    throw new RangeError(
      `Ducklang Core rewrite ${proposal.rule} uses operation ${proposal.operationId}; package contains ${snapshot.operationKinds.length}`,
    );
  }
  const blockId = snapshot.operationBlockIds[proposal.operationId];
  const functionId = snapshot.blockFunctionIds[blockId];
  if (proposal.functionId !== functionId) {
    throw new TypeError(
      `Ducklang Core rewrite ${proposal.rule} claims function ${proposal.functionId}; operation ${proposal.operationId} belongs to ${functionId}`,
    );
  }
  if (
    snapshot.operationResultValueIds[proposal.operationId] !==
      proposal.resultValueId
  ) {
    throw new TypeError(
      `Ducklang Core rewrite ${proposal.rule} result ${proposal.resultValueId} disagrees with operation ${proposal.operationId}`,
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
        `Ducklang Core rewrite ${proposal.rule} ${subject} value ${valueId} is outside table length ${snapshot.valueLocalIds.length}`,
      );
    }
    if (snapshot.valueFunctionIds[valueId] !== functionId) {
      throw new TypeError(
        `Ducklang Core rewrite ${proposal.rule} ${subject} value ${valueId} belongs to function ${
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
      `Ducklang Core rewrite ${proposal.rule} profit must be a non-negative integer; received ${proposal.profit}`,
    );
  }
}

function valueKey(functionId: number, valueId: number): string {
  return `${functionId}:${valueId}`;
}

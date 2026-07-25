import { type FlatFcgPackage, validateFlatFcgPackage } from "./flat_fcg.ts";

export type FlatFcgRewriteRule =
  | "addZero"
  | "multiplyOne"
  | "selfLocalAssignment";

export type FlatFcgRewriteProposal = {
  readonly rule: FlatFcgRewriteRule;
  readonly functionIndex: number;
  readonly operationStart: number;
  readonly operationCount: number;
  readonly profit: number;
};

export type FlatFcgRewriteResult = {
  readonly package: FlatFcgPackage;
  readonly proposals: readonly FlatFcgRewriteProposal[];
  readonly accepted: readonly FlatFcgRewriteProposal[];
};

const rewriteRuleIds: Readonly<Record<FlatFcgRewriteRule, number>> = {
  addZero: 0,
  multiplyOne: 1,
  selfLocalAssignment: 2,
};

export function rewriteFlatFcg(
  snapshot: FlatFcgPackage,
): FlatFcgRewriteResult {
  const proposals = proposeFlatFcgRewrites(snapshot);
  const accepted = resolveFlatFcgRewriteConflicts(snapshot, proposals);
  return {
    package: rebuildFlatFcg(snapshot, accepted),
    proposals,
    accepted,
  };
}

export function proposeFlatFcgRewrites(
  snapshot: FlatFcgPackage,
): readonly FlatFcgRewriteProposal[] {
  const strings = validateFlatFcgPackage(snapshot);
  const proposals: FlatFcgRewriteProposal[] = [];
  for (
    let functionIndex = 0;
    functionIndex < snapshot.functionNameIds.length;
    functionIndex += 1
  ) {
    const operationStart = snapshot.functionOperationStarts[functionIndex];
    const operationCount = snapshot.functionOperationCounts[functionIndex];
    const operationEnd = operationStart + operationCount;
    for (
      let operationIndex = operationStart;
      operationIndex + 1 < operationEnd;
      operationIndex += 1
    ) {
      const nextOperationIndex = operationIndex + 1;
      const opcode = strings[snapshot.operationOpcodeIds[operationIndex]];
      const nextOpcode =
        strings[snapshot.operationOpcodeIds[nextOperationIndex]];
      if (
        snapshot.operationRegionIds[operationIndex] !==
          snapshot.operationRegionIds[nextOperationIndex]
      ) {
        continue;
      }
      const constant = scalarConstant(
        snapshot,
        strings,
        operationIndex,
        opcode,
      );
      if (
        constant === 0 &&
        (nextOpcode === "i32.+" || nextOpcode === "i64.+")
      ) {
        proposals.push({
          rule: "addZero",
          functionIndex,
          operationStart: operationIndex,
          operationCount: 2,
          profit: 2,
        });
        continue;
      }
      if (
        constant === 1 &&
        (nextOpcode === "i32.*" || nextOpcode === "i64.*")
      ) {
        proposals.push({
          rule: "multiplyOne",
          functionIndex,
          operationStart: operationIndex,
          operationCount: 2,
          profit: 2,
        });
        continue;
      }
      if (
        opcode === "local.get" && nextOpcode === "local.set" &&
        sameSingleWordOperand(snapshot, operationIndex, nextOperationIndex)
      ) {
        proposals.push({
          rule: "selfLocalAssignment",
          functionIndex,
          operationStart: operationIndex,
          operationCount: 2,
          profit: 2,
        });
      }
    }
  }
  return proposals;
}

export function resolveFlatFcgRewriteConflicts(
  snapshot: FlatFcgPackage,
  proposals: readonly FlatFcgRewriteProposal[],
): readonly FlatFcgRewriteProposal[] {
  validateFlatFcgPackage(snapshot);
  const ordered = [...proposals].sort((left, right) =>
    right.profit - left.profit ||
    left.functionIndex - right.functionIndex ||
    left.operationStart - right.operationStart ||
    rewriteRuleIds[left.rule] - rewriteRuleIds[right.rule]
  );
  const claimed = new Uint8Array(snapshot.operationOpcodeIds.length);
  const accepted: FlatFcgRewriteProposal[] = [];
  for (const proposal of ordered) {
    validateProposal(snapshot, proposal);
    let conflicts = false;
    for (
      let operationIndex = proposal.operationStart;
      operationIndex < proposal.operationStart + proposal.operationCount;
      operationIndex += 1
    ) {
      if (claimed[operationIndex] !== 0) {
        conflicts = true;
        break;
      }
    }
    if (conflicts) continue;
    claimed.fill(
      1,
      proposal.operationStart,
      proposal.operationStart + proposal.operationCount,
    );
    accepted.push(proposal);
  }
  return accepted.sort((left, right) =>
    left.operationStart - right.operationStart ||
    rewriteRuleIds[left.rule] - rewriteRuleIds[right.rule]
  );
}

export function rebuildFlatFcg(
  snapshot: FlatFcgPackage,
  accepted: readonly FlatFcgRewriteProposal[],
): FlatFcgPackage {
  validateFlatFcgPackage(snapshot);
  const removed = new Uint8Array(snapshot.operationOpcodeIds.length);
  for (const proposal of accepted) {
    validateProposal(snapshot, proposal);
    for (
      let operationIndex = proposal.operationStart;
      operationIndex < proposal.operationStart + proposal.operationCount;
      operationIndex += 1
    ) {
      if (removed[operationIndex] !== 0) {
        throw new TypeError(
          `accepted flat FCG rewrites overlap at operation ${operationIndex}`,
        );
      }
      removed[operationIndex] = 1;
    }
  }

  const functionOperationStarts: number[] = [];
  const functionOperationCounts: number[] = [];
  const operationOpcodeIds: number[] = [];
  const operationOperandStarts: number[] = [];
  const operationOperandCounts: number[] = [];
  const operationSourceStarts: number[] = [];
  const operationRegionIds: number[] = [];
  const operandKinds: number[] = [];
  const operandWords: number[] = [];

  for (
    let functionIndex = 0;
    functionIndex < snapshot.functionNameIds.length;
    functionIndex += 1
  ) {
    const sourceStart = snapshot.functionOperationStarts[functionIndex];
    const sourceEnd = sourceStart +
      snapshot.functionOperationCounts[functionIndex];
    functionOperationStarts.push(operationOpcodeIds.length);
    let retainedCount = 0;
    for (
      let operationIndex = sourceStart;
      operationIndex < sourceEnd;
      operationIndex += 1
    ) {
      if (removed[operationIndex] !== 0) continue;
      operationOpcodeIds.push(snapshot.operationOpcodeIds[operationIndex]);
      operationSourceStarts.push(
        snapshot.operationSourceStarts[operationIndex],
      );
      operationRegionIds.push(snapshot.operationRegionIds[operationIndex]);
      operationOperandStarts.push(operandKinds.length);
      const operandStart = snapshot.operationOperandStarts[operationIndex];
      const operandCount = snapshot.operationOperandCounts[operationIndex];
      operationOperandCounts.push(operandCount);
      for (
        let operandIndex = operandStart;
        operandIndex < operandStart + operandCount;
        operandIndex += 1
      ) {
        operandKinds.push(snapshot.operandKinds[operandIndex]);
        operandWords.push(snapshot.operandWords[operandIndex]);
      }
      retainedCount += 1;
    }
    functionOperationCounts.push(retainedCount);
  }

  const rebuilt: FlatFcgPackage = {
    schemaVersion: snapshot.schemaVersion,
    stringBytes: snapshot.stringBytes.slice(),
    stringStarts: snapshot.stringStarts.slice(),
    stringLengths: snapshot.stringLengths.slice(),
    functionNameIds: snapshot.functionNameIds.slice(),
    functionParameterStarts: snapshot.functionParameterStarts.slice(),
    functionParameterCounts: snapshot.functionParameterCounts.slice(),
    functionLocalCounts: snapshot.functionLocalCounts.slice(),
    functionOperationStarts: new Uint32Array(functionOperationStarts),
    functionOperationCounts: new Uint32Array(functionOperationCounts),
    parameterNameIds: snapshot.parameterNameIds.slice(),
    operationOpcodeIds: new Uint32Array(operationOpcodeIds),
    operationOperandStarts: new Uint32Array(operationOperandStarts),
    operationOperandCounts: new Uint32Array(operationOperandCounts),
    operationSourceStarts: new Uint32Array(operationSourceStarts),
    operationRegionIds: new Uint32Array(operationRegionIds),
    operandKinds: new Uint32Array(operandKinds),
    operandWords: new Uint32Array(operandWords),
    constructorNameIds: snapshot.constructorNameIds.slice(),
    constructorTags: snapshot.constructorTags.slice(),
  };
  validateFlatFcgPackage(rebuilt);
  return rebuilt;
}

function scalarConstant(
  snapshot: FlatFcgPackage,
  strings: readonly string[],
  operationIndex: number,
  opcode: string,
): number | undefined {
  if (opcode !== "const" && opcode !== "i64.const") return undefined;
  if (snapshot.operationOperandCounts[operationIndex] !== 1) return undefined;
  const operandIndex = snapshot.operationOperandStarts[operationIndex];
  const kind = snapshot.operandKinds[operandIndex];
  const word = snapshot.operandWords[operandIndex];
  if (kind === 0) return word | 0;
  if (kind === 1) return word;
  if (kind !== 2) return undefined;
  const value = strings[word];
  return value === "0" ? 0 : value === "1" ? 1 : undefined;
}

function sameSingleWordOperand(
  snapshot: FlatFcgPackage,
  leftOperation: number,
  rightOperation: number,
): boolean {
  if (
    snapshot.operationOperandCounts[leftOperation] !== 1 ||
    snapshot.operationOperandCounts[rightOperation] !== 1
  ) {
    return false;
  }
  const leftOperand = snapshot.operationOperandStarts[leftOperation];
  const rightOperand = snapshot.operationOperandStarts[rightOperation];
  return snapshot.operandKinds[leftOperand] ===
      snapshot.operandKinds[rightOperand] &&
    snapshot.operandWords[leftOperand] === snapshot.operandWords[rightOperand];
}

function validateProposal(
  snapshot: FlatFcgPackage,
  proposal: FlatFcgRewriteProposal,
): void {
  if (
    !Number.isSafeInteger(proposal.functionIndex) ||
    proposal.functionIndex < 0 ||
    proposal.functionIndex >= snapshot.functionNameIds.length
  ) {
    throw new RangeError(
      `flat FCG rewrite ${proposal.rule} uses function ${proposal.functionIndex}; package contains ${snapshot.functionNameIds.length} functions`,
    );
  }
  if (
    !Number.isSafeInteger(proposal.operationCount) ||
    proposal.operationCount <= 0
  ) {
    throw new RangeError(
      `flat FCG rewrite ${proposal.rule} operation count must be positive; received ${proposal.operationCount}`,
    );
  }
  const functionStart =
    snapshot.functionOperationStarts[proposal.functionIndex];
  const functionEnd = functionStart +
    snapshot.functionOperationCounts[proposal.functionIndex];
  if (
    !Number.isSafeInteger(proposal.operationStart) ||
    proposal.operationStart < functionStart ||
    proposal.operationStart + proposal.operationCount > functionEnd
  ) {
    throw new RangeError(
      `flat FCG rewrite ${proposal.rule} range [${proposal.operationStart}, ${
        proposal.operationStart + proposal.operationCount
      }) is outside function ${proposal.functionIndex} operation range [${functionStart}, ${functionEnd})`,
    );
  }
  if (!Number.isSafeInteger(proposal.profit) || proposal.profit < 0) {
    throw new RangeError(
      `flat FCG rewrite ${proposal.rule} profit must be a non-negative integer; received ${proposal.profit}`,
    );
  }
}

import {
  type CoreBlockId,
  type CoreFunctionId,
  type CoreTypeId,
  type CoreValueId,
  type DucklangCoreBlock,
  type DucklangCoreFunction,
  type DucklangCoreModule,
  type DucklangCoreOperation,
  validateDucklangCore,
} from "./ducklang_core.ts";
import { PrimitiveId } from "./ducklang_primitives.ts";
import type { DucklangBinaryOperator } from "./ducklang_types.ts";

export type DucklangVectorPackSource =
  | {
    readonly kind: "previous";
    readonly group: number;
    readonly values: readonly CoreValueId[];
  }
  | {
    readonly kind: "splat";
    readonly value: CoreValueId;
  }
  | {
    readonly kind: "pack";
    readonly values: readonly CoreValueId[];
  };

export type DucklangVectorGroup = {
  readonly operationIndices: readonly number[];
  readonly resultValues: readonly CoreValueId[];
  readonly operator: Extract<DucklangBinaryOperator, "+" | "-" | "*" | "/">;
  readonly left: DucklangVectorPackSource;
  readonly right: DucklangVectorPackSource;
  readonly extractedLanes: readonly number[];
};

export type DucklangVectorPlan = {
  readonly schemaVersion: 1;
  readonly recipe: "f32x4-slp-v1";
  readonly vectorFactor: 4;
  readonly element: "f32";
  readonly requiredTarget: "wasm-simd128";
  readonly residualEffect: "empty";
  readonly ownership: "not-applicable";
  readonly scalarFallback: "input-snapshot";
  readonly functionId: CoreFunctionId;
  readonly blockId: CoreBlockId;
  readonly groups: readonly DucklangVectorGroup[];
  readonly scalarOperationCost: number;
  readonly vectorRecipeCost: number;
  readonly profit: number;
};

export type DucklangVectorizationMetrics = {
  readonly candidateWindowCount: number;
  readonly proposedPlanCount: number;
  readonly acceptedPlanCount: number;
  readonly scalarOperationCount: number;
  readonly vectorOperationCount: number;
  readonly packCount: number;
  readonly splatCount: number;
  readonly extractCount: number;
  readonly estimatedScalarCost: number;
  readonly estimatedVectorCost: number;
};

export type DucklangVectorizationResult = {
  readonly module: DucklangCoreModule;
  readonly proposals: readonly DucklangVectorPlan[];
  readonly accepted: readonly DucklangVectorPlan[];
  readonly metrics: DucklangVectorizationMetrics;
  readonly validationMilliseconds: number;
  readonly planningMilliseconds: number;
  readonly rebuildMilliseconds: number;
};

type ScalarUse = {
  readonly blockId: CoreBlockId;
  readonly operationIndex: number | undefined;
  readonly operandIndex: number | undefined;
};

type CandidateWindow = {
  readonly eligibleStart: number;
  readonly operationIndices: readonly number[];
  readonly resultValues: readonly CoreValueId[];
  readonly operator: DucklangVectorGroup["operator"];
  readonly leftValues: readonly CoreValueId[];
  readonly rightValues: readonly CoreValueId[];
};

type BlockAnalysis = {
  readonly windows: readonly CandidateWindow[];
  readonly uses: ReadonlyMap<CoreValueId, readonly ScalarUse[]>;
  readonly constants: ReadonlyMap<
    CoreValueId,
    {
      readonly value: string | number | bigint | boolean | undefined;
      readonly type: CoreTypeId;
    }
  >;
};

export function vectorizeDucklangCore(
  snapshot: DucklangCoreModule,
): DucklangVectorizationResult {
  const validationStart = performance.now();
  validateDucklangCore(snapshot);
  let validationMilliseconds = performance.now() - validationStart;
  const planningStart = performance.now();
  const discovery = discoverValidatedDucklangVectorPlans(snapshot);
  const accepted = resolveCanonicalDucklangVectorPlans(
    discovery.proposals,
    discovery.proposals,
  );
  const planningMilliseconds = performance.now() - planningStart;
  if (accepted.length === 0) {
    return {
      module: snapshot,
      proposals: discovery.proposals,
      accepted,
      metrics: vectorizationMetrics(
        discovery.candidateWindowCount,
        discovery.proposals.length,
        accepted,
      ),
      validationMilliseconds,
      planningMilliseconds,
      rebuildMilliseconds: 0,
    };
  }
  const rebuildStart = performance.now();
  const module = rebuildDucklangCoreWithVectorPlans(snapshot, accepted);
  const rebuildMilliseconds = performance.now() - rebuildStart;
  const rebuiltValidationStart = performance.now();
  validateDucklangCore(module);
  validationMilliseconds += performance.now() - rebuiltValidationStart;
  return {
    module,
    proposals: discovery.proposals,
    accepted,
    metrics: vectorizationMetrics(
      discovery.candidateWindowCount,
      discovery.proposals.length,
      accepted,
    ),
    validationMilliseconds,
    planningMilliseconds,
    rebuildMilliseconds,
  };
}

export function discoverDucklangVectorPlans(
  snapshot: DucklangCoreModule,
): {
  readonly proposals: readonly DucklangVectorPlan[];
  readonly candidateWindowCount: number;
} {
  validateDucklangCore(snapshot);
  return discoverValidatedDucklangVectorPlans(snapshot);
}

function discoverValidatedDucklangVectorPlans(
  snapshot: DucklangCoreModule,
): {
  readonly proposals: readonly DucklangVectorPlan[];
  readonly candidateWindowCount: number;
} {
  if (observesFloatingPointBits(snapshot)) {
    return { proposals: [], candidateWindowCount: 0 };
  }
  const proposals: DucklangVectorPlan[] = [];
  let candidateWindowCount = 0;
  for (const function_ of snapshot.functions) {
    const valueTypes = collectFunctionValueTypes(function_);
    const uses = collectScalarUses(function_);
    for (const block of function_.blocks) {
      const analysis = analyzeBlock(snapshot, block, valueTypes, uses);
      candidateWindowCount += analysis.windows.length;
      proposals.push(
        ...bestPlansForBlock(function_, block, analysis),
      );
    }
  }
  return {
    proposals: proposals.sort(comparePlansBySourceOrder),
    candidateWindowCount,
  };
}

function observesFloatingPointBits(snapshot: DucklangCoreModule): boolean {
  return snapshot.functions.some((function_) =>
    function_.blocks.some((block) =>
      block.operations.some((operation) =>
        operation.kind === "primitive" &&
        operation.primitiveId === PrimitiveId.i32ReinterpretF32
      )
    )
  );
}

export function validateDucklangVectorPlan(
  snapshot: DucklangCoreModule,
  plan: DucklangVectorPlan,
): void {
  const discovered = discoverDucklangVectorPlans(snapshot).proposals;
  requireCanonicalPlan(indexCanonicalPlans(discovered), plan);
}

export function resolveDucklangVectorPlanConflicts(
  snapshot: DucklangCoreModule,
  proposals: readonly DucklangVectorPlan[],
): readonly DucklangVectorPlan[] {
  const canonical = discoverDucklangVectorPlans(snapshot).proposals;
  return resolveCanonicalDucklangVectorPlans(canonical, proposals);
}

function resolveCanonicalDucklangVectorPlans(
  canonical: readonly DucklangVectorPlan[],
  proposals: readonly DucklangVectorPlan[],
): readonly DucklangVectorPlan[] {
  const claimed = new Set<string>();
  const accepted: DucklangVectorPlan[] = [];
  const canonicalIndex = indexCanonicalPlans(canonical);
  const ordered = [...proposals].sort((left, right) =>
    right.profit - left.profit || comparePlansBySourceOrder(left, right)
  );
  for (const proposal of ordered) {
    requireCanonicalPlan(canonicalIndex, proposal);
    const operations = proposal.groups.flatMap((group) =>
      group.operationIndices.map((operationIndex) =>
        `${proposal.functionId}:${proposal.blockId}:${operationIndex}`
      )
    );
    if (operations.some((operation) => claimed.has(operation))) continue;
    operations.forEach((operation) => claimed.add(operation));
    accepted.push(proposal);
  }
  return accepted.sort(comparePlansBySourceOrder);
}

function analyzeBlock(
  module: DucklangCoreModule,
  block: DucklangCoreBlock,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
  uses: ReadonlyMap<CoreValueId, readonly ScalarUse[]>,
): BlockAnalysis {
  const eligible = block.operations.flatMap((operation, operationIndex) =>
    isVectorizableF32Binary(module, valueTypes, operation)
      ? [{ operation, operationIndex }]
      : []
  );
  const windows: CandidateWindow[] = [];
  for (let start = 0; start + 4 <= eligible.length; start += 1) {
    const entries = eligible.slice(start, start + 4);
    const first = entries[0];
    if (
      entries.some((entry) =>
        entry.operation.operator !== first.operation.operator
      ) ||
      crossesNonScalarWork(
        block,
        entries.map((entry) => entry.operationIndex),
      )
    ) {
      continue;
    }
    const resultValues = entries.map((entry) => entry.operation.result);
    if (
      entries.some((entry) =>
        entry.operation.operands.some((operand) =>
          resultValues.includes(operand)
        )
      )
    ) {
      continue;
    }
    windows.push({
      eligibleStart: start,
      operationIndices: entries.map((entry) => entry.operationIndex),
      resultValues,
      operator: first.operation.operator as CandidateWindow["operator"],
      leftValues: entries.map((entry) => entry.operation.operands[0]),
      rightValues: entries.map((entry) => entry.operation.operands[1]),
    });
  }
  return {
    windows,
    uses,
    constants: new Map(
      block.operations.flatMap((operation) =>
        operation.kind === "constant"
          ? [
            [operation.result, {
              value: operation.value,
              type: operation.type,
            }] as const,
          ]
          : []
      ),
    ),
  };
}

function bestPlansForBlock(
  function_: DucklangCoreFunction,
  block: DucklangCoreBlock,
  analysis: BlockAnalysis,
): readonly DucklangVectorPlan[] {
  const proposals: DucklangVectorPlan[] = [];
  for (let phase = 0; phase < 4; phase += 1) {
    const aligned = analysis.windows.filter((window) =>
      window.eligibleStart % 4 === phase
    );
    let chain: CandidateWindow[] = [];
    let chainResults = new Set<string>();
    const finishChain = (): void => {
      const plan = bestPrefix(
        function_,
        block,
        chain,
        analysis.uses,
        analysis.constants,
      );
      if (plan !== undefined) proposals.push(plan);
      chain = [];
      chainResults = new Set();
    };
    for (const window of aligned) {
      const previous = chain.at(-1);
      if (
        previous === undefined ||
        (window.operationIndices[0] > previous.operationIndices[3] &&
          (chainResults.has(vectorValueKey(window.leftValues)) ||
            chainResults.has(vectorValueKey(window.rightValues))))
      ) {
        chain.push(window);
        chainResults.add(vectorValueKey(window.resultValues));
        continue;
      }
      finishChain();
      chain.push(window);
      chainResults.add(vectorValueKey(window.resultValues));
    }
    finishChain();
  }
  const unique = new Map<string, DucklangVectorPlan>();
  for (const plan of proposals) unique.set(vectorPlanKey(plan), plan);
  return [...unique.values()];
}

function bestPrefix(
  function_: DucklangCoreFunction,
  block: DucklangCoreBlock,
  chain: readonly CandidateWindow[],
  uses: ReadonlyMap<CoreValueId, readonly ScalarUse[]>,
  constants: BlockAnalysis["constants"],
): DucklangVectorPlan | undefined {
  const uncoveredUses = new Map<CoreValueId, number>();
  let recipeWithoutExtracts = 0;
  let extractionCount = 0;
  let bestLength = 0;
  let bestProfit = 0;
  const previousGroups = indexVectorGroups(chain);
  for (let group = 0; group < chain.length; group += 1) {
    const window = chain[group];
    const left = classifyPackSource(
      window.leftValues,
      previousGroups,
      group,
      constants,
    );
    const right = classifyPackSource(
      window.rightValues,
      previousGroups,
      group,
      constants,
    );
    recipeWithoutExtracts += 1 + packSourceCost(left) + packSourceCost(right);
    extractionCount -= coverPreviousScalarUses(left, uncoveredUses);
    extractionCount -= coverPreviousScalarUses(right, uncoveredUses);
    for (const value of window.resultValues) {
      const count = (uses.get(value) ?? []).length;
      uncoveredUses.set(value, count);
      if (count > 0) extractionCount += 1;
    }
    const scalarCost = (group + 1) * 4;
    const profit = scalarCost - recipeWithoutExtracts - extractionCount;
    if (profit > bestProfit) {
      bestProfit = profit;
      bestLength = group + 1;
    }
  }
  if (bestLength === 0) return undefined;
  return materializePlan(
    function_,
    block,
    chain.slice(0, bestLength),
    uses,
    constants,
  );
}

function coverPreviousScalarUses(
  source: DucklangVectorPackSource,
  uncoveredUses: Map<CoreValueId, number>,
): number {
  if (source.kind !== "previous") return 0;
  let eliminatedExtractions = 0;
  for (const value of source.values) {
    const previous = uncoveredUses.get(value);
    if (previous === undefined || previous === 0) {
      throw new Error(`vector plan covered unavailable scalar value ${value}`);
    }
    const next = previous - 1;
    uncoveredUses.set(value, next);
    if (next === 0) eliminatedExtractions += 1;
  }
  return eliminatedExtractions;
}

function materializePlan(
  function_: DucklangCoreFunction,
  block: DucklangCoreBlock,
  windows: readonly CandidateWindow[],
  uses: ReadonlyMap<CoreValueId, readonly ScalarUse[]>,
  constants: BlockAnalysis["constants"],
): DucklangVectorPlan {
  const coveredUses = new Set<string>();
  const previousGroups = indexVectorGroups(windows);
  const provisional = windows.map((window, group) => {
    const left = classifyPackSource(
      window.leftValues,
      previousGroups,
      group,
      constants,
    );
    const right = classifyPackSource(
      window.rightValues,
      previousGroups,
      group,
      constants,
    );
    markCoveredUses(coveredUses, block.id, window, left, 0);
    markCoveredUses(coveredUses, block.id, window, right, 1);
    return { window, left, right };
  });
  const groups = provisional.map(({ window, left, right }) => ({
    operationIndices: window.operationIndices,
    resultValues: window.resultValues,
    operator: window.operator,
    left,
    right,
    extractedLanes: window.resultValues.flatMap((value, lane) =>
      (uses.get(value) ?? []).some((use) =>
          !coveredUses.has(scalarUseKey(value, use))
        )
        ? [lane]
        : []
    ),
  }));
  const scalarOperationCost = groups.length * 4;
  const vectorRecipeCost = groups.reduce(
    (cost, group) =>
      cost + 1 + packSourceCost(group.left) + packSourceCost(group.right) +
      group.extractedLanes.length,
    0,
  );
  return {
    schemaVersion: 1,
    recipe: "f32x4-slp-v1",
    vectorFactor: 4,
    element: "f32",
    requiredTarget: "wasm-simd128",
    residualEffect: "empty",
    ownership: "not-applicable",
    scalarFallback: "input-snapshot",
    functionId: function_.id,
    blockId: block.id,
    groups,
    scalarOperationCost,
    vectorRecipeCost,
    profit: scalarOperationCost - vectorRecipeCost,
  };
}

function classifyPackSource(
  values: readonly CoreValueId[],
  previousGroups: ReadonlyMap<string, number>,
  group: number,
  constants: BlockAnalysis["constants"],
): DucklangVectorPackSource {
  const previous = previousGroups.get(vectorValueKey(values));
  if (previous !== undefined && previous < group) {
    return { kind: "previous", group: previous, values };
  }
  if (values.every((value) => value === values[0])) {
    return { kind: "splat", value: values[0] };
  }
  const first = constants.get(values[0]);
  if (
    first !== undefined && values.every((value) => {
      const constant = constants.get(value);
      return constant !== undefined && constant.type === first.type &&
        Object.is(constant.value, first.value);
    })
  ) {
    return { kind: "splat", value: values[0] };
  }
  return { kind: "pack", values };
}

function indexVectorGroups(
  windows: readonly CandidateWindow[],
): ReadonlyMap<string, number> {
  return new Map(
    windows.map((
      window,
      group,
    ) => [vectorValueKey(window.resultValues), group]),
  );
}

function vectorValueKey(values: readonly CoreValueId[]): string {
  return values.join(":");
}

function markCoveredUses(
  covered: Set<string>,
  blockId: CoreBlockId,
  window: CandidateWindow,
  source: DucklangVectorPackSource,
  operandIndex: number,
): void {
  if (source.kind !== "previous") return;
  source.values.forEach((value, lane) =>
    covered.add(
      scalarUseKey(value, {
        blockId,
        operationIndex: window.operationIndices[lane],
        operandIndex,
      }),
    )
  );
}

function collectScalarUses(
  function_: DucklangCoreFunction,
): ReadonlyMap<CoreValueId, readonly ScalarUse[]> {
  const uses = new Map<CoreValueId, ScalarUse[]>();
  const add = (value: CoreValueId, use: ScalarUse): void => {
    const entries = uses.get(value) ?? [];
    entries.push(use);
    uses.set(value, entries);
  };
  for (const block of function_.blocks) {
    block.operations.forEach((operation, operationIndex) =>
      operation.operands.forEach((value, operandIndex) =>
        add(value, { blockId: block.id, operationIndex, operandIndex })
      )
    );
    for (const value of terminatorValues(block)) {
      add(value, {
        blockId: block.id,
        operationIndex: undefined,
        operandIndex: undefined,
      });
    }
  }
  return uses;
}

function rebuildDucklangCoreWithVectorPlans(
  snapshot: DucklangCoreModule,
  plans: readonly DucklangVectorPlan[],
): DucklangCoreModule {
  const existingVectorType = snapshot.types.findIndex((type) =>
    type.kind === "vector" && type.lanes === 4 && type.element === "f32"
  );
  const vectorType =
    (existingVectorType === -1
      ? snapshot.types.length
      : existingVectorType) as CoreTypeId;
  const types = existingVectorType === -1
    ? [...snapshot.types, {
      kind: "vector" as const,
      lanes: 4 as const,
      element: "f32" as const,
    }]
    : snapshot.types;
  const plansByBlock = new Map<string, DucklangVectorPlan[]>();
  for (const plan of plans) {
    const key = `${plan.functionId}:${plan.blockId}`;
    const blockPlans = plansByBlock.get(key) ?? [];
    blockPlans.push(plan);
    plansByBlock.set(key, blockPlans);
  }
  const functions = snapshot.functions.map((function_) => {
    let nextValue = maximumValueId(function_) + 1;
    const blocks = function_.blocks.map((block) => {
      const blockPlans = plansByBlock.get(`${function_.id}:${block.id}`);
      if (blockPlans === undefined) return block;
      const removed = new Set(
        blockPlans.flatMap((plan) =>
          plan.groups.flatMap((group) => group.operationIndices)
        ),
      );
      const insertion = new Map<
        number,
        { readonly planIndex: number; readonly group: DucklangVectorGroup }
      >();
      blockPlans.forEach((plan, planIndex) =>
        plan.groups.forEach((group) =>
          insertion.set(group.operationIndices.at(-1)!, { planIndex, group })
        )
      );
      const vectorResults = blockPlans.map(() => [] as CoreValueId[]);
      const operations: DucklangCoreOperation[] = [];
      block.operations.forEach((operation, operationIndex) => {
        if (!removed.has(operationIndex)) {
          operations.push(operation);
          return;
        }
        const scheduled = insertion.get(operationIndex);
        if (scheduled === undefined) return;
        const group = scheduled.group;
        const planResults = vectorResults[scheduled.planIndex];
        const left = emitPackSource(
          operations,
          group.left,
          planResults,
          vectorType,
          () => nextValue++ as CoreValueId,
          operation,
        );
        const right = emitPackSource(
          operations,
          group.right,
          planResults,
          vectorType,
          () => nextValue++ as CoreValueId,
          operation,
        );
        const vectorResult = nextValue++ as CoreValueId;
        operations.push({
          kind: "primitive",
          primitiveId: vectorPrimitive(group.operator),
          result: vectorResult,
          type: vectorType,
          operands: [left, right],
          span: operation.span,
        });
        planResults.push(vectorResult);
        for (const lane of group.extractedLanes) {
          operations.push({
            kind: "primitive",
            primitiveId: extractLanePrimitive(lane),
            result: group.resultValues[lane],
            type: operation.type,
            operands: [vectorResult],
            span: block.operations[group.operationIndices[lane]].span,
          });
        }
      });
      return { ...block, operations };
    });
    return { ...function_, blocks };
  });
  return { ...snapshot, types, functions };
}

function emitPackSource(
  operations: DucklangCoreOperation[],
  source: DucklangVectorPackSource,
  vectorResults: readonly CoreValueId[],
  vectorType: CoreTypeId,
  nextValue: () => CoreValueId,
  insertionOperation: DucklangCoreOperation,
): CoreValueId {
  if (source.kind === "previous") return vectorResults[source.group];
  const result = nextValue();
  operations.push({
    kind: "primitive",
    primitiveId: source.kind === "splat"
      ? PrimitiveId.f32x4Splat
      : PrimitiveId.f32x4Make,
    result,
    type: vectorType,
    operands: source.kind === "splat" ? [source.value] : source.values,
    span: insertionOperation.span,
  });
  return result;
}

function isVectorizableF32Binary(
  module: DucklangCoreModule,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
  operation: DucklangCoreOperation,
): operation is Extract<
  DucklangCoreOperation,
  { readonly kind: "scalar.binary" }
> {
  if (
    operation.kind !== "scalar.binary" ||
    !["+", "-", "*", "/"].includes(operation.operator) ||
    operation.operands.length !== 2
  ) {
    return false;
  }
  const result = module.types[operation.type];
  return result.kind === "scalar" && result.scalar === "f32" &&
    operation.operands.every((operand) => {
      const operandType = valueTypes.get(operand);
      if (operandType === undefined) return false;
      const type = module.types[operandType];
      return type.kind === "scalar" && type.scalar === "f32";
    });
}

function crossesNonScalarWork(
  block: DucklangCoreBlock,
  operationIndices: readonly number[],
): boolean {
  const candidate = new Set(operationIndices);
  const first = operationIndices[0];
  const last = operationIndices.at(-1)!;
  return block.operations.slice(first, last + 1).some((operation, offset) =>
    operation.kind !== "constant" && !candidate.has(first + offset)
  );
}

function packSourceCost(source: DucklangVectorPackSource): number {
  if (source.kind === "previous") return 0;
  return source.kind === "splat" ? 1 : 4;
}

function vectorPrimitive(
  operator: DucklangVectorGroup["operator"],
): PrimitiveId {
  if (operator === "+") return PrimitiveId.f32x4Add;
  if (operator === "-") return PrimitiveId.f32x4Subtract;
  if (operator === "*") return PrimitiveId.f32x4Multiply;
  return PrimitiveId.f32x4Divide;
}

function extractLanePrimitive(lane: number): PrimitiveId {
  const ids = [
    PrimitiveId.f32x4ExtractLane0,
    PrimitiveId.f32x4ExtractLane1,
    PrimitiveId.f32x4ExtractLane2,
    PrimitiveId.f32x4ExtractLane3,
  ] as const;
  const id = ids[lane];
  if (id !== undefined) return id;
  throw new RangeError(
    `f32x4 extraction lane must be in 0..3; received ${lane}`,
  );
}

function vectorizationMetrics(
  candidateWindowCount: number,
  proposedPlanCount: number,
  accepted: readonly DucklangVectorPlan[],
): DucklangVectorizationMetrics {
  const groups = accepted.flatMap((plan) => plan.groups);
  const sources = groups.flatMap((group) => [group.left, group.right]);
  return {
    candidateWindowCount,
    proposedPlanCount,
    acceptedPlanCount: accepted.length,
    scalarOperationCount: groups.length * 4,
    vectorOperationCount: groups.length,
    packCount: sources.filter((source) => source.kind === "pack").length,
    splatCount: sources.filter((source) => source.kind === "splat").length,
    extractCount: groups.reduce(
      (count, group) => count + group.extractedLanes.length,
      0,
    ),
    estimatedScalarCost: accepted.reduce(
      (cost, plan) => cost + plan.scalarOperationCost,
      0,
    ),
    estimatedVectorCost: accepted.reduce(
      (cost, plan) => cost + plan.vectorRecipeCost,
      0,
    ),
  };
}

function requireCanonicalPlan(
  canonicalPlans: ReadonlySet<string>,
  plan: DucklangVectorPlan,
): void {
  const key = vectorPlanKey(plan);
  if (canonicalPlans.has(canonicalPlanKey(plan))) return;
  throw new TypeError(
    `Core vector plan ${key} does not match the validated snapshot`,
  );
}

function indexCanonicalPlans(
  plans: readonly DucklangVectorPlan[],
): ReadonlySet<string> {
  return new Set(plans.map(canonicalPlanKey));
}

function canonicalPlanKey(plan: DucklangVectorPlan): string {
  return `${vectorPlanKey(plan)}:${JSON.stringify(plan)}`;
}

function comparePlansBySourceOrder(
  left: DucklangVectorPlan,
  right: DucklangVectorPlan,
): number {
  return left.functionId - right.functionId || left.blockId - right.blockId ||
    left.groups[0].operationIndices[0] - right.groups[0].operationIndices[0] ||
    left.groups.length - right.groups.length;
}

function vectorPlanKey(plan: DucklangVectorPlan): string {
  return `${plan.functionId}:${plan.blockId}:${
    plan.groups[0].operationIndices[0]
  }:${plan.groups.length}`;
}

function scalarUseKey(value: CoreValueId, use: ScalarUse): string {
  return `${value}:${use.blockId}:${use.operationIndex ?? "terminator"}:${
    use.operandIndex ?? "value"
  }`;
}

function maximumValueId(function_: DucklangCoreFunction): number {
  let maximum = -1;
  for (const block of function_.blocks) {
    for (const parameter of block.parameters) {
      maximum = Math.max(maximum, parameter.value);
    }
    for (const operation of block.operations) {
      maximum = Math.max(maximum, operation.result);
    }
  }
  return maximum;
}

function collectFunctionValueTypes(
  function_: DucklangCoreFunction,
): ReadonlyMap<CoreValueId, CoreTypeId> {
  const valueTypes = new Map<CoreValueId, CoreTypeId>();
  for (const block of function_.blocks) {
    for (const parameter of block.parameters) {
      valueTypes.set(parameter.value, parameter.type);
    }
    for (const operation of block.operations) {
      valueTypes.set(operation.result, operation.type);
    }
  }
  return valueTypes;
}

function terminatorValues(block: DucklangCoreBlock): readonly CoreValueId[] {
  const terminator = block.terminator;
  if (terminator.kind === "branch") return terminator.arguments;
  if (terminator.kind === "conditional_branch") {
    return [
      terminator.condition,
      ...terminator.trueArguments,
      ...terminator.falseArguments,
    ];
  }
  return terminator.kind === "return" ? terminator.values : [];
}

import type {
  TypedDucklangBinding,
  TypedDucklangBlockStep,
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";
import { PrimitiveId } from "./ducklang_primitives.ts";
import {
  ducklangReflectedLayout,
  type DucklangReflectedType,
} from "./ducklang_layout.ts";
import type { DucklangSymbol } from "./ducklang_resolution.ts";
import type { SourceSpan } from "./syntax.ts";

export type DucklangSpecializationMetrics = {
  readonly inputBindingCount: number;
  readonly demandedBindingCount: number;
  readonly rewrittenBindingCount: number;
  readonly residualBindingCount: number;
  readonly inputNodeCount: number;
  readonly demandedInputNodeCount: number;
  readonly rewrittenInputNodeCount: number;
  readonly residualNodeCount: number;
  readonly distinctSpecializationKeyCount: number;
  readonly specializationCacheHitCount: number;
  readonly pendingSpecializationCycleCount: number;
  readonly functionConstructingIntrinsicFoldCount: number;
  readonly rejectedOptionalRequestCount: number;
  readonly widenedRequestCount: 0;
  readonly requestsByFunction: readonly DucklangFunctionSpecializationMetrics[];
  readonly distinctFunctionAnalysisCount: number;
  readonly functionAnalysisCacheHitCount: number;
  readonly rewrittenBlockCount: number;
  readonly avoidedEnvironmentEntryCopyCount: number;
  readonly nodeCountCacheHitCount: number;
  readonly nodeCountCacheHitNodeCount: number;
};

export type DucklangFunctionSpecializationMetrics = {
  readonly functionId: number;
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly sourceBodyNodeCount: number;
  readonly emittedRequestCount: number;
  readonly reusedRequestCount: number;
  readonly pendingCycleCount: number;
  readonly emittedNodeCount: number;
  readonly residualNodeAmplification: number;
};

export type DucklangSpecializationResult = {
  readonly module: TypedDucklangModule;
  readonly metrics: DucklangSpecializationMetrics;
  readonly timings: {
    readonly demandMilliseconds: number;
    readonly frontierMilliseconds: number;
    readonly rewriteMilliseconds: number;
    readonly liftingMilliseconds: number;
    readonly reachabilityMilliseconds: number;
    readonly accountingMilliseconds: number;
  };
};

export type DucklangSpecializationFrontier = {
  readonly changedBindingSymbols: ReadonlySet<number>;
  readonly resultChanged: boolean;
};

type FunctionSpecializationAnalysis = {
  readonly body: TypedDucklangExpression;
  readonly referencedSymbols: ReadonlySet<number>;
  readonly parameterSymbols: ReadonlySet<number>;
  readonly directlyCalledSymbols: ReadonlySet<number>;
};

type SpecializationContext = {
  readonly requests: Map<
    string,
    | { readonly status: "pending" }
    | {
      readonly status: "complete";
      readonly expression: TypedDucklangExpression;
    }
  >;
  readonly functionIds: WeakMap<object, number>;
  readonly functionAnalyses: WeakMap<
    object,
    FunctionSpecializationAnalysis | null
  >;
  readonly typeIdentities: WeakMap<object, string>;
  readonly valueIds: WeakMap<object, number>;
  readonly substitutionEnvironments: ReadonlyMap<
    number,
    TypedDucklangExpression
  >[];
  readonly requestFunctions: Map<number, {
    readonly functionId: number;
    readonly file: string;
    readonly start: number;
    readonly end: number;
    readonly body: TypedDucklangExpression;
    readonly emittedExpressions: TypedDucklangExpression[];
    reusedRequestCount: number;
    pendingCycleCount: number;
  }>;
  nextFunctionId: number;
  nextValueId: number;
  cacheHitCount: number;
  pendingCycleCount: number;
  distinctFunctionAnalysisCount: number;
  functionAnalysisCacheHitCount: number;
  rewrittenBlockCount: number;
  avoidedEnvironmentEntryCopyCount: number;
  rejectedOptionalRequestCount: number;
  functionConstructingIntrinsicFoldCount: number;
};

export function specializeStaticDucklangClosures(
  module: TypedDucklangModule,
  frontier?: DucklangSpecializationFrontier,
): DucklangSpecializationResult {
  const demandStart = performance.now();
  const inputBindingsBySymbol = new Map(
    module.bindings.map((binding) => [binding.symbol.id, binding]),
  );
  const demandedBindingSymbols = new Set<number>();
  const pendingBindingSymbols: number[] = [];
  const demandExpression = (expression: TypedDucklangExpression): void => {
    const references = new Set<number>();
    collectReferences(expression, references);
    for (const symbolId of references) {
      if (
        demandedBindingSymbols.has(symbolId) ||
        !inputBindingsBySymbol.has(symbolId)
      ) {
        continue;
      }
      demandedBindingSymbols.add(symbolId);
      pendingBindingSymbols.push(symbolId);
    }
  };
  demandExpression(module.result);
  for (const binding of module.bindings) {
    if (binding.stage !== "runtime" || binding.value.kind === "function") {
      continue;
    }
    if (demandedBindingSymbols.has(binding.symbol.id)) continue;
    demandedBindingSymbols.add(binding.symbol.id);
    pendingBindingSymbols.push(binding.symbol.id);
  }
  while (pendingBindingSymbols.length > 0) {
    const symbolId = pendingBindingSymbols.pop()!;
    demandExpression(inputBindingsBySymbol.get(symbolId)!.value);
  }
  const demandedInputBindings = module.bindings.filter((binding) =>
    demandedBindingSymbols.has(binding.symbol.id)
  );
  const demandMilliseconds = performance.now() - demandStart;

  const frontierStart = performance.now();
  const rewrittenBindingSymbols = frontier === undefined
    ? new Set(demandedBindingSymbols)
    : new Set(
      [...frontier.changedBindingSymbols].filter((symbolId) =>
        demandedBindingSymbols.has(symbolId)
      ),
    );
  if (frontier !== undefined) {
    const dependentBindings = new Map<number, Set<number>>();
    for (const binding of demandedInputBindings) {
      const references = new Set<number>();
      collectReferences(binding.value, references);
      for (const referencedSymbol of references) {
        if (!demandedBindingSymbols.has(referencedSymbol)) continue;
        const dependents = dependentBindings.get(referencedSymbol) ??
          new Set<number>();
        dependents.add(binding.symbol.id);
        dependentBindings.set(referencedSymbol, dependents);
      }
    }
    const pendingChangedSymbols = [...rewrittenBindingSymbols];
    while (pendingChangedSymbols.length > 0) {
      const changedSymbol = pendingChangedSymbols.pop()!;
      for (const dependent of dependentBindings.get(changedSymbol) ?? []) {
        if (rewrittenBindingSymbols.has(dependent)) continue;
        rewrittenBindingSymbols.add(dependent);
        pendingChangedSymbols.push(dependent);
      }
    }
  }
  const resultReferences = new Set<number>();
  collectReferences(module.result, resultReferences);
  const rewriteResult = frontier === undefined || frontier.resultChanged ||
    [...resultReferences].some((symbolId) =>
      rewrittenBindingSymbols.has(symbolId)
    );
  const specialization: SpecializationContext = {
    requests: new Map(),
    functionIds: new WeakMap(),
    functionAnalyses: new WeakMap(),
    typeIdentities: new WeakMap(),
    valueIds: new WeakMap(),
    substitutionEnvironments: [],
    requestFunctions: new Map(),
    nextFunctionId: 0,
    nextValueId: 0,
    cacheHitCount: 0,
    pendingCycleCount: 0,
    distinctFunctionAnalysisCount: 0,
    functionAnalysisCacheHitCount: 0,
    rewrittenBlockCount: 0,
    avoidedEnvironmentEntryCopyCount: 0,
    rejectedOptionalRequestCount: 0,
    functionConstructingIntrinsicFoldCount: 0,
  };
  const frontierMilliseconds = performance.now() - frontierStart;

  const rewriteStart = performance.now();
  const values = new Map<number, TypedDucklangExpression>();
  const rewrittenBindings = demandedInputBindings.map((
    binding,
  ): TypedDucklangBinding => {
    const value = rewrittenBindingSymbols.has(binding.symbol.id)
      ? rewriteExpression(binding.value, values, specialization)
      : binding.value;
    values.set(binding.symbol.id, value);
    return { ...binding, value };
  });
  const liftedBindings: TypedDucklangBinding[] = [];
  const liftedFunctionSymbols = new Set<number>();
  const rewrittenResult = rewriteResult
    ? rewriteExpression(module.result, values, specialization)
    : module.result;
  const rewriteMilliseconds = performance.now() - rewriteStart;

  const liftingStart = performance.now();
  const directFunctionSymbols = new Set<number>();
  const collectDirectFunctions = (
    expression: TypedDucklangExpression,
  ): void => {
    if (expression.kind === "block") {
      for (const step of expression.steps) {
        if (
          step.kind === "binding" && step.binding.value.kind === "function"
        ) {
          directFunctionSymbols.add(step.binding.symbol.id);
        }
      }
    }
    visitDucklangExpressionChildren(expression, collectDirectFunctions);
  };
  for (const binding of rewrittenBindings) {
    if (binding.value.kind === "function") {
      directFunctionSymbols.add(binding.symbol.id);
    }
    collectDirectFunctions(binding.value);
  }
  collectDirectFunctions(rewrittenResult);
  let nextSymbolId = Math.max(0, ...module.symbolTypes.keys()) + 1;
  const allocateSymbolId = (): number => {
    const symbolId = nextSymbolId;
    nextSymbolId += 1;
    return symbolId;
  };
  const bindings = rewrittenBindings.map((binding) => ({
    ...binding,
    value: rewrittenBindingSymbols.has(binding.symbol.id)
      ? liftGeneratedFunctions(
        binding.value,
        liftedBindings,
        liftedFunctionSymbols,
        directFunctionSymbols,
        allocateSymbolId,
      )
      : binding.value,
  }));
  const result = rewriteResult
    ? liftGeneratedFunctions(
      rewrittenResult,
      liftedBindings,
      liftedFunctionSymbols,
      directFunctionSymbols,
      allocateSymbolId,
    )
    : rewrittenResult;
  bindings.push(...liftedBindings);
  const liftingMilliseconds = performance.now() - liftingStart;

  const reachabilityStart = performance.now();
  const bindingsBySymbol = new Map(
    bindings.map((binding) => [binding.symbol.id, binding]),
  );
  const reachable = new Set<number>();
  const visit = (expression: TypedDucklangExpression): void => {
    if (expression.kind === "reference") {
      if (reachable.has(expression.symbol.id)) return;
      const binding = bindingsBySymbol.get(expression.symbol.id);
      if (binding === undefined) return;
      reachable.add(expression.symbol.id);
      visit(binding.value);
      return;
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  visit(result);

  const specializedModule = {
    ...module,
    bindings: bindings.filter((binding) =>
      reachable.has(binding.symbol.id) ||
      (binding.stage === "runtime" && binding.value.kind !== "function")
    ),
    result,
  };
  const reachabilityMilliseconds = performance.now() - reachabilityStart;

  const accountingStart = performance.now();
  const nodeCounts = new WeakMap<object, number>();
  let nodeCountCacheHitCount = 0;
  let nodeCountCacheHitNodeCount = 0;
  const nodeCount = (expression: TypedDucklangExpression): number => {
    const cached = nodeCounts.get(expression);
    if (cached !== undefined) {
      nodeCountCacheHitCount += 1;
      nodeCountCacheHitNodeCount += cached;
      return cached;
    }
    const count = countExpressionNodes(expression);
    nodeCounts.set(expression, count);
    return count;
  };
  const requestsByFunction = [...specialization.requestFunctions.values()]
    .toSorted((left, right) => left.functionId - right.functionId)
    .map((requestFunction): DucklangFunctionSpecializationMetrics => {
      const sourceBodyNodeCount = nodeCount(requestFunction.body);
      const emittedNodeCount = requestFunction.emittedExpressions.reduce(
        (total, expression) => total + nodeCount(expression),
        0,
      );
      const inputNodeCount = sourceBodyNodeCount *
        requestFunction.emittedExpressions.length;
      return {
        functionId: requestFunction.functionId,
        file: requestFunction.file,
        start: requestFunction.start,
        end: requestFunction.end,
        sourceBodyNodeCount,
        emittedRequestCount: requestFunction.emittedExpressions.length,
        reusedRequestCount: requestFunction.reusedRequestCount,
        pendingCycleCount: requestFunction.pendingCycleCount,
        emittedNodeCount,
        residualNodeAmplification: inputNodeCount === 0
          ? 0
          : emittedNodeCount / inputNodeCount,
      };
    });
  const metrics = {
    inputBindingCount: module.bindings.length,
    demandedBindingCount: demandedInputBindings.length,
    rewrittenBindingCount: rewrittenBindingSymbols.size,
    residualBindingCount: specializedModule.bindings.length,
    inputNodeCount: module.bindings.reduce(
      (count, binding) => count + nodeCount(binding.value),
      nodeCount(module.result),
    ),
    demandedInputNodeCount: demandedInputBindings.reduce(
      (count, binding) => count + nodeCount(binding.value),
      nodeCount(module.result),
    ),
    rewrittenInputNodeCount: demandedInputBindings.reduce(
      (count, binding) =>
        rewrittenBindingSymbols.has(binding.symbol.id)
          ? count + nodeCount(binding.value)
          : count,
      rewriteResult ? nodeCount(module.result) : 0,
    ),
    residualNodeCount: specializedModule.bindings.reduce(
      (count, binding) => count + nodeCount(binding.value),
      nodeCount(specializedModule.result),
    ),
    distinctSpecializationKeyCount: specialization.requests.size,
    specializationCacheHitCount: specialization.cacheHitCount,
    pendingSpecializationCycleCount: specialization.pendingCycleCount,
    functionConstructingIntrinsicFoldCount:
      specialization.functionConstructingIntrinsicFoldCount,
    rejectedOptionalRequestCount: specialization.rejectedOptionalRequestCount,
    widenedRequestCount: 0 as const,
    requestsByFunction,
    distinctFunctionAnalysisCount: specialization.distinctFunctionAnalysisCount,
    functionAnalysisCacheHitCount: specialization.functionAnalysisCacheHitCount,
    rewrittenBlockCount: specialization.rewrittenBlockCount,
    avoidedEnvironmentEntryCopyCount:
      specialization.avoidedEnvironmentEntryCopyCount,
    nodeCountCacheHitCount,
    nodeCountCacheHitNodeCount,
  };
  const accountingMilliseconds = performance.now() - accountingStart;

  return {
    module: specializedModule,
    metrics,
    timings: {
      demandMilliseconds,
      frontierMilliseconds,
      rewriteMilliseconds,
      liftingMilliseconds,
      reachabilityMilliseconds,
      accountingMilliseconds,
    },
  };
}

function liftGeneratedFunctions(
  expression: TypedDucklangExpression,
  liftedBindings: TypedDucklangBinding[],
  liftedFunctionSymbols: Set<number>,
  directFunctionSymbols: Set<number>,
  allocateSymbolId: () => number,
): TypedDucklangExpression {
  if (expression.kind !== "block") {
    return rewriteChildren(
      expression,
      (child) =>
        liftGeneratedFunctions(
          child,
          liftedBindings,
          liftedFunctionSymbols,
          directFunctionSymbols,
          allocateSymbolId,
        ),
    );
  }
  let block = expression;
  for (const originalStep of expression.steps) {
    if (originalStep.kind !== "binding") continue;
    const step = block.steps.find((candidate) =>
      candidate.kind === "binding" &&
      candidate.binding.symbol.id === originalStep.binding.symbol.id
    );
    if (
      step?.kind !== "binding" ||
      step.binding.value.kind !== "function" ||
      (!isGeneratedControlFunction(step.binding) &&
        !isOnlyDirectlyCalled(expression, step.binding.symbol.id))
    ) {
      continue;
    }
    const originalSymbol = step.binding.symbol;
    const functionSymbol = liftedFunctionSymbols.has(originalSymbol.id)
      ? { ...originalSymbol, id: allocateSymbolId() }
      : originalSymbol;
    liftedFunctionSymbols.add(functionSymbol.id);
    directFunctionSymbols.add(functionSymbol.id);
    const functionValue = functionSymbol === originalSymbol
      ? step.binding.value
      : renameSymbolReferences(
        step.binding.value,
        originalSymbol.id,
        functionSymbol,
      ) as Extract<TypedDucklangExpression, { readonly kind: "function" }>;
    const captures = collectFunctionCaptures(
      functionSymbol.id,
      functionValue,
      directFunctionSymbols,
    );
    const captureReferences = captures.map((capture) => ({
      kind: "reference" as const,
      symbol: capture.symbol,
      type: capture.type,
      span: capture.symbol.span,
    }));
    const appendCaptures = (
      candidate: TypedDucklangExpression,
    ): TypedDucklangExpression =>
      captureReferences.length === 0 ? candidate : appendCallArguments(
        candidate,
        functionSymbol.id,
        captureReferences,
      );
    const preparedFunction = {
      ...functionValue,
      parameters: [
        ...functionValue.parameters,
        ...captures.map((capture) => capture.symbol),
      ],
      body: appendCaptures(functionValue.body),
    } satisfies Extract<
      TypedDucklangExpression,
      { readonly kind: "function" }
    >;
    const liftedFunction = liftGeneratedFunctions(
      preparedFunction,
      liftedBindings,
      liftedFunctionSymbols,
      directFunctionSymbols,
      allocateSymbolId,
    );
    if (liftedFunction.kind !== "function") {
      throw new TypeError(
        `${step.binding.span.file}:${step.binding.span.start}: generated Ducklang control binding ${step.binding.symbol.text} stopped being a function during closure conversion`,
      );
    }
    liftedBindings.push({
      ...step.binding,
      symbol: functionSymbol,
      value: liftedFunction,
    });
    const remainingBlock = {
      ...block,
      steps: removeGeneratedFunctionStep(block.steps, step.binding),
    } satisfies Extract<TypedDucklangExpression, { readonly kind: "block" }>;
    block = appendCaptures(
      functionSymbol === originalSymbol
        ? remainingBlock
        : renameSymbolReferences(
          remainingBlock,
          originalSymbol.id,
          functionSymbol,
        ),
    ) as Extract<TypedDucklangExpression, { readonly kind: "block" }>;
  }
  return rewriteChildren(
    block,
    (child) =>
      liftGeneratedFunctions(
        child,
        liftedBindings,
        liftedFunctionSymbols,
        directFunctionSymbols,
        allocateSymbolId,
      ),
  );
}

function removeGeneratedFunctionStep(
  steps: readonly TypedDucklangBlockStep[],
  binding: TypedDucklangBinding,
): readonly TypedDucklangBlockStep[] {
  let removed = false;
  return steps.filter((step) => {
    if (
      !removed && step.kind === "binding" &&
      step.binding.symbol.id === binding.symbol.id &&
      step.binding.span.start === binding.span.start
    ) {
      removed = true;
      return false;
    }
    return true;
  });
}

function renameSymbolReferences(
  expression: TypedDucklangExpression,
  symbolId: number,
  replacement: Extract<
    TypedDucklangExpression,
    { readonly kind: "reference" }
  >["symbol"],
): TypedDucklangExpression {
  if (
    expression.kind === "reference" && expression.symbol.id === symbolId
  ) {
    return { ...expression, symbol: replacement };
  }
  return rewriteChildren(
    expression,
    (child) => renameSymbolReferences(child, symbolId, replacement),
  );
}

/**
 * Whether a nested function is only ever called, never used as a value.
 *
 * Lifting appends a function's captures to its parameter list and adds matching
 * arguments at each call site. That is sound for a symbol that only appears as a
 * callee. A symbol also used as a value would need a closure carrying the captures,
 * which is a later item, so such a function is left where it is rather than lifted
 * into something whose arity no longer matches its uses.
 *
 * Loop-lowering artifacts skip this check because they are generated as call-only by
 * construction.
 */
function isOnlyDirectlyCalled(
  scope: TypedDucklangExpression,
  symbolId: number,
): boolean {
  let onlyCalled = true;
  const visit = (expression: TypedDucklangExpression): void => {
    if (!onlyCalled) return;
    if (expression.kind === "call") {
      // The callee position is fine; anything else in the call is not.
      if (
        !(expression.callee.kind === "reference" &&
          expression.callee.symbol.id === symbolId)
      ) {
        visit(expression.callee);
      }
      for (const argument of expression.arguments) visit(argument);
      return;
    }
    if (expression.kind === "reference" && expression.symbol.id === symbolId) {
      onlyCalled = false;
      return;
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  visitDucklangExpressionChildren(scope, visit);
  return onlyCalled;
}

function isGeneratedControlFunction(binding: TypedDucklangBinding): boolean {
  return binding.symbol.text.startsWith("$loop_") ||
    binding.symbol.text.startsWith("$range_loop_");
}

type FunctionCapture = {
  readonly symbol: Extract<
    TypedDucklangExpression,
    { readonly kind: "reference" }
  >["symbol"];
  readonly type: TypedDucklangExpression["type"];
};

export type DucklangFunctionFreeVariables = {
  /** Where the function appears, so nested functions stay distinguishable. */
  readonly span: SourceSpan;
  readonly parameters: readonly DucklangSymbol[];
  /** Symbols the body reads that the function neither declares nor parameterises. */
  readonly freeVariables: readonly DucklangSymbol[];
};

/**
 * Free variables of every runtime function in a module, including nested ones.
 *
 * Module-scope symbols are excluded: they are addressable from any function without
 * being captured, so a closure environment never has to carry one. What remains is
 * exactly what an environment would need to hold.
 *
 * The specializer computes the same thing on demand for the functions it rewrites.
 * This exposes it for every function so closure conversion has the whole picture
 * rather than the subset one pass happened to need.
 */
export function ducklangFunctionFreeVariables(
  module: TypedDucklangModule,
): readonly DucklangFunctionFreeVariables[] {
  const moduleFunctions = new Set(
    module.bindings.flatMap((binding) =>
      binding.value.kind === "function" ? [binding.symbol.id] : []
    ),
  );
  const results: DucklangFunctionFreeVariables[] = [];
  const visit = (
    expression: TypedDucklangExpression,
    owner: number | undefined,
  ): void => {
    if (expression.kind === "function") {
      results.push({
        span: expression.span,
        parameters: expression.parameters,
        freeVariables: collectFunctionCaptures(
          owner ?? -1,
          expression,
          moduleFunctions,
        ).map((capture) => capture.symbol),
      });
    }
    visitDucklangExpressionChildren(
      expression,
      (child) => visit(child, owner),
    );
  };
  for (const binding of module.bindings) {
    visit(binding.value, binding.symbol.id);
  }
  visit(module.result, undefined);
  return results;
}

function collectFunctionCaptures(
  functionSymbolId: number,
  function_: Extract<TypedDucklangExpression, { readonly kind: "function" }>,
  directFunctionSymbols: ReadonlySet<number>,
): readonly FunctionCapture[] {
  const defined = new Set([
    functionSymbolId,
    ...function_.parameters.map((parameter) => parameter.id),
    ...directFunctionSymbols,
  ]);
  collectDefinedSymbols(function_.body, defined);
  const captures = new Map<number, FunctionCapture>();
  const visit = (expression: TypedDucklangExpression): void => {
    if (
      expression.kind === "reference" &&
      expression.symbol.scope !== "module" &&
      !defined.has(expression.symbol.id) &&
      !captures.has(expression.symbol.id)
    ) {
      captures.set(expression.symbol.id, {
        symbol: expression.symbol,
        type: expression.type,
      });
      return;
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  visit(function_.body);
  return [...captures.values()];
}

function collectDefinedSymbols(
  expression: TypedDucklangExpression,
  symbols: Set<number>,
): void {
  if (expression.kind === "function") {
    for (const parameter of expression.parameters) symbols.add(parameter.id);
  }
  if (expression.kind === "ifUnion" && expression.payloadSymbol !== undefined) {
    symbols.add(expression.payloadSymbol.id);
  }
  if (expression.kind === "block") {
    for (const step of expression.steps) {
      if (step.kind === "binding") symbols.add(step.binding.symbol.id);
    }
  }
  visitDucklangExpressionChildren(
    expression,
    (child) => collectDefinedSymbols(child, symbols),
  );
}

function appendCallArguments(
  expression: TypedDucklangExpression,
  functionSymbolId: number,
  arguments_: readonly TypedDucklangExpression[],
): TypedDucklangExpression {
  const rewritten = rewriteChildren(
    expression,
    (child) => appendCallArguments(child, functionSymbolId, arguments_),
  );
  if (
    rewritten.kind !== "call" || rewritten.callee.kind !== "reference" ||
    rewritten.callee.symbol.id !== functionSymbolId
  ) {
    return rewritten;
  }
  return {
    ...rewritten,
    arguments: [...rewritten.arguments, ...arguments_],
  };
}

function rewriteExpression(
  expression: TypedDucklangExpression,
  values: Map<number, TypedDucklangExpression>,
  specialization: SpecializationContext,
): TypedDucklangExpression {
  if (expression.kind === "reference") {
    if (
      specialization.substitutionEnvironments.length > 0 &&
      expression.symbol.scope === "parameter"
    ) {
      for (
        let index = specialization.substitutionEnvironments.length - 1;
        index >= 0;
        index -= 1
      ) {
        const substituted = specialization.substitutionEnvironments[index].get(
          expression.symbol.id,
        );
        if (substituted !== undefined) {
          return rewriteExpression(substituted, values, specialization);
        }
      }
    }
    const value = values.get(expression.symbol.id);
    if (value !== undefined && isInlineableScalar(value)) {
      return {
        ...value,
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      value?.kind === "reference" && value.symbol.id !== expression.symbol.id
    ) {
      return {
        ...value,
        type: expression.type,
        span: expression.span,
      };
    }
  }
  if (expression.kind === "block") {
    return rewriteBlock(expression, values, specialization);
  }
  if (expression.kind === "if") {
    const condition = rewriteExpression(
      expression.condition,
      values,
      specialization,
    );
    const staticCondition = staticValue(condition, values);
    if (
      staticCondition.kind === "boolean" ||
      staticCondition.kind === "integer"
    ) {
      const selectsConsequence = staticCondition.kind === "boolean"
        ? staticCondition.value
        : staticCondition.value !== 0;
      return rewriteExpression(
        selectsConsequence ? expression.consequence : expression.alternative,
        values,
        specialization,
      );
    }
    const consequence = rewriteExpression(
      expression.consequence,
      values,
      specialization,
    );
    const alternative = rewriteExpression(
      expression.alternative,
      values,
      specialization,
    );
    if (
      condition === expression.condition &&
      consequence === expression.consequence &&
      alternative === expression.alternative
    ) {
      return expression;
    }
    return {
      ...expression,
      condition,
      consequence,
      alternative,
    };
  }
  const rewritten = rewriteChildren(
    expression,
    (child) => rewriteExpression(child, values, specialization),
  );
  if (
    rewritten.kind === "comptime" &&
    rewritten.context === "valuePattern"
  ) {
    return {
      ...rewritten,
      expression: staticValue(rewritten.expression, values),
    };
  }
  if (rewritten.kind === "ownership") {
    const value = staticValue(rewritten.expression, values);
    return isInlineableScalar(value) ? rewritten.expression : rewritten;
  }
  if (rewritten.kind === "optionDo") {
    const option = staticValue(rewritten.option, values);
    if (option.kind === "unionCase" && option.caseName === "Some") {
      return option.value;
    }
    if (option.kind === "unionCase" && option.caseName === "None") {
      throw new TypeError(
        `${rewritten.span.file}:${rewritten.span.start}: static Ducklang do encountered None without handler lowering`,
      );
    }
  }
  if (rewritten.kind === "scratch") {
    const body = collapseEmptyBlock(rewritten.body);
    return isInlineableScalar(body) ? body : { ...rewritten, body };
  }
  if (rewritten.kind === "textAppend") {
    const left = staticValue(rewritten.left, values);
    const right = staticValue(rewritten.right, values);
    if (left.kind === "string" && right.kind === "string") {
      return {
        kind: "string",
        value: left.value + right.value,
        type: rewritten.type,
        span: rewritten.span,
      };
    }
  }
  if (rewritten.kind === "index") {
    const collection = staticValue(rewritten.collection, values);
    const index = staticValue(rewritten.index, values);
    if (collection.kind === "string" && index.kind === "integer") {
      const bytes = new TextEncoder().encode(collection.value);
      if (index.value < 0 || index.value >= bytes.length) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang text index ${index.value} is outside byte length ${bytes.length}`,
        );
      }
      return {
        kind: "integer",
        value: bytes[index.value],
        type: rewritten.type,
        span: rewritten.span,
      };
    }
    if (
      collection.kind === "product" &&
      collection.productKind === "array" && index.kind === "integer"
    ) {
      const value = collection.values[index.value];
      if (value === undefined) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang array index ${index.value} is outside length ${collection.values.length}`,
        );
      }
      return value;
    }
    if (collection.kind === "product" && collection.nominalType !== undefined) {
      if (index.kind === "integer") {
        const value = collection.values[index.value];
        if (value === undefined) {
          throw new RangeError(
            `${rewritten.span.file}:${rewritten.span.start}: Ducklang struct index ${index.value} is outside ${collection.values.length} fields`,
          );
        }
        return value;
      }
      return {
        kind: "selectProductElement",
        values: collection.values,
        index,
        type: rewritten.type,
        span: rewritten.span,
      };
    }
  }
  if (rewritten.kind === "project") {
    const product = staticValue(rewritten.product, values);
    if (product.kind === "product") {
      const value = product.values[rewritten.index];
      if (value === undefined) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang tuple projection ${rewritten.index} is outside arity ${product.values.length}`,
        );
      }
      return value;
    }
    if (product.kind === "if") {
      return rewriteExpression(
        {
          ...product,
          consequence: {
            kind: "project",
            product: product.consequence,
            index: rewritten.index,
            type: rewritten.type,
            span: rewritten.span,
          },
          alternative: {
            kind: "project",
            product: product.alternative,
            index: rewritten.index,
            type: rewritten.type,
            span: rewritten.span,
          },
          type: rewritten.type,
          span: rewritten.span,
        },
        values,
        specialization,
      );
    }
  }
  if (rewritten.kind === "recordUpdate") {
    const product = staticValue(rewritten.product, values);
    if (product.kind === "product") {
      const updatedValues = [...product.values];
      for (const field of rewritten.fields) {
        updatedValues[field.index] = field.value;
      }
      return { ...product, values: updatedValues, type: rewritten.type };
    }
  }
  if (rewritten.kind === "indexUpdate") {
    const product = staticValue(rewritten.product, values);
    const index = staticValue(rewritten.index, values);
    if (product.kind === "product" && index.kind === "integer") {
      if (product.values[index.value] === undefined) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang struct assignment index ${index.value} is outside ${product.values.length} fields`,
        );
      }
      const updatedValues = [...product.values];
      updatedValues[index.value] = rewritten.value;
      return { ...product, values: updatedValues, type: rewritten.type };
    }
  }
  if (rewritten.kind === "ifUnion") {
    const value = staticValue(rewritten.value, values);
    if (value.kind === "unionCase") {
      const matches = value.unionName === rewritten.unionName &&
        value.caseName === rewritten.caseName;
      const selected = matches ? rewritten.consequence : rewritten.alternative;
      if (
        matches && rewritten.payloadSymbol !== undefined
      ) {
        return rewriteExpression(
          substitute(
            selected,
            new Map([[rewritten.payloadSymbol.id, value.value]]),
          ),
          values,
          specialization,
        );
      }
      return rewriteExpression(selected, values, specialization);
    }
    if (value.kind === "if") {
      return rewriteExpression(
        {
          ...value,
          consequence: {
            ...rewritten,
            value: value.consequence,
          },
          alternative: {
            ...rewritten,
            value: value.alternative,
          },
          type: rewritten.type,
          span: rewritten.span,
        },
        values,
        specialization,
      );
    }
  }
  const foldedBinary = foldStaticBinary(rewritten, values);
  if (foldedBinary !== undefined) return foldedBinary;
  const foldedIntrinsic = foldStaticIntrinsic(
    rewritten,
    values,
    specialization,
  );
  if (foldedIntrinsic !== undefined) return foldedIntrinsic;
  if (rewritten.kind !== "call") return collapseEmptyBlock(rewritten);
  const selectedCallee = staticValue(rewritten.callee, values);
  if (selectedCallee.kind === "if") {
    return rewriteExpression(
      {
        ...selectedCallee,
        consequence: {
          kind: "call",
          callee: selectedCallee.consequence,
          arguments: rewritten.arguments,
          type: rewritten.type,
          span: rewritten.span,
        },
        alternative: {
          kind: "call",
          callee: selectedCallee.alternative,
          arguments: rewritten.arguments,
          type: rewritten.type,
          span: rewritten.span,
        },
        type: rewritten.type,
        span: rewritten.span,
      },
      values,
      specialization,
    );
  }
  if (selectedCallee.kind === "ifUnion") {
    return rewriteExpression(
      {
        ...selectedCallee,
        consequence: {
          kind: "call",
          callee: selectedCallee.consequence,
          arguments: rewritten.arguments,
          type: rewritten.type,
          span: rewritten.span,
        },
        alternative: {
          kind: "call",
          callee: selectedCallee.alternative,
          arguments: rewritten.arguments,
          type: rewritten.type,
          span: rewritten.span,
        },
        type: rewritten.type,
        span: rewritten.span,
      },
      values,
      specialization,
    );
  }
  if (
    rewritten.arguments.length === 0 &&
    selectedCallee.kind !== "function" &&
    selectedCallee.type.kind !== "function"
  ) {
    return {
      ...selectedCallee,
      type: rewritten.type,
      span: rewritten.span,
    };
  }
  const factory = selectedCallee;
  if (
    factory.kind !== "function" || factory.recursive ||
    factory.parameters.length !== rewritten.arguments.length
  ) {
    return collapseEmptyBlock(rewritten);
  }
  const analysis = analyzeSpecializationFunction(factory, specialization);
  if (analysis === undefined) return collapseEmptyBlock(rewritten);
  const staticArguments = rewritten.arguments.map((argument) =>
    staticValue(argument, values)
  );
  const returnsFunction = rewritten.type.kind === "function";
  const returnsAggregate = rewritten.type.kind === "constructor" &&
    (rewritten.type.name === "tuple" || rewritten.type.name === "array");
  const specializesFunctionParameter = factory.parameters.some(
    (parameter, index) =>
      analysis.referencedSymbols.has(parameter.id) &&
      staticArguments[index].kind === "function",
  );
  const specializesTextParameter = factory.parameters.some(
    (parameter, index) =>
      analysis.referencedSymbols.has(parameter.id) &&
      staticArguments[index].kind === "string",
  );
  const specializesUnionParameter = factory.parameters.some(
    (parameter, index) =>
      analysis.referencedSymbols.has(parameter.id) &&
      staticArguments[index].kind === "unionCase",
  );
  const specializesProductParameter = factory.parameters.some(
    (parameter, index) =>
      analysis.referencedSymbols.has(parameter.id) &&
      staticArguments[index].kind === "product",
  );
  const specializesIntrinsicParameter = factory.parameters.some(
    (parameter, index) => {
      const argument = staticArguments[index];
      return argument.kind === "intrinsic" &&
        (analysis.directlyCalledSymbols.has(parameter.id) ||
          (argument.modulePath.startsWith("duck:type/") &&
            analysis.referencedSymbols.has(parameter.id)));
    },
  );
  const specializesCompileTimeParameter = factory.parameters.some(
    (parameter) => parameter.compileTimeRecord === true,
  );
  const inlinesFunctionLiteral = rewritten.callee.kind === "function";
  if (
    !returnsFunction && !returnsAggregate && !inlinesFunctionLiteral &&
    !specializesFunctionParameter && !specializesTextParameter &&
    !specializesUnionParameter && !specializesProductParameter &&
    !specializesIntrinsicParameter && !specializesCompileTimeParameter
  ) {
    specialization.rejectedOptionalRequestCount += 1;
    return collapseEmptyBlock(rewritten);
  }
  let functionId = specialization.functionIds.get(factory);
  if (functionId === undefined) {
    functionId = specialization.nextFunctionId;
    specialization.nextFunctionId += 1;
    specialization.functionIds.set(factory, functionId);
  }
  let requestFunction = specialization.requestFunctions.get(functionId);
  if (requestFunction === undefined) {
    requestFunction = {
      functionId,
      file: factory.span.file,
      start: factory.span.start,
      end: factory.span.end,
      body: analysis.body,
      emittedExpressions: [],
      reusedRequestCount: 0,
      pendingCycleCount: 0,
    };
    specialization.requestFunctions.set(functionId, requestFunction);
  }
  const environmentIdentity = [...analysis.referencedSymbols]
    .filter((symbolId) =>
      !analysis.parameterSymbols.has(symbolId) && values.has(symbolId)
    )
    .toSorted((left, right) => left - right)
    .map((symbolId) => [
      symbolId,
      specializationExpressionIdentity(
        staticValue(values.get(symbolId)!, values),
        specialization,
      ),
    ]);
  const requestKey = JSON.stringify([
    functionId,
    rewritten.span.file,
    rewritten.span.start,
    rewritten.span.end,
    staticArguments.map((argument) =>
      specializationExpressionIdentity(argument, specialization)
    ),
    environmentIdentity,
  ]);
  const cached = specialization.requests.get(requestKey);
  if (cached?.status === "complete") {
    specialization.cacheHitCount += 1;
    requestFunction.reusedRequestCount += 1;
    return cached.expression;
  }
  if (cached?.status === "pending") {
    specialization.pendingCycleCount += 1;
    requestFunction.pendingCycleCount += 1;
    return collapseEmptyBlock(rewritten);
  }
  specialization.requests.set(requestKey, { status: "pending" });
  const substitutions = new Map(
    factory.parameters.map((parameter, index) => [
      parameter.id,
      rewritten.arguments[index],
    ]),
  );
  specialization.substitutionEnvironments.push(substitutions);
  let specialized: TypedDucklangExpression;
  try {
    specialized = rewriteExpression(
      analysis.body,
      values,
      specialization,
    );
  } finally {
    specialization.substitutionEnvironments.pop();
  }
  specialization.requests.set(requestKey, {
    status: "complete",
    expression: specialized,
  });
  requestFunction.emittedExpressions.push(specialized);
  return specialized;
}

function analyzeSpecializationFunction(
  factory: Extract<TypedDucklangExpression, { readonly kind: "function" }>,
  specialization: SpecializationContext,
): FunctionSpecializationAnalysis | undefined {
  const cached = specialization.functionAnalyses.get(factory);
  if (cached !== undefined) {
    specialization.functionAnalysisCacheHitCount += 1;
    return cached ?? undefined;
  }

  specialization.distinctFunctionAnalysisCount += 1;
  const body = inlineableFunctionBody(factory.body);
  if (body === undefined) {
    specialization.functionAnalyses.set(factory, null);
    return undefined;
  }

  const referencedSymbols = new Set<number>();
  const directlyCalledSymbols = new Set<number>();
  const pending = [body];
  while (pending.length > 0) {
    const expression = pending.pop()!;
    if (expression.kind === "reference") {
      referencedSymbols.add(expression.symbol.id);
    }
    if (
      expression.kind === "call" &&
      expression.callee.kind === "reference"
    ) {
      directlyCalledSymbols.add(expression.callee.symbol.id);
    }
    visitDucklangExpressionChildren(
      expression,
      (child) => pending.push(child),
    );
  }

  const analysis = {
    body,
    referencedSymbols,
    parameterSymbols: new Set(
      factory.parameters.map((parameter) => parameter.id),
    ),
    directlyCalledSymbols,
  };
  specialization.functionAnalyses.set(factory, analysis);
  return analysis;
}

function specializationExpressionIdentity(
  expression: TypedDucklangExpression,
  specialization: SpecializationContext,
): string {
  let typeIdentity = specialization.typeIdentities.get(expression.type);
  if (typeIdentity === undefined) {
    typeIdentity = JSON.stringify(expression.type);
    specialization.typeIdentities.set(expression.type, typeIdentity);
  }
  switch (expression.kind) {
    case "integer":
    case "float32":
    case "float64": {
      const value = Object.is(expression.value, -0)
        ? "-0"
        : String(expression.value);
      return JSON.stringify([expression.kind, typeIdentity, value]);
    }
    case "boolean":
    case "string":
      return JSON.stringify([
        expression.kind,
        typeIdentity,
        expression.value,
      ]);
    case "integer64":
      return JSON.stringify([
        "integer64",
        typeIdentity,
        expression.value.toString(),
      ]);
    case "unit":
      return JSON.stringify(["unit", typeIdentity]);
    case "intrinsic":
      return JSON.stringify([
        "intrinsic",
        typeIdentity,
        expression.modulePath,
        expression.exportName,
      ]);
    case "primitive":
      return JSON.stringify([
        "primitive",
        typeIdentity,
        expression.primitiveId,
      ]);
    case "reference":
      return JSON.stringify([
        "reference",
        typeIdentity,
        expression.symbol.id,
      ]);
    case "function": {
      let functionId = specialization.functionIds.get(expression);
      if (functionId === undefined) {
        functionId = specialization.nextFunctionId;
        specialization.nextFunctionId += 1;
        specialization.functionIds.set(expression, functionId);
      }
      return JSON.stringify(["function", typeIdentity, functionId]);
    }
    case "unionCase":
      return JSON.stringify([
        "unionCase",
        typeIdentity,
        expression.nominalType ?? "",
        expression.unionName,
        expression.caseName,
        specializationExpressionIdentity(expression.value, specialization),
      ]);
    case "product":
      return JSON.stringify([
        "product",
        typeIdentity,
        expression.nominalType ?? "",
        expression.productKind,
        expression.values.map((value) =>
          specializationExpressionIdentity(value, specialization)
        ),
      ]);
    default: {
      let valueId = specialization.valueIds.get(expression);
      if (valueId === undefined) {
        valueId = specialization.nextValueId;
        specialization.nextValueId += 1;
        specialization.valueIds.set(expression, valueId);
      }
      return JSON.stringify([expression.kind, typeIdentity, valueId]);
    }
  }
}

function inlineableFunctionBody(
  body: TypedDucklangExpression,
): TypedDucklangExpression | undefined {
  const collapsed = collapseEmptyBlock(body);
  if (collapsed.kind === "return") return collapsed.expression;
  return containsReturn(collapsed) ? undefined : collapsed;
}

function containsReturn(expression: TypedDucklangExpression): boolean {
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === "return") return true;
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
  return false;
}

function referencesSymbol(
  expression: TypedDucklangExpression,
  symbolId: number,
): boolean {
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.kind === "reference" && current.symbol.id === symbolId
    ) {
      return true;
    }
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
  return false;
}

function rewriteBlock(
  block: Extract<TypedDucklangExpression, { readonly kind: "block" }>,
  values: Map<number, TypedDucklangExpression>,
  specialization: SpecializationContext,
): TypedDucklangExpression {
  specialization.rewrittenBlockCount += 1;
  specialization.avoidedEnvironmentEntryCopyCount += values.size;
  const previousValues: {
    readonly symbolId: number;
    readonly value: TypedDucklangExpression | undefined;
  }[] = [];
  let steps: readonly TypedDucklangBlockStep[];
  let result: TypedDucklangExpression;
  try {
    steps = block.steps.map((step): TypedDucklangBlockStep => {
      if (step.kind === "expression") {
        return {
          kind: "expression",
          expression: rewriteExpression(
            step.expression,
            values,
            specialization,
          ),
        };
      }
      const binding = {
        ...step.binding,
        value: rewriteExpression(step.binding.value, values, specialization),
      };
      previousValues.push({
        symbolId: binding.symbol.id,
        value: values.get(binding.symbol.id),
      });
      values.set(binding.symbol.id, binding.value);
      return { kind: "binding", binding };
    });
    result = rewriteExpression(block.result, values, specialization);
  } finally {
    for (const previous of previousValues.toReversed()) {
      if (previous.value === undefined) {
        values.delete(previous.symbolId);
      } else {
        values.set(previous.symbolId, previous.value);
      }
    }
  }
  const live = new Set<number>();
  collectReferences(result, live);
  const retained: TypedDucklangBlockStep[] = [];
  for (const step of steps.toReversed()) {
    if (step.kind === "expression") {
      collectReferences(step.expression, live);
      retained.push(step);
      continue;
    }
    const referenced = live.delete(step.binding.symbol.id);
    if (!referenced && step.binding.stage === "compileTime") continue;
    collectReferences(step.binding.value, live);
    retained.push(step);
  }
  return collapseEmptyBlock({
    ...block,
    steps: retained.toReversed(),
    result,
  });
}

function isInlineableScalar(
  expression: TypedDucklangExpression,
): expression is Extract<
  TypedDucklangExpression,
  {
    readonly kind:
      | "integer"
      | "integer64"
      | "float32"
      | "float64"
      | "boolean"
      | "unit"
      | "string";
  }
> {
  return expression.kind === "integer" ||
    expression.kind === "integer64" ||
    expression.kind === "float32" ||
    expression.kind === "float64" ||
    expression.kind === "boolean" ||
    expression.kind === "unit" ||
    expression.kind === "string";
}

function collectReferences(
  expression: TypedDucklangExpression,
  references: Set<number>,
): void {
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === "reference") {
      references.add(current.symbol.id);
      continue;
    }
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
}

function countExpressionNodes(expression: TypedDucklangExpression): number {
  let count = 0;
  const pending = [expression];
  const visited = new Set<TypedDucklangExpression>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    count += 1;
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
  return count;
}

function foldStaticBinary(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression | undefined {
  if (expression.kind !== "binary") return undefined;
  const left = staticValue(expression.left, values);
  const right = staticValue(expression.right, values);
  if (
    (expression.operator === "==" || expression.operator === "!=") &&
    left.kind === "string" && right.kind === "string"
  ) {
    const equal = left.value === right.value;
    return {
      kind: "boolean",
      value: expression.operator === "==" ? equal : !equal,
      type: expression.type,
      span: expression.span,
    };
  }
  if (left.kind !== "integer" || right.kind !== "integer") return undefined;
  const comparison = expression.operator === "=="
    ? left.value === right.value
    : expression.operator === "!="
    ? left.value !== right.value
    : expression.operator === "<"
    ? left.value < right.value
    : expression.operator === "<="
    ? left.value <= right.value
    : expression.operator === ">"
    ? left.value > right.value
    : expression.operator === ">="
    ? left.value >= right.value
    : undefined;
  if (comparison !== undefined) {
    return {
      kind: "boolean",
      value: comparison,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    (expression.operator === "/" || expression.operator === "%") &&
    right.value === 0
  ) {
    return undefined;
  }
  const value = expression.operator === "+"
    ? (left.value + right.value) | 0
    : expression.operator === "-"
    ? (left.value - right.value) | 0
    : expression.operator === "*"
    ? Math.imul(left.value, right.value)
    : expression.operator === "/"
    ? Math.trunc(left.value / right.value) | 0
    : expression.operator === "%"
    ? (left.value % right.value) | 0
    : undefined;
  return value === undefined ? undefined : {
    kind: "integer",
    value,
    type: expression.type,
    span: expression.span,
  };
}

/**
 * The `$TypeDescription` value `@describe_type` answers with.
 *
 * The struct is synthesised by the parser whenever a source mentions
 * `@describe_type`, and inference types the call as that struct, so this builds the
 * product that matches rather than introducing a shape of its own.
 */
function typeDescription(
  size: number,
  expression: TypedDucklangExpression,
): TypedDucklangExpression {
  return {
    kind: "product",
    productKind: "tuple",
    values: [{
      kind: "integer",
      value: size,
      type: { kind: "constructor", name: "i32", arguments: [] },
      span: expression.span,
    }],
    nominalType: "$TypeDescription",
    type: expression.type,
    span: expression.span,
  };
}

function foldStaticIntrinsic(
  expression: TypedDucklangExpression,
  values: Map<number, TypedDucklangExpression>,
  specialization: SpecializationContext,
): TypedDucklangExpression | undefined {
  if (expression.kind !== "call") return undefined;
  const callee = staticValue(expression.callee, values);
  const arguments_ = expression.arguments.map((argument) =>
    staticValue(argument, values)
  );
  if (callee.kind === "primitive") {
    if (
      callee.primitiveId === PrimitiveId.bytesGenerate &&
      arguments_.length === 2 && arguments_[0].kind === "integer" &&
      arguments_[1].kind === "function"
    ) {
      expression = { ...expression, arguments: arguments_ };
    }
    if (
      callee.primitiveId === PrimitiveId.booleanNot &&
      arguments_.length === 1
    ) {
      return {
        kind: "binary",
        operator: "==",
        left: arguments_[0],
        right: {
          kind: "boolean",
          value: false,
          type: arguments_[0].type,
          span: expression.span,
        },
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bytesGenerate &&
      arguments_.length === 2 && arguments_[1].kind === "function" &&
      arguments_[1].parameters.length === 1 &&
      !referencesSymbol(
        arguments_[1].body,
        arguments_[1].parameters[0].id,
      )
    ) {
      return {
        ...expression,
        callee: {
          ...callee,
          primitiveId: PrimitiveId.bytesFill,
          type: {
            kind: "function",
            parameter: arguments_[0].type,
            result: {
              kind: "function",
              parameter: arguments_[1].body.type,
              result: expression.type,
            },
          },
        },
        arguments: [arguments_[0], arguments_[1].body],
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bytesGenerate &&
      arguments_.length === 2 && arguments_[0].kind === "integer" &&
      arguments_[1].kind === "function"
    ) {
      return expression;
    }
    if (
      callee.primitiveId === PrimitiveId.panic && arguments_.length === 1 &&
      arguments_[0].kind === "string"
    ) {
      return { ...expression, callee, arguments: [] };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferLength &&
      arguments_.length === 1 && arguments_[0].kind === "if"
    ) {
      return rewriteExpression(
        {
          ...arguments_[0],
          consequence: {
            ...expression,
            arguments: [arguments_[0].consequence],
          },
          alternative: {
            ...expression,
            arguments: [arguments_[0].alternative],
          },
          type: expression.type,
          span: expression.span,
        },
        values,
        specialization,
      );
    }
    if (
      callee.primitiveId === PrimitiveId.bufferLength &&
      arguments_.length === 1 && arguments_[0].kind === "string"
    ) {
      return {
        kind: "integer",
        value: new TextEncoder().encode(arguments_[0].value).length,
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferAppend &&
      arguments_.length === 2 && arguments_[0].kind === "string" &&
      arguments_[1].kind === "string"
    ) {
      return {
        kind: "string",
        value: arguments_[0].value + arguments_[1].value,
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferGet &&
      arguments_.length === 2 && arguments_[0].kind === "string" &&
      arguments_[1].kind === "integer"
    ) {
      const bytes = new TextEncoder().encode(arguments_[0].value);
      const index = arguments_[1].value;
      if (index < 0 || index >= bytes.length) {
        throw new RangeError(
          `${expression.span.file}:${expression.span.start}: Ducklang text index ${index} is outside byte length ${bytes.length}`,
        );
      }
      return {
        kind: "integer",
        value: bytes[index],
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferGet &&
      arguments_.length === 2 && arguments_[0].kind === "string"
    ) {
      return {
        kind: "selectProductElement",
        values: [...new TextEncoder().encode(arguments_[0].value)].map(
          (value): TypedDucklangExpression => ({
            kind: "integer",
            value,
            type: expression.type,
            span: expression.span,
          }),
        ),
        index: expression.arguments[1],
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId !== PrimitiveId.bufferSlice ||
      arguments_.length !== 3 || arguments_[0].kind !== "string" ||
      arguments_[1].kind !== "integer" || arguments_[2].kind !== "integer"
    ) {
      return { ...expression, callee, arguments: arguments_ };
    }
    const bytes = new TextEncoder().encode(arguments_[0].value);
    const start = arguments_[1].value;
    const end = arguments_[2].value;
    if (start < 0 || end < start || end > bytes.length) {
      throw new RangeError(
        `${expression.span.file}:${expression.span.start}: Ducklang slice range ${start}..${end} is outside text byte length ${bytes.length}`,
      );
    }
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(start, end),
      );
    } catch (cause) {
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: Ducklang static slice ${start}..${end} splits a UTF-8 sequence`,
        { cause },
      );
    }
    return {
      kind: "string",
      value,
      type: expression.type,
      span: expression.span,
    };
  }
  if (callee.kind !== "intrinsic") return undefined;
  if (
    (callee.modulePath === "duck:prelude" ||
      callee.modulePath === "duck:prelude/types") &&
    callee.exportName === "cast" && arguments_.length === 2
  ) {
    return {
      ...expression.arguments[0],
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/testing" &&
    (callee.exportName === "assert" ||
      callee.exportName === "assert_false") &&
    expression.arguments.length === 1
  ) {
    const unit: TypedDucklangExpression = {
      kind: "unit",
      type: expression.type,
      span: expression.span,
    };
    const panic: TypedDucklangExpression = {
      kind: "call",
      callee: {
        kind: "primitive",
        primitiveId: PrimitiveId.panic,
        type: {
          kind: "function",
          parameter: { kind: "constructor", name: "text", arguments: [] },
          result: expression.type,
        },
        span: expression.span,
      },
      arguments: [],
      type: expression.type,
      span: expression.span,
    };
    const assertsTruth = callee.exportName === "assert";
    return rewriteExpression(
      {
        kind: "if",
        condition: expression.arguments[0],
        consequence: assertsTruth ? unit : panic,
        alternative: assertsTruth ? panic : unit,
        type: expression.type,
        span: expression.span,
      },
      values,
      specialization,
    );
  }
  if (
    callee.modulePath === "duck:compiler/string-pattern" &&
    arguments_.length === 3 && arguments_[0].kind === "string" &&
    arguments_[1].kind === "string" && arguments_[2].kind === "string"
  ) {
    const value = arguments_[0].value;
    const prefix = arguments_[1].value;
    const suffix = arguments_[2].value;
    const matches = value.length >= prefix.length + suffix.length &&
      value.startsWith(prefix) && value.endsWith(suffix);
    if (callee.exportName === "matches") {
      return {
        kind: "boolean",
        value: matches,
        type: expression.type,
        span: expression.span,
      };
    }
    if (callee.exportName === "capture") {
      return {
        kind: "string",
        value: matches
          ? value.slice(prefix.length, value.length - suffix.length)
          : "",
        type: expression.type,
        span: expression.span,
      };
    }
  }
  if (
    callee.modulePath === "duck:compiler/reflect" &&
    callee.exportName === "describe_type" && arguments_.length === 1 &&
    arguments_[0].kind === "intrinsic" &&
    arguments_[0].modulePath.startsWith("duck:type/")
  ) {
    // The descriptor payload already carries the field types, so the size comes from
    // the same layout rules Core uses rather than from arithmetic invented here.
    // A builtin carries its bare source name while a struct carries a JSON payload,
    // so the shape has to be decided before parsing rather than after.
    if (arguments_[0].modulePath === "duck:type/builtin") {
      return typeDescription(
        ducklangReflectedLayout({
          kind: "builtin",
          name: arguments_[0].exportName,
        }).size,
        expression,
      );
    }
    const payload = JSON.parse(arguments_[0].exportName) as {
      readonly fields?: readonly { readonly type: string }[];
      readonly layout?: { readonly size: number };
    };
    // `reflectDucklangTypes` precomputes the layout when it has the declaration table,
    // which is the only way a nested or generic field can be answered. A bare struct
    // name resolved straight to an intrinsic carries no layout, so scalar fields are
    // laid out from the payload and anything else is refused rather than guessed.
    if (payload.layout !== undefined) {
      return typeDescription(payload.layout.size, expression);
    }
    const reflected: DucklangReflectedType = {
      kind: "struct",
      fields: payload.fields ?? [],
    };
    return {
      kind: "product",
      productKind: "tuple",
      values: [{
        kind: "integer",
        value: ducklangReflectedLayout(reflected).size,
        type: { kind: "constructor", name: "i32", arguments: [] },
        span: expression.span,
      }],
      nominalType: "$TypeDescription",
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:compiler/type-pattern" &&
    callee.exportName === "matches" && arguments_.length === 2 &&
    arguments_[0].kind === "intrinsic" &&
    arguments_[0].modulePath.startsWith("duck:type/") &&
    arguments_[1].kind === "string"
  ) {
    const declaration = JSON.parse(arguments_[0].exportName) as {
      readonly fields?: readonly {
        readonly name: string;
        readonly type: string;
      }[];
    };
    const pattern = JSON.parse(arguments_[1].value) as {
      readonly kind: string;
      readonly fields: readonly {
        readonly name: string;
        readonly type: string;
      }[];
      readonly open: boolean;
    };
    const declarationKind = arguments_[0].modulePath.slice(
      "duck:type/".length,
    );
    const declarationFields = declaration.fields ?? [];
    const fieldsMatch = pattern.fields.every((expected) =>
      declarationFields.some((field) =>
        field.name === expected.name && field.type === expected.type
      )
    );
    return {
      kind: "boolean",
      value: declarationKind === pattern.kind && fieldsMatch &&
        (pattern.open || declarationFields.length === pattern.fields.length),
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    ((callee.modulePath === "duck:prelude/functional" &&
      (callee.exportName === "apply" || callee.exportName === "pipe")) ||
      (callee.modulePath === "duck:prelude/abstractions" &&
        (callee.exportName === "patch_apply" ||
          callee.exportName === "predicate_test"))) &&
    arguments_.length === 2
  ) {
    const piped = callee.exportName === "pipe";
    const functionIndex = piped ? 1 : 0;
    const argumentIndex = piped ? 0 : 1;
    if (arguments_[functionIndex].kind !== "function") return undefined;
    return {
      kind: "call",
      callee: expression.arguments[functionIndex],
      arguments: [expression.arguments[argumentIndex]],
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    ((callee.modulePath === "duck:prelude/functional" &&
      callee.exportName === "identity") ||
      (callee.modulePath === "duck:prelude/abstractions" &&
        (callee.exportName === "patch" ||
          callee.exportName === "predicate"))) && arguments_.length === 1
  ) {
    return expression.arguments[0];
  }
  if (
    callee.modulePath === "duck:prelude/functional" &&
    callee.exportName === "option_unwrap_or" && arguments_.length === 2 &&
    arguments_[1].kind === "unionCase"
  ) {
    return arguments_[1].caseName === "Some"
      ? arguments_[1].value
      : expression.arguments[0];
  }
  if (
    callee.modulePath.startsWith("duck:struct/") &&
    callee.exportName === "new" && arguments_.length === 1
  ) {
    return expression.arguments[0];
  }
  if (
    ((callee.modulePath === "duck:prelude/functional" &&
      callee.exportName === "compose") ||
      (callee.modulePath === "duck:prelude/abstractions" &&
        callee.exportName === "patch_compose")) &&
    arguments_.length === 2 &&
    arguments_[0].kind === "function" &&
    arguments_[0].type.kind === "function" &&
    arguments_[0].parameters.length === 1 &&
    arguments_[1].kind === "function" &&
    arguments_[1].type.kind === "function" &&
    arguments_[1].parameters.length === 1
  ) {
    specialization.functionConstructingIntrinsicFoldCount += 1;
    const parameter = arguments_[1].parameters[0];
    const parameterReference: TypedDucklangExpression = {
      kind: "reference",
      symbol: parameter,
      type: arguments_[1].type.parameter,
      span: expression.span,
    };
    const intermediate: TypedDucklangExpression = {
      kind: "call",
      callee: expression.arguments[1],
      arguments: [parameterReference],
      type: arguments_[1].body.type,
      span: expression.span,
    };
    return {
      kind: "function",
      recursive: false,
      parameters: [parameter],
      body: {
        kind: "call",
        callee: expression.arguments[0],
        arguments: [intermediate],
        type: arguments_[0].body.type,
        span: expression.span,
      },
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/abstractions" &&
    callee.exportName === "predicate_and" && arguments_.length === 2 &&
    arguments_[0].kind === "function" &&
    arguments_[0].type.kind === "function" &&
    arguments_[0].parameters.length === 1 &&
    arguments_[1].kind === "function"
  ) {
    specialization.functionConstructingIntrinsicFoldCount += 1;
    const parameter = arguments_[0].parameters[0];
    const predicateResultType = arguments_[0].body.type;
    const parameterReference: TypedDucklangExpression = {
      kind: "reference",
      symbol: parameter,
      type: arguments_[0].type.parameter,
      span: expression.span,
    };
    return {
      kind: "function",
      recursive: false,
      parameters: [parameter],
      body: {
        kind: "binary",
        operator: "&&",
        left: {
          kind: "call",
          callee: expression.arguments[0],
          arguments: [parameterReference],
          type: predicateResultType,
          span: expression.span,
        },
        right: {
          kind: "call",
          callee: expression.arguments[1],
          arguments: [parameterReference],
          type: predicateResultType,
          span: expression.span,
        },
        type: predicateResultType,
        span: expression.span,
      },
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/abstractions" &&
    callee.exportName === "span" && arguments_.length === 2
  ) {
    return {
      kind: "product",
      productKind: "tuple",
      values: expression.arguments,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/abstractions" &&
    callee.exportName === "span_contains" && arguments_.length === 2 &&
    arguments_[0].kind === "product" &&
    arguments_[0].values[0]?.kind === "integer" &&
    arguments_[0].values[1]?.kind === "integer" &&
    arguments_[1].kind === "integer"
  ) {
    return {
      kind: "boolean",
      value: arguments_[0].values[0].value <= arguments_[1].value &&
        arguments_[1].value < arguments_[0].values[1].value,
      type: expression.type,
      span: expression.span,
    };
  }
  return undefined;
}

function staticValue(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  let value = expression;
  while (value.kind === "comptime") value = value.expression;
  if (value.kind !== "reference") return value;
  const resolved = values.get(value.symbol.id);
  if (resolved === undefined) return value;
  let unwrapped = resolved;
  while (unwrapped.kind === "comptime") unwrapped = unwrapped.expression;
  if (unwrapped.kind !== "reference") return unwrapped;
  if (unwrapped.symbol.id === value.symbol.id) return unwrapped;

  const visited = new Set([value.symbol.id]);
  value = unwrapped;
  while (true) {
    if (value.kind !== "reference" || visited.has(value.symbol.id)) break;
    visited.add(value.symbol.id);
    const next = values.get(value.symbol.id);
    if (next === undefined) break;
    value = next;
    while (value.kind === "comptime") value = value.expression;
  }
  return value;
}

function substitute(
  expression: TypedDucklangExpression,
  substitutions: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  const rewritten = new WeakMap<object, TypedDucklangExpression>();
  const pending: {
    readonly expression: TypedDucklangExpression;
    readonly childrenVisited: boolean;
  }[] = [{ expression, childrenVisited: false }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (rewritten.has(current.expression)) continue;
    if (current.expression.kind === "reference") {
      rewritten.set(
        current.expression,
        substitutions.get(current.expression.symbol.id) ?? current.expression,
      );
      continue;
    }
    if (!current.childrenVisited) {
      pending.push({ ...current, childrenVisited: true });
      visitDucklangExpressionChildren(current.expression, (child) => {
        if (!rewritten.has(child)) {
          pending.push({ expression: child, childrenVisited: false });
        }
      });
      continue;
    }
    rewritten.set(
      current.expression,
      rewriteChildren(current.expression, (child) => {
        const result = rewritten.get(child);
        if (result !== undefined) return result;
        throw new Error(
          `${current.expression.span.file}:${current.expression.span.start}: Ducklang substitution visited a parent before its child`,
        );
      }),
    );
  }
  return rewritten.get(expression)!;
}

function collapseEmptyBlock(
  expression: TypedDucklangExpression,
): TypedDucklangExpression {
  if (expression.kind === "block" && expression.steps.length === 0) {
    return expression.result;
  }
  return expression;
}

export function rewriteChildren(
  expression: TypedDucklangExpression,
  rewrite: (child: TypedDucklangExpression) => TypedDucklangExpression,
): TypedDucklangExpression {
  switch (expression.kind) {
    case "effectHandler": {
      const fields = expression.fields.map((field) => {
        const value = rewrite(field.value);
        return value === field.value ? field : {
          ...field,
          value,
        };
      });
      return fields.every((field, index) => field === expression.fields[index])
        ? expression
        : { ...expression, fields };
    }
    case "handle": {
      const body = rewrite(expression.body);
      const handler = rewrite(expression.handler);
      if (body === expression.body && handler === expression.handler) {
        return expression;
      }
      return {
        ...expression,
        body,
        handler,
      };
    }
    case "resume": {
      const value = rewrite(expression.value);
      return value === expression.value ? expression : { ...expression, value };
    }
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "intrinsic":
    case "primitive":
    case "reference":
      return expression;
    case "unionCase": {
      const value = rewrite(expression.value);
      return value === expression.value ? expression : { ...expression, value };
    }
    case "product": {
      const values = rewriteExpressionList(expression.values, rewrite);
      return values === expression.values ? expression : {
        ...expression,
        values,
      };
    }
    case "project":
    case "namedProject": {
      const product = rewrite(expression.product);
      return product === expression.product ? expression : {
        ...expression,
        product,
      };
    }
    case "recordUpdate": {
      const product = rewrite(expression.product);
      const fields = expression.fields.map((field) => {
        const value = rewrite(field.value);
        return value === field.value ? field : { ...field, value };
      });
      if (
        product === expression.product &&
        fields.every((field, index) => field === expression.fields[index])
      ) {
        return expression;
      }
      return {
        ...expression,
        product,
        fields,
      };
    }
    case "function": {
      const body = rewrite(expression.body);
      return body === expression.body ? expression : { ...expression, body };
    }
    case "call": {
      const callee = rewrite(expression.callee);
      const arguments_ = rewriteExpressionList(expression.arguments, rewrite);
      if (callee === expression.callee && arguments_ === expression.arguments) {
        return expression;
      }
      return {
        ...expression,
        callee,
        arguments: arguments_,
      };
    }
    case "hostCall": {
      const arguments_ = rewriteExpressionList(expression.arguments, rewrite);
      return arguments_ === expression.arguments ? expression : {
        ...expression,
        arguments: arguments_,
      };
    }
    case "optionDo": {
      const option = rewrite(expression.option);
      return option === expression.option ? expression : {
        ...expression,
        option,
      };
    }
    case "index": {
      const collection = rewrite(expression.collection);
      const index = rewrite(expression.index);
      if (
        collection === expression.collection && index === expression.index
      ) {
        return expression;
      }
      return {
        ...expression,
        collection,
        index,
      };
    }
    case "selectProductElement": {
      const values = rewriteExpressionList(expression.values, rewrite);
      const index = rewrite(expression.index);
      if (values === expression.values && index === expression.index) {
        return expression;
      }
      return {
        ...expression,
        values,
        index,
      };
    }
    case "indexUpdate": {
      const product = rewrite(expression.product);
      const index = rewrite(expression.index);
      const value = rewrite(expression.value);
      if (
        product === expression.product && index === expression.index &&
        value === expression.value
      ) {
        return expression;
      }
      return {
        ...expression,
        product,
        index,
        value,
      };
    }
    case "textAppend":
    case "binary": {
      const left = rewrite(expression.left);
      const right = rewrite(expression.right);
      if (left === expression.left && right === expression.right) {
        return expression;
      }
      return {
        ...expression,
        left,
        right,
      };
    }
    case "ownership":
    case "return":
    case "comptime": {
      const rewritten = rewrite(expression.expression);
      return rewritten === expression.expression ? expression : {
        ...expression,
        expression: rewritten,
      };
    }
    case "scratch": {
      const body = rewrite(expression.body);
      return body === expression.body ? expression : { ...expression, body };
    }
    case "if": {
      const condition = rewrite(expression.condition);
      const consequence = rewrite(expression.consequence);
      const alternative = rewrite(expression.alternative);
      if (
        condition === expression.condition &&
        consequence === expression.consequence &&
        alternative === expression.alternative
      ) {
        return expression;
      }
      return {
        ...expression,
        condition,
        consequence,
        alternative,
      };
    }
    case "ifUnion": {
      const value = rewrite(expression.value);
      const consequence = rewrite(expression.consequence);
      const alternative = rewrite(expression.alternative);
      if (
        value === expression.value && consequence === expression.consequence &&
        alternative === expression.alternative
      ) {
        return expression;
      }
      return {
        ...expression,
        value,
        consequence,
        alternative,
      };
    }
    case "block": {
      const steps = expression.steps.map(
        (step): TypedDucklangBlockStep => {
          if (step.kind === "expression") {
            const rewritten = rewrite(step.expression);
            return rewritten === step.expression ? step : {
              kind: "expression",
              expression: rewritten,
            };
          }
          const value = rewrite(step.binding.value);
          return value === step.binding.value ? step : {
            kind: "binding",
            binding: {
              ...step.binding,
              value,
            },
          };
        },
      );
      const result = rewrite(expression.result);
      if (
        result === expression.result &&
        steps.every((step, index) => step === expression.steps[index])
      ) {
        return expression;
      }
      return {
        ...expression,
        steps,
        result,
      };
    }
  }
}

function rewriteExpressionList(
  expressions: readonly TypedDucklangExpression[],
  rewrite: (expression: TypedDucklangExpression) => TypedDucklangExpression,
): readonly TypedDucklangExpression[] {
  const rewritten = expressions.map(rewrite);
  return rewritten.every((expression, index) =>
      expression === expressions[index]
    )
    ? expressions
    : rewritten;
}

export function visitDucklangExpressionChildren(
  expression: TypedDucklangExpression,
  visit: (child: TypedDucklangExpression) => void,
): void {
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "intrinsic":
    case "primitive":
    case "reference":
      return;
    case "effectHandler":
      for (const field of expression.fields) visit(field.value);
      return;
    case "handle":
      visit(expression.body);
      visit(expression.handler);
      return;
    case "resume":
      visit(expression.value);
      return;
    case "unionCase":
      visit(expression.value);
      return;
    case "product":
      for (const value of expression.values) visit(value);
      return;
    case "project":
    case "namedProject":
      visit(expression.product);
      return;
    case "recordUpdate":
      visit(expression.product);
      for (const field of expression.fields) visit(field.value);
      return;
    case "function":
      visit(expression.body);
      return;
    case "call":
      visit(expression.callee);
      for (const argument of expression.arguments) visit(argument);
      return;
    case "hostCall":
      for (const argument of expression.arguments) visit(argument);
      return;
    case "optionDo":
      visit(expression.option);
      return;
    case "index":
      visit(expression.collection);
      visit(expression.index);
      return;
    case "selectProductElement":
      for (const value of expression.values) visit(value);
      visit(expression.index);
      return;
    case "indexUpdate":
      visit(expression.product);
      visit(expression.index);
      visit(expression.value);
      return;
    case "textAppend":
    case "binary":
      visit(expression.left);
      visit(expression.right);
      return;
    case "ownership":
    case "return":
    case "comptime":
      visit(expression.expression);
      return;
    case "scratch":
      visit(expression.body);
      return;
    case "if":
      visit(expression.condition);
      visit(expression.consequence);
      visit(expression.alternative);
      return;
    case "ifUnion":
      visit(expression.value);
      visit(expression.consequence);
      visit(expression.alternative);
      return;
    case "block":
      for (const step of expression.steps) {
        visit(
          step.kind === "binding" ? step.binding.value : step.expression,
        );
      }
      visit(expression.result);
      return;
  }
}

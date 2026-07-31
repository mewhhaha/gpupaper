import {
  rewriteChildren,
  visitDucklangExpressionChildren,
} from "./ducklang_closures.ts";
import type { DucklangSymbol } from "./ducklang_resolution.ts";
import { ducklangExpressionEffects } from "./ducklang_types.ts";
import type {
  TypedDucklangBinding,
  TypedDucklangBlockStep,
  TypedDucklangEffectModule,
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";
import { formatType } from "./types.ts";
import type { CallableEffectRow, Type } from "./types.ts";

export type DucklangStructuralEffectMetrics = {
  readonly directStatePassingRegionCount: number;
  readonly directStatePassingFunctionCount: number;
  readonly cpsTransformedRegionCount: number;
  readonly cpsTransformedFunctionCount: number;
  readonly handledPerformanceCount: number;
  readonly continuationCaptureCount: number;
  readonly capabilityOperandCount: number;
};

type MutableMetrics = {
  directStatePassingRegionCount: number;
  cpsTransformedRegionCount: number;
  handledPerformanceCount: number;
  continuationCaptureCount: number;
  capabilityOperandCount: number;
};

type HandlerPlan = {
  readonly capabilityId: string;
  readonly effectName: string;
  readonly answerType: Type;
  readonly prefixSteps: readonly TypedDucklangBlockStep[];
  readonly stateBindings: readonly TypedDucklangBinding[];
  readonly clauses: ReadonlyMap<string, TypedDucklangExpression>;
};

type TranslationContext = {
  readonly plan: HandlerPlan;
  readonly strategy: "cps" | "direct";
  readonly translationResultType: Type;
  readonly bindings: Map<number, TypedDucklangBinding>;
  readonly clones: Map<number, EffectClone>;
  readonly effectfulBindings: Map<number, boolean>;
  readonly generatedBindings: TypedDucklangBinding[];
  readonly symbolTypes: Map<number, Type>;
  readonly templateSymbol: DucklangSymbol;
  readonly stateArguments: readonly TypedDucklangExpression[];
  readonly loweredClauses: Map<string, TypedDucklangExpression>;
  readonly allocateSymbol: (
    text: string,
    type: Type,
    template: DucklangSymbol,
  ) => DucklangSymbol;
  readonly handledPerformances: Set<string>;
};

type EffectClone = {
  readonly binding: TypedDucklangBinding;
  readonly captures: readonly {
    readonly symbol: DucklangSymbol;
    readonly type: Type;
  }[];
};

type ClauseResumptionLowering =
  | {
    readonly kind: "cps";
    readonly symbol: DucklangSymbol;
  }
  | {
    readonly kind: "direct";
    readonly sourceSymbolId: number;
  };

export function lowerDucklangEffectsStructurally(
  module: TypedDucklangEffectModule,
): {
  readonly module: TypedDucklangModule;
  readonly metrics: DucklangStructuralEffectMetrics;
} {
  const bindings = collectBindings(module);
  const symbolTypes = new Map(module.symbolTypes);
  const generatedBindings: TypedDucklangBinding[] = [];
  const handledFamilies = new Set<string>();
  const residualOperations = ducklangExpressionEffects({
    kind: "block",
    steps: module.bindings.flatMap((binding): TypedDucklangBlockStep[] =>
      binding.value.kind === "function" ? [] : [{ kind: "binding", binding }]
    ),
    result: module.result,
    type: module.result.type,
    span: module.result.span,
  }).operations;
  const metrics: MutableMetrics = {
    directStatePassingRegionCount: 0,
    cpsTransformedRegionCount: 0,
    handledPerformanceCount: 0,
    continuationCaptureCount: 0,
    capabilityOperandCount: 0,
  };
  const handledPerformances = new Set<string>();
  let nextSymbolId = Math.max(0, ...symbolTypes.keys()) + 1;
  const allocateSymbol = (
    text: string,
    type: Type,
    template: DucklangSymbol,
  ): DucklangSymbol => {
    const symbol: DucklangSymbol = {
      id: nextSymbolId,
      moduleId: template.moduleId,
      text,
      scope: "parameter",
      span: template.span,
    };
    nextSymbolId += 1;
    symbolTypes.set(symbol.id, type);
    return symbol;
  };
  const lower = (
    expression: TypedDucklangExpression,
  ): TypedDucklangExpression => {
    const loweredChildren = rewriteChildren(expression, lower);
    if (loweredChildren.kind !== "handle") return loweredChildren;
    const plan = handlerPlan(
      loweredChildren.handler,
      bindings,
      new Set(),
    );
    if (plan === undefined) {
      throw new TypeError(
        `${loweredChildren.handler.span.file}:${loweredChildren.handler.span.start}: structural Ducklang effect lowering requires a statically selected handler`,
      );
    }
    requirePureHandlerInitialization(plan);
    handledFamilies.add(plan.effectName);
    const strategy = supportsDirectStatePassing(plan) ? "direct" : "cps";
    const context: TranslationContext = {
      plan,
      strategy,
      translationResultType: plan.answerType,
      bindings,
      clones: new Map(),
      effectfulBindings: new Map(),
      generatedBindings,
      symbolTypes,
      templateSymbol: handlerTemplate(plan, loweredChildren),
      stateArguments: plan.stateBindings.map((binding) =>
        referenceExpression(binding.symbol, binding.type)
      ),
      loweredClauses: new Map(),
      allocateSymbol,
      handledPerformances,
    };
    if (strategy === "direct") {
      metrics.directStatePassingRegionCount += 1;
    } else {
      metrics.cpsTransformedRegionCount += 1;
    }
    const returnClause = plan.clauses.get("return");
    if (returnClause === undefined) {
      throw new Error(
        `${loweredChildren.span.file}:${loweredChildren.span.start}: typed handler ${plan.effectName} lost its return clause`,
      );
    }
    const handled = translateComputation(
      loweredChildren.body,
      (value, stateArguments) =>
        callExpression(
          capabilityClauses(context).get("return") ?? returnClause,
          [value, ...stateArguments],
          plan.answerType,
          loweredChildren.span,
        ),
      context,
    );
    if (plan.prefixSteps.length === 0) return handled;
    return {
      kind: "block",
      steps: plan.prefixSteps.map((step) =>
        step.kind === "binding"
          ? {
            kind: "binding",
            binding: {
              ...step.binding,
              value: lower(step.binding.value),
            },
          }
          : { kind: "expression", expression: lower(step.expression) }
      ),
      result: handled,
      type: plan.answerType,
      span: loweredChildren.span,
    };
  };

  const loweredBindings = module.bindings.map((binding) => ({
    ...binding,
    value: lower(binding.value),
  }));
  const result = lower(module.result);
  const allBindings = [...loweredBindings, ...generatedBindings];
  const reachableRuntime = reachableRuntimeSymbols(
    allBindings,
    result,
    module.exportNames,
  );
  const candidateBindings = allBindings.filter((binding) =>
    binding.stage === "compileTime" ||
    reachableRuntime.has(binding.symbol.id)
  );
  const referenced = referencedBindingSymbols(candidateBindings, result);
  const retainedBindings = candidateBindings.filter((binding) => {
    if (!containsEffectSyntax(binding.value)) return true;
    if (binding.stage === "compileTime") return true;
    if (!referenced.has(binding.symbol.id)) return false;
    throw new TypeError(
      `${binding.span.file}:${binding.span.start}: first-class Ducklang handler ${binding.symbol.text} escapes structural effect lowering`,
    );
  });
  const requiredEffects = residualRequiredEffects(
    module,
    residualOperations,
    handledFamilies,
  );
  const retainedMetrics = measureRetainedLowering(
    retainedBindings,
    result,
  );
  return {
    module: {
      ...module,
      bindings: retainedBindings,
      result,
      requiredEffects,
      symbolTypes,
    },
    metrics: {
      ...metrics,
      ...retainedMetrics,
      handledPerformanceCount: handledPerformances.size,
    },
  };
}

function reachableRuntimeSymbols(
  bindings: readonly TypedDucklangBinding[],
  result: TypedDucklangExpression,
  exportNames: readonly string[],
): ReadonlySet<number> {
  const bindingsBySymbol = new Map(
    bindings.map((binding) => [binding.symbol.id, binding]),
  );
  const reachable = new Set<number>();
  const visit = (expression: TypedDucklangExpression): void => {
    if (expression.kind === "reference") {
      const binding = bindingsBySymbol.get(expression.symbol.id);
      if (binding !== undefined && !reachable.has(binding.symbol.id)) {
        reachable.add(binding.symbol.id);
        visit(binding.value);
      }
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  for (const binding of bindings) {
    if (!exportNames.includes(binding.symbol.text)) continue;
    reachable.add(binding.symbol.id);
    visit(binding.value);
  }
  visit(result);
  return reachable;
}

function residualRequiredEffects(
  module: TypedDucklangModule,
  operations: readonly string[],
  handledFamilies: ReadonlySet<string>,
): TypedDucklangModule["requiredEffects"] {
  const originalEffects = new Map(
    module.requiredEffects.map((effect) => [
      `${effect.effectName}.${effect.operationName}`,
      effect,
    ]),
  );
  const retainedOperations = new Set(operations);
  for (const effect of module.requiredEffects) {
    if (!handledFamilies.has(effect.effectName)) {
      retainedOperations.add(`${effect.effectName}.${effect.operationName}`);
    }
  }
  return [...retainedOperations].toSorted().map((operation) => {
    const effect = originalEffects.get(operation);
    if (effect !== undefined) return effect;
    throw new Error(
      `${module.file}: structural effect lowering introduced residual operation ${operation} outside the inferred root row`,
    );
  });
}

function collectBindings(
  module: TypedDucklangModule,
): Map<number, TypedDucklangBinding> {
  const bindings = new Map<number, TypedDucklangBinding>();
  const visit = (expression: TypedDucklangExpression): void => {
    if (expression.kind === "block") {
      for (const step of expression.steps) {
        if (step.kind !== "binding") continue;
        bindings.set(step.binding.symbol.id, step.binding);
      }
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  for (const binding of module.bindings) {
    bindings.set(binding.symbol.id, binding);
    visit(binding.value);
  }
  visit(module.result);
  return bindings;
}

function translateComputation(
  expression: TypedDucklangExpression,
  continuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
  context: TranslationContext,
  returnContinuation = continuation,
): TypedDucklangExpression {
  if (expression.kind === "effectHandler") {
    return continuation(expression, context.stateArguments);
  }
  if (expression.kind === "function") {
    if (!isGeneratedResumption(expression)) {
      return continuation(expression, context.stateArguments);
    }
    if (context.strategy === "direct") {
      return continuation(expression, context.stateArguments);
    }
    if (
      !expressionRequiresEffect(
        expression.body,
        context.plan.effectName,
        context.bindings,
        context.effectfulBindings,
        new Set(),
      )
    ) {
      return continuation(expression, context.stateArguments);
    }
    const resultType = functionResultType(expression.type);
    if (formatType(resultType) !== formatType(context.plan.answerType)) {
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: nested effectful function returns ${
          formatType(resultType)
        }, but handler ${context.plan.effectName} has answer type ${
          formatType(context.plan.answerType)
        }`,
      );
    }
    const body = translateComputation(
      expression.body,
      (value) => value,
      context,
    );
    return continuation({ ...expression, body }, context.stateArguments);
  }
  if (expression.kind === "return") {
    return translateComputation(
      expression.expression,
      returnContinuation,
      context,
      returnContinuation,
    );
  }
  if (expression.kind === "block") {
    return translateBlock(
      expression,
      0,
      continuation,
      context,
      returnContinuation,
    );
  }
  if (expression.kind === "if") {
    return translateComputation(
      expression.condition,
      (condition, stateArguments) => {
        const branchContext = { ...context, stateArguments };
        return {
          ...expression,
          condition,
          consequence: translateComputation(
            expression.consequence,
            continuation,
            branchContext,
            returnContinuation,
          ),
          alternative: translateComputation(
            expression.alternative,
            continuation,
            branchContext,
            returnContinuation,
          ),
          type: context.translationResultType,
        };
      },
      context,
      returnContinuation,
    );
  }
  if (expression.kind === "ifUnion") {
    return translateComputation(
      expression.value,
      (value, stateArguments) => {
        const branchContext = { ...context, stateArguments };
        return {
          ...expression,
          value,
          consequence: translateComputation(
            expression.consequence,
            continuation,
            branchContext,
            returnContinuation,
          ),
          alternative: translateComputation(
            expression.alternative,
            continuation,
            branchContext,
            returnContinuation,
          ),
          type: context.translationResultType,
        };
      },
      context,
      returnContinuation,
    );
  }
  const children: TypedDucklangExpression[] = [];
  rewriteChildren(expression, (child) => {
    children.push(child);
    return child;
  });
  return translateChildren(
    expression,
    children,
    0,
    continuation,
    context,
    returnContinuation,
  );
}

function isGeneratedResumption(
  expression: Extract<
    TypedDucklangExpression,
    { readonly kind: "function" }
  >,
): boolean {
  return expression.parameters[0]?.text.startsWith("$resume_") === true;
}

function translateBlock(
  block: Extract<TypedDucklangExpression, { readonly kind: "block" }>,
  stepIndex: number,
  continuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
  context: TranslationContext,
  returnContinuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
): TypedDucklangExpression {
  const step = block.steps[stepIndex];
  if (step === undefined) {
    return translateComputation(
      block.result,
      continuation,
      context,
      returnContinuation,
    );
  }
  const stepExpression = step.kind === "binding"
    ? step.binding.value
    : step.expression;
  return translateComputation(
    stepExpression,
    (value, stateArguments) => {
      const remaining = translateBlock(
        block,
        stepIndex + 1,
        continuation,
        { ...context, stateArguments },
        returnContinuation,
      );
      const loweredStep: TypedDucklangBlockStep = step.kind === "binding"
        ? {
          kind: "binding",
          binding: { ...step.binding, value },
        }
        : { kind: "expression", expression: value };
      return {
        kind: "block",
        steps: [loweredStep],
        result: remaining,
        type: context.translationResultType,
        span: block.span,
      };
    },
    context,
    returnContinuation,
  );
}

function translateChildren(
  expression: TypedDucklangExpression,
  originalChildren: readonly TypedDucklangExpression[],
  childIndex: number,
  continuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
  context: TranslationContext,
  returnContinuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
): TypedDucklangExpression {
  const child = originalChildren[childIndex];
  if (child === undefined) {
    return translateEffectNode(expression, continuation, context);
  }
  return translateComputation(
    child,
    (value, stateArguments) =>
      translateChildren(
        replaceChild(expression, childIndex, value),
        originalChildren.with(childIndex, value),
        childIndex + 1,
        continuation,
        { ...context, stateArguments },
        returnContinuation,
      ),
    context,
    returnContinuation,
  );
}

function translateEffectNode(
  expression: TypedDucklangExpression,
  continuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
  context: TranslationContext,
): TypedDucklangExpression {
  if (
    expression.kind === "hostCall" &&
    expression.effectName === context.plan.effectName
  ) {
    const clause = capabilityClauses(context).get(expression.operationName);
    if (clause === undefined) {
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: handler ${context.plan.effectName} has no clause ${expression.operationName}`,
      );
    }
    context.handledPerformances.add(
      `${context.plan.effectName}\u0000${expression.span.file}\u0000${expression.span.start}\u0000${expression.span.end}`,
    );
    if (context.strategy === "direct") {
      const resultType = directResultType(
        expression.type,
        context.plan.stateBindings,
      );
      return continueDirectResult(
        callExpression(
          clause,
          [...expression.arguments, ...context.stateArguments],
          resultType,
          expression.span,
        ),
        expression.type,
        continuation,
        context,
      );
    }
    const resumption = createResumption(expression, continuation, context);
    return callExpression(
      clause,
      [...expression.arguments, ...context.stateArguments, resumption],
      context.plan.answerType,
      expression.span,
    );
  }
  if (
    expression.kind === "call" &&
    expression.callee.kind === "reference"
  ) {
    const binding = context.bindings.get(expression.callee.symbol.id);
    if (
      binding?.value.kind === "function" &&
      bindingRequiresEffect(
        binding,
        context.plan.effectName,
        context.bindings,
        context.effectfulBindings,
        new Set(),
      )
    ) {
      const clone = context.strategy === "direct"
        ? requireDirectClone(binding, context)
        : requireCpsClone(binding, context);
      const clauseArguments = operationClauses(context);
      if (context.strategy === "direct") {
        return continueDirectResult(
          callExpression(
            referenceExpression(clone.binding.symbol, clone.binding.type),
            [
              ...expression.arguments,
              ...clone.captures.map((capture) =>
                referenceExpression(capture.symbol, capture.type)
              ),
              ...context.stateArguments,
              ...clauseArguments,
            ],
            directResultType(
              expression.type,
              context.plan.stateBindings,
            ),
            expression.span,
          ),
          expression.type,
          continuation,
          context,
        );
      }
      const resumption = createResumption(expression, continuation, context);
      return callExpression(
        referenceExpression(clone.binding.symbol, clone.binding.type),
        [
          ...expression.arguments,
          ...clone.captures.map((capture) =>
            referenceExpression(capture.symbol, capture.type)
          ),
          ...context.stateArguments,
          ...clauseArguments,
          resumption,
        ],
        context.plan.answerType,
        expression.span,
      );
    }
  }
  return continuation(expression, context.stateArguments);
}

function continueDirectResult(
  call: TypedDucklangExpression,
  valueType: Type,
  continuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
  context: TranslationContext,
): TypedDucklangExpression {
  const resultSymbol = context.allocateSymbol(
    `$direct_result_${call.span.start}`,
    call.type,
    context.templateSymbol,
  );
  const resultReference = referenceExpression(resultSymbol, call.type);
  const includesValue = !isUnitType(valueType);
  const componentCount = context.plan.stateBindings.length +
    (includesValue ? 1 : 0);
  const value = includesValue
    ? componentCount === 1 ? resultReference : {
      kind: "project" as const,
      product: resultReference,
      index: 0,
      arity: componentCount,
      type: valueType,
      span: call.span,
    }
    : componentCount === 0
    ? resultReference
    : {
      kind: "unit" as const,
      type: valueType,
      span: call.span,
    };
  const stateArguments = context.plan.stateBindings.map((binding, index) =>
    componentCount === 1 ? resultReference : {
      kind: "project" as const,
      product: resultReference,
      index: index + (includesValue ? 1 : 0),
      arity: componentCount,
      type: binding.type,
      span: call.span,
    }
  );
  const remaining = continuation(value, stateArguments);
  return {
    kind: "block",
    steps: [{
      kind: "binding",
      binding: {
        symbol: resultSymbol,
        previous: undefined,
        recursive: false,
        stage: "runtime",
        value: call,
        type: call.type,
        latentEffects: [],
        latentEffectRow: {
          operations: [],
          parameterEffects: [],
        },
        span: call.span,
      },
    }],
    result: remaining,
    type: context.translationResultType,
    span: call.span,
  };
}

function createResumption(
  expression: TypedDucklangExpression,
  continuation: (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ) => TypedDucklangExpression,
  context: TranslationContext,
): Extract<TypedDucklangExpression, { readonly kind: "function" }> {
  const resultSymbol = context.allocateSymbol(
    `$resume_${expression.span.start}`,
    expression.type,
    context.templateSymbol,
  );
  const stateSymbols = context.plan.stateBindings.map((binding) =>
    context.allocateSymbol(
      `$state_${binding.symbol.text}_${expression.span.start}`,
      binding.type,
      binding.symbol,
    )
  );
  const stateArguments = stateSymbols.map((symbol, index) =>
    referenceExpression(symbol, context.plan.stateBindings[index].type)
  );
  const body = continuation(
    referenceExpression(resultSymbol, expression.type),
    stateArguments,
  );
  const resumption = functionExpression(
    [resultSymbol, ...stateSymbols],
    body,
    functionType([
      expression.type,
      ...context.plan.stateBindings.map((binding) => binding.type),
    ], context.plan.answerType),
    expression.span,
  );
  return resumption;
}

function requireCpsClone(
  binding: TypedDucklangBinding,
  context: TranslationContext,
): EffectClone {
  const existing = context.clones.get(binding.symbol.id);
  if (existing !== undefined) return existing;
  if (binding.value.kind !== "function") {
    throw new Error(
      `${binding.span.file}:${binding.span.start}: CPS source ${binding.symbol.text} is not a function`,
    );
  }
  const captures = functionCaptures(binding);
  const clauseValues = operationClauses(context);
  const continuationType = functionType([
    functionResultType(binding.type),
    ...context.plan.stateBindings.map((state) => state.type),
  ], context.plan.answerType);
  const continuationSymbol = context.allocateSymbol(
    `$continue_${binding.symbol.text}`,
    continuationType,
    binding.symbol,
  );
  const clauseSymbols = clauseValues.map((clause, index) =>
    context.allocateSymbol(
      `$cap_${context.plan.effectName}_${index}`,
      clause.type,
      binding.symbol,
    )
  );
  const stateSymbols = context.plan.stateBindings.map((state) =>
    context.allocateSymbol(
      `$state_${state.symbol.text}`,
      state.type,
      binding.symbol,
    )
  );
  const cloneType = functionType(
    [
      ...functionParameterTypes(binding.type),
      ...captures.map((capture) => capture.type),
      ...context.plan.stateBindings.map((state) => state.type),
      ...clauseValues.map((clause) => clause.type),
      continuationType,
    ],
    context.plan.answerType,
  );
  const cloneSymbol: DucklangSymbol = {
    ...binding.symbol,
    id: context.allocateSymbol(
      `$cps_${binding.symbol.text}_${context.plan.capabilityId}`,
      cloneType,
      binding.symbol,
    ).id,
    text: `$cps_${binding.symbol.text}_${context.plan.capabilityId}`,
    declaredType: undefined,
    declaredEffectRow: undefined,
  };
  context.symbolTypes.set(cloneSymbol.id, cloneType);
  const placeholder: TypedDucklangBinding = {
    ...binding,
    symbol: cloneSymbol,
    value: {
      ...binding.value,
      parameters: [
        ...binding.value.parameters,
        ...captures.map((capture) => capture.symbol),
        ...stateSymbols,
        ...clauseSymbols,
        continuationSymbol,
      ],
      body: binding.value.body,
      type: cloneType,
    },
    type: cloneType,
    latentEffects: binding.latentEffects.filter((effect) =>
      effect.effectName !== context.plan.effectName
    ),
    latentEffectRow: {
      ...binding.latentEffectRow,
      operations: binding.latentEffectRow.operations.filter((effect) =>
        effect.effectName !== context.plan.effectName
      ),
    },
  };
  context.clones.set(binding.symbol.id, {
    binding: placeholder,
    captures,
  });

  const clauses = new Map(
    [...context.plan.clauses.keys()]
      .filter((name) => name !== "return")
      .toSorted()
      .map((name, index) => [
        name,
        referenceExpression(clauseSymbols[index], clauseValues[index].type),
      ]),
  );
  const cloneContext: TranslationContext = {
    ...context,
    templateSymbol: binding.symbol,
    loweredClauses: clauses,
    stateArguments: stateSymbols.map((symbol, index) =>
      referenceExpression(symbol, context.plan.stateBindings[index].type)
    ),
  };
  const finalContinuation = (
    value: TypedDucklangExpression,
    stateArguments: readonly TypedDucklangExpression[],
  ): TypedDucklangExpression =>
    callExpression(
      referenceExpression(continuationSymbol, continuationType),
      [value, ...stateArguments],
      context.plan.answerType,
      binding.span,
    );
  const body = translateComputation(
    binding.value.body,
    finalContinuation,
    cloneContext,
  );
  const clone: TypedDucklangBinding = {
    ...placeholder,
    value: {
      ...placeholder.value,
      body,
    } as Extract<TypedDucklangExpression, { readonly kind: "function" }>,
  };
  const completed = { binding: clone, captures };
  context.clones.set(binding.symbol.id, completed);
  context.bindings.set(clone.symbol.id, clone);
  context.generatedBindings.push(clone);
  return completed;
}

function requireDirectClone(
  binding: TypedDucklangBinding,
  context: TranslationContext,
): EffectClone {
  const existing = context.clones.get(binding.symbol.id);
  if (existing !== undefined) return existing;
  if (binding.value.kind !== "function") {
    throw new Error(
      `${binding.span.file}:${binding.span.start}: direct state-passing source ${binding.symbol.text} is not a function`,
    );
  }
  const captures = functionCaptures(binding);
  const clauseValues = operationClauses(context);
  const clauseSymbols = clauseValues.map((clause, index) =>
    context.allocateSymbol(
      `$cap_${context.plan.effectName}_${index}`,
      clause.type,
      binding.symbol,
    )
  );
  const stateSymbols = context.plan.stateBindings.map((state) =>
    context.allocateSymbol(
      `$state_${state.symbol.text}`,
      state.type,
      binding.symbol,
    )
  );
  const resultType = directResultType(
    functionResultType(binding.type),
    context.plan.stateBindings,
  );
  const cloneType = functionType(
    [
      ...functionParameterTypes(binding.type),
      ...captures.map((capture) => capture.type),
      ...context.plan.stateBindings.map((state) => state.type),
      ...clauseValues.map((clause) => clause.type),
    ],
    resultType,
  );
  const cloneSymbol: DucklangSymbol = {
    ...binding.symbol,
    id: context.allocateSymbol(
      `$direct_${binding.symbol.text}_${context.plan.capabilityId}`,
      cloneType,
      binding.symbol,
    ).id,
    text: `$direct_${binding.symbol.text}_${context.plan.capabilityId}`,
    declaredType: undefined,
    declaredEffectRow: undefined,
  };
  context.symbolTypes.set(cloneSymbol.id, cloneType);
  const placeholder: TypedDucklangBinding = {
    ...binding,
    symbol: cloneSymbol,
    value: {
      ...binding.value,
      parameters: [
        ...binding.value.parameters,
        ...captures.map((capture) => capture.symbol),
        ...stateSymbols,
        ...clauseSymbols,
      ],
      body: binding.value.body,
      type: cloneType,
    },
    type: cloneType,
    latentEffects: binding.latentEffects.filter((effect) =>
      effect.effectName !== context.plan.effectName
    ),
    latentEffectRow: {
      ...binding.latentEffectRow,
      operations: binding.latentEffectRow.operations.filter((effect) =>
        effect.effectName !== context.plan.effectName
      ),
    },
  };
  context.clones.set(binding.symbol.id, {
    binding: placeholder,
    captures,
  });

  const clauses = new Map(
    [...context.plan.clauses.keys()]
      .filter((name) => name !== "return")
      .toSorted()
      .map((name, index) => [
        name,
        referenceExpression(clauseSymbols[index], clauseValues[index].type),
      ]),
  );
  const cloneContext: TranslationContext = {
    ...context,
    translationResultType: resultType,
    templateSymbol: binding.symbol,
    loweredClauses: clauses,
    stateArguments: stateSymbols.map((symbol, index) =>
      referenceExpression(symbol, context.plan.stateBindings[index].type)
    ),
  };
  const body = translateComputation(
    binding.value.body,
    (value, stateArguments) =>
      directResultExpression(value, stateArguments, binding.span),
    cloneContext,
  );
  const clone: TypedDucklangBinding = {
    ...placeholder,
    value: {
      ...placeholder.value,
      body,
    } as Extract<TypedDucklangExpression, { readonly kind: "function" }>,
  };
  const completed = { binding: clone, captures };
  context.clones.set(binding.symbol.id, completed);
  context.bindings.set(clone.symbol.id, clone);
  context.generatedBindings.push(clone);
  return completed;
}

function handlerPlan(
  expression: TypedDucklangExpression,
  bindings: ReadonlyMap<number, TypedDucklangBinding>,
  visiting: Set<number>,
): HandlerPlan | undefined {
  if (expression.kind === "effectHandler") {
    return {
      capabilityId: expression.capabilityId,
      effectName: expression.effectName,
      answerType: expression.answerType,
      prefixSteps: [],
      stateBindings: [],
      clauses: handlerClauses(expression),
    };
  }
  if (expression.kind === "block") {
    const result = handlerPlan(expression.result, bindings, visiting);
    if (result === undefined) return undefined;
    const prefixSteps = [...expression.steps, ...result.prefixSteps];
    return {
      ...result,
      prefixSteps,
      stateBindings: mutableHandlerBindings(prefixSteps, result.clauses),
    };
  }
  if (
    expression.kind === "call" &&
    expression.callee.kind === "reference"
  ) {
    const binding = bindings.get(expression.callee.symbol.id);
    if (
      binding?.value.kind !== "function" ||
      binding.value.parameters.length !== expression.arguments.length
    ) {
      return undefined;
    }
    const result = handlerPlan(binding.value.body, bindings, visiting);
    if (result === undefined) return undefined;
    const parameterBindings = binding.value.parameters.map(
      (symbol, index): TypedDucklangBinding => ({
        symbol,
        previous: undefined,
        recursive: false,
        stage: "runtime",
        value: expression.arguments[index],
        type: expression.arguments[index].type,
        latentEffects: [],
        latentEffectRow: {
          operations: [],
          parameterEffects: [],
        },
        span: symbol.span,
      }),
    );
    const prefixSteps = [
      ...parameterBindings.map((parameter): TypedDucklangBlockStep => ({
        kind: "binding",
        binding: parameter,
      })),
      ...result.prefixSteps,
    ];
    return {
      ...result,
      prefixSteps,
      stateBindings: mutableHandlerBindings(prefixSteps, result.clauses),
    };
  }
  if (expression.kind !== "reference") return undefined;
  if (visiting.has(expression.symbol.id)) return undefined;
  const binding = bindings.get(expression.symbol.id);
  if (binding === undefined) return undefined;
  visiting.add(expression.symbol.id);
  const result = handlerPlan(binding.value, bindings, visiting);
  visiting.delete(expression.symbol.id);
  return result;
}

function mutableHandlerBindings(
  prefixSteps: readonly TypedDucklangBlockStep[],
  clauses: HandlerPlan["clauses"],
): readonly TypedDucklangBinding[] {
  const candidates = prefixSteps.flatMap((step) =>
    step.kind === "binding" ? [step.binding] : []
  );
  const candidateIds = new Set(candidates.map((binding) => binding.symbol.id));
  const mutableRoots = new Set<number>();
  for (const clause of clauses.values()) {
    const previous = collectPreviousSymbols(clause);
    for (const symbolId of previous.keys()) {
      const root = stateRoot(symbolId, previous);
      if (candidateIds.has(root)) mutableRoots.add(root);
    }
  }
  return candidates.filter((binding) =>
    binding.symbol.linear === true || mutableRoots.has(binding.symbol.id)
  );
}

function handlerClauses(
  handler: Extract<TypedDucklangExpression, { readonly kind: "effectHandler" }>,
): HandlerPlan["clauses"] {
  const clauses = new Map<
    string,
    Extract<TypedDucklangExpression, { readonly kind: "function" }>
  >();
  for (const field of handler.fields) {
    if (field.value.kind !== "function") {
      throw new TypeError(
        `${field.span.file}:${field.span.start}: typed handler clause ${field.name} is not a function`,
      );
    }
    clauses.set(field.name, field.value);
  }
  return clauses;
}

function supportsDirectStatePassing(plan: HandlerPlan): boolean {
  return [...plan.clauses]
    .filter(([name]) => name !== "return")
    .every(([, clause]) => {
      if (clause.kind !== "function") return false;
      const resumption = clause.parameters.findLast((parameter) =>
        parameter.resumption === true
      );
      return resumption !== undefined &&
        isLinearTailResumption(clause.body, resumption.id);
    });
}

function isLinearTailResumption(
  expression: TypedDucklangExpression,
  resumptionId: number,
): boolean {
  if (expression.kind === "resume") {
    return expression.resumption.id === resumptionId &&
      resumptionUseCount(expression.value, resumptionId) === 0;
  }
  if (expression.kind !== "block") return false;
  const prefixPreservesControl = expression.steps.every((step) => {
    const stepExpression = step.kind === "binding"
      ? step.binding.value
      : step.expression;
    return resumptionUseCount(stepExpression, resumptionId) === 0 &&
      !containsReturn(stepExpression);
  });
  return prefixPreservesControl &&
    isLinearTailResumption(expression.result, resumptionId);
}

function resumptionUseCount(
  expression: TypedDucklangExpression,
  resumptionId: number,
): number {
  let count = expression.kind === "resume" &&
      expression.resumption.id === resumptionId
    ? 1
    : 0;
  visitDucklangExpressionChildren(expression, (child) => {
    count += resumptionUseCount(child, resumptionId);
  });
  return count;
}

function containsReturn(expression: TypedDucklangExpression): boolean {
  if (expression.kind === "return") return true;
  let contains = false;
  visitDucklangExpressionChildren(expression, (child) => {
    if (!contains && containsReturn(child)) contains = true;
  });
  return contains;
}

function requirePureHandlerInitialization(plan: HandlerPlan): void {
  for (const step of plan.prefixSteps) {
    if (step.kind === "binding" && !containsHostCall(step.binding.value)) {
      continue;
    }
    const span = step.kind === "binding"
      ? step.binding.span
      : step.expression.span;
    throw new TypeError(
      `${span.file}:${span.start}: structural handler ${plan.effectName} initialization must be pure bindings`,
    );
  }
}

function operationClauses(
  context: TranslationContext,
): readonly TypedDucklangExpression[] {
  return [...capabilityClauses(context)]
    .filter(([name]) => name !== "return")
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, clause]) => clause);
}

function capabilityClauses(
  context: TranslationContext,
): ReadonlyMap<string, TypedDucklangExpression> {
  if (context.loweredClauses.size !== 0) return context.loweredClauses;
  for (const [name, clause] of context.plan.clauses) {
    if (clause.kind !== "function") {
      context.loweredClauses.set(name, clause);
      continue;
    }
    context.loweredClauses.set(
      name,
      lowerStatefulClause(
        clause,
        context,
        context.strategy === "direct" && name !== "return",
      ),
    );
  }
  return context.loweredClauses;
}

function lowerStatefulClause(
  clause: Extract<TypedDucklangExpression, { readonly kind: "function" }>,
  context: TranslationContext,
  direct: boolean,
): TypedDucklangExpression {
  const resumption = clause.parameters.findLast((parameter) =>
    parameter.resumption === true
  );
  const ordinaryParameters = resumption === undefined
    ? clause.parameters
    : clause.parameters.slice(0, -1);
  const originalParameterTypes = functionParameterTypes(clause.type);
  const ordinaryParameterTypes = resumption === undefined
    ? originalParameterTypes
    : originalParameterTypes.slice(0, -1);
  const stateSymbols = context.plan.stateBindings.map((state) =>
    context.allocateSymbol(
      `$clause_state_${state.symbol.text}`,
      state.type,
      state.symbol,
    )
  );
  const state = new Map(
    context.plan.stateBindings.map((binding, index) => [
      binding.symbol.id,
      referenceExpression(stateSymbols[index], binding.type),
    ]),
  );
  const previous = collectPreviousSymbols(clause.body);
  let loweredResumption: DucklangSymbol | undefined;
  let loweredResumptionType: Type | undefined;
  let operationResultType: Type | undefined;
  if (resumption !== undefined) {
    const originalType = context.symbolTypes.get(resumption.id) ??
      originalParameterTypes.at(-1);
    if (originalType === undefined) {
      throw new Error(
        `${clause.span.file}:${clause.span.start}: resumption ${resumption.text} has no type`,
      );
    }
    operationResultType = originalType.kind === "function"
      ? originalType.parameter
      : functionParameterTypes(originalType)[0];
    if (operationResultType === undefined) {
      throw new TypeError(
        `${clause.span.file}:${clause.span.start}: resumption ${resumption.text} is not callable`,
      );
    }
    if (!direct) {
      loweredResumptionType = functionType([
        operationResultType,
        ...context.plan.stateBindings.map((binding) => binding.type),
      ], context.plan.answerType);
      loweredResumption = context.allocateSymbol(
        `$resume_${clause.span.start}`,
        loweredResumptionType,
        resumption,
      );
    }
  }
  const resumptionLowering: ClauseResumptionLowering | undefined =
    direct && resumption !== undefined
      ? { kind: "direct", sourceSymbolId: resumption.id }
      : loweredResumption === undefined
      ? undefined
      : { kind: "cps", symbol: loweredResumption };
  const lowered = lowerClauseExpression(
    clause.body,
    state,
    previous,
    resumptionLowering,
    context,
  );
  const parameterTypes = [
    ...ordinaryParameterTypes,
    ...context.plan.stateBindings.map((binding) => binding.type),
    ...(loweredResumptionType === undefined ? [] : [loweredResumptionType]),
  ];
  const clauseResultType = direct
    ? directResultType(
      operationResultType ?? functionResultType(clause.type),
      context.plan.stateBindings,
    )
    : context.plan.answerType;
  return {
    ...clause,
    parameters: [
      ...ordinaryParameters,
      ...stateSymbols,
      ...(loweredResumption === undefined ? [] : [loweredResumption]),
    ],
    body: lowered.expression,
    type: functionType(parameterTypes, clauseResultType),
  };
}

function lowerClauseExpression(
  expression: TypedDucklangExpression,
  state: ReadonlyMap<number, TypedDucklangExpression>,
  previous: ReadonlyMap<number, number>,
  resumption: ClauseResumptionLowering | undefined,
  context: TranslationContext,
): {
  readonly expression: TypedDucklangExpression;
  readonly state: ReadonlyMap<number, TypedDucklangExpression>;
} {
  if (expression.kind === "reference") {
    const root = stateRoot(expression.symbol.id, previous);
    return {
      expression: state.get(root) ?? expression,
      state,
    };
  }
  if (expression.kind === "resume") {
    if (resumption === undefined) {
      throw new Error(
        `${expression.span.file}:${expression.span.start}: clause lost its resumption parameter`,
      );
    }
    const value = lowerClauseExpression(
      expression.value,
      state,
      previous,
      resumption,
      context,
    );
    if (resumption.kind === "direct") {
      if (expression.resumption.id !== resumption.sourceSymbolId) {
        throw new Error(
          `${expression.span.file}:${expression.span.start}: direct clause refers to an unexpected resumption`,
        );
      }
      return {
        expression: directResultExpression(
          value.expression,
          [...value.state.values()],
          expression.span,
        ),
        state: value.state,
      };
    }
    const resumptionType = context.symbolTypes.get(resumption.symbol.id);
    if (resumptionType === undefined) {
      throw new Error(
        `${expression.span.file}:${expression.span.start}: generated resumption ${resumption.symbol.text} has no type`,
      );
    }
    return {
      expression: callExpression(
        referenceExpression(resumption.symbol, resumptionType),
        [value.expression, ...value.state.values()],
        expression.type,
        expression.span,
      ),
      state: value.state,
    };
  }
  if (expression.kind === "block") {
    let currentState = new Map(state);
    const steps: TypedDucklangBlockStep[] = [];
    for (const step of expression.steps) {
      if (step.kind === "expression") {
        const lowered = lowerClauseExpression(
          step.expression,
          currentState,
          previous,
          resumption,
          context,
        );
        currentState = new Map(lowered.state);
        steps.push({ kind: "expression", expression: lowered.expression });
        continue;
      }
      const lowered = lowerClauseExpression(
        step.binding.value,
        currentState,
        previous,
        resumption,
        context,
      );
      currentState = new Map(lowered.state);
      const binding = { ...step.binding, value: lowered.expression };
      steps.push({ kind: "binding", binding });
      const root = stateRoot(binding.symbol.id, previous);
      if (currentState.has(root)) {
        currentState.set(
          root,
          referenceExpression(binding.symbol, binding.type),
        );
      }
    }
    const result = lowerClauseExpression(
      expression.result,
      currentState,
      previous,
      resumption,
      context,
    );
    return {
      expression: {
        ...expression,
        steps,
        result: result.expression,
        type: result.expression.type,
      },
      state: result.state,
    };
  }
  let latestState: ReadonlyMap<number, TypedDucklangExpression> = state;
  const rewritten = rewriteChildren(expression, (child) => {
    const lowered = lowerClauseExpression(
      child,
      latestState,
      previous,
      resumption,
      context,
    );
    latestState = lowered.state;
    return lowered.expression;
  });
  return { expression: rewritten, state: latestState };
}

function collectPreviousSymbols(
  expression: TypedDucklangExpression,
): ReadonlyMap<number, number> {
  const previous = new Map<number, number>();
  const pending = [expression];
  while (pending.length !== 0) {
    const current = pending.pop()!;
    if (current.kind === "block") {
      for (const step of current.steps) {
        if (
          step.kind === "binding" && step.binding.previous !== undefined
        ) {
          previous.set(step.binding.symbol.id, step.binding.previous.id);
        }
      }
    }
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
  return previous;
}

function stateRoot(
  symbolId: number,
  previous: ReadonlyMap<number, number>,
): number {
  let root = symbolId;
  const visited = new Set<number>();
  while (previous.has(root) && !visited.has(root)) {
    visited.add(root);
    root = previous.get(root)!;
  }
  return root;
}

function containsHostCall(expression: TypedDucklangExpression): boolean {
  if (expression.kind === "hostCall") return true;
  let contains = false;
  visitDucklangExpressionChildren(expression, (child) => {
    if (!contains && containsHostCall(child)) contains = true;
  });
  return contains;
}

function replaceChild(
  expression: TypedDucklangExpression,
  selectedIndex: number,
  replacement: TypedDucklangExpression,
): TypedDucklangExpression {
  let index = 0;
  return rewriteChildren(expression, (child) => {
    const current = index;
    index += 1;
    return current === selectedIndex ? replacement : child;
  });
}

function bindingRequiresEffect(
  binding: TypedDucklangBinding,
  effectName: string,
  bindings: ReadonlyMap<number, TypedDucklangBinding>,
  cache: Map<number, boolean>,
  visiting: Set<number>,
): boolean {
  const cached = cache.get(binding.symbol.id);
  if (cached !== undefined) return cached;
  if (
    binding.latentEffectRow.operations.some((effect) =>
      effect.effectName === effectName
    )
  ) {
    cache.set(binding.symbol.id, true);
    return true;
  }
  if (visiting.has(binding.symbol.id)) return false;
  visiting.add(binding.symbol.id);
  const requires = binding.value.kind === "function" &&
    expressionRequiresEffect(
      binding.value.body,
      effectName,
      bindings,
      cache,
      visiting,
    );
  visiting.delete(binding.symbol.id);
  cache.set(binding.symbol.id, requires);
  return requires;
}

function expressionRequiresEffect(
  expression: TypedDucklangExpression,
  effectName: string,
  bindings: ReadonlyMap<number, TypedDucklangBinding>,
  cache: Map<number, boolean>,
  visiting: Set<number>,
): boolean {
  if (
    expression.kind === "hostCall" &&
    expression.effectName === effectName
  ) {
    return true;
  }
  if (
    expression.kind === "call" &&
    expression.callee.kind === "reference"
  ) {
    const callee = bindings.get(expression.callee.symbol.id);
    if (
      callee?.value.kind === "function" &&
      bindingRequiresEffect(callee, effectName, bindings, cache, visiting)
    ) {
      return true;
    }
  }
  let requires = false;
  const visit = (expression: TypedDucklangExpression): void => {
    if (requires) return;
    requires = expressionRequiresEffect(
      expression,
      effectName,
      bindings,
      cache,
      visiting,
    );
  };
  visitDucklangExpressionChildren(expression, visit);
  return requires;
}

function containsEffectSyntax(expression: TypedDucklangExpression): boolean {
  if (
    expression.kind === "effectHandler" ||
    expression.kind === "handle" ||
    expression.kind === "resume"
  ) {
    return true;
  }
  let contains = false;
  visitDucklangExpressionChildren(expression, (child) => {
    if (!contains && containsEffectSyntax(child)) contains = true;
  });
  return contains;
}

function referencedBindingSymbols(
  bindings: readonly TypedDucklangBinding[],
  result: TypedDucklangExpression,
): ReadonlySet<number> {
  const bindingIds = new Set(bindings.map((binding) => binding.symbol.id));
  const referenced = new Set<number>();
  const visit = (expression: TypedDucklangExpression): void => {
    if (
      expression.kind === "reference" &&
      bindingIds.has(expression.symbol.id)
    ) {
      referenced.add(expression.symbol.id);
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  for (const binding of bindings) visit(binding.value);
  visit(result);
  return referenced;
}

function measureRetainedLowering(
  bindings: readonly TypedDucklangBinding[],
  result: TypedDucklangExpression,
): Pick<
  DucklangStructuralEffectMetrics,
  | "directStatePassingFunctionCount"
  | "cpsTransformedFunctionCount"
  | "continuationCaptureCount"
  | "capabilityOperandCount"
> {
  const capabilityCounts = new Map(
    bindings.flatMap((binding) => {
      if (
        (
          !binding.symbol.text.startsWith("$cps_") &&
          !binding.symbol.text.startsWith("$direct_")
        ) ||
        binding.value.kind !== "function"
      ) {
        return [];
      }
      return [
        [
          binding.symbol.id,
          binding.value.parameters.filter((parameter) =>
            parameter.text.startsWith("$cap_")
          ).length,
        ] as const,
      ];
    }),
  );
  let continuationCaptureCount = 0;
  let capabilityOperandCount = 0;
  const visit = (expression: TypedDucklangExpression): void => {
    if (expression.kind === "function" && isGeneratedResumption(expression)) {
      continuationCaptureCount += countFreeReferences(
        expression.body,
        new Set(expression.parameters.map((parameter) => parameter.id)),
      );
    }
    if (expression.kind === "call") {
      if (expression.callee.kind === "reference") {
        capabilityOperandCount +=
          capabilityCounts.get(expression.callee.symbol.id) ?? 0;
        if (expression.callee.symbol.text.startsWith("$cap_")) {
          capabilityOperandCount += 1;
        }
      } else if (
        expression.callee.kind === "function" &&
        expression.callee.parameters.some((parameter) =>
          parameter.text.startsWith("$resume_")
        )
      ) {
        capabilityOperandCount += 1;
      }
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  for (const binding of bindings) visit(binding.value);
  visit(result);
  return {
    directStatePassingFunctionCount:
      bindings.filter((binding) =>
        binding.symbol.text.startsWith("$direct_") &&
        binding.value.kind === "function"
      ).length,
    cpsTransformedFunctionCount:
      bindings.filter((binding) =>
        binding.symbol.text.startsWith("$cps_") &&
        binding.value.kind === "function"
      ).length,
    continuationCaptureCount,
    capabilityOperandCount,
  };
}

function countFreeReferences(
  expression: TypedDucklangExpression,
  bound: ReadonlySet<number>,
): number {
  const references = new Set<number>();
  const visit = (current: TypedDucklangExpression): void => {
    if (
      current.kind === "reference" && !bound.has(current.symbol.id) &&
      current.symbol.scope !== "module"
    ) {
      references.add(current.symbol.id);
    }
    visitDucklangExpressionChildren(current, visit);
  };
  visit(expression);
  return references.size;
}

function functionCaptures(
  binding: TypedDucklangBinding,
): readonly {
  readonly symbol: DucklangSymbol;
  readonly type: Type;
}[] {
  if (binding.value.kind !== "function") return [];
  const defined = new Set([
    binding.symbol.id,
    ...binding.value.parameters.map((parameter) => parameter.id),
  ]);
  const collectDefined = (expression: TypedDucklangExpression): void => {
    if (expression.kind === "function") {
      for (const parameter of expression.parameters) defined.add(parameter.id);
    }
    if (
      expression.kind === "ifUnion" &&
      expression.payloadSymbol !== undefined
    ) {
      defined.add(expression.payloadSymbol.id);
    }
    if (expression.kind === "block") {
      for (const step of expression.steps) {
        if (step.kind === "binding") defined.add(step.binding.symbol.id);
      }
    }
    visitDucklangExpressionChildren(expression, collectDefined);
  };
  collectDefined(binding.value.body);

  const captures = new Map<number, {
    readonly symbol: DucklangSymbol;
    readonly type: Type;
  }>();
  const collectReferences = (expression: TypedDucklangExpression): void => {
    if (
      expression.kind === "reference" &&
      expression.symbol.scope !== "module" &&
      !defined.has(expression.symbol.id)
    ) {
      captures.set(expression.symbol.id, {
        symbol: expression.symbol,
        type: expression.type,
      });
      return;
    }
    visitDucklangExpressionChildren(expression, collectReferences);
  };
  collectReferences(binding.value.body);
  return [...captures.values()];
}

function referenceExpression(
  symbol: DucklangSymbol,
  type: Type,
): Extract<TypedDucklangExpression, { readonly kind: "reference" }> {
  return { kind: "reference", symbol, type, span: symbol.span };
}

function functionExpression(
  parameters: readonly DucklangSymbol[],
  body: TypedDucklangExpression,
  type: Type,
  span: TypedDucklangExpression["span"],
): Extract<TypedDucklangExpression, { readonly kind: "function" }> {
  return {
    kind: "function",
    recursive: false,
    parameters,
    body,
    type,
    span,
  };
}

function callExpression(
  callee: TypedDucklangExpression,
  arguments_: readonly TypedDucklangExpression[],
  type: Type,
  span: TypedDucklangExpression["span"],
): Extract<TypedDucklangExpression, { readonly kind: "call" }> {
  return {
    kind: "call",
    callee,
    arguments: arguments_,
    effects: emptyEffects(),
    type,
    span,
  };
}

function directResultType(
  valueType: Type,
  stateBindings: readonly TypedDucklangBinding[],
): Type {
  const components = [
    ...(isUnitType(valueType) ? [] : [valueType]),
    ...stateBindings.map((binding) => binding.type),
  ];
  if (components.length === 0) return valueType;
  if (components.length === 1) return components[0];
  return {
    kind: "constructor",
    name: "tuple",
    arguments: components,
  };
}

function directResultExpression(
  value: TypedDucklangExpression,
  stateArguments: readonly TypedDucklangExpression[],
  span: TypedDucklangExpression["span"],
): TypedDucklangExpression {
  const values = [
    ...(isUnitType(value.type) ? [] : [value]),
    ...stateArguments,
  ];
  if (values.length === 0) return value;
  if (values.length === 1) return values[0];
  return {
    kind: "product",
    productKind: "tuple",
    values,
    type: {
      kind: "constructor",
      name: "tuple",
      arguments: values.map((element) => element.type),
    },
    span,
  };
}

function isUnitType(type: Type): boolean {
  return type.kind === "constructor" &&
    (type.name === "unit" || type.name === "Unit") &&
    type.arguments.length === 0;
}

function emptyEffects(): CallableEffectRow {
  return { operations: [], parameterEffects: [], variables: [] };
}

function functionType(parameters: readonly Type[], result: Type): Type {
  if (parameters.length === 0) {
    return {
      kind: "function",
      parameter: { kind: "constructor", name: "unit", arguments: [] },
      result,
      nullary: true,
    };
  }
  return parameters.toReversed().reduce<Type>(
    (current, parameter) => ({
      kind: "function",
      parameter,
      result: current,
    }),
    result,
  );
}

function functionParameterTypes(type: Type): readonly Type[] {
  const parameters: Type[] = [];
  let current = type;
  while (current.kind === "function") {
    if (current.nullary !== true) parameters.push(current.parameter);
    current = current.result;
  }
  return parameters;
}

function functionResultType(type: Type): Type {
  let current = type;
  while (current.kind === "function") current = current.result;
  return current;
}

function handlerTemplate(
  plan: HandlerPlan,
  expression: TypedDucklangExpression,
): DucklangSymbol {
  const clause = plan.clauses.values().next().value;
  if (clause?.kind !== "function") {
    throw new Error(
      `${expression.span.file}:${expression.span.start}: handler ${plan.effectName} has no function clause for generated continuation`,
    );
  }
  const template = clause.parameters[0];
  if (template !== undefined) return template;
  throw new Error(
    `${expression.span.file}:${expression.span.start}: handler ${plan.effectName} has no symbol for generated continuation`,
  );
}

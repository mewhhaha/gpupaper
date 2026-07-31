import type {
  DucklangEffectReference,
  DucklangEffectRow,
  DucklangTypeReference,
} from "./ducklang_ast.ts";
import type {
  ResolvedDucklangBinding,
  ResolvedDucklangExpression,
  ResolvedDucklangModule,
} from "./ducklang_resolution.ts";

export type DucklangEffectRowType = {
  readonly operations: readonly DucklangEffectReference[];
  readonly parameterEffects: readonly number[];
};

export type DucklangEffectAnalysis = {
  readonly bindingEffects: ReadonlyMap<number, DucklangEffectRowType>;
  readonly moduleEffects: readonly DucklangEffectReference[];
};

type EffectSummary = {
  readonly operations: Map<string, DucklangEffectReference>;
  readonly parameterEffects: Set<number>;
};

export function analyzeDucklangEffects(
  module: ResolvedDucklangModule,
): DucklangEffectAnalysis {
  const bindingsBySymbol = new Map(
    module.bindings.map((binding) => [binding.symbol.id, binding]),
  );
  const functionBindings = new Map(
    module.bindings.flatMap((binding) =>
      binding.value.kind === "function"
        ? [[binding.symbol.id, binding] as const]
        : []
    ),
  );
  const functionTargets = new Map(
    [...functionBindings.keys()].map((symbolId) => [symbolId, symbolId]),
  );
  for (let iteration = 0; iteration < module.bindings.length; iteration += 1) {
    let changed = false;
    for (const binding of module.bindings) {
      if (binding.value.kind !== "reference") continue;
      const target = functionTargets.get(binding.value.symbol.id);
      if (target === undefined || functionTargets.has(binding.symbol.id)) {
        continue;
      }
      functionTargets.set(binding.symbol.id, target);
      changed = true;
    }
    if (!changed) break;
  }

  const bindingEffects = new Map<number, EffectSummary>(
    [...functionBindings.keys()].map((symbolId) => [
      symbolId,
      emptyEffectSummary(),
    ]),
  );
  for (let iteration = 0; iteration <= functionBindings.size; iteration += 1) {
    let changed = false;
    for (const [symbolId, binding] of functionBindings) {
      if (binding.value.kind !== "function") continue;
      const effects = collectExpressionEffects(
        binding.value.body,
        bindingsBySymbol,
        functionTargets,
        bindingEffects,
        new Map(
          binding.value.parameters.map((parameter, index) => [
            parameter.id,
            index,
          ]),
        ),
      );
      if (sameEffectSummary(effects, bindingEffects.get(symbolId))) continue;
      bindingEffects.set(symbolId, effects);
      changed = true;
    }
    if (!changed) break;
    if (iteration === functionBindings.size) {
      throw new Error(
        `${module.file}: Ducklang effect inference did not reach a fixed point`,
      );
    }
  }

  for (const [symbolId, binding] of functionBindings) {
    if (
      binding.value.kind !== "function" ||
      binding.symbol.declaredEffectRow === undefined
    ) {
      continue;
    }
    const effectVariables = functionEffectVariables(
      binding.value.parameters.map((parameter) => parameter.declaredType),
    );
    const declared = binding.symbol.declaredEffectRow === null
      ? emptyEffectSummary()
      : resolveDeclaredEffectRow(
        module,
        binding.symbol.declaredEffectRow,
        effectVariables,
      );
    const inferred = bindingEffects.get(symbolId) ?? emptyEffectSummary();
    for (const effect of inferred.operations.values()) {
      if (declared.operations.has(effectKey(effect))) continue;
      throw new TypeError(
        `${module.file}:${binding.span.start}: Ducklang function ${binding.symbol.text} exceeds its declared effect row with ${effect.effectName}.${effect.operationName}`,
      );
    }
    for (const parameterIndex of inferred.parameterEffects) {
      if (declared.parameterEffects.has(parameterIndex)) continue;
      const parameter = binding.value.parameters[parameterIndex];
      throw new TypeError(
        `${module.file}:${binding.span.start}: Ducklang function ${binding.symbol.text} exceeds its declared effect row with effects from parameter ${
          parameter?.text ?? parameterIndex
        }`,
      );
    }
  }

  const moduleEffects = emptyEffectSummary();
  for (const binding of module.bindings) {
    if (binding.value.kind === "function") continue;
    mergeEffectSummaries(
      moduleEffects,
      collectExpressionEffects(
        binding.value,
        bindingsBySymbol,
        functionTargets,
        bindingEffects,
        new Map(),
      ),
    );
  }
  mergeEffectSummaries(
    moduleEffects,
    collectExpressionEffects(
      module.result,
      bindingsBySymbol,
      functionTargets,
      bindingEffects,
      new Map(),
    ),
  );

  return {
    bindingEffects: new Map(
      module.bindings.map((binding) => {
        const summary = bindingEffects.get(
          functionTargets.get(binding.symbol.id) ?? binding.symbol.id,
        ) ?? emptyEffectSummary();
        return [binding.symbol.id, freezeEffectSummary(summary)];
      }),
    ),
    moduleEffects: [...moduleEffects.operations.values()],
  };
}

function resolveDeclaredEffectRow(
  module: ResolvedDucklangModule,
  row: DucklangEffectRow,
  effectVariables: ReadonlyMap<string, number>,
): EffectSummary {
  if (row.kind === "family") {
    const operations = module.effects.get(row.effectName);
    if (operations === undefined) {
      throw new TypeError(
        `${module.file}:${row.span.start}: unknown Ducklang effect ${row.effectName} in effect row`,
      );
    }
    const summary = emptyEffectSummary();
    for (const operation of operations) {
      const reference = {
        effectName: row.effectName,
        operationName: operation.name,
        span: row.span,
      };
      summary.operations.set(effectKey(reference), reference);
    }
    return summary;
  }
  if (row.kind === "operation") {
    const operation = module.effects.get(row.effectName)?.find((candidate) =>
      candidate.name === row.operationName
    );
    if (operation === undefined) {
      throw new TypeError(
        `${module.file}:${row.span.start}: unknown Ducklang effect operation ${row.effectName}.${row.operationName} in effect row`,
      );
    }
    const reference = {
      effectName: row.effectName,
      operationName: row.operationName,
      span: row.span,
    };
    const summary = emptyEffectSummary();
    summary.operations.set(effectKey(reference), reference);
    return summary;
  }
  if (row.kind === "variable") {
    const parameterIndex = effectVariables.get(row.name);
    if (parameterIndex === undefined) {
      throw new TypeError(
        `${module.file}:${row.span.start}: unbound Ducklang effect row variable ${row.name}`,
      );
    }
    const summary = emptyEffectSummary();
    summary.parameterEffects.add(parameterIndex);
    return summary;
  }

  const left = resolveDeclaredEffectRow(module, row.left, effectVariables);
  const right = resolveDeclaredEffectRow(module, row.right, effectVariables);
  if (row.kind === "union") {
    mergeEffectSummaries(left, right);
    return left;
  }
  if (row.kind === "intersection") {
    for (const key of left.operations.keys()) {
      if (!right.operations.has(key)) left.operations.delete(key);
    }
    for (const parameterIndex of left.parameterEffects) {
      if (!right.parameterEffects.has(parameterIndex)) {
        left.parameterEffects.delete(parameterIndex);
      }
    }
    return left;
  }
  for (const key of right.operations.keys()) left.operations.delete(key);
  for (const parameterIndex of right.parameterEffects) {
    left.parameterEffects.delete(parameterIndex);
  }
  return left;
}

function functionEffectVariables(
  parameterTypes: readonly (DucklangTypeReference | undefined)[],
): ReadonlyMap<string, number> {
  const variables = new Map<string, number>();
  for (const [parameterIndex, type] of parameterTypes.entries()) {
    if (type === undefined) continue;
    collectTypeEffectVariables(type, parameterIndex, variables);
  }
  return variables;
}

function collectTypeEffectVariables(
  type: DucklangTypeReference,
  parameterIndex: number,
  variables: Map<string, number>,
): void {
  if (type.effectRow !== undefined && type.effectRow !== null) {
    collectRowVariables(type.effectRow, parameterIndex, variables);
  }
  for (const argument of type.arguments) {
    collectTypeEffectVariables(argument, parameterIndex, variables);
  }
}

function collectRowVariables(
  row: DucklangEffectRow,
  parameterIndex: number,
  variables: Map<string, number>,
): void {
  if (row.kind === "variable") {
    const existing = variables.get(row.name);
    if (existing !== undefined && existing !== parameterIndex) {
      throw new TypeError(
        `${row.span.file}:${row.span.start}: Ducklang effect row variable ${row.name} belongs to parameters ${existing} and ${parameterIndex}`,
      );
    }
    variables.set(row.name, parameterIndex);
    return;
  }
  if ("left" in row) {
    collectRowVariables(row.left, parameterIndex, variables);
    collectRowVariables(row.right, parameterIndex, variables);
  }
}

function collectExpressionEffects(
  expression: ResolvedDucklangExpression,
  bindingsBySymbol: ReadonlyMap<number, ResolvedDucklangBinding>,
  functionTargets: ReadonlyMap<number, number>,
  bindingEffects: ReadonlyMap<number, EffectSummary>,
  effectParameters: ReadonlyMap<number, number>,
): EffectSummary {
  const effects = emptyEffectSummary();
  const localFunctions = new Map<
    number,
    Extract<ResolvedDucklangExpression, { readonly kind: "function" }>
  >();
  const activeLocalFunctions = new Set<number>();
  const activeCallableBindings = new Set<number>();

  const callableEffects = (
    callable: ResolvedDucklangExpression,
  ): EffectSummary => {
    if (callable.kind === "reference") {
      const parameterIndex = effectParameters.get(callable.symbol.id);
      if (parameterIndex !== undefined) {
        const summary = emptyEffectSummary();
        summary.parameterEffects.add(parameterIndex);
        return summary;
      }
      const target = functionTargets.get(callable.symbol.id);
      if (target !== undefined) {
        return cloneEffectSummary(
          bindingEffects.get(target) ?? emptyEffectSummary(),
        );
      }
      const localFunction = localFunctions.get(callable.symbol.id);
      if (
        localFunction !== undefined &&
        !activeLocalFunctions.has(callable.symbol.id)
      ) {
        activeLocalFunctions.add(callable.symbol.id);
        const summary = collectExpressionEffects(
          localFunction.body,
          bindingsBySymbol,
          functionTargets,
          bindingEffects,
          new Map(
            localFunction.parameters.map((parameter, index) => [
              parameter.id,
              index,
            ]),
          ),
        );
        activeLocalFunctions.delete(callable.symbol.id);
        return summary;
      }
      const binding = bindingsBySymbol.get(callable.symbol.id);
      if (
        binding !== undefined &&
        !activeCallableBindings.has(callable.symbol.id)
      ) {
        activeCallableBindings.add(callable.symbol.id);
        const summary = callableEffects(binding.value);
        activeCallableBindings.delete(callable.symbol.id);
        return summary;
      }
      return emptyEffectSummary();
    }
    if (callable.kind === "function") {
      return collectExpressionEffects(
        callable.body,
        bindingsBySymbol,
        functionTargets,
        bindingEffects,
        new Map(
          callable.parameters.map((parameter, index) => [parameter.id, index]),
        ),
      );
    }
    if (callable.kind === "if") {
      const summary = callableEffects(callable.consequence);
      if (callable.alternative !== undefined) {
        mergeEffectSummaries(summary, callableEffects(callable.alternative));
      }
      return summary;
    }
    if (callable.kind === "ifUnion") {
      const summary = callableEffects(callable.consequence);
      if (callable.alternative !== undefined) {
        mergeEffectSummaries(summary, callableEffects(callable.alternative));
      }
      return summary;
    }
    if (callable.kind === "block") return callableEffects(callable.result);
    if (callable.kind === "field") {
      const field = callableFieldValue(
        callable.product,
        callable.fieldName,
        bindingsBySymbol,
        functionTargets,
      );
      return field === undefined
        ? emptyEffectSummary()
        : callableEffects(field);
    }
    return emptyEffectSummary();
  };

  const mergeInstantiatedCall = (
    summary: EffectSummary,
    arguments_: readonly ResolvedDucklangExpression[],
  ): void => {
    for (const operation of summary.operations.values()) {
      effects.operations.set(effectKey(operation), operation);
    }
    for (const parameterIndex of summary.parameterEffects) {
      const argument = arguments_[parameterIndex];
      if (argument === undefined) continue;
      mergeEffectSummaries(effects, callableEffects(argument));
    }
  };

  const visit = (current: ResolvedDucklangExpression): void => {
    switch (current.kind) {
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
      case "hostCall": {
        const reference = {
          effectName: current.effectName,
          operationName: current.operationName,
          span: current.span,
        };
        effects.operations.set(effectKey(reference), reference);
        for (const argument of current.arguments) visit(argument);
        return;
      }
      case "effectHandler":
        return;
      case "handle": {
        const handled = collectExpressionEffects(
          current.body,
          bindingsBySymbol,
          functionTargets,
          bindingEffects,
          effectParameters,
        );
        const effectName = resolvedHandlerEffectName(
          current.handler,
          bindingsBySymbol,
          functionTargets,
          new Set(),
        );
        if (effectName !== undefined) {
          for (const [key, operation] of handled.operations) {
            if (operation.effectName === effectName) {
              handled.operations.delete(key);
            }
          }
        }
        mergeEffectSummaries(effects, handled);
        const handler = resolvedHandlerExpression(
          current.handler,
          bindingsBySymbol,
          functionTargets,
          new Set(),
        );
        if (handler !== undefined) {
          for (const field of handler.fields) {
            if (field.value.kind !== "function") continue;
            const clause = collectExpressionEffects(
              field.value.body,
              bindingsBySymbol,
              functionTargets,
              bindingEffects,
              new Map(),
            );
            for (const [key, operation] of clause.operations) {
              if (operation.effectName !== handler.effectName) {
                effects.operations.set(key, operation);
              }
            }
          }
        }
        return;
      }
      case "resume":
        visit(current.value);
        return;
      case "function":
        return;
      case "call":
        visit(current.callee);
        for (const argument of current.arguments) visit(argument);
        if (current.callee.kind === "reference") {
          const parameterIndex = effectParameters.get(
            current.callee.symbol.id,
          );
          if (parameterIndex !== undefined) {
            effects.parameterEffects.add(parameterIndex);
            return;
          }
        }
        mergeInstantiatedCall(
          callableEffects(current.callee),
          current.arguments,
        );
        return;
      case "unionCase":
        visit(current.value);
        return;
      case "product":
        for (const value of current.values) visit(value);
        return;
      case "field":
        visit(current.product);
        return;
      case "recordUpdate":
        visit(current.product);
        for (const field of current.fields) visit(field.value);
        return;
      case "record":
        for (const field of current.fields) visit(field.value);
        return;
      case "project":
        visit(current.product);
        return;
      case "optionDo":
        visit(current.option);
        return;
      case "index":
        visit(current.collection);
        visit(current.index);
        return;
      case "indexUpdate":
        visit(current.product);
        visit(current.index);
        visit(current.value);
        return;
      case "binary":
        visit(current.left);
        visit(current.right);
        return;
      case "unary":
        visit(current.operand);
        return;
      case "return":
      case "comptime":
        visit(current.expression);
        return;
      case "if":
        visit(current.condition);
        visit(current.consequence);
        if (current.alternative !== undefined) visit(current.alternative);
        return;
      case "ifUnion":
        visit(current.value);
        visit(current.consequence);
        if (current.alternative !== undefined) visit(current.alternative);
        return;
      case "block":
        for (const step of current.steps) {
          if (
            step.kind === "binding" && step.binding.value.kind === "function"
          ) {
            localFunctions.set(step.binding.symbol.id, step.binding.value);
            continue;
          }
          visit(
            step.kind === "binding" ? step.binding.value : step.expression,
          );
        }
        visit(current.result);
        return;
      case "scratch":
        visit(current.body);
        return;
    }
  };
  visit(expression);
  return effects;
}

function emptyEffectSummary(): EffectSummary {
  return { operations: new Map(), parameterEffects: new Set() };
}

function callableFieldValue(
  product: ResolvedDucklangExpression,
  fieldName: string,
  bindingsBySymbol: ReadonlyMap<number, ResolvedDucklangBinding>,
  functionTargets: ReadonlyMap<number, number>,
): ResolvedDucklangExpression | undefined {
  if (product.kind === "block") {
    return callableFieldValue(
      product.result,
      fieldName,
      bindingsBySymbol,
      functionTargets,
    );
  }
  if (product.kind === "record") {
    return product.fields.find((field) => field.name === fieldName)?.value;
  }
  if (product.kind === "reference") {
    const binding = bindingsBySymbol.get(product.symbol.id);
    return binding === undefined ? undefined : callableFieldValue(
      binding.value,
      fieldName,
      bindingsBySymbol,
      functionTargets,
    );
  }
  if (
    product.kind !== "call" || product.callee.kind !== "reference"
  ) {
    return undefined;
  }
  const target = functionTargets.get(product.callee.symbol.id) ??
    product.callee.symbol.id;
  const binding = bindingsBySymbol.get(target);
  if (binding?.value.kind !== "function") return undefined;
  return callableFieldValue(
    binding.value.body,
    fieldName,
    bindingsBySymbol,
    functionTargets,
  );
}

function resolvedHandlerEffectName(
  expression: ResolvedDucklangExpression,
  bindingsBySymbol: ReadonlyMap<number, ResolvedDucklangBinding>,
  functionTargets: ReadonlyMap<number, number>,
  visiting: Set<number>,
): string | undefined {
  return resolvedHandlerExpression(
    expression,
    bindingsBySymbol,
    functionTargets,
    visiting,
  )?.effectName;
}

function resolvedHandlerExpression(
  expression: ResolvedDucklangExpression,
  bindingsBySymbol: ReadonlyMap<number, ResolvedDucklangBinding>,
  functionTargets: ReadonlyMap<number, number>,
  visiting: Set<number>,
):
  | Extract<
    ResolvedDucklangExpression,
    { readonly kind: "effectHandler" }
  >
  | undefined {
  if (expression.kind === "effectHandler") return expression;
  if (expression.kind === "block") {
    return resolvedHandlerExpression(
      expression.result,
      bindingsBySymbol,
      functionTargets,
      visiting,
    );
  }
  if (expression.kind === "call" && expression.callee.kind === "reference") {
    const target = functionTargets.get(expression.callee.symbol.id) ??
      expression.callee.symbol.id;
    if (visiting.has(target)) return undefined;
    const binding = bindingsBySymbol.get(target);
    if (binding?.value.kind !== "function") return undefined;
    visiting.add(target);
    const handler = resolvedHandlerExpression(
      binding.value.body,
      bindingsBySymbol,
      functionTargets,
      visiting,
    );
    visiting.delete(target);
    return handler;
  }
  if (expression.kind !== "reference") return undefined;
  const target = functionTargets.get(expression.symbol.id) ??
    expression.symbol.id;
  if (visiting.has(target)) return undefined;
  const binding = bindingsBySymbol.get(target);
  if (binding === undefined) return undefined;
  visiting.add(target);
  const handler = resolvedHandlerExpression(
    binding.value,
    bindingsBySymbol,
    functionTargets,
    visiting,
  );
  visiting.delete(target);
  return handler;
}

function cloneEffectSummary(summary: EffectSummary): EffectSummary {
  return {
    operations: new Map(summary.operations),
    parameterEffects: new Set(summary.parameterEffects),
  };
}

function freezeEffectSummary(summary: EffectSummary): DucklangEffectRowType {
  return {
    operations: [...summary.operations.values()].toSorted((left, right) =>
      effectKey(left).localeCompare(effectKey(right))
    ),
    parameterEffects: [...summary.parameterEffects].toSorted((a, b) => a - b),
  };
}

function effectKey(effect: DucklangEffectReference): string {
  return `${effect.effectName}.${effect.operationName}`;
}

function mergeEffectSummaries(
  target: EffectSummary,
  source: EffectSummary,
): void {
  for (const [key, effect] of source.operations) {
    target.operations.set(key, effect);
  }
  for (const parameterIndex of source.parameterEffects) {
    target.parameterEffects.add(parameterIndex);
  }
}

function sameEffectSummary(
  left: EffectSummary,
  right: EffectSummary | undefined,
): boolean {
  if (
    right === undefined ||
    left.operations.size !== right.operations.size ||
    left.parameterEffects.size !== right.parameterEffects.size
  ) {
    return false;
  }
  for (const key of left.operations.keys()) {
    if (!right.operations.has(key)) return false;
  }
  for (const parameterIndex of left.parameterEffects) {
    if (!right.parameterEffects.has(parameterIndex)) return false;
  }
  return true;
}

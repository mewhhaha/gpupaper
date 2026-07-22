import type {
  DucklangEffectReference,
  DucklangEffectRow,
} from "./ducklang_ast.ts";
import type {
  ResolvedDucklangExpression,
  ResolvedDucklangModule,
} from "./ducklang_resolution.ts";

export type DucklangEffectAnalysis = {
  readonly bindingEffects: ReadonlyMap<
    number,
    readonly DucklangEffectReference[]
  >;
  readonly moduleEffects: readonly DucklangEffectReference[];
};

export function analyzeDucklangEffects(
  module: ResolvedDucklangModule,
): DucklangEffectAnalysis {
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
  const bindingEffects = new Map<
    number,
    ReadonlyMap<string, DucklangEffectReference>
  >(
    [...functionBindings.keys()].map((symbolId) => [symbolId, new Map()]),
  );

  for (let iteration = 0; iteration <= functionBindings.size; iteration += 1) {
    let changed = false;
    for (const [symbolId, binding] of functionBindings) {
      if (binding.value.kind !== "function") continue;
      const effects = collectExpressionEffects(
        binding.value.body,
        functionTargets,
        bindingEffects,
      );
      if (sameEffects(effects, bindingEffects.get(symbolId))) continue;
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
    if (binding.symbol.declaredEffectRow === undefined) continue;
    const declared = binding.symbol.declaredEffectRow === null
      ? new Map<string, DucklangEffectReference>()
      : resolveDeclaredEffectRow(
        module,
        binding.symbol.declaredEffectRow,
      );
    for (const effect of bindingEffects.get(symbolId)?.values() ?? []) {
      if (declared.has(effectKey(effect))) continue;
      throw new TypeError(
        `${module.file}:${binding.span.start}: Ducklang function ${binding.symbol.text} exceeds its declared effect row with ${effect.effectName}.${effect.operationName}`,
      );
    }
  }

  const moduleEffects = new Map<string, DucklangEffectReference>();
  for (const binding of module.bindings) {
    if (binding.value.kind === "function") continue;
    mergeEffects(
      moduleEffects,
      collectExpressionEffects(
        binding.value,
        functionTargets,
        bindingEffects,
      ),
    );
  }
  mergeEffects(
    moduleEffects,
    collectExpressionEffects(module.result, functionTargets, bindingEffects),
  );

  return {
    bindingEffects: new Map(
      module.bindings.map((binding) => [
        binding.symbol.id,
        [
          ...(
            bindingEffects.get(
              functionTargets.get(binding.symbol.id) ?? binding.symbol.id,
            )?.values() ?? []
          ),
        ],
      ]),
    ),
    moduleEffects: [...moduleEffects.values()],
  };
}

function resolveDeclaredEffectRow(
  module: ResolvedDucklangModule,
  row: DucklangEffectRow,
): Map<string, DucklangEffectReference> {
  if (row.kind === "family") {
    const operations = module.effects.get(row.effectName);
    if (operations === undefined) {
      throw new TypeError(
        `${module.file}:${row.span.start}: unknown Ducklang effect ${row.effectName} in effect row`,
      );
    }
    return new Map(
      operations.map((operation) => {
        const reference = {
          effectName: row.effectName,
          operationName: operation.name,
          span: row.span,
        };
        return [effectKey(reference), reference];
      }),
    );
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
    return new Map([[effectKey(reference), reference]]);
  }
  if (row.kind === "variable") {
    throw new TypeError(
      `${module.file}:${row.span.start}: cannot infer unbound Ducklang effect row variable ${row.name}`,
    );
  }

  const left = resolveDeclaredEffectRow(module, row.left);
  const right = resolveDeclaredEffectRow(module, row.right);
  if (row.kind === "union") {
    mergeEffects(left, right);
    return left;
  }
  if (row.kind === "intersection") {
    for (const key of left.keys()) {
      if (!right.has(key)) left.delete(key);
    }
    return left;
  }
  for (const key of right.keys()) left.delete(key);
  return left;
}

function collectExpressionEffects(
  expression: ResolvedDucklangExpression,
  functionTargets: ReadonlyMap<number, number>,
  bindingEffects: ReadonlyMap<
    number,
    ReadonlyMap<string, DucklangEffectReference>
  >,
): Map<string, DucklangEffectReference> {
  const effects = new Map<string, DucklangEffectReference>();
  const visit = (current: ResolvedDucklangExpression): void => {
    switch (current.kind) {
      case "integer":
      case "integer64":
      case "boolean":
      case "unit":
      case "string":
      case "intrinsic":
      case "reference":
        return;
      case "hostCall": {
        const reference = {
          effectName: current.effectName,
          operationName: current.operationName,
          span: current.span,
        };
        effects.set(effectKey(reference), reference);
        for (const argument of current.arguments) visit(argument);
        return;
      }
      case "function":
        return;
      case "call":
        visit(current.callee);
        for (const argument of current.arguments) visit(argument);
        if (
          current.callee.kind === "reference" &&
          functionTargets.has(current.callee.symbol.id)
        ) {
          const target = functionTargets.get(current.callee.symbol.id);
          mergeEffects(
            effects,
            target === undefined
              ? new Map()
              : bindingEffects.get(target) ?? new Map(),
          );
        } else if (current.callee.kind === "function") {
          visit(current.callee.body);
        }
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
          const value = step.kind === "binding"
            ? step.binding.value
            : step.expression;
          if (value.kind !== "function") visit(value);
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

function effectKey(effect: DucklangEffectReference): string {
  return `${effect.effectName}.${effect.operationName}`;
}

function mergeEffects(
  target: Map<string, DucklangEffectReference>,
  source: ReadonlyMap<string, DucklangEffectReference>,
): void {
  for (const [key, effect] of source) target.set(key, effect);
}

function sameEffects(
  left: ReadonlyMap<string, DucklangEffectReference>,
  right: ReadonlyMap<string, DucklangEffectReference> | undefined,
): boolean {
  if (right === undefined || left.size !== right.size) return false;
  for (const key of left.keys()) {
    if (!right.has(key)) return false;
  }
  return true;
}

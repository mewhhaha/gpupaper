import type { DucklangSymbol } from "./ducklang_resolution.ts";
import { rewriteChildren } from "./ducklang_closures.ts";
import type {
  TypedDucklangBinding,
  TypedDucklangEffectModule,
  TypedDucklangExpression,
} from "./ducklang_types.ts";

type ResumptionUsage = {
  readonly minimum: number;
  readonly maximum: number;
  readonly fallsThrough: boolean;
};

export function validateDucklangEffectOwnership(
  module: TypedDucklangEffectModule,
): TypedDucklangEffectModule {
  const bindings = new Map(
    module.bindings.map((binding) => [binding.symbol.id, binding]),
  );
  return {
    ...module,
    bindings: module.bindings.map((binding) => ({
      ...binding,
      value: validateExpression(binding.value, bindings),
    })),
    result: validateExpression(module.result, bindings),
  };
}

function validateExpression(
  expression: TypedDucklangExpression,
  bindings: ReadonlyMap<number, TypedDucklangBinding>,
): TypedDucklangExpression {
  const rewritten = rewriteChildren(
    expression,
    (child) => validateExpression(child, bindings),
  );
  if (rewritten.kind === "effectHandler") {
    validateHandlerClauses(rewritten, new Map());
    return rewritten;
  }
  if (rewritten.kind === "handle") {
    const handler = resolveHandler(rewritten.handler, bindings, new Set());
    if (handler !== undefined) {
      const requiredLinearOperations = collectLinearOperations(
        rewritten.body,
        handler.effectName,
        bindings,
      );
      validateHandlerClauses(handler, requiredLinearOperations);
      return {
        ...rewritten,
        controlFlow: handler.fields
          .filter((field) => field.name !== "return")
          .map((field) => {
            const capturedLinearSymbols = requiredLinearOperations.get(
              field.name,
            ) ?? [];
            return {
              operationName: field.name,
              multiplicity: capturedLinearSymbols.length === 0
                ? "affine" as const
                : "linear" as const,
              capturedLinearSymbols,
            };
          }),
      };
    }
  }
  return rewritten;
}

function validateHandlerClauses(
  handler: Extract<TypedDucklangExpression, { readonly kind: "effectHandler" }>,
  requiredLinearOperations: ReadonlyMap<string, readonly string[]>,
): void {
  for (const field of handler.fields) {
    if (field.name === "return" || field.value.kind !== "function") continue;
    const resumption = field.value.parameters.findLast((parameter) =>
      parameter.resumption === true
    );
    if (resumption === undefined) continue;
    const usage = resumptionUsage(field.value.body, resumption.id);
    if (usage.maximum > 1) {
      const description = Number.isFinite(usage.maximum)
        ? `resumes ${usage.maximum} times`
        : "may resume more than once";
      throw new TypeError(
        `${field.span.file}:${field.span.start}: Ducklang handler clause ${field.name} ${description}; a resumption may be used at most once`,
      );
    }
    const captures = requiredLinearOperations.get(field.name) ?? [];
    if (
      captures.length !== 0 &&
      (usage.minimum !== 1 || usage.maximum !== 1)
    ) {
      throw new TypeError(
        `${field.span.file}:${field.span.start}: Ducklang handler clause ${field.name} must resume because its continuation captures linear ${
          captures.join(", ")
        }`,
      );
    }
  }
}

function collectLinearOperations(
  expression: TypedDucklangExpression,
  effectName: string,
  bindings: ReadonlyMap<number, TypedDucklangBinding>,
): ReadonlyMap<string, readonly string[]> {
  const captures = new Map<string, Set<string>>();
  const visitingFunctions = new Set<number>();

  const visit = (
    current: TypedDucklangExpression,
    enclosingFunction:
      | Extract<TypedDucklangExpression, { readonly kind: "function" }>
      | undefined,
  ): void => {
    if (current.kind === "function") return;
    if (current.kind === "hostCall" && current.effectName === effectName) {
      const names = enclosingFunction === undefined
        ? linearValuesLiveAfter(expression, current)
        : linearValuesLiveAfter(enclosingFunction.body, current);
      if (names.length !== 0) {
        const operationCaptures = captures.get(current.operationName) ??
          new Set<string>();
        for (const name of names) operationCaptures.add(name);
        captures.set(current.operationName, operationCaptures);
      }
    }
    if (current.kind === "call") {
      for (const argument of current.arguments) {
        visit(argument, enclosingFunction);
      }
      if (current.callee.kind === "function") {
        visitFunction(current.callee);
        return;
      }
      if (current.callee.kind === "reference") {
        const binding = bindings.get(current.callee.symbol.id);
        if (binding?.value.kind === "function") {
          visitFunction(binding.value, binding.symbol.id);
          return;
        }
      }
      visit(current.callee, enclosingFunction);
      return;
    }
    for (const child of expressionChildren(current)) {
      visit(child, enclosingFunction);
    }
  };

  const visitFunction = (
    function_: Extract<TypedDucklangExpression, { readonly kind: "function" }>,
    symbolId?: number,
  ): void => {
    if (symbolId !== undefined && visitingFunctions.has(symbolId)) return;
    if (symbolId !== undefined) visitingFunctions.add(symbolId);
    visit(function_.body, function_);
    if (symbolId !== undefined) visitingFunctions.delete(symbolId);
  };

  visit(expression, undefined);
  return new Map(
    [...captures].map(([operation, names]) => [
      operation,
      [...names].toSorted(),
    ]),
  );
}

function linearValuesLiveAfter(
  scope: TypedDucklangExpression,
  performance: Extract<TypedDucklangExpression, { readonly kind: "hostCall" }>,
): readonly string[] {
  const live = new Map<number, DucklangSymbol>();
  const pending = [scope];
  while (pending.length !== 0) {
    const expression = pending.pop()!;
    if (
      expression.kind === "reference" &&
      expression.symbol.linear === true &&
      expression.symbol.span.end <= performance.span.start &&
      expression.span.start >= performance.span.end
    ) {
      live.set(expression.symbol.id, expression.symbol);
    }
    pending.push(...expressionChildren(expression));
  }
  return [...live.values()].map((symbol) => symbol.text).toSorted();
}

function resolveHandler(
  expression: TypedDucklangExpression,
  bindings: ReadonlyMap<number, TypedDucklangBinding>,
  visiting: Set<number>,
):
  | Extract<
    TypedDucklangExpression,
    { readonly kind: "effectHandler" }
  >
  | undefined {
  if (expression.kind === "effectHandler") return expression;
  if (expression.kind === "block") {
    return resolveHandler(expression.result, bindings, visiting);
  }
  if (expression.kind === "reference") {
    if (visiting.has(expression.symbol.id)) return undefined;
    const binding = bindings.get(expression.symbol.id);
    if (binding === undefined) return undefined;
    visiting.add(expression.symbol.id);
    const handler = resolveHandler(binding.value, bindings, visiting);
    visiting.delete(expression.symbol.id);
    return handler;
  }
  if (expression.kind === "call") {
    if (expression.callee.kind === "function") {
      return resolveHandler(expression.callee.body, bindings, visiting);
    }
    if (expression.callee.kind === "reference") {
      const binding = bindings.get(expression.callee.symbol.id);
      if (binding?.value.kind === "function") {
        return resolveHandler(binding.value.body, bindings, visiting);
      }
    }
  }
  return undefined;
}

function resumptionUsage(
  expression: TypedDucklangExpression,
  resumptionId: number,
): ResumptionUsage {
  if (expression.kind === "resume") {
    const value = resumptionUsage(expression.value, resumptionId);
    return expression.resumption.id === resumptionId
      ? {
        minimum: value.minimum + 1,
        maximum: value.maximum + 1,
        fallsThrough: value.fallsThrough,
      }
      : value;
  }
  if (
    expression.kind === "reference" &&
    expression.symbol.id === resumptionId
  ) {
    return {
      minimum: 0,
      maximum: Number.POSITIVE_INFINITY,
      fallsThrough: true,
    };
  }
  if (expression.kind === "function") {
    const body = resumptionUsage(expression.body, resumptionId);
    return body.maximum === 0 ? noResumptionUsage() : {
      minimum: 0,
      maximum: Number.POSITIVE_INFINITY,
      fallsThrough: true,
    };
  }
  if (expression.kind === "if" || expression.kind === "ifUnion") {
    const prefix = expression.kind === "if"
      ? resumptionUsage(expression.condition, resumptionId)
      : resumptionUsage(expression.value, resumptionId);
    const consequence = resumptionUsage(
      expression.consequence,
      resumptionId,
    );
    const alternative = resumptionUsage(
      expression.alternative,
      resumptionId,
    );
    return sequenceUsage([
      prefix,
      {
        minimum: Math.min(consequence.minimum, alternative.minimum),
        maximum: Math.max(consequence.maximum, alternative.maximum),
        fallsThrough: consequence.fallsThrough && alternative.fallsThrough,
      },
    ]);
  }
  if (expression.kind === "return") {
    const value = resumptionUsage(expression.expression, resumptionId);
    return { ...value, fallsThrough: false };
  }
  if (expression.kind === "block") {
    return sequenceUsage([
      ...expression.steps.map((step) =>
        resumptionUsage(
          step.kind === "binding" ? step.binding.value : step.expression,
          resumptionId,
        )
      ),
      resumptionUsage(expression.result, resumptionId),
    ]);
  }
  return sequenceUsage(
    expressionChildren(expression).map((child) =>
      resumptionUsage(child, resumptionId)
    ),
  );
}

function noResumptionUsage(): ResumptionUsage {
  return { minimum: 0, maximum: 0, fallsThrough: true };
}

function sequenceUsage(
  usages: readonly ResumptionUsage[],
): ResumptionUsage {
  let minimum = 0;
  let maximum = 0;
  let fallsThrough = true;
  for (const usage of usages) {
    if (!fallsThrough) break;
    minimum += usage.minimum;
    maximum += usage.maximum;
    fallsThrough = usage.fallsThrough;
  }
  return { minimum, maximum, fallsThrough };
}

function expressionChildren(
  expression: TypedDucklangExpression,
): readonly TypedDucklangExpression[] {
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
      return [];
    case "effectHandler":
      return expression.fields.map((field) => field.value);
    case "handle":
      return [expression.body, expression.handler];
    case "resume":
      return [expression.value];
    case "hostCall":
      return expression.arguments;
    case "optionDo":
      return [expression.option];
    case "unionCase":
      return [expression.value];
    case "product":
      return expression.values;
    case "project":
    case "namedProject":
      return [expression.product];
    case "recordUpdate":
      return [
        expression.product,
        ...expression.fields.map((field) => field.value),
      ];
    case "function":
      return [expression.body];
    case "call":
      return [expression.callee, ...expression.arguments];
    case "index":
      return [expression.collection, expression.index];
    case "selectProductElement":
      return [...expression.values, expression.index];
    case "indexUpdate":
      return [expression.product, expression.index, expression.value];
    case "textAppend":
    case "binary":
      return [expression.left, expression.right];
    case "ownership":
    case "return":
    case "comptime":
      return [expression.expression];
    case "if":
      return [
        expression.condition,
        expression.consequence,
        expression.alternative,
      ];
    case "ifUnion":
      return [
        expression.value,
        expression.consequence,
        expression.alternative,
      ];
    case "block":
      return [
        ...expression.steps.map((step) =>
          step.kind === "binding" ? step.binding.value : step.expression
        ),
        expression.result,
      ];
    case "scratch":
      return [expression.body];
  }
}

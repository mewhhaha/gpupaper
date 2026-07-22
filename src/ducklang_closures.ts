import type {
  TypedDucklangBinding,
  TypedDucklangBlockStep,
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";

export function specializeStaticDucklangClosures(
  module: TypedDucklangModule,
): TypedDucklangModule {
  const values = new Map<number, TypedDucklangExpression>();
  const bindings = module.bindings.map((binding): TypedDucklangBinding => {
    const value = rewriteExpression(binding.value, values);
    values.set(binding.symbol.id, value);
    return { ...binding, value };
  });
  const result = rewriteExpression(module.result, values);

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
    visitChildren(expression, visit);
  };
  visit(result);

  return {
    ...module,
    bindings: bindings.filter((binding) => reachable.has(binding.symbol.id)),
    result,
  };
}

function rewriteExpression(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  const rewritten = rewriteChildren(
    expression,
    (child) => rewriteExpression(child, values),
  );
  const foldedBinary = foldStaticBinary(rewritten, values);
  if (foldedBinary !== undefined) return foldedBinary;
  const foldedIntrinsic = foldStaticIntrinsic(rewritten, values);
  if (foldedIntrinsic !== undefined) return foldedIntrinsic;
  if (
    rewritten.kind !== "call" || rewritten.type.kind !== "function" ||
    rewritten.callee.kind !== "reference"
  ) {
    return collapseEmptyBlock(rewritten);
  }
  const factory = values.get(rewritten.callee.symbol.id);
  if (
    factory?.kind !== "function" || factory.recursive ||
    factory.parameters.length !== rewritten.arguments.length
  ) {
    return collapseEmptyBlock(rewritten);
  }
  const substitutions = new Map(
    factory.parameters.map((parameter, index) => [
      parameter.id,
      rewritten.arguments[index],
    ]),
  );
  return rewriteExpression(substitute(factory.body, substitutions), values);
}

function foldStaticBinary(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression | undefined {
  if (expression.kind !== "binary" || expression.operator !== "==") {
    return undefined;
  }
  const left = staticValue(expression.left, values);
  const right = staticValue(expression.right, values);
  if (left.kind !== "string" || right.kind !== "string") return undefined;
  return {
    kind: "boolean",
    value: left.value === right.value,
    type: expression.type,
    span: expression.span,
  };
}

function foldStaticIntrinsic(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression | undefined {
  if (expression.kind !== "call") return undefined;
  const callee = staticValue(expression.callee, values);
  if (
    callee.kind !== "intrinsic" ||
    callee.modulePath !== "duck:prelude/runtime"
  ) {
    return undefined;
  }
  const arguments_ = expression.arguments.map((argument) =>
    staticValue(argument, values)
  );
  if (
    callee.exportName === "length" && arguments_.length === 1 &&
    arguments_[0].kind === "string"
  ) {
    return {
      kind: "integer",
      value: new TextEncoder().encode(arguments_[0].value).length,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.exportName === "append" && arguments_.length === 2 &&
    arguments_[0].kind === "string" && arguments_[1].kind === "string"
  ) {
    return {
      kind: "string",
      value: arguments_[0].value + arguments_[1].value,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.exportName !== "slice" || arguments_.length !== 3 ||
    arguments_[0].kind !== "string" || arguments_[1].kind !== "integer" ||
    arguments_[2].kind !== "integer"
  ) {
    return undefined;
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

function staticValue(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  const visited = new Set<number>();
  let value = expression;
  while (value.kind === "reference" && !visited.has(value.symbol.id)) {
    visited.add(value.symbol.id);
    const resolved = values.get(value.symbol.id);
    if (resolved === undefined) break;
    value = resolved;
  }
  return value;
}

function substitute(
  expression: TypedDucklangExpression,
  substitutions: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  if (expression.kind === "reference") {
    return substitutions.get(expression.symbol.id) ?? expression;
  }
  return rewriteChildren(
    expression,
    (child) => substitute(child, substitutions),
  );
}

function collapseEmptyBlock(
  expression: TypedDucklangExpression,
): TypedDucklangExpression {
  if (expression.kind === "block" && expression.steps.length === 0) {
    return expression.result;
  }
  return expression;
}

function rewriteChildren(
  expression: TypedDucklangExpression,
  rewrite: (child: TypedDucklangExpression) => TypedDucklangExpression,
): TypedDucklangExpression {
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "boolean":
    case "string":
    case "intrinsic":
    case "reference":
      return expression;
    case "function":
      return { ...expression, body: rewrite(expression.body) };
    case "call":
      return {
        ...expression,
        callee: rewrite(expression.callee),
        arguments: expression.arguments.map(rewrite),
      };
    case "binary":
      return {
        ...expression,
        left: rewrite(expression.left),
        right: rewrite(expression.right),
      };
    case "return":
    case "comptime":
      return { ...expression, expression: rewrite(expression.expression) };
    case "if":
      return {
        ...expression,
        condition: rewrite(expression.condition),
        consequence: rewrite(expression.consequence),
        alternative: rewrite(expression.alternative),
      };
    case "block":
      return {
        ...expression,
        steps: expression.steps.map((step): TypedDucklangBlockStep =>
          step.kind === "expression"
            ? { kind: "expression", expression: rewrite(step.expression) }
            : {
              kind: "binding",
              binding: {
                ...step.binding,
                value: rewrite(step.binding.value),
              },
            }
        ),
        result: rewrite(expression.result),
      };
  }
}

function visitChildren(
  expression: TypedDucklangExpression,
  visit: (child: TypedDucklangExpression) => void,
): void {
  rewriteChildren(expression, (child) => {
    visit(child);
    return child;
  });
}

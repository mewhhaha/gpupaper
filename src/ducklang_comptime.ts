import {
  compileScalarComptimeExpression,
  type ComptimeBatchResult,
  type ComptimeValue,
  evaluateBytecodeOnCpu,
  evaluateBytecodeOnGpu,
  type ScalarComptimeExpression,
} from "./comptime.ts";
import type {
  TypedDucklangBinding,
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";

export async function evaluateDucklangComptime(
  module: TypedDucklangModule,
  runGpu: boolean,
): Promise<{
  readonly module: TypedDucklangModule;
  readonly cpuValues: readonly ComptimeValue[];
  readonly gpu: ComptimeBatchResult | undefined;
}> {
  const expressions: TypedDucklangExpression[] = [];
  for (const binding of module.bindings) {
    collectComptimeExpressions(binding.value, expressions);
  }
  collectComptimeExpressions(module.result, expressions);

  const programs = expressions.map((expression) =>
    compileScalarComptimeExpression(scalarExpression(expression))
  );
  const cpu = evaluateBytecodeOnCpu(programs);
  const gpu = runGpu ? await evaluateBytecodeOnGpu(programs) : undefined;
  if (cpu.status !== "completed") {
    throw new Error("Ducklang CPU comptime evaluator did not complete");
  }
  if (gpu?.status === "completed") {
    for (let index = 0; index < cpu.values.length; index += 1) {
      if (
        JSON.stringify(cpu.values[index]) !== JSON.stringify(gpu.values[index])
      ) {
        throw new Error(`Ducklang CPU/GPU comptime mismatch at job ${index}`);
      }
    }
  }

  let valueIndex = 0;
  const replace = (expression: TypedDucklangExpression) =>
    replaceComptimeExpressions(expression, cpu.values, () => valueIndex++);
  return {
    module: {
      ...module,
      bindings: module.bindings.map((binding) => ({
        ...binding,
        value: replace(binding.value),
      })),
      result: replace(module.result),
    },
    cpuValues: cpu.values,
    gpu,
  };
}

function collectComptimeExpressions(
  expression: TypedDucklangExpression,
  expressions: TypedDucklangExpression[],
): void {
  if (expression.kind === "comptime") {
    expressions.push(expression.expression);
    return;
  }
  switch (expression.kind) {
    case "integer":
    case "boolean":
    case "reference":
      return;
    case "function":
      collectComptimeExpressions(expression.body, expressions);
      return;
    case "call":
      collectComptimeExpressions(expression.callee, expressions);
      for (const argument of expression.arguments) {
        collectComptimeExpressions(argument, expressions);
      }
      return;
    case "binary":
      collectComptimeExpressions(expression.left, expressions);
      collectComptimeExpressions(expression.right, expressions);
      return;
    case "if":
      collectComptimeExpressions(expression.condition, expressions);
      collectComptimeExpressions(expression.consequence, expressions);
      collectComptimeExpressions(expression.alternative, expressions);
      return;
    case "block":
      for (const binding of expression.bindings) {
        collectComptimeExpressions(binding.value, expressions);
      }
      collectComptimeExpressions(expression.result, expressions);
      return;
  }
}

function scalarExpression(
  expression: TypedDucklangExpression,
): ScalarComptimeExpression {
  switch (expression.kind) {
    case "integer":
    case "boolean":
      return expression;
    case "binary":
      return {
        ...expression,
        left: scalarExpression(expression.left),
        right: scalarExpression(expression.right),
      };
    case "if":
      return {
        kind: "if",
        condition: scalarExpression(expression.condition),
        thenBranch: scalarExpression(expression.consequence),
        elseBranch: scalarExpression(expression.alternative),
        span: expression.span,
      };
    case "comptime":
      return scalarExpression(expression.expression);
    case "block":
      if (expression.bindings.length === 0) {
        return scalarExpression(expression.result);
      }
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: Ducklang comptime requires a closed scalar block; found ${expression.bindings.length} bindings`,
      );
    default:
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: Ducklang comptime requires a closed scalar expression; found ${expression.kind}`,
      );
  }
}

function replaceComptimeExpressions(
  expression: TypedDucklangExpression,
  values: readonly ComptimeValue[],
  nextValueIndex: () => number,
): TypedDucklangExpression {
  if (expression.kind === "comptime") {
    const value = values[nextValueIndex()];
    if (value === undefined) {
      throw new Error(
        `${expression.span.file}:${expression.span.start}: missing Ducklang comptime result`,
      );
    }
    return value.kind === "integer"
      ? {
        kind: "integer",
        value: value.value,
        type: expression.type,
        span: expression.span,
      }
      : {
        kind: "boolean",
        value: value.value,
        type: expression.type,
        span: expression.span,
      };
  }
  switch (expression.kind) {
    case "integer":
    case "boolean":
    case "reference":
      return expression;
    case "function":
      return {
        ...expression,
        body: replaceComptimeExpressions(
          expression.body,
          values,
          nextValueIndex,
        ),
      };
    case "call":
      return {
        ...expression,
        callee: replaceComptimeExpressions(
          expression.callee,
          values,
          nextValueIndex,
        ),
        arguments: expression.arguments.map((argument) =>
          replaceComptimeExpressions(argument, values, nextValueIndex)
        ),
      };
    case "binary":
      return {
        ...expression,
        left: replaceComptimeExpressions(
          expression.left,
          values,
          nextValueIndex,
        ),
        right: replaceComptimeExpressions(
          expression.right,
          values,
          nextValueIndex,
        ),
      };
    case "if":
      return {
        ...expression,
        condition: replaceComptimeExpressions(
          expression.condition,
          values,
          nextValueIndex,
        ),
        consequence: replaceComptimeExpressions(
          expression.consequence,
          values,
          nextValueIndex,
        ),
        alternative: replaceComptimeExpressions(
          expression.alternative,
          values,
          nextValueIndex,
        ),
      };
    case "block":
      return {
        ...expression,
        bindings: expression.bindings.map((binding): TypedDucklangBinding => ({
          ...binding,
          value: replaceComptimeExpressions(
            binding.value,
            values,
            nextValueIndex,
          ),
        })),
        result: replaceComptimeExpressions(
          expression.result,
          values,
          nextValueIndex,
        ),
      };
  }
}

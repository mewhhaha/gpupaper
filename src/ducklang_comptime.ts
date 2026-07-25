import {
  compileScalarComptimeExpression,
  type ComptimeBatchResult,
  type ComptimeValue,
  evaluateBytecodeOnCpu,
  evaluateBytecodeOnGpu,
  type ScalarComptimeExpression,
} from "./comptime.ts";
import {
  type DucklangConstValue,
  evaluateDucklangConst,
} from "./ducklang_const.ts";
import type {
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";
import type { Type } from "./types.ts";

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

  const constValues = expressions.map((expression) =>
    evaluateDucklangConst(expression, { fuel: 1_000_000 })
  );
  const scalarExpressions = expressions.flatMap((expression, index) => {
    const scalar = scalarExpression(expression);
    return scalar === undefined ? [] : [{ expression: scalar, index }];
  });
  const programs = scalarExpressions.map(({ expression }) =>
    compileScalarComptimeExpression(expression)
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
  for (const [scalarIndex, candidate] of scalarExpressions.entries()) {
    const constValue = constValues[candidate.index];
    const cpuValue = cpu.values[scalarIndex];
    if (
      constValue === undefined || cpuValue === undefined ||
      JSON.stringify(comptimeValue(constValue)) !== JSON.stringify(cpuValue)
    ) {
      throw new Error(
        `Ducklang scalar/ConstValue comptime mismatch at job ${candidate.index}`,
      );
    }
  }

  let valueIndex = 0;
  const replace = (expression: TypedDucklangExpression) =>
    replaceComptimeExpressions(expression, constValues, () => valueIndex++);
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
    if (expression.expression.kind === "function") return;
    expressions.push(expression.expression);
    return;
  }
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
    case "unionCase":
      collectComptimeExpressions(expression.value, expressions);
      return;
    case "product":
      for (const value of expression.values) {
        collectComptimeExpressions(value, expressions);
      }
      return;
    case "project":
      collectComptimeExpressions(expression.product, expressions);
      return;
    case "recordUpdate":
      collectComptimeExpressions(expression.product, expressions);
      for (const field of expression.fields) {
        collectComptimeExpressions(field.value, expressions);
      }
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
    case "hostCall":
      for (const argument of expression.arguments) {
        collectComptimeExpressions(argument, expressions);
      }
      return;
    case "optionDo":
      collectComptimeExpressions(expression.option, expressions);
      return;
    case "index":
      collectComptimeExpressions(expression.collection, expressions);
      collectComptimeExpressions(expression.index, expressions);
      return;
    case "selectProductElement":
      for (const value of expression.values) {
        collectComptimeExpressions(value, expressions);
      }
      collectComptimeExpressions(expression.index, expressions);
      return;
    case "indexUpdate":
      collectComptimeExpressions(expression.product, expressions);
      collectComptimeExpressions(expression.index, expressions);
      collectComptimeExpressions(expression.value, expressions);
      return;
    case "textAppend":
      collectComptimeExpressions(expression.left, expressions);
      collectComptimeExpressions(expression.right, expressions);
      return;
    case "binary":
      collectComptimeExpressions(expression.left, expressions);
      collectComptimeExpressions(expression.right, expressions);
      return;
    case "ownership":
      collectComptimeExpressions(expression.expression, expressions);
      return;
    case "return":
      collectComptimeExpressions(expression.expression, expressions);
      return;
    case "scratch":
      collectComptimeExpressions(expression.body, expressions);
      return;
    case "if":
      collectComptimeExpressions(expression.condition, expressions);
      collectComptimeExpressions(expression.consequence, expressions);
      collectComptimeExpressions(expression.alternative, expressions);
      return;
    case "ifUnion":
      collectComptimeExpressions(expression.value, expressions);
      collectComptimeExpressions(expression.consequence, expressions);
      collectComptimeExpressions(expression.alternative, expressions);
      return;
    case "block":
      for (const step of expression.steps) {
        collectComptimeExpressions(
          step.kind === "binding" ? step.binding.value : step.expression,
          expressions,
        );
      }
      collectComptimeExpressions(expression.result, expressions);
      return;
  }
}

function scalarExpression(
  expression: TypedDucklangExpression,
): ScalarComptimeExpression | undefined {
  switch (expression.kind) {
    case "integer":
    case "boolean":
      return expression;
    case "integer64":
    case "float32":
    case "float64":
      return undefined;
    case "binary": {
      const left = scalarExpression(expression.left);
      const right = scalarExpression(expression.right);
      if (left === undefined || right === undefined) return undefined;
      return {
        ...expression,
        left,
        right,
      };
    }
    case "if": {
      const condition = scalarExpression(expression.condition);
      const thenBranch = scalarExpression(expression.consequence);
      const elseBranch = scalarExpression(expression.alternative);
      if (
        condition === undefined || thenBranch === undefined ||
        elseBranch === undefined
      ) {
        return undefined;
      }
      return {
        kind: "if",
        condition,
        thenBranch,
        elseBranch,
        span: expression.span,
      };
    }
    case "comptime":
      return scalarExpression(expression.expression);
    case "block":
      if (expression.steps.length === 0) {
        return scalarExpression(expression.result);
      }
      return undefined;
    default:
      return undefined;
  }
}

function replaceComptimeExpressions(
  expression: TypedDucklangExpression,
  values: readonly DucklangConstValue[],
  nextValueIndex: () => number,
): TypedDucklangExpression {
  if (expression.kind === "comptime") {
    if (expression.expression.kind === "function") {
      return expression.expression;
    }
    const value = values[nextValueIndex()];
    if (value === undefined) {
      throw new Error(
        `${expression.span.file}:${expression.span.start}: missing Ducklang comptime result`,
      );
    }
    return constExpression(value, expression);
  }
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
      return expression;
    case "unionCase":
      return {
        ...expression,
        value: replaceComptimeExpressions(
          expression.value,
          values,
          nextValueIndex,
        ),
      };
    case "product":
      return {
        ...expression,
        values: expression.values.map((value) =>
          replaceComptimeExpressions(value, values, nextValueIndex)
        ),
      };
    case "project":
      return {
        ...expression,
        product: replaceComptimeExpressions(
          expression.product,
          values,
          nextValueIndex,
        ),
      };
    case "recordUpdate":
      return {
        ...expression,
        product: replaceComptimeExpressions(
          expression.product,
          values,
          nextValueIndex,
        ),
        fields: expression.fields.map((field) => ({
          ...field,
          value: replaceComptimeExpressions(
            field.value,
            values,
            nextValueIndex,
          ),
        })),
      };
    case "function":
      return {
        ...expression,
        body: replaceComptimeExpressions(
          expression.body,
          values,
          nextValueIndex,
        ),
      };
    case "ownership":
      return {
        ...expression,
        expression: replaceComptimeExpressions(
          expression.expression,
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
    case "hostCall":
      return {
        ...expression,
        arguments: expression.arguments.map((argument) =>
          replaceComptimeExpressions(argument, values, nextValueIndex)
        ),
      };
    case "optionDo":
      return {
        ...expression,
        option: replaceComptimeExpressions(
          expression.option,
          values,
          nextValueIndex,
        ),
      };
    case "index":
      return {
        ...expression,
        collection: replaceComptimeExpressions(
          expression.collection,
          values,
          nextValueIndex,
        ),
        index: replaceComptimeExpressions(
          expression.index,
          values,
          nextValueIndex,
        ),
      };
    case "selectProductElement":
      return {
        ...expression,
        values: expression.values.map((value) =>
          replaceComptimeExpressions(value, values, nextValueIndex)
        ),
        index: replaceComptimeExpressions(
          expression.index,
          values,
          nextValueIndex,
        ),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: replaceComptimeExpressions(
          expression.product,
          values,
          nextValueIndex,
        ),
        index: replaceComptimeExpressions(
          expression.index,
          values,
          nextValueIndex,
        ),
        value: replaceComptimeExpressions(
          expression.value,
          values,
          nextValueIndex,
        ),
      };
    case "textAppend":
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
    case "return":
      return {
        ...expression,
        expression: replaceComptimeExpressions(
          expression.expression,
          values,
          nextValueIndex,
        ),
      };
    case "scratch":
      return {
        ...expression,
        body: replaceComptimeExpressions(
          expression.body,
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
    case "ifUnion":
      return {
        ...expression,
        value: replaceComptimeExpressions(
          expression.value,
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
        steps: expression.steps.map((step) =>
          step.kind === "expression"
            ? {
              kind: "expression" as const,
              expression: replaceComptimeExpressions(
                step.expression,
                values,
                nextValueIndex,
              ),
            }
            : {
              kind: "binding" as const,
              binding: {
                ...step.binding,
                value: replaceComptimeExpressions(
                  step.binding.value,
                  values,
                  nextValueIndex,
                ),
              },
            }
        ),
        result: replaceComptimeExpressions(
          expression.result,
          values,
          nextValueIndex,
        ),
      };
  }
}

function comptimeValue(value: DucklangConstValue): ComptimeValue | undefined {
  if (value.kind !== "scalar") return undefined;
  if (value.scalar.kind === "i32") {
    return { kind: "integer", value: value.scalar.value };
  }
  if (value.scalar.kind === "bool") {
    return { kind: "boolean", value: value.scalar.value };
  }
  return undefined;
}

function constExpression(
  value: DucklangConstValue,
  template: Extract<
    TypedDucklangExpression,
    { readonly kind: "comptime" }
  >,
): TypedDucklangExpression {
  const span = template.span;
  if (value.kind === "scalar") {
    switch (value.scalar.kind) {
      case "i32":
        return {
          kind: "integer",
          value: value.scalar.value,
          type: template.type,
          span,
        };
      case "i64":
        return {
          kind: "integer64",
          value: value.scalar.value,
          type: template.type,
          span,
        };
      case "f32":
        return {
          kind: "float32",
          value: value.scalar.value,
          type: template.type,
          span,
        };
      case "f64":
        return {
          kind: "float64",
          value: value.scalar.value,
          type: template.type,
          span,
        };
      case "bool":
        return {
          kind: "boolean",
          value: value.scalar.value,
          type: template.type,
          span,
        };
      case "text":
        return {
          kind: "string",
          value: value.scalar.value,
          type: template.type,
          span,
        };
      case "unit":
        return { kind: "unit", type: template.type, span };
      case "bytes":
        throw new TypeError(
          `${span.file}:${span.start}: compile-time Bytes require runtime buffer layout before materialization`,
        );
    }
  }
  if (value.kind === "product") {
    return {
      kind: "product",
      productKind: "tuple",
      values: value.fields.map((field, index) =>
        materializeConstValue(
          field.value,
          productElementType(template.type, index),
          span,
        )
      ),
      type: template.type,
      span,
    };
  }
  if (value.kind === "sum") {
    return {
      kind: "unionCase",
      unionName: value.unionName,
      caseName: value.caseName,
      value: materializeConstValue(
        value.value,
        constValueType(value.value),
        span,
      ),
      type: template.type,
      span,
    };
  }
  throw new TypeError(
    `${span.file}:${span.start}: compile-time ${value.kind} value escaped normalization`,
  );
}

function materializeConstValue(
  value: DucklangConstValue,
  type: Type,
  span: TypedDucklangExpression["span"],
): TypedDucklangExpression {
  return constExpression(value, {
    kind: "comptime",
    context: "explicit",
    expression: { kind: "unit", type, span },
    type,
    span,
  });
}

function productElementType(type: Type, index: number): Type {
  return type.kind === "constructor" && type.arguments[index] !== undefined
    ? type.arguments[index]
    : { kind: "constructor", name: "unit", arguments: [] };
}

function constValueType(value: DucklangConstValue): Type {
  if (value.kind === "scalar") {
    const name = value.scalar.kind === "bool"
      ? "bool"
      : value.scalar.kind === "text"
      ? "text"
      : value.scalar.kind === "bytes"
      ? "bytes"
      : value.scalar.kind === "unit"
      ? "unit"
      : value.scalar.kind;
    return { kind: "constructor", name, arguments: [] };
  }
  if (value.kind === "product") {
    return {
      kind: "constructor",
      name: "tuple",
      arguments: value.fields.map((field) => constValueType(field.value)),
    };
  }
  if (value.kind === "sum") {
    return {
      kind: "constructor",
      name: value.unionName,
      arguments: [],
    };
  }
  return { kind: "constructor", name: "unit", arguments: [] };
}

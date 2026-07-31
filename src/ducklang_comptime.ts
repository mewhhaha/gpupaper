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
  recursiveDucklangConstEnvironment,
} from "./ducklang_const.ts";
import { visitDucklangExpressionChildren } from "./ducklang_closures.ts";
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
  readonly changedBindingSymbols: ReadonlySet<number>;
  readonly resultChanged: boolean;
  readonly metrics: {
    readonly expressionCount: number;
    readonly functionExpressionCount: number;
    readonly scalarJobCount: number;
    readonly deferredExpressionCount: number;
    readonly changedBindingCount: number;
  };
}> {
  const expressions: TypedDucklangExpression[] = [];
  const functionExpressions = new Set<TypedDucklangExpression>();
  const deferredExpressions = new Set<TypedDucklangExpression>();
  for (const binding of module.bindings) {
    collectComptimeExpressions(
      binding.value,
      expressions,
      new Set(),
      deferredExpressions,
      functionExpressions,
    );
  }
  collectComptimeExpressions(
    module.result,
    expressions,
    new Set(),
    deferredExpressions,
    functionExpressions,
  );

  // Module-level function bindings are supplied as closures that can see the
  // environment holding them, so a recursive compile-time function finds itself.
  // Reference substitution alone cannot express that, which is why recursion used to
  // surface as "missing compile-time value for <name>#<id>".
  const environment = recursiveDucklangConstEnvironment(
    module.bindings.flatMap((binding) =>
      binding.value.kind === "function"
        ? [{
          symbol: binding.symbol,
          code: {
            kind: "source" as const,
            parameters: binding.value.parameters,
            body: binding.value.body,
          },
        }]
        : []
    ),
  );
  const constValues = expressions.map((expression) =>
    evaluateDucklangConst(expression, { fuel: 1_000_000, environment })
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
    replaceComptimeExpressions(
      expression,
      constValues,
      () => valueIndex++,
      deferredExpressions,
    );
  const changedBindingSymbols = new Set<number>();
  const bindings = module.bindings.map((binding) => {
    if (!containsComptimeReplacement(binding.value, deferredExpressions)) {
      return binding;
    }
    changedBindingSymbols.add(binding.symbol.id);
    return { ...binding, value: replace(binding.value) };
  });
  const resultChanged = containsComptimeReplacement(
    module.result,
    deferredExpressions,
  );
  const result = resultChanged ? replace(module.result) : module.result;
  const comptimeModule = changedBindingSymbols.size === 0 && !resultChanged
    ? module
    : {
      ...module,
      bindings,
      result,
    };
  return {
    module: comptimeModule,
    cpuValues: cpu.values,
    gpu,
    changedBindingSymbols,
    resultChanged,
    metrics: {
      expressionCount: expressions.length,
      functionExpressionCount: functionExpressions.size,
      scalarJobCount: scalarExpressions.length,
      deferredExpressionCount: deferredExpressions.size,
      changedBindingCount: changedBindingSymbols.size,
    },
  };
}

function containsComptimeReplacement(
  expression: TypedDucklangExpression,
  deferredExpressions: ReadonlySet<TypedDucklangExpression>,
): boolean {
  if (expression.kind === "comptime") {
    return !deferredExpressions.has(expression);
  }
  if (expression.kind === "binary") {
    if (expression.operator === ":>" || expression.operator === ":<") {
      return true;
    }
    if (
      expression.operator === ":+"
    ) {
      if (expression.left.kind === "integer" && expression.left.value === 0) {
        return true;
      }
      if (
        expression.left.kind === "product" &&
        expression.right.kind === "product"
      ) {
        return true;
      }
    }
  }
  let containsReplacement = false;
  visitDucklangExpressionChildren(expression, (child) => {
    if (
      !containsReplacement &&
      containsComptimeReplacement(child, deferredExpressions)
    ) {
      containsReplacement = true;
    }
  });
  return containsReplacement;
}

function collectComptimeExpressions(
  expression: TypedDucklangExpression,
  expressions: TypedDucklangExpression[],
  boundSymbols: ReadonlySet<number>,
  deferredExpressions: Set<TypedDucklangExpression>,
  functionExpressions: Set<TypedDucklangExpression>,
): void {
  if (expression.kind === "comptime") {
    if (expression.expression.kind === "function") {
      functionExpressions.add(expression);
      return;
    }
    if (referencesBoundSymbol(expression.expression, boundSymbols)) {
      deferredExpressions.add(expression);
      return;
    }
    expressions.push(expression.expression);
    return;
  }
  const collect = (child: TypedDucklangExpression) =>
    collectComptimeExpressions(
      child,
      expressions,
      boundSymbols,
      deferredExpressions,
      functionExpressions,
    );
  switch (expression.kind) {
    case "effectHandler":
      for (const field of expression.fields) collect(field.value);
      return;
    case "resume":
      collect(expression.value);
      return;
    case "handle":
      throw new Error(
        `${expression.span.file}:${expression.span.start}: typed Ducklang effect syntax reached comptime before structural effect lowering`,
      );
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
      collect(expression.value);
      return;
    case "product":
      for (const value of expression.values) {
        collect(value);
      }
      return;
    case "project":
      collect(expression.product);
      return;
    case "namedProject":
      collect(expression.product);
      return;
    case "recordUpdate":
      collect(expression.product);
      for (const field of expression.fields) {
        collect(field.value);
      }
      return;
    case "function": {
      const functionSymbols = new Set(boundSymbols);
      for (const parameter of expression.parameters) {
        functionSymbols.add(parameter.id);
      }
      collectComptimeExpressions(
        expression.body,
        expressions,
        functionSymbols,
        deferredExpressions,
        functionExpressions,
      );
      return;
    }
    case "call":
      collect(expression.callee);
      for (const argument of expression.arguments) {
        collect(argument);
      }
      return;
    case "hostCall":
      for (const argument of expression.arguments) {
        collect(argument);
      }
      return;
    case "optionDo":
      collect(expression.option);
      return;
    case "index":
      collect(expression.collection);
      collect(expression.index);
      return;
    case "selectProductElement":
      for (const value of expression.values) {
        collect(value);
      }
      collect(expression.index);
      return;
    case "indexUpdate":
      collect(expression.product);
      collect(expression.index);
      collect(expression.value);
      return;
    case "textAppend":
      collect(expression.left);
      collect(expression.right);
      return;
    case "binary":
      collect(expression.left);
      collect(expression.right);
      return;
    case "ownership":
      collect(expression.expression);
      return;
    case "return":
      collect(expression.expression);
      return;
    case "scratch":
      collect(expression.body);
      return;
    case "if":
      collect(expression.condition);
      collect(expression.consequence);
      collect(expression.alternative);
      return;
    case "ifUnion":
      collect(expression.value);
      collect(expression.consequence);
      collect(expression.alternative);
      return;
    case "block":
      for (const step of expression.steps) {
        collect(step.kind === "binding" ? step.binding.value : step.expression);
      }
      collect(expression.result);
      return;
  }
}

function referencesBoundSymbol(
  expression: TypedDucklangExpression,
  boundSymbols: ReadonlySet<number>,
): boolean {
  const pending: unknown[] = [expression];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const candidate = current as {
      readonly kind?: unknown;
      readonly symbol?: { readonly id?: unknown };
    };
    if (
      candidate.kind === "reference" &&
      typeof candidate.symbol?.id === "number" &&
      boundSymbols.has(candidate.symbol.id)
    ) {
      return true;
    }
    pending.push(...Object.values(current));
  }
  return false;
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
      const operator = expression.operator;
      if (
        operator === ":>" || operator === ":<" || operator === ":+" ||
        operator === ":|" || operator === ":&" || operator === ":-"
      ) {
        return undefined;
      }
      const left = scalarExpression(expression.left);
      const right = scalarExpression(expression.right);
      if (left === undefined || right === undefined) return undefined;
      return {
        kind: "binary",
        operator,
        left,
        right,
        span: expression.span,
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
  deferredExpressions: ReadonlySet<TypedDucklangExpression>,
): TypedDucklangExpression {
  if (expression.kind === "comptime") {
    if (deferredExpressions.has(expression)) return expression;
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
          deferredExpressions,
        ),
      };
    case "product":
      return {
        ...expression,
        values: expression.values.map((value) =>
          replaceComptimeExpressions(
            value,
            values,
            nextValueIndex,
            deferredExpressions,
          )
        ),
      };
    case "project":
      return {
        ...expression,
        product: replaceComptimeExpressions(
          expression.product,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "namedProject":
      return {
        ...expression,
        product: replaceComptimeExpressions(
          expression.product,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "recordUpdate":
      return {
        ...expression,
        product: replaceComptimeExpressions(
          expression.product,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        fields: expression.fields.map((field) => ({
          ...field,
          value: replaceComptimeExpressions(
            field.value,
            values,
            nextValueIndex,
            deferredExpressions,
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
          deferredExpressions,
        ),
      };
    case "ownership":
      return {
        ...expression,
        expression: replaceComptimeExpressions(
          expression.expression,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "call":
      return {
        ...expression,
        callee: replaceComptimeExpressions(
          expression.callee,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        arguments: expression.arguments.map((argument) =>
          replaceComptimeExpressions(
            argument,
            values,
            nextValueIndex,
            deferredExpressions,
          )
        ),
      };
    case "hostCall":
      return {
        ...expression,
        arguments: expression.arguments.map((argument) =>
          replaceComptimeExpressions(
            argument,
            values,
            nextValueIndex,
            deferredExpressions,
          )
        ),
      };
    case "effectHandler":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: replaceComptimeExpressions(
            field.value,
            values,
            nextValueIndex,
            deferredExpressions,
          ),
        })),
      };
    case "resume":
      return {
        ...expression,
        value: replaceComptimeExpressions(
          expression.value,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "handle":
      throw new Error(
        `${expression.span.file}:${expression.span.start}: typed Ducklang effect syntax reached comptime replacement before structural effect lowering`,
      );
    case "optionDo":
      return {
        ...expression,
        option: replaceComptimeExpressions(
          expression.option,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "index":
      return {
        ...expression,
        collection: replaceComptimeExpressions(
          expression.collection,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        index: replaceComptimeExpressions(
          expression.index,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "selectProductElement":
      return {
        ...expression,
        values: expression.values.map((value) =>
          replaceComptimeExpressions(
            value,
            values,
            nextValueIndex,
            deferredExpressions,
          )
        ),
        index: replaceComptimeExpressions(
          expression.index,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: replaceComptimeExpressions(
          expression.product,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        index: replaceComptimeExpressions(
          expression.index,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        value: replaceComptimeExpressions(
          expression.value,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "textAppend":
      return {
        ...expression,
        left: replaceComptimeExpressions(
          expression.left,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        right: replaceComptimeExpressions(
          expression.right,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "binary": {
      const binary = {
        ...expression,
        left: replaceComptimeExpressions(
          expression.left,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        right: replaceComptimeExpressions(
          expression.right,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
      if (binary.operator === ":>" || binary.operator === ":<") {
        return binary.left;
      }
      if (
        binary.operator === ":+" && binary.left.kind === "integer" &&
        binary.left.value === 0
      ) {
        return binary.right;
      }
      if (
        binary.operator === ":+" && binary.left.kind === "product" &&
        binary.right.kind === "product"
      ) {
        return {
          kind: "product",
          productKind: "tuple",
          values: [...binary.left.values, ...binary.right.values],
          ...(binary.left.fieldNames === undefined ||
              binary.right.fieldNames === undefined
            ? {}
            : {
              fieldNames: [
                ...binary.left.fieldNames,
                ...binary.right.fieldNames,
              ],
            }),
          type: binary.type,
          span: binary.span,
        };
      }
      return binary;
    }
    case "return":
      return {
        ...expression,
        expression: replaceComptimeExpressions(
          expression.expression,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "scratch":
      return {
        ...expression,
        body: replaceComptimeExpressions(
          expression.body,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "if":
      return {
        ...expression,
        condition: replaceComptimeExpressions(
          expression.condition,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        consequence: replaceComptimeExpressions(
          expression.consequence,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        alternative: replaceComptimeExpressions(
          expression.alternative,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
      };
    case "ifUnion":
      return {
        ...expression,
        value: replaceComptimeExpressions(
          expression.value,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        consequence: replaceComptimeExpressions(
          expression.consequence,
          values,
          nextValueIndex,
          deferredExpressions,
        ),
        alternative: replaceComptimeExpressions(
          expression.alternative,
          values,
          nextValueIndex,
          deferredExpressions,
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
                deferredExpressions,
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
                  deferredExpressions,
                ),
              },
            }
        ),
        result: replaceComptimeExpressions(
          expression.result,
          values,
          nextValueIndex,
          deferredExpressions,
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

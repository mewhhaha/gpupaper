import type { SourceSpan } from "./syntax.ts";
import type { EqualityConstraint, Type } from "./types.ts";
import type {
  DucklangSymbol,
  ResolvedDucklangBinding,
  ResolvedDucklangExpression,
  ResolvedDucklangModule,
} from "./ducklang_resolution.ts";

export type TypedDucklangExpression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "integer64";
    readonly value: bigint;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "boolean";
    readonly value: boolean;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "string";
    readonly value: string;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "intrinsic";
    readonly modulePath: string;
    readonly exportName: string;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "reference";
    readonly symbol: DucklangSymbol;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "function";
    readonly recursive: boolean;
    readonly parameters: readonly DucklangSymbol[];
    readonly body: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "call";
    readonly callee: TypedDucklangExpression;
    readonly arguments: readonly TypedDucklangExpression[];
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: DucklangBinaryOperator;
    readonly left: TypedDucklangExpression;
    readonly right: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "return";
    readonly expression: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: TypedDucklangExpression;
    readonly consequence: TypedDucklangExpression;
    readonly alternative: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "block";
    readonly steps: readonly TypedDucklangBlockStep[];
    readonly result: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "comptime";
    readonly expression: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  };

export type DucklangBinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "<"
  | ">"
  | "&&";

export type TypedDucklangBinding = {
  readonly symbol: DucklangSymbol;
  readonly previous: DucklangSymbol | undefined;
  readonly recursive: boolean;
  readonly stage: "compileTime" | "runtime";
  readonly value: TypedDucklangExpression;
  readonly type: Type;
  readonly span: SourceSpan;
};

export type TypedDucklangBlockStep =
  | { readonly kind: "binding"; readonly binding: TypedDucklangBinding }
  | {
    readonly kind: "expression";
    readonly expression: TypedDucklangExpression;
  };

export type TypedDucklangModule = {
  readonly file: string;
  readonly bindings: readonly TypedDucklangBinding[];
  readonly result: TypedDucklangExpression;
  readonly resultType: Type;
  readonly equalities: readonly EqualityConstraint[];
  readonly symbolTypes: ReadonlyMap<number, Type>;
};

type InferredExpression = {
  readonly expression: TypedDucklangExpression;
  readonly type: Type;
};

const i32Type: Type = { kind: "constructor", name: "i32", arguments: [] };
const i64Type: Type = { kind: "constructor", name: "i64", arguments: [] };
const booleanType: Type = {
  kind: "constructor",
  name: "bool",
  arguments: [],
};
const textType: Type = { kind: "constructor", name: "text", arguments: [] };
const binaryOperators = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "<",
  ">",
  "&&",
]);

export function inferDucklangModule(
  module: ResolvedDucklangModule,
): TypedDucklangModule {
  const inference = new DucklangInference(module.file);
  const environment = new Map<number, Type>();
  const bindings = inference.inferBindings(module.bindings, environment);
  const result = inference.inferExpression(module.result, environment);
  return inference.finish(bindings, result);
}

export function formatDucklangType(type: Type): string {
  if (type.kind === "variable") return `t${type.id}`;
  if (type.kind === "constructor") {
    if (type.arguments.length === 0) return type.name;
    return `${type.name}<${type.arguments.map(formatDucklangType).join(", ")}>`;
  }
  const parameter = type.parameter.kind === "function"
    ? `(${formatDucklangType(type.parameter)})`
    : formatDucklangType(type.parameter);
  return `${parameter} -> ${formatDucklangType(type.result)}`;
}

class DucklangInference {
  readonly #file: string;
  readonly #equalities: EqualityConstraint[] = [];
  readonly #substitutions = new Map<number, Type>();
  readonly #symbolTypes = new Map<number, Type>();
  readonly #numericVariables = new Set<number>();
  #nextVariable = 0;

  constructor(file: string) {
    this.#file = file;
  }

  inferBindings(
    bindings: readonly ResolvedDucklangBinding[],
    environment: Map<number, Type>,
  ): readonly TypedDucklangBinding[] {
    const typed: TypedDucklangBinding[] = [];
    for (const binding of bindings) {
      const recursiveType = binding.recursive
        ? this.#freshVariable()
        : undefined;
      if (recursiveType !== undefined) {
        environment.set(binding.symbol.id, recursiveType);
      }
      const inferred = this.inferExpression(binding.value, environment);
      const bindingType = recursiveType ?? inferred.type;
      if (recursiveType !== undefined) {
        this.#unify(recursiveType, inferred.type, binding.span);
      }
      if (binding.previous !== undefined) {
        const previousType = environment.get(binding.previous.id);
        if (previousType === undefined) {
          throw new Error(
            `${this.#file}:${binding.span.start}: missing type for resolved symbol ${binding.previous.text}#${binding.previous.id}`,
          );
        }
        this.#unify(previousType, bindingType, binding.span);
      }
      environment.set(binding.symbol.id, bindingType);
      this.#symbolTypes.set(binding.symbol.id, bindingType);
      typed.push({
        ...binding,
        value: inferred.expression,
        type: bindingType,
      });
    }
    return typed;
  }

  inferExpression(
    expression: ResolvedDucklangExpression,
    environment: ReadonlyMap<number, Type>,
  ): InferredExpression {
    switch (expression.kind) {
      case "integer":
        return { expression: { ...expression, type: i32Type }, type: i32Type };
      case "integer64":
        return { expression: { ...expression, type: i64Type }, type: i64Type };
      case "boolean":
        return {
          expression: { ...expression, type: booleanType },
          type: booleanType,
        };
      case "string":
        return {
          expression: { ...expression, type: textType },
          type: textType,
        };
      case "intrinsic": {
        let type: Type;
        if (
          expression.modulePath === "duck:prelude/runtime" &&
          expression.exportName === "length"
        ) {
          type = functionType([textType], i32Type);
        } else if (
          expression.modulePath === "duck:prelude/runtime" &&
          expression.exportName === "append"
        ) {
          type = functionType([textType, textType], textType);
        } else if (
          expression.modulePath === "duck:prelude/runtime" &&
          expression.exportName === "slice"
        ) {
          type = functionType([textType, i32Type, i32Type], textType);
        } else if (
          expression.modulePath === "duck:prelude/functional" &&
          expression.exportName === "apply"
        ) {
          const parameter = this.#freshVariable();
          const result = this.#freshVariable();
          type = functionType([
            functionType([parameter], result),
            parameter,
          ], result);
        } else if (
          expression.modulePath === "duck:prelude/functional" &&
          expression.exportName === "pipe"
        ) {
          const parameter = this.#freshVariable();
          const result = this.#freshVariable();
          type = functionType([
            parameter,
            functionType([parameter], result),
          ], result);
        } else if (
          expression.modulePath === "duck:prelude/functional" &&
          expression.exportName === "compose"
        ) {
          const parameter = this.#freshVariable();
          const intermediate = this.#freshVariable();
          const result = this.#freshVariable();
          type = functionType([
            functionType([intermediate], result),
            functionType([parameter], intermediate),
          ], functionType([parameter], result));
        } else {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang import ${expression.modulePath} does not provide a typed intrinsic ${expression.exportName}`,
          );
        }
        return { expression: { ...expression, type }, type };
      }
      case "reference": {
        const type = environment.get(expression.symbol.id);
        if (type === undefined) {
          throw new Error(
            `${this.#file}:${expression.span.start}: missing type for resolved symbol ${expression.symbol.text}#${expression.symbol.id}`,
          );
        }
        return { expression: { ...expression, type }, type };
      }
      case "function": {
        const functionEnvironment = new Map(environment);
        const parameterTypes = expression.parameters.map((parameter) => {
          const type = parameter.declaredType === undefined
            ? this.#freshVariable()
            : declaredDucklangType(parameter.declaredType);
          functionEnvironment.set(parameter.id, type);
          this.#symbolTypes.set(parameter.id, type);
          return type;
        });
        const body = this.inferExpression(expression.body, functionEnvironment);
        this.#unifyReturnTypes(body.expression, body.type);
        const type = parameterTypes.toReversed().reduce<Type>(
          (result, parameter) => ({ kind: "function", parameter, result }),
          body.type,
        );
        return {
          expression: { ...expression, body: body.expression, type },
          type,
        };
      }
      case "call": {
        const callee = this.inferExpression(expression.callee, environment);
        const arguments_ = expression.arguments.map((argument) =>
          this.inferExpression(argument, environment)
        );
        let result = callee.type;
        let calleeResult = callee.type;
        for (const [index, argument] of arguments_.entries()) {
          result = this.#freshVariable();
          this.#unify(
            calleeResult,
            { kind: "function", parameter: argument.type, result },
            expression.arguments[index].span,
          );
          calleeResult = result;
        }
        return {
          expression: {
            ...expression,
            callee: callee.expression,
            arguments: arguments_.map((argument) => argument.expression),
            type: result,
          },
          type: result,
        };
      }
      case "binary": {
        if (!binaryOperators.has(expression.operator)) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang operator ${expression.operator} has no typed IR operation`,
          );
        }
        const operator = expression.operator as DucklangBinaryOperator;
        const left = this.inferExpression(expression.left, environment);
        const right = this.inferExpression(expression.right, environment);
        if (operator === "&&") {
          this.#unify(left.type, booleanType, expression.left.span);
          this.#unify(right.type, booleanType, expression.right.span);
        } else {
          this.#unify(left.type, right.type, expression.span);
          const operandType = this.#apply(left.type);
          const equalityOnNonIntegers = operator === "==" &&
            operandType.kind === "constructor" &&
            (operandType.name === "bool" || operandType.name === "text") &&
            operandType.arguments.length === 0;
          if (operandType.kind === "variable") {
            this.#numericVariables.add(operandType.id);
          } else if (!isIntegerType(operandType) && !equalityOnNonIntegers) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang operator ${operator} requires equal-width integers; received ${
                formatDucklangType(operandType)
              }`,
            );
          }
        }
        const type = ["==", "<", ">", "&&"].includes(operator)
          ? booleanType
          : this.#apply(left.type);
        return {
          expression: {
            ...expression,
            operator,
            left: left.expression,
            right: right.expression,
            type,
          },
          type,
        };
      }
      case "unary": {
        const operand = this.inferExpression(expression.operand, environment);
        if (expression.operator === "-") {
          let operandType = this.#apply(operand.type);
          if (operandType.kind === "variable") {
            this.#unify(operandType, i32Type, expression.span);
            operandType = i32Type;
          }
          if (!isIntegerType(operandType)) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang unary - requires an integer; received ${
                formatDucklangType(operandType)
              }`,
            );
          }
          const zero: TypedDucklangExpression = operandType.name === "i64"
            ? {
              kind: "integer64",
              value: 0n,
              type: i64Type,
              span: expression.span,
            }
            : {
              kind: "integer",
              value: 0,
              type: i32Type,
              span: expression.span,
            };
          return {
            expression: {
              kind: "binary",
              operator: "-",
              left: zero,
              right: operand.expression,
              type: operandType,
              span: expression.span,
            },
            type: operandType,
          };
        }
        if (expression.operator === "!") {
          this.#unify(operand.type, booleanType, expression.span);
          const falseValue: TypedDucklangExpression = {
            kind: "boolean",
            value: false,
            type: booleanType,
            span: expression.span,
          };
          return {
            expression: {
              kind: "binary",
              operator: "==",
              left: operand.expression,
              right: falseValue,
              type: booleanType,
              span: expression.span,
            },
            type: booleanType,
          };
        }
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang unary operator ${expression.operator} has no typed IR operation`,
        );
      }
      case "return": {
        const returned = this.inferExpression(
          expression.expression,
          environment,
        );
        return {
          expression: {
            ...expression,
            expression: returned.expression,
            type: returned.type,
          },
          type: returned.type,
        };
      }
      case "if": {
        const condition = this.inferExpression(
          expression.condition,
          environment,
        );
        const consequence = this.inferExpression(
          expression.consequence,
          environment,
        );
        const consequenceType = this.#apply(consequence.type);
        const alternative = expression.alternative === undefined
          ? consequenceType.kind === "constructor" &&
              consequenceType.name === "i64"
            ? {
              expression: {
                kind: "integer64" as const,
                value: 0n,
                type: i64Type,
                span: expression.span,
              },
              type: i64Type,
            }
            : consequenceType.kind === "constructor" &&
                consequenceType.name === "bool"
            ? {
              expression: {
                kind: "boolean" as const,
                value: false,
                type: booleanType,
                span: expression.span,
              },
              type: booleanType,
            }
            : {
              expression: {
                kind: "integer" as const,
                value: 0,
                type: i32Type,
                span: expression.span,
              },
              type: i32Type,
            }
          : this.inferExpression(expression.alternative, environment);
        const conditionType = this.#apply(condition.type);
        const scalarCondition = conditionType.kind === "variable" ||
          (conditionType.kind === "constructor" &&
            conditionType.arguments.length === 0 &&
            (conditionType.name === "bool" || conditionType.name === "i32"));
        if (!scalarCondition) {
          throw new TypeError(
            `${this.#file}:${expression.condition.span.start}: Ducklang condition requires bool or i32; received ${
              formatDucklangType(conditionType)
            }`,
          );
        }
        this.#unify(
          consequence.type,
          alternative.type,
          expression.alternative?.span ?? expression.span,
        );
        return {
          expression: {
            ...expression,
            condition: condition.expression,
            consequence: consequence.expression,
            alternative: alternative.expression,
            type: consequence.type,
          },
          type: consequence.type,
        };
      }
      case "block": {
        const blockEnvironment = new Map(environment);
        const steps: TypedDucklangBlockStep[] = [];
        for (const step of expression.steps) {
          if (step.kind === "expression") {
            steps.push({
              kind: "expression",
              expression: this.inferExpression(
                step.expression,
                blockEnvironment,
              ).expression,
            });
            continue;
          }
          const [binding] = this.inferBindings(
            [step.binding],
            blockEnvironment,
          );
          steps.push({ kind: "binding", binding });
        }
        const result = this.inferExpression(
          expression.result,
          blockEnvironment,
        );
        return {
          expression: {
            ...expression,
            steps,
            result: result.expression,
            type: result.type,
          },
          type: result.type,
        };
      }
      case "comptime": {
        const inferred = this.inferExpression(
          expression.expression,
          environment,
        );
        return {
          expression: {
            ...expression,
            expression: inferred.expression,
            type: inferred.type,
          },
          type: inferred.type,
        };
      }
    }
  }

  finish(
    bindings: readonly TypedDucklangBinding[],
    result: InferredExpression,
  ): TypedDucklangModule {
    for (const variable of this.#numericVariables) {
      if (this.#apply({ kind: "variable", id: variable }).kind === "variable") {
        this.#substitutions.set(variable, i32Type);
      }
    }
    const normalizedBindings = bindings.map((binding) => ({
      ...binding,
      value: this.#normalizeExpression(binding.value),
      type: this.#apply(binding.type),
    }));
    const normalizedResult = this.#normalizeExpression(result.expression);
    return {
      file: this.#file,
      bindings: normalizedBindings,
      result: normalizedResult,
      resultType: this.#apply(result.type),
      equalities: this.#equalities,
      symbolTypes: new Map(
        [...this.#symbolTypes].map(([id, type]) => [id, this.#apply(type)]),
      ),
    };
  }

  #normalizeExpression(
    expression: TypedDucklangExpression,
  ): TypedDucklangExpression {
    const type = this.#apply(expression.type);
    switch (expression.kind) {
      case "integer":
      case "integer64":
      case "boolean":
      case "string":
      case "intrinsic":
      case "reference":
        return { ...expression, type };
      case "function":
        return {
          ...expression,
          body: this.#normalizeExpression(expression.body),
          type,
        };
      case "call":
        return {
          ...expression,
          callee: this.#normalizeExpression(expression.callee),
          arguments: expression.arguments.map((argument) =>
            this.#normalizeExpression(argument)
          ),
          type,
        };
      case "binary":
        return {
          ...expression,
          left: this.#normalizeExpression(expression.left),
          right: this.#normalizeExpression(expression.right),
          type,
        };
      case "return":
        return {
          ...expression,
          expression: this.#normalizeExpression(expression.expression),
          type,
        };
      case "if":
        return {
          ...expression,
          condition: this.#normalizeExpression(expression.condition),
          consequence: this.#normalizeExpression(expression.consequence),
          alternative: this.#normalizeExpression(expression.alternative),
          type,
        };
      case "block":
        return {
          ...expression,
          steps: expression.steps.map((step): TypedDucklangBlockStep =>
            step.kind === "expression"
              ? {
                kind: "expression",
                expression: this.#normalizeExpression(step.expression),
              }
              : {
                kind: "binding",
                binding: {
                  ...step.binding,
                  value: this.#normalizeExpression(step.binding.value),
                  type: this.#apply(step.binding.type),
                },
              }
          ),
          result: this.#normalizeExpression(expression.result),
          type,
        };
      case "comptime":
        return {
          ...expression,
          expression: this.#normalizeExpression(expression.expression),
          type,
        };
    }
  }

  #freshVariable(): Type {
    const type: Type = { kind: "variable", id: this.#nextVariable };
    this.#nextVariable += 1;
    return type;
  }

  #unifyReturnTypes(expression: TypedDucklangExpression, result: Type): void {
    switch (expression.kind) {
      case "return":
        this.#unify(expression.type, result, expression.span);
        return;
      case "function":
      case "integer":
      case "integer64":
      case "boolean":
      case "reference":
        return;
      case "call":
        this.#unifyReturnTypes(expression.callee, result);
        for (const argument of expression.arguments) {
          this.#unifyReturnTypes(argument, result);
        }
        return;
      case "binary":
        this.#unifyReturnTypes(expression.left, result);
        this.#unifyReturnTypes(expression.right, result);
        return;
      case "if":
        this.#unifyReturnTypes(expression.condition, result);
        this.#unifyReturnTypes(expression.consequence, result);
        this.#unifyReturnTypes(expression.alternative, result);
        return;
      case "block":
        for (const step of expression.steps) {
          this.#unifyReturnTypes(
            step.kind === "binding" ? step.binding.value : step.expression,
            result,
          );
        }
        this.#unifyReturnTypes(expression.result, result);
        return;
      case "comptime":
        this.#unifyReturnTypes(expression.expression, result);
        return;
    }
  }

  #unify(leftInput: Type, rightInput: Type, span: SourceSpan): void {
    this.#equalities.push({ left: leftInput, right: rightInput, span });
    const left = this.#apply(leftInput);
    const right = this.#apply(rightInput);
    if (left.kind === "variable") {
      if (right.kind === "variable" && left.id === right.id) return;
      if (this.#occurs(left.id, right)) {
        throw new TypeError(
          `${this.#file}:${span.start}: Ducklang type t${left.id} occurs in ${
            formatDucklangType(right)
          }`,
        );
      }
      this.#substitutions.set(left.id, right);
      return;
    }
    if (right.kind === "variable") {
      this.#unify(right, left, span);
      return;
    }
    if (left.kind === "function" && right.kind === "function") {
      this.#unify(left.parameter, right.parameter, span);
      this.#unify(left.result, right.result, span);
      return;
    }
    if (
      left.kind === "constructor" && right.kind === "constructor" &&
      left.name === right.name &&
      left.arguments.length === right.arguments.length
    ) {
      for (let index = 0; index < left.arguments.length; index += 1) {
        this.#unify(left.arguments[index], right.arguments[index], span);
      }
      return;
    }
    throw new TypeError(
      `${this.#file}:${span.start}: cannot unify Ducklang ${
        formatDucklangType(left)
      } with ${formatDucklangType(right)}`,
    );
  }

  #apply(type: Type): Type {
    if (type.kind === "variable") {
      const substitution = this.#substitutions.get(type.id);
      if (substitution === undefined) return type;
      const applied = this.#apply(substitution);
      this.#substitutions.set(type.id, applied);
      return applied;
    }
    if (type.kind === "function") {
      return {
        kind: "function",
        parameter: this.#apply(type.parameter),
        result: this.#apply(type.result),
      };
    }
    return {
      ...type,
      arguments: type.arguments.map((argument) => this.#apply(argument)),
    };
  }

  #occurs(variable: number, type: Type): boolean {
    const applied = this.#apply(type);
    if (applied.kind === "variable") return applied.id === variable;
    if (applied.kind === "function") {
      return this.#occurs(variable, applied.parameter) ||
        this.#occurs(variable, applied.result);
    }
    return applied.arguments.some((argument) =>
      this.#occurs(variable, argument)
    );
  }
}

function declaredDucklangType(name: "I32" | "I64" | "Bool"): Type {
  if (name === "I32") return i32Type;
  if (name === "I64") return i64Type;
  return booleanType;
}

function functionType(parameters: readonly Type[], result: Type): Type {
  return parameters.toReversed().reduce<Type>(
    (returnType, parameter) => ({
      kind: "function",
      parameter,
      result: returnType,
    }),
    result,
  );
}

function isIntegerType(
  type: Type,
): type is Extract<Type, { readonly kind: "constructor" }> {
  return type.kind === "constructor" &&
    (type.name === "i32" || type.name === "i64") &&
    type.arguments.length === 0;
}

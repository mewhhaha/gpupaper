import { PrimitiveId } from "./ducklang_primitives.ts";
import type { DucklangSymbol } from "./ducklang_resolution.ts";
import type { TypedDucklangExpression } from "./ducklang_types.ts";
import type { Type } from "./types.ts";

declare const typeIdBrand: unique symbol;

export type TypeId = string & { readonly [typeIdBrand]: true };

export type DucklangConstScalar =
  | { readonly kind: "i32"; readonly value: number }
  | { readonly kind: "i64"; readonly value: bigint }
  | { readonly kind: "f32"; readonly value: number }
  | { readonly kind: "f64"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "unit" };

export type DucklangConstProduct = {
  readonly kind: "product";
  readonly fields: readonly {
    readonly name: string | undefined;
    readonly value: DucklangConstValue;
  }[];
};

export type DucklangConstCode =
  | {
    readonly kind: "source";
    readonly parameters: readonly DucklangSymbol[];
    readonly body: TypedDucklangExpression;
  }
  | {
    readonly kind: "primitive";
    readonly primitiveId: PrimitiveId;
  };

export type DucklangConstEnvironment = {
  readonly parent: DucklangConstEnvironment | undefined;
  readonly bindings: readonly {
    readonly symbol: string;
    readonly value: DucklangConstValue;
  }[];
};

export type DucklangConstValue =
  | { readonly kind: "scalar"; readonly scalar: DucklangConstScalar }
  | { readonly kind: "type"; readonly typeId: TypeId }
  | DucklangConstProduct
  | {
    readonly kind: "sum";
    readonly unionName: string;
    readonly caseName: string;
    readonly value: DucklangConstValue;
  }
  | {
    readonly kind: "closure";
    readonly code: DucklangConstCode;
    readonly environment: DucklangConstEnvironment;
  }
  | {
    readonly kind: "module";
    readonly exports: DucklangConstProduct;
  };

/**
 * Nested compile-time calls allowed before evaluation is refused.
 *
 * Each level costs a JavaScript frame, so this has to sit well under the host stack
 * budget for the diagnostic to arrive before a stack overflow does.
 */
const maximumConstCallDepth = 2_000;

export const emptyDucklangConstEnvironment: DucklangConstEnvironment = {
  parent: undefined,
  bindings: [],
};

export function canonicalDucklangTypeId(type: Type): TypeId {
  switch (type.kind) {
    case "variable":
      throw new TypeError(
        `cannot canonicalize unresolved Ducklang type variable t${type.id}`,
      );
    case "constructor":
      return `${
        JSON.stringify([
          "constructor",
          type.name,
          type.arguments.map(canonicalDucklangTypeId),
        ])
      }` as TypeId;
    case "function":
      return `${
        JSON.stringify([
          "function",
          canonicalDucklangTypeId(type.parameter),
          canonicalDucklangTypeId(type.result),
        ])
      }` as TypeId;
  }
}

/**
 * Builds an environment whose closures can see the environment itself.
 *
 * A recursive compile-time function has to find its own binding while evaluating its
 * body, which `extendDucklangConstEnvironment` cannot express because it maps its
 * bindings before the environment exists. This ties the knot: the environment is
 * created first and each closure is given it, so a self-reference resolves.
 */
export function recursiveDucklangConstEnvironment(
  bindings: readonly {
    readonly symbol: DucklangSymbol;
    readonly code: DucklangConstCode;
  }[],
): DucklangConstEnvironment {
  const entries: {
    readonly symbol: string;
    readonly value: DucklangConstValue;
  }[] = [];
  const environment: DucklangConstEnvironment = {
    parent: undefined,
    bindings: entries,
  };
  for (const binding of bindings) {
    entries.push({
      symbol: qualifiedSymbol(binding.symbol),
      value: { kind: "closure", code: binding.code, environment },
    });
  }
  return environment;
}

export function extendDucklangConstEnvironment(
  environment: DucklangConstEnvironment,
  bindings: readonly {
    readonly symbol: DucklangSymbol;
    readonly value: DucklangConstValue;
  }[],
): DucklangConstEnvironment {
  return {
    parent: environment,
    bindings: bindings.map((binding) => ({
      symbol: qualifiedSymbol(binding.symbol),
      value: binding.value,
    })),
  };
}

export function projectDucklangConst(
  value: DucklangConstValue,
  field: number | string,
): DucklangConstValue {
  const product = value.kind === "module"
    ? value.exports
    : value.kind === "product"
    ? value
    : undefined;
  if (product === undefined) {
    throw new TypeError(`cannot project ${value.kind} compile-time value`);
  }
  const selected = typeof field === "number"
    ? product.fields[field]
    : product.fields.find((candidate) => candidate.name === field);
  if (selected === undefined) {
    throw new RangeError(
      `compile-time ${value.kind} has no field ${JSON.stringify(field)}`,
    );
  }
  return selected.value;
}

export function extendDucklangConstProduct(
  base: DucklangConstProduct,
  extension: DucklangConstProduct,
): DucklangConstProduct {
  const fields = [...base.fields];
  for (const field of extension.fields) {
    if (field.name === undefined) {
      fields.push(field);
      continue;
    }
    const index = fields.findIndex((candidate) =>
      candidate.name === field.name
    );
    if (index < 0) fields.push(field);
    else fields[index] = field;
  }
  return { kind: "product", fields };
}

export function evaluateDucklangConst(
  expression: TypedDucklangExpression,
  options: {
    readonly fuel: number;
    readonly environment?: DucklangConstEnvironment;
  },
): DucklangConstValue {
  if (!Number.isSafeInteger(options.fuel) || options.fuel <= 0) {
    throw new RangeError(
      `Ducklang compile-time fuel must be a positive safe integer; received ${options.fuel}`,
    );
  }
  return new DucklangConstEvaluator(options.fuel).evaluate(
    expression,
    options.environment ?? emptyDucklangConstEnvironment,
  );
}

class DucklangConstEvaluator {
  #remainingFuel: number;
  #callDepth = 0;

  constructor(fuel: number) {
    this.#remainingFuel = fuel;
  }

  evaluate(
    expression: TypedDucklangExpression,
    environment: DucklangConstEnvironment,
  ): DucklangConstValue {
    this.#consumeFuel(expression);
    switch (expression.kind) {
      case "integer":
        return scalar({ kind: "i32", value: expression.value });
      case "integer64":
        return scalar({ kind: "i64", value: expression.value });
      case "float32":
        return scalar({ kind: "f32", value: expression.value });
      case "float64":
        return scalar({ kind: "f64", value: expression.value });
      case "boolean":
        return scalar({ kind: "bool", value: expression.value });
      case "unit":
        return scalar({ kind: "unit" });
      case "string":
        return scalar({ kind: "text", value: expression.value });
      case "intrinsic":
        if (!expression.modulePath.startsWith("duck:type/")) {
          throw this.#unsupported(expression, "intrinsic");
        }
        return {
          kind: "type",
          typeId: `${expression.modulePath}:${expression.exportName}` as TypeId,
        };
      case "primitive":
        return {
          kind: "closure",
          code: {
            kind: "primitive",
            primitiveId: expression.primitiveId,
          },
          environment: emptyDucklangConstEnvironment,
        };
      case "reference":
        return lookupConstEnvironment(environment, expression.symbol);
      case "function":
        return {
          kind: "closure",
          code: {
            kind: "source",
            parameters: expression.parameters,
            body: expression.body,
          },
          environment,
        };
      case "call":
        return this.#call(expression, environment);
      case "product":
        return {
          kind: "product",
          fields: expression.values.map((value) => ({
            name: undefined,
            value: this.evaluate(value, environment),
          })),
        };
      case "unionCase":
        return {
          kind: "sum",
          unionName: expression.unionName,
          caseName: expression.caseName,
          value: this.evaluate(expression.value, environment),
        };
      case "project":
        return projectDucklangConst(
          this.evaluate(expression.product, environment),
          expression.index,
        );
      case "recordUpdate": {
        const product = this.evaluate(expression.product, environment);
        if (product.kind !== "product") {
          throw this.#unsupported(expression, "record update");
        }
        const fields = [...product.fields];
        for (const field of expression.fields) {
          fields[field.index] = {
            name: fields[field.index]?.name ?? field.name,
            value: this.evaluate(field.value, environment),
          };
        }
        return { kind: "product", fields };
      }
      case "index":
        return this.#index(expression, environment);
      case "selectProductElement": {
        const index = expectI32(this.evaluate(expression.index, environment));
        const selected = expression.values[index];
        if (selected === undefined) {
          throw new RangeError(
            `${
              source(expression)
            }: compile-time product index ${index} is outside arity ${expression.values.length}`,
          );
        }
        return this.evaluate(selected, environment);
      }
      case "indexUpdate": {
        const product = this.evaluate(expression.product, environment);
        const index = expectI32(this.evaluate(expression.index, environment));
        if (product.kind !== "product" || product.fields[index] === undefined) {
          throw new RangeError(
            `${
              source(expression)
            }: compile-time product update index ${index} is outside its fields`,
          );
        }
        const fields = [...product.fields];
        fields[index] = {
          ...fields[index],
          value: this.evaluate(expression.value, environment),
        };
        return { kind: "product", fields };
      }
      case "textAppend": {
        const left = expectText(this.evaluate(expression.left, environment));
        const right = expectText(this.evaluate(expression.right, environment));
        return scalar({ kind: "text", value: left + right });
      }
      case "binary":
        return this.#binary(expression, environment);
      case "if": {
        const condition = this.evaluate(expression.condition, environment);
        return this.evaluate(
          truthy(condition) ? expression.consequence : expression.alternative,
          environment,
        );
      }
      case "ifUnion": {
        const value = this.evaluate(expression.value, environment);
        const matches = value.kind === "sum" &&
          value.unionName === expression.unionName &&
          value.caseName === expression.caseName;
        if (!matches) {
          return this.evaluate(expression.alternative, environment);
        }
        const consequenceEnvironment = expression.payloadSymbol === undefined
          ? environment
          : extendDucklangConstEnvironment(environment, [{
            symbol: expression.payloadSymbol,
            value: value.value,
          }]);
        return this.evaluate(
          expression.consequence,
          consequenceEnvironment,
        );
      }
      case "block": {
        let blockEnvironment = environment;
        for (const step of expression.steps) {
          if (step.kind === "expression") {
            this.evaluate(step.expression, blockEnvironment);
            continue;
          }
          const value = this.evaluate(step.binding.value, blockEnvironment);
          blockEnvironment = extendDucklangConstEnvironment(
            blockEnvironment,
            [{ symbol: step.binding.symbol, value }],
          );
        }
        return this.evaluate(expression.result, blockEnvironment);
      }
      case "comptime":
        return this.evaluate(expression.expression, environment);
      case "ownership":
        return this.evaluate(expression.expression, environment);
      case "scratch":
        return this.evaluate(expression.body, environment);
      case "return":
        return this.evaluate(expression.expression, environment);
      case "optionDo": {
        const option = this.evaluate(expression.option, environment);
        if (option.kind !== "sum" || option.caseName !== "Some") {
          throw new TypeError(
            `${source(expression)}: compile-time do expected Some`,
          );
        }
        return option.value;
      }
      case "hostCall":
        throw this.#unsupported(expression, "host call");
    }
  }

  #call(
    expression: Extract<TypedDucklangExpression, { readonly kind: "call" }>,
    environment: DucklangConstEnvironment,
  ): DucklangConstValue {
    // Fuel alone does not bound recursion depth: a self-call nests a JavaScript
    // frame per level, so unbounded recursion exhausted the host stack and reported
    // "Maximum call stack size exceeded" with no source location, long before a
    // million units of fuel ran out.
    if (this.#callDepth >= maximumConstCallDepth) {
      throw new RangeError(
        `${
          source(expression)
        }: Ducklang compile-time evaluation exceeded ${maximumConstCallDepth} nested calls`,
      );
    }
    const callee = this.evaluate(expression.callee, environment);
    if (callee.kind !== "closure") {
      throw new TypeError(
        `${
          source(expression)
        }: compile-time call requires a closure; received ${callee.kind}`,
      );
    }
    const arguments_ = expression.arguments.map((argument) =>
      this.evaluate(argument, environment)
    );
    if (callee.code.kind === "primitive") {
      return this.#primitive(
        callee.code.primitiveId,
        arguments_,
        expression,
      );
    }
    if (callee.code.parameters.length !== arguments_.length) {
      throw new TypeError(
        `${
          source(expression)
        }: compile-time closure expects ${callee.code.parameters.length} arguments; received ${arguments_.length}`,
      );
    }
    this.#callDepth += 1;
    try {
      return this.evaluate(
        callee.code.body,
        extendDucklangConstEnvironment(
          callee.environment,
          callee.code.parameters.map((symbol, index) => ({
            symbol,
            value: arguments_[index],
          })),
        ),
      );
    } finally {
      this.#callDepth -= 1;
    }
  }

  #primitive(
    primitiveId: PrimitiveId,
    arguments_: readonly DucklangConstValue[],
    expression: TypedDucklangExpression,
  ): DucklangConstValue {
    switch (primitiveId) {
      case PrimitiveId.bufferLength: {
        const value = arguments_[0];
        const length = value?.kind === "scalar" &&
            value.scalar.kind === "text"
          ? new TextEncoder().encode(value.scalar.value).length
          : value?.kind === "scalar" && value.scalar.kind === "bytes"
          ? value.scalar.value.length
          : undefined;
        if (length === undefined) break;
        return scalar({ kind: "i32", value: length });
      }
      case PrimitiveId.bufferGet: {
        const value = arguments_[0];
        const index = expectI32(arguments_[1]);
        const bytes = value?.kind === "scalar" &&
            value.scalar.kind === "text"
          ? new TextEncoder().encode(value.scalar.value)
          : value?.kind === "scalar" && value.scalar.kind === "bytes"
          ? value.scalar.value
          : undefined;
        const selected = bytes?.[index];
        if (selected === undefined) {
          throw new RangeError(
            `${
              source(expression)
            }: compile-time buffer index ${index} is outside its length`,
          );
        }
        return scalar({ kind: "i32", value: selected });
      }
      case PrimitiveId.bufferAppend: {
        const left = arguments_[0];
        const right = arguments_[1];
        if (
          left?.kind === "scalar" && left.scalar.kind === "text" &&
          right?.kind === "scalar" && right.scalar.kind === "text"
        ) {
          return scalar({
            kind: "text",
            value: left.scalar.value + right.scalar.value,
          });
        }
        if (
          left?.kind === "scalar" && left.scalar.kind === "bytes" &&
          right?.kind === "scalar" && right.scalar.kind === "bytes"
        ) {
          const value = new Uint8Array(
            left.scalar.value.length + right.scalar.value.length,
          );
          value.set(left.scalar.value);
          value.set(right.scalar.value, left.scalar.value.length);
          return scalar({ kind: "bytes", value });
        }
        break;
      }
      case PrimitiveId.utf8Encode:
        return scalar({
          kind: "bytes",
          value: new TextEncoder().encode(expectText(arguments_[0])),
        });
      case PrimitiveId.utf8Decode: {
        const bytes = expectBytes(arguments_[0]);
        try {
          return scalar({
            kind: "text",
            value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        } catch (cause) {
          throw new TypeError(
            `${
              source(expression)
            }: compile-time UTF-8 decode received invalid bytes`,
            { cause },
          );
        }
      }
      case PrimitiveId.panic:
        throw new Error(
          `${source(expression)}: Ducklang compile-time panic: ${
            expectText(arguments_[0])
          }`,
        );
    }
    throw new TypeError(
      `${
        source(expression)
      }: primitive ${primitiveId} is not available to compile-time evaluation`,
    );
  }

  #index(
    expression: Extract<TypedDucklangExpression, { readonly kind: "index" }>,
    environment: DucklangConstEnvironment,
  ): DucklangConstValue {
    const collection = this.evaluate(expression.collection, environment);
    const index = expectI32(this.evaluate(expression.index, environment));
    if (collection.kind === "product") {
      return projectDucklangConst(collection, index);
    }
    if (collection.kind === "scalar" && collection.scalar.kind === "text") {
      const selected = new TextEncoder().encode(collection.scalar.value)[index];
      if (selected !== undefined) {
        return scalar({ kind: "i32", value: selected });
      }
    }
    if (collection.kind === "scalar" && collection.scalar.kind === "bytes") {
      const selected = collection.scalar.value[index];
      if (selected !== undefined) {
        return scalar({ kind: "i32", value: selected });
      }
    }
    throw new RangeError(
      `${
        source(expression)
      }: compile-time index ${index} is outside ${collection.kind}`,
    );
  }

  #binary(
    expression: Extract<TypedDucklangExpression, { readonly kind: "binary" }>,
    environment: DucklangConstEnvironment,
  ): DucklangConstValue {
    const left = this.evaluate(expression.left, environment);
    const right = this.evaluate(expression.right, environment);
    if (expression.operator === "&&" || expression.operator === "||") {
      const value = expression.operator === "&&"
        ? truthy(left) && truthy(right)
        : truthy(left) || truthy(right);
      return scalar({ kind: "bool", value });
    }
    if (expression.operator === "==" || expression.operator === "!=") {
      const value = constEqual(left, right);
      return scalar({
        kind: "bool",
        value: expression.operator === "==" ? value : !value,
      });
    }
    const leftNumber = expectNumber(left);
    const rightNumber = expectNumber(right);
    if (expression.operator === "<") {
      return scalar({ kind: "bool", value: leftNumber < rightNumber });
    }
    if (expression.operator === "<=") {
      return scalar({ kind: "bool", value: leftNumber <= rightNumber });
    }
    if (expression.operator === ">") {
      return scalar({ kind: "bool", value: leftNumber > rightNumber });
    }
    if (expression.operator === ">=") {
      return scalar({ kind: "bool", value: leftNumber >= rightNumber });
    }
    if (typeof leftNumber === "bigint" || typeof rightNumber === "bigint") {
      if (
        typeof leftNumber !== "bigint" || typeof rightNumber !== "bigint"
      ) {
        throw new TypeError(
          `${source(expression)}: compile-time arithmetic mixes integer widths`,
        );
      }
      return scalar({
        kind: "i64",
        value: integerBinary(expression.operator, leftNumber, rightNumber),
      });
    }
    const kind = scalarNumericKind(left);
    return scalar({
      kind,
      value: numberBinary(expression.operator, leftNumber, rightNumber),
    });
  }

  #consumeFuel(expression: TypedDucklangExpression): void {
    this.#remainingFuel -= 1;
    if (this.#remainingFuel >= 0) return;
    throw new RangeError(
      `${
        source(expression)
      }: Ducklang compile-time evaluation exhausted its fuel`,
    );
  }

  #unsupported(
    expression: TypedDucklangExpression,
    operation: string,
  ): TypeError {
    return new TypeError(
      `${
        source(expression)
      }: Ducklang compile-time evaluation does not support ${operation}`,
    );
  }
}

function lookupConstEnvironment(
  environment: DucklangConstEnvironment,
  symbol: DucklangSymbol,
): DucklangConstValue {
  const identity = qualifiedSymbol(symbol);
  let current: DucklangConstEnvironment | undefined = environment;
  while (current !== undefined) {
    const binding = current.bindings.find((candidate) =>
      candidate.symbol === identity
    );
    if (binding !== undefined) return binding.value;
    current = current.parent;
  }
  throw new ReferenceError(
    `${symbol.span.file}:${symbol.span.start}: missing compile-time value for ${symbol.text}#${symbol.id}`,
  );
}

function qualifiedSymbol(symbol: DucklangSymbol): string {
  return `${symbol.moduleId}\0${symbol.id}`;
}

function scalar(value: DucklangConstScalar): DucklangConstValue {
  return { kind: "scalar", scalar: value };
}

function expectI32(value: DucklangConstValue | undefined): number {
  if (value?.kind === "scalar" && value.scalar.kind === "i32") {
    return value.scalar.value;
  }
  throw new TypeError(`expected compile-time I32, received ${value?.kind}`);
}

function expectText(value: DucklangConstValue | undefined): string {
  if (value?.kind === "scalar" && value.scalar.kind === "text") {
    return value.scalar.value;
  }
  throw new TypeError(`expected compile-time Text, received ${value?.kind}`);
}

function expectBytes(value: DucklangConstValue | undefined): Uint8Array {
  if (value?.kind === "scalar" && value.scalar.kind === "bytes") {
    return value.scalar.value;
  }
  throw new TypeError(`expected compile-time Bytes, received ${value?.kind}`);
}

function expectNumber(value: DucklangConstValue): number | bigint {
  if (
    value.kind === "scalar" &&
    (value.scalar.kind === "i32" || value.scalar.kind === "i64" ||
      value.scalar.kind === "f32" || value.scalar.kind === "f64")
  ) {
    return value.scalar.value;
  }
  throw new TypeError(`expected compile-time number, received ${value.kind}`);
}

function scalarNumericKind(
  value: DucklangConstValue,
): "i32" | "f32" | "f64" {
  if (
    value.kind === "scalar" &&
    (value.scalar.kind === "i32" || value.scalar.kind === "f32" ||
      value.scalar.kind === "f64")
  ) {
    return value.scalar.kind;
  }
  throw new TypeError(`expected compile-time scalar number`);
}

function truthy(value: DucklangConstValue): boolean {
  if (value.kind !== "scalar") {
    throw new TypeError(
      `compile-time condition requires Bool or I32; received ${value.kind}`,
    );
  }
  if (value.scalar.kind === "bool") return value.scalar.value;
  if (value.scalar.kind === "i32") return value.scalar.value !== 0;
  throw new TypeError(
    `compile-time condition requires Bool or I32; received ${value.scalar.kind}`,
  );
}

function constEqual(
  left: DucklangConstValue,
  right: DucklangConstValue,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "scalar" && right.kind === "scalar") {
    if (left.scalar.kind !== right.scalar.kind) return false;
    if (left.scalar.kind === "bytes") {
      if (right.scalar.kind !== "bytes") return false;
      const rightBytes = right.scalar.value;
      return left.scalar.value.length === right.scalar.value.length &&
        left.scalar.value.every((byte, index) => byte === rightBytes[index]);
    }
    return "value" in left.scalar && "value" in right.scalar
      ? left.scalar.value === right.scalar.value
      : true;
  }
  if (left.kind === "type" && right.kind === "type") {
    return left.typeId === right.typeId;
  }
  if (left.kind === "sum" && right.kind === "sum") {
    return left.unionName === right.unionName &&
      left.caseName === right.caseName &&
      constEqual(left.value, right.value);
  }
  if (left.kind === "product" && right.kind === "product") {
    return left.fields.length === right.fields.length &&
      left.fields.every((field, index) => {
        const candidate = right.fields[index];
        return candidate !== undefined && field.name === candidate.name &&
          constEqual(field.value, candidate.value);
      });
  }
  return left === right;
}

function integerBinary(
  operator: string,
  left: bigint,
  right: bigint,
): bigint {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
    default:
      throw new TypeError(
        `unsupported compile-time integer operator ${operator}`,
      );
  }
}

function numberBinary(
  operator: string,
  left: number,
  right: number,
): number {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
    default:
      throw new TypeError(
        `unsupported compile-time numeric operator ${operator}`,
      );
  }
}

function source(expression: TypedDucklangExpression): string {
  return `${expression.span.file}:${expression.span.start}`;
}

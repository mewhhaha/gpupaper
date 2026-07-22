import type { SourceSpan } from "./syntax.ts";
import type { DucklangTypeReference } from "./ducklang_ast.ts";
import type { EqualityConstraint, Type } from "./types.ts";
import type {
  DucklangSymbol,
  ResolvedDucklangBinding,
  ResolvedDucklangExpression,
  ResolvedDucklangModule,
  ResolvedDucklangStructType,
  ResolvedDucklangTypeAlias,
  ResolvedDucklangUnionType,
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
    readonly kind: "unit";
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
    readonly kind: "hostCall";
    readonly effectName: string;
    readonly operationName: string;
    readonly arguments: readonly TypedDucklangExpression[];
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "optionDo";
    readonly option: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionCase";
    readonly unionName: string;
    readonly caseName: string;
    readonly value: TypedDucklangExpression;
    readonly nominalType?: string;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "product";
    readonly productKind: "tuple" | "array";
    readonly values: readonly TypedDucklangExpression[];
    readonly nominalType?: string;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "project";
    readonly product: TypedDucklangExpression;
    readonly index: number;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "recordUpdate";
    readonly product: TypedDucklangExpression;
    readonly fields: readonly {
      readonly name: string;
      readonly value: TypedDucklangExpression;
      readonly index: number;
      readonly span: SourceSpan;
    }[];
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
    readonly kind: "index";
    readonly collection: TypedDucklangExpression;
    readonly index: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "selectProductElement";
    readonly values: readonly TypedDucklangExpression[];
    readonly index: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "indexUpdate";
    readonly product: TypedDucklangExpression;
    readonly index: TypedDucklangExpression;
    readonly value: TypedDucklangExpression;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "textAppend";
    readonly left: TypedDucklangExpression;
    readonly right: TypedDucklangExpression;
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
    readonly kind: "ownership";
    readonly operation: "borrow" | "freeze";
    readonly expression: TypedDucklangExpression;
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
    readonly kind: "ifUnion";
    readonly unionName: string;
    readonly caseName: string;
    readonly payloadSymbol: DucklangSymbol | undefined;
    readonly value: TypedDucklangExpression;
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
  }
  | {
    readonly kind: "scratch";
    readonly body: TypedDucklangExpression;
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
  readonly unionTypes: readonly ResolvedDucklangUnionType[];
  readonly typeAliases: readonly ResolvedDucklangTypeAlias[];
  readonly structTypes: readonly ResolvedDucklangStructType[];
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
const unitType: Type = { kind: "constructor", name: "unit", arguments: [] };
const typeDescriptorType: Type = {
  kind: "constructor",
  name: "typeDescriptor",
  arguments: [],
};
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
  const inference = new DucklangInference(
    module.file,
    module.unionTypes,
    module.typeAliases,
    module.structTypes,
  );
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
  readonly #unionTypes: readonly ResolvedDucklangUnionType[];
  readonly #typeAliases: readonly ResolvedDucklangTypeAlias[];
  readonly #structTypes: readonly ResolvedDucklangStructType[];
  #nextVariable = 0;

  constructor(
    file: string,
    unionTypes: readonly ResolvedDucklangUnionType[],
    typeAliases: readonly ResolvedDucklangTypeAlias[],
    structTypes: readonly ResolvedDucklangStructType[],
  ) {
    this.#file = file;
    this.#unionTypes = unionTypes;
    this.#typeAliases = typeAliases;
    this.#structTypes = structTypes;
    for (const declaration of unionTypes) {
      const caseNames = new Set<string>();
      for (const unionCase of declaration.cases) {
        if (caseNames.has(unionCase.name)) {
          throw new TypeError(
            `${file}:${unionCase.span.start}: duplicate Ducklang constructor ${declaration.name}.${unionCase.name}`,
          );
        }
        caseNames.add(unionCase.name);
      }
    }
    for (const declaration of unionTypes) {
      const parameters = new Map(
        declaration.parameters.map((name) => [name, this.#freshVariable()]),
      );
      for (const unionCase of declaration.cases) {
        this.#typeReference(unionCase.payloadType, parameters, []);
      }
    }
    for (const alias of typeAliases) {
      const parameters = new Map(
        alias.parameters.map((name) => [name, this.#freshVariable()]),
      );
      this.#typeReference(alias.target, parameters, [alias.name]);
    }
    for (const declaration of structTypes) {
      const parameters = new Map(
        declaration.parameters.map((name) => [name, this.#freshVariable()]),
      );
      for (const field of declaration.fields) {
        this.#typeReference(field.type, parameters, []);
      }
    }
  }

  inferBindings(
    bindings: readonly ResolvedDucklangBinding[],
    environment: Map<number, Type>,
  ): readonly TypedDucklangBinding[] {
    const typed: TypedDucklangBinding[] = [];
    for (const binding of bindings) {
      if (!binding.recursive) continue;
      const type = this.#freshVariable();
      environment.set(binding.symbol.id, type);
      this.#symbolTypes.set(binding.symbol.id, type);
    }
    for (const binding of bindings) {
      const recursiveType = binding.recursive
        ? environment.get(binding.symbol.id)
        : undefined;
      if (binding.recursive && recursiveType === undefined) {
        throw new Error(
          `${this.#file}:${binding.span.start}: missing type for recursive Ducklang binding ${binding.symbol.text}#${binding.symbol.id}`,
        );
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
        try {
          this.#unify(previousType, bindingType, binding.span);
        } catch (cause) {
          throw new TypeError(
            `${this.#file}:${binding.span.start}: Assignment changes type for ${binding.symbol.text} from ${
              sourceTypeName(this.#apply(previousType))
            } to ${sourceTypeName(this.#apply(bindingType))}`,
            { cause },
          );
        }
      }
      if (binding.symbol.declaredType !== undefined) {
        this.#unify(
          this.#declaredType(binding.symbol.declaredType, binding.symbol.span),
          bindingType,
          binding.span,
        );
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
      case "unit":
        return {
          expression: { ...expression, type: unitType },
          type: unitType,
        };
      case "string":
        return {
          expression: { ...expression, type: textType },
          type: textType,
        };
      case "intrinsic": {
        let type: Type;
        if (expression.modulePath.startsWith("duck:type/")) {
          type = typeDescriptorType;
        } else if (
          expression.modulePath === "duck:compiler/string-pattern" &&
          expression.exportName === "matches"
        ) {
          type = functionType(
            [textType, textType, textType],
            booleanType,
          );
        } else if (
          expression.modulePath === "duck:compiler/string-pattern" &&
          expression.exportName === "capture"
        ) {
          type = functionType([textType, textType, textType], textType);
        } else if (
          expression.modulePath === "duck:compiler/type-pattern" &&
          expression.exportName === "matches"
        ) {
          type = functionType([typeDescriptorType, textType], booleanType);
        } else if (
          expression.modulePath === "duck:compiler/reflection" &&
          expression.exportName === "length"
        ) {
          type = functionType([textType], i32Type);
        } else if (
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
          expression.modulePath === "duck:prelude/runtime" &&
          expression.exportName === "get"
        ) {
          type = functionType([textType, i32Type], i32Type);
        } else if (
          expression.modulePath === "duck:prelude/runtime" &&
          expression.exportName === "panic"
        ) {
          type = functionType([textType], i32Type);
        } else if (
          expression.modulePath === "duck:prelude/functional" &&
          expression.exportName === "option_unwrap_or"
        ) {
          const value = this.#freshVariable();
          type = functionType([value, {
            kind: "constructor",
            name: "Option",
            arguments: [value],
          }], value);
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
        } else if (
          expression.modulePath === "duck:prelude/functional" &&
          expression.exportName === "identity"
        ) {
          const value = this.#freshVariable();
          type = functionType([value], value);
        } else if (
          expression.modulePath === "duck:prelude/abstractions" &&
          (expression.exportName === "patch" ||
            expression.exportName === "predicate")
        ) {
          const value = this.#freshVariable();
          const result = expression.exportName === "patch"
            ? value
            : booleanType;
          const abstraction = functionType([value], result);
          type = functionType([abstraction], abstraction);
        } else if (
          expression.modulePath === "duck:prelude/abstractions" &&
          (expression.exportName === "patch_apply" ||
            expression.exportName === "predicate_test")
        ) {
          const value = this.#freshVariable();
          const result = expression.exportName === "patch_apply"
            ? value
            : booleanType;
          type = functionType([functionType([value], result), value], result);
        } else if (
          expression.modulePath === "duck:prelude/abstractions" &&
          expression.exportName === "patch_compose"
        ) {
          const value = this.#freshVariable();
          const patch = functionType([value], value);
          type = functionType([patch, patch], patch);
        } else if (
          expression.modulePath === "duck:prelude/abstractions" &&
          expression.exportName === "predicate_and"
        ) {
          const value = this.#freshVariable();
          const predicate = functionType([value], booleanType);
          type = functionType([predicate, predicate], predicate);
        } else if (
          expression.modulePath === "duck:prelude/abstractions" &&
          expression.exportName === "span"
        ) {
          type = functionType([i32Type, i32Type], {
            kind: "constructor",
            name: "tuple",
            arguments: [i32Type, i32Type],
          });
        } else if (
          expression.modulePath === "duck:prelude/abstractions" &&
          expression.exportName === "span_contains"
        ) {
          type = functionType([{
            kind: "constructor",
            name: "tuple",
            arguments: [i32Type, i32Type],
          }, i32Type], booleanType);
        } else if (
          expression.modulePath.startsWith("duck:struct/") &&
          expression.exportName === "new"
        ) {
          const name = expression.modulePath.slice("duck:struct/".length);
          const declaration = this.#structTypes.find((candidate) =>
            candidate.name === name
          );
          if (declaration === undefined) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: unknown Ducklang struct constructor ${name}.new`,
            );
          }
          const structType: Type = {
            kind: "constructor",
            name,
            arguments: [],
          };
          type = functionType([structType], structType);
        } else if (
          expression.modulePath === "duck:prelude" &&
          (expression.exportName === "struct" ||
            expression.exportName === "packed" ||
            expression.exportName === "cast" ||
            expression.exportName === "newtype" ||
            expression.exportName === "representation" ||
            expression.exportName === "seal")
        ) {
          type = unitType;
        } else {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang import ${expression.modulePath} does not provide a typed intrinsic ${expression.exportName}`,
          );
        }
        return { expression: { ...expression, type }, type };
      }
      case "hostCall": {
        const arguments_ = expression.arguments.map((argument) =>
          this.inferExpression(argument, environment)
        );
        for (const [index, argument] of arguments_.entries()) {
          const declared = this.#typeReference(
            expression.operation.parameterTypes[index],
            new Map(),
            [],
          );
          this.#unify(declared, argument.type, argument.expression.span);
        }
        const type = this.#typeReference(
          expression.operation.resultType,
          new Map(),
          [],
        );
        return {
          expression: {
            kind: "hostCall",
            effectName: expression.effectName,
            operationName: expression.operationName,
            arguments: arguments_.map((argument) => argument.expression),
            type,
            span: expression.span,
          },
          type,
        };
      }
      case "optionDo": {
        const option = this.inferExpression(expression.option, environment);
        const some = this.#unionCaseType("Some", expression.span);
        this.#unify(option.type, some.union, expression.option.span);
        return {
          expression: {
            ...expression,
            option: option.expression,
            type: some.payload,
          },
          type: some.payload,
        };
      }
      case "unionCase": {
        const unionCase = this.#unionCaseType(
          expression.caseName,
          expression.span,
          expression.nominalType,
        );
        const value = this.inferExpression(expression.value, environment);
        try {
          this.#unify(value.type, unionCase.payload, expression.value.span);
        } catch (cause) {
          throw new TypeError(
            `${this.#file}:${expression.value.span.start}: Ducklang union case ${expression.caseName} expects ${
              sourceTypeName(this.#apply(unionCase.payload))
            }, got ${sourceTypeName(this.#apply(value.type))}`,
            { cause },
          );
        }
        return {
          expression: {
            ...expression,
            unionName: unionCase.unionName,
            value: value.expression,
            type: unionCase.union,
          },
          type: unionCase.union,
        };
      }
      case "product": {
        const values = expression.values.map((value) =>
          this.inferExpression(value, environment)
        );
        let type: Type;
        if (expression.nominalType !== undefined) {
          const nominalType = this.#declaredType(
            expression.nominalType,
            expression.span,
          );
          const declaration = this.#structDeclaration(
            nominalType,
            expression.span,
          );
          if (declaration.fields.length !== values.length) {
            const missing = declaration.fields[values.length];
            if (missing !== undefined) {
              throw new TypeError(
                `${this.#file}:${expression.span.start}: Missing struct field: ${missing.name}`,
              );
            }
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang struct ${declaration.name} expects ${declaration.fields.length} fields; received ${values.length}`,
            );
          }
          for (const [index, field] of declaration.fields.entries()) {
            this.#unify(
              this.#structFieldType(declaration, nominalType, field.type),
              values[index].type,
              values[index].expression.span,
            );
          }
          type = nominalType;
        } else if (expression.productKind === "tuple") {
          type = {
            kind: "constructor",
            name: "tuple",
            arguments: values.map((value) => value.type),
          };
        } else {
          const elementType = values[0]?.type ?? this.#freshVariable();
          for (const value of values.slice(1)) {
            this.#unify(elementType, value.type, expression.span);
          }
          type = {
            kind: "constructor",
            name: "array",
            arguments: [elementType],
          };
        }
        return {
          expression: {
            ...expression,
            values: values.map((value) => value.expression),
            type,
          },
          type,
        };
      }
      case "field": {
        const product = this.inferExpression(expression.product, environment);
        const productType = this.#apply(product.type);
        if (productType.kind !== "constructor") {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang field ${expression.fieldName} requires a struct; received ${
              formatDucklangType(productType)
            }`,
          );
        }
        const declaration = this.#structTypes.find((candidate) =>
          candidate.name === productType.name
        );
        const index =
          declaration?.fields.findIndex((field) =>
            field.name === expression.fieldName
          ) ?? -1;
        if (declaration === undefined || index < 0) {
          if (
            productType.name.startsWith("$module_") &&
            productType.name.endsWith("_exports")
          ) {
            const moduleName = productType.name.slice(
              "$module_".length,
              -"_exports".length,
            );
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang module ${moduleName} does not export ${expression.fieldName}`,
            );
          }
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang struct ${productType.name} has no field ${expression.fieldName}`,
          );
        }
        const type = this.#structFieldType(
          declaration,
          productType,
          declaration.fields[index].type,
        );
        return {
          expression: {
            kind: "project",
            product: product.expression,
            index,
            type,
            span: expression.span,
          },
          type,
        };
      }
      case "record": {
        const fields = new Map<string, ResolvedDucklangExpression>();
        for (const field of expression.fields) {
          if (fields.has(field.name)) {
            throw new TypeError(
              `${this.#file}:${field.span.start}: duplicate Ducklang record field ${field.name}`,
            );
          }
          fields.set(field.name, field.value);
        }
        const matchingDeclarations = this.#structTypes.filter((declaration) =>
          declaration.fields.length === fields.size &&
          declaration.fields.every((field) => fields.has(field.name))
        );
        let nominalType: Type | undefined;
        const declaration = expression.nominalType === undefined
          ? matchingDeclarations.length === 1
            ? matchingDeclarations[0]
            : undefined
          : (() => {
            const resolvedNominalType = this.#declaredType(
              expression.nominalType,
              expression.span,
            );
            nominalType = resolvedNominalType;
            return resolvedNominalType.kind === "constructor"
              ? this.#structTypes.find((candidate) =>
                candidate.name === resolvedNominalType.name
              )
              : undefined;
          })();
        if (declaration === undefined) {
          const requested = expression.nominalType === undefined
            ? [...fields.keys()].join(", ")
            : expression.nominalType;
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang record ${requested} does not identify exactly one declared struct`,
          );
        }
        const receivedNames = new Set(fields.keys());
        const missing = declaration.fields.filter((field) =>
          !receivedNames.has(field.name)
        );
        const unexpected = expression.fields.filter((field) =>
          !declaration.fields.some((candidate) => candidate.name === field.name)
        );
        if (missing.length > 0 || unexpected.length > 0) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang struct ${declaration.name} record fields are ${
              declaration.fields.map((field) => field.name).join(", ")
            }; received ${
              expression.fields.map((field) => field.name).join(", ")
            }`,
          );
        }
        const structType = nominalType ?? {
          kind: "constructor" as const,
          name: declaration.name,
          arguments: declaration.parameters.map(() => this.#freshVariable()),
        };
        const values = declaration.fields.map((field) => {
          const valueExpression = fields.get(field.name);
          if (valueExpression === undefined) {
            throw new Error(
              `${this.#file}:${expression.span.start}: missing elaborated Ducklang record field ${field.name}`,
            );
          }
          const value = this.inferExpression(valueExpression, environment);
          this.#unify(
            this.#structFieldType(declaration, structType, field.type),
            value.type,
            valueExpression.span,
          );
          return value.expression;
        });
        const type: Type = structType;
        return {
          expression: {
            kind: "product",
            productKind: "tuple",
            values,
            nominalType: declaration.name,
            type,
            span: expression.span,
          },
          type,
        };
      }
      case "recordUpdate": {
        const product = this.inferExpression(expression.product, environment);
        const productType = this.#apply(product.type);
        if (productType.kind !== "constructor") {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang struct update requires a struct; received ${
              formatDucklangType(productType)
            }`,
          );
        }
        const declaration = this.#structTypes.find((candidate) =>
          candidate.name === productType.name
        );
        if (declaration === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang type ${productType.name} does not support field updates`,
          );
        }
        const seen = new Set<string>();
        const fields = expression.fields.map((field) => {
          if (seen.has(field.name)) {
            throw new TypeError(
              `${this.#file}:${field.span.start}: duplicate Ducklang struct update field ${field.name}`,
            );
          }
          seen.add(field.name);
          const index = declaration.fields.findIndex((candidate) =>
            candidate.name === field.name
          );
          if (index < 0) {
            throw new TypeError(
              `${this.#file}:${field.span.start}: Ducklang struct ${declaration.name} has no field ${field.name}`,
            );
          }
          const value = this.inferExpression(field.value, environment);
          this.#unify(
            this.#typeReference(
              declaration.fields[index].type,
              new Map(),
              [],
            ),
            value.type,
            field.span,
          );
          return { ...field, value: value.expression, index };
        });
        return {
          expression: {
            ...expression,
            product: product.expression,
            fields,
            type: productType,
          },
          type: productType,
        };
      }
      case "project": {
        const product = this.inferExpression(expression.product, environment);
        const productType = this.#apply(product.type);
        if (
          productType.kind !== "constructor" ||
          productType.name !== "tuple" ||
          expression.index >= productType.arguments.length
        ) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang product projection ${expression.index} requires a tuple with that element`,
          );
        }
        const type = productType.arguments[expression.index];
        return {
          expression: { ...expression, product: product.expression, type },
          type,
        };
      }
      case "reference": {
        if (expression.symbol.identityPolymorphic) {
          const value = this.#freshVariable();
          const type = functionType([value], value);
          return { expression: { ...expression, type }, type };
        }
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
            : this.#declaredType(parameter.declaredType, parameter.span);
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
      case "index": {
        const collection = this.inferExpression(
          expression.collection,
          environment,
        );
        const index = this.inferExpression(expression.index, environment);
        this.#unify(index.type, i32Type, expression.index.span);
        const collectionType = this.#apply(collection.type);
        let type: Type;
        if (
          collectionType.kind === "constructor" &&
          collectionType.name === "text"
        ) {
          type = i32Type;
        } else if (
          collectionType.kind === "constructor" &&
          collectionType.name === "array" &&
          collectionType.arguments.length === 1
        ) {
          type = collectionType.arguments[0];
        } else if (collectionType.kind === "constructor") {
          const declaration = this.#structTypes.find((candidate) =>
            candidate.name === collectionType.name
          );
          const firstField = declaration?.fields[0];
          if (declaration === undefined || firstField === undefined) {
            throw new TypeError(
              `${this.#file}:${expression.collection.span.start}: Ducklang index requires Text, an array, or a nonempty homogeneous struct; received ${
                formatDucklangType(collectionType)
              }`,
            );
          }
          type = this.#typeReference(firstField.type, new Map(), []);
          for (const field of declaration.fields.slice(1)) {
            this.#unify(
              type,
              this.#typeReference(field.type, new Map(), []),
              field.span,
            );
          }
        } else {
          throw new TypeError(
            `${this.#file}:${expression.collection.span.start}: Ducklang index requires Text, an array, or a nonempty homogeneous struct; received ${
              formatDucklangType(collectionType)
            }`,
          );
        }
        return {
          expression: {
            ...expression,
            collection: collection.expression,
            index: index.expression,
            type,
          },
          type,
        };
      }
      case "indexUpdate": {
        const product = this.inferExpression(expression.product, environment);
        const index = this.inferExpression(expression.index, environment);
        this.#unify(index.type, i32Type, expression.index.span);
        const productType = this.#apply(product.type);
        const declaration = productType.kind === "constructor"
          ? this.#structTypes.find((candidate) =>
            candidate.name === productType.name
          )
          : undefined;
        const firstField = declaration?.fields[0];
        if (declaration === undefined || firstField === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.product.span.start}: Ducklang indexed assignment requires a nonempty homogeneous struct; received ${
              formatDucklangType(productType)
            }`,
          );
        }
        const fieldType = this.#typeReference(firstField.type, new Map(), []);
        for (const field of declaration.fields.slice(1)) {
          this.#unify(
            fieldType,
            this.#typeReference(field.type, new Map(), []),
            field.span,
          );
        }
        const value = this.inferExpression(expression.value, environment);
        this.#unify(fieldType, value.type, expression.value.span);
        return {
          expression: {
            ...expression,
            product: product.expression,
            index: index.expression,
            value: value.expression,
            type: productType,
          },
          type: productType,
        };
      }
      case "binary": {
        if (expression.operator === "<>") {
          const left = this.inferExpression(expression.left, environment);
          const right = this.inferExpression(expression.right, environment);
          this.#unify(left.type, textType, expression.left.span);
          this.#unify(right.type, textType, expression.right.span);
          return {
            expression: {
              kind: "textAppend",
              left: left.expression,
              right: right.expression,
              type: textType,
              span: expression.span,
            },
            type: textType,
          };
        }
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
          const leftType = this.#apply(left.type);
          const rightType = this.#apply(right.type);
          if (
            isIntegerType(leftType) && isIntegerType(rightType) &&
            formatDucklangType(leftType) !== formatDucklangType(rightType)
          ) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Mixed i32 and i64 operands`,
            );
          }
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
        if (expression.operator === "&" || expression.operator === "freeze") {
          return {
            expression: {
              kind: "ownership",
              operation: expression.operator === "&" ? "borrow" : "freeze",
              expression: operand.expression,
              type: operand.type,
              span: expression.span,
            },
            type: operand.type,
          };
        }
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
            `${this.#file}:${expression.condition.span.start}: If condition expects Bool, got ${
              sourceTypeName(conditionType)
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
      case "ifUnion": {
        const value = this.inferExpression(expression.value, environment);
        const candidates = this.#unionCaseCandidates(
          expression.caseName,
          expression.span,
        );
        if (candidates.length === 1) {
          this.#unify(
            value.type,
            candidates[0].union,
            expression.value.span,
          );
        }
        const payloadType = candidates.length === 1
          ? candidates[0].payload
          : this.#freshVariable();
        const consequenceEnvironment = new Map(environment);
        if (expression.payloadSymbol !== undefined) {
          consequenceEnvironment.set(
            expression.payloadSymbol.id,
            payloadType,
          );
          this.#symbolTypes.set(
            expression.payloadSymbol.id,
            payloadType,
          );
        }
        const consequence = this.inferExpression(
          expression.consequence,
          consequenceEnvironment,
        );
        const alternative = expression.alternative === undefined
          ? {
            expression: {
              kind: "integer" as const,
              value: 0,
              type: i32Type,
              span: expression.span,
            },
            type: i32Type,
          }
          : this.inferExpression(expression.alternative, environment);
        const compatibleCandidates = candidates.filter((candidate) =>
          this.#typesCouldMatch(value.type, candidate.union) &&
          this.#typesCouldMatch(payloadType, candidate.payload)
        );
        if (compatibleCandidates.length === 0) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang constructor pattern ${expression.caseName} matches neither scrutinee ${
              formatDucklangType(this.#apply(value.type))
            } nor payload ${formatDucklangType(this.#apply(payloadType))}`,
          );
        }
        if (compatibleCandidates.length > 1) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang constructor pattern ${expression.caseName} is ambiguous among ${
              compatibleCandidates.map((candidate) => candidate.unionName).join(
                ", ",
              )
            }`,
          );
        }
        const unionCase = compatibleCandidates[0];
        this.#unify(value.type, unionCase.union, expression.value.span);
        this.#unify(payloadType, unionCase.payload, expression.span);
        this.#unify(consequence.type, alternative.type, expression.span);
        return {
          expression: {
            ...expression,
            unionName: unionCase.unionName,
            value: value.expression,
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
      case "scratch": {
        const body = this.inferExpression(expression.body, environment);
        return {
          expression: { ...expression, body: body.expression, type: body.type },
          type: body.type,
        };
      }
    }
  }

  #unionCaseType(
    caseName: string,
    span: SourceSpan,
    expectedUnionName?: string,
  ): {
    readonly unionName: string;
    readonly union: Type;
    readonly payload: Type;
  } {
    const candidates = this.#unionCaseCandidates(
      caseName,
      span,
      expectedUnionName,
    );
    if (candidates.length !== 1) {
      throw new TypeError(
        `${this.#file}:${span.start}: Ducklang constructor ${caseName} requires an expected union type; candidates are ${
          candidates.map((candidate) => candidate.unionName).join(", ")
        }`,
      );
    }
    return candidates[0];
  }

  #unionCaseCandidates(
    caseName: string,
    span: SourceSpan,
    expectedUnionName?: string,
  ): readonly {
    readonly unionName: string;
    readonly union: Type;
    readonly payload: Type;
  }[] {
    const expectedDeclarationName = expectedUnionName === undefined
      ? undefined
      : this.#typeAliases.find((alias) => alias.name === expectedUnionName)
        ?.target.name ?? expectedUnionName;
    const declarations = this.#unionTypes.filter((candidate) =>
      (expectedDeclarationName === undefined ||
        candidate.name === expectedDeclarationName) &&
      candidate.cases.some((unionCase) => unionCase.name === caseName)
    );
    if (declarations.length === 0) {
      throw new TypeError(
        `${this.#file}:${span.start}: unknown Ducklang union constructor ${caseName}`,
      );
    }
    return declarations.map((declaration) => {
      const parameters = new Map(
        declaration.parameters.map((name) => [name, this.#freshVariable()]),
      );
      const unionCase = declaration.cases.find((candidate) =>
        candidate.name === caseName
      )!;
      return {
        unionName: declaration.name,
        union: {
          kind: "constructor",
          name: declaration.name,
          arguments: declaration.parameters.map((name) =>
            parameters.get(name)!
          ),
        },
        payload: this.#typeReference(unionCase.payloadType, parameters, []),
      };
    });
  }

  #typesCouldMatch(left: Type, right: Type): boolean {
    const appliedLeft = this.#apply(left);
    const appliedRight = this.#apply(right);
    if (appliedLeft.kind === "variable" || appliedRight.kind === "variable") {
      return true;
    }
    if (appliedLeft.kind !== appliedRight.kind) return false;
    if (appliedLeft.kind === "function" && appliedRight.kind === "function") {
      return this.#typesCouldMatch(
        appliedLeft.parameter,
        appliedRight.parameter,
      ) &&
        this.#typesCouldMatch(appliedLeft.result, appliedRight.result);
    }
    if (
      appliedLeft.kind !== "constructor" ||
      appliedRight.kind !== "constructor" ||
      appliedLeft.name !== appliedRight.name ||
      appliedLeft.arguments.length !== appliedRight.arguments.length
    ) {
      return false;
    }
    return appliedLeft.arguments.every((argument, index) =>
      this.#typesCouldMatch(argument, appliedRight.arguments[index])
    );
  }

  #declaredType(name: string, span: SourceSpan): Type {
    return this.#typeReference({ name, arguments: [], span }, new Map(), []);
  }

  #typeReference(
    reference: DucklangTypeReference,
    parameters: ReadonlyMap<string, Type>,
    expandingAliases: readonly string[],
  ): Type {
    const parameter = parameters.get(reference.name);
    if (parameter !== undefined) {
      if (reference.arguments.length !== 0) {
        throw new TypeError(
          `${this.#file}:${reference.span.start}: Ducklang type parameter ${reference.name} cannot take arguments`,
        );
      }
      return parameter;
    }
    if (reference.name === "Int" || reference.name === "I32") return i32Type;
    if (reference.name === "I64") return i64Type;
    if (reference.name === "Bool") return booleanType;
    if (reference.name === "Text") return textType;
    if (reference.name === "Unit") return unitType;
    if (/^U(?:[1-9]|[12][0-9]|3[01])$/.test(reference.name)) return i32Type;
    if (
      this.#structTypes.some((declaration) =>
        declaration.name === reference.name
      )
    ) {
      const declaration = this.#structTypes.find((candidate) =>
        candidate.name === reference.name
      )!;
      if (reference.arguments.length !== declaration.parameters.length) {
        throw new TypeError(
          `${this.#file}:${reference.span.start}: Ducklang struct ${reference.name} expects ${declaration.parameters.length} arguments; received ${reference.arguments.length}`,
        );
      }
      return {
        kind: "constructor",
        name: reference.name,
        arguments: reference.arguments.map((argument) =>
          this.#typeReference(argument, parameters, expandingAliases)
        ),
      };
    }
    const arguments_ = reference.arguments.map((argument) =>
      this.#typeReference(argument, parameters, expandingAliases)
    );
    const alias = this.#typeAliases.find((candidate) =>
      candidate.name === reference.name
    );
    if (alias !== undefined) {
      if (alias.parameters.length !== arguments_.length) {
        throw new TypeError(
          `${this.#file}:${reference.span.start}: Ducklang type alias ${alias.name} expects ${alias.parameters.length} arguments; received ${arguments_.length}`,
        );
      }
      if (expandingAliases.includes(alias.name)) {
        throw new TypeError(
          `${this.#file}:${reference.span.start}: recursive Ducklang type alias ${
            [...expandingAliases, alias.name].join(" -> ")
          }`,
        );
      }
      return this.#typeReference(
        alias.target,
        new Map(
          alias.parameters.map((name, index) => [name, arguments_[index]]),
        ),
        [...expandingAliases, alias.name],
      );
    }
    const declaration = this.#unionTypes.find((candidate) =>
      candidate.name === reference.name
    );
    if (declaration === undefined) {
      throw new TypeError(
        `${this.#file}:${reference.span.start}: unknown Ducklang type ${reference.name}`,
      );
    }
    if (declaration.parameters.length !== arguments_.length) {
      throw new TypeError(
        `${this.#file}:${reference.span.start}: Ducklang type ${declaration.name} expects ${declaration.parameters.length} arguments; received ${arguments_.length}`,
      );
    }
    return {
      kind: "constructor",
      name: declaration.name,
      arguments: arguments_,
    };
  }

  #structDeclaration(
    type: Type,
    span: SourceSpan,
  ): ResolvedDucklangStructType {
    const applied = this.#apply(type);
    const declaration = applied.kind === "constructor"
      ? this.#structTypes.find((candidate) => candidate.name === applied.name)
      : undefined;
    if (declaration !== undefined) return declaration;
    throw new TypeError(
      `${this.#file}:${span.start}: Ducklang type ${
        formatDucklangType(applied)
      } is not a struct`,
    );
  }

  #structFieldType(
    declaration: ResolvedDucklangStructType,
    structType: Type,
    fieldType: DucklangTypeReference,
  ): Type {
    const applied = this.#apply(structType);
    if (
      applied.kind !== "constructor" ||
      applied.arguments.length !== declaration.parameters.length
    ) {
      throw new TypeError(
        `${this.#file}:${fieldType.span.start}: Ducklang struct ${declaration.name} has an invalid type application`,
      );
    }
    return this.#typeReference(
      fieldType,
      new Map(
        declaration.parameters.map((name, index) => [
          name,
          applied.arguments[index],
        ]),
      ),
      [],
    );
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
      unionTypes: this.#unionTypes,
      typeAliases: this.#typeAliases,
      structTypes: this.#structTypes,
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
      case "unit":
      case "string":
      case "intrinsic":
      case "reference":
        return { ...expression, type };
      case "hostCall":
        return {
          ...expression,
          arguments: expression.arguments.map((argument) =>
            this.#normalizeExpression(argument)
          ),
          type,
        };
      case "optionDo":
        return {
          ...expression,
          option: this.#normalizeExpression(expression.option),
          type,
        };
      case "unionCase":
        return {
          ...expression,
          value: this.#normalizeExpression(expression.value),
          type,
        };
      case "product":
        return {
          ...expression,
          values: expression.values.map((value) =>
            this.#normalizeExpression(value)
          ),
          type,
        };
      case "project":
        return {
          ...expression,
          product: this.#normalizeExpression(expression.product),
          type,
        };
      case "recordUpdate":
        return {
          ...expression,
          product: this.#normalizeExpression(expression.product),
          fields: expression.fields.map((field) => ({
            ...field,
            value: this.#normalizeExpression(field.value),
          })),
          type,
        };
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
      case "index":
        return {
          ...expression,
          collection: this.#normalizeExpression(expression.collection),
          index: this.#normalizeExpression(expression.index),
          type,
        };
      case "selectProductElement":
        return {
          ...expression,
          values: expression.values.map((value) =>
            this.#normalizeExpression(value)
          ),
          index: this.#normalizeExpression(expression.index),
          type,
        };
      case "indexUpdate":
        return {
          ...expression,
          product: this.#normalizeExpression(expression.product),
          index: this.#normalizeExpression(expression.index),
          value: this.#normalizeExpression(expression.value),
          type,
        };
      case "textAppend":
        return {
          ...expression,
          left: this.#normalizeExpression(expression.left),
          right: this.#normalizeExpression(expression.right),
          type,
        };
      case "binary":
        return {
          ...expression,
          left: this.#normalizeExpression(expression.left),
          right: this.#normalizeExpression(expression.right),
          type,
        };
      case "ownership":
        return {
          ...expression,
          expression: this.#normalizeExpression(expression.expression),
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
      case "ifUnion":
        return {
          ...expression,
          value: this.#normalizeExpression(expression.value),
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
      case "scratch":
        return {
          ...expression,
          body: this.#normalizeExpression(expression.body),
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
      case "hostCall":
        for (const argument of expression.arguments) {
          this.#unifyReturnTypes(argument, result);
        }
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

function sourceTypeName(type: Type): string {
  if (type.kind !== "constructor") return formatDucklangType(type);
  if (type.name === "i32") return "Int";
  if (type.name === "i64") return "I64";
  if (type.name === "bool") return "Bool";
  if (type.name === "text") return "Text";
  if (type.name === "unit") return "Unit";
  return formatDucklangType(type);
}

function isIntegerType(
  type: Type,
): type is Extract<Type, { readonly kind: "constructor" }> {
  return type.kind === "constructor" &&
    (type.name === "i32" || type.name === "i64") &&
    type.arguments.length === 0;
}

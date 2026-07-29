import type { SourceSpan } from "./syntax.ts";
import {
  BuiltinTypeId,
  type BuiltinTypeId as BuiltinTypeIdentity,
  primitiveDescriptor,
  PrimitiveId,
  type PrimitiveOperandPattern,
} from "./ducklang_primitives.ts";
import type { DucklangTypeReference } from "./ducklang_ast.ts";
import type {
  DucklangEffectOperation,
  DucklangEffectReference,
  DucklangInitField,
} from "./ducklang_ast.ts";
import { analyzeDucklangEffects } from "./ducklang_effects.ts";
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
    readonly kind: "float32";
    readonly value: number;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "float64";
    readonly value: number;
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
    readonly kind: "primitive";
    readonly primitiveId: PrimitiveId;
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
    readonly spreadValues?: readonly boolean[];
    readonly fieldNames?: readonly string[];
    readonly nominalType?: string;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "project";
    readonly product: TypedDucklangExpression;
    readonly index: number;
    readonly arity?: number;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "namedProject";
    readonly product: TypedDucklangExpression;
    readonly fieldName: string;
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
    readonly consumed?: true;
    readonly type: Type;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "function";
    readonly recursive: boolean;
    readonly loweringRole?: "loop";
    readonly parameters: readonly DucklangSymbol[];
    readonly typeParameters?: readonly string[];
    readonly parameterTypeSources?: readonly TypedDucklangExpression[];
    readonly declaredResultType?: DucklangTypeReference;
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
    readonly entryProjection?: boolean;
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
    readonly context: "explicit" | "valuePattern";
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
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | ":>"
  | ":<"
  | ":+"
  | ":|"
  | ":&"
  | ":-";

export type TypedDucklangBinding = {
  readonly symbol: DucklangSymbol;
  readonly previous: DucklangSymbol | undefined;
  readonly recursive: boolean;
  readonly stage: "compileTime" | "runtime";
  readonly value: TypedDucklangExpression;
  readonly type: Type;
  readonly latentEffects: readonly DucklangEffectReference[];
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
  readonly exportNames: readonly string[];
  readonly bindings: readonly TypedDucklangBinding[];
  readonly result: TypedDucklangExpression;
  readonly resultType: Type;
  readonly equalities: readonly EqualityConstraint[];
  readonly symbolTypes: ReadonlyMap<number, Type>;
  readonly effectDeclarations: ReadonlyMap<
    string,
    readonly DucklangEffectOperation[]
  >;
  readonly requiredEffects: readonly DucklangEffectReference[];
  readonly initFields: readonly DucklangInitField[];
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
const f32Type: Type = { kind: "constructor", name: "f32", arguments: [] };
const f64Type: Type = { kind: "constructor", name: "f64", arguments: [] };
const booleanType: Type = {
  kind: "constructor",
  name: "bool",
  arguments: [],
};
const textType: Type = { kind: "constructor", name: "text", arguments: [] };
const bytesType: Type = { kind: "constructor", name: "bytes", arguments: [] };
const f32x4Type: Type = { kind: "constructor", name: "f32x4", arguments: [] };
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
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  ":>",
  ":<",
  ":+",
  ":|",
  ":&",
  ":-",
]);
const compileTimeBinaryOperators = new Set([
  ":>",
  ":<",
  ":+",
  ":|",
  ":&",
  ":-",
]);

export function inferDucklangModule(
  module: ResolvedDucklangModule,
): TypedDucklangModule {
  const effectAnalysis = analyzeDucklangEffects(module);
  const inference = new DucklangInference(
    module.file,
    module.unionTypes,
    module.typeAliases,
    module.structTypes,
    module.effects,
    effectAnalysis.bindingEffects,
    module.initFields,
    module.exportNames,
  );
  const environment = inference.inferModuleParameters(module.parameters);
  const bindings = inference.inferBindings(module.bindings, environment);
  const result = inference.inferModuleResult(module.result, environment);
  return inference.finish(bindings, result, effectAnalysis.moduleEffects);
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
  readonly #productConstraints = new Map<number, Type[]>();
  readonly #indexedElementTypes = new Map<number, Type>();
  readonly #namedFieldConstraints = new Map<number, Map<string, Type>>();
  readonly #numericVariables = new Set<number>();
  readonly #bottomVariables = new Set<number>();
  readonly #unionTypes: readonly ResolvedDucklangUnionType[];
  readonly #typeAliases: readonly ResolvedDucklangTypeAlias[];
  readonly #structTypes: readonly ResolvedDucklangStructType[];
  readonly #effectDeclarations: ReadonlyMap<
    string,
    readonly DucklangEffectOperation[]
  >;
  readonly #bindingEffects: ReadonlyMap<
    number,
    readonly DucklangEffectReference[]
  >;
  readonly #initFields: readonly DucklangInitField[];
  readonly #exportNames: readonly string[];
  #activeTypeParameters: ReadonlyMap<string, Type> = new Map();
  #nextVariable = 0;

  constructor(
    file: string,
    unionTypes: readonly ResolvedDucklangUnionType[],
    typeAliases: readonly ResolvedDucklangTypeAlias[],
    structTypes: readonly ResolvedDucklangStructType[],
    effectDeclarations: ReadonlyMap<
      string,
      readonly DucklangEffectOperation[]
    >,
    bindingEffects: ReadonlyMap<
      number,
      readonly DucklangEffectReference[]
    >,
    initFields: readonly DucklangInitField[],
    exportNames: readonly string[],
  ) {
    this.#file = file;
    this.#unionTypes = unionTypes;
    this.#typeAliases = typeAliases;
    this.#structTypes = structTypes;
    this.#effectDeclarations = effectDeclarations;
    this.#bindingEffects = bindingEffects;
    this.#initFields = initFields;
    this.#exportNames = exportNames;
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
      const typeParameters = binding.value.kind === "function"
        ? this.#functionTypeParameters(
          binding.value.parameters,
          binding.value.typeParameters,
        )
        : new Map<string, Type>();
      const type = binding.value.kind === "function" &&
          binding.value.declaredResultType !== undefined
        ? functionType(
          binding.value.parameters.map((parameter) =>
            parameter.declaredType !== undefined
              ? this.#declaredType(
                parameter.declaredType,
                parameter.span,
                typeParameters,
              )
              : typeParameters.get(parameter.text) ?? this.#freshVariable()
          ),
          this.#declaredType(
            binding.value.declaredResultType,
            binding.value.span,
            typeParameters,
          ),
        )
        : this.#freshVariable();
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
      if (
        recursiveType !== undefined && binding.value.kind === "function" &&
        binding.value.parameterTypeSources !== undefined
      ) {
        const typeParameters = this.#functionTypeParameters(
          binding.value.parameters,
          binding.value.typeParameters,
        );
        const parameterSourceTypes = binding.value.parameterTypeSources.map((
          source,
        ) => this.inferExpression(source, environment).type);
        this.#unify(
          recursiveType,
          functionType(
            binding.value.parameters.map((parameter, index) =>
              parameter.declaredType !== undefined
                ? this.#declaredType(
                  parameter.declaredType,
                  parameter.span,
                  typeParameters,
                )
                : typeParameters.get(parameter.text) ??
                  parameterSourceTypes[index]
            ),
            binding.value.declaredResultType === undefined
              ? this.#freshVariable()
              : this.#declaredType(
                binding.value.declaredResultType,
                binding.value.span,
                typeParameters,
              ),
          ),
          binding.span,
        );
      }
      const declaredBindingType = binding.symbol.declaredType === undefined
        ? undefined
        : this.#declaredType(
          binding.symbol.declaredType,
          binding.symbol.span,
        );
      const previousType = binding.previous === undefined
        ? undefined
        : environment.get(binding.previous.id);
      if (binding.previous !== undefined && previousType === undefined) {
        throw new Error(
          `${this.#file}:${binding.span.start}: missing type for resolved symbol ${binding.previous.text}#${binding.previous.id}`,
        );
      }
      const inferred = this.inferExpression(
        binding.value,
        environment,
        declaredBindingType ?? previousType,
      );
      const bindingType = recursiveType ?? inferred.type;
      if (recursiveType !== undefined) {
        this.#unify(recursiveType, inferred.type, binding.span);
      }
      if (previousType !== undefined) {
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
        const declaredType = declaredBindingType!;
        try {
          this.#unify(declaredType, bindingType, binding.span);
        } catch (cause) {
          throw new TypeError(
            `${binding.span.file}:${binding.span.start}: Ducklang binding ${binding.symbol.text} declares ${
              sourceTypeName(this.#apply(declaredType))
            } but produces ${sourceTypeName(this.#apply(bindingType))}`,
            { cause },
          );
        }
      }
      environment.set(binding.symbol.id, bindingType);
      this.#symbolTypes.set(binding.symbol.id, bindingType);
      typed.push({
        ...binding,
        value: inferred.expression,
        type: bindingType,
        latentEffects: this.#bindingEffects.get(binding.symbol.id) ?? [],
      });
    }
    return typed;
  }

  inferModuleParameters(
    parameters: readonly DucklangSymbol[],
  ): Map<number, Type> {
    const environment = new Map<number, Type>();
    for (const parameter of parameters) {
      const type = parameter.declaredType === undefined
        ? this.#freshVariable()
        : this.#declaredType(parameter.declaredType, parameter.span);
      environment.set(parameter.id, type);
      this.#symbolTypes.set(parameter.id, type);
    }
    return environment;
  }

  inferModuleResult(
    expression: ResolvedDucklangExpression,
    environment: ReadonlyMap<number, Type>,
  ): InferredExpression {
    if (
      expression.kind !== "record" || expression.nominalType !== undefined ||
      expression.fields.length !== this.#exportNames.length ||
      !this.#exportNames.every((name, index) =>
        expression.fields[index]?.name === name
      )
    ) {
      return this.inferExpression(expression, environment);
    }
    const values = expression.fields.map((field) =>
      this.inferExpression(field.value, environment)
    );
    if (values.length === 1) return values[0];
    const type: Type = {
      kind: "constructor",
      name: "tuple",
      arguments: values.map((value) => value.type),
    };
    return {
      expression: {
        kind: "product",
        productKind: "tuple",
        values: values.map((value) => value.expression),
        type,
        span: expression.span,
      },
      type,
    };
  }

  inferExpression(
    expression: ResolvedDucklangExpression,
    environment: ReadonlyMap<number, Type>,
    expectedType?: Type,
  ): InferredExpression {
    switch (expression.kind) {
      case "integer":
        return { expression: { ...expression, type: i32Type }, type: i32Type };
      case "integer64":
        return { expression: { ...expression, type: i64Type }, type: i64Type };
      case "float32":
        return { expression: { ...expression, type: f32Type }, type: f32Type };
      case "float64":
        return { expression: { ...expression, type: f64Type }, type: f64Type };
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
          expression.modulePath === "duck:prelude/attributes" &&
          expression.exportName === "test"
        ) {
          type = unitType;
        } else if (
          expression.modulePath === "duck:prelude/testing" &&
          (expression.exportName === "assert" ||
            expression.exportName === "assert_false")
        ) {
          type = functionType([booleanType], unitType);
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
          expression.modulePath === "duck:prelude/iterators" &&
          expression.exportName === "iterator_count"
        ) {
          const state = this.#freshVariable();
          const value = this.#freshVariable();
          type = functionType([
            {
              kind: "constructor",
              name: "IteratorValue",
              arguments: [state, value],
            },
            functionType([value], booleanType),
          ], i32Type);
        } else if (
          expression.modulePath === "duck:prelude" &&
          expression.exportName === "not"
        ) {
          type = functionType([booleanType], booleanType);
        } else if (
          expression.modulePath === "duck:prelude" &&
          expression.exportName === "slice"
        ) {
          const buffer = this.#freshVariable();
          type = functionType([buffer, i32Type, i32Type], buffer);
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
          expression.modulePath === "duck:compiler/reflect" &&
          expression.exportName === "type_of"
        ) {
          // Reflection turns a value into a type descriptor, so the argument is
          // unconstrained and the result is the same descriptor kind every
          // `duck:type/*` intrinsic already carries.
          type = functionType([this.#freshVariable()], typeDescriptorType);
        } else if (
          expression.modulePath === "duck:compiler/reflect" &&
          expression.exportName === "describe_type"
        ) {
          type = functionType(
            [typeDescriptorType],
            this.#declaredType("$TypeDescription", expression.span),
          );
        } else if (
          (expression.modulePath === "duck:prelude" ||
            expression.modulePath === "duck:prelude/types") &&
          expression.exportName === "cast"
        ) {
          type = functionType([
            this.#freshVariable(),
            typeDescriptorType,
          ], this.#freshVariable());
        } else if (
          (expression.modulePath === "duck:prelude" ||
            expression.modulePath === "duck:prelude/types") &&
          (expression.exportName === "struct" ||
            expression.exportName === "packed" ||
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
      case "primitive": {
        const descriptor = primitiveDescriptor(expression.primitiveId);
        const operandTypes: Type[] = [];
        const operandType = (operand: PrimitiveOperandPattern): Type => {
          if (typeof operand === "number") return this.#builtinType(operand);
          if (typeof operand === "object") {
            if ("function" in operand) {
              const parameters = operand.function.parameters.map(operandType);
              const result = operand.function.result;
              return functionType(
                parameters,
                result === "bottom"
                  ? this.#freshVariable()
                  : typeof result === "number"
                  ? this.#builtinType(result)
                  : operandTypes[result.sameAs],
              );
            }
            return operandTypes[operand.sameAs];
          }
          return this.#freshVariable();
        };
        for (const operand of descriptor.signature.operands) {
          operandTypes.push(operandType(operand));
        }
        const result = descriptor.signature.result;
        const resultType = result === "bottom"
          ? this.#freshBottomVariable()
          : typeof result === "number"
          ? this.#builtinType(result)
          : operandTypes[result.sameAs];
        const type = functionType(
          operandTypes,
          resultType,
        );
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
        const appliedExpectedType = expectedType === undefined
          ? undefined
          : this.#apply(expectedType);
        const expectedUnionName = appliedExpectedType?.kind === "constructor"
          ? appliedExpectedType.name
          : undefined;
        const unionCase = this.#unionCaseType(
          expression.caseName,
          expression.span,
          expression.nominalType ?? expectedUnionName,
        );
        let value = this.inferExpression(expression.value, environment);
        const payloadType = this.#apply(unionCase.payload);
        const payloadDeclaration = payloadType.kind === "constructor"
          ? this.#structTypes.find((declaration) =>
            declaration.name === payloadType.name
          )
          : undefined;
        if (
          value.expression.kind === "product" &&
          value.expression.nominalType === undefined &&
          payloadDeclaration !== undefined &&
          payloadDeclaration.fields.length === value.expression.values.length
        ) {
          for (const [index, field] of payloadDeclaration.fields.entries()) {
            this.#unify(
              this.#structFieldType(
                payloadDeclaration,
                payloadType,
                field.type,
              ),
              value.expression.values[index].type,
              value.expression.values[index].span,
            );
          }
          value = {
            expression: {
              ...value.expression,
              nominalType: payloadDeclaration.name,
              type: payloadType,
            },
            type: payloadType,
          };
        }
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
        const expectedProductType = expectedType === undefined
          ? undefined
          : this.#apply(expectedType);
        const expectedTupleFields =
          expectedProductType?.kind === "constructor" &&
            expectedProductType.name === "tuple" &&
            expectedProductType.arguments.length === expression.values.length
            ? expectedProductType.arguments
            : undefined;
        const expectedArrayElement =
          expectedProductType?.kind === "constructor" &&
            expectedProductType.name === "array" &&
            expectedProductType.arguments.length === 1
            ? expectedProductType.arguments[0]
            : undefined;
        const values = expression.values.map((value, index) =>
          this.inferExpression(
            value,
            environment,
            expectedTupleFields?.[index] ?? expectedArrayElement,
          )
        );
        let type: Type;
        if (expectedTupleFields !== undefined) {
          for (const [index, value] of values.entries()) {
            this.#unify(
              value.type,
              expectedTupleFields[index],
              value.expression.span,
            );
          }
          type = {
            kind: "constructor",
            name: "tuple",
            arguments: values.map((value) => value.type),
          };
        } else if (expectedArrayElement !== undefined) {
          for (const [index, value] of values.entries()) {
            const expected = expression.spreadValues?.[index] === true
              ? {
                kind: "constructor" as const,
                name: "array",
                arguments: [expectedArrayElement],
              }
              : expectedArrayElement;
            this.#unify(expected, value.type, value.expression.span);
          }
          type = {
            kind: "constructor",
            name: "array",
            arguments: [expectedArrayElement],
          };
        } else if (
          expression.nominalType === undefined &&
          (expression.values.length === 0 ||
            expression.spreadValues?.some((spread) => spread))
        ) {
          type = {
            kind: "constructor",
            name: "compileTimeProduct",
            arguments: [],
          };
        } else if (expression.nominalType !== undefined) {
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
        } else {
          type = {
            kind: "constructor",
            name: "tuple",
            arguments: values.map((value) => value.type),
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
        if (productType.kind === "variable") {
          let fields = this.#namedFieldConstraints.get(productType.id);
          if (fields === undefined) {
            fields = new Map();
            this.#namedFieldConstraints.set(productType.id, fields);
          }
          const type = fields.get(expression.fieldName) ??
            this.#freshVariable();
          fields.set(expression.fieldName, type);
          return {
            expression: {
              kind: "namedProject",
              product: product.expression,
              fieldName: expression.fieldName,
              type,
              span: expression.span,
            },
            type,
          };
        }
        if (productType.kind !== "constructor") {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang field ${expression.fieldName} requires a struct; received ${
              formatDucklangType(productType)
            }`,
          );
        }
        if (productType.name === "compileTimeProduct") {
          const type = this.#freshVariable();
          return {
            expression: {
              kind: "namedProject",
              product: product.expression,
              fieldName: expression.fieldName,
              type,
              span: expression.span,
            },
            type,
          };
        }
        const structuralFields = structuralRecordFieldNames(productType.name);
        if (structuralFields !== undefined) {
          const index = structuralFields.indexOf(expression.fieldName);
          if (index < 0) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang record has no field ${expression.fieldName}; available fields are ${
                structuralFields.join(", ")
              }`,
            );
          }
          const type = productType.arguments[index];
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
          if (expression.nominalType === undefined) {
            const values = expression.fields.map((field) =>
              this.inferExpression(field.value, environment)
            );
            const fieldNames = expression.fields.map((field) => field.name);
            const type: Type = {
              kind: "constructor",
              name: structuralRecordTypeName(fieldNames),
              arguments: values.map((value) => value.type),
            };
            return {
              expression: {
                kind: "product",
                productKind: "tuple",
                values: values.map((value) => value.expression),
                fieldNames,
                type,
                span: expression.span,
              },
              type,
            };
          }
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
            fieldNames: declaration.fields.map((field) => field.name),
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
        if (productType.kind === "variable" && expression.arity !== undefined) {
          let fields = this.#productConstraints.get(productType.id);
          if (fields === undefined) {
            fields = Array.from(
              { length: expression.arity },
              () => this.#freshVariable(),
            );
            this.#productConstraints.set(productType.id, fields);
          }
          const type = fields[expression.index];
          if (type === undefined) {
            throw new RangeError(
              `${expression.span.file}:${expression.span.start}: Ducklang product projection ${expression.index} is outside arity ${fields.length}`,
            );
          }
          return {
            expression: { ...expression, product: product.expression, type },
            type,
          };
        }
        if (productType.kind !== "constructor") {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Ducklang product projection ${expression.index} requires a product; received ${
              formatDucklangType(productType)
            }`,
          );
        }
        let type: Type | undefined;
        if (productType.name === "tuple") {
          type = productType.arguments[expression.index];
        } else if (productType.name === "array") {
          type = productType.arguments[0];
        } else {
          const declaration = this.#structTypes.find((candidate) =>
            candidate.name === productType.name
          );
          const field = declaration?.fields[expression.index];
          if (declaration !== undefined && field !== undefined) {
            type = this.#structFieldType(declaration, productType, field.type);
          }
        }
        if (type === undefined) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Ducklang product projection ${expression.index} is outside ${
              sourceTypeName(productType)
            }`,
          );
        }
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
        const typeParameters = this.#functionTypeParameters(
          expression.parameters,
          expression.typeParameters,
        );
        const previousTypeParameters = this.#activeTypeParameters;
        this.#activeTypeParameters = typeParameters;
        try {
          const parameterTypeSources = expression.parameterTypeSources?.map((
            source,
          ) => this.inferExpression(source, environment));
          const parameterTypes = expression.parameters.map(
            (parameter, index) => {
              const type = parameter.declaredType !== undefined
                ? this.#declaredType(
                  parameter.declaredType,
                  parameter.span,
                  typeParameters,
                )
                : typeParameters.get(parameter.text) ??
                  parameterTypeSources?.[index]?.type ??
                  this.#freshVariable();
              functionEnvironment.set(parameter.id, type);
              this.#symbolTypes.set(parameter.id, type);
              return type;
            },
          );
          const declaredResultType = expression.declaredResultType === undefined
            ? undefined
            : this.#declaredType(
              expression.declaredResultType,
              expression.span,
              typeParameters,
            );
          const body = this.inferExpression(
            expression.body,
            functionEnvironment,
            declaredResultType,
          );
          const resultType = declaredResultType ?? body.type;
          if (declaredResultType !== undefined) {
            this.#unify(body.type, declaredResultType, expression.body.span);
          }
          this.#unifyReturnTypes(body.expression, resultType);
          const type = parameterTypes.toReversed().reduce<Type>(
            (result, parameter) => ({ kind: "function", parameter, result }),
            resultType,
          );
          return {
            expression: {
              ...expression,
              parameterTypeSources: parameterTypeSources?.map((source) =>
                source.expression
              ),
              body: body.expression,
              type,
            },
            type,
          };
        } finally {
          this.#activeTypeParameters = previousTypeParameters;
        }
      }
      case "call": {
        const callee = this.inferExpression(expression.callee, environment);
        const appliedCalleeType = this.#apply(callee.type);
        if (
          appliedCalleeType.kind === "constructor" &&
          appliedCalleeType.name === "typeDescriptor" &&
          appliedCalleeType.arguments.length === 0
        ) {
          const arguments_ = expression.arguments.map((argumentExpression) => {
            const argument = this.inferExpression(
              argumentExpression,
              environment,
              typeDescriptorType,
            );
            this.#unify(
              argument.type,
              typeDescriptorType,
              argumentExpression.span,
            );
            return argument;
          });
          return {
            expression: {
              ...expression,
              callee: callee.expression,
              arguments: arguments_.map((argument) => argument.expression),
              type: typeDescriptorType,
            },
            type: typeDescriptorType,
          };
        }
        const arguments_: InferredExpression[] = [];
        let result = callee.type;
        let calleeResult = callee.type;
        for (
          const [index, argumentExpression] of expression.arguments.entries()
        ) {
          const appliedCallee = this.#apply(calleeResult);
          const argument = this.inferExpression(
            argumentExpression,
            environment,
            appliedCallee.kind === "function"
              ? appliedCallee.parameter
              : undefined,
          );
          arguments_.push(argument);
          result = this.#freshVariable();
          try {
            this.#unify(
              calleeResult,
              { kind: "function", parameter: argument.type, result },
              argumentExpression.span,
            );
          } catch (cause) {
            throw new TypeError(
              `${expression.span.file}:${expression.span.start}: Ducklang call argument ${
                index + 1
              } cannot apply ${sourceTypeName(this.#apply(calleeResult))} to ${
                sourceTypeName(this.#apply(argument.type))
              }`,
              { cause },
            );
          }
          calleeResult = result;
        }
        result = this.#apply(result);
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
          expression.entryProjection === true &&
          collectionType.kind === "constructor" &&
          (collectionType.name === "compileTimeProduct" ||
            structuralRecordFieldNames(collectionType.name) !== undefined)
        ) {
          type = {
            kind: "constructor",
            name: structuralRecordTypeName(["name", "value"]),
            arguments: [textType, this.#freshVariable()],
          };
        } else if (collectionType.kind === "variable") {
          type = this.#indexedElementTypes.get(collectionType.id) ??
            this.#freshVariable();
          this.#indexedElementTypes.set(collectionType.id, type);
        } else if (
          collectionType.kind === "constructor" &&
          (collectionType.name === "text" ||
            collectionType.name === "bytes")
        ) {
          type = i32Type;
        } else if (
          collectionType.kind === "constructor" &&
          collectionType.name === "tuple"
        ) {
          if (expression.index.kind === "integer") {
            const selected = collectionType.arguments[expression.index.value];
            if (selected === undefined) {
              throw new RangeError(
                `${expression.span.file}:${expression.span.start}: Ducklang product index ${expression.index.value} is outside arity ${collectionType.arguments.length}`,
              );
            }
            type = selected;
          } else {
            type = collectionType.arguments[0] ?? this.#freshVariable();
            for (const elementType of collectionType.arguments.slice(1)) {
              this.#unify(type, elementType, expression.collection.span);
            }
          }
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
              `${expression.collection.span.file}:${expression.collection.span.start}: Ducklang index requires Text, Bytes, an array, or a nonempty homogeneous struct; received ${
                formatDucklangType(collectionType)
              }`,
            );
          }
          if (expression.index.kind === "integer") {
            const field = declaration.fields[expression.index.value];
            if (field === undefined) {
              throw new RangeError(
                `${expression.span.file}:${expression.span.start}: Ducklang product index ${expression.index.value} is outside ${declaration.name} arity ${declaration.fields.length}`,
              );
            }
            type = this.#structFieldType(
              declaration,
              collectionType,
              field.type,
            );
          } else {
            type = this.#structFieldType(
              declaration,
              collectionType,
              firstField.type,
            );
            for (const field of declaration.fields.slice(1)) {
              this.#unify(
                type,
                this.#structFieldType(
                  declaration,
                  collectionType,
                  field.type,
                ),
                field.span,
              );
            }
          }
        } else {
          throw new TypeError(
            `${expression.collection.span.file}:${expression.collection.span.start}: Ducklang index requires Text, Bytes, an array, or a nonempty homogeneous struct; received ${
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
        if (
          productType.kind === "constructor" &&
          productType.name === "bytes"
        ) {
          const value = this.inferExpression(expression.value, environment);
          this.#unify(value.type, i32Type, expression.value.span);
          return {
            expression: {
              ...expression,
              product: product.expression,
              index: index.expression,
              value: value.expression,
              type: bytesType,
            },
            type: bytesType,
          };
        }
        const declaration = productType.kind === "constructor"
          ? this.#structTypes.find((candidate) =>
            candidate.name === productType.name
          )
          : undefined;
        const firstField = declaration?.fields[0];
        if (declaration === undefined || firstField === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.product.span.start}: Ducklang indexed assignment requires Bytes or a nonempty homogeneous struct; received ${
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
        if (
          expression.operator === "<>" || expression.operator === "++"
        ) {
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
        if (compileTimeBinaryOperators.has(operator)) {
          let type = left.type;
          if (operator === ":|" || operator === ":&" || operator === ":-") {
            type = typeDescriptorType;
          } else if (operator === ":+") {
            const appliedLeft = this.#apply(left.type);
            const appliedRight = this.#apply(right.type);
            const leftFields = appliedLeft.kind === "constructor"
              ? structuralRecordFieldNames(appliedLeft.name)
              : undefined;
            const rightFields = appliedRight.kind === "constructor"
              ? structuralRecordFieldNames(appliedRight.name)
              : undefined;
            if (
              appliedLeft.kind === "constructor" &&
              appliedLeft.name === "compileTimeProduct"
            ) {
              type = appliedLeft;
            } else if (
              rightFields !== undefined && leftFields === undefined
            ) {
              type = appliedRight;
            } else if (
              appliedLeft.kind === "constructor" &&
              appliedRight.kind === "constructor" &&
              leftFields !== undefined && rightFields !== undefined
            ) {
              type = {
                kind: "constructor",
                name: structuralRecordTypeName([
                  ...leftFields,
                  ...rightFields,
                ]),
                arguments: [
                  ...appliedLeft.arguments,
                  ...appliedRight.arguments,
                ],
              };
            }
          }
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
        if (operator === "&&" || operator === "||") {
          try {
            this.#unify(left.type, booleanType, expression.left.span);
            this.#unify(right.type, booleanType, expression.right.span);
          } catch (cause) {
            throw new TypeError(
              `${expression.span.file}:${expression.span.start}: Ducklang operator ${operator} requires Bool operands; received ${
                formatDucklangType(this.#apply(left.type))
              } at ${expression.left.span.start} and ${
                formatDucklangType(this.#apply(right.type))
              } at ${expression.right.span.start}`,
              { cause },
            );
          }
        } else {
          const leftType = this.#apply(left.type);
          const rightType = this.#apply(right.type);
          if (
            isScalarNumericType(leftType) &&
            isScalarNumericType(rightType) &&
            formatDucklangType(leftType) !== formatDucklangType(rightType)
          ) {
            const mixedTypes = [
              formatDucklangType(leftType),
              formatDucklangType(rightType),
            ].sort().join(" and ");
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Mixed ${mixedTypes} numeric operand types: left ${
                formatDucklangType(leftType)
              }, right ${formatDucklangType(rightType)}`,
            );
          }
          try {
            this.#unify(left.type, right.type, expression.span);
          } catch (cause) {
            throw new TypeError(
              `${expression.span.file}:${expression.span.start}: Ducklang operator ${operator} has incompatible operands ${
                sourceTypeName(this.#apply(left.type))
              } at ${expression.left.span.start} and ${
                sourceTypeName(this.#apply(right.type))
              } at ${expression.right.span.start}`,
              { cause },
            );
          }
          const operandType = this.#apply(left.type);
          const equalityOnNonIntegers =
            (operator === "==" || operator === "!=") &&
            operandType.kind === "constructor" &&
            (operandType.name === "bool" || operandType.name === "text") &&
            operandType.arguments.length === 0;
          if (operandType.kind === "variable") {
            this.#numericVariables.add(operandType.id);
          } else if (
            !isScalarNumericType(operandType) && !equalityOnNonIntegers
          ) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang operator ${operator} requires equal-width numeric values; received ${
                formatDucklangType(operandType)
              }`,
            );
          }
        }
        const type = [
            "==",
            "!=",
            "<",
            "<=",
            ">",
            ">=",
            "&&",
            "||",
          ].includes(operator)
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
          if (!isScalarNumericType(operandType)) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang unary - requires a numeric value; received ${
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
            : operandType.name === "f32"
            ? {
              kind: "float32",
              value: 0,
              type: f32Type,
              span: expression.span,
            }
            : operandType.name === "f64"
            ? {
              kind: "float64",
              value: 0,
              type: f64Type,
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
          expectedType,
        );
        const type = this.#freshBottomVariable();
        return {
          expression: {
            ...expression,
            expression: returned.expression,
            type,
          },
          type,
        };
      }
      case "if": {
        let branchExpectedType = expectedType;
        let consequenceResult = expression.consequence;
        while (consequenceResult.kind === "block") {
          consequenceResult = consequenceResult.result;
        }
        let alternativeResult = expression.alternative;
        while (alternativeResult?.kind === "block") {
          alternativeResult = alternativeResult.result;
        }
        if (
          branchExpectedType === undefined &&
          consequenceResult.kind === "unionCase" &&
          consequenceResult.nominalType === undefined &&
          alternativeResult?.kind === "unionCase" &&
          alternativeResult.nominalType === undefined
        ) {
          const alternativeUnions = new Set(
            this.#unionCaseCandidates(
              alternativeResult.caseName,
              alternativeResult.span,
            ).map((candidate) => candidate.unionName),
          );
          const commonUnions = this.#unionCaseCandidates(
            consequenceResult.caseName,
            consequenceResult.span,
          ).filter((candidate) => alternativeUnions.has(candidate.unionName));
          if (commonUnions.length === 1) {
            branchExpectedType = commonUnions[0].union;
          }
        }
        const condition = this.inferExpression(
          expression.condition,
          environment,
        );
        const consequence = this.inferExpression(
          expression.consequence,
          environment,
          branchExpectedType,
        );
        const consequenceType = this.#apply(consequence.type);
        const alternative = expression.alternative === undefined
          ? consequenceType.kind === "constructor" &&
              consequenceType.name === "unit"
            ? {
              expression: {
                kind: "unit" as const,
                type: unitType,
                span: expression.span,
              },
              type: unitType,
            }
            : consequenceType.kind === "constructor" &&
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
          : this.inferExpression(
            expression.alternative,
            environment,
            branchExpectedType,
          );
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
        try {
          this.#unify(
            consequence.type,
            alternative.type,
            expression.alternative?.span ?? expression.span,
          );
        } catch (cause) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Ducklang if branches have incompatible types ${
              sourceTypeName(this.#apply(consequence.type))
            } at ${consequence.expression.span.start} and ${
              sourceTypeName(this.#apply(alternative.type))
            } at ${alternative.expression.span.start}`,
            { cause },
          );
        }
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
        const scrutineeType = this.#apply(value.type);
        const expectedUnionName = scrutineeType.kind === "constructor"
          ? scrutineeType.name
          : undefined;
        const candidates = this.#unionCaseCandidates(
          expression.caseName,
          expression.span,
          expectedUnionName,
        );
        let scrutineeCandidates = candidates.filter((candidate) =>
          this.#typesCouldMatch(value.type, candidate.union)
        );
        if (scrutineeCandidates.length > 1) {
          // An unconstrained pattern keeps the unique maximally polymorphic
          // declaration. A concrete declaration would prematurely default every
          // instantiation of a generic constructor with the same spelling.
          const parameterCounts = scrutineeCandidates.map((candidate) =>
            this.#unionTypes.find((declaration) =>
              declaration.name === candidate.unionName
            )?.parameters.length ?? 0
          );
          const highestParameterCount = Math.max(...parameterCounts);
          const mostGeneralCandidates = scrutineeCandidates.filter(
            (_, index) => parameterCounts[index] === highestParameterCount,
          );
          if (
            highestParameterCount > 0 && mostGeneralCandidates.length === 1
          ) {
            scrutineeCandidates = mostGeneralCandidates;
          }
        }
        if (scrutineeCandidates.length === 1) {
          this.#unify(
            value.type,
            scrutineeCandidates[0].union,
            expression.value.span,
          );
        }
        const payloadType = scrutineeCandidates.length === 1
          ? scrutineeCandidates[0].payload
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
          expectedType,
        );
        const consequenceType = this.#apply(consequence.type);
        const missingAlternativeType = expression.alternative === undefined &&
            !(consequenceType.kind === "constructor" &&
              consequenceType.name === "unit")
          ? this.#freshBottomVariable()
          : undefined;
        const alternative = expression.alternative === undefined
          ? consequenceType.kind === "constructor" &&
              consequenceType.name === "unit"
            ? {
              expression: {
                kind: "unit" as const,
                type: unitType,
                span: expression.span,
              },
              type: unitType,
            }
            : {
              expression: {
                kind: "call" as const,
                callee: {
                  kind: "primitive" as const,
                  primitiveId: PrimitiveId.panic,
                  type: functionType([textType], missingAlternativeType!),
                  span: expression.span,
                },
                arguments: [],
                type: missingAlternativeType!,
                span: expression.span,
              },
              type: missingAlternativeType!,
            }
          : this.inferExpression(
            expression.alternative,
            environment,
            expectedType,
          );
        const compatibleCandidates = scrutineeCandidates.filter((candidate) =>
          this.#typesCouldMatch(payloadType, candidate.payload)
        );
        if (compatibleCandidates.length === 0) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Ducklang constructor pattern ${expression.caseName} matches neither scrutinee ${
              formatDucklangType(this.#apply(value.type))
            } nor payload ${formatDucklangType(this.#apply(payloadType))}`,
          );
        }
        if (compatibleCandidates.length > 1) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Ducklang constructor pattern ${expression.caseName} is ambiguous among ${
              compatibleCandidates.map((candidate) => candidate.unionName).join(
                ", ",
              )
            }`,
          );
        }
        const unionCase = compatibleCandidates[0];
        this.#unify(value.type, unionCase.union, expression.value.span);
        this.#unify(payloadType, unionCase.payload, expression.span);
        try {
          this.#unify(consequence.type, alternative.type, expression.span);
        } catch (cause) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Ducklang union-pattern branches have incompatible types ${
              sourceTypeName(this.#apply(consequence.type))
            } and ${sourceTypeName(this.#apply(alternative.type))}`,
            { cause },
          );
        }
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
          expectedType,
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
    preferSourceFile = true,
  ): readonly {
    readonly unionName: string;
    readonly union: Type;
    readonly payload: Type;
  }[] {
    const expectedDeclarationName = expectedUnionName === undefined
      ? undefined
      : this.#typeAliases.find((alias) => alias.name === expectedUnionName)
        ?.target.name ?? expectedUnionName;
    const namedDeclarations = this.#unionTypes.filter((candidate) =>
      (expectedDeclarationName === undefined ||
        candidate.name === expectedDeclarationName) &&
      candidate.cases.some((unionCase) => unionCase.name === caseName)
    );
    const localDeclarations = namedDeclarations.filter((candidate) =>
      candidate.span.file === span.file
    );
    const declarations = !preferSourceFile || localDeclarations.length === 0
      ? namedDeclarations
      : localDeclarations;
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
    if (appliedLeft.kind === "variable") {
      const fields = this.#productConstraints.get(appliedLeft.id);
      if (fields === undefined || appliedRight.kind === "variable") return true;
      const rightFields = this.#productFieldTypes(
        appliedRight,
        fields.length,
      );
      return rightFields !== undefined &&
        fields.every((field, index) =>
          this.#typesCouldMatch(field, rightFields[index])
        );
    }
    if (appliedRight.kind === "variable") {
      return this.#typesCouldMatch(appliedRight, appliedLeft);
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

  #declaredType(
    reference: string | DucklangTypeReference,
    span: SourceSpan,
    parameters: ReadonlyMap<string, Type> = this.#activeTypeParameters,
  ): Type {
    return this.#typeReference(
      typeof reference === "string"
        ? { name: reference, arguments: [], span }
        : reference,
      parameters,
      [],
    );
  }

  #functionTypeParameters(
    parameters: readonly DucklangSymbol[],
    declaredParameters: readonly string[] | undefined,
  ): ReadonlyMap<string, Type> {
    const types = new Map(this.#activeTypeParameters);
    for (const name of declaredParameters ?? []) {
      if (!types.has(name)) types.set(name, this.#freshVariable());
    }
    for (const parameter of parameters) {
      if (
        parameter.compileTimeRecord !== true ||
        parameter.declaredType !== undefined ||
        types.has(parameter.text)
      ) {
        continue;
      }
      types.set(parameter.text, this.#freshVariable());
    }
    return types;
  }

  #builtinType(id: BuiltinTypeIdentity): Type {
    switch (id) {
      case BuiltinTypeId.i32:
      case BuiltinTypeId.char:
        return i32Type;
      case BuiltinTypeId.i64:
        return i64Type;
      case BuiltinTypeId.f32:
        return f32Type;
      case BuiltinTypeId.f64:
        return f64Type;
      case BuiltinTypeId.f32x4:
        return f32x4Type;
      case BuiltinTypeId.bool:
        return booleanType;
      case BuiltinTypeId.text:
        return textType;
      case BuiltinTypeId.bytes:
        return bytesType;
      case BuiltinTypeId.unit:
        return unitType;
    }
  }

  #typeReference(
    reference: DucklangTypeReference,
    parameters: ReadonlyMap<string, Type>,
    expandingAliases: readonly string[],
  ): Type {
    if (reference.name === "$tuple") {
      return {
        kind: "constructor",
        name: "tuple",
        arguments: reference.arguments.map((argument) =>
          this.#typeReference(argument, parameters, expandingAliases)
        ),
      };
    }
    if (reference.name === "$function" && reference.arguments.length === 2) {
      const parameter = this.#typeReference(
        reference.arguments[0],
        parameters,
        expandingAliases,
      );
      const result = this.#typeReference(
        reference.arguments[1],
        parameters,
        expandingAliases,
      );
      return parameter.kind === "constructor" && parameter.name === "tuple"
        ? functionType(parameter.arguments, result)
        : functionType([parameter], result);
    }
    const parameter = parameters.get(reference.name);
    if (parameter !== undefined) {
      if (reference.arguments.length !== 0) {
        throw new TypeError(
          `${this.#file}:${reference.span.start}: Ducklang type parameter ${reference.name} cannot take arguments`,
        );
      }
      return parameter;
    }
    if (
      reference.name === "Int" || reference.name === "I32" ||
      reference.name === "Char"
    ) {
      return i32Type;
    }
    if (reference.name === "I64") return i64Type;
    if (reference.name === "F32") return f32Type;
    if (reference.name === "F64") return f64Type;
    if (reference.name === "F32x4") return f32x4Type;
    if (reference.name === "Bool") return booleanType;
    if (reference.name === "Text") return textType;
    if (reference.name === "Bytes") return bytesType;
    if (reference.name === "Unit") return unitType;
    if (reference.name === "typeDescriptor") return typeDescriptorType;
    if (/^U(?:[1-9]|[12][0-9]|3[01])$/.test(reference.name)) return i32Type;
    const structDeclaration =
      this.#structTypes.find((candidate) =>
        candidate.name === reference.name &&
        candidate.span.file === reference.span.file
      ) ?? this.#structTypes.find((candidate) =>
        candidate.name === reference.name
      );
    if (structDeclaration !== undefined) {
      const arguments_ = reference.arguments.length === 0
        ? structDeclaration.parameters.map(() => this.#freshVariable())
        : reference.arguments.map((argument) =>
          this.#typeReference(argument, parameters, expandingAliases)
        );
      if (arguments_.length !== structDeclaration.parameters.length) {
        throw new TypeError(
          `${this.#file}:${reference.span.start}: Ducklang struct ${reference.name} expects ${structDeclaration.parameters.length} arguments; received ${reference.arguments.length}`,
        );
      }
      return {
        kind: "constructor",
        name: reference.name,
        arguments: arguments_,
      };
    }
    let arguments_ = reference.arguments.map((argument) =>
      this.#typeReference(argument, parameters, expandingAliases)
    );
    const alias =
      this.#typeAliases.find((candidate) =>
        candidate.name === reference.name &&
        candidate.span.file === reference.span.file
      ) ?? this.#typeAliases.find((candidate) =>
        candidate.name === reference.name
      );
    if (alias !== undefined) {
      if (arguments_.length === 0 && alias.parameters.length > 0) {
        arguments_ = alias.parameters.map(() => this.#freshVariable());
      }
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
    const declaration =
      this.#unionTypes.find((candidate) =>
        candidate.name === reference.name &&
        candidate.span.file === reference.span.file
      ) ?? this.#unionTypes.find((candidate) =>
        candidate.name === reference.name
      );
    if (declaration === undefined) {
      throw new TypeError(
        `${reference.span.file}:${reference.span.start}: unknown Ducklang type ${reference.name}`,
      );
    }
    if (arguments_.length === 0 && declaration.parameters.length > 0) {
      arguments_ = declaration.parameters.map(() => this.#freshVariable());
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
    requiredEffects: readonly DucklangEffectReference[],
  ): TypedDucklangModule {
    for (const variable of this.#numericVariables) {
      const applied = this.#apply({ kind: "variable", id: variable });
      if (applied.kind === "variable") {
        this.#substitutions.set(applied.id, i32Type);
      }
    }
    for (const variable of this.#bottomVariables) {
      const applied = this.#apply({ kind: "variable", id: variable });
      if (applied.kind === "variable") {
        this.#substitutions.set(applied.id, unitType);
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
      exportNames: this.#exportNames,
      bindings: normalizedBindings,
      result: normalizedResult,
      resultType: this.#apply(result.type),
      equalities: this.#equalities,
      symbolTypes: new Map(
        [...this.#symbolTypes].map(([id, type]) => [id, this.#apply(type)]),
      ),
      effectDeclarations: this.#effectDeclarations,
      requiredEffects,
      initFields: this.#initFields,
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
      case "float32":
      case "float64":
      case "boolean":
      case "unit":
      case "string":
      case "intrinsic":
      case "primitive":
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
      case "namedProject": {
        const product = this.#normalizeExpression(expression.product);
        const index = this.#namedFieldIndex(
          this.#apply(product.type),
          expression.fieldName,
        );
        return index === undefined ? { ...expression, product, type } : {
          kind: "project",
          product,
          index,
          type,
          span: expression.span,
        };
      }
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
      case "index": {
        const collection = this.#normalizeExpression(expression.collection);
        const namedFields = type.kind === "variable"
          ? this.#namedFieldConstraints.get(type.id)
          : undefined;
        const structuralFields = type.kind === "constructor"
          ? structuralRecordFieldNames(type.name)
          : undefined;
        const entryProjection = expression.entryProjection === true &&
          (namedFields?.has("name") === true &&
              namedFields.has("value") ||
            structuralFields?.includes("name") === true &&
              structuralFields.includes("value"));
        return {
          ...expression,
          collection,
          index: this.#normalizeExpression(expression.index),
          entryProjection,
          type,
        };
      }
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

  #freshBottomVariable(): Type {
    const type = this.#freshVariable();
    if (type.kind === "variable") {
      this.#bottomVariables.add(type.id);
    }
    return type;
  }

  #unifyReturnTypes(expression: TypedDucklangExpression, result: Type): void {
    switch (expression.kind) {
      case "return":
        this.#unify(expression.expression.type, result, expression.span);
        return;
      case "hostCall":
        for (const argument of expression.arguments) {
          this.#unifyReturnTypes(argument, result);
        }
        return;
      case "function":
      case "integer":
      case "integer64":
      case "float32":
      case "float64":
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
      const fields = this.#productConstraints.get(left.id);
      if (fields !== undefined) {
        if (right.kind === "variable") {
          const rightFields = this.#productConstraints.get(right.id);
          if (rightFields === undefined) {
            this.#productConstraints.set(right.id, fields);
          } else {
            if (rightFields.length !== fields.length) {
              throw new TypeError(
                `${span.file}:${span.start}: Ducklang product constraints require both arity ${fields.length} and ${rightFields.length}`,
              );
            }
            for (let index = 0; index < fields.length; index += 1) {
              this.#unify(fields[index], rightFields[index], span);
            }
          }
        } else {
          const rightFields = this.#productFieldTypes(right, fields.length);
          if (rightFields === undefined) {
            throw new TypeError(
              `${span.file}:${span.start}: Ducklang destructuring expects a product with ${fields.length} fields; received ${
                formatDucklangType(right)
              }`,
            );
          }
          for (let index = 0; index < fields.length; index += 1) {
            this.#unify(fields[index], rightFields[index], span);
          }
        }
      }
      const indexedElement = this.#indexedElementTypes.get(left.id);
      if (indexedElement !== undefined) {
        if (right.kind === "variable") {
          const rightElement = this.#indexedElementTypes.get(right.id);
          if (rightElement === undefined) {
            this.#indexedElementTypes.set(right.id, indexedElement);
          } else {
            this.#unify(indexedElement, rightElement, span);
          }
        } else {
          const rightElement = this.#indexElementType(
            right,
            span,
            indexedElement,
          );
          if (rightElement === undefined) {
            throw new TypeError(
              `${span.file}:${span.start}: Ducklang indexing requires a buffer or homogeneous product; received ${
                formatDucklangType(right)
              }`,
            );
          }
          this.#unify(indexedElement, rightElement, span);
        }
      }
      const namedFields = this.#namedFieldConstraints.get(left.id);
      if (namedFields !== undefined) {
        if (right.kind === "variable") {
          let rightFields = this.#namedFieldConstraints.get(right.id);
          if (rightFields === undefined) {
            rightFields = new Map();
            this.#namedFieldConstraints.set(right.id, rightFields);
          }
          for (const [name, fieldType] of namedFields) {
            const rightFieldType = rightFields.get(name);
            if (rightFieldType === undefined) {
              rightFields.set(name, fieldType);
            } else {
              this.#unify(fieldType, rightFieldType, span);
            }
          }
        } else {
          for (const [name, fieldType] of namedFields) {
            const concreteFieldType = this.#namedFieldType(right, name);
            if (concreteFieldType === undefined) {
              throw new TypeError(
                `${span.file}:${span.start}: Ducklang value of type ${
                  formatDucklangType(right)
                } has no field ${name}`,
              );
            }
            this.#unify(fieldType, concreteFieldType, span);
          }
        }
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

  #productFieldTypes(
    type: Type,
    arity: number,
  ): readonly Type[] | undefined {
    const applied = this.#apply(type);
    if (applied.kind !== "constructor") return undefined;
    if (applied.name === "tuple") {
      return applied.arguments.length === arity ? applied.arguments : undefined;
    }
    if (applied.name === "array" && applied.arguments.length === 1) {
      return Array.from({ length: arity }, () => applied.arguments[0]);
    }
    const declaration = this.#structTypes.find((candidate) =>
      candidate.name === applied.name
    );
    if (declaration === undefined || declaration.fields.length !== arity) {
      return undefined;
    }
    return declaration.fields.map((field) =>
      this.#structFieldType(declaration, applied, field.type)
    );
  }

  #indexElementType(
    type: Type,
    span: SourceSpan,
    expectedElement?: Type,
  ): Type | undefined {
    const applied = this.#apply(type);
    const appliedExpected = expectedElement === undefined
      ? undefined
      : this.#apply(expectedElement);
    const expectedFields = appliedExpected?.kind === "variable"
      ? this.#namedFieldConstraints.get(appliedExpected.id)
      : undefined;
    const expectedFieldNames = appliedExpected?.kind === "constructor"
      ? structuralRecordFieldNames(appliedExpected.name)
      : undefined;
    if (
      applied.kind === "constructor" &&
      (applied.name === "compileTimeProduct" ||
        structuralRecordFieldNames(applied.name) !== undefined ||
        (expectedFields?.has("name") === true &&
          expectedFields.has("value")) ||
        (expectedFieldNames?.includes("name") === true &&
          expectedFieldNames.includes("value")))
    ) {
      return {
        kind: "constructor",
        name: structuralRecordTypeName(["name", "value"]),
        arguments: [textType, this.#freshVariable()],
      };
    }
    if (
      applied.kind === "constructor" &&
      (applied.name === "text" || applied.name === "bytes")
    ) {
      return i32Type;
    }
    if (
      applied.kind === "constructor" && applied.name === "array" &&
      applied.arguments.length === 1
    ) {
      return applied.arguments[0];
    }
    const fields = this.#productFieldTypes(
      applied,
      applied.kind === "constructor" && applied.name === "tuple"
        ? applied.arguments.length
        : this.#structTypes.find((candidate) =>
          applied.kind === "constructor" && candidate.name === applied.name
        )?.fields.length ?? 0,
    );
    if (fields === undefined || fields.length === 0) return undefined;
    const first = fields[0];
    for (const field of fields.slice(1)) this.#unify(first, field, span);
    return first;
  }

  #namedFieldType(type: Type, fieldName: string): Type | undefined {
    const applied = this.#apply(type);
    if (applied.kind !== "constructor") return undefined;
    const structuralNames = structuralRecordFieldNames(applied.name);
    if (structuralNames !== undefined) {
      const index = structuralNames.indexOf(fieldName);
      return index < 0 ? undefined : applied.arguments[index];
    }
    const declaration = this.#structTypes.find((candidate) =>
      candidate.name === applied.name
    );
    const field = declaration?.fields.find((candidate) =>
      candidate.name === fieldName
    );
    return declaration === undefined || field === undefined
      ? undefined
      : this.#structFieldType(declaration, applied, field.type);
  }

  #namedFieldIndex(type: Type, fieldName: string): number | undefined {
    const applied = this.#apply(type);
    if (applied.kind !== "constructor") return undefined;
    const structuralNames = structuralRecordFieldNames(applied.name);
    if (structuralNames !== undefined) {
      const index = structuralNames.indexOf(fieldName);
      return index < 0 ? undefined : index;
    }
    const declaration = this.#structTypes.find((candidate) =>
      candidate.name === applied.name
    );
    const index = declaration?.fields.findIndex((candidate) =>
      candidate.name === fieldName
    );
    return index === undefined || index < 0 ? undefined : index;
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

const structuralRecordPrefix = "$record:";

function structuralRecordTypeName(fieldNames: readonly string[]): string {
  return structuralRecordPrefix + JSON.stringify(fieldNames);
}

function structuralRecordFieldNames(
  typeName: string,
): readonly string[] | undefined {
  if (!typeName.startsWith(structuralRecordPrefix)) return undefined;
  const parsed: unknown = JSON.parse(
    typeName.slice(structuralRecordPrefix.length),
  );
  if (
    !Array.isArray(parsed) ||
    !parsed.every((fieldName) => typeof fieldName === "string")
  ) {
    throw new TypeError(`invalid structural record type ${typeName}`);
  }
  return parsed;
}

function sourceTypeName(type: Type): string {
  if (type.kind !== "constructor") return formatDucklangType(type);
  if (type.name === "i32") return "Int";
  if (type.name === "i64") return "I64";
  if (type.name === "f32") return "F32";
  if (type.name === "f64") return "F64";
  if (type.name === "f32x4") return "F32x4";
  if (type.name === "bool") return "Bool";
  if (type.name === "text") return "Text";
  if (type.name === "bytes") return "Bytes";
  if (type.name === "unit") return "Unit";
  return formatDucklangType(type);
}

function isScalarNumericType(
  type: Type,
): type is Extract<Type, { readonly kind: "constructor" }> {
  return type.kind === "constructor" &&
    ["i32", "i64", "f32", "f64"].includes(type.name) &&
    type.arguments.length === 0;
}

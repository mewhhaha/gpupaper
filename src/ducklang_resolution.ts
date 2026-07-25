import type {
  DucklangEffectOperation,
  DucklangEffectRow,
  DucklangExpression,
  DucklangInitField,
  DucklangModule,
  DucklangName,
  DucklangStatement,
  DucklangStructField,
  DucklangTypeReference,
  DucklangUnionCase,
} from "./ducklang_ast.ts";
import type { SourceSpan } from "./syntax.ts";
import { type ModuleId, moduleId } from "./ducklang_module_graph.ts";
import {
  PrimitiveId,
  type PrimitiveId as PrimitiveIdType,
  resolveImportedPrimitive,
  resolveSourcePrimitive,
} from "./ducklang_primitives.ts";

export type DucklangSymbol = {
  readonly id: number;
  readonly moduleId: ModuleId;
  readonly text: string;
  readonly scope: "module" | "parameter" | "local";
  readonly declaredType?: string;
  readonly declaredEffectRow?: DucklangEffectRow | null;
  readonly identityPolymorphic?: boolean;
  readonly linear?: boolean;
  readonly span: SourceSpan;
};

export type ResolvedDucklangExpression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "integer64";
    readonly value: bigint;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "float32";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "float64";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "boolean";
    readonly value: boolean;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unit";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "string";
    readonly value: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "intrinsic";
    readonly modulePath: string;
    readonly exportName: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "primitive";
    readonly primitiveId: PrimitiveIdType;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "hostCall";
    readonly effectName: string;
    readonly operationName: string;
    readonly arguments: readonly ResolvedDucklangExpression[];
    readonly operation: DucklangEffectOperation;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "optionDo";
    readonly option: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionCase";
    readonly caseName: string;
    readonly value: ResolvedDucklangExpression;
    readonly nominalType?: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "product";
    readonly productKind: "tuple" | "array";
    readonly values: readonly ResolvedDucklangExpression[];
    readonly nominalType?: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "field";
    readonly product: ResolvedDucklangExpression;
    readonly fieldName: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "recordUpdate";
    readonly product: ResolvedDucklangExpression;
    readonly fields: readonly {
      readonly name: string;
      readonly value: ResolvedDucklangExpression;
      readonly span: SourceSpan;
    }[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly value: ResolvedDucklangExpression;
      readonly span: SourceSpan;
    }[];
    readonly nominalType?: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "project";
    readonly product: ResolvedDucklangExpression;
    readonly index: number;
    readonly arity?: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "reference";
    readonly symbol: DucklangSymbol;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "function";
    readonly recursive: boolean;
    readonly parameters: readonly DucklangSymbol[];
    readonly parameterTypeSources?: readonly ResolvedDucklangExpression[];
    readonly declaredResultType?: string;
    readonly body: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "call";
    readonly callee: ResolvedDucklangExpression;
    readonly arguments: readonly ResolvedDucklangExpression[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "index";
    readonly collection: ResolvedDucklangExpression;
    readonly index: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "indexUpdate";
    readonly product: ResolvedDucklangExpression;
    readonly index: ResolvedDucklangExpression;
    readonly value: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: string;
    readonly left: ResolvedDucklangExpression;
    readonly right: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unary";
    readonly operator: string;
    readonly operand: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "return";
    readonly expression: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: ResolvedDucklangExpression;
    readonly consequence: ResolvedDucklangExpression;
    readonly alternative: ResolvedDucklangExpression | undefined;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "ifUnion";
    readonly caseName: string;
    readonly payloadSymbol: DucklangSymbol | undefined;
    readonly value: ResolvedDucklangExpression;
    readonly consequence: ResolvedDucklangExpression;
    readonly alternative: ResolvedDucklangExpression | undefined;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "block";
    readonly steps: readonly ResolvedDucklangBlockStep[];
    readonly result: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "comptime";
    readonly context: "explicit" | "valuePattern";
    readonly expression: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "scratch";
    readonly body: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  };

export type ResolvedDucklangBinding = {
  readonly symbol: DucklangSymbol;
  readonly previous: DucklangSymbol | undefined;
  readonly recursive: boolean;
  readonly stage: "compileTime" | "runtime";
  readonly value: ResolvedDucklangExpression;
  readonly span: SourceSpan;
};

export type ResolvedDucklangBlockStep =
  | { readonly kind: "binding"; readonly binding: ResolvedDucklangBinding }
  | {
    readonly kind: "expression";
    readonly expression: ResolvedDucklangExpression;
  };

export type ResolvedDucklangUnionType = {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly cases: readonly DucklangUnionCase[];
  readonly span: SourceSpan;
};

export type ResolvedDucklangTypeAlias = {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly target: DucklangTypeReference;
  readonly span: SourceSpan;
};

export type ResolvedDucklangStructType = {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly fields: readonly DucklangStructField[];
  readonly span: SourceSpan;
};

export type ResolvedDucklangModule = {
  readonly file: string;
  readonly exportNames: readonly string[];
  readonly parameters: readonly DucklangSymbol[];
  readonly bindings: readonly ResolvedDucklangBinding[];
  readonly result: ResolvedDucklangExpression;
  readonly symbols: readonly DucklangSymbol[];
  readonly unionTypes: readonly ResolvedDucklangUnionType[];
  readonly typeAliases: readonly ResolvedDucklangTypeAlias[];
  readonly effects: ReadonlyMap<string, readonly DucklangEffectOperation[]>;
  readonly initFields: readonly DucklangInitField[];
  readonly structTypes: readonly ResolvedDucklangStructType[];
};

type ResolvedStatements = {
  readonly bindings: readonly ResolvedDucklangBinding[];
  readonly steps: readonly ResolvedDucklangBlockStep[];
  readonly result: ResolvedDucklangExpression;
  readonly environment: ReadonlyMap<string, DucklangSymbol>;
};

export function resolveDucklangModule(
  module: DucklangModule,
): ResolvedDucklangModule {
  const resolver = new DucklangResolver(module.file);
  const parameters = resolver.declareModuleParameters(module.parameters);
  const resolved = resolver.resolveStatements(
    module.statements,
    new Map(parameters.map((parameter) => [parameter.text, parameter])),
    "module",
    module.span,
  );
  resolver.requireLinearUses();
  const initializationSteps = resolved.steps.filter((step) =>
    step.kind === "expression"
  );
  return {
    file: module.file,
    exportNames: module.exportNames,
    parameters,
    bindings: resolved.bindings,
    result: initializationSteps.length === 0 ? resolved.result : {
      kind: "block",
      steps: initializationSteps,
      result: resolved.result,
      span: module.span,
    },
    symbols: resolver.symbols,
    unionTypes: resolver.unionTypes,
    typeAliases: resolver.typeAliases,
    effects: resolver.effects,
    initFields: resolver.initFields,
    structTypes: resolver.structTypes,
  };
}

class DucklangResolver {
  readonly #file: string;
  readonly #symbols: DucklangSymbol[] = [];
  readonly #unionTypes: ResolvedDucklangUnionType[] = [];
  readonly #typeAliases: ResolvedDucklangTypeAlias[] = [];
  readonly #effects = new Map<string, readonly DucklangEffectOperation[]>();
  readonly #initFields: DucklangInitField[] = [];
  readonly #structTypes: ResolvedDucklangStructType[] = [];
  readonly #linearUseCounts = new Map<number, number>();

  /**
   * Resolves mutually exclusive branches so each starts from the same linear
   * state, then keeps the highest consumption per value.
   *
   * Linear use was counted once per reference across the whole module, so a value
   * consumed once in each arm of an `if` counted twice and was rejected even
   * though only one arm runs. The roadmap's rule is that exclusive branches may
   * each consume an incoming linear value once.
   *
   * Merging by maximum keeps a value consumed in one arm consumed afterwards, so a
   * later use is still rejected. It deliberately does not require every arm to
   * consume, which would be stricter than the current checker and is a separate
   * question.
   */
  #resolveExclusiveBranches<T>(
    branches: readonly (() => T)[],
  ): readonly T[] {
    const entry = new Map(this.#linearUseCounts);
    const results: T[] = [];
    const merged = new Map(entry);
    const branchStates: Map<number, number>[] = [];
    for (const branch of branches) {
      this.#linearUseCounts.clear();
      for (const [symbol, count] of entry) {
        this.#linearUseCounts.set(symbol, count);
      }
      results.push(branch());
      branchStates.push(new Map(this.#linearUseCounts));
      for (const [symbol, count] of this.#linearUseCounts) {
        merged.set(symbol, Math.max(merged.get(symbol) ?? 0, count));
      }
    }
    // A join must agree on what each linear value has become. If one branch
    // consumed a value and another did not, the state after the join depends on
    // which arm ran, which is exactly what a linear obligation forbids.
    for (const [symbol, count] of merged) {
      if (count === (entry.get(symbol) ?? 0)) continue;
      for (const [index, branchCounts] of branchStates.entries()) {
        if ((branchCounts.get(symbol) ?? 0) === count) continue;
        const declared = this.#symbols.find((candidate) =>
          candidate.id === symbol
        );
        throw new TypeError(
          `${this.#file}:${declared?.span.start ?? 0}: linear Ducklang value ${
            declared?.text ?? symbol
          } is consumed on some paths but not branch ${index + 1}`,
        );
      }
    }
    this.#linearUseCounts.clear();
    for (const [symbol, count] of merged) {
      this.#linearUseCounts.set(symbol, count);
    }
    return results;
  }
  readonly #bindingStages = new Map<
    number,
    ResolvedDucklangBinding["stage"]
  >();
  readonly #primitiveSymbols = new Map<number, PrimitiveIdType>();
  #resolvingValuePattern = false;

  constructor(file: string) {
    this.#file = file;
  }

  get symbols(): readonly DucklangSymbol[] {
    return this.#symbols;
  }

  get unionTypes(): ResolvedDucklangModule["unionTypes"] {
    return this.#unionTypes;
  }

  get typeAliases(): ResolvedDucklangModule["typeAliases"] {
    return this.#typeAliases;
  }

  get effects(): ResolvedDucklangModule["effects"] {
    return this.#effects;
  }

  get initFields(): ResolvedDucklangModule["initFields"] {
    return this.#initFields;
  }

  get structTypes(): ResolvedDucklangModule["structTypes"] {
    return this.#structTypes;
  }

  declareModuleParameters(
    parameters: readonly DucklangName[],
  ): readonly DucklangSymbol[] {
    const names = new Set<string>();
    return parameters.map((parameter) => {
      if (names.has(parameter.text)) {
        throw new SyntaxError(
          `${this.#file}:${parameter.span.start}: duplicate Ducklang module parameter ${parameter.text}`,
        );
      }
      names.add(parameter.text);
      return this.#declare(parameter, "parameter");
    });
  }

  requireLinearUses(): void {
    for (const symbol of this.#symbols) {
      if (!symbol.linear) continue;
      if ((this.#linearUseCounts.get(symbol.id) ?? 0) > 0) continue;
      throw new TypeError(
        `${this.#file}:${symbol.span.start}: linear Ducklang value ${symbol.text} was not consumed`,
      );
    }
  }

  resolveStatements(
    statements: readonly DucklangStatement[],
    initialEnvironment: ReadonlyMap<string, DucklangSymbol>,
    scope: "module" | "local",
    span: SourceSpan,
    currentRecursive: DucklangSymbol | undefined = undefined,
  ): ResolvedStatements {
    const environment = new Map(initialEnvironment);
    const bindings: ResolvedDucklangBinding[] = [];
    const steps: ResolvedDucklangBlockStep[] = [];
    let result: ResolvedDucklangExpression | undefined;

    for (const [index, statement] of statements.entries()) {
      if (statement.kind === "initDeclaration") {
        if (scope !== "module") {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: Ducklang Init declarations must be module-level`,
          );
        }
        if (this.#initFields.length > 0) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: duplicate Ducklang Init declaration`,
          );
        }
        const names = new Set<string>();
        const effectFields = new Map<string, string>();
        for (const field of statement.fields) {
          if (names.has(field.name)) {
            throw new SyntaxError(
              `${this.#file}:${field.span.start}: duplicate Ducklang Init field ${field.name}`,
            );
          }
          names.add(field.name);
          if (!this.#effects.has(field.effectName)) {
            throw new TypeError(
              `${this.#file}:${field.span.start}: Ducklang Init field ${field.name} references unknown effect ${field.effectName}`,
            );
          }
          const existingField = effectFields.get(field.effectName);
          if (existingField !== undefined) {
            throw new TypeError(
              `${this.#file}:${field.span.start}: Ducklang Init fields ${existingField} and ${field.name} both grant effect ${field.effectName}`,
            );
          }
          effectFields.set(field.effectName, field.name);
          this.#initFields.push(field);
        }
        this.#structTypes.push({
          name: "Init",
          parameters: [],
          fields: statement.fields.map((field) => ({
            name: field.name,
            type: { name: "I32", arguments: [], span: field.span },
            span: field.span,
          })),
          span: statement.span,
        });
        continue;
      }
      if (statement.kind === "recursiveGroup") {
        const names = new Set<string>();
        const symbols = statement.bindings.map((binding) => {
          if (names.has(binding.name.text)) {
            throw new SyntaxError(
              `${this.#file}:${binding.name.span.start}: duplicate Ducklang recursive binding ${binding.name.text}`,
            );
          }
          names.add(binding.name.text);
          return this.#declare(binding.name, scope);
        });
        for (const symbol of symbols) environment.set(symbol.text, symbol);
        for (
          const [bindingIndex, sourceBinding] of statement.bindings.entries()
        ) {
          const symbol = symbols[bindingIndex];
          const binding = {
            symbol,
            previous: undefined,
            recursive: true,
            stage: statement.declarationKind === "const"
              ? "compileTime"
              : "runtime",
            value: this.#resolveExpression(
              sourceBinding.value,
              environment,
              symbol,
            ),
            span: sourceBinding.span,
          } satisfies ResolvedDucklangBinding;
          this.#bindingStages.set(binding.symbol.id, binding.stage);
          bindings.push(binding);
          steps.push({ kind: "binding", binding });
        }
        continue;
      }
      if (statement.kind === "effectDeclaration") {
        if (scope !== "module") {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: Ducklang effect declarations must be module-level`,
          );
        }
        if (this.#effects.has(statement.name)) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: duplicate Ducklang effect ${statement.name}`,
          );
        }
        const operationNames = new Set<string>();
        for (const operation of statement.operations) {
          if (operationNames.has(operation.name)) {
            throw new SyntaxError(
              `${this.#file}:${operation.span.start}: duplicate Ducklang effect operation ${statement.name}.${operation.name}`,
            );
          }
          operationNames.add(operation.name);
        }
        this.#effects.set(statement.name, statement.operations);
        continue;
      }
      if (statement.kind === "structType") {
        if (scope !== "module") {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: Ducklang struct declarations must be module-level`,
          );
        }
        const duplicate = this.#structTypes.some((declaration) =>
          declaration.name === statement.name &&
          declaration.span.file === statement.span.file
        ) || this.#unionTypes.some((declaration) =>
          declaration.name === statement.name &&
          declaration.span.file === statement.span.file
        ) || this.#typeAliases.some((declaration) =>
          declaration.name === statement.name &&
          declaration.span.file === statement.span.file
        );
        if (duplicate) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: duplicate Ducklang type ${statement.name}`,
          );
        }
        const fieldNames = new Set<string>();
        for (const field of statement.fields) {
          if (fieldNames.has(field.name)) {
            throw new SyntaxError(
              `${this.#file}:${field.span.start}: duplicate Ducklang field ${statement.name}.${field.name}`,
            );
          }
          fieldNames.add(field.name);
        }
        this.#structTypes.push(statement);
        continue;
      }
      if (statement.kind === "unionType") {
        if (scope !== "module") {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: Ducklang type declarations must be module-level`,
          );
        }
        if (
          this.#unionTypes.some((declaration) =>
            declaration.name === statement.name &&
            declaration.span.file === statement.span.file
          ) || this.#typeAliases.some((alias) =>
            alias.name === statement.name &&
            alias.span.file === statement.span.file
          ) ||
          this.#structTypes.some((declaration) =>
            declaration.name === statement.name &&
            declaration.span.file === statement.span.file
          )
        ) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: duplicate Ducklang type ${statement.name}`,
          );
        }
        this.#unionTypes.push(statement);
        continue;
      }
      if (statement.kind === "typeAlias") {
        if (scope !== "module") {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: Ducklang type aliases must be module-level`,
          );
        }
        const duplicate = this.#typeAliases.some((alias) =>
          alias.name === statement.name &&
          alias.span.file === statement.span.file
        ) || this.#unionTypes.some((declaration) =>
          declaration.name === statement.name &&
          declaration.span.file === statement.span.file
        ) || this.#structTypes.some((declaration) =>
          declaration.name === statement.name &&
          declaration.span.file === statement.span.file
        );
        if (duplicate) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: duplicate Ducklang type ${statement.name}`,
          );
        }
        this.#typeAliases.push(statement);
        continue;
      }
      if (statement.kind === "typePattern") {
        const target = this.#resolveExpression(
          statement.target,
          environment,
          currentRecursive,
        );
        const expectedModulePath = `duck:type/${statement.patternKind}`;
        if (
          target.kind !== "intrinsic" ||
          target.modulePath !== expectedModulePath
        ) {
          throw new TypeError(
            `${this.#file}:${statement.target.span.start}: Ducklang ${statement.patternKind} pattern does not match its target`,
          );
        }
        const descriptor = JSON.parse(target.exportName) as {
          readonly fields?: readonly {
            readonly name: string;
            readonly type: string;
          }[];
          readonly cases?: readonly {
            readonly name: string;
            readonly type: string;
          }[];
        };
        const members = descriptor.fields ?? descriptor.cases;
        if (members === undefined) {
          throw new TypeError(
            `${this.#file}:${statement.target.span.start}: Ducklang ${statement.patternKind} target has no members`,
          );
        }
        for (const expected of statement.fields) {
          const actual = members.find((member) =>
            member.name === expected.name
          );
          if (actual?.type !== expected.type) {
            const received = actual === undefined ? "missing" : actual.type;
            throw new TypeError(
              `${this.#file}:${statement.span.start}: Ducklang ${statement.patternKind} pattern field ${expected.name} expects ${expected.type}; received ${received}`,
            );
          }
        }
        if (!statement.open && members.length !== statement.fields.length) {
          throw new TypeError(
            `${this.#file}:${statement.span.start}: closed Ducklang ${statement.patternKind} pattern expects ${statement.fields.length} members; received ${members.length}`,
          );
        }
        continue;
      }
      if (statement.kind === "import") {
        if (statement.namespace !== undefined || statement.open) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: Ducklang local and open imports require module graph resolution`,
          );
        }
        if (
          statement.path === "duck:prelude/effects/defaults" &&
          !this.#unionTypes.some((declaration) => declaration.name === "Option")
        ) {
          const typeParameter = {
            name: "t",
            arguments: [],
            span: statement.span,
          };
          this.#unionTypes.push({
            name: "Option",
            parameters: ["t"],
            cases: [
              {
                name: "Some",
                payloadType: typeParameter,
                span: statement.span,
              },
              {
                name: "None",
                payloadType: {
                  name: "Unit",
                  arguments: [],
                  span: statement.span,
                },
                span: statement.span,
              },
            ],
            span: statement.span,
          });
        }
        for (const selection of statement.selections) {
          if (selection.localName === undefined) continue;
          const symbol = this.#declare(selection.localName, scope);
          environment.set(symbol.text, symbol);
          const primitive = resolveImportedPrimitive(
            statement.path,
            selection.exportName,
          );
          const binding = {
            symbol,
            previous: undefined,
            recursive: false,
            stage: "compileTime",
            value: primitive === undefined
              ? {
                kind: "intrinsic" as const,
                modulePath: statement.path,
                exportName: selection.exportName,
                span: selection.span,
              }
              : {
                kind: "primitive" as const,
                primitiveId: primitive.id,
                span: selection.span,
              },
            span: selection.span,
          } satisfies ResolvedDucklangBinding;
          this.#bindingStages.set(binding.symbol.id, binding.stage);
          if (primitive !== undefined) {
            this.#primitiveSymbols.set(binding.symbol.id, primitive.id);
          }
          bindings.push(binding);
          steps.push({ kind: "binding", binding });
        }
        continue;
      }
      if (statement.kind === "unionBinding") {
        const symbol = this.#declare(statement.name, scope);
        const value: ResolvedDucklangExpression = {
          kind: "ifUnion",
          caseName: statement.caseName,
          payloadSymbol: symbol,
          value: this.#resolveExpression(
            statement.value,
            environment,
            currentRecursive,
          ),
          consequence: {
            kind: "reference",
            symbol,
            span: statement.name.span,
          },
          alternative: this.#resolveExpression(
            statement.alternative,
            environment,
            currentRecursive,
          ),
          span: statement.span,
        };
        environment.set(symbol.text, symbol);
        const binding = {
          symbol,
          previous: undefined,
          recursive: false,
          stage: statement.declarationKind === "const"
            ? "compileTime"
            : "runtime",
          value,
          span: statement.span,
        } satisfies ResolvedDucklangBinding;
        this.#bindingStages.set(binding.symbol.id, binding.stage);
        bindings.push(binding);
        steps.push({ kind: "binding", binding });
        continue;
      }
      if (statement.kind === "productBinding") {
        const stage = statement.declarationKind === "const"
          ? "compileTime"
          : "runtime";
        const productSymbol = this.#declare({
          text: "destructuredProduct",
          span: statement.span,
        }, scope);
        const productBinding = {
          symbol: productSymbol,
          previous: undefined,
          recursive: false,
          stage,
          value: this.#resolveExpression(
            statement.value,
            environment,
            currentRecursive,
          ),
          span: statement.span,
        } satisfies ResolvedDucklangBinding;
        this.#bindingStages.set(productBinding.symbol.id, productBinding.stage);
        bindings.push(productBinding);
        steps.push({ kind: "binding", binding: productBinding });
        for (const [elementIndex, name] of statement.names.entries()) {
          if (name === undefined) continue;
          const symbol = this.#declare(name, scope);
          environment.set(symbol.text, symbol);
          const binding = {
            symbol,
            previous: undefined,
            recursive: false,
            stage,
            value: {
              kind: "project",
              product: {
                kind: "reference",
                symbol: productSymbol,
                span: statement.span,
              },
              index: elementIndex,
              arity: statement.names.length,
              span: name.span,
            },
            span: name.span,
          } satisfies ResolvedDucklangBinding;
          this.#bindingStages.set(binding.symbol.id, binding.stage);
          bindings.push(binding);
          steps.push({ kind: "binding", binding });
        }
        continue;
      }
      if (statement.kind === "recordBinding") {
        const stage = statement.declarationKind === "const"
          ? "compileTime"
          : "runtime";
        const recordSymbol = this.#declare({
          text: "destructuredRecord",
          span: statement.span,
        }, scope);
        const recordBinding = {
          symbol: recordSymbol,
          previous: undefined,
          recursive: false,
          stage,
          value: this.#resolveExpression(
            statement.value,
            environment,
            currentRecursive,
          ),
          span: statement.span,
        } satisfies ResolvedDucklangBinding;
        this.#bindingStages.set(recordBinding.symbol.id, recordBinding.stage);
        bindings.push(recordBinding);
        steps.push({ kind: "binding", binding: recordBinding });
        for (const field of statement.fields) {
          const symbol = this.#declare(field.localName, scope);
          environment.set(symbol.text, symbol);
          const binding = {
            symbol,
            previous: undefined,
            recursive: false,
            stage,
            value: {
              kind: "field",
              product: {
                kind: "reference",
                symbol: recordSymbol,
                span: statement.span,
              },
              fieldName: field.fieldName,
              span: field.localName.span,
            },
            span: field.localName.span,
          } satisfies ResolvedDucklangBinding;
          this.#bindingStages.set(binding.symbol.id, binding.stage);
          bindings.push(binding);
          steps.push({ kind: "binding", binding });
        }
        continue;
      }
      if (
        statement.kind === "forRange" || statement.kind === "forCollection" ||
        statement.kind === "break" || statement.kind === "continue"
      ) {
        throw new TypeError(
          `${this.#file}:${statement.span.start}: dynamic Ducklang ${statement.kind} requires loop IR lowering`,
        );
      }
      if (statement.kind === "expression") {
        const expression = this.#resolveExpression(
          statement.expression,
          environment,
          currentRecursive,
        );
        if (index === statements.length - 1) result = expression;
        else {
          steps.push({ kind: "expression", expression });
        }
        continue;
      }

      if (statement.kind === "return") {
        const expression: ResolvedDucklangExpression = {
          kind: "return",
          expression: this.#resolveExpression(
            statement.expression,
            environment,
            currentRecursive,
          ),
          span: statement.span,
        };
        if (index === statements.length - 1) result = expression;
        else if (scope === "local") {
          steps.push({ kind: "expression", expression });
        } else {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: module-level Ducklang return must be the final statement`,
          );
        }
        continue;
      }

      if (statement.kind === "binding") {
        if (
          scope === "module" && statement.declarationKind === "const" &&
          statement.value.kind === "field" &&
          statement.value.product.kind === "field" &&
          statement.value.product.fieldName === "shape" &&
          statement.value.product.product.kind === "reference"
        ) {
          const structName = statement.value.product.product.name.text;
          const projectedFieldName = statement.value.fieldName;
          const declaration = this.#structTypes.find((candidate) =>
            candidate.name === structName
          );
          const field = declaration?.fields.find((candidate) =>
            candidate.name === projectedFieldName
          );
          if (declaration === undefined || field === undefined) {
            throw new TypeError(
              `${this.#file}:${statement.value.span.start}: Ducklang struct type projection ${structName}.shape.${projectedFieldName} does not name a declared field`,
            );
          }
          const duplicate = this.#typeAliases.some((alias) =>
            alias.name === statement.name.text
          ) || this.#structTypes.some((candidate) =>
            candidate.name === statement.name.text
          ) || this.#unionTypes.some((candidate) =>
            candidate.name === statement.name.text
          );
          if (duplicate) {
            throw new SyntaxError(
              `${this.#file}:${statement.name.span.start}: duplicate Ducklang type ${statement.name.text}`,
            );
          }
          this.#typeAliases.push({
            name: statement.name.text,
            parameters: [],
            target: field.type,
            span: statement.span,
          });
          continue;
        }
        const symbol = this.#declare(statement.name, scope);
        const recursive = statement.recursive ||
          (statement.value.kind === "function" && statement.value.recursive);
        if (recursive) environment.set(symbol.text, symbol);
        const sourceValue = recursive && statement.value.kind === "function"
          ? { ...statement.value, recursive: true }
          : statement.value;
        const value = this.#resolveExpression(
          sourceValue,
          environment,
          recursive ? symbol : currentRecursive,
        );
        environment.set(symbol.text, symbol);
        const binding = {
          symbol,
          previous: undefined,
          recursive,
          stage: statement.declarationKind === "const"
            ? "compileTime"
            : "runtime",
          value,
          span: statement.span,
        } satisfies ResolvedDucklangBinding;
        this.#bindingStages.set(binding.symbol.id, binding.stage);
        bindings.push(binding);
        steps.push({ kind: "binding", binding });
        continue;
      }

      const previous = environment.get(statement.name.text);
      if (previous === undefined) {
        throw new ReferenceError(
          `${this.#file}:${statement.name.span.start}: assignment to ${statement.name.text} has no visible Ducklang binding`,
        );
      }
      const value = this.#resolveExpression(
        statement.value,
        environment,
        currentRecursive,
      );
      const symbol = this.#declare(statement.name, scope);
      environment.set(symbol.text, symbol);
      const binding = {
        symbol,
        previous: statement.operator === "=" ? previous : undefined,
        recursive: false,
        stage: "runtime",
        value,
        span: statement.span,
      } satisfies ResolvedDucklangBinding;
      this.#bindingStages.set(binding.symbol.id, binding.stage);
      bindings.push(binding);
      steps.push({ kind: "binding", binding });
    }

    if (result === undefined) {
      if (scope === "local") {
        return {
          bindings,
          steps,
          result: { kind: "unit", span },
          environment,
        };
      }
      throw new TypeError(
        `${this.#file}:${span.start}: Ducklang block has no result expression`,
      );
    }
    return { bindings, steps, result, environment };
  }

  #resolveExpression(
    expression: DucklangExpression,
    environment: ReadonlyMap<string, DucklangSymbol>,
    currentRecursive: DucklangSymbol | undefined,
  ): ResolvedDucklangExpression {
    switch (expression.kind) {
      case "integer":
      case "integer64":
      case "float32":
      case "float64":
      case "boolean":
      case "string":
      case "unit":
        return expression;
      case "unionCase":
        return {
          ...expression,
          value: this.#resolveExpression(
            expression.value,
            environment,
            currentRecursive,
          ),
        };
      case "product":
        return {
          ...expression,
          values: expression.values.map((value) =>
            this.#resolveExpression(value, environment, currentRecursive)
          ),
        };
      case "field":
        if (
          expression.fieldName === "new" &&
          expression.product.kind === "reference"
        ) {
          const structName = expression.product.name.text;
          if (
            this.#structTypes.some((declaration) =>
              declaration.name === structName
            )
          ) {
            return {
              kind: "intrinsic",
              modulePath: `duck:struct/${structName}`,
              exportName: "new",
              span: expression.span,
            };
          }
        }
        return {
          ...expression,
          product: this.#resolveExpression(
            expression.product,
            environment,
            currentRecursive,
          ),
        };
      case "recordUpdate":
        return {
          ...expression,
          product: this.#resolveExpression(
            expression.product,
            environment,
            currentRecursive,
          ),
          fields: expression.fields.map((field) => ({
            ...field,
            value: this.#resolveExpression(
              field.value,
              environment,
              currentRecursive,
            ),
          })),
        };
      case "record":
        return {
          ...expression,
          fields: expression.fields.map((field) => ({
            ...field,
            value: this.#resolveExpression(
              field.value,
              environment,
              currentRecursive,
            ),
          })),
        };
      case "moduleImport":
        throw new SyntaxError(
          `${this.#file}:${expression.span.start}: Ducklang import expression must initialize a module binding`,
        );
      case "hostCall": {
        const operation = this.#effects.get(expression.effectName)?.find(
          (candidate) => candidate.name === expression.operationName,
        );
        if (operation === undefined) {
          throw new ReferenceError(
            `${this.#file}:${expression.span.start}: unknown Ducklang effect operation ${expression.effectName}.${expression.operationName}`,
          );
        }
        if (operation.parameterTypes.length !== expression.arguments.length) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang effect operation ${expression.effectName}.${expression.operationName} expects ${operation.parameterTypes.length} arguments; received ${expression.arguments.length}`,
          );
        }
        return {
          ...expression,
          operation,
          arguments: expression.arguments.map((argument) =>
            this.#resolveExpression(argument, environment, currentRecursive)
          ),
        };
      }
      case "optionDo":
        return {
          ...expression,
          option: this.#resolveExpression(
            expression.option,
            environment,
            currentRecursive,
          ),
        };
      case "reference": {
        const symbol = environment.get(expression.name.text);
        if (symbol === undefined) {
          const primitive = resolveSourcePrimitive(expression.name.text);
          if (primitive !== undefined) {
            return {
              kind: "primitive",
              primitiveId: primitive.id,
              span: expression.span,
            };
          }
          const syntheticIntrinsic = expression.name.text ===
              "$duck_string_pattern_matches"
            ? {
              modulePath: "duck:compiler/string-pattern",
              exportName: "matches",
            }
            : expression.name.text === "$duck_string_pattern_capture"
            ? {
              modulePath: "duck:compiler/string-pattern",
              exportName: "capture",
            }
            : expression.name.text === "$duck_type_pattern_matches"
            ? {
              modulePath: "duck:compiler/type-pattern",
              exportName: "matches",
            }
            : [
                "Int",
                "I32",
                "I64",
                "Char",
                "Bool",
                "Text",
                "Unit",
              ].includes(expression.name.text)
            ? {
              modulePath: "duck:type/builtin",
              exportName: expression.name.text,
            }
            : undefined;
          if (syntheticIntrinsic !== undefined) {
            return {
              kind: "intrinsic",
              ...syntheticIntrinsic,
              span: expression.span,
            };
          }
          const structDeclaration = this.#structTypes.find((declaration) =>
            declaration.name === expression.name.text
          );
          if (structDeclaration !== undefined) {
            return {
              kind: "intrinsic",
              modulePath: "duck:type/struct",
              exportName: JSON.stringify({
                name: structDeclaration.name,
                fields: structDeclaration.fields.map((field) => ({
                  name: field.name,
                  type: field.type.name,
                })),
              }),
              span: expression.span,
            };
          }
          const unionDeclaration = this.#unionTypes.find((declaration) =>
            declaration.name === expression.name.text
          );
          if (unionDeclaration !== undefined) {
            return {
              kind: "intrinsic",
              modulePath: "duck:type/union",
              exportName: JSON.stringify({
                name: unionDeclaration.name,
                cases: unionDeclaration.cases.map((unionCase) => ({
                  name: unionCase.name,
                  type: unionCase.payloadType.name,
                })),
              }),
              span: expression.span,
            };
          }
          throw new ReferenceError(
            `${this.#file}:${expression.span.start}: unknown Ducklang name ${expression.name.text}`,
          );
        }
        if (symbol.linear) {
          const uses = (this.#linearUseCounts.get(symbol.id) ?? 0) + 1;
          if (uses > 1) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: linear Ducklang value ${symbol.text} was already consumed`,
            );
          }
          this.#linearUseCounts.set(symbol.id, uses);
        }
        if (
          this.#resolvingValuePattern &&
          this.#bindingStages.get(symbol.id) !== "compileTime"
        ) {
          throw new TypeError(
            `Value pattern requires a compile-time expression: ${symbol.text}`,
          );
        }
        const primitiveId = this.#primitiveSymbols.get(symbol.id);
        if (primitiveId !== undefined) {
          return {
            kind: "primitive",
            primitiveId,
            span: expression.span,
          };
        }
        return {
          kind: "reference",
          symbol: expression.name.identityPolymorphic
            ? { ...symbol, identityPolymorphic: true }
            : symbol,
          span: expression.span,
        };
      }
      case "function": {
        const functionEnvironment = new Map(environment);
        const parameters: DucklangSymbol[] = [];
        const parameterNames = new Set<string>();
        for (const parameter of expression.parameters) {
          if (parameterNames.has(parameter.text)) {
            throw new SyntaxError(
              `${this.#file}:${parameter.span.start}: duplicate Ducklang parameter ${parameter.text}`,
            );
          }
          parameterNames.add(parameter.text);
          const symbol = this.#declare(parameter, "parameter");
          functionEnvironment.set(symbol.text, symbol);
          parameters.push(symbol);
        }
        return {
          kind: "function",
          recursive: expression.recursive,
          parameters,
          ...(expression.parameterTypeSources === undefined ? {} : {
            parameterTypeSources: expression.parameterTypeSources.map((
              source,
            ) =>
              this.#resolveExpression(
                source,
                environment,
                currentRecursive,
              )
            ),
          }),
          ...(expression.declaredResultType === undefined
            ? {}
            : { declaredResultType: expression.declaredResultType }),
          body: this.#resolveExpression(
            expression.body,
            functionEnvironment,
            expression.recursive ? currentRecursive : undefined,
          ),
          span: expression.span,
        };
      }
      case "recursiveCall": {
        if (currentRecursive === undefined) {
          throw new ReferenceError(
            `${this.#file}:${expression.span.start}: recursive call has no enclosing recursive function`,
          );
        }
        return {
          kind: "call",
          callee: {
            kind: "reference",
            symbol: currentRecursive,
            span: expression.span,
          },
          arguments: expression.arguments.map((argument) =>
            this.#resolveExpression(
              argument,
              environment,
              currentRecursive,
            )
          ),
          span: expression.span,
        };
      }
      case "call": {
        if (
          expression.callee.kind === "field" &&
          expression.callee.product.kind === "reference"
        ) {
          const structName = expression.callee.product.name.text;
          const memberName = expression.callee.fieldName;
          const primitive = resolveSourcePrimitive(
            `@${structName}.${memberName}`,
          );
          if (primitive !== undefined) {
            return {
              ...expression,
              callee: {
                kind: "primitive",
                primitiveId: primitive.id,
                span: expression.callee.span,
              },
              arguments: expression.arguments.map((argument) =>
                this.#resolveExpression(
                  argument,
                  environment,
                  currentRecursive,
                )
              ),
            };
          }
          const declaration = this.#structTypes.find((candidate) =>
            candidate.name === structName &&
            candidate.span.file === expression.span.file
          ) ?? this.#structTypes.find((candidate) =>
            candidate.name === structName
          );
          const argument = expression.arguments[0];
          if (declaration !== undefined && argument !== undefined) {
            if (
              memberName === "new" &&
              expression.arguments.length === 1 &&
              (argument.kind === "record" || argument.kind === "product")
            ) {
              return this.#resolveExpression(
                { ...argument, nominalType: structName },
                environment,
                currentRecursive,
              );
            }
            const structArguments =
              expression.arguments.length === 1 && argument.kind === "product"
                ? argument.values
                : expression.arguments;
            if (
              memberName === "pack" &&
              structArguments.length === declaration.fields.length
            ) {
              return {
                kind: "product",
                productKind: "tuple",
                nominalType: structName,
                values: structArguments.map((value) =>
                  this.#resolveExpression(value, environment, currentRecursive)
                ),
                span: expression.span,
              };
            }
            const updatedField = memberName.startsWith("with_")
              ? memberName.slice("with_".length)
              : undefined;
            if (
              updatedField !== undefined && structArguments.length === 2
            ) {
              return {
                kind: "recordUpdate",
                product: this.#resolveExpression(
                  structArguments[0],
                  environment,
                  currentRecursive,
                ),
                fields: [{
                  name: updatedField,
                  value: this.#resolveExpression(
                    structArguments[1],
                    environment,
                    currentRecursive,
                  ),
                  span: expression.span,
                }],
                span: expression.span,
              };
            }
            if (
              expression.arguments.length === 1 &&
              declaration.fields.some((field) =>
                field.name === memberName
              )
            ) {
              return {
                kind: "field",
                product: this.#resolveExpression(
                  argument,
                  environment,
                  currentRecursive,
                ),
                fieldName: memberName,
                span: expression.span,
              };
            }
          }
        }
        return {
          ...expression,
          callee: this.#resolveExpression(
            expression.callee,
            environment,
            currentRecursive,
          ),
          arguments: expression.arguments.map((argument) =>
            this.#resolveExpression(argument, environment, currentRecursive)
          ),
        };
      }
      case "index":
        return {
          ...expression,
          collection: this.#resolveExpression(
            expression.collection,
            environment,
            currentRecursive,
          ),
          index: this.#resolveExpression(
            expression.index,
            environment,
            currentRecursive,
          ),
        };
      case "indexUpdate":
        return {
          ...expression,
          product: this.#resolveExpression(
            expression.product,
            environment,
            currentRecursive,
          ),
          index: this.#resolveExpression(
            expression.index,
            environment,
            currentRecursive,
          ),
          value: this.#resolveExpression(
            expression.value,
            environment,
            currentRecursive,
          ),
        };
      case "binary": {
        const primitiveId = {
          "&&&": PrimitiveId.bitAnd,
          "|||": PrimitiveId.bitOr,
          "^^^": PrimitiveId.bitXor,
          "<<": PrimitiveId.shiftLeft,
          ">>": PrimitiveId.shiftRightUnsigned,
        }[expression.operator];
        if (primitiveId !== undefined) {
          return {
            kind: "call",
            callee: {
              kind: "primitive",
              primitiveId,
              span: expression.span,
            },
            arguments: [
              this.#resolveExpression(
                expression.left,
                environment,
                currentRecursive,
              ),
              this.#resolveExpression(
                expression.right,
                environment,
                currentRecursive,
              ),
            ],
            span: expression.span,
          };
        }
        return {
          ...expression,
          left: this.#resolveExpression(
            expression.left,
            environment,
            currentRecursive,
          ),
          right: this.#resolveExpression(
            expression.right,
            environment,
            currentRecursive,
          ),
        };
      }
      case "unary":
        return {
          ...expression,
          operand: this.#resolveExpression(
            expression.operand,
            environment,
            currentRecursive,
          ),
        };
      case "if": {
        const condition = this.#resolveExpression(
          expression.condition,
          environment,
          currentRecursive,
        );
        const [consequence, alternative] = this.#resolveExclusiveBranches([
          () =>
            this.#resolveExpression(
              expression.consequence,
              environment,
              currentRecursive,
            ),
          () =>
            expression.alternative === undefined ? undefined : this
              .#resolveExpression(
                expression.alternative,
                environment,
                currentRecursive,
              ),
        ]);
        return {
          ...expression,
          condition,
          consequence: consequence as ResolvedDucklangExpression,
          alternative: alternative as ResolvedDucklangExpression | undefined,
        };
      }
      case "ifUnion": {
        const consequenceEnvironment = new Map(environment);
        const payloadSymbol = expression.payloadName === undefined
          ? undefined
          : this.#declare(expression.payloadName, "local");
        if (payloadSymbol !== undefined) {
          consequenceEnvironment.set(payloadSymbol.text, payloadSymbol);
        }
        const value = this.#resolveExpression(
          expression.value,
          environment,
          currentRecursive,
        );
        // A matched arm and its alternative are mutually exclusive, exactly like
        // the arms of an `if`, so each starts from the same linear state.
        const [consequence, alternative] = this.#resolveExclusiveBranches([
          () =>
            this.#resolveExpression(
              expression.consequence,
              consequenceEnvironment,
              currentRecursive,
            ),
          () =>
            expression.alternative === undefined ? undefined : this
              .#resolveExpression(
                expression.alternative,
                environment,
                currentRecursive,
              ),
        ]);
        return {
          kind: "ifUnion",
          caseName: expression.caseName,
          payloadSymbol,
          value,
          consequence: consequence as ResolvedDucklangExpression,
          alternative: alternative as ResolvedDucklangExpression | undefined,
          span: expression.span,
        };
      }
      case "block": {
        const resolved = this.resolveStatements(
          expression.statements,
          environment,
          "local",
          expression.span,
          currentRecursive,
        );
        return {
          kind: "block",
          steps: resolved.steps,
          result: resolved.result,
          span: expression.span,
        };
      }
      case "comptime": {
        const previousValuePattern = this.#resolvingValuePattern;
        if (expression.context === "valuePattern") {
          this.#resolvingValuePattern = true;
        }
        try {
          return {
            ...expression,
            expression: this.#resolveExpression(
              expression.expression,
              environment,
              currentRecursive,
            ),
          };
        } finally {
          this.#resolvingValuePattern = previousValuePattern;
        }
      }
      case "scratch":
        return {
          ...expression,
          body: this.#resolveExpression(
            expression.body,
            environment,
            currentRecursive,
          ),
        };
      case "loop":
        throw new SyntaxError(
          `${this.#file}:${expression.span.start}: dynamic Ducklang loop expression requires loop IR lowering`,
        );
    }
  }

  #declare(
    name: DucklangName,
    scope: DucklangSymbol["scope"],
  ): DucklangSymbol {
    const symbol = {
      id: this.#symbols.length,
      moduleId: moduleId(name.span.file),
      text: name.text,
      scope,
      ...(name.declaredType === undefined
        ? {}
        : { declaredType: name.declaredType }),
      ...(name.declaredEffectRow === undefined
        ? {}
        : { declaredEffectRow: name.declaredEffectRow }),
      ...(name.identityPolymorphic === undefined
        ? {}
        : { identityPolymorphic: name.identityPolymorphic }),
      ...(name.linear === undefined ? {} : { linear: name.linear }),
      span: name.span,
    } satisfies DucklangSymbol;
    this.#symbols.push(symbol);
    return symbol;
  }
}

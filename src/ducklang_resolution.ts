import type {
  DucklangEffectOperation,
  DucklangExpression,
  DucklangModule,
  DucklangName,
  DucklangStatement,
  DucklangStructField,
  DucklangTypeReference,
  DucklangUnionCase,
} from "./ducklang_ast.ts";
import type { SourceSpan } from "./syntax.ts";

export type DucklangSymbol = {
  readonly id: number;
  readonly text: string;
  readonly scope: "module" | "parameter" | "local";
  readonly declaredType?: string;
  readonly identityPolymorphic?: boolean;
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
  readonly fields: readonly DucklangStructField[];
  readonly span: SourceSpan;
};

export type ResolvedDucklangModule = {
  readonly file: string;
  readonly bindings: readonly ResolvedDucklangBinding[];
  readonly result: ResolvedDucklangExpression;
  readonly symbols: readonly DucklangSymbol[];
  readonly unionTypes: readonly ResolvedDucklangUnionType[];
  readonly typeAliases: readonly ResolvedDucklangTypeAlias[];
  readonly effects: ReadonlyMap<string, readonly DucklangEffectOperation[]>;
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
  const resolved = resolver.resolveStatements(
    module.statements,
    new Map(),
    "module",
    module.span,
  );
  return {
    file: module.file,
    bindings: resolved.bindings,
    result: resolved.result,
    symbols: resolver.symbols,
    unionTypes: resolver.unionTypes,
    typeAliases: resolver.typeAliases,
    effects: resolver.effects,
    structTypes: resolver.structTypes,
  };
}

class DucklangResolver {
  readonly #file: string;
  readonly #symbols: DucklangSymbol[] = [];
  readonly #unionTypes: ResolvedDucklangUnionType[] = [];
  readonly #typeAliases: ResolvedDucklangTypeAlias[] = [];
  readonly #effects = new Map<string, readonly DucklangEffectOperation[]>();
  readonly #structTypes: ResolvedDucklangStructType[] = [];

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

  get structTypes(): ResolvedDucklangModule["structTypes"] {
    return this.#structTypes;
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
          declaration.name === statement.name
        ) || this.#unionTypes.some((declaration) =>
          declaration.name === statement.name
        ) || this.#typeAliases.some((declaration) =>
          declaration.name === statement.name
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
            declaration.name === statement.name
          ) || this.#typeAliases.some((alias) =>
            alias.name === statement.name
          ) ||
          this.#structTypes.some((declaration) =>
            declaration.name === statement.name
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
          alias.name === statement.name
        ) || this.#unionTypes.some((declaration) =>
          declaration.name === statement.name
        ) || this.#structTypes.some((declaration) =>
          declaration.name === statement.name
        );
        if (duplicate) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: duplicate Ducklang type ${statement.name}`,
          );
        }
        this.#typeAliases.push(statement);
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
          const binding = {
            symbol,
            previous: undefined,
            recursive: false,
            stage: "compileTime",
            value: {
              kind: "intrinsic",
              modulePath: statement.path,
              exportName: selection.exportName,
              span: selection.span,
            },
            span: selection.span,
          } satisfies ResolvedDucklangBinding;
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
            value: statement.productKind === "tuple"
              ? {
                kind: "project",
                product: {
                  kind: "reference",
                  symbol: productSymbol,
                  span: statement.span,
                },
                index: elementIndex,
                span: name.span,
              }
              : {
                kind: "index",
                collection: {
                  kind: "reference",
                  symbol: productSymbol,
                  span: statement.span,
                },
                index: {
                  kind: "integer",
                  value: elementIndex,
                  span: name.span,
                },
                span: name.span,
              },
            span: name.span,
          } satisfies ResolvedDucklangBinding;
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
        else if (scope === "local") {
          steps.push({ kind: "expression", expression });
        } else {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: module-level Ducklang expressions require ordered module initialization`,
          );
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
        const value = this.#resolveExpression(
          statement.value,
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
      bindings.push(binding);
      steps.push({ kind: "binding", binding });
    }

    if (result === undefined) {
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
          throw new ReferenceError(
            `${this.#file}:${expression.span.start}: unknown Ducklang name ${expression.name.text}`,
          );
        }
        return { kind: "reference", symbol, span: expression.span };
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
          const declaration = this.#structTypes.find((candidate) =>
            candidate.name === structName
          );
          const argument = expression.arguments[0];
          if (declaration !== undefined && argument !== undefined) {
            if (
              memberName === "pack" &&
              expression.arguments.length === 1 && argument.kind === "product"
            ) {
              return {
                ...argument,
                productKind: "tuple",
                nominalType: structName,
                values: argument.values.map((value) =>
                  this.#resolveExpression(value, environment, currentRecursive)
                ),
              };
            }
            const updatedField = memberName.startsWith("with_")
              ? memberName.slice("with_".length)
              : undefined;
            if (
              updatedField !== undefined && expression.arguments.length === 1 &&
              argument.kind === "product" && argument.values.length === 2
            ) {
              return {
                kind: "recordUpdate",
                product: this.#resolveExpression(
                  argument.values[0],
                  environment,
                  currentRecursive,
                ),
                fields: [{
                  name: updatedField,
                  value: this.#resolveExpression(
                    argument.values[1],
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
              declaration.fields.some((field) => field.name === memberName)
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
      case "binary":
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
      case "unary":
        return {
          ...expression,
          operand: this.#resolveExpression(
            expression.operand,
            environment,
            currentRecursive,
          ),
        };
      case "if":
        return {
          ...expression,
          condition: this.#resolveExpression(
            expression.condition,
            environment,
            currentRecursive,
          ),
          consequence: this.#resolveExpression(
            expression.consequence,
            environment,
            currentRecursive,
          ),
          alternative: expression.alternative === undefined
            ? undefined
            : this.#resolveExpression(
              expression.alternative,
              environment,
              currentRecursive,
            ),
        };
      case "ifUnion": {
        const consequenceEnvironment = new Map(environment);
        const payloadSymbol = expression.payloadName === undefined
          ? undefined
          : this.#declare(expression.payloadName, "local");
        if (payloadSymbol !== undefined) {
          consequenceEnvironment.set(payloadSymbol.text, payloadSymbol);
        }
        return {
          kind: "ifUnion",
          caseName: expression.caseName,
          payloadSymbol,
          value: this.#resolveExpression(
            expression.value,
            environment,
            currentRecursive,
          ),
          consequence: this.#resolveExpression(
            expression.consequence,
            consequenceEnvironment,
            currentRecursive,
          ),
          alternative: expression.alternative === undefined
            ? undefined
            : this.#resolveExpression(
              expression.alternative,
              environment,
              currentRecursive,
            ),
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
      case "comptime":
        return {
          ...expression,
          expression: this.#resolveExpression(
            expression.expression,
            environment,
            currentRecursive,
          ),
        };
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
      text: name.text,
      scope,
      ...(name.declaredType === undefined
        ? {}
        : { declaredType: name.declaredType }),
      ...(name.identityPolymorphic === undefined
        ? {}
        : { identityPolymorphic: name.identityPolymorphic }),
      span: name.span,
    } satisfies DucklangSymbol;
    this.#symbols.push(symbol);
    return symbol;
  }
}

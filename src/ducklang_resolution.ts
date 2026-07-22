import type {
  DucklangExpression,
  DucklangModule,
  DucklangName,
  DucklangStatement,
  DucklangTypeReference,
  DucklangUnionCase,
} from "./ducklang_ast.ts";
import type { SourceSpan } from "./syntax.ts";

export type DucklangSymbol = {
  readonly id: number;
  readonly text: string;
  readonly scope: "module" | "parameter" | "local";
  readonly declaredType?: string;
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
    readonly kind: "unionCase";
    readonly caseName: string;
    readonly value: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "product";
    readonly productKind: "tuple" | "array";
    readonly values: readonly ResolvedDucklangExpression[];
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

export type ResolvedDucklangModule = {
  readonly file: string;
  readonly bindings: readonly ResolvedDucklangBinding[];
  readonly result: ResolvedDucklangExpression;
  readonly symbols: readonly DucklangSymbol[];
  readonly unionTypes: readonly ResolvedDucklangUnionType[];
  readonly typeAliases: readonly ResolvedDucklangTypeAlias[];
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
  };
}

class DucklangResolver {
  readonly #file: string;
  readonly #symbols: DucklangSymbol[] = [];
  readonly #unionTypes: ResolvedDucklangUnionType[] = [];
  readonly #typeAliases: ResolvedDucklangTypeAlias[] = [];

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
      if (statement.kind === "unionType") {
        if (scope !== "module") {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: Ducklang type declarations must be module-level`,
          );
        }
        if (
          this.#unionTypes.some((declaration) =>
            declaration.name === statement.name
          ) || this.#typeAliases.some((alias) => alias.name === statement.name)
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
            value: {
              kind: "project",
              product: {
                kind: "reference",
                symbol: productSymbol,
                span: statement.span,
              },
              index: elementIndex,
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
        statement.kind === "forRange" || statement.kind === "break" ||
        statement.kind === "continue"
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
      case "moduleImport":
        throw new SyntaxError(
          `${this.#file}:${expression.span.start}: Ducklang import expression must initialize a module binding`,
        );
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
      case "call":
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
      span: name.span,
    } satisfies DucklangSymbol;
    this.#symbols.push(symbol);
    return symbol;
  }
}

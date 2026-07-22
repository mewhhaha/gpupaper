import type {
  DucklangExpression,
  DucklangModule,
  DucklangName,
  DucklangStatement,
} from "./ducklang_ast.ts";
import type { SourceSpan } from "./syntax.ts";

export type DucklangSymbol = {
  readonly id: number;
  readonly text: string;
  readonly scope: "module" | "parameter" | "local";
  readonly declaredType?: "I32" | "I64" | "Bool";
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
    readonly kind: "reference";
    readonly symbol: DucklangSymbol;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "function";
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
    readonly kind: "if";
    readonly condition: ResolvedDucklangExpression;
    readonly consequence: ResolvedDucklangExpression;
    readonly alternative: ResolvedDucklangExpression | undefined;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "block";
    readonly bindings: readonly ResolvedDucklangBinding[];
    readonly result: ResolvedDucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "comptime";
    readonly expression: ResolvedDucklangExpression;
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

export type ResolvedDucklangModule = {
  readonly file: string;
  readonly bindings: readonly ResolvedDucklangBinding[];
  readonly result: ResolvedDucklangExpression;
  readonly symbols: readonly DucklangSymbol[];
};

type ResolvedStatements = {
  readonly bindings: readonly ResolvedDucklangBinding[];
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
  };
}

class DucklangResolver {
  readonly #file: string;
  readonly #symbols: DucklangSymbol[] = [];

  constructor(file: string) {
    this.#file = file;
  }

  get symbols(): readonly DucklangSymbol[] {
    return this.#symbols;
  }

  resolveStatements(
    statements: readonly DucklangStatement[],
    initialEnvironment: ReadonlyMap<string, DucklangSymbol>,
    scope: "module" | "local",
    span: SourceSpan,
  ): ResolvedStatements {
    const environment = new Map(initialEnvironment);
    const bindings: ResolvedDucklangBinding[] = [];
    let result: ResolvedDucklangExpression | undefined;

    for (const [index, statement] of statements.entries()) {
      if (statement.kind === "expression") {
        if (index !== statements.length - 1) {
          throw new SyntaxError(
            `${this.#file}:${statement.span.start}: only the final Ducklang statement may produce the block result`,
          );
        }
        result = this.#resolveExpression(statement.expression, environment);
        continue;
      }

      if (statement.kind === "binding") {
        const symbol = this.#declare(statement.name, scope);
        if (statement.recursive) environment.set(symbol.text, symbol);
        const value = this.#resolveExpression(statement.value, environment);
        environment.set(symbol.text, symbol);
        bindings.push({
          symbol,
          previous: undefined,
          recursive: statement.recursive,
          stage: statement.declarationKind === "const"
            ? "compileTime"
            : "runtime",
          value,
          span: statement.span,
        });
        continue;
      }

      const previous = environment.get(statement.name.text);
      if (previous === undefined) {
        throw new ReferenceError(
          `${this.#file}:${statement.name.span.start}: assignment to ${statement.name.text} has no visible Ducklang binding`,
        );
      }
      const value = this.#resolveExpression(statement.value, environment);
      const symbol = this.#declare(statement.name, scope);
      environment.set(symbol.text, symbol);
      bindings.push({
        symbol,
        previous: statement.operator === "=" ? previous : undefined,
        recursive: false,
        stage: "runtime",
        value,
        span: statement.span,
      });
    }

    if (result === undefined) {
      throw new TypeError(
        `${this.#file}:${span.start}: Ducklang block has no result expression`,
      );
    }
    return { bindings, result, environment };
  }

  #resolveExpression(
    expression: DucklangExpression,
    environment: ReadonlyMap<string, DucklangSymbol>,
  ): ResolvedDucklangExpression {
    switch (expression.kind) {
      case "integer":
      case "integer64":
      case "boolean":
        return expression;
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
          parameters,
          body: this.#resolveExpression(expression.body, functionEnvironment),
          span: expression.span,
        };
      }
      case "call":
        return {
          ...expression,
          callee: this.#resolveExpression(expression.callee, environment),
          arguments: expression.arguments.map((argument) =>
            this.#resolveExpression(argument, environment)
          ),
        };
      case "binary":
        return {
          ...expression,
          left: this.#resolveExpression(expression.left, environment),
          right: this.#resolveExpression(expression.right, environment),
        };
      case "unary":
        return {
          ...expression,
          operand: this.#resolveExpression(expression.operand, environment),
        };
      case "if":
        return {
          ...expression,
          condition: this.#resolveExpression(expression.condition, environment),
          consequence: this.#resolveExpression(
            expression.consequence,
            environment,
          ),
          alternative: expression.alternative === undefined
            ? undefined
            : this.#resolveExpression(expression.alternative, environment),
        };
      case "block": {
        const resolved = this.resolveStatements(
          expression.statements,
          environment,
          "local",
          expression.span,
        );
        return {
          kind: "block",
          bindings: resolved.bindings,
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
          ),
        };
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

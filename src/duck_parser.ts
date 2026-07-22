import { type DuckToken, tokenizeDuck } from "./duck_lexer.ts";
import {
  type ClassDeclaration,
  type Declaration,
  type Expression,
  type InstanceDeclaration,
  type Module,
  type Name,
  type SourceSpan,
  spanFrom,
  type TypeSyntax,
  unscopedName,
  type ValueDeclaration,
} from "./syntax.ts";

type LocalBinding = {
  readonly name: Name;
  readonly value: Expression;
  readonly span: SourceSpan;
};

type ArrowFunction = {
  readonly parameters: readonly Name[];
  readonly body: Expression;
};

const maximumIntegerLiteral = 2_147_483_647;
const unsupportedExpressionKeywords = new Set([
  "break",
  "continue",
  "do",
  "freeze",
  "import",
  "include",
  "loop",
  "match",
  "rec",
  "return",
  "scratch",
  "try",
]);

export function parseDuckModule(file: string, source: string): Module {
  return new DuckParser(file, tokenizeDuck(file, source)).parseModule();
}

class DuckParser {
  readonly #file: string;
  readonly #tokens: readonly DuckToken[];
  readonly #topLevelNames = new Map<string, string>();
  readonly #nameGenerations = new Map<string, number>();
  readonly #arrowFunctions = new WeakMap<Expression, ArrowFunction>();
  #position = 0;
  #equalitySpan: SourceSpan | undefined;

  constructor(file: string, tokens: readonly DuckToken[]) {
    this.#file = file;
    this.#tokens = tokens;
  }

  parseModule(): Module {
    const values: ValueDeclaration[] = [];
    let mainExpression: Expression | undefined;
    this.#skipNewlines();

    while (!this.#at("eof")) {
      if (this.#atText("let") || this.#atText("const")) {
        values.push(this.#parseTopLevelBinding());
        this.#expectStatementEnd();
        this.#skipNewlines();
        continue;
      }
      if (this.#startsAssignment()) {
        values.push(this.#parseTopLevelAssignment());
        this.#expectStatementEnd();
        this.#skipNewlines();
        continue;
      }

      mainExpression = this.#parseExpression(
        new Map(this.#topLevelNames),
        new Set(["\n"]),
      );
      this.#skipNewlines();
      if (!this.#at("eof")) {
        this.#fail(
          this.#peek(),
          "only the final expression may appear without a binding in this pure Duck subset",
        );
      }
    }

    if (mainExpression === undefined) {
      this.#fail(
        this.#peek(),
        "a header-free Duck program must end with a result expression",
      );
    }
    const mainName = unscopedName("main", mainExpression.span);
    values.push({
      kind: "value",
      name: mainName,
      parameters: [],
      expression: mainExpression,
      span: mainExpression.span,
    });

    const declarations: Declaration[] = [];
    if (this.#equalitySpan !== undefined) {
      declarations.push(...duckIntegerEquality(this.#equalitySpan));
    }
    declarations.push(...values);
    return { file: this.#file, declarations };
  }

  #parseTopLevelBinding(): ValueDeclaration {
    const start = this.#peek();
    const kind = this.#expect("identifier", "expected let or const");
    if (kind.text === "const") {
      this.#fail(
        kind,
        "Duck const bindings require compile-time dependency evaluation; use an explicit comptime expression in this frontend slice",
      );
    }
    const recursive = this.#match("rec");
    const sourceName = this.#expect(
      "identifier",
      "expected a Duck binding name",
    );
    if (this.#atText(":")) {
      this.#fail(
        this.#peek(),
        `type annotations on Duck binding ${sourceName.text} are not represented by the current scalar core`,
      );
    }
    this.#expectText("=");

    const recursiveName = recursive
      ? this.#allocateTopLevelName(sourceName.text)
      : undefined;
    if (recursiveName !== undefined) {
      this.#topLevelNames.set(sourceName.text, recursiveName);
    }
    const value = this.#parseExpression(
      new Map(this.#topLevelNames),
      new Set(["\n"]),
    );
    const internalName = recursiveName ??
      this.#allocateTopLevelName(sourceName.text);
    if (recursiveName === undefined) {
      this.#topLevelNames.set(sourceName.text, internalName);
    }
    if (recursive && !this.#arrowFunctions.has(value)) {
      this.#fail(
        sourceName,
        `recursive Duck binding ${sourceName.text} must be a function`,
      );
    }
    return this.#valueDeclaration(start, sourceName, internalName, value);
  }

  #parseTopLevelAssignment(): ValueDeclaration {
    const sourceName = this.#expect(
      "identifier",
      "expected an assignment name",
    );
    const previousName = this.#topLevelNames.get(sourceName.text);
    if (previousName === undefined) {
      this.#fail(
        sourceName,
        `assignment to ${sourceName.text} has no preceding Duck binding`,
      );
    }
    const operator = this.#peek();
    this.#position += 1;
    let value = this.#parseExpression(
      new Map(this.#topLevelNames),
      new Set(["\n"]),
    );
    if (operator.text === "=") {
      value = {
        kind: "if",
        condition: { kind: "boolean", value: false, span: operator.span },
        thenBranch: {
          kind: "variable",
          name: unscopedName(previousName, operator.span),
          span: operator.span,
        },
        elseBranch: value,
        span: spanFrom(operator.span, value.span),
      };
    }
    const internalName = this.#allocateTopLevelName(sourceName.text);
    this.#topLevelNames.set(sourceName.text, internalName);
    return this.#valueDeclaration(
      sourceName,
      sourceName,
      internalName,
      value,
    );
  }

  #valueDeclaration(
    start: DuckToken,
    sourceName: DuckToken,
    internalName: string,
    value: Expression,
  ): ValueDeclaration {
    const arrow = this.#arrowFunctions.get(value);
    return {
      kind: "value",
      name: unscopedName(internalName, sourceName.span),
      parameters: arrow?.parameters ?? [],
      expression: arrow?.body ?? value,
      span: spanFrom(start.span, value.span),
    };
  }

  #parseExpression(
    environment: ReadonlyMap<string, string>,
    stops: ReadonlySet<string>,
    minimumPrecedence = 0,
  ): Expression {
    let expression = this.#parsePrefix(environment, stops);
    while (!this.#isStop(stops)) {
      if (this.#atText("(")) {
        expression = this.#parseCall(expression, environment);
        continue;
      }

      const operator = this.#peek().text;
      const precedence = operator === "=="
        ? 1
        : operator === "+" || operator === "-"
        ? 2
        : operator === "*"
        ? 3
        : -1;
      if (precedence >= minimumPrecedence) {
        const operatorToken = this.#peek();
        this.#position += 1;
        const right = this.#parseExpression(
          environment,
          stops,
          precedence + 1,
        );
        if (operator === "==" && this.#equalitySpan === undefined) {
          this.#equalitySpan = operatorToken.span;
        }
        expression = {
          kind: "binary",
          operator: operator as "+" | "-" | "*" | "==",
          left: expression,
          right,
          span: spanFrom(expression.span, right.span),
        };
        continue;
      }
      if (
        ["/", "%", "<", ">", "<=", ">=", "!=", "&&", "||"].includes(operator)
      ) {
        this.#fail(
          this.#peek(),
          `Duck operator ${operator} is not yet represented by the shared scalar core`,
        );
      }
      break;
    }
    return expression;
  }

  #parsePrefix(
    environment: ReadonlyMap<string, string>,
    stops: ReadonlySet<string>,
  ): Expression {
    const token = this.#peek();
    if (token.kind === "integer") {
      this.#position += 1;
      return {
        kind: "integer",
        value: this.#parseInteger(token),
        span: token.span,
      };
    }
    if (token.text === "true" || token.text === "false") {
      this.#position += 1;
      return {
        kind: "boolean",
        value: token.text === "true",
        span: token.span,
      };
    }
    if (token.text === "if") return this.#parseIf(environment);
    if (token.text === "comptime") {
      this.#position += 1;
      const expression = this.#parseExpression(environment, stops, 4);
      return {
        kind: "comptime",
        expression,
        backend: "bytecode",
        span: spanFrom(token.span, expression.span),
      };
    }
    if (token.text === "-") {
      this.#position += 1;
      const right = this.#parseExpression(environment, stops, 4);
      const zero: Expression = {
        kind: "integer",
        value: 0,
        span: token.span,
      };
      return {
        kind: "binary",
        operator: "-",
        left: zero,
        right,
        span: spanFrom(token.span, right.span),
      };
    }
    if (token.text === "{") return this.#parseBlock(environment);
    if (token.text === "(") {
      if (this.#startsParenthesizedArrow()) {
        return this.#parseParenthesizedArrow(environment, stops);
      }
      this.#position += 1;
      this.#skipNewlines();
      const expression = this.#parseExpression(
        environment,
        new Set([")", ","]),
      );
      if (this.#atText(",")) {
        this.#fail(
          this.#peek(),
          "Duck product values require aggregate representation in the shared core",
        );
      }
      this.#skipNewlines();
      this.#expectText(")");
      return expression;
    }
    if (token.kind === "identifier") {
      if (unsupportedExpressionKeywords.has(token.text)) {
        this.#fail(
          token,
          `Duck ${token.text} expressions are outside the current frontend slice`,
        );
      }
      if (this.#peek(1).text === "=>") {
        this.#position += 2;
        const parameter = unscopedName(token.text, token.span);
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(token.text, token.text);
        const body = this.#parseExpression(bodyEnvironment, stops);
        const lambda: Expression = {
          kind: "lambda",
          parameter,
          body,
          span: spanFrom(token.span, body.span),
        };
        this.#arrowFunctions.set(lambda, { parameters: [parameter], body });
        return lambda;
      }
      this.#position += 1;
      const resolvedName = environment.get(token.text) ?? token.text;
      return {
        kind: "variable",
        name: unscopedName(resolvedName, token.span),
        span: token.span,
      };
    }
    this.#fail(token, "expected a supported Duck expression");
  }

  #parseParenthesizedArrow(
    environment: ReadonlyMap<string, string>,
    stops: ReadonlySet<string>,
  ): Expression {
    const start = this.#expectText("(");
    const parameters: Name[] = [];
    const parameterNames = new Set<string>();
    while (!this.#atText(")")) {
      const parameter = this.#expect(
        "identifier",
        "expected a Duck function parameter",
      );
      if (parameterNames.has(parameter.text)) {
        this.#fail(parameter, `duplicate Duck parameter ${parameter.text}`);
      }
      parameterNames.add(parameter.text);
      if (this.#atText(":")) {
        this.#fail(
          this.#peek(),
          `type annotation on Duck parameter ${parameter.text} is not represented by the current scalar core`,
        );
      }
      parameters.push(unscopedName(parameter.text, parameter.span));
      if (!this.#match(",")) break;
    }
    this.#expectText(")");
    this.#expectText("=>");
    if (parameters.length === 0) {
      this.#fail(
        start,
        "zero-parameter Duck lambdas require a Unit argument representation",
      );
    }
    const bodyEnvironment = new Map(environment);
    for (const parameter of parameters) {
      bodyEnvironment.set(parameter.text, parameter.text);
    }
    const body = this.#parseExpression(bodyEnvironment, stops);
    let lambda = body;
    for (const parameter of parameters.toReversed()) {
      lambda = {
        kind: "lambda",
        parameter,
        body: lambda,
        span: spanFrom(start.span, body.span),
      };
    }
    this.#arrowFunctions.set(lambda, { parameters, body });
    return lambda;
  }

  #parseCall(
    callee: Expression,
    environment: ReadonlyMap<string, string>,
  ): Expression {
    this.#expectText("(");
    this.#skipNewlines();
    if (this.#match(")")) return callee;

    const arguments_: Expression[] = [];
    while (true) {
      arguments_.push(
        this.#parseExpression(environment, new Set([",", ")"])),
      );
      this.#skipNewlines();
      if (!this.#match(",")) break;
      this.#skipNewlines();
    }
    const end = this.#expectText(")");
    let application = callee;
    for (const argument of arguments_) {
      application = {
        kind: "apply",
        callee: application,
        argument,
        span: spanFrom(callee.span, end.span),
      };
    }
    return application;
  }

  #parseIf(environment: ReadonlyMap<string, string>): Expression {
    const start = this.#expectText("if");
    const condition = this.#parseExpression(environment, new Set(["{"]));
    if (!this.#atText("{")) {
      this.#fail(this.#peek(), "Duck if condition must be followed by a block");
    }
    const thenBranch = this.#parseBlock(environment);
    const positionAfterThen = this.#position;
    this.#skipNewlines();
    if (!this.#match("else")) {
      this.#position = positionAfterThen;
      this.#fail(
        this.#peek(),
        "Duck if without else returns Unit, which the current scalar core cannot represent",
      );
    }
    this.#skipNewlines();
    const elseBranch = this.#atText("if")
      ? this.#parseIf(environment)
      : this.#parseBlock(environment);
    return {
      kind: "if",
      condition,
      thenBranch,
      elseBranch,
      span: spanFrom(start.span, elseBranch.span),
    };
  }

  #parseBlock(environment: ReadonlyMap<string, string>): Expression {
    const start = this.#expectText("{");
    const blockEnvironment = new Map(environment);
    const bindings: LocalBinding[] = [];
    let result: Expression | undefined;
    this.#skipNewlines();

    while (!this.#atText("}")) {
      if (this.#at("eof")) {
        this.#fail(this.#peek(), "unterminated Duck block");
      }
      if (this.#atText("let") || this.#atText("const")) {
        bindings.push(this.#parseLocalBinding(blockEnvironment));
        this.#expectBlockStatementEnd();
        this.#skipNewlines();
        continue;
      }
      if (this.#startsAssignment()) {
        bindings.push(this.#parseLocalAssignment(blockEnvironment));
        this.#expectBlockStatementEnd();
        this.#skipNewlines();
        continue;
      }

      result = this.#parseExpression(blockEnvironment, new Set(["\n", "}"]));
      if (this.#atText("}")) break;
      this.#skipNewlines();
      if (!this.#atText("}")) {
        this.#fail(
          this.#peek(),
          "only the final expression is supported in this pure Duck block subset",
        );
      }
    }

    const end = this.#expectText("}");
    if (result === undefined) {
      this.#fail(
        end,
        "Duck block has no scalar result; Unit is not represented by the current core",
      );
    }
    let expression = result;
    for (const binding of bindings.toReversed()) {
      expression = {
        kind: "let",
        name: binding.name,
        value: binding.value,
        body: expression,
        span: spanFrom(binding.span, expression.span),
      };
    }
    return { ...expression, span: spanFrom(start.span, end.span) };
  }

  #parseLocalBinding(environment: Map<string, string>): LocalBinding {
    const start = this.#expect("identifier", "expected let or const");
    if (start.text === "const") {
      this.#fail(
        start,
        "local Duck const bindings require compile-time dependency evaluation",
      );
    }
    if (this.#match("rec")) {
      this.#fail(
        start,
        "local recursive Duck functions require closure conversion",
      );
    }
    const name = this.#expect("identifier", "expected a local binding name");
    if (this.#atText(":")) {
      this.#fail(
        this.#peek(),
        `type annotation on local Duck binding ${name.text} is not represented by the current scalar core`,
      );
    }
    this.#expectText("=");
    const value = this.#parseExpression(environment, new Set(["\n", "}"]));
    if (this.#arrowFunctions.has(value)) {
      this.#fail(
        name,
        `local Duck function ${name.text} requires closure conversion`,
      );
    }
    environment.set(name.text, name.text);
    return {
      name: unscopedName(name.text, name.span),
      value,
      span: spanFrom(start.span, value.span),
    };
  }

  #parseLocalAssignment(environment: Map<string, string>): LocalBinding {
    const name = this.#expect("identifier", "expected an assignment name");
    const previousName = environment.get(name.text);
    if (previousName === undefined) {
      this.#fail(
        name,
        `assignment to ${name.text} has no visible Duck binding`,
      );
    }
    const operator = this.#peek();
    this.#position += 1;
    let value = this.#parseExpression(environment, new Set(["\n", "}"]));
    if (operator.text === "=") {
      value = {
        kind: "if",
        condition: { kind: "boolean", value: false, span: operator.span },
        thenBranch: {
          kind: "variable",
          name: unscopedName(previousName, operator.span),
          span: operator.span,
        },
        elseBranch: value,
        span: spanFrom(operator.span, value.span),
      };
    }
    if (this.#arrowFunctions.has(value)) {
      this.#fail(
        name,
        `assignment of local Duck function ${name.text} requires closure conversion`,
      );
    }
    environment.set(name.text, name.text);
    return {
      name: unscopedName(name.text, name.span),
      value,
      span: spanFrom(name.span, value.span),
    };
  }

  #startsParenthesizedArrow(): boolean {
    let lookahead = this.#position + 1;
    if (this.#tokens[lookahead].text === ")") {
      return this.#tokens[lookahead + 1].text === "=>";
    }
    while (this.#tokens[lookahead].kind === "identifier") {
      lookahead += 1;
      if (this.#tokens[lookahead].text === ":") return true;
      if (this.#tokens[lookahead].text === ")") {
        return this.#tokens[lookahead + 1].text === "=>";
      }
      if (this.#tokens[lookahead].text !== ",") return false;
      lookahead += 1;
    }
    return false;
  }

  #startsAssignment(): boolean {
    return this.#peek().kind === "identifier" &&
      (this.#peek(1).text === "=" || this.#peek(1).text === ":=");
  }

  #allocateTopLevelName(sourceName: string): string {
    const generation = (this.#nameGenerations.get(sourceName) ?? 0) + 1;
    this.#nameGenerations.set(sourceName, generation);
    if (generation === 1 && sourceName !== "main") return sourceName;
    return `${sourceName}__duck${generation}`;
  }

  #parseInteger(token: DuckToken): number {
    const match = /^(\d+)([iu]\d+)?$/.exec(token.text);
    if (match === null) {
      this.#fail(
        token,
        `numeric literal ${token.text} is not an integer supported by the scalar core`,
      );
    }
    const suffix = match[2];
    if (suffix !== undefined && suffix !== "i32") {
      this.#fail(
        token,
        `numeric literal ${token.text} requires ${suffix} representation; only signed i32 is implemented`,
      );
    }
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value > maximumIntegerLiteral) {
      this.#fail(
        token,
        `integer literal ${token.text} exceeds the supported signed i32 range`,
      );
    }
    return value;
  }

  #expectStatementEnd(): void {
    if (!this.#at("newline") && !this.#at("eof")) {
      this.#fail(this.#peek(), "expected the end of a Duck statement");
    }
  }

  #expectBlockStatementEnd(): void {
    if (!this.#at("newline") && !this.#atText("}")) {
      this.#fail(this.#peek(), "expected the end of a Duck block statement");
    }
  }

  #isStop(stops: ReadonlySet<string>): boolean {
    const token = this.#peek();
    return token.kind === "eof" || stops.has(token.text);
  }

  #skipNewlines(): void {
    while (this.#at("newline")) this.#position += 1;
  }

  #match(text: string): boolean {
    if (!this.#atText(text)) return false;
    this.#position += 1;
    return true;
  }

  #expectText(text: string): DuckToken {
    const token = this.#peek();
    if (token.text !== text) {
      this.#fail(token, `expected ${JSON.stringify(text)}`);
    }
    this.#position += 1;
    return token;
  }

  #expect(kind: DuckToken["kind"], message: string): DuckToken {
    const token = this.#peek();
    if (token.kind !== kind) this.#fail(token, message);
    this.#position += 1;
    return token;
  }

  #atText(text: string): boolean {
    return this.#peek().text === text;
  }

  #at(kind: DuckToken["kind"]): boolean {
    return this.#peek().kind === kind;
  }

  #peek(offset = 0): DuckToken {
    return this.#tokens[this.#position + offset] ?? this.#tokens.at(-1)!;
  }

  #fail(token: DuckToken, message: string): never {
    throw new SyntaxError(
      `${token.span.file}:${token.span.start}: ${message}; found ${
        JSON.stringify(token.text)
      }`,
    );
  }
}

function duckIntegerEquality(
  span: SourceSpan,
): readonly [ClassDeclaration, InstanceDeclaration] {
  const typeParameter: TypeSyntax = { kind: "name", name: "a", span };
  const boolType: TypeSyntax = { kind: "name", name: "Bool", span };
  const methodType: TypeSyntax = {
    kind: "function",
    parameter: typeParameter,
    result: {
      kind: "function",
      parameter: typeParameter,
      result: boolType,
      span,
    },
    span,
  };
  const methodName = unscopedName("__duck_integer_equality", span);
  return [{
    kind: "class",
    name: unscopedName("Eq", span),
    parameter: "a",
    methodName,
    methodType: { predicates: [], type: methodType, span },
    span,
  }, {
    kind: "instance",
    className: unscopedName("Eq", span),
    type: { kind: "name", name: "Int", span },
    methodName,
    primitive: "integerEquality",
    span,
  }];
}

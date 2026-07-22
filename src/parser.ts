import { type Token, tokenize } from "./lexer.ts";
import {
  type CaseAlternative,
  type ClassDeclaration,
  type ConstructorDeclaration,
  type DataDeclaration,
  type Declaration,
  type Expression,
  type InstanceDeclaration,
  type MacroDeclaration,
  type MacroInvocation,
  type Module,
  type Name,
  type PredicateSyntax,
  type SourceSpan,
  spanFrom,
  type TypeSignature,
  type TypeSyntax,
  unscopedName,
  type ValueDeclaration,
} from "./syntax.ts";

type PendingSignature = {
  readonly name: string;
  readonly signature: TypeSignature;
};

const maximumIntegerLiteral = 2_147_483_647;

export function parseModule(file: string, source: string): Module {
  const parser = new Parser(file, tokenize(file, source));
  return parser.parseModule();
}

class Parser {
  readonly #file: string;
  readonly #tokens: readonly Token[];
  #position = 0;
  #pendingSignature: PendingSignature | undefined;

  constructor(file: string, tokens: readonly Token[]) {
    this.#file = file;
    this.#tokens = tokens;
  }

  parseModule(): Module {
    const declarations: Declaration[] = [];
    this.#skipNewlines();
    while (!this.#at("eof")) {
      const declaration = this.#parseDeclaration();
      if (declaration !== undefined) declarations.push(declaration);
      if (!this.#at("newline") && !this.#at("eof")) {
        this.#fail(this.#peek(), "expected end of declaration");
      }
      this.#skipNewlines();
    }
    if (this.#pendingSignature !== undefined) {
      this.#fail(
        this.#peek(),
        `signature for ${this.#pendingSignature.name} has no value declaration`,
      );
    }
    return { file: this.#file, declarations };
  }

  #parseDeclaration(): Declaration | undefined {
    if (this.#peek().text === "data") return this.#parseDataDeclaration();
    if (this.#peek().text === "class") return this.#parseClassDeclaration();
    if (this.#peek().text === "instance") {
      return this.#parseInstanceDeclaration();
    }
    if (this.#peek().text === "macro") return this.#parseMacroDeclaration();

    const nameToken = this.#expectName("expected a declaration name");
    if (this.#match("!")) return this.#parseMacroInvocation(nameToken);
    if (this.#match("::")) {
      if (this.#pendingSignature !== undefined) {
        this.#fail(
          nameToken,
          `signature for ${this.#pendingSignature.name} has no value declaration`,
        );
      }
      this.#pendingSignature = {
        name: nameToken.text,
        signature: this.#parseTypeSignature(nameToken.span),
      };
      return undefined;
    }
    return this.#parseValueDeclaration(nameToken);
  }

  #parseValueDeclaration(nameToken: Token): ValueDeclaration {
    const parameters: Name[] = [];
    while (!this.#atText("=")) {
      const parameter = this.#expect("identifier", "expected a parameter or =");
      parameters.push(unscopedName(parameter.text, parameter.span));
    }
    this.#expectText("=");
    const expression = this.#parseExpression(new Set(["\n"]));
    const signature = this.#pendingSignature?.name === nameToken.text
      ? this.#pendingSignature.signature
      : undefined;
    if (this.#pendingSignature !== undefined && signature === undefined) {
      this.#fail(
        nameToken,
        `signature for ${this.#pendingSignature.name} must be followed by its value declaration`,
      );
    }
    this.#pendingSignature = undefined;
    return {
      kind: "value",
      name: unscopedName(nameToken.text, nameToken.span),
      parameters,
      expression,
      signature,
      span: spanFrom(nameToken.span, expression.span),
    };
  }

  #parseDataDeclaration(): DataDeclaration {
    const start = this.#expectText("data");
    const name = this.#expect("constructor", "expected a datatype name");
    const parameters: string[] = [];
    while (!this.#atText("=")) {
      parameters.push(
        this.#expect("identifier", "expected a type parameter or =").text,
      );
    }
    this.#expectText("=");
    const constructors: ConstructorDeclaration[] = [];
    while (true) {
      const constructor = this.#expect(
        "constructor",
        "expected a constructor name",
      );
      const fields: TypeSyntax[] = [];
      while (!this.#atText("|") && !this.#at("newline") && !this.#at("eof")) {
        fields.push(this.#parseAtomicType());
      }
      constructors.push({
        name: unscopedName(constructor.text, constructor.span),
        fields,
        span: fields.length === 0
          ? constructor.span
          : spanFrom(constructor.span, fields.at(-1)!.span),
      });
      if (!this.#match("|")) break;
    }
    return {
      kind: "datatype",
      name: unscopedName(name.text, name.span),
      parameters,
      constructors,
      span: spanFrom(start.span, constructors.at(-1)!.span),
    };
  }

  #parseClassDeclaration(): ClassDeclaration {
    const start = this.#expectText("class");
    const name = this.#expect("constructor", "expected a class name");
    const parameter = this.#expect("identifier", "expected a class parameter");
    this.#expectText("where");
    const method = this.#expect("identifier", "expected a method name");
    this.#expectText("::");
    const methodType = this.#parseTypeSignature(method.span);
    return {
      kind: "class",
      name: unscopedName(name.text, name.span),
      parameter: parameter.text,
      methodName: unscopedName(method.text, method.span),
      methodType,
      span: spanFrom(start.span, methodType.span),
    };
  }

  #parseInstanceDeclaration(): InstanceDeclaration {
    const start = this.#expectText("instance");
    const className = this.#expect("constructor", "expected a class name");
    const type = this.#parseAtomicType();
    this.#expectText("where");
    const methodName = this.#expect(
      "identifier",
      "expected an instance method",
    );
    this.#expectText("=");
    const primitive = this.#expect("identifier", "expected primEqInt");
    if (primitive.text !== "primEqInt") {
      this.#fail(primitive, `unsupported instance primitive ${primitive.text}`);
    }
    return {
      kind: "instance",
      className: unscopedName(className.text, className.span),
      type,
      methodName: unscopedName(methodName.text, methodName.span),
      primitive: "integerEquality",
      span: spanFrom(start.span, primitive.span),
    };
  }

  #parseMacroDeclaration(): MacroDeclaration {
    const start = this.#expectText("macro");
    const name = this.#expect("identifier", "expected a macro name");
    this.#expectText("=");
    const operation = this.#expect(
      "identifier",
      "expected identity or constant",
    );
    if (operation.text !== "identity" && operation.text !== "constant") {
      this.#fail(operation, `unsupported macro operation ${operation.text}`);
    }
    return {
      kind: "macro",
      name: unscopedName(name.text, name.span),
      operation: operation.text,
      span: spanFrom(start.span, operation.span),
    };
  }

  #parseMacroInvocation(nameToken: Token): MacroInvocation {
    this.#expectText("(");
    const macroArguments: (Name | number)[] = [];
    while (!this.#atText(")")) {
      const argument = this.#peek();
      if (argument.kind === "integer") {
        this.#position += 1;
        macroArguments.push(this.#parseIntegerLiteral(argument));
      } else {
        const name = this.#expectName("expected a macro argument");
        macroArguments.push(unscopedName(name.text, name.span));
      }
      if (!this.#match(",")) break;
    }
    const end = this.#expectText(")");
    return {
      kind: "macroInvocation",
      name: unscopedName(nameToken.text, nameToken.span),
      arguments: macroArguments,
      span: spanFrom(nameToken.span, end.span),
    };
  }

  #parseTypeSignature(start: SourceSpan): TypeSignature {
    const predicates: PredicateSyntax[] = [];
    let lookahead = this.#position;
    while (
      this.#tokens[lookahead].kind !== "newline" &&
      this.#tokens[lookahead].kind !== "eof" &&
      this.#tokens[lookahead].text !== "=>"
    ) lookahead += 1;
    if (this.#tokens[lookahead].text === "=>") {
      const classToken = this.#expect(
        "constructor",
        "expected a class constraint",
      );
      const argument = this.#parseAtomicType();
      this.#expectText("=>");
      predicates.push({
        className: classToken.text,
        argument,
        span: spanFrom(classToken.span, argument.span),
      });
    }
    const type = this.#parseType();
    return {
      predicates,
      type,
      span: { file: start.file, start: start.start, end: type.span.end },
    };
  }

  #parseType(): TypeSyntax {
    const left = this.#parseTypeApplication();
    if (!this.#match("->")) return left;
    const right = this.#parseType();
    return {
      kind: "function",
      parameter: left,
      result: right,
      span: spanFrom(left.span, right.span),
    };
  }

  #parseTypeApplication(): TypeSyntax {
    let type = this.#parseAtomicType();
    while (
      this.#peek().kind === "identifier" ||
      this.#peek().kind === "constructor" || this.#atText("(")
    ) {
      const argument = this.#parseAtomicType();
      type = {
        kind: "apply",
        constructor: type,
        argument,
        span: spanFrom(type.span, argument.span),
      };
    }
    return type;
  }

  #parseAtomicType(): TypeSyntax {
    if (this.#match("(")) {
      const type = this.#parseType();
      this.#expectText(")");
      return type;
    }
    const token = this.#expectName("expected a type");
    return { kind: "name", name: token.text, span: token.span };
  }

  #parseExpression(
    stops: ReadonlySet<string>,
    minimumPrecedence = 0,
  ): Expression {
    let expression = this.#parsePrefix(stops);
    while (!this.#isStop(stops)) {
      const operator = this.#peek().text;
      const precedence = operator === "=="
        ? 1
        : operator === "+" || operator === "-"
        ? 2
        : operator === "*"
        ? 3
        : -1;
      if (precedence >= minimumPrecedence) {
        this.#position += 1;
        const right = this.#parseExpression(stops, precedence + 1);
        expression = {
          kind: "binary",
          operator: operator as "+" | "-" | "*" | "==",
          left: expression,
          right,
          span: spanFrom(expression.span, right.span),
        };
        continue;
      }
      if (minimumPrecedence <= 4 && this.#startsExpression(this.#peek())) {
        const argument = this.#parseExpression(stops, 5);
        expression = {
          kind: "apply",
          callee: expression,
          argument,
          span: spanFrom(expression.span, argument.span),
        };
        continue;
      }
      break;
    }
    return expression;
  }

  #parsePrefix(stops: ReadonlySet<string>): Expression {
    const token = this.#peek();
    if (token.kind === "integer") {
      this.#position += 1;
      return {
        kind: "integer",
        value: this.#parseIntegerLiteral(token),
        span: token.span,
      };
    }
    if (token.text === "True" || token.text === "False") {
      this.#position += 1;
      return {
        kind: "boolean",
        value: token.text === "True",
        span: token.span,
      };
    }
    if (this.#match("(")) {
      const expression = this.#parseExpression(new Set([...stops, ")"]));
      this.#expectText(")");
      return expression;
    }
    if (this.#match("\\")) {
      const parameter = this.#expect(
        "identifier",
        "expected a lambda parameter",
      );
      this.#expectText("->");
      const body = this.#parseExpression(stops);
      return {
        kind: "lambda",
        parameter: unscopedName(parameter.text, parameter.span),
        body,
        span: spanFrom(token.span, body.span),
      };
    }
    if (this.#match("let")) {
      const name = this.#expect("identifier", "expected a let name");
      this.#expectText("=");
      const value = this.#parseExpression(new Set(["in"]));
      this.#expectText("in");
      const body = this.#parseExpression(stops);
      return {
        kind: "let",
        name: unscopedName(name.text, name.span),
        value,
        body,
        span: spanFrom(token.span, body.span),
      };
    }
    if (this.#match("if")) {
      const condition = this.#parseExpression(new Set(["then"]));
      this.#expectText("then");
      const thenBranch = this.#parseExpression(new Set(["else"]));
      this.#expectText("else");
      const elseBranch = this.#parseExpression(stops);
      return {
        kind: "if",
        condition,
        thenBranch,
        elseBranch,
        span: spanFrom(token.span, elseBranch.span),
      };
    }
    if (this.#match("comptime") || this.#match("ic")) {
      const backend = token.text === "ic" ? "interaction" : "bytecode";
      const expression = this.#parseExpression(stops, 5);
      return {
        kind: "comptime",
        expression,
        backend,
        span: spanFrom(token.span, expression.span),
      };
    }
    if (this.#match("case")) return this.#parseCase(token);
    if (token.kind === "identifier" || token.kind === "constructor") {
      this.#position += 1;
      return {
        kind: "variable",
        name: unscopedName(token.text, token.span),
        span: token.span,
      };
    }
    this.#fail(token, "expected an expression");
  }

  #parseCase(start: Token): Expression {
    const scrutinee = this.#parseExpression(new Set(["of"]));
    this.#expectText("of");
    this.#expectText("{");
    const alternatives: CaseAlternative[] = [];
    while (!this.#atText("}")) {
      const patternStart = this.#peek();
      let pattern: CaseAlternative["pattern"];
      if (patternStart.text === "_") {
        this.#position += 1;
        pattern = { kind: "wildcard", span: patternStart.span };
      } else if (patternStart.kind === "integer") {
        this.#position += 1;
        pattern = {
          kind: "integer",
          value: this.#parseIntegerLiteral(patternStart),
          span: patternStart.span,
        };
      } else {
        const constructor = this.#expect(
          "constructor",
          "expected a constructor pattern",
        );
        const fields: Name[] = [];
        while (!this.#atText("->")) {
          const field = this.#expect(
            "identifier",
            "expected a pattern field or ->",
          );
          fields.push(unscopedName(field.text, field.span));
        }
        pattern = {
          kind: "constructor",
          name: unscopedName(constructor.text, constructor.span),
          fields,
          span: fields.length === 0
            ? constructor.span
            : spanFrom(constructor.span, fields.at(-1)!.span),
        };
      }
      this.#expectText("->");
      const expression = this.#parseExpression(new Set([";", "}"]));
      alternatives.push({
        pattern,
        expression,
        span: spanFrom(pattern.span, expression.span),
      });
      if (!this.#match(";")) break;
    }
    const end = this.#expectText("}");
    if (alternatives.length === 0) {
      this.#fail(end, "case requires at least one alternative");
    }
    return {
      kind: "case",
      scrutinee,
      alternatives,
      span: {
        file: start.span.file,
        start: start.span.start,
        end: end.span.end,
      },
    };
  }

  #startsExpression(token: Token): boolean {
    return token.kind === "identifier" || token.kind === "constructor" ||
      token.kind === "integer" ||
      ["(", "\\", "let", "if", "comptime", "ic", "case"].includes(token.text);
  }

  #isStop(stops: ReadonlySet<string>): boolean {
    const token = this.#peek();
    return token.kind === "eof" || token.kind === "newline" ||
      stops.has(token.text);
  }

  #skipNewlines(): void {
    while (this.#at("newline")) this.#position += 1;
  }

  #peek(): Token {
    return this.#tokens[this.#position];
  }

  #at(kind: Token["kind"]): boolean {
    return this.#peek().kind === kind;
  }

  #atText(text: string): boolean {
    return this.#peek().text === text;
  }

  #match(text: string): boolean {
    if (!this.#atText(text)) return false;
    this.#position += 1;
    return true;
  }

  #expect(kind: Token["kind"], message: string): Token {
    const token = this.#peek();
    if (token.kind !== kind) this.#fail(token, message);
    this.#position += 1;
    return token;
  }

  #expectName(message: string): Token {
    const token = this.#peek();
    if (token.kind !== "identifier" && token.kind !== "constructor") {
      this.#fail(token, message);
    }
    this.#position += 1;
    return token;
  }

  #expectText(text: string): Token {
    const token = this.#peek();
    if (token.text !== text) this.#fail(token, `expected ${text}`);
    this.#position += 1;
    return token;
  }

  #parseIntegerLiteral(token: Token): number {
    const value = Number(token.text);
    if (!Number.isSafeInteger(value) || value > maximumIntegerLiteral) {
      this.#fail(
        token,
        `integer literal ${token.text} exceeds the supported i32 range`,
      );
    }
    return value;
  }

  #fail(token: Token, message: string): never {
    throw new SyntaxError(
      `${this.#file}:${token.span.start}: ${message}; found ${
        JSON.stringify(token.text)
      }`,
    );
  }
}

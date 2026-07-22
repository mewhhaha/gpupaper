import type {
  CursorFieldValue,
  RuleCursor,
  SyntaxCursor,
  TokenCursor,
} from "@mewhhaha/baba/runtime/generated-wasm";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import type {
  DucklangExpression,
  DucklangModule,
  DucklangName,
  DucklangParameter,
  DucklangStatement,
} from "./ducklang_ast.ts";
import type { SourceSpan } from "./syntax.ts";

const parserWasmUrl = new URL(
  "../grammar/generated/parser.wasm",
  import.meta.url,
);
const parserPlanUrl = new URL(
  "../grammar/generated/parser.plan",
  import.meta.url,
);
const maximumIntegerLiteral = 2_147_483_647;

export async function parseDucklangModule(
  file: string,
  source: string,
): Promise<DucklangModule> {
  const parser = createParser({
    bytes: await Deno.readFile(parserWasmUrl),
    plan: await Deno.readFile(parserPlanUrl),
  });
  try {
    const result = parser.parse(source, { maxTraceActions: 10_000_000 });
    if (!result.ok) {
      const diagnostic = result.diagnostics[0];
      throw new SyntaxError(
        `${file}:${diagnostic.span.start}: ${diagnostic.message}`,
      );
    }
    const statements = result.cursor.children().map((cursor) =>
      lowerModuleStatement(file, cursor)
    );
    return {
      file,
      statements,
      span: sourceSpan(file, result.cursor),
    };
  } finally {
    parser.dispose();
  }
}

function lowerModuleStatement(
  file: string,
  cursor: SyntaxCursor,
): DucklangStatement {
  const statement = descendSingleRule(
    cursor,
    new Set([
      "_module_statement",
      "_attributed_module_statement",
      "_plain_module_statement",
      "_statement",
    ]),
  );
  if (statement.type !== "rule") {
    throw unsupported(file, statement, "module statement");
  }
  if (statement.name === "binding_statement") {
    const name = identifierName(
      file,
      requiredField(statement, "name"),
      "binding pattern",
    );
    const kind = tokenField(statement, "kind");
    return {
      kind: "binding",
      declarationKind: kind?.text === "const" ? "const" : "let",
      recursive: tokenField(statement, "recursive") !== undefined,
      name,
      value: lowerExpression(file, requiredField(statement, "value")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "assignment") {
    const name = identifierName(
      file,
      requiredField(statement, "name"),
      "assignment target",
    );
    const operator = tokenField(statement, "operator");
    if (operator?.text !== "=" && operator?.text !== ":=") {
      throw unsupported(file, statement, "assignment operator");
    }
    return {
      kind: "assignment",
      operator: operator.text,
      name,
      value: lowerExpression(file, requiredField(statement, "value")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "expression_statement") {
    const expression = lowerExpression(file, onlyRuleChild(statement));
    if (
      expression.kind === "binary" &&
      (expression.operator === "=" || expression.operator === ":=") &&
      expression.left.kind === "reference"
    ) {
      return {
        kind: "assignment",
        operator: expression.operator,
        name: expression.left.name,
        value: expression.right,
        span: sourceSpan(file, statement),
      };
    }
    return {
      kind: "expression",
      expression,
      span: sourceSpan(file, statement),
    };
  }
  throw unsupported(file, statement, statement.name);
}

function lowerExpression(
  file: string,
  input: SyntaxCursor,
): DucklangExpression {
  const cursor = descendSingleRule(
    input,
    new Set([
      "_expression",
      "is_expression",
      "as_expression",
      "condition_expression",
      "condition_is_expression",
      "condition_call_expression",
      "condition_parenthesized_expression",
      "_condition_primary",
      "_primary_expression",
      "parenthesized_or_product",
      "boolean",
    ]),
  );
  if (cursor.type === "token") return lowerTokenExpression(file, cursor);

  if (
    cursor.name === "binary_expression" ||
    cursor.name === "condition_binary_expression"
  ) {
    const operators = tokenFields(cursor, "operator");
    const rightOperands = cursorFields(cursor, "right");
    const rightSet = new Set(rightOperands);
    const leftCursor = cursor.children().find((child) =>
      child.type === "rule" && !rightSet.has(child)
    );
    if (leftCursor === undefined || operators.length !== rightOperands.length) {
      throw unsupported(file, cursor, "binary expression shape");
    }
    const leadingOperator = operators[0]?.text;
    if (
      leadingOperator === "=>" || leadingOperator === "=" ||
      leadingOperator === ":="
    ) {
      let right = lowerExpression(file, rightOperands[0]);
      for (let index = 1; index < operators.length; index += 1) {
        const next = lowerExpression(
          file,
          rightOperands[index],
        );
        right = {
          kind: "binary",
          operator: operators[index].text,
          left: right,
          right: next,
          span: spanFrom(right.span, next.span),
        };
      }
      if (leadingOperator === "=>") {
        return {
          kind: "function",
          parameters: arrowParameters(file, leftCursor),
          body: right,
          span: sourceSpan(file, cursor),
        };
      }
      const left = lowerExpression(file, leftCursor);
      return {
        kind: "binary",
        operator: leadingOperator,
        left,
        right,
        span: spanFrom(left.span, right.span),
      };
    }

    let expression = lowerExpression(file, leftCursor);
    for (let index = 0; index < operators.length; index += 1) {
      const right = lowerExpression(file, rightOperands[index]);
      expression = {
        kind: "binary",
        operator: operators[index].text,
        left: expression,
        right,
        span: spanFrom(expression.span, right.span),
      };
    }
    return expression;
  }

  if (
    cursor.name === "unary_expression" ||
    cursor.name === "condition_unary_expression"
  ) {
    const operator = tokenField(cursor, "operator");
    if (operator === undefined) {
      return lowerExpression(file, onlyRuleChild(cursor));
    }
    const operand = lowerExpression(file, requiredField(cursor, "operand"));
    if (operator.text === "comptime") {
      return {
        kind: "comptime",
        expression: operand,
        span: sourceSpan(file, cursor),
      };
    }
    return {
      kind: "unary",
      operator: operator.text,
      operand,
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "application_expression") {
    const arguments_ = cursorFields(cursor, "argument");
    const argumentSet = new Set(arguments_);
    const calleeCursor = cursor.children().find((child) =>
      child.type === "rule" && !argumentSet.has(child)
    );
    if (calleeCursor === undefined) {
      throw unsupported(file, cursor, "application callee");
    }
    let expression = lowerExpression(file, calleeCursor);
    for (const argument of arguments_) {
      const callArguments = lowerCallArguments(file, argument);
      expression = {
        kind: "call",
        callee: expression,
        arguments: callArguments,
        span: spanFrom(
          expression.span,
          sourceSpan(file, argument),
        ),
      };
    }
    return expression;
  }

  if (cursor.name === "postfix_expression") {
    const children = cursor.children().filter((child) => child.type === "rule");
    if (children.length !== 1) {
      throw unsupported(
        file,
        cursor,
        "field, index, or effect-handler postfix",
      );
    }
    return lowerExpression(file, children[0]);
  }

  if (cursor.name === "arrow_function") {
    const parameters = lowerParameters(
      file,
      requiredField(cursor, "parameters"),
    );
    const body = lowerExpression(file, requiredField(cursor, "body"));
    return {
      kind: "function",
      parameters,
      body,
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "if_expression") {
    const condition = lowerExpression(file, requiredField(cursor, "condition"));
    const consequence = lowerExpression(
      file,
      requiredField(cursor, "consequence"),
    );
    const alternativeField = cursor.field("alternative");
    const alternative = isCursor(alternativeField)
      ? lowerExpression(file, alternativeField)
      : undefined;
    return {
      kind: "if",
      condition,
      consequence,
      alternative,
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "block") {
    const statements = cursor.children().flatMap((child) =>
      child.type === "rule" && child.name === "_statement"
        ? [lowerModuleStatement(file, child)]
        : []
    );
    return {
      kind: "block",
      statements,
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "parenthesized_expression") {
    return lowerExpression(file, onlyRuleChild(cursor));
  }

  throw unsupported(file, cursor, cursor.name);
}

function lowerTokenExpression(
  file: string,
  cursor: TokenCursor,
): DucklangExpression {
  const span = sourceSpan(file, cursor);
  if (cursor.kind === "number") {
    if (!/^[0-9]+(?:i32)?$/.test(cursor.text)) {
      throw unsupported(file, cursor, `numeric literal ${cursor.text}`);
    }
    const value = Number.parseInt(cursor.text, 10);
    if (!Number.isSafeInteger(value) || value > maximumIntegerLiteral) {
      throw new SyntaxError(
        `${file}:${cursor.span.start}: integer literal ${cursor.text} is outside signed i32`,
      );
    }
    return { kind: "integer", value, span };
  }
  if (cursor.text === "true" || cursor.text === "false") {
    return { kind: "boolean", value: cursor.text === "true", span };
  }
  if (cursor.kind === "identifier") {
    const name = { text: cursor.text, span };
    return { kind: "reference", name, span };
  }
  throw unsupported(file, cursor, cursor.kind);
}

function lowerCallArguments(
  file: string,
  input: SyntaxCursor,
): readonly DucklangExpression[] {
  const cursor = descendSingleRule(
    input,
    new Set(["parenthesized_or_product"]),
  );
  if (cursor.type === "rule" && cursor.name === "positional_product") {
    return cursor.children().flatMap((child) =>
      child.type === "rule" && child.name === "_expression"
        ? [lowerExpression(file, child)]
        : []
    );
  }
  if (cursor.type === "rule" && cursor.name === "unit_pattern") return [];
  return [lowerExpression(file, cursor)];
}

function lowerParameters(
  file: string,
  input: CursorFieldValue,
): readonly DucklangParameter[] {
  if (!isCursor(input)) throw new Error("arrow parameters are missing");
  if (input.type === "token") return [identifierName(file, input, "parameter")];
  if (input.name === "parameter_list") return arrowParameters(file, input);
  if (input.name === "parameter") {
    return [identifierName(file, requiredField(input, "name"), "parameter")];
  }
  throw unsupported(file, input, input.name);
}

function arrowParameters(
  file: string,
  cursor: SyntaxCursor,
): readonly DucklangParameter[] {
  const tokens: TokenCursor[] = [];
  collectAllTokens(cursor, tokens);
  const unsupportedToken = tokens.find((token) =>
    token.kind !== "identifier" &&
    !["(", ")", ","].includes(token.text)
  );
  if (unsupportedToken !== undefined) {
    throw unsupported(
      file,
      unsupportedToken,
      "annotated or patterned parameter",
    );
  }
  const identifiers = tokens.filter((token) => token.kind === "identifier");
  if (identifiers.length === 0) {
    throw unsupported(file, cursor, "zero-parameter function");
  }
  return identifiers.map((identifier) => ({
    text: identifier.text,
    span: sourceSpan(file, identifier),
  }));
}

function identifierName(
  file: string,
  input: CursorFieldValue,
  subject: string,
): DucklangName {
  if (!isCursor(input)) throw new Error(`${subject} is missing`);
  const identifiers: TokenCursor[] = [];
  collectTokens(input, identifiers, "identifier");
  if (identifiers.length !== 1) throw unsupported(file, input, subject);
  const identifier = identifiers[0];
  return { text: identifier.text, span: sourceSpan(file, identifier) };
}

function collectTokens(
  cursor: SyntaxCursor,
  tokens: TokenCursor[],
  kind: string,
): void {
  if (cursor.type === "token") {
    if (cursor.kind === kind) tokens.push(cursor);
    return;
  }
  for (const child of cursor.children()) collectTokens(child, tokens, kind);
}

function collectAllTokens(
  cursor: SyntaxCursor,
  tokens: TokenCursor[],
): void {
  if (cursor.type === "token") {
    tokens.push(cursor);
    return;
  }
  for (const child of cursor.children()) collectAllTokens(child, tokens);
}

function descendSingleRule(
  input: SyntaxCursor,
  wrappers: ReadonlySet<string>,
): SyntaxCursor {
  let cursor = input;
  while (cursor.type === "rule" && wrappers.has(cursor.name)) {
    cursor = onlyRuleOrTokenChild(cursor);
  }
  return cursor;
}

function onlyRuleChild(cursor: RuleCursor): RuleCursor {
  const children = cursor.children().filter((child): child is RuleCursor =>
    child.type === "rule"
  );
  if (children.length !== 1) {
    throw new Error(`rule ${cursor.name} has ${children.length} rule children`);
  }
  return children[0];
}

function onlyRuleOrTokenChild(cursor: RuleCursor): SyntaxCursor {
  const children = cursor.children();
  if (children.length !== 1) {
    throw new Error(`rule ${cursor.name} has ${children.length} children`);
  }
  return children[0];
}

function requiredField(cursor: RuleCursor, name: string): SyntaxCursor {
  const field = cursor.field(name);
  if (!isCursor(field)) {
    throw new Error(`rule ${cursor.name} has no singular ${name} field`);
  }
  return field;
}

function tokenField(cursor: RuleCursor, name: string): TokenCursor | undefined {
  const field = cursor.field(name);
  if (field === undefined || field === null) return undefined;
  if (isCursor(field) && field.type === "token") return field;
  throw new Error(`rule ${cursor.name} field ${name} is not a token`);
}

function tokenFields(cursor: RuleCursor, name: string): readonly TokenCursor[] {
  return cursor.fieldArray(name).map((field) => {
    if (!isCursor(field) || field.type !== "token") {
      throw new Error(`rule ${cursor.name} field ${name} is not a token`);
    }
    return field;
  });
}

function cursorFields(
  cursor: RuleCursor,
  name: string,
): readonly SyntaxCursor[] {
  return cursor.fieldArray(name).map((field) => {
    if (!isCursor(field)) {
      throw new Error(`rule ${cursor.name} field ${name} is not a cursor`);
    }
    return field;
  });
}

function isCursor(value: CursorFieldValue | undefined): value is SyntaxCursor {
  return value !== undefined && value !== null && !Array.isArray(value);
}

function sourceSpan(file: string, cursor: SyntaxCursor): SourceSpan {
  return { file, start: cursor.span.start, end: cursor.span.end };
}

function spanFrom(start: SourceSpan, end: SourceSpan): SourceSpan {
  return { file: start.file, start: start.start, end: end.end };
}

function unsupported(
  file: string,
  cursor: SyntaxCursor,
  subject: string,
): SyntaxError {
  return new SyntaxError(
    `${file}:${cursor.span.start}: Ducklang ${subject} is not represented by the typed IR`,
  );
}

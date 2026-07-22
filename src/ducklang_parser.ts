import type {
  CursorFieldValue,
  RuleCursor,
  SyntaxCursor,
  TokenCursor,
} from "@mewhhaha/baba/runtime/generated-wasm";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import type {
  DucklangExpression,
  DucklangImportSelection,
  DucklangModule,
  DucklangName,
  DucklangParameter,
  DucklangStatement,
  DucklangTypeReference,
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
    const statements = result.cursor.children().flatMap((cursor) => {
      const statement = lowerModuleStatement(file, cursor);
      return statement === undefined ? [] : [statement];
    });
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
): DucklangStatement | undefined {
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
  if (statement.name === "module_header") return undefined;
  if (statement.name === "declare_record_statement") {
    const name = identifierName(
      file,
      requiredField(statement, "name"),
      "record declaration name",
    );
    if (name.text !== "Init") {
      throw unsupported(file, statement, `record declaration ${name.text}`);
    }
    return undefined;
  }
  if (statement.name === "declare_effect_statement") {
    const operationBlock = findRule(statement, "effect_operation_block");
    if (operationBlock === undefined) {
      throw unsupported(file, statement, "effect operation block");
    }
    return {
      kind: "effectDeclaration",
      name: tokenText(
        file,
        requiredField(statement, "name"),
        "effect declaration name",
      ),
      operations: operationBlock.children().flatMap((child) => {
        if (child.type !== "rule" || child.name !== "effect_operation") {
          return [];
        }
        const parameters = requiredField(child, "parameters");
        if (parameters.type !== "rule") {
          throw unsupported(file, parameters, "effect parameters");
        }
        return [{
          name: identifierName(
            file,
            requiredField(child, "name"),
            "effect operation name",
          ).text,
          parameterTypes: parameters.children().flatMap((parameter) =>
            parameter.type === "rule" && parameter.name === "host_parameter"
              ? [lowerTypeReference(file, parameter)]
              : []
          ),
          resultType: lowerTypeReference(
            file,
            requiredField(child, "result"),
          ),
          span: sourceSpan(file, child),
        }];
      }),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "effect_binding_statement") {
    return {
      kind: "binding",
      declarationKind: "let",
      recursive: false,
      name: identifierName(
        file,
        requiredField(statement, "name"),
        "effect result binding",
      ),
      value: lowerHostCall(file, requiredField(statement, "value")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "module_return_statement") {
    const fieldBlock = findRule(statement, "field_block");
    const fields = fieldBlock?.children().filter((child): child is RuleCursor =>
      child.type === "rule" && child.name === "shape_field"
    ) ?? [];
    const field = fields.length === 1 ? fields[0] : undefined;
    if (
      field === undefined ||
      identifierName(
          file,
          requiredField(field, "name"),
          "module return field",
        ).text !== "result"
    ) {
      throw unsupported(file, statement, "module result return");
    }
    return {
      kind: "expression",
      expression: lowerExpression(file, requiredField(field, "value")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "binding_statement") {
    let value = lowerExpression(file, requiredField(statement, "value"));
    const declaredType = statement.field("type");
    if (
      value.kind === "function" && isCursor(declaredType) &&
      hasIdentityForallParameter(declaredType) &&
      value.parameters[0] !== undefined
    ) {
      value = {
        ...value,
        parameters: [
          { ...value.parameters[0], identityPolymorphic: true },
          ...value.parameters.slice(1),
        ],
      };
    }
    const bindingPattern = requiredField(statement, "name");
    const children = statement.children();
    const conjunctionIndices = children.flatMap((child, index) =>
      child.type === "token" && child.text === "and" ? [index] : []
    );
    if (conjunctionIndices.length > 0) {
      const bindings = [{
        name: identifierName(file, bindingPattern, "recursive binding name"),
        value,
        span: spanFrom(sourceSpan(file, bindingPattern), value.span),
      }];
      for (const conjunctionIndex of conjunctionIndices) {
        const name = children[conjunctionIndex + 1];
        const groupedValue = children[conjunctionIndex + 3];
        if (
          name?.type !== "token" || name.kind !== "identifier" ||
          groupedValue?.type !== "rule" || groupedValue.name !== "_expression"
        ) {
          throw unsupported(file, statement, "recursive binding group");
        }
        const loweredValue = lowerExpression(file, groupedValue);
        bindings.push({
          name: identifierName(file, name, "recursive binding name"),
          value: loweredValue,
          span: spanFrom(sourceSpan(file, name), loweredValue.span),
        });
      }
      return {
        kind: "recursiveGroup",
        declarationKind: tokenField(statement, "kind")?.text === "const"
          ? "const"
          : "let",
        bindings,
        span: sourceSpan(file, statement),
      };
    }
    const unionPattern = findRule(bindingPattern, "union_pattern");
    if (unionPattern !== undefined) {
      const alternative = statement.field("alternative");
      if (!isCursor(alternative)) {
        throw new SyntaxError(
          `${file}:${statement.span.start}: refutable Ducklang binding requires an else block`,
        );
      }
      const payload = requiredField(unionPattern, "value");
      return {
        kind: "unionBinding",
        declarationKind: tokenField(statement, "kind")?.text === "const"
          ? "const"
          : "let",
        caseName: tokenText(
          file,
          requiredField(unionPattern, "case"),
          "union binding case",
        ),
        name: identifierName(file, payload, "union payload binding"),
        value,
        alternative: lowerExpression(file, alternative),
        span: sourceSpan(file, statement),
      };
    }
    const tuplePattern = findRule(bindingPattern, "binding_product_pattern");
    const arrayPattern = findRule(bindingPattern, "array_pattern");
    const productPattern = tuplePattern ?? arrayPattern;
    if (productPattern !== undefined) {
      const tokens: TokenCursor[] = [];
      collectAllTokens(productPattern, tokens);
      const names = tokens.flatMap((token) => {
        if (token.kind === "identifier") {
          return [identifierName(file, token, "product binding")];
        }
        if (token.text === "_") return [undefined];
        return [];
      });
      return {
        kind: "productBinding",
        declarationKind: tokenField(statement, "kind")?.text === "const"
          ? "const"
          : "let",
        productKind: arrayPattern === undefined ? "tuple" : "array",
        names,
        value,
        span: sourceSpan(file, statement),
      };
    }
    const imported = lowerImportStatement(file, statement, value);
    if (imported !== undefined) return imported;
    const singlePattern = descendSingleRule(
      bindingPattern,
      new Set(["_binding_pattern", "_single_binding_pattern"]),
    );
    if (singlePattern.type === "rule" && singlePattern.name === "wildcard") {
      return undefined;
    }
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
      value,
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "type_declaration_statement") {
    const definition = requiredField(statement, "definition");
    const typeSum = findRule(definition, "type_sum");
    if (typeSum === undefined) {
      return {
        kind: "typeAlias",
        name: identifierName(
          file,
          requiredField(statement, "name"),
          "type alias name",
        ).text,
        parameters: tokenFields(statement, "parameter").map((token) =>
          token.text
        ),
        target: lowerTypeReference(file, definition),
        span: sourceSpan(file, statement),
      };
    }
    return {
      kind: "unionType",
      name: identifierName(
        file,
        requiredField(statement, "name"),
        "type declaration name",
      ).text,
      parameters: tokenFields(statement, "parameter").map((token) =>
        token.text
      ),
      cases: typeSum.children().flatMap((child) => {
        if (child.type !== "rule" || child.name !== "type_case") return [];
        const name = requiredField(child, "name");
        return [{
          name: tokenText(file, name, "union case name"),
          payloadType: lowerTypeReference(file, child),
          span: sourceSpan(file, child),
        }];
      }),
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
  if (statement.name === "return_statement") {
    return {
      kind: "return",
      expression: lowerExpression(file, requiredField(statement, "value")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "for_statement") {
    const end = statement.field("end");
    if (!isCursor(end)) {
      throw unsupported(file, statement, "collection loop");
    }
    const start = statement.field("start_or_collection") ??
      statement.field("start");
    if (!isCursor(start)) {
      throw new Error("Ducklang range loop has no start expression");
    }
    const first = statement.field("first");
    const iterator =
      isCursor(first) && findRule(first, "wildcard") === undefined
        ? identifierName(file, first, "range iterator")
        : undefined;
    const step = statement.field("step");
    return {
      kind: "forRange",
      iterator,
      start: lowerExpression(file, start),
      end: lowerExpression(file, end),
      step: isCursor(step) ? lowerExpression(file, step) : undefined,
      inclusive: statement.children().some((child) =>
        child.type === "token" && child.text === "..="
      ),
      body: lowerExpression(file, requiredField(statement, "body")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "break_statement") {
    const value = statement.field("value");
    return {
      kind: "break",
      value: isCursor(value) ? lowerExpression(file, value) : undefined,
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "continue_statement") {
    return { kind: "continue", span: sourceSpan(file, statement) };
  }
  throw unsupported(file, statement, statement.name);
}

function lowerHostCall(
  file: string,
  input: SyntaxCursor,
): DucklangExpression {
  const application = findRule(input, "application_expression");
  const postfix = application === undefined
    ? undefined
    : findRule(application, "postfix_expression");
  if (application === undefined || postfix === undefined) {
    throw unsupported(file, input, "effect operation call");
  }
  const names: TokenCursor[] = [];
  collectTokens(postfix, names, "identifier");
  if (names.length !== 2) {
    throw unsupported(file, postfix, "effect operation reference");
  }
  const arguments_ = cursorFields(application, "argument").flatMap((argument) =>
    lowerCallArguments(file, argument)
  );
  return {
    kind: "hostCall",
    effectName: names[0].text,
    operationName: names[1].text,
    arguments: arguments_,
    span: sourceSpan(file, application),
  };
}

function lowerTypeReference(
  file: string,
  input: SyntaxCursor,
): DucklangTypeReference {
  const application = findRule(input, "type_application");
  if (application === undefined) {
    const name = identifierName(file, input, "type reference");
    return { name: name.text, arguments: [], span: sourceSpan(file, input) };
  }
  const arguments_ = cursorFields(application, "argument");
  const argumentSet = new Set(arguments_);
  const base = application.children().find((child) =>
    child.type === "rule" && !argumentSet.has(child)
  );
  if (base === undefined) {
    throw unsupported(file, application, "type application base");
  }
  const name = identifierName(file, base, "type reference");
  return {
    name: name.text,
    arguments: arguments_.map((argument) => lowerTypeReference(file, argument)),
    span: sourceSpan(file, application),
  };
}

function lowerImportStatement(
  file: string,
  statement: RuleCursor,
  value: DucklangExpression,
): DucklangStatement | undefined {
  const imported = value.kind === "moduleImport"
    ? value
    : value.kind === "call" && value.callee.kind === "moduleImport" &&
        value.arguments.length === 0
    ? value.callee
    : undefined;
  if (imported === undefined) return undefined;
  const pattern = requiredField(statement, "name");
  const namedShape = findRule(pattern, "named_shape_pattern");
  const wildcard = findRule(pattern, "wildcard");
  const namespace = namedShape === undefined && wildcard === undefined
    ? identifierName(file, pattern, "import namespace")
    : undefined;
  return {
    kind: "import",
    path: imported.path,
    selections: namedShape === undefined
      ? []
      : lowerImportSelections(file, namedShape),
    namespace,
    open: tokenField(statement, "open") !== undefined,
    span: sourceSpan(file, statement),
  };
}

function lowerImportSelections(
  file: string,
  pattern: RuleCursor,
): readonly DucklangImportSelection[] {
  return pattern.children().flatMap(
    (child): readonly DucklangImportSelection[] => {
      if (child.type !== "rule") return [];
      if (child.name === "shorthand_shape_pattern_field") {
        const name = requiredField(child, "name");
        const localName = identifierName(file, name, "import selection");
        return [{
          exportName: localName.text,
          localName,
          span: sourceSpan(file, child),
        }];
      }
      if (child.name !== "named_shape_pattern_field") return [];
      const exportName = identifierName(
        file,
        requiredField(child, "name"),
        "import export",
      ).text;
      const selectedPattern = child.field("pattern");
      if (!isCursor(selectedPattern) || findRule(selectedPattern, "wildcard")) {
        return [{
          exportName,
          localName: undefined,
          span: sourceSpan(file, child),
        }];
      }
      return [{
        exportName,
        localName: identifierName(file, selectedPattern, "import alias"),
        span: sourceSpan(file, child),
      }];
    },
  );
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
          recursive: false,
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

    const operands = [
      lowerExpression(file, leftCursor),
      ...rightOperands.map((right) => lowerExpression(file, right)),
    ];
    const expressionStack: DucklangExpression[] = [operands[0]];
    const operatorStack: TokenCursor[] = [];
    const reduce = () => {
      const operator = operatorStack.pop();
      const right = expressionStack.pop();
      const left = expressionStack.pop();
      if (operator === undefined || left === undefined || right === undefined) {
        throw new Error(
          `rule ${cursor.name} has an invalid binary operator sequence`,
        );
      }
      expressionStack.push(lowerBinaryExpression(operator.text, left, right));
    };
    const precedence = (operator: string): number => {
      if (operator === "$" || operator === "|>") return 10;
      if (operator === "||") return 20;
      if (operator === "&&") return 30;
      if (["==", "!=", "<", ">", "<=", ">="].includes(operator)) {
        return 40;
      }
      if (operator === "+" || operator === "-") return 60;
      return 70;
    };
    for (let index = 0; index < operators.length; index += 1) {
      const operator = operators[index];
      while (
        operatorStack.length > 0 &&
        precedence(operatorStack.at(-1)!.text) >= precedence(operator.text)
      ) {
        reduce();
      }
      operatorStack.push(operator);
      expressionStack.push(operands[index + 1]);
    }
    while (operatorStack.length > 0) reduce();
    if (expressionStack.length !== 1) {
      throw new Error(
        `rule ${cursor.name} produced ${expressionStack.length} binary expressions`,
      );
    }
    return expressionStack[0];
  }

  if (
    cursor.name === "unary_expression" ||
    cursor.name === "condition_unary_expression"
  ) {
    const operator = tokenField(cursor, "operator") ??
      cursor.children().find((child): child is TokenCursor =>
        child.type === "token" && (child.text === "!" || child.text === "-")
      );
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
    if (
      expression.kind === "call" &&
      expression.callee.kind === "reference" &&
      expression.callee.name.text === "loop" &&
      expression.arguments.length === 1 &&
      expression.arguments[0].kind === "block"
    ) {
      return {
        kind: "loop",
        body: expression.arguments[0],
        span: sourceSpan(file, cursor),
      };
    }
    return expression;
  }

  if (cursor.name === "condition_call_expression") {
    const [callee, ...suffixes] = cursor.children().filter((child) =>
      child.type === "rule"
    );
    if (callee === undefined) {
      throw unsupported(file, cursor, "condition call callee");
    }
    let expression = lowerExpression(file, callee);
    for (const suffix of suffixes) {
      const argument = suffix.field("argument");
      if (!isCursor(argument)) {
        throw unsupported(file, suffix, "condition field or index postfix");
      }
      expression = {
        kind: "call",
        callee: expression,
        arguments: lowerCallArguments(file, argument),
        span: spanFrom(expression.span, sourceSpan(file, suffix)),
      };
    }
    return expression;
  }

  if (cursor.name === "postfix_expression") {
    const children = cursor.children().filter((child) => child.type === "rule");
    const [primary, ...suffixes] = children;
    if (primary === undefined) {
      throw unsupported(file, cursor, "postfix expression primary");
    }
    let expression = lowerExpression(file, primary);
    for (const suffix of suffixes) {
      const index = suffix.field("index");
      if (!isCursor(index)) {
        throw unsupported(file, suffix, "field or effect-handler postfix");
      }
      expression = {
        kind: "index",
        collection: expression,
        index: lowerExpression(file, index),
        span: spanFrom(expression.span, sourceSpan(file, suffix)),
      };
    }
    return expression;
  }

  if (cursor.name === "arrow_function") {
    const parameters = lowerParameters(
      file,
      requiredField(cursor, "parameters"),
    );
    const body = lowerExpression(file, requiredField(cursor, "body"));
    return {
      kind: "function",
      recursive: false,
      parameters,
      body,
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "recursive_expression") {
    const operand = requiredField(cursor, "operand");
    const bodyField = cursor.field("body");
    if (isCursor(bodyField)) {
      return {
        kind: "function",
        recursive: true,
        parameters: arrowParameters(file, operand),
        body: lowerExpression(file, bodyField),
        span: sourceSpan(file, cursor),
      };
    }
    const recursiveArguments = descendSingleRule(
      operand,
      new Set(["parenthesized_or_product"]),
    );
    if (
      recursiveArguments.type !== "rule" ||
      recursiveArguments.name !== "positional_product"
    ) {
      throw unsupported(file, operand, "recursive call arguments");
    }
    return {
      kind: "recursiveCall",
      arguments: lowerCallArguments(file, recursiveArguments),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "if_expression") {
    const pattern = cursor.field("pattern");
    if (isCursor(pattern)) {
      const unionPattern = findRule(pattern, "union_pattern");
      if (unionPattern === undefined) {
        const literal = descendSingleRule(
          pattern,
          new Set(["_match_pattern", "_single_match_pattern"]),
        );
        if (literal.type !== "token") {
          throw unsupported(file, pattern, "if-let pattern");
        }
        const value = lowerExpression(file, requiredField(cursor, "value"));
        const literalExpression = lowerTokenExpression(file, literal);
        const alternative = cursor.field("alternative");
        return {
          kind: "if",
          condition: {
            kind: "binary",
            operator: "==",
            left: value,
            right: literalExpression,
            span: {
              file,
              start: literalExpression.span.start,
              end: value.span.end,
            },
          },
          consequence: lowerExpression(
            file,
            requiredField(cursor, "consequence"),
          ),
          alternative: isCursor(alternative)
            ? lowerExpression(file, alternative)
            : undefined,
          span: sourceSpan(file, cursor),
        };
      }
      const payload = requiredField(unionPattern, "value");
      const payloadName = payload.type === "token" &&
          payload.kind === "identifier"
        ? identifierName(file, payload, "union payload binding")
        : undefined;
      const alternative = cursor.field("alternative");
      return {
        kind: "ifUnion",
        caseName: tokenText(
          file,
          requiredField(unionPattern, "case"),
          "union pattern case",
        ),
        payloadName,
        value: lowerExpression(file, requiredField(cursor, "value")),
        consequence: lowerExpression(
          file,
          requiredField(cursor, "consequence"),
        ),
        alternative: isCursor(alternative)
          ? lowerExpression(file, alternative)
          : undefined,
        span: sourceSpan(file, cursor),
      };
    }
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
    const statements = cursor.children().flatMap((child) => {
      if (child.type !== "rule" || child.name !== "_statement") return [];
      const statement = lowerModuleStatement(file, child);
      return statement === undefined ? [] : [statement];
    });
    return {
      kind: "block",
      statements,
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "scratch_expression") {
    return {
      kind: "scratch",
      body: lowerExpression(file, requiredField(cursor, "body")),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "parenthesized_expression") {
    return lowerExpression(file, onlyRuleChild(cursor));
  }

  if (cursor.name === "import_expression") {
    const path = tokenField(cursor, "path");
    if (path === undefined) {
      throw new Error("Ducklang import expression has no path token");
    }
    return {
      kind: "moduleImport",
      path: decodeStringLiteral(file, path),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "union_case") {
    return {
      kind: "unionCase",
      caseName: tokenText(
        file,
        requiredField(cursor, "case"),
        "union case",
      ),
      value: lowerExpression(file, requiredField(cursor, "value")),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "unit_pattern") {
    return { kind: "unit", span: sourceSpan(file, cursor) };
  }

  if (cursor.name === "positional_product") {
    return {
      kind: "product",
      productKind: "tuple",
      values: cursor.children().flatMap((child) =>
        child.type === "rule" && child.name === "_expression"
          ? [lowerExpression(file, child)]
          : []
      ),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "array_expression") {
    return {
      kind: "product",
      productKind: "array",
      values: cursor.children().flatMap((child) =>
        child.type === "rule" && child.name === "_expression"
          ? [lowerExpression(file, child)]
          : []
      ),
      span: sourceSpan(file, cursor),
    };
  }

  throw unsupported(file, cursor, cursor.name);
}

function lowerBinaryExpression(
  operator: string,
  left: DucklangExpression,
  right: DucklangExpression,
): DucklangExpression {
  const span = spanFrom(left.span, right.span);
  if (operator === "$") {
    return { kind: "call", callee: left, arguments: [right], span };
  }
  if (operator === "|>") {
    return { kind: "call", callee: right, arguments: [left], span };
  }
  return { kind: "binary", operator, left, right, span };
}

function lowerTokenExpression(
  file: string,
  cursor: TokenCursor,
): DucklangExpression {
  const span = sourceSpan(file, cursor);
  if (cursor.kind === "number") {
    if (/^[0-9]+i64$/.test(cursor.text)) {
      const value = BigInt(cursor.text.slice(0, -3));
      if (value > 9_223_372_036_854_775_807n) {
        throw new SyntaxError(
          `${file}:${cursor.span.start}: integer literal ${cursor.text} is outside signed i64`,
        );
      }
      return { kind: "integer64", value, span };
    }
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
  if (cursor.kind === "string") {
    return { kind: "string", value: decodeStringLiteral(file, cursor), span };
  }
  if (cursor.kind === "character") {
    const value = decodeCharacterLiteral(file, cursor);
    return { kind: "integer", value, span };
  }
  if (cursor.kind === "identifier" || cursor.text === "loop") {
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
    new Set([
      "parenthesized_or_product",
      "postfix_expression",
      "_primary_expression",
    ]),
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
  if (input.name === "const_parameter_list") {
    return constParameterNames(file, input);
  }
  if (input.name === "parameter") {
    return [identifierName(file, requiredField(input, "name"), "parameter")];
  }
  throw unsupported(file, input, input.name);
}

function constParameterNames(
  file: string,
  cursor: RuleCursor,
): readonly DucklangParameter[] {
  const tokens: TokenCursor[] = [];
  collectAllTokens(cursor, tokens);
  const list = tokens.find((token) => token.kind === "CONST_PARAMETER_LIST");
  if (list === undefined) {
    throw new Error("Ducklang const parameter list has no fused token");
  }
  const parameters = list.text.slice(1, -1).split(",");
  let searchStart = 1;
  return parameters.map((parameter) => {
    const match = parameter.trim().match(
      /^(?:const\s+)?(?:\.\.\.)?([A-Za-z][A-Za-z0-9_]*)(?:\s*:\s*(I32|I64|Bool|Text))?$/,
    );
    if (match === null) {
      throw unsupported(file, list, "const parameter list");
    }
    const nameOffset = list.text.indexOf(match[1], searchStart);
    if (nameOffset < 0) {
      throw new Error(
        `Ducklang const parameter ${match[1]} has no source span`,
      );
    }
    searchStart = nameOffset + match[1].length;
    return {
      text: match[1],
      ...(match[2] === undefined ? {} : {
        declaredType: match[2] as "I32" | "I64" | "Bool" | "Text",
      }),
      span: {
        file,
        start: list.span.start + nameOffset,
        end: list.span.start + nameOffset + match[1].length,
      },
    };
  });
}

function arrowParameters(
  file: string,
  cursor: SyntaxCursor,
): readonly DucklangParameter[] {
  const tokens: TokenCursor[] = [];
  collectAllTokens(cursor, tokens);
  const parameterTokens = tokens.filter((token) =>
    token.text !== "(" && token.text !== ")"
  );
  const groups: TokenCursor[][] = [[]];
  for (const token of parameterTokens) {
    if (token.text === ",") {
      groups.push([]);
      continue;
    }
    groups.at(-1)!.push(token);
  }
  if (groups.length === 1 && groups[0].length === 0) {
    return [];
  }
  return groups.map((group) => {
    const [name, separator, annotation] = group;
    if (group.length === 1 && name?.text === "_") {
      return {
        text: `discarded_parameter_${name.span.start}`,
        span: sourceSpan(file, name),
      };
    }
    const plain = group.length === 1 && name?.kind === "identifier";
    const annotated = group.length === 3 && name?.kind === "identifier" &&
      separator?.text === ":" && annotation?.kind === "identifier";
    if (!plain && !annotated) {
      throw unsupported(
        file,
        group[0] ?? cursor,
        "patterned parameter or unsupported type annotation",
      );
    }
    return {
      text: name.text,
      ...(annotation === undefined ? {} : {
        declaredType: annotation.text,
      }),
      span: sourceSpan(file, name),
    };
  });
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

function tokenText(
  file: string,
  input: SyntaxCursor,
  subject: string,
): string {
  if (input.type !== "token") throw unsupported(file, input, subject);
  return input.text;
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

function findRule(cursor: SyntaxCursor, name: string): RuleCursor | undefined {
  if (cursor.type === "token") return undefined;
  if (cursor.name === name) return cursor;
  for (const child of cursor.children()) {
    const found = findRule(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function hasIdentityForallParameter(cursor: SyntaxCursor): boolean {
  const functionType = findRule(cursor, "function_type");
  const parameterType = functionType?.children().find((child) =>
    child.type === "rule" && child.name === "type_union"
  );
  const forall = parameterType === undefined
    ? undefined
    : findRule(parameterType, "forall_type");
  if (forall === undefined) return false;
  const tokens: TokenCursor[] = [];
  collectAllTokens(forall, tokens);
  const identifiers = tokens.filter((token) => token.kind === "identifier");
  return identifiers.length === 3 &&
    identifiers[0].text === identifiers[1].text &&
    identifiers[1].text === identifiers[2].text &&
    tokens.some((token) => token.text === "->");
}

function decodeStringLiteral(file: string, token: TokenCursor): string {
  try {
    return JSON.parse(token.text) as string;
  } catch (cause) {
    throw new SyntaxError(
      `${file}:${token.span.start}: invalid Ducklang string literal ${token.text}`,
      { cause },
    );
  }
}

function decodeCharacterLiteral(file: string, token: TokenCursor): number {
  try {
    const contents = token.text.slice(1, -1).replaceAll('"', '\\"');
    const value = JSON.parse(`"${contents}"`) as string;
    const characters = [...value];
    const character = characters[0];
    if (characters.length !== 1 || character === undefined) {
      throw new Error("not one character");
    }
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) throw new Error("empty character");
    return codePoint;
  } catch (cause) {
    throw new SyntaxError(
      `${file}:${token.span.start}: invalid Ducklang character literal ${token.text}`,
      { cause },
    );
  }
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

import type {
  CursorFieldValue,
  RuleCursor,
  SyntaxCursor,
  TokenCursor,
} from "@mewhhaha/baba/runtime/generated-wasm";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import {
  type DucklangEffectRow,
  type DucklangExpression,
  type DucklangExtensionDeclaration,
  type DucklangFixityDeclaration,
  type DucklangImportSelection,
  type DucklangModule,
  type DucklangName,
  ducklangNamedType,
  type DucklangParameter,
  type DucklangProtocolDeclaration,
  type DucklangRecordField,
  type DucklangStatement,
  type DucklangTypeReference,
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
const stringPatternMatchesName = "$duck_string_pattern_matches";
const stringPatternCaptureName = "$duck_string_pattern_capture";
const typePatternMatchesName = "$duck_type_pattern_matches";
type DucklangParser = ReturnType<typeof createParser>;
let parserPromise: Promise<DucklangParser> | undefined;

export type DucklangParseTimings = {
  readonly parserInitializationMilliseconds: number;
  readonly contextualClassificationMilliseconds: number;
  readonly parserExecutionMilliseconds: number;
  readonly syntaxMilliseconds: number;
  readonly astLoweringMilliseconds: number;
};

export class DucklangSyntaxError extends SyntaxError {
  readonly timings: DucklangParseTimings;

  constructor(message: string, timings: DucklangParseTimings) {
    super(message);
    this.name = "DucklangSyntaxError";
    this.timings = timings;
  }
}

export async function parseDucklangModule(
  file: string,
  source: string,
): Promise<DucklangModule> {
  return (await parseDucklangModuleWithTimings(file, source)).module;
}

export async function parseDucklangModuleWithTimings(
  file: string,
  source: string,
): Promise<
  {
    readonly module: DucklangModule;
    readonly timings: DucklangParseTimings;
  }
> {
  const initializationStart = performance.now();
  const parser = await getDucklangParser();
  const parserInitializationMilliseconds = performance.now() -
    initializationStart;

  const contextualClassificationStart = performance.now();
  const classifiedSource = classifyContextualTokens(source);
  const contextualClassificationMilliseconds = performance.now() -
    contextualClassificationStart;

  const parserExecutionStart = performance.now();
  const result = parser.parse(classifiedSource, {
    maxTraceActions: 10_000_000,
  });
  const parserExecutionMilliseconds = performance.now() -
    parserExecutionStart;
  const syntaxMilliseconds = contextualClassificationMilliseconds +
    parserExecutionMilliseconds;
  if (!result.ok) {
    const diagnostic = result.diagnostics[0];
    throw new DucklangSyntaxError(
      `${file}:${diagnostic.span.start}: ${diagnostic.message}`,
      {
        parserInitializationMilliseconds,
        contextualClassificationMilliseconds,
        parserExecutionMilliseconds,
        syntaxMilliseconds,
        astLoweringMilliseconds: 0,
      },
    );
  }
  const astLoweringStart = performance.now();
  const document = findRule(result.cursor, "document") ?? result.cursor;
  const protocols: DucklangProtocolDeclaration[] = [];
  const extensions: DucklangExtensionDeclaration[] = [];
  const fixities: DucklangFixityDeclaration[] = [];
  const loweredStatements = document.children().flatMap((cursor) => {
    const declaration = lowerDispatchDeclaration(file, cursor);
    if (declaration?.kind === "protocol") {
      protocols.push(declaration.value);
      return [];
    }
    if (declaration?.kind === "extension") {
      extensions.push(declaration.value);
      return [];
    }
    if (declaration?.kind === "fixity") {
      fixities.push(declaration.value);
      return [];
    }
    if (
      findRule(cursor, "fixity_declaration_statement") !== undefined
    ) {
      return [];
    }
    const statement = lowerModuleStatement(file, cursor);
    return statement === undefined ? [] : [statement];
  });
  const moduleHeader = findRule(document, "module_header");
  const moduleReturn = findRule(document, "module_return_statement");
  const exportBlock = moduleReturn === undefined
    ? undefined
    : findRule(moduleReturn, "field_block") ??
      findRule(moduleReturn, "shape_field_block");
  const exportNames = exportBlock === undefined
    ? []
    : lowerRecordFields(file, exportBlock).map((field) => field.name);
  const parameterList = moduleHeader === undefined
    ? undefined
    : findRule(moduleHeader, "parameter_list");
  const splitStatements = loweredStatements.flatMap((statement) => {
    if (
      statement.kind !== "binding" ||
      statement.value.kind !== "function" ||
      statement.value.body.kind !== "binary" ||
      statement.value.body.left.kind !== "call" ||
      statement.value.body.left.callee.kind !== "block" ||
      statement.value.body.left.arguments.length !== 1
    ) {
      return [statement];
    }
    const body = statement.value.body.left.callee;
    const trailingExpression = statement.value.body.left.arguments[0];
    if (
      !source.slice(body.span.end, trailingExpression.span.start).includes(
        "\n",
      )
    ) {
      return [statement];
    }
    const resultExpression: DucklangExpression = {
      ...statement.value.body,
      left: trailingExpression,
      span: spanFrom(
        trailingExpression.span,
        statement.value.body.right.span,
      ),
    };
    return [
      {
        ...statement,
        value: {
          ...statement.value,
          body,
          span: { ...statement.value.span, end: body.span.end },
        },
        span: { ...statement.span, end: body.span.end },
      },
      {
        kind: "expression" as const,
        expression: resultExpression,
        span: resultExpression.span,
      },
    ];
  });
  const statements: DucklangStatement[] = [];
  for (let index = 0; index < splitStatements.length; index += 1) {
    const statement = splitStatements[index];
    if (statement.kind !== "binding" || !statement.recursive) {
      statements.push(statement);
      continue;
    }
    const bindings = [{
      name: statement.name,
      value: statement.value,
      span: statement.span,
    }];
    while (index + 1 < splitStatements.length) {
      const candidate = splitStatements[index + 1];
      if (
        candidate.kind !== "expression" ||
        candidate.expression.kind !== "binary" ||
        candidate.expression.operator !== "=" ||
        candidate.expression.left.kind !== "call" ||
        candidate.expression.left.callee.kind !== "reference" ||
        candidate.expression.left.callee.name.text !== "and" ||
        candidate.expression.left.arguments.length !== 1 ||
        candidate.expression.left.arguments[0].kind !== "reference" ||
        !source.slice(candidate.span.start).startsWith("and ")
      ) {
        break;
      }
      const name = candidate.expression.left.arguments[0].name;
      const value = candidate.expression.right;
      bindings.push({
        name,
        value,
        span: spanFrom(name.span, value.span),
      });
      index += 1;
    }
    if (bindings.length === 1) {
      statements.push(statement);
      continue;
    }
    statements.push({
      kind: "recursiveGroup",
      declarationKind: statement.declarationKind === "const" ? "const" : "let",
      bindings,
      span: spanFrom(statement.span, bindings.at(-1)!.span),
    });
  }
  const typedMetadata: DucklangStatement[] = source.includes("@describe_type")
    ? [{
      kind: "structType",
      name: "$TypeDescription",
      parameters: [],
      fields: [{
        name: "size",
        type: {
          name: "I32",
          arguments: [],
          span: sourceSpan(file, result.cursor),
        },
        span: sourceSpan(file, result.cursor),
      }],
      span: sourceSpan(file, result.cursor),
    }]
    : [];
  const module = {
    file,
    exportNames,
    parameters: parameterList === undefined
      ? []
      : parameterList.children().flatMap((parameter) =>
        parameter.type === "rule" && parameter.name === "parameter"
          ? (() => {
            const name = identifierName(
              file,
              requiredField(parameter, "name"),
              "module parameter",
            );
            const declaredType = parameter.field("type");
            const declaredTypeReference = isCursor(declaredType)
              ? lowerTypeReference(file, declaredType)
              : undefined;
            return [{
              ...name,
              ...(declaredTypeReference === undefined
                ? {}
                : { declaredType: declaredTypeReference }),
            }];
          })()
          : []
      ),
    protocols,
    extensions: extensions.map((extension) => ({
      ...extension,
      methods: extension.methods.map((method) => ({
        ...method,
        value: normalizeExpressionStatementBoundaries(method.value, source),
      })),
    })),
    fixities,
    statements: normalizeStatementBoundaries(
      [...typedMetadata, ...statements],
      source,
    ),
    span: sourceSpan(file, result.cursor),
  };
  return {
    module,
    timings: {
      parserInitializationMilliseconds,
      contextualClassificationMilliseconds,
      parserExecutionMilliseconds,
      syntaxMilliseconds,
      astLoweringMilliseconds: performance.now() - astLoweringStart,
    },
  };
}

function normalizeStatementBoundaries(
  statements: readonly DucklangStatement[],
  source: string,
  typeParameters: readonly string[] = [],
): readonly DucklangStatement[] {
  const repairedStatements: DucklangStatement[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const followingStatement = statements[index + 1];
    const repaired = repairConditionalAssignment(
      statement,
      followingStatement,
    );
    repairedStatements.push(repaired ?? statement);
    if (repaired !== undefined) index += 1;
  }

  return repairedStatements.flatMap((statement) => {
    const normalized = normalizeStatementExpressions(
      statement,
      source,
      typeParameters,
    );
    if (
      normalized.kind === "expression" &&
      normalized.expression.kind === "call" &&
      normalized.expression.arguments.length === 0 &&
      normalized.expression.callee.kind === "call"
    ) {
      const precedingExpressionEnd =
        normalized.expression.callee.arguments.at(-1)?.span.end ??
          normalized.expression.callee.span.end;
      const separator = source.slice(
        precedingExpressionEnd,
        normalized.expression.span.end,
      );
      const unitOffset = separator.lastIndexOf("()");
      if (separator.includes("\n") && unitOffset >= 0) {
        const unitStart = precedingExpressionEnd + unitOffset;
        const precedingExpression = {
          ...normalized.expression.callee,
          span: {
            ...normalized.expression.callee.span,
            end: precedingExpressionEnd,
          },
        };
        const unit: DucklangExpression = {
          kind: "unit",
          span: {
            file: normalized.span.file,
            start: unitStart,
            end: unitStart + 2,
          },
        };
        return [
          {
            kind: "expression" as const,
            expression: precedingExpression,
            span: {
              ...normalized.span,
              end: precedingExpressionEnd,
            },
          },
          {
            kind: "expression" as const,
            expression: unit,
            span: unit.span,
          },
        ];
      }
    }
    if (
      (normalized.kind !== "binding" &&
        normalized.kind !== "productBinding" &&
        normalized.kind !== "recordBinding") ||
      normalized.value.kind !== "call" ||
      normalized.value.arguments.length === 0
    ) {
      return [normalized];
    }
    const initializer = normalized.kind !== "binding" ||
        normalized.name.declaredType === undefined
      ? normalized.value.callee
      : applyNominalProductType(
        normalized.value.callee,
        normalized.name.declaredType,
      );
    const firstFollowingArgument = normalized.value.arguments[0];
    if (
      !source.slice(
        initializer.span.end,
        firstFollowingArgument.span.start,
      ).includes(";")
    ) {
      return [normalized];
    }
    const followingExpression: DucklangExpression =
      normalized.value.arguments.length === 1 ? firstFollowingArgument : {
        kind: "product",
        productKind: "array",
        values: normalized.value.arguments,
        span: spanFrom(
          firstFollowingArgument.span,
          normalized.value.arguments.at(-1)!.span,
        ),
      };
    return [
      {
        ...normalized,
        value: initializer,
        span: { ...normalized.span, end: initializer.span.end },
      },
      {
        kind: "expression" as const,
        expression: followingExpression,
        span: followingExpression.span,
      },
    ];
  });
}

function repairConditionalAssignment(
  statement: DucklangStatement,
  followingStatement: DucklangStatement | undefined,
): DucklangStatement | undefined {
  if (
    statement.kind !== "assignment" ||
    followingStatement?.kind !== "expression"
  ) {
    return undefined;
  }
  // Baba's generalized assignment production can prefer the identifier reading
  // of `if`, splitting `x = if ... { ... } else { ... }` at `else`. Rejoin that
  // one ambiguous surface form before names or statement boundaries become semantic.
  const alternative = trailingElseBlock(followingStatement.expression);
  if (alternative === undefined) return undefined;
  const detached = detachTrailingBlock(statement.value);
  if (detached === undefined) return undefined;
  const condition = removeLeadingIfKeyword(detached.expression);
  if (condition === undefined) return undefined;

  return {
    ...statement,
    value: {
      kind: "if",
      condition,
      consequence: detached.block,
      alternative,
      span: {
        file: statement.span.file,
        start: statement.value.span.start,
        end: alternative.span.end,
      },
    },
    span: { ...statement.span, end: followingStatement.span.end },
  };
}

function trailingElseBlock(
  expression: DucklangExpression,
): Extract<DucklangExpression, { readonly kind: "block" }> | undefined {
  if (
    expression.kind !== "call" ||
    expression.callee.kind !== "reference" ||
    expression.callee.name.text !== "else" ||
    expression.arguments.length !== 1
  ) {
    return undefined;
  }
  const argument = expression.arguments[0];
  if (argument.kind === "block") return argument;
  if (
    argument.kind !== "record" ||
    argument.fields.length !== 1 ||
    argument.fields[0].value.kind !== "reference" ||
    argument.fields[0].name !== argument.fields[0].value.name.text ||
    argument.fields[0].span.start !== argument.fields[0].value.span.start ||
    argument.fields[0].span.end !== argument.fields[0].value.span.end
  ) {
    return undefined;
  }
  return {
    kind: "block",
    statements: [{
      kind: "expression",
      expression: argument.fields[0].value,
      span: argument.fields[0].span,
    }],
    span: argument.span,
  };
}

function detachTrailingBlock(
  expression: DucklangExpression,
): {
  readonly expression: DucklangExpression;
  readonly block: Extract<DucklangExpression, { readonly kind: "block" }>;
} | undefined {
  if (expression.kind === "binary") {
    const detached = detachTrailingBlock(expression.right);
    if (detached === undefined) return undefined;
    return {
      expression: { ...expression, right: detached.expression },
      block: detached.block,
    };
  }
  if (
    expression.kind !== "call" ||
    expression.arguments.at(-1)?.kind !== "block"
  ) {
    return undefined;
  }
  const block = expression.arguments.at(-1) as Extract<
    DucklangExpression,
    { readonly kind: "block" }
  >;
  const argumentsWithoutBlock = expression.arguments.slice(0, -1);
  return {
    expression: argumentsWithoutBlock.length === 0
      ? expression.callee
      : { ...expression, arguments: argumentsWithoutBlock },
    block,
  };
}

function removeLeadingIfKeyword(
  expression: DucklangExpression,
): DucklangExpression | undefined {
  if (expression.kind === "binary") {
    const left = removeLeadingIfKeyword(expression.left);
    return left === undefined ? undefined : { ...expression, left };
  }
  if (
    expression.kind !== "call" ||
    expression.callee.kind !== "reference" ||
    expression.callee.name.text !== "if" ||
    expression.arguments.length !== 1
  ) {
    return undefined;
  }
  return expression.arguments[0];
}

function normalizeStatementExpressions(
  statement: DucklangStatement,
  source: string,
  typeParameters: readonly string[],
): DucklangStatement {
  const normalize = (expression: DucklangExpression) =>
    normalizeExpressionStatementBoundaries(
      expression,
      source,
      typeParameters,
    );
  switch (statement.kind) {
    case "recursiveGroup":
      return {
        ...statement,
        bindings: statement.bindings.map((binding) => ({
          ...binding,
          value: normalize(binding.value),
        })),
      };
    case "typePattern":
      return {
        ...statement,
        target: normalize(statement.target),
      };
    case "binding":
    case "assignment":
      return {
        ...statement,
        value: normalize(statement.value),
      };
    case "unionBinding":
      return {
        ...statement,
        value: normalize(statement.value),
        alternative: normalize(statement.alternative),
      };
    case "productBinding":
    case "recordBinding":
      return {
        ...statement,
        value: normalize(statement.value),
      };
    case "forRange":
      return {
        ...statement,
        start: normalize(statement.start),
        end: normalize(statement.end),
        step: statement.step === undefined
          ? undefined
          : normalize(statement.step),
        body: normalize(statement.body),
      };
    case "forCollection":
      return {
        ...statement,
        collection: normalize(statement.collection),
        body: normalize(statement.body),
      };
    case "break":
      return {
        ...statement,
        value: statement.value === undefined
          ? undefined
          : normalize(statement.value),
      };
    case "return":
    case "expression":
      return {
        ...statement,
        expression: normalize(statement.expression),
      };
    case "effectDeclaration":
    case "initDeclaration":
    case "unionType":
    case "structType":
    case "typeAlias":
    case "import":
    case "continue":
      return statement;
  }
}

function normalizeExpressionStatementBoundaries(
  expression: DucklangExpression,
  source: string,
  typeParameters: readonly string[] = [],
): DucklangExpression {
  const normalize = (child: DucklangExpression) =>
    normalizeExpressionStatementBoundaries(child, source, typeParameters);
  const normalizeFields = (fields: readonly DucklangRecordField[]) =>
    fields.map((field) => ({ ...field, value: normalize(field.value) }));
  switch (expression.kind) {
    case "hostCall":
    case "recursiveCall":
      return {
        ...expression,
        arguments: expression.arguments.map(normalize),
      };
    case "effectHandler":
      return { ...expression, fields: normalizeFields(expression.fields) };
    case "handle":
      return {
        ...expression,
        body: normalize(expression.body),
        handler: normalize(expression.handler),
      };
    case "optionDo":
      return { ...expression, option: normalize(expression.option) };
    case "unionCase":
      return { ...expression, value: normalize(expression.value) };
    case "product":
      return { ...expression, values: expression.values.map(normalize) };
    case "field":
      return { ...expression, product: normalize(expression.product) };
    case "recordUpdate":
      return {
        ...expression,
        product: normalize(expression.product),
        fields: normalizeFields(expression.fields),
      };
    case "record":
      return { ...expression, fields: normalizeFields(expression.fields) };
    case "function": {
      const functionTypeParameters = [
        ...new Set([
          ...typeParameters,
          ...(expression.typeParameters ?? []),
          ...expression.parameters.flatMap((parameter) =>
            parameter.compileTimeRecord === true &&
              parameter.declaredType === undefined
              ? [parameter.text]
              : []
          ),
        ]),
      ];
      const body = normalizeExpressionStatementBoundaries(
        expression.body,
        source,
        functionTypeParameters,
      );
      return {
        ...expression,
        ...(functionTypeParameters.length === 0
          ? {}
          : { typeParameters: functionTypeParameters }),
        body: expression.declaredResultType === undefined ||
            (expression.declaredResultType.name === "$function" &&
              body.kind === "function")
          ? body
          : applyNominalProductType(body, expression.declaredResultType),
      };
    }
    case "call":
      return {
        ...expression,
        callee: normalize(expression.callee),
        arguments: expression.arguments.map(normalize),
      };
    case "index":
      return {
        ...expression,
        collection: normalize(expression.collection),
        index: normalize(expression.index),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: normalize(expression.product),
        index: normalize(expression.index),
        value: normalize(expression.value),
      };
    case "binary":
      return reassociateBinaryExpression({
        ...expression,
        left: normalize(expression.left),
        right: normalize(expression.right),
      }, source);
    case "unary":
      return { ...expression, operand: normalize(expression.operand) };
    case "if":
      return {
        ...expression,
        condition: normalize(expression.condition),
        consequence: normalize(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : normalize(expression.alternative),
      };
    case "ifUnion":
      return {
        ...expression,
        value: normalize(expression.value),
        consequence: normalize(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : normalize(expression.alternative),
      };
    case "block":
      return {
        ...expression,
        statements: normalizeStatementBoundaries(
          expression.statements,
          source,
          typeParameters,
        ),
      };
    case "comptime":
      return { ...expression, expression: normalize(expression.expression) };
    case "scratch":
    case "loop":
      return { ...expression, body: normalize(expression.body) };
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
    case "reference":
      return expression;
  }
}

function classifyContextualTokens(source: string): string {
  const classified = source.split("");
  classifyMultilineArrowParameters(source, classified);
  const patterns = {
    lineArrayOpen: /[\r\n][ \t]*\[/y,
    dottedShorthand: /\.[A-Za-z][A-Za-z0-9_]*(?=[ \t\r\n]*(?:,|\}))/y,
    trailingArrayClose: /,[ \t\r\n]*\]/y,
    trailingShapeClose: /,[ \t\r\n]*\}/y,
    caretOperator: /\^{2,}/y,
    handlerKeyword: /handler(?=[ \t]+[A-Z])/y,
    floatLiteral: /([0-9])([0-9]*\.[0-9]+f(?:32|64))\b/y,
    hexadecimalLiteral: /0[xX][0-9A-Fa-f]+\b/y,
    discardedArrow: /_[ \t]*=>/y,
    singleArrowParameter: /([A-Za-z][A-Za-z0-9_]*)([ \t]*)=>/y,
    recordShape: /\{[ \t\r\n]*\./y,
    shorthandRecord:
      /\{[ \t\r\n]*[A-Za-z][A-Za-z0-9_]*(?:[ \t\r\n]*,[ \t\r\n]*[A-Za-z][A-Za-z0-9_]*)+[ \t\r\n]*\}/y,
  };
  const matchAt = (pattern: RegExp, index: number): RegExpExecArray | null => {
    pattern.lastIndex = index;
    return pattern.exec(source);
  };
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let lineComment = false;
  const delimiters: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      delimiters.push(character);
    } else if (
      character === ")" || character === "]" || character === "}"
    ) {
      delimiters.pop();
    }
    if (
      (character === "\n" || character === "\r") &&
      delimiters.at(-1) === "("
    ) {
      const arrayStart = matchAt(patterns.lineArrayOpen, index);
      if (arrayStart !== null) {
        for (
          let whitespace = index;
          whitespace < index + arrayStart[0].length - 1;
          whitespace += 1
        ) {
          classified[whitespace] = " ";
        }
      }
    }

    if (character === ".") {
      let precedingDottedField = index - 1;
      while (
        precedingDottedField >= 0 &&
        /[ \t\r\n]/.test(source[precedingDottedField])
      ) {
        precedingDottedField -= 1;
      }
      const dottedShorthand = source[precedingDottedField] === "{" ||
          source[precedingDottedField] === ","
        ? matchAt(patterns.dottedShorthand, index)
        : null;
      if (dottedShorthand !== null) {
        classified[index] = " ";
        index += dottedShorthand[0].length - 1;
        continue;
      }
    }
    if (character === ",") {
      const trailingArrayClose = matchAt(patterns.trailingArrayClose, index);
      if (trailingArrayClose !== null) {
        classified[index] = "\\";
        classified[index + trailingArrayClose[0].length - 1] = "A";
        index += trailingArrayClose[0].length - 1;
        continue;
      }
      const trailingShapeClose = matchAt(patterns.trailingShapeClose, index);
      if (trailingShapeClose !== null) {
        classified[index] = "\\";
        index += trailingShapeClose[0].length - 1;
        continue;
      }
    }
    if (character === "^") {
      const caretOperator = matchAt(patterns.caretOperator, index);
      if (caretOperator !== null) {
        classified[index] = "\\";
        classified[index + caretOperator[0].length - 1] = "C";
        index += caretOperator[0].length - 1;
        continue;
      }
    }
    if (character === "h") {
      const handlerKeyword = matchAt(patterns.handlerKeyword, index);
      if (handlerKeyword !== null) {
        classified[index] = "\\";
        classified[index + handlerKeyword[0].length - 1] = "K";
        index += handlerKeyword[0].length - 1;
        continue;
      }
    }
    if (/[0-9]/.test(character)) {
      const floatLiteral = matchAt(patterns.floatLiteral, index);
      if (floatLiteral !== null) {
        const decimalPoint = index + floatLiteral[0].indexOf(".");
        classified[index] = "\\";
        classified[decimalPoint] = String.fromCharCode(
          "k".charCodeAt(0) + Number.parseInt(floatLiteral[1], 10),
        );
        index += floatLiteral[0].length - 1;
        continue;
      }
      const hexadecimalLiteral = matchAt(
        patterns.hexadecimalLiteral,
        index,
      );
      if (hexadecimalLiteral !== null) {
        classified[index] = "\\";
        classified[index + 1] = "H";
        index += hexadecimalLiteral[0].length - 1;
        continue;
      }
    }
    if (character === "_") {
      const discardedArrow = matchAt(patterns.discardedArrow, index);
      if (
        discardedArrow !== null &&
        canStartBareArrowFunction(source, index)
      ) {
        classified[index] = "\\";
        classified[index + 1] = "D";
        for (
          let padding = index + 2;
          padding < index + discardedArrow[0].length;
          padding += 1
        ) {
          classified[padding] = "~";
        }
        index += discardedArrow[0].length - 1;
        continue;
      }
    }
    if (/[A-Za-z]/.test(character)) {
      const singleArrowParameter = matchAt(
        patterns.singleArrowParameter,
        index,
      );
      if (
        singleArrowParameter !== null &&
        canStartSingleArrowFunction(source, index)
      ) {
        classified[index] = "\\";
        classified[index + singleArrowParameter[0].length - 1] =
          singleArrowParameter[1][0];
        index += singleArrowParameter[0].length - 1;
        continue;
      }
    }
    if (character === "{") {
      let precedingRecord = index - 1;
      while (
        precedingRecord >= 0 &&
        /[ \t\r\n]/.test(source[precedingRecord])
      ) {
        precedingRecord -= 1;
      }
      const precedingCharacter = source[precedingRecord];
      const precedingPair = precedingRecord < 1
        ? ""
        : source.slice(precedingRecord - 1, precedingRecord + 1);
      const recordExpressionContext = precedingRecord < 0 ||
        precedingPair === ":+" ||
        precedingPair === "<&" ||
        precedingCharacter === ";" ||
        precedingCharacter === "}";
      const recordShape = recordExpressionContext
        ? matchAt(patterns.recordShape, index)
        : null;
      if (recordShape !== null) {
        classified[index] = "\\";
        classified[index + recordShape[0].length - 1] = "R";
        index += recordShape[0].length - 1;
        continue;
      }
      const shorthandRecord = recordExpressionContext
        ? matchAt(patterns.shorthandRecord, index)
        : null;
      if (shorthandRecord !== null) {
        classified[index] = "\\";
        classified[index + shorthandRecord[0].length - 1] = "S";
        index += shorthandRecord[0].length - 1;
      }
    }
  }
  return classified.join("");
}

function classifyMultilineArrowParameters(
  source: string,
  classified: string[],
): void {
  for (
    const match of source.matchAll(
      /\([^()]*[\r\n][^()]*\)(?=[ \t\r\n]*=>)/g,
    )
  ) {
    if (!/[:!_]|\bconst\b/.test(match[0])) continue;
    const start = match.index;
    for (let offset = 0; offset < match[0].length; offset += 1) {
      if (match[0][offset] === "\n" || match[0][offset] === "\r") {
        classified[start + offset] = " ";
      }
    }
  }
}

function canStartBareArrowFunction(source: string, start: number): boolean {
  let previous = start - 1;
  while (previous >= 0 && /[ \t\r\n]/.test(source[previous])) previous -= 1;
  if (previous < 0) return true;
  if ("=(:,[{".includes(source[previous])) return true;
  return source[previous] === ">" && source[previous - 1] === "=";
}

function canStartSingleArrowFunction(source: string, start: number): boolean {
  if (!canStartBareArrowFunction(source, start)) return false;
  const prefix = source.slice(0, start).trimEnd();
  const lineStart = Math.max(
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\r"),
  );
  if (
    /\band\s+[A-Za-z][A-Za-z0-9_]*\s*=$/.test(
      prefix.slice(lineStart + 1),
    )
  ) {
    return false;
  }
  if (!prefix.endsWith("=>")) return true;
  const outerParameters = prefix.slice(0, -2).trimEnd();
  if (!outerParameters.endsWith(")")) return true;
  const open = outerParameters.lastIndexOf("(");
  if (open < 0) return true;
  return /[:!_]|\bconst\b/.test(
    outerParameters.slice(open + 1, -1),
  ) || outerParameters.slice(open + 1, -1).trim().length === 0;
}

export async function clearDucklangParserCache(): Promise<void> {
  const pendingParser = parserPromise;
  parserPromise = undefined;
  if (pendingParser === undefined) return;
  (await pendingParser).dispose();
}

function getDucklangParser(): Promise<DucklangParser> {
  if (parserPromise !== undefined) return parserPromise;
  const pendingParser = Promise.all([
    Deno.readFile(parserWasmUrl),
    Deno.readFile(parserPlanUrl),
  ]).then(([bytes, plan]) => createParser({ bytes, plan }));
  parserPromise = pendingParser;
  void pendingParser.catch(() => {
    if (parserPromise === pendingParser) parserPromise = undefined;
  });
  return pendingParser;
}

type DispatchDeclaration =
  | { readonly kind: "protocol"; readonly value: DucklangProtocolDeclaration }
  | { readonly kind: "extension"; readonly value: DucklangExtensionDeclaration }
  | { readonly kind: "fixity"; readonly value: DucklangFixityDeclaration };

function lowerDispatchDeclaration(
  file: string,
  cursor: SyntaxCursor,
): DispatchDeclaration | undefined {
  const declaration = findRule(cursor, "duck_declaration_statement") ??
    findRule(cursor, "extension_declaration_statement") ??
    findRule(cursor, "fixity_declaration_statement");
  if (declaration === undefined) return undefined;
  if (declaration.name === "duck_declaration_statement") {
    const members = findRule(declaration, "duck_member_block");
    if (members === undefined) {
      throw unsupported(file, declaration, "duck member block");
    }
    return {
      kind: "protocol",
      value: {
        name: identifierName(
          file,
          requiredField(declaration, "name"),
          "duck declaration name",
        ).text,
        methods: members.children().flatMap((member) =>
          member.type === "rule" && member.name === "duck_member"
            ? [
              identifierName(
                file,
                requiredField(member, "name"),
                "duck method name",
              ).text,
            ]
            : []
        ),
        span: sourceSpan(file, declaration),
      },
    };
  }
  if (declaration.name === "extension_declaration_statement") {
    const memberBlock = findRule(declaration, "extension_member_block");
    if (memberBlock === undefined) {
      throw unsupported(file, declaration, "extension member block");
    }
    const parameters = cursorFields(declaration, "parameter").map((parameter) =>
      tokenText(file, parameter, "extension parameter")
    );
    return {
      kind: "extension",
      value: {
        targetType: identifierName(
          file,
          requiredField(declaration, "type"),
          "extension target type",
        ).text,
        parameters,
        methods: memberBlock.children().flatMap((member) => {
          if (member.type !== "rule" || member.name !== "shape_field") {
            return [];
          }
          return [{
            name: identifierName(
              file,
              requiredField(member, "name"),
              "extension method name",
            ).text,
            value: lowerExpression(file, requiredField(member, "value")),
            span: sourceSpan(file, member),
          }];
        }),
        span: sourceSpan(file, declaration),
      },
    };
  }
  if (declaration.name !== "fixity_declaration_statement") return undefined;
  const targetTokens: TokenCursor[] = [];
  collectAllTokens(requiredField(declaration, "target"), targetTokens);
  const targetNames = targetTokens.filter((token) =>
    token.kind === "identifier"
  );
  if (
    targetTokens.some((token) =>
      token.kind === "intrinsic_identifier" || token.text.startsWith("@")
    )
  ) {
    return undefined;
  }
  if (targetNames.length === 1) return undefined;
  if (targetNames.length !== 2) {
    throw unsupported(file, declaration, "qualified fixity target");
  }
  const fixity = tokenField(declaration, "fixity");
  const precedence = tokenField(declaration, "precedence");
  const operator = tokenField(declaration, "operator");
  if (
    fixity === undefined || precedence === undefined || operator === undefined
  ) {
    throw unsupported(file, declaration, "fixity declaration fields");
  }
  return {
    kind: "fixity",
    value: {
      fixity: fixity.text as DucklangFixityDeclaration["fixity"],
      precedence: Number.parseInt(precedence.text, 10),
      operator: operatorText(operator),
      protocolName: targetNames[0].text,
      methodName: targetNames[1].text,
      span: sourceSpan(file, declaration),
    },
  };
}

function lowerModuleStatement(
  file: string,
  cursor: SyntaxCursor,
): DucklangStatement | undefined {
  if (cursor.type === "rule") {
    const attributes = cursor.children().filter((child): child is RuleCursor =>
      child.type === "rule" && child.name === "attribute_group"
    );
    if (attributes.length > 0) {
      const attributed = cursor.children().find((child): child is RuleCursor =>
        child.type === "rule" && child.name === "_attributed_module_statement"
      );
      if (attributed === undefined) {
        throw unsupported(file, cursor, "attributed module statement");
      }
      const lowered = lowerModuleStatement(file, attributed);
      const attributeNames = attributes.flatMap((attribute) => {
        const tokens: TokenCursor[] = [];
        collectAllTokens(attribute, tokens);
        return tokens.map((token) => token.text);
      });
      if (attributeNames.includes("test")) {
        if (lowered?.kind !== "binding" || lowered.value.kind !== "function") {
          throw new TypeError(
            `${file}:${
              sourceSpan(file, cursor).start
            }: Ducklang test attribute requires a function binding`,
          );
        }
        return {
          ...lowered,
          name: { ...lowered.name, sourceTest: true },
        };
      }
      const incrementCount = attributeNames.filter((name) =>
        name === "increment"
      ).length;
      if (
        incrementCount === 0 || lowered?.kind !== "binding" ||
        lowered.value.kind !== "integer"
      ) {
        return lowered;
      }
      return {
        ...lowered,
        value: {
          ...lowered.value,
          value: lowered.value.value + incrementCount,
        },
      };
    }
  }
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
    const fieldBlock = findRule(statement, "type_field_block");
    if (fieldBlock === undefined) {
      throw unsupported(file, statement, "Init field block");
    }
    return {
      kind: "initDeclaration",
      fields: fieldBlock.children().flatMap((field) => {
        if (field.type !== "rule" || field.name !== "type_field") return [];
        return [{
          name: tokenText(
            file,
            requiredField(field, "name"),
            "Init field name",
          ),
          effectName: lowerTypeReference(
            file,
            requiredField(field, "type"),
          ).name,
          span: sourceSpan(file, field),
        }];
      }),
      span: sourceSpan(file, statement),
    };
  }
  if (
    statement.name === "declare_effect_statement" ||
    statement.name === "effect_statement"
  ) {
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
      parameters: statement.fieldArray("parameter").map((parameter) =>
        identifierName(file, parameter, "effect type parameter").text
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
    const valueCursor = requiredField(statement, "value");
    const value = lowerExpression(file, valueCursor);
    const option = value.kind === "unary" && value.operator === "do"
      ? value.operand
      : value.kind === "call" && value.callee.kind === "reference" &&
          value.callee.name.text === "do" && value.arguments.length === 1
      ? value.arguments[0]
      : undefined;
    const effectValue = option === undefined
      ? lowerEffectBindingValue(file, valueCursor, value)
      : { kind: "optionDo" as const, option, span: value.span };
    const bindingHead = tokenField(statement, "head");
    const bindingName = bindingHead ?? requiredField(statement, "name");
    const fusedName = bindingHead?.text.match(
      /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*<-$/,
    )?.[1];
    if (
      fusedName === "_" || findRule(bindingName, "wildcard") !== undefined
    ) {
      return {
        kind: "expression",
        expression: effectValue,
        span: sourceSpan(file, statement),
      };
    }
    return {
      kind: "binding",
      declarationKind: "let",
      recursive: false,
      name: fusedName === undefined
        ? identifierName(file, bindingName, "effect result binding")
        : {
          text: fusedName,
          span: {
            file,
            start: bindingHead!.span.start,
            end: bindingHead!.span.start + fusedName.length,
          },
        },
      value: effectValue,
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "module_return_statement") {
    const fieldBlock = findRule(statement, "field_block") ??
      findRule(statement, "shape_field_block");
    if (fieldBlock === undefined) {
      throw unsupported(file, statement, "module return object");
    }
    const fields = fieldBlock.children().filter((child): child is RuleCursor =>
      child.type === "rule" && child.name === "shape_field"
    );
    const field = fields.length === 1 ? fields[0] : undefined;
    if (
      field !== undefined &&
      identifierName(
          file,
          requiredField(field, "name"),
          "module return field",
        ).text === "result"
    ) {
      return {
        kind: "expression",
        expression: lowerExpression(file, requiredField(field, "value")),
        span: sourceSpan(file, statement),
      };
    }
    return {
      kind: "expression",
      expression: {
        kind: "record",
        fields: fieldBlock.children().flatMap((child) => {
          if (child.type !== "rule") {
            return [];
          }
          if (child.name === "shape_field") {
            return [{
              name: identifierName(
                file,
                requiredField(child, "name"),
                "module return field",
              ).text,
              value: lowerExpression(file, requiredField(child, "value")),
              span: sourceSpan(file, child),
            }];
          }
          if (child.name !== "shorthand_field") {
            return [];
          }
          const name = identifierName(file, child, "module return field");
          return [{
            name: name.text,
            value: { kind: "reference" as const, name, span: name.span },
            span: sourceSpan(file, child),
          }];
        }),
        span: sourceSpan(file, fieldBlock),
      },
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "binding_statement") {
    let value = lowerExpression(file, requiredField(statement, "value"));
    const declaredType = statement.field("type");
    const forallType = isCursor(declaredType)
      ? findRule(declaredType, "forall_type")
      : undefined;
    if (value.kind === "function" && forallType !== undefined) {
      value = {
        ...value,
        typeParameters: forallTypeParameterNames(forallType),
      };
    }
    if (
      value.kind === "function" && isCursor(declaredType) &&
      value.parameters.length > 0
    ) {
      const functionType = findRule(declaredType, "function_type");
      const functionResult = functionType?.field("result");
      const parameter = functionType?.children().find((child) =>
        child.type === "rule" && child !== functionResult &&
        child.name !== "latent_effect_row"
      );
      if (parameter !== undefined) {
        const parameterType = lowerTypeReference(file, parameter);
        const parameterTypes = parameterType.name === "$tuple" ||
            parameterType.name === "$array"
          ? parameterType.arguments
          : [parameterType];
        if (parameterTypes.length === value.parameters.length) {
          value = {
            ...value,
            parameters: value.parameters.map((parameter, index) => {
              const type = parameterTypes[index];
              const carriesLatentEffects = type.name === "$function";
              const carriesForallType = forallType !== undefined &&
                !type.name.startsWith("$");
              return parameter.declaredType === undefined &&
                  (carriesLatentEffects || carriesForallType)
                ? { ...parameter, declaredType: type }
                : parameter;
            }),
          };
        }
      }
    }
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
    const declaredTypeReference = isCursor(declaredType)
      ? lowerTypeReference(file, declaredType)
      : undefined;
    const declaredResultTypeReference = declaredTypeReference === undefined
      ? undefined
      : declaredTypeReference.name === "$array"
      ? undefined
      : declaredTypeReference.name === "$function"
      ? declaredTypeReference.arguments[1]?.name === "$array"
        ? undefined
        : declaredTypeReference.arguments[1]
      : declaredTypeReference;
    const declaredTypeTokens: TokenCursor[] = [];
    if (isCursor(declaredType)) {
      collectAllTokens(declaredType, declaredTypeTokens);
    }
    const declaredFunctionType = declaredTypeTokens.some((token) =>
      token.text === "->"
    );
    const bindingDeclaredType = declaredFunctionType
      ? undefined
      : declaredTypeReference;
    const declaredEffectRow = isCursor(declaredType)
      ? lowerDeclaredEffectRow(file, declaredType)
      : undefined;
    const nominalType = declaredFunctionType
      ? declaredResultTypeReference
      : declaredTypeReference;
    if (nominalType !== undefined) {
      value = applyNominalProductType(value, nominalType);
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
    const tuplePattern = findRule(
      bindingPattern,
      "positional_product_pattern",
    );
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
    const namedShape = findRule(bindingPattern, "named_shape_pattern");
    if (namedShape !== undefined) {
      const selections = lowerImportSelections(file, namedShape);
      return {
        kind: "recordBinding",
        declarationKind: tokenField(statement, "kind")?.text === "const"
          ? "const"
          : "let",
        fields: selections.flatMap((selection) =>
          selection.localName === undefined ? [] : [{
            fieldName: selection.exportName,
            localName: selection.localName,
          }]
        ),
        value,
        span: sourceSpan(file, statement),
      };
    }
    const singlePattern = descendSingleRule(
      bindingPattern,
      new Set(["_binding_pattern", "_single_binding_pattern"]),
    );
    if (singlePattern.type === "rule" && singlePattern.name === "wildcard") {
      return undefined;
    }
    const bindingTokens: TokenCursor[] = [];
    collectAllTokens(singlePattern, bindingTokens);
    const bindingName = bindingTokens.length === 1 &&
        (bindingTokens[0].kind === "identifier" ||
          bindingTokens[0].text === "struct")
      ? bindingTokens[0]
      : undefined;
    if (bindingName === undefined) {
      throw unsupported(file, singlePattern, "binding pattern");
    }
    const parsedName = {
      text: bindingName.text,
      span: sourceSpan(file, bindingName),
    };
    const name = {
      ...parsedName,
      ...(bindingDeclaredType === undefined
        ? {}
        : { declaredType: bindingDeclaredType }),
      ...(declaredEffectRow === undefined ? {} : { declaredEffectRow }),
      ...(tokenField(statement, "linear") !== undefined
        ? { linear: true }
        : {}),
    };
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
  if (statement.name === "module_binding_statement") {
    return {
      kind: "binding",
      declarationKind: "module",
      recursive: false,
      name: identifierName(
        file,
        requiredField(statement, "name"),
        "module binding name",
      ),
      value: lowerExpression(file, requiredField(statement, "value")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "type_declaration_statement") {
    const definition = requiredField(statement, "definition");
    const structType = findRule(definition, "struct_type");
    if (structType !== undefined) {
      const fieldBlock = findRule(structType, "type_field_block");
      if (fieldBlock === undefined) {
        throw unsupported(file, structType, "struct field block");
      }
      return {
        kind: "structType",
        name: identifierName(
          file,
          requiredField(statement, "name"),
          "struct type name",
        ).text,
        parameters: tokenFields(statement, "parameter").map((token) =>
          token.text
        ),
        fields: fieldBlock.children().flatMap((child) => {
          if (child.type !== "rule" || child.name !== "named_type_field") {
            return [];
          }
          return [{
            name: identifierName(
              file,
              requiredField(child, "name"),
              "struct field name",
            ).text,
            type: lowerTypeReference(file, requiredField(child, "type")),
            span: sourceSpan(file, child),
          }];
        }),
        span: sourceSpan(file, statement),
      };
    }
    const positionalProduct = findRule(definition, "positional_type_product");
    if (positionalProduct !== undefined) {
      return {
        kind: "structType",
        name: identifierName(
          file,
          requiredField(statement, "name"),
          "product type name",
        ).text,
        parameters: tokenFields(statement, "parameter").map((token) =>
          token.text
        ),
        fields: positionalProduct.children().flatMap((child, index) =>
          child.type === "rule" && child.name === "type_reference"
            ? [{
              name: `$${index}`,
              type: lowerTypeReference(file, child),
              span: sourceSpan(file, child),
            }]
            : []
        ),
        span: sourceSpan(file, statement),
      };
    }
    const definitionTokens: TokenCursor[] = [];
    collectAllTokens(definition, definitionTokens);
    const arraySeparator = definitionTokens.find((token) => token.text === ";");
    if (arraySeparator !== undefined) {
      const elementType = findRule(definition, "type_reference");
      const lengthToken = definitionTokens.find((token) =>
        token.kind === "number"
      );
      const length = lengthToken === undefined
        ? Number.NaN
        : Number.parseInt(lengthToken.text, 10);
      if (
        elementType === undefined || !Number.isSafeInteger(length) || length < 0
      ) {
        throw unsupported(file, definition, "fixed array type");
      }
      const type = lowerTypeReference(file, elementType);
      return {
        kind: "structType",
        name: identifierName(
          file,
          requiredField(statement, "name"),
          "fixed array type name",
        ).text,
        parameters: tokenFields(statement, "parameter").map((token) =>
          token.text
        ),
        fields: Array.from({ length }, (_, index) => ({
          name: `$${index}`,
          type,
          span: sourceSpan(file, definition),
        })),
        span: sourceSpan(file, statement),
      };
    }
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
    if (
      expression.kind === "binary" && expression.operator === "=" &&
      expression.left.kind === "index" &&
      expression.left.collection.kind === "reference"
    ) {
      return {
        kind: "assignment",
        operator: "=",
        name: expression.left.collection.name,
        value: {
          kind: "indexUpdate",
          product: expression.left.collection,
          index: expression.left.index,
          value: expression.right,
          span: expression.span,
        },
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
  if (statement.name === "type_pattern_statement") {
    const pattern = requiredField(statement, "pattern");
    if (pattern.type !== "rule" || pattern.name !== "type_pattern") {
      throw unsupported(file, pattern, "type pattern statement");
    }
    const patternKind = tokenText(
      file,
      requiredField(pattern, "kind"),
      "type pattern kind",
    );
    if (patternKind !== "struct" && patternKind !== "union") {
      throw unsupported(file, pattern, "type pattern kind");
    }
    return {
      kind: "typePattern",
      patternKind,
      fields: pattern.children().flatMap((child) => {
        if (child.type !== "rule" || child.name !== "type_pattern_field") {
          return [];
        }
        return [{
          name: tokenText(
            file,
            requiredField(child, "name"),
            "type pattern field",
          ),
          type: lowerTypeReference(
            file,
            requiredField(child, "type"),
          ).name,
        }];
      }),
      open: tokenField(pattern, "open") !== undefined,
      target: lowerExpression(file, requiredField(statement, "value")),
      span: sourceSpan(file, statement),
    };
  }
  if (statement.name === "for_statement") {
    const end = statement.field("end");
    if (!isCursor(end)) {
      const first = requiredField(statement, "first");
      const second = statement.field("second");
      const firstUnion = findRule(first, "union_pattern");
      const secondUnion = isCursor(second)
        ? findRule(second, "union_pattern")
        : undefined;
      if (isCursor(second) && firstUnion !== undefined) {
        throw unsupported(file, first, "collection index pattern");
      }
      const firstName = firstUnion === undefined
        ? identifierName(file, first, "collection loop pattern")
        : identifierName(
          file,
          requiredField(firstUnion, "value"),
          "collection loop payload",
        );
      const secondName = !isCursor(second)
        ? undefined
        : secondUnion === undefined
        ? identifierName(file, second, "collection loop pattern")
        : identifierName(
          file,
          requiredField(secondUnion, "value"),
          "collection loop payload",
        );
      const unionPattern = secondUnion ?? firstUnion;
      return {
        kind: "forCollection",
        index: secondName === undefined ? undefined : firstName,
        value: secondName ?? firstName,
        caseName: unionPattern === undefined ? undefined : tokenText(
          file,
          requiredField(unionPattern, "case"),
          "collection loop union case",
        ),
        collection: lowerExpression(
          file,
          requiredField(statement, "start_or_collection"),
        ),
        body: lowerExpression(file, requiredField(statement, "body")),
        span: sourceSpan(file, statement),
      };
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

function lowerEffectBindingValue(
  file: string,
  input: SyntaxCursor,
  value: DucklangExpression,
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
  if (names.length === 1) return value;
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

function lowerDeclaredEffectRow(
  file: string,
  input: SyntaxCursor,
): DucklangEffectRow | null | undefined {
  const functionType = topLevelRule(input, "function_type");
  if (
    functionType === undefined ||
    !functionType.children().some((child) =>
      child.type === "token" && child.text === "->"
    )
  ) {
    return undefined;
  }
  const latent = functionType.children().find((child): child is RuleCursor =>
    child.type === "rule" && child.name === "latent_effect_row"
  );
  if (latent === undefined) return null;
  return lowerEffectRow(file, requiredField(latent, "row"));
}

function lowerEffectRow(
  file: string,
  input: SyntaxCursor,
): DucklangEffectRow {
  const row = descendSingleRule(
    input,
    new Set(["effect_row", "_effect_row_expression"]),
  );
  if (row.type !== "rule") {
    throw unsupported(file, row, "effect row");
  }
  if (row.name === "parenthesized_effect_expression") {
    return lowerEffectRow(file, requiredField(row, "value"));
  }
  if (row.name === "effect_family_reference") {
    return {
      kind: "family",
      effectName: tokenText(
        file,
        requiredField(row, "effect"),
        "effect row family",
      ),
      span: sourceSpan(file, row),
    };
  }
  if (row.name === "effect_operation_reference") {
    return {
      kind: "operation",
      effectName: tokenText(
        file,
        requiredField(row, "effect"),
        "effect row operation family",
      ),
      operationName: tokenText(
        file,
        requiredField(row, "operation"),
        "effect row operation",
      ),
      span: sourceSpan(file, row),
    };
  }
  if (row.name === "effect_row_variable") {
    return {
      kind: "variable",
      name: tokenText(
        file,
        requiredField(row, "name"),
        "effect row variable",
      ),
      span: sourceSpan(file, row),
    };
  }
  const operators = row.children().filter((child): child is TokenCursor =>
    child.type === "token" && [":|", ":&", ":-"].includes(child.text)
  );
  const operands = row.children().filter((child): child is RuleCursor =>
    child.type === "rule"
  );
  if (operators.length === 0 && operands.length === 1) {
    return lowerEffectRow(file, operands[0]);
  }
  if (operators.length + 1 !== operands.length) {
    throw unsupported(file, row, "effect row expression");
  }
  let result = lowerEffectRow(file, operands[0]);
  for (const [index, operator] of operators.entries()) {
    const right = lowerEffectRow(file, operands[index + 1]);
    result = {
      kind: operator.text === ":|"
        ? "union"
        : operator.text === ":&"
        ? "intersection"
        : "difference",
      left: result,
      right,
      span: spanFrom(result.span, right.span),
    };
  }
  return result;
}

function lowerTypeReference(
  file: string,
  input: SyntaxCursor,
): DucklangTypeReference {
  const forallType = topLevelRule(input, "forall_type");
  const forallBody = forallType?.field("body");
  if (forallType !== undefined && isCursor(forallBody)) {
    return lowerTypeReference(file, forallBody);
  }
  const functionType = topLevelRule(input, "function_type");
  const functionResult = functionType?.field("result");
  if (functionType !== undefined && isCursor(functionResult)) {
    const parameter = functionType.children().find((child) =>
      child.type === "rule" && child !== functionResult &&
      child.name !== "latent_effect_row"
    );
    if (parameter === undefined) {
      throw unsupported(file, functionType, "function parameter type");
    }
    const latent = functionType.children().find(
      (child): child is RuleCursor =>
        child.type === "rule" && child.name === "latent_effect_row",
    );
    return {
      name: "$function",
      arguments: [
        lowerTypeReference(file, parameter),
        lowerTypeReference(file, functionResult),
      ],
      effectRow: latent === undefined
        ? null
        : lowerEffectRow(file, requiredField(latent, "row")),
      span: sourceSpan(file, functionType),
    };
  }
  const parenthesized = findRule(input, "type_parenthesized");
  if (
    parenthesized !== undefined &&
    parenthesized.span.start === input.span.start
  ) {
    const nested = parenthesized.children().find((child): child is RuleCursor =>
      child.type === "rule" && child.name === "_type_expression"
    );
    if (nested !== undefined) return lowerTypeReference(file, nested);
  }
  const product = findRule(input, "type_product");
  if (product !== undefined) {
    const productTokens: TokenCursor[] = [];
    collectAllTokens(product, productTokens);
    const elements: RuleCursor[] = [];
    const collectElements = (cursor: RuleCursor): void => {
      for (const child of cursor.children()) {
        if (child.type !== "rule") continue;
        if (child.name === "type_reference") {
          elements.push(child);
        } else {
          collectElements(child);
        }
      }
    };
    collectElements(product);
    if (productTokens.some((token) => token.text === ";")) {
      return {
        name: "$array",
        arguments: elements.slice(0, 1).map((element) =>
          lowerTypeReference(file, element)
        ),
        span: sourceSpan(file, product),
      };
    }
    return {
      name: "$tuple",
      arguments: elements.map((element) => lowerTypeReference(file, element)),
      span: sourceSpan(file, product),
    };
  }
  const newtype = findRule(input, "newtype_type");
  if (newtype !== undefined) {
    const representation = findRule(newtype, "type_reference");
    if (representation === undefined) {
      throw unsupported(file, newtype, "newtype representation");
    }
    return lowerTypeReference(file, representation);
  }
  const frozen = findRule(input, "frozen_type");
  if (frozen !== undefined) {
    const tokens: TokenCursor[] = [];
    collectAllTokens(frozen, tokens);
    const name = tokens.find((token) =>
      token.kind === "identifier" || token.kind === "effect_identifier"
    );
    if (name === undefined) throw unsupported(file, frozen, "frozen type");
    return { name: name.text, arguments: [], span: sourceSpan(file, input) };
  }
  if (findRule(input, "atom_type") !== undefined) {
    return { name: "I32", arguments: [], span: sourceSpan(file, input) };
  }
  const literal = findRule(input, "type_literal");
  if (literal !== undefined) {
    const tokens: TokenCursor[] = [];
    collectAllTokens(literal, tokens);
    const carrier = tokens.some((token) => token.kind === "string")
      ? "Text"
      : "I32";
    return { name: carrier, arguments: [], span: sourceSpan(file, input) };
  }
  const tokens: TokenCursor[] = [];
  collectAllTokens(input, tokens);
  const identifiers = tokens.filter((token) => token.kind === "identifier");
  if (
    identifiers.length === 0 &&
    tokens.every((token) => token.text === "(" || token.text === ")")
  ) {
    return { name: "Unit", arguments: [], span: sourceSpan(file, input) };
  }
  if (tokens.some((token) => token.text === ":&") && identifiers.length > 0) {
    const name = identifiers.at(-1)!;
    return { name: name.text, arguments: [], span: sourceSpan(file, input) };
  }
  if (tokens.some((token) => token.text === ":|") && identifiers.length > 0) {
    const name = identifiers[0];
    return { name: name.text, arguments: [], span: sourceSpan(file, input) };
  }
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
  if (arguments_.length === 0) {
    const parenthesizedBase = findRule(base, "type_parenthesized");
    if (parenthesizedBase !== undefined) {
      const nested = parenthesizedBase.children().find(
        (child): child is RuleCursor =>
          child.type === "rule" && child.name === "_type_expression",
      );
      if (nested !== undefined) return lowerTypeReference(file, nested);
    }
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
      "condition_expression",
      "condition_parenthesized_expression",
      "_condition_primary",
      "_primary_expression",
      "_if_consequence",
      "_else_block",
      "_else_if",
      "_collection_range_body",
      "_numeric_range_body",
      "parenthesized_or_product",
      "boolean",
    ]),
  );
  if (cursor.type === "token") return lowerTokenExpression(file, cursor);

  if (cursor.name === "as_expression") {
    const value = cursor.children().find((child): child is RuleCursor =>
      child.type === "rule" && child.name !== "as_keyword" &&
      child.name !== "type_reference"
    );
    if (value === undefined) throw unsupported(file, cursor, "cast value");
    const annotations = cursorFields(cursor, "type");
    const annotation = annotations.at(-1);
    if (!isCursor(annotation)) return lowerExpression(file, value);
    return applyNominalProductType(
      lowerExpression(file, value),
      lowerTypeReference(file, annotation),
    );
  }

  if (
    cursor.name === "is_expression" ||
    cursor.name === "condition_is_expression"
  ) {
    const [valueInput, typeInput] = cursor.children().filter(
      (child): child is RuleCursor => child.type === "rule",
    );
    if (valueInput === undefined) throw unsupported(file, cursor, "type test");
    if (typeInput === undefined) return lowerExpression(file, valueInput);
    const value = lowerExpression(file, valueInput);
    const atom = findRule(typeInput, "atom_type");
    if (atom === undefined) {
      return { kind: "boolean", value: true, span: sourceSpan(file, cursor) };
    }
    const tokens: TokenCursor[] = [];
    collectAllTokens(atom, tokens);
    const name = tokens.find((token) =>
      token.kind === "row_variable" || token.kind === "effect_identifier"
    );
    if (name === undefined) throw unsupported(file, atom, "atom type test");
    return {
      kind: "binary",
      operator: "==",
      left: value,
      right: {
        kind: "integer",
        value: atomValue(name.text),
        span: sourceSpan(file, atom),
      },
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "match_expression") {
    return lowerMatchExpression(file, cursor);
  }

  if (cursor.name === "import_meta_expression") {
    return {
      kind: "integer",
      value: atomValue("build"),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "try_with_expression") {
    const handler = cursor.field("handler");
    return {
      kind: "handle",
      body: lowerExpression(file, requiredField(cursor, "body")),
      handler: isCursor(handler)
        ? lowerExpression(file, handler)
        : { kind: "unit", span: sourceSpan(file, cursor) },
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "effect_handler_expression") {
    const effect = requiredField(cursor, "effect");
    const clauses = requiredField(cursor, "clauses");
    if (clauses.type !== "rule") {
      throw unsupported(file, clauses, "handler clauses");
    }
    const effectTokens: TokenCursor[] = [];
    collectAllTokens(effect, effectTokens);
    const effectName = effectTokens.find((token) =>
      token.kind === "effect_identifier"
    )?.text;
    if (effectName === undefined) {
      throw unsupported(file, effect, "handler effect");
    }
    const fields = clauses.children().flatMap((child) => {
      if (
        child.type !== "rule" ||
        (child.name !== "handler_operation_clause" &&
          child.name !== "handler_return_clause")
      ) {
        return [];
      }
      const name = child.name === "handler_return_clause"
        ? "return"
        : identifierName(
          file,
          requiredField(child, "name"),
          "handler operation",
        ).text;
      const value = child.name === "handler_operation_clause"
        ? {
          kind: "function" as const,
          recursive: false,
          parameters: arrowParameters(
            file,
            requiredField(child, "parameters"),
          ),
          body: lowerExpression(file, requiredField(child, "body")),
          span: sourceSpan(file, child),
        }
        : lowerExpression(file, requiredField(child, "value"));
      return [{
        name,
        value,
        span: sourceSpan(file, child),
      }];
    });
    return {
      kind: "effectHandler",
      effectName,
      fields,
      span: sourceSpan(file, cursor),
    };
  }

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
    const leadingOperator = operators[0] === undefined
      ? undefined
      : operatorText(operators[0]);
    if (
      leadingOperator === "=>" || leadingOperator === "=" ||
      leadingOperator === ":="
    ) {
      let right = lowerExpression(file, rightOperands[0]);
      for (let index = 1; index < operators.length; index += 1) {
        const operator = operatorText(operators[index]);
        const next = lowerExpression(file, rightOperands[index]);
        if (operator === "<&" && next.kind === "record") {
          right = {
            kind: "recordUpdate",
            product: right,
            fields: next.fields,
            span: spanFrom(right.span, next.span),
          };
          continue;
        }
        right = lowerBinaryExpression(operator, right, next);
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

    if (
      operators.length === 1 &&
      operatorText(operators[0]) === "<&"
    ) {
      const fields = lowerExpression(file, rightOperands[0]);
      if (fields.kind === "record") {
        const product = lowerExpression(file, leftCursor);
        return {
          kind: "recordUpdate",
          product,
          fields: fields.fields,
          span: spanFrom(product.span, fields.span),
        };
      }
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
      expressionStack.push(
        lowerBinaryExpression(operatorText(operator), left, right),
      );
    };
    for (let index = 0; index < operators.length; index += 1) {
      const operator = operators[index];
      while (
        operatorStack.length > 0 &&
        binaryOperatorPrecedence(operatorText(operatorStack.at(-1)!)) >=
          binaryOperatorPrecedence(operatorText(operator))
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
    const operandCursor = requiredField(cursor, "operand");
    const decodedOperator = operatorText(operator);
    if (decodedOperator === "-") {
      const operandTokens: TokenCursor[] = [];
      collectAllTokens(operandCursor, operandTokens);
      if (
        operandTokens.length === 1 &&
        operandTokens[0].text === "9223372036854775808i64"
      ) {
        return {
          kind: "integer64",
          value: -9_223_372_036_854_775_808n,
          span: sourceSpan(file, cursor),
        };
      }
    }
    const operand = lowerExpression(file, operandCursor);
    if (decodedOperator === "comptime") {
      return {
        kind: "comptime",
        context: "explicit",
        expression: operand,
        span: sourceSpan(file, cursor),
      };
    }
    return {
      kind: "unary",
      operator: decodedOperator,
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
      expression.kind === "call" && expression.callee.kind === "reference" &&
      /^[A-Z]/.test(expression.callee.name.text) &&
      expression.arguments.length === 1 &&
      expression.arguments[0].kind === "record" &&
      expression.arguments[0].fields.some((field) => field.name === "return")
    ) {
      return {
        kind: "effectHandler",
        effectName: expression.callee.name.text,
        fields: expression.arguments[0].fields,
        span: expression.span,
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
    if (
      expression.kind === "call" &&
      expression.callee.kind === "reference" &&
      expression.callee.name.text === "@len" &&
      expression.arguments.length === 1 &&
      expression.arguments[0].kind === "string"
    ) {
      return {
        kind: "integer",
        value: new TextEncoder().encode(expression.arguments[0].value).length,
        span: expression.span,
      };
    }
    // `@type_of` and `@describe_type` are deliberately not rewritten here. The parser
    // has no type information, so answering them at this point can only mean inventing
    // a constant. They resolve to `duck:compiler/reflect` intrinsics and are folded by
    // `reflectDucklangTypes` and `foldStaticIntrinsic` once inference has run.
    if (
      expression.kind === "call" &&
      expression.callee.kind === "reference" &&
      expression.callee.name.text === "@cast" &&
      expression.arguments[0] !== undefined
    ) {
      return expression.arguments[0];
    }
    if (
      expression.kind === "call" &&
      expression.callee.kind === "reference" &&
      expression.callee.name.text === "@construct" &&
      expression.arguments[1] !== undefined
    ) {
      return expression.arguments[1];
    }
    return expression;
  }

  if (cursor.name === "condition_call_expression") {
    const directArguments = new Set(cursorFields(cursor, "argument"));
    const children = cursor.children();
    const callee = children.find((child) =>
      child.type === "rule" && !directArguments.has(child)
    );
    if (callee === undefined) {
      throw unsupported(file, cursor, "condition call callee");
    }
    const suffixes = children.filter((child) =>
      child !== callee &&
      (directArguments.has(child) || child.type === "rule")
    );
    let expression = lowerExpression(file, callee);
    for (const suffix of suffixes) {
      const argument = directArguments.has(suffix)
        ? suffix
        : suffix.type === "rule"
        ? suffix.field("argument")
        : undefined;
      if (!isCursor(argument)) {
        if (suffix.type !== "rule") {
          throw unsupported(file, suffix, "condition call argument");
        }
        const index = suffix.field("index");
        if (isCursor(index)) {
          expression = {
            kind: "index",
            collection: expression,
            index: lowerExpression(file, index),
            span: spanFrom(expression.span, sourceSpan(file, suffix)),
          };
          continue;
        }
        const names: TokenCursor[] = [];
        collectTokens(suffix, names, "identifier");
        if (names.length !== 1) {
          throw unsupported(file, suffix, "condition field or index postfix");
        }
        if (names[0].text === "mode" && expression.kind === "integer") {
          continue;
        }
        expression = {
          kind: "field",
          product: expression,
          fieldName: names[0].text,
          span: spanFrom(expression.span, sourceSpan(file, suffix)),
        };
        continue;
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
        const names: TokenCursor[] = [];
        collectTokens(suffix, names, "identifier");
        if (names.length !== 1) {
          throw unsupported(file, suffix, "field or effect-handler postfix");
        }
        expression = {
          kind: "field",
          product: expression,
          fieldName: names[0].text,
          span: spanFrom(expression.span, sourceSpan(file, suffix)),
        };
        continue;
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
      const wildcardUnionPattern = findRule(
        pattern,
        "wildcard_union_pattern",
      );
      if (
        unionPattern === undefined && wildcardUnionPattern === undefined
      ) {
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
      const payload = unionPattern?.field("value");
      const payloadName = isCursor(payload) && payload.type === "token" &&
          payload.kind === "identifier"
        ? identifierName(file, payload, "union payload binding")
        : undefined;
      const wildcardToken = wildcardUnionPattern?.children().find((
        child,
      ): child is TokenCursor => child.type === "token");
      const caseName = unionPattern === undefined
        ? wildcardToken?.text.match(
          /^`([A-Z][A-Za-z0-9_]*)[ \t]+_$/,
        )?.[1]
        : tokenText(
          file,
          requiredField(unionPattern, "case"),
          "union pattern case",
        );
      if (caseName === undefined) {
        throw unsupported(file, pattern, "wildcard union pattern");
      }
      const alternative = cursor.field("alternative");
      return {
        kind: "ifUnion",
        caseName,
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
    const fields = cursor.children().filter((child): child is RuleCursor =>
      child.type === "rule" &&
      (child.name === "shape_field" ||
        child.name === "field_definition" ||
        child.name === "shorthand_field")
    );
    if (fields.length > 0) {
      return {
        kind: "record",
        fields: lowerRecordFields(file, cursor),
        span: sourceSpan(file, cursor),
      };
    }
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

  if (
    cursor.name === "import_expression" ||
    cursor.name === "include_expression"
  ) {
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
    const arrayHead = tokenField(cursor, "head");
    const caseName = arrayHead === undefined
      ? tokenText(
        file,
        requiredField(cursor, "case"),
        "union case",
      )
      : arrayHead.text.match(/^`([A-Z][A-Za-z0-9_]*)[ \t]+\[$/)?.[1];
    if (caseName === undefined) {
      throw unsupported(file, cursor, "union array case");
    }
    if (caseName === "Replace") {
      return lowerExpression(file, requiredField(cursor, "value"));
    }
    const value = requiredField(cursor, "value");
    const namedFields = value.type === "rule"
      ? value.children().filter((child): child is RuleCursor =>
        child.type === "rule" && child.name === "product_field"
      )
      : [];
    return {
      kind: "unionCase",
      caseName,
      value: arrayHead === undefined
        ? lowerExpression(file, value)
        : namedFields.length > 0
        ? {
          kind: "record",
          fields: namedFields.map((field) => ({
            name: identifierName(
              file,
              requiredField(field, "name"),
              "record field name",
            ).text,
            value: lowerExpression(file, requiredField(field, "value")),
            span: sourceSpan(file, field),
          })),
          span: sourceSpan(file, value),
        }
        : {
          kind: "product",
          productKind: "array",
          ...(value.type === "rule"
            ? lowerArrayElements(file, value)
            : { values: [] }),
          span: sourceSpan(file, value),
        },
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "atom_expression") {
    const tokens: TokenCursor[] = [];
    collectAllTokens(cursor, tokens);
    const name = tokens.find((token) => token.kind === "row_variable");
    if (name === undefined) throw unsupported(file, cursor, "atom expression");
    return {
      kind: "integer",
      value: atomValue(name.text),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "linear_reference") {
    const name = {
      ...identifierName(
        file,
        requiredField(cursor, "name"),
        "linear reference",
      ),
      linear: true,
    };
    return { kind: "reference", name, span: sourceSpan(file, cursor) };
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

  if (cursor.name === "named_product") {
    return {
      kind: "record",
      fields: cursor.children().flatMap((child) => {
        if (child.type !== "rule" || child.name !== "product_field") return [];
        return [{
          name: identifierName(
            file,
            requiredField(child, "name"),
            "record field name",
          ).text,
          value: lowerExpression(file, requiredField(child, "value")),
          span: sourceSpan(file, child),
        }];
      }),
      span: sourceSpan(file, cursor),
    };
  }

  if (
    cursor.name === "field_block" ||
    cursor.name === "nonempty_field_block" ||
    cursor.name === "shape_field_block"
  ) {
    return {
      kind: "record",
      fields: lowerRecordFields(file, cursor),
      span: sourceSpan(file, cursor),
    };
  }

  if (cursor.name === "shape_value") {
    const fields = findRule(cursor, "shape_field_block");
    if (fields === undefined) {
      throw unsupported(file, cursor, "shape value fields");
    }
    return {
      kind: "record",
      fields: lowerRecordFields(file, fields),
      span: sourceSpan(file, cursor),
    };
  }

  if (
    cursor.name === "array_expression" ||
    cursor.name === "line_array_expression"
  ) {
    const namedFields = cursor.children().filter((child): child is RuleCursor =>
      child.type === "rule" && child.name === "product_field"
    );
    if (namedFields.length > 0) {
      return {
        kind: "record",
        fields: namedFields.map((field) => ({
          name: identifierName(
            file,
            requiredField(field, "name"),
            "record field name",
          ).text,
          value: lowerExpression(file, requiredField(field, "value")),
          span: sourceSpan(file, field),
        })),
        span: sourceSpan(file, cursor),
      };
    }
    return {
      kind: "product",
      productKind: "array",
      ...lowerArrayElements(file, cursor),
      span: sourceSpan(file, cursor),
    };
  }

  throw unsupported(file, cursor, cursor.name);
}

function lowerArrayElements(
  file: string,
  cursor: RuleCursor,
): {
  readonly values: readonly DucklangExpression[];
  readonly spreadValues?: readonly boolean[];
} {
  const elements = cursor.children().flatMap((child) => {
    if (child.type !== "rule") return [];
    if (child.name === "_expression") {
      return [{ value: lowerExpression(file, child), spread: false }];
    }
    if (child.name !== "array_spread") return [];
    return [{
      value: lowerExpression(file, requiredField(child, "value")),
      spread: true,
    }];
  });
  const spreadValues = elements.map((element) => element.spread);
  return {
    values: elements.map((element) => element.value),
    ...(spreadValues.some(Boolean) ? { spreadValues } : {}),
  };
}

type MatchArm = {
  readonly patterns: readonly SyntaxCursor[];
  readonly guard: SyntaxCursor | undefined;
  readonly body: SyntaxCursor;
  readonly span: SourceSpan;
};

function lowerMatchExpression(
  file: string,
  cursor: RuleCursor,
): DucklangExpression {
  const target = lowerExpression(file, requiredField(cursor, "target"));
  const cases = requiredField(cursor, "cases");
  if (cases.type !== "rule") {
    throw unsupported(file, cases, "match cases");
  }
  const caseRules = cases.children().filter((child): child is RuleCursor =>
    child.type === "rule" &&
    (child.name === "match_case_tail" || child.name === "match_case")
  );
  const arms = caseRules.map((caseRule): MatchArm => {
    const guard = caseRule.field("guard");
    return {
      patterns: cursorFields(caseRule, "pattern"),
      guard: isCursor(guard) ? guard : undefined,
      body: requiredField(caseRule, "body"),
      span: sourceSpan(file, caseRule),
    };
  });
  if (arms.length === 0) {
    throw new SyntaxError(
      `${file}:${cursor.span.start}: Ducklang match expression has no cases`,
    );
  }

  let alternative: DucklangExpression | undefined;
  for (const arm of arms.toReversed()) {
    alternative = lowerMatchArm(file, target, arm, alternative);
  }
  if (alternative === undefined) {
    throw new TypeError(
      `${file}:${cursor.span.start}: Ducklang match expression is not exhaustive`,
    );
  }
  return { ...alternative, span: sourceSpan(file, cursor) };
}

function lowerMatchArm(
  file: string,
  target: DucklangExpression,
  arm: MatchArm,
  alternative: DucklangExpression | undefined,
): DucklangExpression {
  const body = lowerExpression(file, arm.body);
  const patterns = arm.patterns.map((pattern) =>
    descendSingleRule(
      pattern,
      new Set(["_match_pattern", "_single_match_pattern"]),
    )
  );
  if (patterns.some((pattern) => findRule(pattern, "wildcard") !== undefined)) {
    if (arm.guard === undefined) return body;
    if (alternative === undefined) {
      throw new TypeError(
        `${file}:${arm.span.start}: guarded Ducklang match expression is not exhaustive`,
      );
    }
    return {
      kind: "if",
      condition: lowerExpression(file, arm.guard),
      consequence: body,
      alternative,
      span: arm.span,
    };
  }
  if (arm.guard !== undefined) {
    throw unsupported(file, arm.guard, "non-wildcard guarded match case");
  }
  const wildcardUnionPattern = patterns.length === 1
    ? findRule(patterns[0], "wildcard_union_pattern")
    : undefined;
  if (wildcardUnionPattern !== undefined) {
    const wildcardToken = wildcardUnionPattern.children().find((
      child,
    ): child is TokenCursor => child.type === "token");
    const caseName = wildcardToken?.text.match(
      /^`([A-Z][A-Za-z0-9_]*)[ \t]+_$/,
    )?.[1];
    if (caseName === undefined) {
      throw unsupported(file, wildcardUnionPattern, "wildcard union pattern");
    }
    return {
      kind: "ifUnion",
      caseName,
      payloadName: undefined,
      value: target,
      consequence: body,
      alternative,
      span: arm.span,
    };
  }
  const unionPattern = patterns.length === 1
    ? findRule(patterns[0], "union_pattern")
    : undefined;
  if (unionPattern !== undefined) {
    const payload = requiredField(unionPattern, "value");
    const payloadName = payload.type === "token" &&
        payload.kind === "identifier"
      ? identifierName(file, payload, "union payload binding")
      : undefined;
    return {
      kind: "ifUnion",
      caseName: tokenText(
        file,
        requiredField(unionPattern, "case"),
        "union pattern case",
      ),
      payloadName,
      value: target,
      consequence: body,
      alternative,
      span: arm.span,
    };
  }
  const productPattern = patterns.length === 1 &&
      patterns[0].type === "rule" &&
      patterns[0].name === "positional_product_pattern"
    ? patterns[0]
    : undefined;
  if (productPattern !== undefined) {
    return lowerProductMatchArm(file, target, productPattern, body, arm.span);
  }
  const stringPattern = patterns.length === 1 && patterns[0].type === "token" &&
      patterns[0].kind === "string"
    ? patterns[0]
    : undefined;
  if (stringPattern !== undefined) {
    const interpolated = lowerStringMatchArm(
      file,
      target,
      stringPattern,
      body,
      alternative,
      arm.span,
    );
    if (interpolated !== undefined) return interpolated;
  }
  const typePattern = patterns.length === 1 &&
      patterns[0].type === "rule" && patterns[0].name === "type_pattern"
    ? patterns[0]
    : undefined;
  if (typePattern !== undefined) {
    return lowerTypeMatchArm(
      file,
      target,
      typePattern,
      body,
      alternative,
      arm.span,
    );
  }
  if (alternative === undefined) {
    throw new TypeError(
      `${file}:${arm.span.start}: Ducklang match expression is not exhaustive`,
    );
  }
  const conditions = patterns.map((pattern) =>
    lowerValuePatternCondition(file, target, pattern, arm.span)
  );
  return conditions.toReversed().reduce<DucklangExpression>(
    (next, condition) => ({
      kind: "if",
      condition,
      consequence: body,
      alternative: next,
      span: arm.span,
    }),
    alternative,
  );
}

function lowerStringMatchArm(
  file: string,
  target: DucklangExpression,
  pattern: TokenCursor,
  body: DucklangExpression,
  alternative: DucklangExpression | undefined,
  span: SourceSpan,
): DucklangExpression | undefined {
  const value = decodeStringLiteral(file, pattern);
  const capture = value.match(/^(.*?)\$\{([A-Za-z][A-Za-z0-9_]*)\}(.*)$/s);
  if (capture === null) return undefined;
  if (alternative === undefined) {
    throw new TypeError(
      `${file}:${span.start}: Ducklang string match expression is not exhaustive`,
    );
  }
  const secondCapture = capture[3].match(/\$\{[A-Za-z][A-Za-z0-9_]*\}/);
  if (secondCapture !== null) {
    throw unsupported(file, pattern, "string pattern with multiple captures");
  }
  const prefix = stringExpression(capture[1], sourceSpan(file, pattern));
  const suffix = stringExpression(capture[3], sourceSpan(file, pattern));
  const captureOffset = pattern.text.indexOf(capture[2]);
  const captureName: DucklangName = {
    text: capture[2],
    span: {
      file,
      start: pattern.span.start + captureOffset,
      end: pattern.span.start + captureOffset + capture[2].length,
    },
  };
  return {
    kind: "block",
    statements: [
      {
        kind: "binding",
        declarationKind: "const",
        recursive: false,
        name: captureName,
        value: syntheticCall(
          stringPatternCaptureName,
          [target, prefix, suffix],
          span,
        ),
        span,
      },
      {
        kind: "expression",
        expression: {
          kind: "if",
          condition: syntheticCall(
            stringPatternMatchesName,
            [target, prefix, suffix],
            span,
          ),
          consequence: body,
          alternative,
          span,
        },
        span,
      },
    ],
    span,
  };
}

function lowerValuePatternCondition(
  file: string,
  target: DucklangExpression,
  pattern: SyntaxCursor,
  span: SourceSpan,
): DucklangExpression {
  if (pattern.type === "token" && pattern.kind === "string") {
    const value = decodeStringLiteral(file, pattern);
    const capture = value.match(/^(.*?)\$\{([A-Za-z][A-Za-z0-9_]*)\}(.*)$/s);
    if (capture !== null) {
      throw new SyntaxError(
        `${file}:${pattern.span.start}: Ducklang interpolated string pattern ${pattern.text} must be the only pattern in its case`,
      );
    }
  }
  if (pattern.type !== "token") {
    const constValuePattern = findRule(pattern, "const_value_pattern");
    if (constValuePattern === undefined) {
      throw unsupported(file, pattern, "match value pattern");
    }
    return {
      kind: "binary",
      operator: "==",
      left: target,
      right: {
        kind: "comptime",
        context: "valuePattern",
        expression: lowerExpression(
          file,
          requiredField(constValuePattern, "value"),
        ),
        span: sourceSpan(file, constValuePattern),
      },
      span,
    };
  }
  const literal = lowerTokenExpression(file, pattern);
  if (literal.kind === "reference") {
    throw unsupported(file, pattern, "match binding pattern");
  }
  return {
    kind: "binary",
    operator: "==",
    left: target,
    right: literal,
    span,
  };
}

function lowerProductMatchArm(
  file: string,
  target: DucklangExpression,
  pattern: RuleCursor,
  body: DucklangExpression,
  span: SourceSpan,
): DucklangExpression {
  const firstPattern = pattern.children().find((child): child is RuleCursor =>
    child.type === "rule" && child.name === "_match_pattern"
  );
  if (firstPattern === undefined) {
    throw unsupported(file, pattern, "product match pattern");
  }
  const first = descendSingleRule(
    firstPattern,
    new Set(["_match_pattern", "_single_match_pattern"]),
  );
  const firstName = first.type === "token" && first.kind === "identifier"
    ? identifierName(file, first, "product match binding")
    : undefined;
  if (firstName === undefined && findRule(first, "wildcard") === undefined) {
    throw unsupported(file, first, "product match element");
  }
  return {
    kind: "block",
    statements: [
      {
        kind: "productBinding",
        declarationKind: "const",
        productKind: "tuple",
        names: [firstName],
        value: target,
        span,
      },
      { kind: "expression", expression: body, span: body.span },
    ],
    span,
  };
}

function lowerTypeMatchArm(
  file: string,
  target: DucklangExpression,
  pattern: RuleCursor,
  body: DucklangExpression,
  alternative: DucklangExpression | undefined,
  span: SourceSpan,
): DucklangExpression {
  if (alternative === undefined) {
    throw new TypeError(
      `${file}:${span.start}: Ducklang type match expression is not exhaustive`,
    );
  }
  const kind = tokenText(file, requiredField(pattern, "kind"), "type pattern");
  const fields = pattern.children().flatMap((child) => {
    if (child.type !== "rule" || child.name !== "type_pattern_field") {
      return [];
    }
    const type = lowerTypeReference(file, requiredField(child, "type"));
    return [{
      name: tokenText(
        file,
        requiredField(child, "name"),
        "type pattern field",
      ),
      type: type.name,
    }];
  });
  const descriptor = JSON.stringify({
    kind,
    fields,
    open: tokenField(pattern, "open") !== undefined,
  });
  return {
    kind: "if",
    condition: syntheticCall(
      typePatternMatchesName,
      [target, stringExpression(descriptor, span)],
      span,
    ),
    consequence: body,
    alternative,
    span,
  };
}

function syntheticCall(
  name: string,
  arguments_: readonly DucklangExpression[],
  span: SourceSpan,
): DucklangExpression {
  return {
    kind: "call",
    callee: {
      kind: "reference",
      name: { text: name, span },
      span,
    },
    arguments: arguments_,
    span,
  };
}

function stringExpression(value: string, span: SourceSpan): DucklangExpression {
  return { kind: "string", value, span };
}

function operatorText(operator: TokenCursor): string {
  return operator.kind === "CARET_OPERATOR"
    ? "^".repeat(operator.text.length)
    : operator.text;
}

function binaryOperatorPrecedence(operator: string): number {
  if (operator === "$" || operator === "|>") return 10;
  if (operator === "||") return 20;
  if (operator === "&&") return 30;
  if (["==", "!=", "<", ">", "<=", ">="].includes(operator)) return 40;
  if (operator === "+" || operator === "-") return 60;
  return 70;
}

function reassociateBinaryExpression(
  expression: Extract<DucklangExpression, { readonly kind: "binary" }>,
  source: string,
): DucklangExpression {
  const operands: DucklangExpression[] = [];
  const operators: string[] = [];
  const collect = (
    current: DucklangExpression,
    preserveParentheses: boolean,
  ): void => {
    if (
      current.kind !== "binary" ||
      (preserveParentheses && isDirectlyParenthesized(current, source))
    ) {
      operands.push(current);
      return;
    }
    collect(current.left, true);
    operators.push(current.operator);
    collect(current.right, true);
  };
  collect(expression, false);
  if (operators.length < 2) return expression;

  const expressionStack: DucklangExpression[] = [operands[0]];
  const operatorStack: string[] = [];
  const reduce = (): void => {
    const operator = operatorStack.pop();
    const right = expressionStack.pop();
    const left = expressionStack.pop();
    if (operator === undefined || left === undefined || right === undefined) {
      throw new Error("invalid Ducklang binary expression");
    }
    expressionStack.push({
      kind: "binary",
      operator,
      left,
      right,
      span: spanFrom(left.span, right.span),
    });
  };
  for (let index = 0; index < operators.length; index += 1) {
    const operator = operators[index];
    while (
      operatorStack.length > 0 &&
      binaryOperatorPrecedence(operatorStack.at(-1)!) >=
        binaryOperatorPrecedence(operator)
    ) {
      reduce();
    }
    operatorStack.push(operator);
    expressionStack.push(operands[index + 1]);
  }
  while (operatorStack.length > 0) reduce();
  if (expressionStack.length !== 1) {
    throw new Error(
      `Ducklang binary reassociation produced ${expressionStack.length} expressions`,
    );
  }
  return expressionStack[0];
}

function isDirectlyParenthesized(
  expression: DucklangExpression,
  source: string,
): boolean {
  let before = expression.span.start - 1;
  while (before >= 0 && /\s/.test(source[before])) before -= 1;
  let after = expression.span.end;
  while (after < source.length && /\s/.test(source[after])) after += 1;
  return source[before] === "(" && source[after] === ")";
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
  if (operator === "=>" && left.kind === "reference") {
    return {
      kind: "function",
      recursive: false,
      parameters: [left.name],
      body: right,
      span,
    };
  }
  if (left.kind === "function") {
    return {
      ...left,
      body: lowerBinaryExpression(operator, left.body, right),
      span,
    };
  }
  return { kind: "binary", operator, left, right, span };
}

function atomValue(name: string): number {
  let value = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) {
    value = Math.imul(value ^ byte, 0x01000193);
  }
  return value & 0x7fff_ffff;
}

function lowerRecordFields(
  file: string,
  fieldBlock: RuleCursor,
): readonly DucklangRecordField[] {
  return fieldBlock.children().flatMap(
    (child): readonly DucklangRecordField[] => {
      if (child.type === "token" && child.kind === "SHORTHAND_RECORD") {
        return shorthandRecordFields(file, child);
      }
      if (child.type !== "rule") return [];
      if (child.name === "shorthand_field") {
        const name = identifierName(file, child, "record shorthand field");
        return [{
          name: name.text,
          value: { kind: "reference", name, span: name.span },
          span: sourceSpan(file, child),
        }];
      }
      if (
        child.name !== "shape_field" &&
        child.name !== "first_shape_field" &&
        child.name !== "field_definition"
      ) {
        throw unsupported(file, child, "record field");
      }
      return [{
        name: identifierName(
          file,
          requiredField(child, "name"),
          "struct update field",
        ).text,
        value: lowerExpression(file, requiredField(child, "value")),
        span: sourceSpan(file, child),
      }];
    },
  );
}

function shorthandRecordFields(
  file: string,
  cursor: TokenCursor,
): readonly DucklangRecordField[] {
  return [...cursor.text.slice(1, -1).matchAll(/[A-Za-z][A-Za-z0-9_]*/g)].map(
    (match) => {
      const start = cursor.span.start + 1 + match.index;
      const name = {
        text: match[0],
        span: { file, start, end: start + match[0].length },
      };
      return {
        name: name.text,
        value: { kind: "reference" as const, name, span: name.span },
        span: name.span,
      };
    },
  );
}

function applyNominalProductType(
  expression: DucklangExpression,
  declaredType: DucklangTypeReference,
): DucklangExpression {
  if (expression.kind === "function") {
    const bodyType = declaredType.name === "$function"
      ? declaredType.arguments[1] ?? declaredType
      : declaredType;
    return {
      ...expression,
      declaredResultType: declaredType,
      body: applyNominalProductType(expression.body, bodyType),
    };
  }
  if (declaredType.name.startsWith("$")) return expression;
  const nominalType = declaredType.name;
  if (expression.kind === "product" && expression.productKind === "array") {
    return { ...expression, productKind: "tuple", nominalType };
  }
  if (expression.kind === "record") {
    return { ...expression, nominalType };
  }
  if (expression.kind === "unionCase") {
    return { ...expression, nominalType };
  }
  if (expression.kind === "if") {
    return {
      ...expression,
      consequence: applyNominalProductType(
        expression.consequence,
        declaredType,
      ),
      alternative: expression.alternative === undefined
        ? undefined
        : applyNominalProductType(expression.alternative, declaredType),
    };
  }
  if (expression.kind === "ifUnion") {
    return {
      ...expression,
      consequence: applyNominalProductType(
        expression.consequence,
        declaredType,
      ),
      alternative: expression.alternative === undefined
        ? undefined
        : applyNominalProductType(expression.alternative, declaredType),
    };
  }
  if (expression.kind !== "block" || expression.statements.length === 0) {
    return expression;
  }
  const statements = [...expression.statements];
  const last = statements.at(-1);
  if (last === undefined || last.kind !== "expression") return expression;
  statements[statements.length - 1] = {
    ...last,
    expression: applyNominalProductType(last.expression, declaredType),
  };
  return { ...expression, statements };
}

function forallTypeParameterNames(
  forallType: RuleCursor,
): readonly string[] {
  const tokens: TokenCursor[] = [];
  collectAllTokens(forallType, tokens);
  const delimiter = tokens.findIndex((token) => token.text === ".");
  return tokens.slice(0, delimiter < 0 ? tokens.length : delimiter)
    .filter((token) => token.kind === "identifier")
    .map((token) => token.text);
}

function lowerTokenExpression(
  file: string,
  cursor: TokenCursor,
): DucklangExpression {
  const span = sourceSpan(file, cursor);
  if (cursor.kind === "SHORTHAND_RECORD") {
    return {
      kind: "record",
      fields: shorthandRecordFields(file, cursor),
      span,
    };
  }
  if (cursor.kind === "FLOAT_LITERAL") {
    const encoded = cursor.text.match(
      /^\\([0-9]*)([k-t])([0-9]+)f(32|64)$/,
    );
    if (encoded === null) {
      throw unsupported(file, cursor, "floating-point literal");
    }
    const leadingDigit = String(encoded[2].charCodeAt(0) - "k".charCodeAt(0));
    const value = Number.parseFloat(
      `${leadingDigit}${encoded[1]}.${encoded[3]}`,
    );
    return encoded[4] === "32"
      ? { kind: "float32", value: Math.fround(value), span }
      : { kind: "float64", value, span };
  }
  if (cursor.kind === "HEX_LITERAL") {
    const value = Number.parseInt(cursor.text.slice(2), 16);
    if (!Number.isSafeInteger(value) || value > maximumIntegerLiteral) {
      throw new SyntaxError(
        `${file}:${cursor.span.start}: integer literal 0x${
          cursor.text.slice(2)
        } is outside signed i32`,
      );
    }
    return { kind: "integer", value, span };
  }
  if (cursor.kind === "number") {
    const floatingPoint = cursor.text.match(/^([0-9]+)f(32|64)$/);
    if (floatingPoint !== null) {
      const value = Number.parseFloat(floatingPoint[1]);
      return floatingPoint[2] === "32"
        ? { kind: "float32", value: Math.fround(value), span }
        : { kind: "float64", value, span };
    }
    if (/^0[xX][0-9A-Fa-f]+$/.test(cursor.text)) {
      const value = Number.parseInt(cursor.text.slice(2), 16);
      if (!Number.isSafeInteger(value) || value > maximumIntegerLiteral) {
        throw new SyntaxError(
          `${file}:${cursor.span.start}: integer literal ${cursor.text} is outside signed i32`,
        );
      }
      return { kind: "integer", value, span };
    }
    if (/^[0-9]+i64$/.test(cursor.text)) {
      const value = BigInt(cursor.text.slice(0, -3));
      if (value > 9_223_372_036_854_775_807n) {
        throw new SyntaxError(
          `${file}:${cursor.span.start}: integer literal ${cursor.text} is outside signed i64`,
        );
      }
      return { kind: "integer64", value, span };
    }
    const packedInteger = cursor.text.match(/^([0-9]+)u([1-9][0-9]*)$/);
    if (packedInteger !== null) {
      const value = Number.parseInt(packedInteger[1], 10);
      const width = Number.parseInt(packedInteger[2], 10);
      if (
        !Number.isSafeInteger(value) || width > 31 ||
        value >= 2 ** width
      ) {
        throw new SyntaxError(
          `${file}:${cursor.span.start}: packed integer literal ${cursor.text} does not fit an unsigned ${width}-bit i32 carrier`,
        );
      }
      return { kind: "integer", value, span };
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
  if (
    cursor.kind === "identifier" || cursor.kind === "intrinsic_identifier" ||
    cursor.text === "loop"
  ) {
    const name = { text: cursor.text, span };
    return { kind: "reference", name, span };
  }
  throw unsupported(file, cursor, cursor.kind);
}

function lowerCallArguments(
  file: string,
  input: SyntaxCursor,
): readonly DucklangExpression[] {
  const wrappedDirectArgument = input.type === "rule" &&
    ((input.name === "postfix_expression" &&
      input.children().length === 1) ||
      input.name === "_primary_expression");
  const directArrayArgument = input.type === "rule" &&
    (input.name === "array_expression" ||
      input.name === "line_array_expression");
  const argument = wrappedDirectArgument ? onlyRuleOrTokenChild(input) : input;
  const cursor = descendSingleRule(
    argument,
    new Set([
      "parenthesized_or_product",
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
  const lowered = lowerExpression(file, cursor);
  if (
    (wrappedDirectArgument || directArrayArgument) &&
    lowered.kind === "product" &&
    lowered.productKind === "array"
  ) {
    return lowered.values;
  }
  return [lowered];
}

function lowerParameters(
  file: string,
  input: CursorFieldValue,
): readonly DucklangParameter[] {
  if (!isCursor(input)) throw new Error("arrow parameters are missing");
  if (input.type === "token") {
    if (
      input.kind === "ARROW_PARAMETER" ||
      input.kind === "ARROW_PARAMETER_LIST" ||
      input.kind === "BRACKET_PARAMETER_LIST"
    ) {
      return arrowParameters(file, input);
    }
    if (input.kind === "DISCARDED_ARROW") {
      return [{
        text: `discarded_parameter_${input.span.start}`,
        span: {
          file,
          start: input.span.start,
          end: input.span.start + 1,
        },
      }];
    }
    if (input.kind === "SINGLE_ARROW_PARAMETER") {
      const equals = input.text.lastIndexOf("=");
      const text = input.text.at(-1)! +
        input.text.slice(1, equals).trimEnd();
      return [{
        text,
        span: {
          file,
          start: input.span.start,
          end: input.span.start + text.length,
        },
      }];
    }
    return [identifierName(file, input, "parameter")];
  }
  if (input.name === "unit_pattern") return [];
  if (input.name === "parameter_list") return arrowParameters(file, input);
  if (input.name === "bracket_parameter_list") {
    return arrowParameters(file, input);
  }
  if (input.name === "const_parameter_list") {
    return constParameterNames(file, input);
  }
  if (input.name === "parameter") {
    if (findRule(input, "wildcard") !== undefined) {
      return [{
        text: `discarded_parameter_${input.span.start}`,
        span: sourceSpan(file, input),
      }];
    }
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
    const parameters = cursor.children().filter((child): child is RuleCursor =>
      child.type === "rule" && child.name === "parameter"
    );
    if (parameters.length > 0) {
      return parameters.map((parameter) => {
        const name = identifierName(
          file,
          requiredField(parameter, "name"),
          "const parameter",
        );
        const parameterTokens: TokenCursor[] = [];
        collectAllTokens(parameter, parameterTokens);
        const declaredType = parameter.field("type");
        const declaredTypeReference = isCursor(declaredType) &&
            !parameterTokens.some((token) => token.text === "->")
          ? lowerTypeReference(file, declaredType)
          : undefined;
        const compileTime = parameterTokens.some((token) =>
          token.text === "const"
        );
        return {
          ...name,
          ...(parameterTokens.some((token) => token.text === "...")
            ? { variadic: true }
            : {}),
          ...(compileTime ? { compileTimeRecord: true } : {}),
          ...(declaredTypeReference === undefined ||
              (compileTime && /^[a-z]/.test(declaredTypeReference.name))
            ? {}
            : { declaredType: declaredTypeReference }),
        };
      });
    }
    throw new Error(
      `Ducklang const parameter list has no fused token; children ${
        cursor.children().map((child) =>
          child.type === "rule" ? child.name : child.kind
        ).join(", ")
      }; tokens ${tokens.map((token) => token.kind).join(", ")}`,
    );
  }
  const contents = list.text.slice(1, -1);
  const parameters: string[] = [];
  let parameterStart = 0;
  let delimiterDepth = 0;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (character === "(" || character === "[" || character === "{") {
      delimiterDepth += 1;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      delimiterDepth -= 1;
      continue;
    }
    if (character !== "," || delimiterDepth !== 0) continue;
    parameters.push(contents.slice(parameterStart, index));
    parameterStart = index + 1;
  }
  const trailingParameter = contents.slice(parameterStart);
  if (trailingParameter.trim().length > 0) {
    parameters.push(trailingParameter);
  }
  let searchStart = 1;
  return parameters.map((parameter) => {
    const match = parameter.trim().match(
      /^(const\s+)?(?:\.\.\.)?([A-Za-z][A-Za-z0-9_]*)(?:\s*:\s*(.+))?$/,
    );
    if (match === null) {
      throw unsupported(file, list, "const parameter list");
    }
    const nameOffset = list.text.indexOf(match[2], searchStart);
    if (nameOffset < 0) {
      throw new Error(
        `Ducklang const parameter ${match[2]} has no source span`,
      );
    }
    searchStart = nameOffset + match[2].length;
    const declaredTypeName = match[3] === "I32" || match[3] === "I64" ||
        match[3] === "Bool" || match[3] === "Text"
      ? match[3]
      : undefined;
    const span = {
      file,
      start: list.span.start + nameOffset,
      end: list.span.start + nameOffset + match[2].length,
    };
    return {
      text: match[2],
      ...(parameter.includes("...") ? { variadic: true } : {}),
      ...(match[1] === undefined ? {} : { compileTimeRecord: true }),
      ...(declaredTypeName === undefined
        ? {}
        : { declaredType: ducklangNamedType(declaredTypeName, span) }),
      span,
    };
  });
}

function arrowParameters(
  file: string,
  cursor: SyntaxCursor,
): readonly DucklangParameter[] {
  if (cursor.type === "rule" && cursor.name === "const_parameter_list") {
    return constParameterNames(file, cursor);
  }
  const tokens: TokenCursor[] = [];
  collectAllTokens(cursor, tokens);
  const singleParameter = tokens.find((token) =>
    token.kind === "ARROW_PARAMETER"
  );
  if (singleParameter !== undefined) {
    const span = sourceSpan(file, singleParameter);
    return [{
      text: singleParameter.text === "_"
        ? `discarded_parameter_${span.start}`
        : singleParameter.text,
      span,
    }];
  }
  const fusedList = tokens.find((token) =>
    token.kind === "ARROW_PARAMETER_LIST" ||
    token.kind === "BRACKET_PARAMETER_LIST"
  );
  if (fusedList !== undefined) {
    const parameters = fusedList.text.slice(1, -1).split(",").filter((
      parameter,
    ) => parameter.trim().length > 0);
    let searchStart = 1;
    return parameters.map((parameter) => {
      const match = parameter.trim().match(
        /^(?:(const|!)\s*)?([A-Za-z][A-Za-z0-9_]*|_)(?:\s*:\s*(.+))?$/,
      );
      if (match === null) {
        throw unsupported(
          file,
          fusedList,
          `arrow parameter list ${JSON.stringify(fusedList.text)}`,
        );
      }
      const nameOffset = fusedList.text.indexOf(match[2], searchStart);
      if (nameOffset < 0) {
        throw new Error(
          `Ducklang arrow parameter ${match[2]} has no source span`,
        );
      }
      searchStart = nameOffset + match[2].length;
      const span = {
        file,
        start: fusedList.span.start + nameOffset,
        end: fusedList.span.start + nameOffset + match[2].length,
      };
      if (match[2] === "_") {
        return {
          text: `discarded_parameter_${span.start}`,
          span,
        };
      }
      const annotation = match[3]?.trim();
      const declaredTypeName = annotation === undefined ||
          annotation.includes("->")
        ? undefined
        : /^(?:&\s*)?([A-Za-z][A-Za-z0-9_]*)/.exec(annotation)?.[1];
      return {
        text: match[2],
        ...(match[1] === "!" ? { linear: true } : {}),
        ...(match[1] === "const" ? { compileTimeRecord: true } : {}),
        ...(declaredTypeName === undefined
          ? {}
          : { declaredType: ducklangNamedType(declaredTypeName, span) }),
        span,
      };
    });
  }
  const parameterTokens = tokens.filter((token) =>
    token.text !== "(" && token.text !== ")" && token.text !== "[" &&
    token.text !== "]" && token.kind !== "TRAILING_PRODUCT_CLOSE" &&
    !/^\s+$/.test(token.text)
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
    const linear = group.length === 2 && name?.text === "!" &&
      separator?.kind === "identifier";
    const compileTime = group.length === 2 && name?.text === "const" &&
      separator?.kind === "identifier";
    const annotated = group.length >= 3 && name?.kind === "identifier" &&
      separator?.text === ":" && annotation?.kind === "identifier" &&
      group.slice(3).every((token) => token.kind === "identifier");
    if (!plain && !linear && !compileTime && !annotated) {
      throw unsupported(
        file,
        group[0] ?? cursor,
        `patterned parameter or unsupported type annotation ${
          JSON.stringify(
            group.map((token) => ({ kind: token.kind, text: token.text })),
          )
        }`,
      );
    }
    const parameterName = linear || compileTime ? separator : name;
    return {
      text: parameterName.text,
      ...(linear ? { linear: true } : {}),
      ...(compileTime ? { compileTimeRecord: true } : {}),
      ...(annotation === undefined ? {} : {
        declaredType: ducklangNamedType(
          annotation.text,
          sourceSpan(file, annotation),
        ),
      }),
      span: sourceSpan(file, parameterName),
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

function topLevelRule(
  cursor: SyntaxCursor,
  name: string,
): RuleCursor | undefined {
  let current = cursor;
  while (current.type === "rule") {
    if (current.name === name) return current;
    const ruleChildren = current.children().filter((
      child,
    ): child is RuleCursor => child.type === "rule");
    if (ruleChildren.length !== 1) return undefined;
    current = ruleChildren[0];
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
    const ruleChildren = cursor.children().filter((
      child,
    ): child is RuleCursor => child.type === "rule");
    if (ruleChildren.length === 1) {
      cursor = ruleChildren[0];
      continue;
    }
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
    throw new Error(
      `rule ${cursor.name} at ${cursor.span.start} has ${children.length} children`,
    );
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

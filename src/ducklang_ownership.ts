import type {
  DucklangExpression,
  DucklangModule,
  DucklangStatement,
} from "./ducklang_ast.ts";

export function validateDucklangOwnership(
  module: DucklangModule,
): DucklangModule {
  validateStatements(module.statements);
  return module;
}

function validateStatements(statements: readonly DucklangStatement[]): void {
  const borrowedOwners = new Set<string>();
  const frozenValues = new Set<string>();
  for (const statement of statements) {
    if (statement.kind === "binding") {
      validateExpression(statement.value);
      if (statement.value.kind === "function") {
        const parameterNames = new Set(
          statement.value.parameters.map((parameter) => parameter.text),
        );
        const escaped = returnedBorrow(statement.value.body);
        if (escaped !== undefined && parameterNames.has(escaped)) {
          throw new TypeError(
            `${statement.span.file}:${statement.span.start}: borrow of ${escaped} cannot escape its function`,
          );
        }
      }
      const borrowed = borrowedReference(statement.value);
      if (borrowed !== undefined) borrowedOwners.add(borrowed);
      const frozen = frozenReference(statement.value);
      if (frozen !== undefined && borrowedOwners.has(frozen)) {
        throw new TypeError(
          `${statement.span.file}:${statement.span.start}: Cannot freeze borrowed owner ${frozen}`,
        );
      }
      if (
        statement.value.kind === "unary" &&
        statement.value.operator === "freeze"
      ) {
        frozenValues.add(statement.name.text);
      }
      continue;
    }
    if (
      statement.kind === "assignment" &&
      statement.value.kind === "indexUpdate" &&
      statement.value.product.kind === "reference" &&
      frozenValues.has(statement.value.product.name.text)
    ) {
      throw new TypeError(
        `${statement.span.file}:${statement.span.start}: cannot mutate frozen Ducklang value ${statement.value.product.name.text}`,
      );
    }
    if (statement.kind === "expression") {
      validateExpression(statement.expression);
    }
  }
}

function validateExpression(expression: DucklangExpression): void {
  if (expression.kind === "scratch") {
    const result = blockResult(expression.body);
    if (result !== undefined && allocatesText(result)) {
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: allocated value cannot leave scratch region`,
      );
    }
  }
  if (expression.kind === "block") validateStatements(expression.statements);
  for (const value of Object.values(expression)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isExpression(child)) validateExpression(child);
      }
    } else if (isExpression(value)) {
      validateExpression(value);
    }
  }
}

function returnedBorrow(expression: DucklangExpression): string | undefined {
  const result = blockResult(expression) ?? expression;
  return borrowedReference(result);
}

function borrowedReference(expression: DucklangExpression): string | undefined {
  return expression.kind === "unary" && expression.operator === "&" &&
      expression.operand.kind === "reference"
    ? expression.operand.name.text
    : undefined;
}

function frozenReference(expression: DucklangExpression): string | undefined {
  return expression.kind === "unary" && expression.operator === "freeze" &&
      expression.operand.kind === "reference"
    ? expression.operand.name.text
    : undefined;
}

function blockResult(
  expression: DucklangExpression,
): DucklangExpression | undefined {
  if (expression.kind !== "block") return undefined;
  const statement = expression.statements.at(-1);
  return statement?.kind === "expression" ? statement.expression : undefined;
}

function allocatesText(expression: DucklangExpression): boolean {
  return expression.kind === "binary" &&
    (expression.operator === "<>" || expression.operator === "++");
}

function isExpression(value: unknown): value is DucklangExpression {
  if (value === null || typeof value !== "object") return false;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === "string" && expressionKinds.has(kind);
}

const expressionKinds = new Set([
  "integer",
  "integer64",
  "boolean",
  "unit",
  "string",
  "moduleImport",
  "hostCall",
  "optionDo",
  "unionCase",
  "product",
  "field",
  "recordUpdate",
  "record",
  "reference",
  "function",
  "recursiveCall",
  "call",
  "index",
  "indexUpdate",
  "binary",
  "unary",
  "if",
  "ifUnion",
  "block",
  "comptime",
  "scratch",
  "loop",
]);

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
    // Freezing a borrowed owner is already refused because it changes the owner's
    // state while a borrow observes it. Mutating one changes its contents under
    // the borrow, which is the same hazard and a stronger one.
    if (
      statement.kind === "assignment" &&
      statement.value.kind === "indexUpdate" &&
      statement.value.product.kind === "reference" &&
      borrowedOwners.has(statement.value.product.name.text)
    ) {
      throw new TypeError(
        `${statement.span.file}:${statement.span.start}: cannot mutate borrowed Ducklang value ${statement.value.product.name.text}`,
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
    if (result !== undefined && escapesScratch(result, expression.body)) {
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

/**
 * Whether a scratch block's result carries a value allocated inside the region.
 *
 * Checking only whether the result is itself an allocation caught
 * `scratch { "a" <> "b" }` and missed every indirection: binding the allocation
 * first and returning the name escaped, and so did returning it inside an
 * aggregate. Both leave the region with a pointer into it.
 *
 * So the result is searched for an allocation anywhere within it, and a reference
 * to a name the block bound to an allocation counts as one.
 */
function escapesScratch(
  result: DucklangExpression,
  body: DucklangExpression,
): boolean {
  const allocatedNames = new Set<string>();
  if (body.kind === "block") {
    for (const statement of body.statements) {
      if (statement.kind !== "binding") continue;
      if (containsAllocation(statement.value, allocatedNames)) {
        allocatedNames.add(statement.name.text);
      }
    }
  }
  return containsAllocation(result, allocatedNames);
}

function containsAllocation(
  expression: DucklangExpression,
  allocatedNames: ReadonlySet<string>,
): boolean {
  if (allocatesText(expression)) return true;
  if (
    expression.kind === "reference" && allocatedNames.has(expression.name.text)
  ) {
    return true;
  }
  // A nested scratch owns its own region, so its result cannot carry this one's
  // allocations outward.
  if (expression.kind === "scratch") return false;
  // Freezing is the sanctioned way out: a frozen value is immutable and no longer
  // tied to the region's lifetime, which is how
  // examples/showcases/05_linear_host_session.duck exports a scratch allocation.
  if (expression.kind === "unary" && expression.operator === "freeze") {
    return false;
  }
  for (const value of Object.values(expression)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isExpression(child) && containsAllocation(child, allocatedNames)) {
          return true;
        }
      }
      continue;
    }
    if (isExpression(value) && containsAllocation(value, allocatedNames)) {
      return true;
    }
  }
  return false;
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
  "effectHandler",
  "handle",
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

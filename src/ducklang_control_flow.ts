import type {
  DucklangExpression,
  DucklangModule,
  DucklangName,
  DucklangStatement,
} from "./ducklang_ast.ts";

export function lowerDucklangConditionalAssignments(
  module: DucklangModule,
): DucklangModule {
  return { ...module, statements: lowerStatements(module.statements) };
}

function lowerStatements(
  statements: readonly DucklangStatement[],
): readonly DucklangStatement[] {
  return statements.map((statement) => {
    const lowered = lowerStatementExpressions(statement);
    if (lowered.kind !== "expression" || lowered.expression.kind !== "if") {
      return lowered;
    }
    const assignments = collectBranchAssignments(lowered.expression);
    if (assignments.size !== 1) return lowered;
    const [name] = assignments.values();
    const value = lowerAssignmentCondition(lowered.expression, name);
    if (value === undefined) return lowered;
    return {
      kind: "assignment",
      operator: "=",
      name,
      value,
      span: lowered.span,
    };
  });
}

function lowerStatementExpressions(
  statement: DucklangStatement,
): DucklangStatement {
  switch (statement.kind) {
    case "binding":
    case "assignment":
      return { ...statement, value: lowerExpression(statement.value) };
    case "unionBinding":
      return {
        ...statement,
        value: lowerExpression(statement.value),
        alternative: lowerExpression(statement.alternative),
      };
    case "recursiveGroup":
      return {
        ...statement,
        bindings: statement.bindings.map((binding) => ({
          ...binding,
          value: lowerExpression(binding.value),
        })),
      };
    case "productBinding":
      return { ...statement, value: lowerExpression(statement.value) };
    case "forRange":
      return {
        ...statement,
        start: lowerExpression(statement.start),
        end: lowerExpression(statement.end),
        step: statement.step === undefined
          ? undefined
          : lowerExpression(statement.step),
        body: lowerExpression(statement.body),
      };
    case "break":
      return {
        ...statement,
        value: statement.value === undefined
          ? undefined
          : lowerExpression(statement.value),
      };
    case "return":
    case "expression":
      return {
        ...statement,
        expression: lowerExpression(statement.expression),
      };
    case "effectDeclaration":
    case "unionType":
    case "typeAlias":
    case "import":
    case "continue":
      return statement;
  }
}

function lowerExpression(expression: DucklangExpression): DucklangExpression {
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
    case "reference":
      return expression;
    case "hostCall":
      return {
        ...expression,
        arguments: expression.arguments.map(lowerExpression),
      };
    case "unionCase":
      return { ...expression, value: lowerExpression(expression.value) };
    case "product":
      return { ...expression, values: expression.values.map(lowerExpression) };
    case "function":
      return { ...expression, body: lowerExpression(expression.body) };
    case "recursiveCall":
      return {
        ...expression,
        arguments: expression.arguments.map(lowerExpression),
      };
    case "call":
      return {
        ...expression,
        callee: lowerExpression(expression.callee),
        arguments: expression.arguments.map(lowerExpression),
      };
    case "index":
      return {
        ...expression,
        collection: lowerExpression(expression.collection),
        index: lowerExpression(expression.index),
      };
    case "binary":
      return {
        ...expression,
        left: lowerExpression(expression.left),
        right: lowerExpression(expression.right),
      };
    case "unary":
      return { ...expression, operand: lowerExpression(expression.operand) };
    case "if":
      return {
        ...expression,
        condition: lowerExpression(expression.condition),
        consequence: lowerExpression(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : lowerExpression(expression.alternative),
      };
    case "ifUnion":
      return {
        ...expression,
        value: lowerExpression(expression.value),
        consequence: lowerExpression(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : lowerExpression(expression.alternative),
      };
    case "block":
      return {
        ...expression,
        statements: lowerStatements(expression.statements),
      };
    case "comptime":
      return {
        ...expression,
        expression: lowerExpression(expression.expression),
      };
    case "scratch":
    case "loop":
      return { ...expression, body: lowerExpression(expression.body) };
  }
}

function collectBranchAssignments(
  expression: Extract<DucklangExpression, { readonly kind: "if" }>,
): ReadonlyMap<string, DucklangName> {
  const assignments = new Map<string, DucklangName>();
  collectAssignments(expression.consequence, assignments);
  if (expression.alternative !== undefined) {
    collectAssignments(expression.alternative, assignments);
  }
  return assignments;
}

function collectAssignments(
  expression: DucklangExpression,
  assignments: Map<string, DucklangName>,
): void {
  if (expression.kind !== "block") return;
  for (const statement of expression.statements) {
    if (statement.kind === "assignment") {
      assignments.set(statement.name.text, statement.name);
    }
  }
}

function lowerAssignmentCondition(
  expression: Extract<DucklangExpression, { readonly kind: "if" }>,
  name: DucklangName,
): DucklangExpression | undefined {
  const fallback: DucklangExpression = {
    kind: "reference",
    name,
    span: name.span,
  };
  const consequence = lowerAssignmentBranch(
    expression.consequence,
    name.text,
    fallback,
  );
  if (consequence === undefined) return undefined;
  const alternative = expression.alternative === undefined
    ? fallback
    : lowerAssignmentBranch(expression.alternative, name.text, fallback);
  if (alternative === undefined) return undefined;
  return {
    ...expression,
    consequence,
    alternative,
  };
}

function lowerAssignmentBranch(
  expression: DucklangExpression,
  target: string,
  fallback: DucklangExpression,
): DucklangExpression | undefined {
  if (expression.kind !== "block") return undefined;
  const matching = expression.statements.flatMap((statement, index) =>
    statement.kind === "assignment" && statement.name.text === target
      ? [{ statement, index }]
      : []
  );
  if (matching.length === 0) {
    return {
      ...expression,
      statements: [
        ...expression.statements,
        { kind: "expression", expression: fallback, span: fallback.span },
      ],
    };
  }
  const assignment = matching[0];
  if (
    matching.length !== 1 ||
    assignment.index !== expression.statements.length - 1
  ) {
    return undefined;
  }
  return {
    ...expression,
    statements: [
      ...expression.statements.slice(0, -1),
      {
        kind: "expression",
        expression: assignment.statement.value,
        span: assignment.statement.span,
      },
    ],
  };
}

import type {
  DucklangExpression,
  DucklangModule,
  DucklangName,
  DucklangStatement,
} from "./ducklang_ast.ts";

export function lowerDucklangControlFlow(
  module: DucklangModule,
): DucklangModule {
  return { ...module, statements: lowerStatements(module.statements) };
}

function lowerStatements(
  statements: readonly DucklangStatement[],
): readonly DucklangStatement[] {
  return statements.flatMap((statement): readonly DucklangStatement[] => {
    const lowered = lowerStatementExpressions(statement);
    if (lowered.kind === "forRange") {
      const range = lowerDynamicRange(lowered);
      return range ?? [lowered];
    }
    if (lowered.kind !== "expression" || lowered.expression.kind !== "if") {
      return [lowered];
    }
    const assignments = collectBranchAssignments(lowered.expression);
    if (assignments.size !== 1) return [lowered];
    const [name] = assignments.values();
    const value = lowerAssignmentCondition(lowered.expression, name);
    if (value === undefined) return [lowered];
    return [{
      kind: "assignment",
      operator: "=",
      name,
      value,
      span: lowered.span,
    }];
  });
}

function lowerDynamicRange(
  statement: Extract<DucklangStatement, { readonly kind: "forRange" }>,
): readonly DucklangStatement[] | undefined {
  if (statement.iterator === undefined || statement.body.kind !== "block") {
    return undefined;
  }
  if (statement.body.statements.length !== 1) return undefined;
  const update = statement.body.statements[0];
  if (update.kind !== "assignment") return undefined;
  if (statement.iterator.text === update.name.text) return undefined;
  const step = statement.step ?? {
    kind: "integer" as const,
    value: 1,
    span: statement.span,
  };
  const staticStep = step.kind === "integer"
    ? step.value
    : step.kind === "unary" && step.operator === "-" &&
        step.operand.kind === "integer"
    ? -step.operand.value
    : undefined;
  if (staticStep === undefined || staticStep === 0) return undefined;
  const functionName: DucklangName = {
    text: `$range_loop_${statement.span.start}`,
    span: statement.span,
  };
  const endParameter: DucklangName = {
    text: `$range_end_${statement.span.start}`,
    span: statement.end.span,
  };
  const stepParameter: DucklangName = {
    text: `$range_step_${statement.span.start}`,
    span: step.span,
  };
  let comparisonOperator: "<" | ">";
  if (statement.inclusive) {
    comparisonOperator = staticStep > 0 ? ">" : "<";
  } else {
    comparisonOperator = staticStep > 0 ? "<" : ">";
  }
  const boundaryComparison: DucklangExpression = {
    kind: "binary",
    operator: comparisonOperator,
    left: {
      kind: "reference",
      name: statement.iterator,
      span: statement.iterator.span,
    },
    right: {
      kind: "reference",
      name: endParameter,
      span: endParameter.span,
    },
    span: statement.span,
  };
  const condition: DucklangExpression = statement.inclusive
    ? {
      kind: "unary",
      operator: "!",
      operand: boundaryComparison,
      span: statement.span,
    }
    : boundaryComparison;
  const nextIndex: DucklangExpression = {
    kind: "binary",
    operator: "+",
    left: {
      kind: "reference",
      name: statement.iterator,
      span: statement.iterator.span,
    },
    right: {
      kind: "reference",
      name: stepParameter,
      span: stepParameter.span,
    },
    span: statement.span,
  };
  const loopFunction: DucklangStatement = {
    kind: "binding",
    declarationKind: "let",
    recursive: true,
    name: functionName,
    value: {
      kind: "function",
      recursive: true,
      parameters: [
        statement.iterator,
        update.name,
        endParameter,
        stepParameter,
      ],
      body: {
        kind: "if",
        condition,
        consequence: {
          kind: "recursiveCall",
          arguments: [
            nextIndex,
            update.value,
            {
              kind: "reference",
              name: endParameter,
              span: endParameter.span,
            },
            {
              kind: "reference",
              name: stepParameter,
              span: stepParameter.span,
            },
          ],
          span: statement.span,
        },
        alternative: {
          kind: "reference",
          name: update.name,
          span: update.name.span,
        },
        span: statement.span,
      },
      span: statement.span,
    },
    span: statement.span,
  };
  return [
    loopFunction,
    {
      kind: "assignment",
      operator: update.operator,
      name: update.name,
      value: {
        kind: "call",
        callee: {
          kind: "reference",
          name: functionName,
          span: functionName.span,
        },
        arguments: [
          statement.start,
          {
            kind: "reference",
            name: update.name,
            span: update.name.span,
          },
          statement.end,
          step,
        ],
        span: statement.span,
      },
      span: statement.span,
    },
  ];
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
    case "structType":
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
    case "field":
      return { ...expression, product: lowerExpression(expression.product) };
    case "recordUpdate":
      return {
        ...expression,
        product: lowerExpression(expression.product),
        fields: expression.fields.map((field) => ({
          ...field,
          value: lowerExpression(field.value),
        })),
      };
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

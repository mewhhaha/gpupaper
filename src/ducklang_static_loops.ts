import type {
  DucklangExpression,
  DucklangModule,
  DucklangStatement,
} from "./ducklang_ast.ts";

type Expansion = {
  readonly statements: readonly DucklangStatement[];
  readonly control: "next" | "break" | "continue";
};

const maximumStaticIterations = 100_000;

export function expandStaticDucklangLoops(
  module: DucklangModule,
): DucklangModule {
  const expanded = expandStatements(module.statements, new Map(), false);
  if (expanded.control !== "next") {
    throw new SyntaxError(
      `${module.file}:${module.span.start}: Ducklang ${expanded.control} has no enclosing loop`,
    );
  }
  return { ...module, statements: expanded.statements };
}

function expandStatements(
  statements: readonly DucklangStatement[],
  initialValues: ReadonlyMap<string, DucklangExpression>,
  inLoop: boolean,
): Expansion {
  const values = new Map(initialValues);
  const expanded: DucklangStatement[] = [];
  for (const statement of statements) {
    if (statement.kind === "break" || statement.kind === "continue") {
      if (!inLoop) {
        throw new SyntaxError(
          `${statement.span.file}:${statement.span.start}: Ducklang ${statement.kind} has no enclosing loop`,
        );
      }
      return { statements: expanded, control: statement.kind };
    }
    if (statement.kind === "forRange") {
      const start = evaluateStaticInteger(
        substituteExpression(statement.start, values),
      );
      const end = evaluateStaticInteger(
        substituteExpression(statement.end, values),
      );
      const step = statement.step === undefined
        ? 1
        : evaluateStaticInteger(substituteExpression(statement.step, values));
      if (start === undefined || end === undefined || step === undefined) {
        expanded.push(substituteStatement(statement, values));
        continue;
      }
      if (step === 0) {
        throw new RangeError(
          `${statement.span.file}:${statement.span.start}: Ducklang static range step cannot be zero`,
        );
      }
      const body = statement.body.kind === "block"
        ? statement.body.statements
        : undefined;
      if (body === undefined) {
        throw new Error(
          `${statement.span.file}:${statement.span.start}: Ducklang range body is not a block`,
        );
      }
      let iterations = 0;
      const beforeEnd = step > 0
        ? (value: number) => statement.inclusive ? value <= end : value < end
        : (value: number) => statement.inclusive ? value >= end : value > end;
      for (let value = start; beforeEnd(value); value += step) {
        iterations += 1;
        if (iterations > maximumStaticIterations) {
          throw new RangeError(
            `${statement.span.file}:${statement.span.start}: Ducklang static range exceeds ${maximumStaticIterations} iterations`,
          );
        }
        const iterationValues = new Map(values);
        if (statement.iterator !== undefined) {
          iterationValues.set(statement.iterator.text, {
            kind: "integer",
            value,
            span: statement.iterator.span,
          });
        }
        const iteration = expandStatements(body, iterationValues, true);
        expanded.push(...iteration.statements);
        if (iteration.control === "break") break;
      }
      continue;
    }
    if (inLoop && statement.kind === "expression") {
      const expression = substituteExpression(statement.expression, values);
      if (expression.kind === "if") {
        const condition = evaluateStaticBoolean(expression.condition);
        if (condition !== undefined) {
          const selected = condition
            ? expression.consequence
            : expression.alternative;
          if (selected === undefined) continue;
          if (selected.kind === "block") {
            const branch = expandStatements(selected.statements, values, true);
            expanded.push(...branch.statements);
            if (branch.control !== "next") {
              return { statements: expanded, control: branch.control };
            }
            continue;
          }
        }
      }
      expanded.push({ ...statement, expression });
      continue;
    }
    const substituted = substituteStatement(statement, values);
    expanded.push(substituted);
    if (statement.kind === "binding") values.delete(statement.name.text);
    if (statement.kind === "assignment") values.delete(statement.name.text);
    if (statement.kind === "unionBinding") values.delete(statement.name.text);
    if (statement.kind === "productBinding") {
      for (const name of statement.names) {
        if (name !== undefined) values.delete(name.text);
      }
    }
  }
  return { statements: expanded, control: "next" };
}

function substituteStatement(
  statement: DucklangStatement,
  values: ReadonlyMap<string, DucklangExpression>,
): DucklangStatement {
  switch (statement.kind) {
    case "binding":
    case "assignment":
      return {
        ...statement,
        value: substituteExpression(statement.value, values),
      };
    case "unionBinding":
      return {
        ...statement,
        value: substituteExpression(statement.value, values),
        alternative: substituteExpression(statement.alternative, values),
      };
    case "productBinding":
      return {
        ...statement,
        value: substituteExpression(statement.value, values),
      };
    case "return":
      return {
        ...statement,
        expression: substituteExpression(statement.expression, values),
      };
    case "expression":
      return {
        ...statement,
        expression: substituteExpression(statement.expression, values),
      };
    case "forRange":
      return {
        ...statement,
        start: substituteExpression(statement.start, values),
        end: substituteExpression(statement.end, values),
        step: statement.step === undefined
          ? undefined
          : substituteExpression(statement.step, values),
        body: substituteExpression(statement.body, values),
      };
    case "break":
      return {
        ...statement,
        value: statement.value === undefined
          ? undefined
          : substituteExpression(statement.value, values),
      };
    case "continue":
    case "import":
    case "unionType":
    case "typeAlias":
      return statement;
  }
}

function substituteExpression(
  expression: DucklangExpression,
  values: ReadonlyMap<string, DucklangExpression>,
): DucklangExpression {
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
      return expression;
    case "reference":
      return values.get(expression.name.text) ?? expression;
    case "function": {
      const functionValues = new Map(values);
      for (const parameter of expression.parameters) {
        functionValues.delete(parameter.text);
      }
      return {
        ...expression,
        body: substituteExpression(expression.body, functionValues),
      };
    }
    case "recursiveCall":
      return {
        ...expression,
        arguments: expression.arguments.map((argument) =>
          substituteExpression(argument, values)
        ),
      };
    case "call":
      return {
        ...expression,
        callee: substituteExpression(expression.callee, values),
        arguments: expression.arguments.map((argument) =>
          substituteExpression(argument, values)
        ),
      };
    case "index":
      return {
        ...expression,
        collection: substituteExpression(expression.collection, values),
        index: substituteExpression(expression.index, values),
      };
    case "unionCase":
      return {
        ...expression,
        value: substituteExpression(expression.value, values),
      };
    case "product":
      return {
        ...expression,
        values: expression.values.map((value) =>
          substituteExpression(value, values)
        ),
      };
    case "binary":
      return {
        ...expression,
        left: substituteExpression(expression.left, values),
        right: substituteExpression(expression.right, values),
      };
    case "unary":
      return {
        ...expression,
        operand: substituteExpression(expression.operand, values),
      };
    case "if":
      return {
        ...expression,
        condition: substituteExpression(expression.condition, values),
        consequence: substituteExpression(expression.consequence, values),
        alternative: expression.alternative === undefined
          ? undefined
          : substituteExpression(expression.alternative, values),
      };
    case "ifUnion": {
      const consequenceValues = new Map(values);
      if (expression.payloadName !== undefined) {
        consequenceValues.delete(expression.payloadName.text);
      }
      return {
        ...expression,
        value: substituteExpression(expression.value, values),
        consequence: substituteExpression(
          expression.consequence,
          consequenceValues,
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : substituteExpression(expression.alternative, values),
      };
    }
    case "block":
      return {
        ...expression,
        statements: substituteStatementList(expression.statements, values),
      };
    case "comptime":
      return {
        ...expression,
        expression: substituteExpression(expression.expression, values),
      };
    case "scratch":
      return {
        ...expression,
        body: substituteExpression(expression.body, values),
      };
  }
}

function substituteStatementList(
  statements: readonly DucklangStatement[],
  initialValues: ReadonlyMap<string, DucklangExpression>,
): readonly DucklangStatement[] {
  const values = new Map(initialValues);
  return statements.map((statement) => {
    const substituted = substituteStatement(statement, values);
    if (
      statement.kind === "binding" || statement.kind === "assignment" ||
      statement.kind === "unionBinding"
    ) {
      values.delete(statement.name.text);
    }
    return substituted;
  });
}

function evaluateStaticInteger(
  expression: DucklangExpression,
): number | undefined {
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "unary" && expression.operator === "-") {
    const operand = evaluateStaticInteger(expression.operand);
    return operand === undefined ? undefined : -operand;
  }
  if (expression.kind !== "binary") return undefined;
  const left = evaluateStaticInteger(expression.left);
  const right = evaluateStaticInteger(expression.right);
  if (left === undefined || right === undefined) return undefined;
  if (expression.operator === "+") return left + right;
  if (expression.operator === "-") return left - right;
  if (expression.operator === "*") return left * right;
  if (expression.operator === "/" && right !== 0) {
    return Math.trunc(left / right);
  }
  if (expression.operator === "%" && right !== 0) return left % right;
  return undefined;
}

function evaluateStaticBoolean(
  expression: DucklangExpression,
): boolean | undefined {
  if (expression.kind === "boolean") return expression.value;
  if (expression.kind === "unary" && expression.operator === "!") {
    const operand = evaluateStaticBoolean(expression.operand);
    return operand === undefined ? undefined : !operand;
  }
  if (expression.kind !== "binary") return undefined;
  const leftInteger = evaluateStaticInteger(expression.left);
  const rightInteger = evaluateStaticInteger(expression.right);
  if (leftInteger !== undefined && rightInteger !== undefined) {
    if (expression.operator === "==") return leftInteger === rightInteger;
    if (expression.operator === "<") return leftInteger < rightInteger;
    if (expression.operator === ">") return leftInteger > rightInteger;
  }
  if (expression.operator === "&&") {
    const left = evaluateStaticBoolean(expression.left);
    const right = evaluateStaticBoolean(expression.right);
    return left === undefined || right === undefined
      ? undefined
      : left && right;
  }
  return undefined;
}

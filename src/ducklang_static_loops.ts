import {
  type DucklangExpression,
  type DucklangModule,
  type DucklangName,
  ducklangNamedType,
  type DucklangStatement,
  type DucklangTypeReference,
} from "./ducklang_ast.ts";

type Expansion = {
  readonly statements: readonly DucklangStatement[];
  readonly control: "next" | "break" | "continue";
  readonly values: ReadonlyMap<string, DucklangExpression>;
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
  let values = new Map(initialValues);
  const expanded: DucklangStatement[] = [];
  for (const [statementIndex, statement] of statements.entries()) {
    if (statement.kind === "break" || statement.kind === "continue") {
      if (!inLoop) {
        throw new SyntaxError(
          `${statement.span.file}:${statement.span.start}: Ducklang ${statement.kind} has no enclosing loop`,
        );
      }
      return { statements: expanded, control: statement.kind, values };
    }
    if (
      statement.kind === "binding" && statement.value.kind === "function" &&
      statement.value.parameters.some((parameter) =>
        parameter.variadic || parameter.compileTimeRecord
      )
    ) {
      values.set(
        statement.name.text,
        substituteExpression(statement.value, values),
      );
      continue;
    }
    if (
      statementIndex < statements.length - 1 &&
      statement.kind === "expression" && statement.expression.kind === "field"
    ) {
      continue;
    }
    if (inLoop && statement.kind === "unionBinding") {
      const value = substituteExpression(statement.value, values);
      if (value.kind === "unionCase") {
        if (value.caseName === statement.caseName) {
          values.set(statement.name.text, value.value);
          continue;
        }
        if (statement.alternative.kind !== "block") {
          throw new Error(
            `${statement.span.file}:${statement.span.start}: Ducklang refutable binding alternative is not a block`,
          );
        }
        const alternative = expandStatements(
          statement.alternative.statements,
          values,
          true,
        );
        expanded.push(...alternative.statements);
        values = new Map(alternative.values);
        if (alternative.control !== "next") {
          return {
            statements: expanded,
            control: alternative.control,
            values,
          };
        }
        continue;
      }
    }
    if (statement.kind === "forCollection") {
      const collection = evaluateStaticValue(
        substituteExpression(statement.collection, values),
      );
      const elements = staticCollectionElements(collection);
      if (elements === undefined) {
        expanded.push(substituteStatement(statement, values, false));
        if (statement.body.kind === "block") {
          for (const bodyStatement of statement.body.statements) {
            if (bodyStatement.kind === "assignment") {
              values.delete(bodyStatement.name.text);
            }
          }
        }
        continue;
      }
      if (statement.body.kind !== "block") {
        throw new Error(
          `${statement.span.file}:${statement.span.start}: Ducklang collection body is not a block`,
        );
      }
      const loopNames = statement.index === undefined
        ? [statement.value]
        : [statement.index, statement.value];
      const bodyNames = statement.body.statements.flatMap((bodyStatement) => {
        if (
          bodyStatement.kind === "binding" ||
          bodyStatement.kind === "unionBinding"
        ) {
          return [bodyStatement.name];
        }
        if (bodyStatement.kind === "recursiveGroup") {
          return bodyStatement.bindings.map((binding) => binding.name);
        }
        if (bodyStatement.kind === "productBinding") {
          return bodyStatement.names.flatMap((name) =>
            name === undefined ? [] : [name]
          );
        }
        return [];
      });
      const scopedNames = [...loopNames, ...bodyNames];
      const shadowedValues = new Map(
        scopedNames.map((name) => [name.text, values.get(name.text)]),
      );
      for (const [index, element] of elements.entries()) {
        let iterationValue = element;
        if (statement.caseName !== undefined) {
          if (
            element.kind !== "unionCase" ||
            element.caseName !== statement.caseName
          ) {
            continue;
          }
          iterationValue = element.value;
        }
        const iterationValues = new Map(values);
        iterationValues.set(statement.value.text, iterationValue);
        if (statement.index !== undefined) {
          iterationValues.set(statement.index.text, {
            kind: "integer",
            value: index,
            span: statement.index.span,
          });
        }
        const iteration = expandStatements(
          statement.body.statements,
          iterationValues,
          true,
        );
        expanded.push(...iteration.statements);
        values = new Map(iteration.values);
        for (const name of scopedNames) {
          const shadowed = shadowedValues.get(name.text);
          if (shadowed === undefined) values.delete(name.text);
          else values.set(name.text, shadowed);
        }
        if (iteration.control === "break") break;
      }
      continue;
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
        expanded.push(substituteStatement(statement, values, false));
        if (statement.body.kind === "block") {
          for (const bodyStatement of statement.body.statements) {
            if (bodyStatement.kind === "assignment") {
              values.delete(bodyStatement.name.text);
            }
          }
        }
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
        const previousIteratorValue = statement.iterator === undefined
          ? undefined
          : values.get(statement.iterator.text);
        values = new Map(iteration.values);
        if (statement.iterator !== undefined) {
          if (previousIteratorValue !== undefined) {
            values.set(statement.iterator.text, previousIteratorValue);
          } else {
            values.delete(statement.iterator.text);
          }
        }
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
            values = new Map(branch.values);
            if (branch.control !== "next") {
              return {
                statements: expanded,
                control: branch.control,
                values,
              };
            }
            continue;
          }
        }
      }
      expanded.push({ ...statement, expression });
      continue;
    }
    const substituted = substituteStatement(statement, values, inLoop);
    if (
      substituted.kind === "binding" &&
      substituted.declarationKind === "const" &&
      isStaticTypeExpression(substituted.value)
    ) {
      values.set(substituted.name.text, substituted.value);
      continue;
    }
    if (
      substituted.kind === "binding" &&
      substituted.value.kind === "function" &&
      substituted.value.parameters.some((parameter) =>
        parameter.variadic || parameter.compileTimeRecord
      )
    ) {
      values.set(substituted.name.text, substituted.value);
      continue;
    }
    if (
      substituted.kind === "binding" &&
      substituted.value.kind !== "function"
    ) {
      const staticRecord = evaluateStaticValue(
        substituteExpression(substituted.value, values),
      );
      if (
        staticRecord?.kind === "record" &&
        staticRecord.nominalType === undefined &&
        staticRecord.fields.some((field) => field.value.kind === "function")
      ) {
        values.set(substituted.name.text, staticRecord);
        continue;
      }
    }
    expanded.push(substituted);
    if (substituted.kind === "binding" || substituted.kind === "assignment") {
      const staticValue = evaluateStaticValue(
        substituteExpression(substituted.value, values),
      );
      if (staticValue === undefined) {
        values.delete(substituted.name.text);
      } else {
        values.set(substituted.name.text, staticValue);
      }
    }
    if (statement.kind === "unionBinding") values.delete(statement.name.text);
    if (
      statement.kind === "import" &&
      statement.path === "duck:prelude/runtime"
    ) {
      for (const selection of statement.selections) {
        if (selection.localName === undefined) continue;
        values.set(selection.localName.text, {
          kind: "reference",
          name: {
            text: `$duck_runtime_${selection.exportName}`,
            span: selection.span,
          },
          span: selection.span,
        });
      }
    }
    if (statement.kind === "recursiveGroup") {
      for (const binding of statement.bindings) {
        values.delete(binding.name.text);
      }
    }
    if (statement.kind === "productBinding") {
      for (const name of statement.names) {
        if (name !== undefined) values.delete(name.text);
      }
    }
    if (statement.kind === "recordBinding") {
      for (const field of statement.fields) {
        values.delete(field.localName.text);
      }
    }
  }
  return { statements: expanded, control: "next", values };
}

function isStaticTypeExpression(expression: DucklangExpression): boolean {
  if (expression.kind === "reference") {
    return /^[A-Z]/.test(expression.name.text);
  }
  return expression.kind === "call" &&
    isStaticTypeExpression(expression.callee) &&
    expression.arguments.every(isStaticTypeExpression);
}

function substituteStatement(
  statement: DucklangStatement,
  values: ReadonlyMap<string, DucklangExpression>,
  replaceReferences = true,
): DucklangStatement {
  switch (statement.kind) {
    case "binding":
    case "assignment":
      return {
        ...statement,
        name: substituteDeclaredType(statement.name, values),
        value: substituteExpression(statement.value, values, replaceReferences),
      };
    case "unionBinding":
      return {
        ...statement,
        value: substituteExpression(statement.value, values, replaceReferences),
        alternative: substituteExpression(
          statement.alternative,
          values,
          replaceReferences,
        ),
      };
    case "recursiveGroup": {
      const groupValues = new Map(values);
      for (const binding of statement.bindings) {
        groupValues.delete(binding.name.text);
      }
      return {
        ...statement,
        bindings: statement.bindings.map((binding) => ({
          ...binding,
          value: substituteExpression(
            binding.value,
            groupValues,
            replaceReferences,
          ),
        })),
      };
    }
    case "productBinding":
    case "recordBinding":
      return {
        ...statement,
        value: substituteExpression(statement.value, values, replaceReferences),
      };
    case "typePattern":
      return {
        ...statement,
        target: substituteExpression(
          statement.target,
          values,
          replaceReferences,
        ),
      };
    case "return":
      return {
        ...statement,
        expression: substituteExpression(
          statement.expression,
          values,
          replaceReferences,
        ),
      };
    case "expression":
      return {
        ...statement,
        expression: substituteExpression(
          statement.expression,
          values,
          replaceReferences,
        ),
      };
    case "forRange":
      return {
        ...statement,
        start: substituteExpression(
          statement.start,
          values,
          replaceReferences,
        ),
        end: substituteExpression(statement.end, values, replaceReferences),
        step: statement.step === undefined
          ? undefined
          : substituteExpression(statement.step, values, replaceReferences),
        body: substituteExpression(statement.body, values, replaceReferences),
      };
    case "forCollection": {
      const bodyValues = new Map(values);
      bodyValues.delete(statement.value.text);
      if (statement.index !== undefined) {
        bodyValues.delete(statement.index.text);
      }
      return {
        ...statement,
        collection: substituteExpression(
          statement.collection,
          values,
          replaceReferences,
        ),
        body: substituteExpression(
          statement.body,
          bodyValues,
          replaceReferences,
        ),
      };
    }
    case "break":
      return {
        ...statement,
        value: statement.value === undefined
          ? undefined
          : substituteExpression(statement.value, values, replaceReferences),
      };
    case "continue":
    case "import":
    case "effectDeclaration":
    case "initDeclaration":
    case "structType":
    case "unionType":
    case "typeAlias":
      return statement;
  }
}

function substituteExpression(
  expression: DucklangExpression,
  values: ReadonlyMap<string, DucklangExpression>,
  replaceReferences = true,
): DucklangExpression {
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
      return expression;
    case "hostCall":
      return {
        ...expression,
        arguments: expression.arguments.map((argument) =>
          substituteExpression(argument, values, replaceReferences)
        ),
      };
    case "optionDo":
      return {
        ...expression,
        option: substituteExpression(
          expression.option,
          values,
          replaceReferences,
        ),
      };
    case "reference": {
      if (replaceReferences) {
        return values.get(expression.name.text) ?? expression;
      }
      const staticValue = values.get(expression.name.text);
      if (staticValue?.kind === "record") return staticValue;
      if (
        staticValue?.kind === "function" &&
        staticValue.parameters.some((parameter) =>
          parameter.variadic || parameter.compileTimeRecord
        )
      ) {
        return staticValue;
      }
      return expression;
    }
    case "function": {
      const functionValues = new Map(values);
      for (const parameter of expression.parameters) {
        functionValues.delete(parameter.text);
      }
      return {
        ...expression,
        parameters: expression.parameters.map((parameter) =>
          substituteDeclaredType(parameter, values)
        ),
        parameterTypeSources: expression.parameterTypeSources?.map((source) =>
          substituteExpression(source, values, replaceReferences)
        ),
        body: substituteExpression(
          expression.body,
          functionValues,
          replaceReferences,
        ),
      };
    }
    case "recursiveCall":
      return {
        ...expression,
        arguments: expression.arguments.map((argument) =>
          substituteExpression(argument, values, replaceReferences)
        ),
      };
    case "call": {
      const callee = substituteExpression(
        expression.callee,
        values,
        replaceReferences,
      );
      const arguments_ = expression.arguments.map((argument) =>
        substituteExpression(argument, values, replaceReferences)
      );
      if (callee.kind !== "function") {
        return { ...expression, callee, arguments: arguments_ };
      }
      const variadicIndex = callee.parameters.findIndex((parameter) =>
        parameter.variadic
      );
      const hasCompileTimeRecord = callee.parameters.some((parameter) =>
        parameter.compileTimeRecord
      );
      if (variadicIndex < 0 && !hasCompileTimeRecord) {
        return { ...expression, callee, arguments: arguments_ };
      }
      if (variadicIndex < 0 && arguments_.length !== callee.parameters.length) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: Ducklang specialized call expects ${callee.parameters.length} arguments; received ${arguments_.length}`,
        );
      }
      if (
        variadicIndex >= 0 && variadicIndex !== callee.parameters.length - 1
      ) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: Ducklang variadic parameter must be last`,
        );
      }
      if (variadicIndex >= 0 && arguments_.length < variadicIndex) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: Ducklang variadic call expects at least ${variadicIndex} arguments; received ${arguments_.length}`,
        );
      }
      const fixedParameterCount = variadicIndex < 0
        ? callee.parameters.length
        : variadicIndex;
      const parameterValues = new Map<string, DucklangExpression>();
      for (let index = 0; index < fixedParameterCount; index += 1) {
        const parameter = callee.parameters[index];
        const argument = parameter.compileTimeRecord
          ? substituteExpression(expression.arguments[index], values)
          : arguments_[index];
        parameterValues.set(
          parameter.text,
          parameter.identityPolymorphic && argument.kind === "reference"
            ? {
              ...argument,
              name: { ...argument.name, identityPolymorphic: true },
            }
            : argument,
        );
      }
      if (variadicIndex >= 0) {
        parameterValues.set(callee.parameters[variadicIndex].text, {
          kind: "product",
          productKind: "tuple",
          values: arguments_.slice(variadicIndex),
          span: expression.span,
        });
      }
      const body = substituteExpression(callee.body, parameterValues);
      const block = body.kind === "comptime" && body.expression.kind === "block"
        ? body.expression
        : body.kind === "block"
        ? body
        : undefined;
      if (block === undefined) return body;
      const expanded = expandStatements(block.statements, new Map(), false);
      if (expanded.control !== "next") {
        throw new SyntaxError(
          `${expression.span.file}:${expression.span.start}: Ducklang ${expanded.control} escapes variadic function specialization`,
        );
      }
      const expandedBlock: DucklangExpression = {
        ...block,
        statements: expanded.statements,
      };
      const resultStatement = expanded.statements.at(-1);
      const staticResult = resultStatement?.kind === "expression"
        ? evaluateStaticValue(
          substituteExpression(resultStatement.expression, expanded.values),
        )
        : undefined;
      if (staticResult !== undefined) return staticResult;
      if (body.kind !== "comptime") return expandedBlock;
      return {
        ...body,
        expression: expandedBlock,
      };
    }
    case "index":
      return {
        ...expression,
        collection: substituteExpression(
          expression.collection,
          values,
          replaceReferences,
        ),
        index: substituteExpression(
          expression.index,
          values,
          replaceReferences,
        ),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: substituteExpression(
          expression.product,
          values,
          replaceReferences,
        ),
        index: substituteExpression(
          expression.index,
          values,
          replaceReferences,
        ),
        value: substituteExpression(
          expression.value,
          values,
          replaceReferences,
        ),
      };
    case "unionCase":
      return {
        ...expression,
        value: substituteExpression(
          expression.value,
          values,
          replaceReferences,
        ),
      };
    case "product":
      return {
        ...expression,
        values: expression.values.map((value) =>
          substituteExpression(value, values, replaceReferences)
        ),
      };
    case "field": {
      const product = substituteExpression(
        expression.product,
        values,
        replaceReferences,
      );
      if (product.kind === "record") {
        const field = product.fields.find((candidate) =>
          candidate.name === expression.fieldName
        );
        if (field !== undefined) return field.value;
      }
      return { ...expression, product };
    }
    case "recordUpdate":
      return {
        ...expression,
        product: substituteExpression(
          expression.product,
          values,
          replaceReferences,
        ),
        fields: expression.fields.map((field) => ({
          ...field,
          value: substituteExpression(
            field.value,
            values,
            replaceReferences,
          ),
        })),
      };
    case "record":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: substituteExpression(
            field.value,
            values,
            replaceReferences,
          ),
        })),
      };
    case "binary":
      return {
        ...expression,
        left: substituteExpression(expression.left, values, replaceReferences),
        right: substituteExpression(
          expression.right,
          values,
          replaceReferences,
        ),
      };
    case "unary":
      return {
        ...expression,
        operand: substituteExpression(
          expression.operand,
          values,
          replaceReferences,
        ),
      };
    case "if":
      return {
        ...expression,
        condition: substituteExpression(
          expression.condition,
          values,
          replaceReferences,
        ),
        consequence: substituteExpression(
          expression.consequence,
          values,
          replaceReferences,
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : substituteExpression(
            expression.alternative,
            values,
            replaceReferences,
          ),
      };
    case "ifUnion": {
      const consequenceValues = new Map(values);
      if (expression.payloadName !== undefined) {
        consequenceValues.delete(expression.payloadName.text);
      }
      return {
        ...expression,
        value: substituteExpression(
          expression.value,
          values,
          replaceReferences,
        ),
        consequence: substituteExpression(
          expression.consequence,
          consequenceValues,
          replaceReferences,
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : substituteExpression(
            expression.alternative,
            values,
            replaceReferences,
          ),
      };
    }
    case "block": {
      const statements = substituteStatementList(
        expression.statements,
        values,
        replaceReferences,
      );
      return {
        ...expression,
        statements: statements.filter((statement, index) =>
          index === statements.length - 1 || statement.kind !== "expression" ||
          statement.expression.kind !== "field"
        ),
      };
    }
    case "comptime":
      return {
        ...expression,
        expression: substituteExpression(
          expression.expression,
          values,
          replaceReferences,
        ),
      };
    case "scratch":
      return {
        ...expression,
        body: substituteExpression(expression.body, values, replaceReferences),
      };
    case "loop": {
      if (expression.body.kind !== "block") {
        return {
          ...expression,
          body: substituteExpression(
            expression.body,
            values,
            replaceReferences,
          ),
        };
      }
      const breakValue = evaluateLoopBreak(expression.body.statements, values);
      return breakValue ?? {
        ...expression,
        body: substituteExpression(expression.body, values, replaceReferences),
      };
    }
  }
}

function substituteDeclaredType(
  name: DucklangName,
  values: ReadonlyMap<string, DucklangExpression>,
): DucklangName {
  if (name.declaredType === undefined) return name;
  return {
    ...name,
    declaredType: substituteDeclaredTypeReference(name.declaredType, values),
  };
}

function substituteDeclaredTypeReference(
  reference: DucklangTypeReference,
  values: ReadonlyMap<string, DucklangExpression>,
): DucklangTypeReference {
  const staticName = reference.arguments.length === 0
    ? staticTypeName(values.get(reference.name))
    : undefined;
  if (staticName !== undefined) {
    return ducklangNamedType(staticName, reference.span);
  }
  return {
    ...reference,
    arguments: reference.arguments.map((argument) =>
      substituteDeclaredTypeReference(argument, values)
    ),
  };
}

function staticTypeName(
  expression: DucklangExpression | undefined,
): string | undefined {
  if (expression?.kind === "reference" && /^[A-Z]/.test(expression.name.text)) {
    return expression.name.text;
  }
  if (
    expression?.kind === "call" && expression.callee.kind === "reference" &&
    /^[A-Z]/.test(expression.callee.name.text)
  ) {
    return expression.callee.name.text;
  }
  return undefined;
}

function evaluateLoopBreak(
  statements: readonly DucklangStatement[],
  values: ReadonlyMap<string, DucklangExpression>,
): DucklangExpression | undefined {
  for (const statement of statements) {
    if (statement.kind === "break") {
      return statement.value === undefined
        ? { kind: "unit", span: statement.span }
        : substituteExpression(statement.value, values);
    }
    if (statement.kind !== "expression") return undefined;
    const expression = substituteExpression(statement.expression, values);
    if (expression.kind !== "if") return undefined;
    const condition = evaluateStaticBoolean(expression.condition);
    if (condition === undefined) return undefined;
    const selected = condition
      ? expression.consequence
      : expression.alternative;
    if (selected === undefined) continue;
    if (selected.kind !== "block") return undefined;
    return evaluateLoopBreak(selected.statements, values);
  }
  return undefined;
}

function substituteStatementList(
  statements: readonly DucklangStatement[],
  initialValues: ReadonlyMap<string, DucklangExpression>,
  replaceReferences: boolean,
): readonly DucklangStatement[] {
  const values = new Map(initialValues);
  return statements.map((statement) => {
    const substituted = substituteStatement(
      statement,
      values,
      replaceReferences,
    );
    if (
      statement.kind === "binding" || statement.kind === "assignment" ||
      statement.kind === "unionBinding"
    ) {
      values.delete(statement.name.text);
    }
    if (statement.kind === "recursiveGroup") {
      for (const binding of statement.bindings) {
        values.delete(binding.name.text);
      }
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

function evaluateStaticValue(
  expression: DucklangExpression,
): DucklangExpression | undefined {
  if (expression.kind === "comptime") {
    return evaluateStaticValue(expression.expression);
  }
  const integer = evaluateStaticInteger(expression);
  if (integer !== undefined) {
    return { kind: "integer", value: integer, span: expression.span };
  }
  const boolean = evaluateStaticBoolean(expression);
  if (boolean !== undefined) {
    return { kind: "boolean", value: boolean, span: expression.span };
  }
  if (expression.kind === "string" || expression.kind === "unit") {
    return expression;
  }
  if (expression.kind === "function") return expression;
  if (
    expression.kind === "call" && expression.callee.kind === "reference" &&
    expression.callee.name.text.startsWith("$duck_runtime_")
  ) {
    const arguments_: DucklangExpression[] = [];
    for (const argument of expression.arguments) {
      const evaluated = evaluateStaticValue(argument);
      if (evaluated === undefined) return undefined;
      arguments_.push(evaluated);
    }
    const operation = expression.callee.name.text.slice(
      "$duck_runtime_".length,
    );
    if (
      operation === "length" && arguments_.length === 1 &&
      arguments_[0].kind === "string"
    ) {
      return {
        kind: "integer",
        value: new TextEncoder().encode(arguments_[0].value).length,
        span: expression.span,
      };
    }
    if (
      operation === "append" && arguments_.length === 2 &&
      arguments_[0].kind === "string" && arguments_[1].kind === "string"
    ) {
      return {
        kind: "string",
        value: arguments_[0].value + arguments_[1].value,
        span: expression.span,
      };
    }
    if (
      operation === "slice" && arguments_.length === 3 &&
      arguments_[0].kind === "string" && arguments_[1].kind === "integer" &&
      arguments_[2].kind === "integer"
    ) {
      const bytes = new TextEncoder().encode(arguments_[0].value);
      const start = arguments_[1].value;
      const end = arguments_[2].value;
      if (start < 0 || end < start || end > bytes.length) {
        throw new RangeError(
          `${expression.span.file}:${expression.span.start}: Ducklang static slice range ${start}..${end} is outside text byte length ${bytes.length}`,
        );
      }
      try {
        return {
          kind: "string",
          value: new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(start, end),
          ),
          span: expression.span,
        };
      } catch (cause) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: Ducklang static slice ${start}..${end} splits a UTF-8 sequence`,
          { cause },
        );
      }
    }
  }
  if (expression.kind === "product") {
    const values: DucklangExpression[] = [];
    for (const value of expression.values) {
      const evaluated = evaluateStaticValue(value);
      if (evaluated === undefined) return undefined;
      values.push(evaluated);
    }
    return { ...expression, values };
  }
  if (expression.kind === "record") {
    const fields = [];
    for (const field of expression.fields) {
      const value = evaluateStaticValue(field.value);
      if (value === undefined) return undefined;
      fields.push({ ...field, value });
    }
    return { ...expression, fields };
  }
  if (expression.kind === "recordUpdate") {
    const product = evaluateStaticValue(expression.product);
    if (
      product?.kind !== "record" &&
      !(product?.kind === "integer" && product.value === 0)
    ) {
      return undefined;
    }
    const fields = product.kind === "record" ? [...product.fields] : [];
    for (const update of expression.fields) {
      const value = evaluateStaticValue(update.value);
      if (value === undefined) return undefined;
      const index = fields.findIndex((field) => field.name === update.name);
      if (index < 0) fields.push({ ...update, value });
      else fields[index] = { ...update, value };
    }
    return {
      kind: "record",
      fields,
      span: expression.span,
    };
  }
  if (expression.kind === "unionCase") {
    const value = evaluateStaticValue(expression.value);
    return value === undefined ? undefined : { ...expression, value };
  }
  return undefined;
}

function staticCollectionElements(
  collection: DucklangExpression | undefined,
): readonly DucklangExpression[] | undefined {
  if (collection?.kind === "product") {
    return collection.values;
  }
  if (collection?.kind !== "string") return undefined;
  return [...new TextEncoder().encode(collection.value)].map((value) => ({
    kind: "integer",
    value,
    span: collection.span,
  }));
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

import {
  type DucklangExpression,
  type DucklangModule,
  type DucklangName,
  ducklangNamedType,
  type DucklangStatement,
} from "./ducklang_ast.ts";

export function lowerDucklangControlFlow(
  module: DucklangModule,
): DucklangModule {
  return { ...module, statements: lowerStatements(module.statements) };
}

/**
 * Rejects a loop that mixes a valued `break` with a bare one.
 *
 * A loop whose value is taken must supply one on every exit. Mixing left the bare
 * path fabricating an `i32` zero: a loop yielding 7 on its valued exit returned 0
 * through the bare one, and a `Text`-yielding loop passed that zero on as a buffer
 * handle, failing at runtime with "unknown handle 0" instead of being diagnosed.
 *
 * This walks the whole module rather than hooking one lowering site, because a
 * loop reaches lowering by several paths depending on whether it appears as a
 * statement or as a binding's value. It must also run before static loop
 * expansion, which folds a constant-conditioned loop away and produced the zero
 * before any later pass could object.
 */
export function requireConsistentDucklangLoopExits(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    if (node.kind === "loop") {
      const body = node.body as DucklangExpression;
      if (
        hasValuedBreakTargetingLoop(body) && hasBareBreakTargetingLoop(body)
      ) {
        const span = node.span as
          | { readonly file: string; readonly start: number }
          | undefined;
        throw new TypeError(
          `${span?.file ?? "?"}:${
            span?.start ?? 0
          }: Ducklang loop mixes a valued break with a bare break`,
        );
      }
    }
    pending.push(...Object.values(node));
  }
}

function lowerStatements(
  statements: readonly DucklangStatement[],
): readonly DucklangStatement[] {
  const result: DucklangStatement[] = [];
  for (const [index, statement] of statements.entries()) {
    if (
      statement.kind === "expression" &&
      (statement.expression.kind === "if" ||
        statement.expression.kind === "ifUnion") &&
      !containsLoopControl(statement.expression) &&
      collectBranchAssignments(statement.expression).size > 0 &&
      index + 1 < statements.length
    ) {
      const remaining = statements.slice(index + 1);
      result.push({
        kind: "expression",
        expression: lowerExpression({
          ...statement.expression,
          consequence: appendBranchContinuation(
            statement.expression.consequence,
            remaining,
            statement.expression.span,
          ),
          alternative: appendBranchContinuation(
            statement.expression.alternative,
            remaining,
            statement.expression.span,
          ),
        }),
        span: statement.span,
      });
      return result;
    }
    const lowered = lowerStatementExpressions(statement);
    if (lowered.kind === "forRange") {
      const range = lowerDynamicRange(
        lowered,
        visibleBindingNames(result),
      );
      result.push(...(range ?? [lowered]));
      continue;
    }
    if (lowered.kind === "forCollection") {
      const collection = lowerIndexedBufferLoop(
        lowered,
        visibleBindingNames(result),
      );
      result.push(...(collection ?? [lowered]));
      continue;
    }
    if (lowered.kind === "expression" && lowered.expression.kind === "loop") {
      const remaining = lowerStatements(statements.slice(index + 1));
      const continuation: DucklangExpression = remaining.length === 0
        ? { kind: "unit", span: lowered.span }
        : {
          kind: "block",
          statements: remaining,
          span: {
            file: remaining[0].span.file,
            start: remaining[0].span.start,
            end: remaining[remaining.length - 1].span.end,
          },
        };
      result.push(
        ...lowerDynamicLoop(
          lowered.expression,
          continuation,
          visibleBindingNames(result),
          remaining.length === 0 &&
            hasValuedBreakTargetingLoop(lowered.expression.body),
        ),
      );
      return result;
    }
    if (
      lowered.kind !== "expression" ||
      (lowered.expression.kind !== "if" &&
        lowered.expression.kind !== "ifUnion")
    ) {
      result.push(lowered);
      continue;
    }
    if (containsLoopControl(lowered.expression)) {
      result.push(lowered);
      continue;
    }
    const assignments = collectBranchAssignments(lowered.expression);
    const [name] = assignments.values();
    const value = name === undefined
      ? undefined
      : lowerAssignmentCondition(lowered.expression, name);
    if (
      assignments.size > 0 && index + 1 < statements.length
    ) {
      const remaining = statements.slice(index + 1);
      result.push({
        kind: "expression",
        expression: lowerExpression({
          ...lowered.expression,
          consequence: appendBranchContinuation(
            lowered.expression.consequence,
            remaining,
            lowered.expression.span,
          ),
          alternative: appendBranchContinuation(
            lowered.expression.alternative,
            remaining,
            lowered.expression.span,
          ),
        }),
        span: lowered.span,
      });
      return result;
    }
    if (name === undefined || value === undefined) {
      result.push(lowered);
      continue;
    }
    result.push({
      kind: "assignment",
      operator: "=",
      name,
      value,
      span: lowered.span,
    });
  }
  return result;
}

function appendBranchContinuation(
  branch: DucklangExpression | undefined,
  remaining: readonly DucklangStatement[],
  fallbackSpan: DucklangExpression["span"],
): DucklangExpression {
  if (branch?.kind === "block") {
    return { ...branch, statements: [...branch.statements, ...remaining] };
  }
  return {
    kind: "block",
    statements: [
      ...(branch === undefined ? [] : [{
        kind: "expression" as const,
        expression: branch,
        span: branch.span,
      }]),
      ...remaining,
    ],
    span: branch?.span ?? fallbackSpan,
  };
}

function containsLoopControl(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    if (node.kind === "break" || node.kind === "continue") return true;
    pending.push(...Object.values(node));
  }
  return false;
}

/**
 * Whether a bare `break` targets this loop, ignoring nested loops and functions.
 *
 * Mirrors hasValuedBreakTargetingLoop so the two can be compared: a loop whose
 * value is taken must supply one on every exit, and a bare break supplies none.
 */
function hasBareBreakTargetingLoop(body: DucklangExpression): boolean {
  const pending: unknown[] = [body];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    if (node.kind === "break") {
      if (node.value === undefined) return true;
      continue;
    }
    if (
      node !== body &&
      (node.kind === "loop" ||
        node.kind === "forRange" ||
        node.kind === "forCollection" ||
        node.kind === "function")
    ) {
      continue;
    }
    pending.push(...Object.values(node));
  }
  return false;
}

function hasValuedBreakTargetingLoop(body: DucklangExpression): boolean {
  const pending: unknown[] = [body];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    if (node.kind === "break") {
      if (node.value !== undefined) return true;
      continue;
    }
    if (
      node !== body &&
      (node.kind === "loop" ||
        node.kind === "forRange" ||
        node.kind === "forCollection" ||
        node.kind === "function")
    ) {
      continue;
    }
    pending.push(...Object.values(node));
  }
  return false;
}

type LoopLoweringContext = {
  readonly functionName: DucklangName;
  readonly carriedBindings: readonly DucklangName[];
  readonly breakContinuation: DucklangExpression;
  readonly breakValueIsResult: boolean;
  readonly recursiveArguments: readonly DucklangExpression[];
  readonly span: DucklangExpression["span"];
};

function lowerDynamicLoop(
  loop: Extract<DucklangExpression, { readonly kind: "loop" }>,
  breakContinuation: DucklangExpression,
  visibleBindings: ReadonlyMap<string, DucklangName>,
  breakValueIsResult = false,
): readonly DucklangStatement[] {
  if (loop.body.kind !== "block") {
    throw new TypeError(
      `${loop.span.file}:${loop.span.start}: Ducklang loop body must be a block`,
    );
  }
  const carriedBindings = collectLoopCarriedBindings(loop.body).map((
    binding,
  ) => preserveBindingType(binding, visibleBindings.get(binding.text)));
  const functionName: DucklangName = {
    text: `$loop_${loop.span.start}`,
    span: loop.span,
  };
  const context = {
    functionName,
    carriedBindings,
    breakContinuation,
    breakValueIsResult,
    recursiveArguments: carriedBindings.map(bindingReference),
    span: loop.span,
  } satisfies LoopLoweringContext;
  const recursiveCall = loopRecursiveCall(context);
  const functionBinding: DucklangStatement = {
    kind: "binding",
    declarationKind: "let",
    recursive: true,
    name: functionName,
    value: {
      kind: "function",
      recursive: true,
      parameters: carriedBindings,
      parameterTypeSources: carriedBindings.map(bindingReference),
      body: lowerLoopStatementSequence(
        loop.body.statements,
        recursiveCall,
        context,
      ),
      span: loop.span,
    },
    span: loop.span,
  };
  const initialCall: DucklangExpression = {
    kind: "call",
    callee: {
      kind: "reference",
      name: functionName,
      span: functionName.span,
    },
    arguments: carriedBindings.map(bindingReference),
    span: loop.span,
  };
  return [
    functionBinding,
    {
      kind: "expression",
      expression: initialCall,
      span: loop.span,
    },
  ];
}

function visibleBindingNames(
  statements: readonly DucklangStatement[],
): ReadonlyMap<string, DucklangName> {
  const bindings = new Map<string, DucklangName>();
  for (const statement of statements) {
    if (statement.kind === "binding" || statement.kind === "unionBinding") {
      bindings.set(statement.name.text, statement.name);
      continue;
    }
    if (statement.kind === "recursiveGroup") {
      for (const binding of statement.bindings) {
        bindings.set(binding.name.text, binding.name);
      }
      continue;
    }
    if (statement.kind === "productBinding") {
      for (const name of statement.names) {
        if (name !== undefined) bindings.set(name.text, name);
      }
      continue;
    }
    if (statement.kind === "recordBinding") {
      for (const field of statement.fields) {
        bindings.set(field.localName.text, field.localName);
      }
    }
  }
  return bindings;
}

function preserveBindingType(
  binding: DucklangName,
  declaration: DucklangName | undefined,
): DucklangName {
  if (declaration?.declaredType === undefined) return binding;
  return {
    ...binding,
    declaredType: declaration.declaredType,
  };
}

function lowerLoopStatementSequence(
  statements: readonly DucklangStatement[],
  continuation: DucklangExpression,
  context: LoopLoweringContext,
): DucklangExpression {
  const [statement, ...remaining] = statements;
  if (statement === undefined) return continuation;
  if (statement.kind === "break") {
    if (statement.value !== undefined && context.breakValueIsResult) {
      return lowerExpression(statement.value);
    }
    return context.breakContinuation;
  }
  if (statement.kind === "continue") return loopRecursiveCall(context);
  if (statement.kind === "return") {
    throw new TypeError(
      `${statement.span.file}:${statement.span.start}: Ducklang return cannot cross a lowered loop function`,
    );
  }
  const remainingExpression = lowerLoopStatementSequence(
    remaining,
    continuation,
    context,
  );
  if (statement.kind === "expression" && statement.expression.kind === "loop") {
    const lowered = lowerDynamicLoop(
      statement.expression,
      remainingExpression,
      new Map(),
      false,
    );
    return {
      kind: "block",
      statements: lowered,
      span: statement.expression.span,
    };
  }
  if (
    statement.kind === "unionBinding" &&
    containsLoopControl(statement.alternative)
  ) {
    return {
      kind: "ifUnion",
      caseName: statement.caseName,
      payloadName: statement.name,
      value: statement.value,
      consequence: remainingExpression,
      alternative: appendLoopContinuation(
        statement.alternative,
        remainingExpression,
        context,
      ),
      span: statement.span,
    };
  }
  if (statement.kind === "expression") {
    return appendLoopContinuation(
      statement.expression,
      remainingExpression,
      context,
    );
  }
  if (statement.kind === "forCollection") {
    const lowered = lowerIndexedBufferLoop(statement, new Map());
    if (lowered !== undefined) {
      return lowerLoopStatementSequence(
        [...lowered, ...remaining],
        continuation,
        context,
      );
    }
  }
  if (statement.kind === "forRange") {
    const lowered = lowerDynamicRange(statement, new Map());
    if (lowered !== undefined) {
      return lowerLoopStatementSequence(
        [...lowered, ...remaining],
        continuation,
        context,
      );
    }
  }
  if (statement.kind === "forRange" || statement.kind === "forCollection") {
    throw new TypeError(
      `${statement.span.file}:${statement.span.start}: nested dynamic Ducklang ${statement.kind} requires loop IR lowering`,
    );
  }
  return {
    kind: "block",
    statements: [
      lowerStatementExpressions(statement),
      {
        kind: "expression",
        expression: remainingExpression,
        span: remainingExpression.span,
      },
    ],
    span: {
      file: statement.span.file,
      start: statement.span.start,
      end: remainingExpression.span.end,
    },
  };
}

function appendLoopContinuation(
  expression: DucklangExpression,
  continuation: DucklangExpression,
  context: LoopLoweringContext,
): DucklangExpression {
  if (expression.kind === "block") {
    return {
      ...expression,
      statements: [{
        kind: "expression",
        expression: lowerLoopStatementSequence(
          expression.statements,
          continuation,
          context,
        ),
        span: expression.span,
      }],
    };
  }
  if (expression.kind === "if") {
    return {
      ...expression,
      consequence: appendLoopContinuation(
        expression.consequence,
        continuation,
        context,
      ),
      alternative: expression.alternative === undefined
        ? continuation
        : appendLoopContinuation(
          expression.alternative,
          continuation,
          context,
        ),
    };
  }
  if (expression.kind === "ifUnion") {
    return {
      ...expression,
      consequence: appendLoopContinuation(
        expression.consequence,
        continuation,
        context,
      ),
      alternative: expression.alternative === undefined
        ? continuation
        : appendLoopContinuation(
          expression.alternative,
          continuation,
          context,
        ),
    };
  }
  return {
    kind: "block",
    statements: [
      { kind: "expression", expression, span: expression.span },
      {
        kind: "expression",
        expression: continuation,
        span: continuation.span,
      },
    ],
    span: {
      file: expression.span.file,
      start: expression.span.start,
      end: continuation.span.end,
    },
  };
}

function loopRecursiveCall(
  context: LoopLoweringContext,
): DucklangExpression {
  return {
    kind: "call",
    callee: {
      kind: "reference",
      name: context.functionName,
      span: context.functionName.span,
    },
    arguments: context.recursiveArguments,
    span: context.span,
  };
}

function bindingReference(name: DucklangName): DucklangExpression {
  return { kind: "reference", name, span: name.span };
}

function collectLoopCarriedBindings(
  body: DucklangExpression,
): readonly DucklangName[] {
  const carriedBindings = new Map<string, DucklangName>();
  collectExpressionRebindings(body, new Set(), carriedBindings);
  return [...carriedBindings.values()];
}

function collectStatementRebindings(
  statements: readonly DucklangStatement[],
  localBindings: Set<string>,
  carriedBindings: Map<string, DucklangName>,
): void {
  for (const statement of statements) {
    switch (statement.kind) {
      case "binding":
        collectExpressionRebindings(
          statement.value,
          localBindings,
          carriedBindings,
        );
        localBindings.add(statement.name.text);
        break;
      case "unionBinding":
        collectExpressionRebindings(
          statement.value,
          localBindings,
          carriedBindings,
        );
        collectExpressionRebindings(
          statement.alternative,
          localBindings,
          carriedBindings,
        );
        localBindings.add(statement.name.text);
        break;
      case "recursiveGroup":
        for (const binding of statement.bindings) {
          localBindings.add(binding.name.text);
        }
        for (const binding of statement.bindings) {
          collectExpressionRebindings(
            binding.value,
            localBindings,
            carriedBindings,
          );
        }
        break;
      case "productBinding":
        collectExpressionRebindings(
          statement.value,
          localBindings,
          carriedBindings,
        );
        for (const name of statement.names) {
          if (name !== undefined) localBindings.add(name.text);
        }
        break;
      case "recordBinding":
        collectExpressionRebindings(
          statement.value,
          localBindings,
          carriedBindings,
        );
        for (const field of statement.fields) {
          localBindings.add(field.localName.text);
        }
        break;
      case "assignment":
        collectExpressionRebindings(
          statement.value,
          localBindings,
          carriedBindings,
        );
        if (!localBindings.has(statement.name.text)) {
          carriedBindings.set(statement.name.text, statement.name);
        }
        break;
      case "forRange": {
        collectExpressionRebindings(
          statement.start,
          localBindings,
          carriedBindings,
        );
        collectExpressionRebindings(
          statement.end,
          localBindings,
          carriedBindings,
        );
        if (statement.step !== undefined) {
          collectExpressionRebindings(
            statement.step,
            localBindings,
            carriedBindings,
          );
        }
        const rangeBindings = new Set(localBindings);
        if (statement.iterator !== undefined) {
          rangeBindings.add(statement.iterator.text);
        }
        collectExpressionRebindings(
          statement.body,
          rangeBindings,
          carriedBindings,
        );
        break;
      }
      case "forCollection": {
        collectExpressionRebindings(
          statement.collection,
          localBindings,
          carriedBindings,
        );
        const collectionBindings = new Set(localBindings);
        collectionBindings.add(statement.value.text);
        if (statement.index !== undefined) {
          collectionBindings.add(statement.index.text);
        }
        collectExpressionRebindings(
          statement.body,
          collectionBindings,
          carriedBindings,
        );
        break;
      }
      case "break":
        if (statement.value !== undefined) {
          collectExpressionRebindings(
            statement.value,
            localBindings,
            carriedBindings,
          );
        }
        break;
      case "return":
      case "expression":
        collectExpressionRebindings(
          statement.expression,
          localBindings,
          carriedBindings,
        );
        break;
      case "typePattern":
        collectExpressionRebindings(
          statement.target,
          localBindings,
          carriedBindings,
        );
        break;
      case "effectDeclaration":
      case "initDeclaration":
      case "structType":
      case "unionType":
      case "typeAlias":
      case "import":
      case "continue":
        break;
    }
  }
}

function collectExpressionRebindings(
  expression: DucklangExpression,
  localBindings: Set<string>,
  carriedBindings: Map<string, DucklangName>,
): void {
  const collect = (child: DucklangExpression) =>
    collectExpressionRebindings(child, localBindings, carriedBindings);
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
    case "reference":
      return;
    case "hostCall":
      expression.arguments.forEach(collect);
      return;
    case "optionDo":
      collect(expression.option);
      return;
    case "unionCase":
      collect(expression.value);
      return;
    case "product":
      expression.values.forEach(collect);
      return;
    case "field":
      collect(expression.product);
      return;
    case "recordUpdate":
      collect(expression.product);
      expression.fields.forEach((field) => collect(field.value));
      return;
    case "record":
      expression.fields.forEach((field) => collect(field.value));
      return;
    case "function":
      return;
    case "recursiveCall":
      expression.arguments.forEach(collect);
      return;
    case "call":
      collect(expression.callee);
      expression.arguments.forEach(collect);
      return;
    case "index":
      collect(expression.collection);
      collect(expression.index);
      return;
    case "indexUpdate":
      collect(expression.product);
      collect(expression.index);
      collect(expression.value);
      return;
    case "binary":
      collect(expression.left);
      collect(expression.right);
      return;
    case "unary":
      collect(expression.operand);
      return;
    case "if":
      collect(expression.condition);
      collectExpressionRebindings(
        expression.consequence,
        new Set(localBindings),
        carriedBindings,
      );
      if (expression.alternative !== undefined) {
        collectExpressionRebindings(
          expression.alternative,
          new Set(localBindings),
          carriedBindings,
        );
      }
      return;
    case "ifUnion": {
      collect(expression.value);
      const consequenceBindings = new Set(localBindings);
      if (expression.payloadName !== undefined) {
        consequenceBindings.add(expression.payloadName.text);
      }
      collectExpressionRebindings(
        expression.consequence,
        consequenceBindings,
        carriedBindings,
      );
      if (expression.alternative !== undefined) {
        collectExpressionRebindings(
          expression.alternative,
          new Set(localBindings),
          carriedBindings,
        );
      }
      return;
    }
    case "block":
      collectStatementRebindings(
        expression.statements,
        new Set(localBindings),
        carriedBindings,
      );
      return;
    case "comptime":
      collect(expression.expression);
      return;
    case "scratch":
    case "loop":
      collect(expression.body);
      return;
  }
}

function lowerDynamicRange(
  statement: Extract<DucklangStatement, { readonly kind: "forRange" }>,
  visibleBindings: ReadonlyMap<string, DucklangName>,
): readonly DucklangStatement[] | undefined {
  if (statement.body.kind !== "block") {
    return undefined;
  }
  const iterator = statement.iterator ?? {
    text: `$range_index_${statement.span.start}`,
    span: statement.span,
  };
  const carriedBindings = collectLoopCarriedBindings(statement.body)
    .filter((binding) => binding.text !== iterator.text)
    .map((binding) =>
      preserveBindingType(binding, visibleBindings.get(binding.text))
    );
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
  if (staticStep === 0) return undefined;
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
  const boundaryCondition = (
    comparisonOperator: "<" | ">",
  ): DucklangExpression => {
    const comparison: DucklangExpression = {
      kind: "binary",
      operator: comparisonOperator,
      left: {
        kind: "reference",
        name: iterator,
        span: iterator.span,
      },
      right: {
        kind: "reference",
        name: endParameter,
        span: endParameter.span,
      },
      span: statement.span,
    };
    return statement.inclusive
      ? {
        kind: "unary",
        operator: "!",
        operand: comparison,
        span: statement.span,
      }
      : comparison;
  };
  const positiveCondition = boundaryCondition(statement.inclusive ? ">" : "<");
  const negativeCondition = boundaryCondition(statement.inclusive ? "<" : ">");
  const condition: DucklangExpression = staticStep === undefined
    ? {
      kind: "if",
      condition: {
        kind: "binary",
        operator: ">",
        left: {
          kind: "reference",
          name: stepParameter,
          span: stepParameter.span,
        },
        right: { kind: "integer", value: 0, span: step.span },
        span: statement.span,
      },
      consequence: positiveCondition,
      alternative: negativeCondition,
      span: statement.span,
    }
    : staticStep > 0
    ? positiveCondition
    : negativeCondition;
  const nextIndex: DucklangExpression = {
    kind: "binary",
    operator: "+",
    left: {
      kind: "reference",
      name: iterator,
      span: iterator.span,
    },
    right: {
      kind: "reference",
      name: stepParameter,
      span: stepParameter.span,
    },
    span: statement.span,
  };
  const carriedResult: DucklangExpression = carriedBindings.length === 0
    ? { kind: "unit", span: statement.span }
    : carriedBindings.length === 1
    ? bindingReference(carriedBindings[0])
    : {
      kind: "product",
      productKind: "tuple",
      values: carriedBindings.map(bindingReference),
      span: statement.span,
    };
  const context = {
    functionName,
    carriedBindings,
    breakContinuation: carriedResult,
    breakValueIsResult: false,
    recursiveArguments: [
      nextIndex,
      bindingReference(endParameter),
      bindingReference(stepParameter),
      ...carriedBindings.map(bindingReference),
    ],
    span: statement.span,
  } satisfies LoopLoweringContext;
  const loopFunction: DucklangStatement = {
    kind: "binding",
    declarationKind: "let",
    recursive: true,
    name: functionName,
    value: {
      kind: "function",
      recursive: true,
      parameters: [
        iterator,
        endParameter,
        stepParameter,
        ...carriedBindings,
      ],
      parameterTypeSources: [
        statement.start,
        statement.end,
        step,
        ...carriedBindings.map(bindingReference),
      ],
      body: {
        kind: "if",
        condition,
        consequence: lowerLoopStatementSequence(
          statement.body.statements,
          loopRecursiveCall(context),
          context,
        ),
        alternative: carriedResult,
        span: statement.span,
      },
      span: statement.span,
    },
    span: statement.span,
  };
  const initialCall: DucklangExpression = {
    kind: "if",
    condition: {
      kind: "binary",
      operator: "==",
      left: step,
      right: { kind: "integer", value: 0, span: step.span },
      span: statement.span,
    },
    consequence: {
      kind: "call",
      callee: {
        kind: "reference",
        name: { text: "$duck_panic", span: statement.span },
        span: statement.span,
      },
      arguments: [{
        kind: "string",
        value: "Ducklang range step cannot be zero",
        span: statement.span,
      }],
      span: statement.span,
    },
    alternative: {
      kind: "call",
      callee: {
        kind: "reference",
        name: functionName,
        span: functionName.span,
      },
      arguments: [
        statement.start,
        statement.end,
        step,
        ...carriedBindings.map(bindingReference),
      ],
      span: statement.span,
    },
    span: statement.span,
  };
  const resultStatement: DucklangStatement = carriedBindings.length === 0
    ? {
      kind: "expression",
      expression: initialCall,
      span: statement.span,
    }
    : carriedBindings.length === 1
    ? {
      kind: "assignment",
      operator: "=",
      name: carriedBindings[0],
      value: initialCall,
      span: statement.span,
    }
    : {
      kind: "productBinding",
      declarationKind: "let",
      productKind: "tuple",
      names: carriedBindings,
      value: initialCall,
      span: statement.span,
    };
  return [loopFunction, resultStatement];
}

function lowerIndexedBufferLoop(
  statement: Extract<DucklangStatement, { readonly kind: "forCollection" }>,
  visibleBindings: ReadonlyMap<string, DucklangName>,
): readonly DucklangStatement[] | undefined {
  if (
    statement.body.kind !== "block" || statement.caseName !== undefined ||
    statement.collection.kind !== "reference"
  ) {
    return undefined;
  }
  const collectionType = statement.collection.name.declaredType;
  if (
    collectionType?.name !== "Bytes" && collectionType?.name !== "Text"
  ) {
    return undefined;
  }
  const collectionName: DucklangName = {
    text: `$collection_${statement.span.start}`,
    declaredType: collectionType,
    span: statement.collection.span,
  };
  const indexName: DucklangName = statement.index ?? {
    text: `$collection_index_${statement.span.start}`,
    declaredType: ducklangNamedType("I32", statement.span),
    span: statement.span,
  };
  const collectionReference: DucklangExpression = {
    kind: "reference",
    name: collectionName,
    span: collectionName.span,
  };
  const indexReference: DucklangExpression = {
    kind: "reference",
    name: indexName,
    span: indexName.span,
  };
  const body: DucklangExpression = {
    ...statement.body,
    statements: [
      {
        kind: "binding",
        declarationKind: "let",
        recursive: false,
        name: {
          ...statement.value,
          declaredType: ducklangNamedType("I32", statement.value.span),
        },
        value: {
          kind: "call",
          callee: {
            kind: "reference",
            name: { text: "@get", span: statement.span },
            span: statement.span,
          },
          arguments: [collectionReference, indexReference],
          span: statement.span,
        },
        span: statement.span,
      },
      ...statement.body.statements,
    ],
  };
  const range: Extract<DucklangStatement, { readonly kind: "forRange" }> = {
    kind: "forRange",
    iterator: indexName,
    start: { kind: "integer", value: 0, span: statement.span },
    end: {
      kind: "call",
      callee: {
        kind: "reference",
        name: { text: "@len", span: statement.span },
        span: statement.span,
      },
      arguments: [collectionReference],
      span: statement.span,
    },
    step: undefined,
    inclusive: false,
    body,
    span: statement.span,
  };
  const rangeBindings = new Map(visibleBindings);
  rangeBindings.set(collectionName.text, collectionName);
  const loweredRange = lowerDynamicRange(range, rangeBindings);
  if (loweredRange === undefined) return undefined;
  return [
    {
      kind: "binding",
      declarationKind: "let",
      recursive: false,
      name: collectionName,
      value: statement.collection,
      span: statement.span,
    },
    ...loweredRange,
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
    case "recordBinding":
      return { ...statement, value: lowerExpression(statement.value) };
    case "typePattern":
      return { ...statement, target: lowerExpression(statement.target) };
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
    case "forCollection":
      return {
        ...statement,
        collection: lowerExpression(statement.collection),
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
    case "initDeclaration":
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
    case "float32":
    case "float64":
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
    case "optionDo":
      return { ...expression, option: lowerExpression(expression.option) };
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
    case "record":
      return {
        ...expression,
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
    case "indexUpdate":
      return {
        ...expression,
        product: lowerExpression(expression.product),
        index: lowerExpression(expression.index),
        value: lowerExpression(expression.value),
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
      return { ...expression, body: lowerExpression(expression.body) };
    case "loop":
      return expression;
  }
}

function collectBranchAssignments(
  expression: BranchExpression,
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
      continue;
    }
    if (
      statement.kind === "expression" &&
      (statement.expression.kind === "if" ||
        statement.expression.kind === "ifUnion")
    ) {
      collectAssignments(statement.expression.consequence, assignments);
      if (statement.expression.alternative !== undefined) {
        collectAssignments(statement.expression.alternative, assignments);
      }
    }
  }
}

function lowerAssignmentCondition(
  expression: BranchExpression,
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

type BranchExpression = Extract<
  DucklangExpression,
  { readonly kind: "if" | "ifUnion" }
>;

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

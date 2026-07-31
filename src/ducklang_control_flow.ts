import {
  type DucklangExpression,
  type DucklangModule,
  type DucklangName,
  ducklangNamedType,
  type DucklangStatement,
  type DucklangTypeReference,
} from "./ducklang_ast.ts";

export function lowerDucklangControlFlow(
  module: DucklangModule,
): DucklangModule {
  return lowerDucklangControlFlowWithMetrics(module).module;
}

export function lowerDucklangControlFlowWithMetrics(
  module: DucklangModule,
): {
  readonly module: DucklangModule;
  readonly passCount: number;
  readonly firstPassResidualControlCount: number;
  readonly firstPassMilliseconds: number;
  readonly subsequentPassMilliseconds: number;
} {
  let lowered = module;
  let passCount = 0;
  let firstPassResidualControlCount = 0;
  let firstPassMilliseconds = 0;
  let subsequentPassMilliseconds = 0;
  let previousResidualControlCount: number | undefined;
  while (true) {
    const passStart = performance.now();
    lowered = {
      ...lowered,
      statements: lowerStatements(lowered.statements),
      extensions: lowered.extensions.map((extension) => ({
        ...extension,
        methods: extension.methods.map((method) => ({
          ...method,
          value: lowerExpression(method.value),
        })),
      })),
    };
    const passMilliseconds = performance.now() - passStart;
    passCount += 1;
    if (passCount === 1) {
      firstPassMilliseconds = passMilliseconds;
    } else {
      subsequentPassMilliseconds += passMilliseconds;
    }
    const residual = sourceControlFlowSummary(lowered);
    if (passCount === 1) {
      firstPassResidualControlCount = residual.count;
    }
    if (residual.first === undefined) {
      return {
        module: lowered,
        passCount,
        firstPassResidualControlCount,
        firstPassMilliseconds,
        subsequentPassMilliseconds,
      };
    }
    if (
      previousResidualControlCount !== undefined &&
      residual.count >= previousResidualControlCount
    ) {
      throw new TypeError(
        `${residual.first.span.file}:${residual.first.span.start}: Ducklang control-flow lowering did not decrease residual ${residual.first.kind} count from ${previousResidualControlCount} to ${residual.count}`,
      );
    }
    previousResidualControlCount = residual.count;
  }
}

function sourceControlFlowSummary(
  module: DucklangModule,
): {
  readonly count: number;
  readonly first:
    | {
      readonly kind: "loop" | "forRange" | "forCollection";
      readonly span: DucklangExpression["span"];
    }
    | undefined;
} {
  const pending: (DucklangExpression | DucklangStatement)[] = [
    ...module.statements,
    ...module.extensions.flatMap((extension) =>
      extension.methods.map((method) => method.value)
    ),
  ];
  let count = 0;
  let first:
    | {
      readonly kind: "loop" | "forRange" | "forCollection";
      readonly span: DucklangExpression["span"];
    }
    | undefined;
  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
      case "loop":
      case "forRange":
      case "forCollection":
        count += 1;
        first ??= current;
        break;
      case "binding":
      case "assignment":
      case "productBinding":
      case "recordBinding":
        pending.push(current.value);
        break;
      case "unionBinding":
        pending.push(current.value, current.alternative);
        break;
      case "recursiveGroup":
        pending.push(...current.bindings.map((binding) => binding.value));
        break;
      case "typePattern":
        pending.push(current.target);
        break;
      case "break":
        if (current.value !== undefined) pending.push(current.value);
        break;
      case "return":
      case "expression":
        pending.push(current.expression);
        break;
      case "hostCall":
      case "recursiveCall":
        pending.push(...current.arguments);
        break;
      case "effectHandler":
        pending.push(...current.fields.map((field) => field.value));
        break;
      case "handle":
        pending.push(current.body, current.handler);
        break;
      case "optionDo":
        pending.push(current.option);
        break;
      case "unionCase":
        pending.push(current.value);
        break;
      case "product":
        pending.push(...current.values);
        break;
      case "field":
        pending.push(current.product);
        break;
      case "recordUpdate":
        pending.push(
          current.product,
          ...current.fields.map((field) => field.value),
        );
        break;
      case "record":
        pending.push(...current.fields.map((field) => field.value));
        break;
      case "function":
      case "scratch":
        pending.push(current.body);
        break;
      case "call":
        pending.push(current.callee, ...current.arguments);
        break;
      case "index":
        pending.push(current.collection, current.index);
        break;
      case "indexUpdate":
        pending.push(current.product, current.index, current.value);
        break;
      case "binary":
        pending.push(current.left, current.right);
        break;
      case "unary":
        pending.push(current.operand);
        break;
      case "if":
        pending.push(current.condition, current.consequence);
        if (current.alternative !== undefined) {
          pending.push(current.alternative);
        }
        break;
      case "ifUnion":
        pending.push(current.value, current.consequence);
        if (current.alternative !== undefined) {
          pending.push(current.alternative);
        }
        break;
      case "block":
        pending.push(...current.statements);
        break;
      case "comptime":
        pending.push(current.expression);
        break;
      case "effectDeclaration":
      case "initDeclaration":
      case "structType":
      case "unionType":
      case "typeAlias":
      case "import":
      case "continue":
      case "integer":
      case "integer64":
      case "float32":
      case "float64":
      case "boolean":
      case "unit":
      case "string":
      case "moduleImport":
      case "reference":
        break;
      default: {
        const unhandled: never = current;
        throw new Error(
          `unhandled Ducklang syntax ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }
  return { count, first };
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
  expectedResultType?: DucklangTypeReference,
): readonly DucklangStatement[] {
  const result: DucklangStatement[] = [];
  for (const [index, statement] of statements.entries()) {
    if (
      statement.kind === "expression" &&
      (statement.expression.kind === "if" ||
        statement.expression.kind === "ifUnion") &&
      statement.expression.stateThreaded !== true &&
      !containsLoopControl(statement.expression) &&
      collectBranchAssignments(statement.expression).size > 0 &&
      index + 1 < statements.length
    ) {
      const remaining = statements.slice(index + 1);
      result.push(
        ...lowerBranchContinuation(
          statement.expression,
          remaining,
          visibleBindingNames(result),
          expectedResultType,
        ),
      );
      return result;
    }
    const lowered = lowerStatementExpressions(
      statement,
      index === statements.length - 1 ? expectedResultType : undefined,
    );
    if (lowered.kind === "forRange") {
      const range = lowerDynamicRange(
        lowered,
        visibleBindingNames(result),
      );
      result.push(...(range ?? [lowered]));
      continue;
    }
    if (lowered.kind === "forCollection") {
      const collection = lowerIndexedCollectionLoop(
        lowered,
        visibleBindingNames(result),
      );
      result.push(...(collection ?? [lowered]));
      continue;
    }
    if (lowered.kind === "expression" && lowered.expression.kind === "loop") {
      const remaining = lowerStatements(
        statements.slice(index + 1),
        expectedResultType,
      );
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
          expectedResultType,
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
    if (lowered.expression.stateThreaded === true) {
      result.push(lowered);
      continue;
    }
    const assignments = collectBranchAssignments(lowered.expression);
    if (
      assignments.size > 0 && index + 1 < statements.length
    ) {
      const remaining = statements.slice(index + 1);
      result.push(
        ...lowerBranchContinuation(
          lowered.expression,
          remaining,
          visibleBindingNames(result),
          expectedResultType,
        ),
      );
      return result;
    }
    result.push(lowered);
  }
  return result;
}

function lowerBranchContinuation(
  branch: BranchExpression,
  remaining: readonly DucklangStatement[],
  visibleBindings: ReadonlyMap<string, DucklangName>,
  expectedResultType?: DucklangTypeReference,
): readonly DucklangStatement[] {
  const parameters = [...collectBranchAssignments(branch).values()].map(
    (assignment) =>
      preserveBindingType(
        assignment,
        visibleBindings.get(assignment.text),
      ),
  );
  const continuationName: DucklangName = {
    text: `$branch_${branch.span.start}`,
    span: branch.span,
  };
  const continuationCall = (): DucklangExpression => ({
    kind: "call",
    callee: {
      kind: "reference",
      name: continuationName,
      span: continuationName.span,
    },
    arguments: parameters.map(bindingReference),
    span: branch.span,
  });
  const appendCall = (
    expression: DucklangExpression | undefined,
  ): DucklangExpression => {
    const call = continuationCall();
    if (expression?.kind === "block") {
      return {
        ...expression,
        statements: [
          ...expression.statements,
          { kind: "expression", expression: call, span: call.span },
        ],
      };
    }
    return {
      kind: "block",
      statements: [
        ...(expression === undefined ? [] : [{
          kind: "expression" as const,
          expression,
          span: expression.span,
        }]),
        { kind: "expression", expression: call, span: call.span },
      ],
      span: expression?.span ?? branch.span,
    };
  };
  const continuationBody: DucklangExpression = {
    kind: "block",
    statements: remaining,
    span: {
      file: remaining[0].span.file,
      start: Math.min(...remaining.map((statement) => statement.span.start)),
      end: Math.max(...remaining.map((statement) => statement.span.end)),
    },
  };
  const continuationBinding: DucklangStatement = {
    kind: "binding",
    declarationKind: "let",
    recursive: false,
    name: continuationName,
    value: {
      kind: "function",
      recursive: false,
      parameters,
      parameterTypeSources: parameters.map(bindingReference),
      ...(expectedResultType === undefined
        ? {}
        : { declaredResultType: expectedResultType }),
      body: lowerExpression(continuationBody, expectedResultType),
      span: branch.span,
    },
    span: branch.span,
  };
  return [
    continuationBinding,
    {
      kind: "expression",
      expression: lowerExpression(
        {
          ...branch,
          stateThreaded: true,
          consequence: appendCall(branch.consequence),
          alternative: appendCall(branch.alternative),
        },
        expectedResultType,
      ),
      span: branch.span,
    },
  ];
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
  readonly resultType?: DucklangTypeReference;
  readonly span: DucklangExpression["span"];
};

function lowerDynamicLoop(
  loop: Extract<DucklangExpression, { readonly kind: "loop" }>,
  breakContinuation: DucklangExpression,
  visibleBindings: ReadonlyMap<string, DucklangName>,
  breakValueIsResult = false,
  resultType?: DucklangTypeReference,
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
  const exitName: DucklangName = {
    text: `$loop_exit_${loop.span.start}`,
    span: loop.span,
  };
  const exitCall: DucklangExpression = {
    kind: "call",
    callee: {
      kind: "reference",
      name: exitName,
      span: exitName.span,
    },
    arguments: carriedBindings.map(bindingReference),
    span: loop.span,
  };
  const context = {
    functionName,
    carriedBindings,
    breakContinuation: breakValueIsResult ? breakContinuation : exitCall,
    breakValueIsResult,
    recursiveArguments: carriedBindings.map(bindingReference),
    resultType,
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
      loweringRole: "loop",
      parameters: carriedBindings,
      parameterTypeSources: carriedBindings.map(bindingReference),
      ...(resultType === undefined ? {} : { declaredResultType: resultType }),
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
  const exitBinding: DucklangStatement = {
    kind: "binding",
    declarationKind: "let",
    recursive: false,
    name: exitName,
    value: {
      kind: "function",
      recursive: false,
      parameters: carriedBindings,
      parameterTypeSources: carriedBindings.map(bindingReference),
      ...(resultType === undefined ? {} : { declaredResultType: resultType }),
      body: breakContinuation,
      span: loop.span,
    },
    span: loop.span,
  };
  return [
    ...(breakValueIsResult ? [] : [exitBinding]),
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
      context.resultType,
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
      stateThreaded: true,
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
    const lowered = lowerIndexedCollectionLoop(statement, new Map());
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
      stateThreaded: true,
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
      stateThreaded: true,
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
      loweringRole: "loop",
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

function lowerIndexedCollectionLoop(
  statement: Extract<DucklangStatement, { readonly kind: "forCollection" }>,
  visibleBindings: ReadonlyMap<string, DucklangName>,
): readonly DucklangStatement[] | undefined {
  if (
    statement.body.kind !== "block" || statement.caseName !== undefined
  ) {
    return undefined;
  }
  const collectionName: DucklangName = {
    text: `$collection_${statement.span.start}`,
    ...(statement.collection.kind === "reference" &&
        statement.collection.name.declaredType !== undefined
      ? { declaredType: statement.collection.name.declaredType }
      : {}),
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
        name: statement.value,
        value: {
          kind: "index",
          collection: collectionReference,
          index: indexReference,
          entryProjection: true,
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
  expectedResultType?: DucklangTypeReference,
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
        expression: lowerExpression(statement.expression, expectedResultType),
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

function lowerExpression(
  expression: DucklangExpression,
  expectedResultType?: DucklangTypeReference,
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
    case "reference":
      return expression;
    case "hostCall":
      return {
        ...expression,
        arguments: expression.arguments.map((argument) =>
          lowerExpression(argument)
        ),
      };
    case "effectHandler":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: lowerExpression(field.value),
        })),
      };
    case "handle":
      return {
        ...expression,
        body: lowerExpression(expression.body),
        handler: lowerExpression(expression.handler),
      };
    case "optionDo":
      return { ...expression, option: lowerExpression(expression.option) };
    case "unionCase":
      return { ...expression, value: lowerExpression(expression.value) };
    case "product":
      return {
        ...expression,
        values: expression.values.map((value) => lowerExpression(value)),
      };
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
      return {
        ...expression,
        body: lowerExpression(
          expression.body,
          expression.declaredResultType,
        ),
      };
    case "recursiveCall":
      return {
        ...expression,
        arguments: expression.arguments.map((argument) =>
          lowerExpression(argument)
        ),
      };
    case "call":
      return {
        ...expression,
        callee: lowerExpression(expression.callee),
        arguments: expression.arguments.map((argument) =>
          lowerExpression(argument)
        ),
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
        consequence: lowerExpression(
          expression.consequence,
          expectedResultType,
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : lowerExpression(expression.alternative, expectedResultType),
      };
    case "ifUnion":
      return {
        ...expression,
        value: lowerExpression(expression.value),
        consequence: lowerExpression(
          expression.consequence,
          expectedResultType,
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : lowerExpression(expression.alternative, expectedResultType),
      };
    case "block":
      return {
        ...expression,
        statements: lowerStatements(
          expression.statements,
          expectedResultType,
        ),
      };
    case "comptime":
      return {
        ...expression,
        expression: lowerExpression(
          expression.expression,
          expectedResultType,
        ),
      };
    case "scratch":
      return {
        ...expression,
        body: lowerExpression(expression.body, expectedResultType),
      };
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
  localBindings: ReadonlySet<string> = new Set(),
): void {
  if (expression.kind === "if" || expression.kind === "ifUnion") {
    if (expression.stateThreaded === true) return;
    collectAssignments(expression.consequence, assignments, localBindings);
    if (expression.alternative !== undefined) {
      collectAssignments(expression.alternative, assignments, localBindings);
    }
    return;
  }
  if (expression.kind === "scratch") {
    collectAssignments(expression.body, assignments, localBindings);
    return;
  }
  if (expression.kind !== "block") return;
  const blockBindings = new Set(localBindings);
  for (const statement of expression.statements) {
    switch (statement.kind) {
      case "assignment":
        if (!blockBindings.has(statement.name.text)) {
          assignments.set(statement.name.text, statement.name);
        }
        collectAssignments(statement.value, assignments, blockBindings);
        break;
      case "expression":
        collectAssignments(statement.expression, assignments, blockBindings);
        break;
      case "return":
        collectAssignments(statement.expression, assignments, blockBindings);
        break;
      case "binding":
        blockBindings.add(statement.name.text);
        break;
      case "unionBinding":
        blockBindings.add(statement.name.text);
        break;
      case "productBinding":
        for (const name of statement.names) {
          if (name !== undefined) blockBindings.add(name.text);
        }
        break;
      case "recordBinding":
        for (const field of statement.fields) {
          blockBindings.add(field.localName.text);
        }
        break;
      case "recursiveGroup":
        for (const binding of statement.bindings) {
          blockBindings.add(binding.name.text);
        }
        break;
      case "forRange":
      case "forCollection":
      case "break":
      case "continue":
      case "effectDeclaration":
      case "initDeclaration":
      case "unionType":
      case "structType":
      case "typeAlias":
      case "typePattern":
      case "import":
        break;
    }
  }
}

type BranchExpression = Extract<
  DucklangExpression,
  { readonly kind: "if" | "ifUnion" }
>;

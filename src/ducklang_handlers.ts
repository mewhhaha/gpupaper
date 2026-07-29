import type {
  DucklangExpression,
  DucklangExtensionDeclaration,
  DucklangModule,
  DucklangRecordField,
  DucklangStatement,
} from "./ducklang_ast.ts";
import type { SourceSpan } from "./syntax.ts";

type Handler = {
  readonly bindingName: string;
  readonly effectName: string;
  readonly fields: ReadonlyMap<string, DucklangRecordField>;
  readonly state: Map<string, DucklangExpression>;
  readonly order: number;
};

export function elaborateDucklangHandlers(
  module: DucklangModule,
): DucklangModule {
  const bindings = new Map(
    module.statements.flatMap((statement) =>
      statement.kind === "binding" ? [[statement.name.text, statement]] : []
    ),
  );
  const handlers = collectHandlers(module, bindings);
  const removedBindings = new Set<string>();
  const statements = module.statements.map((statement) =>
    elaborateNestedTryExpressions(
      statement,
      bindings,
      handlers,
      removedBindings,
    )
  );
  return {
    ...module,
    statements: statements.filter((statement) =>
      !(statement.kind === "binding" &&
        removedBindings.has(statement.name.text))
    ),
  };
}

const expressionKinds = new Set<DucklangExpression["kind"]>([
  "integer",
  "integer64",
  "float32",
  "float64",
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

function elaborateNestedTryExpressions<T>(
  value: T,
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
  handlers: ReadonlyMap<string, Handler>,
  removedBindings: Set<string>,
): T {
  if (Array.isArray(value)) {
    return value.map((element) =>
      elaborateNestedTryExpressions(
        element,
        bindings,
        handlers,
        removedBindings,
      )
    ) as T;
  }
  if (value === null || typeof value !== "object") return value;
  const mapped = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      elaborateNestedTryExpressions(
        child,
        bindings,
        handlers,
        removedBindings,
      ),
    ]),
  );
  const kind = (mapped as { readonly kind?: unknown }).kind;
  if (
    typeof kind !== "string" || !expressionKinds.has(
      kind as DucklangExpression["kind"],
    )
  ) {
    return mapped as T;
  }
  return elaborateTryExpression(
    mapped as DucklangExpression,
    bindings,
    handlers,
    removedBindings,
  ) as T;
}

function collectHandlers(
  module: DucklangModule,
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
): ReadonlyMap<string, Handler> {
  const handlers = new Map<string, Handler>();
  for (const binding of bindings.values()) {
    const extracted = extractHandler(binding.value);
    if (extracted === undefined) continue;
    const order = handlerOrder(extracted.effectName, module.extensions);
    handlers.set(extracted.effectName, {
      bindingName: binding.name.text,
      effectName: extracted.effectName,
      fields: new Map(
        extracted.record.fields.map((field) => [field.name, field]),
      ),
      state: extracted.state,
      order,
    });
  }
  return handlers;
}

function extractHandler(
  expression: DucklangExpression,
): {
  readonly effectName: string;
  readonly record: Extract<DucklangExpression, { readonly kind: "record" }>;
  readonly state: Map<string, DucklangExpression>;
} | undefined {
  const body = expression.kind === "function" ? expression.body : expression;
  if (body.kind === "record") {
    const effectName = handlerEffectName(body);
    return effectName === undefined
      ? undefined
      : { effectName, record: body, state: new Map() };
  }
  if (body.kind !== "block") return undefined;
  const result = body.statements.at(-1);
  if (result?.kind !== "expression" || result.expression.kind !== "record") {
    return undefined;
  }
  const effectName = handlerEffectName(result.expression);
  if (effectName === undefined) return undefined;
  const state = new Map<string, DucklangExpression>();
  for (const statement of body.statements.slice(0, -1)) {
    if (statement.kind !== "binding") {
      throw new TypeError(
        `${statement.span.file}:${statement.span.start}: Ducklang handler state must use bindings before its clauses`,
      );
    }
    state.set(statement.name.text, statement.value);
  }
  return { effectName, record: result.expression, state };
}

function handlerEffectName(
  record: Extract<DucklangExpression, { readonly kind: "record" }>,
): string | undefined {
  const prefix = "$effect_handler_";
  return record.nominalType?.startsWith(prefix)
    ? record.nominalType.slice(prefix.length)
    : undefined;
}

function handlerOrder(
  effectName: string,
  extensions: readonly DucklangExtensionDeclaration[],
): number {
  const extension = extensions.find((candidate) =>
    candidate.targetType === effectName
  );
  const order = extension?.methods.find((method) => method.name === "order")
    ?.value;
  return order?.kind === "function" && order.body.kind === "integer"
    ? order.body.value
    : 0;
}

function elaborateTryExpression(
  expression: DucklangExpression,
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
  handlers: ReadonlyMap<string, Handler>,
  removedBindings: Set<string>,
): DucklangExpression {
  if (
    expression.kind === "record" &&
    expression.nominalType?.startsWith("$effect_handler_")
  ) {
    const { nominalType: _, ...record } = expression;
    return {
      ...record,
      fields: expression.fields.map((field) => {
        if (field.value.kind !== "function") return field;
        const resumption = field.value.parameters.at(-1);
        if (resumption?.linear !== true) return field;
        return {
          ...field,
          value: {
            ...field.value,
            parameters: [
              ...field.value.parameters.slice(0, -1),
              { ...resumption, affine: true },
            ],
          },
        };
      }),
    };
  }
  if (
    expression.kind !== "call" || expression.callee.kind !== "reference" ||
    expression.callee.name.text !== "$duck_try" ||
    expression.arguments.length !== 2
  ) return expression;
  const bodyArgument = expression.arguments[0];
  const bodyBinding = bodyArgument.kind === "call" &&
      bodyArgument.callee.kind === "reference" &&
      bodyArgument.arguments.length === 0
    ? bindings.get(bodyArgument.callee.name.text)
    : undefined;
  const body = bodyArgument.kind === "block"
    ? bodyArgument
    : bodyBinding?.value.kind === "function" &&
        bodyBinding.value.parameters.length === 0
    ? bodyBinding.value.body
    : undefined;
  if (body === undefined) {
    throw new TypeError(
      `${bodyArgument.span.file}:${bodyArgument.span.start}: Ducklang handled body must be a block or zero-argument function call`,
    );
  }
  if (expression.arguments[1].kind === "unit") {
    const effects = new Set<string>();
    collectHandledEffects(body, effects);
    if (effects.size === 0) {
      return {
        kind: "unionCase",
        caseName: "Some",
        value: bodyArgument,
        span: expression.span,
      };
    }
  }
  if (bodyBinding !== undefined) removedBindings.add(bodyBinding.name.text);
  const selectedHandlers = selectHandlers(
    expression.arguments[1],
    body,
    handlers,
    bindings,
  );
  for (const handler of selectedHandlers) {
    removedBindings.add(handler.bindingName);
  }
  return lowerHandledExpression(
    body,
    selectedHandlers,
    bindings,
    expression.span,
  );
}

function selectHandlers(
  explicit: DucklangExpression,
  body: DucklangExpression,
  handlers: ReadonlyMap<string, Handler>,
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
): readonly Handler[] {
  if (explicit.kind === "reference") {
    const handler = [...handlers.values()].find((candidate) =>
      candidate.bindingName === explicit.name.text
    );
    if (handler !== undefined) return [cloneHandler(handler)];
    throw new ReferenceError(
      `${explicit.span.file}:${explicit.span.start}: unknown Ducklang handler ${explicit.name.text}`,
    );
  }
  if (
    explicit.kind === "call" && explicit.callee.kind === "reference"
  ) {
    const handlerName = explicit.callee.name.text;
    const handler = [...handlers.values()].find((candidate) =>
      candidate.bindingName === handlerName
    );
    const binding = bindings.get(handlerName);
    if (
      handler !== undefined && binding?.value.kind === "function" &&
      binding.value.parameters.length === explicit.arguments.length
    ) {
      const substitutions = new Map(
        binding.value.parameters.map((parameter, index) => [
          parameter.text,
          explicit.arguments[index],
        ]),
      );
      return [{
        ...cloneHandler(handler),
        state: new Map(
          [...handler.state].map(([name, value]) => [
            name,
            substituteTree(value, substitutions),
          ]),
        ),
        fields: new Map(
          [...handler.fields].map(([name, field]) => [
            name,
            {
              ...field,
              value: substituteTree(field.value, substitutions),
            },
          ]),
        ),
      }];
    }
  }
  if (explicit.kind !== "unit") {
    throw new TypeError(
      `${explicit.span.file}:${explicit.span.start}: Ducklang handler selection must be a handler name or omitted`,
    );
  }
  const effectNames = new Set<string>();
  collectHandledEffects(body, effectNames);
  return [...effectNames].map((effectName) => {
    const handler = handlers.get(effectName);
    if (handler === undefined) {
      throw new ReferenceError(
        `${body.span.file}:${body.span.start}: Ducklang effect ${effectName} has no default handler`,
      );
    }
    return cloneHandler(handler);
  });
}

function lowerHandledExpression(
  body: DucklangExpression,
  handlers: readonly Handler[],
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
  span: SourceSpan,
): DucklangExpression {
  const orderedHandlers = handlers.toSorted((left, right) =>
    left.order - right.order
  );
  const effectNames = new Set(
    orderedHandlers.map((handler) => handler.effectName),
  );
  const loweredBody = rewriteHandledEffects(
    body,
    orderedHandlers,
    effectNames,
    bindings,
    new Set(),
  );
  const stateBindings: DucklangStatement[] = orderedHandlers.flatMap((
    handler,
  ) =>
    [...handler.state].map(([name, value]): DucklangStatement => ({
      kind: "binding",
      declarationKind: "let",
      recursive: false,
      name: { text: name, span: value.span },
      value,
      span: value.span,
    }))
  );
  const bodyStatements = flattenHandledStatements(
    loweredBody.kind === "block" ? loweredBody.statements : [{
      kind: "expression" as const,
      expression: loweredBody,
      span: loweredBody.span,
    }],
  );
  const trailingStatement = bodyStatements.at(-1);
  let result: DucklangExpression = trailingStatement?.kind === "expression"
    ? trailingStatement.expression
    : { kind: "unit", span };
  const precedingStatements = trailingStatement?.kind === "expression"
    ? bodyStatements.slice(0, -1)
    : bodyStatements;
  for (const handler of orderedHandlers) {
    const returnClause = handler.fields.get("return");
    if (returnClause === undefined) continue;
    result = inlineHandlerClause(returnClause, [result], span);
  }
  return {
    kind: "block",
    statements: [
      ...stateBindings,
      ...precedingStatements,
      { kind: "expression", expression: result, span: result.span },
    ],
    span,
  };
}

function flattenHandledStatements(
  statements: readonly DucklangStatement[],
): readonly DucklangStatement[] {
  return statements.flatMap((statement): readonly DucklangStatement[] => {
    if (
      statement.kind === "expression" &&
      statement.expression.kind === "block"
    ) {
      return flattenHandledStatements(statement.expression.statements);
    }
    if (
      (statement.kind === "binding" || statement.kind === "assignment") &&
      statement.value.kind === "block"
    ) {
      const flattened = flattenHandledStatements(statement.value.statements);
      const result = flattened.at(-1);
      if (result?.kind !== "expression") {
        throw new TypeError(
          `${statement.span.file}:${statement.span.start}: Ducklang handler operation used as a value must produce an expression`,
        );
      }
      return [
        ...flattened.slice(0, -1),
        { ...statement, value: result.expression },
      ];
    }
    return [statement];
  });
}

function rewriteHandledEffects(
  expression: DucklangExpression,
  handlers: readonly Handler[],
  effectNames: ReadonlySet<string>,
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
  inlining: ReadonlySet<string>,
): DucklangExpression {
  return mapExpressionTree(expression, (rewritten) => {
    if (
      rewritten.kind === "hostCall" && effectNames.has(rewritten.effectName)
    ) {
      const handler = handlers.find((candidate) =>
        candidate.effectName === rewritten.effectName
      );
      const clause = handler?.fields.get(rewritten.operationName);
      if (handler === undefined || clause === undefined) {
        throw new ReferenceError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang handler ${rewritten.effectName} has no operation ${rewritten.operationName}`,
        );
      }
      return inlineHandlerClause(
        clause,
        rewritten.arguments,
        rewritten.span,
      );
    }
    if (
      rewritten.kind !== "call" || rewritten.callee.kind !== "reference"
    ) {
      return rewritten;
    }
    const functionName = rewritten.callee.name.text;
    const binding = bindings.get(functionName);
    if (
      binding?.value.kind !== "function" ||
      !functionContainsHandledEffect(
        binding.value.body,
        effectNames,
        bindings,
        new Set(),
      )
    ) {
      return rewritten;
    }
    if (inlining.has(functionName)) {
      throw new TypeError(
        `${rewritten.span.file}:${rewritten.span.start}: recursive Ducklang function ${functionName} performs a locally handled effect`,
      );
    }
    if (binding.value.parameters.length !== rewritten.arguments.length) {
      throw new TypeError(
        `${rewritten.span.file}:${rewritten.span.start}: handled Ducklang call ${functionName} expects ${binding.value.parameters.length} arguments; received ${rewritten.arguments.length}`,
      );
    }
    const substitutions = new Map(
      binding.value.parameters.map((parameter, index) => [
        parameter.text,
        rewritten.arguments[index],
      ]),
    );
    return rewriteHandledEffects(
      substituteTree(binding.value.body, substitutions),
      handlers,
      effectNames,
      bindings,
      new Set([...inlining, functionName]),
    );
  });
}

function functionContainsHandledEffect(
  value: unknown,
  effectNames: ReadonlySet<string>,
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
  visiting: Set<string>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((child) =>
      functionContainsHandledEffect(child, effectNames, bindings, visiting)
    );
  }
  if (value === null || typeof value !== "object") return false;
  const expression = value as Partial<DucklangExpression>;
  if (
    expression.kind === "hostCall" &&
    effectNames.has(expression.effectName as string)
  ) {
    return true;
  }
  if (
    expression.kind === "call" &&
    expression.callee?.kind === "reference"
  ) {
    const functionName = expression.callee.name.text;
    if (!visiting.has(functionName)) {
      const binding = bindings.get(functionName);
      if (binding?.value.kind === "function") {
        visiting.add(functionName);
        const contains = functionContainsHandledEffect(
          binding.value.body,
          effectNames,
          bindings,
          visiting,
        );
        visiting.delete(functionName);
        if (contains) return true;
      }
    }
  }
  return Object.values(value).some((child) =>
    functionContainsHandledEffect(child, effectNames, bindings, visiting)
  );
}

function inlineHandlerClause(
  field: DucklangRecordField,
  arguments_: readonly DucklangExpression[],
  span: SourceSpan,
): DucklangExpression {
  if (field.value.kind !== "function") {
    throw new TypeError(
      `${field.span.file}:${field.span.start}: Ducklang handler clause ${field.name} is not a function`,
    );
  }
  const resume = field.value.parameters.at(-1)?.linear
    ? field.value.parameters.at(-1)
    : undefined;
  const parameters = resume === undefined
    ? field.value.parameters
    : field.value.parameters.slice(0, -1);
  if (parameters.length !== arguments_.length) {
    throw new TypeError(
      `${span.file}:${span.start}: Ducklang handler clause ${field.name} expects ${parameters.length} arguments; received ${arguments_.length}`,
    );
  }
  const substitutions = new Map(
    parameters.map((parameter, index) => [
      parameter.text,
      arguments_[index],
    ]),
  );
  if (resume !== undefined) {
    // The resumption is declared linear, but elaboration substitutes it away and
    // inlines each call as its argument, so resolution never sees the `!` and a
    // clause could resume twice. Counting the uses here is what keeps the declared
    // discipline: at most one resumption per clause.
    const uses = countReferences(field.value.body, resume.text);
    if (uses > 1) {
      throw new TypeError(
        `${field.span.file}:${field.span.start}: Ducklang handler clause ${field.name} resumes ${uses} times; a resumption may be used at most once`,
      );
    }
    substitutions.set(resume.text, referenceResume(resume.span));
  }
  return replaceResumeCalls(
    substituteTree(field.value.body, substitutions),
  );
}

/** Counts references to a name, so a resumption's declared linearity survives. */
function countReferences(value: unknown, name: string): number {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    const reference = node.name as Record<string, unknown> | undefined;
    if (node.kind === "reference" && reference?.text === name) count += 1;
    pending.push(...Object.values(node));
  }
  return count;
}

function replaceResumeCalls(
  expression: DucklangExpression,
): DucklangExpression {
  return mapExpressionTree(expression, (candidate) => {
    if (
      candidate.kind === "call" && candidate.callee.kind === "reference" &&
      candidate.callee.name.text === "$duck_resume" &&
      candidate.arguments.length === 1
    ) {
      return candidate.arguments[0];
    }
    return candidate;
  });
}

function substituteTree(
  expression: DucklangExpression,
  substitutions: ReadonlyMap<string, DucklangExpression>,
): DucklangExpression {
  return mapExpressionTree(
    expression,
    (candidate) =>
      candidate.kind === "reference"
        ? substitutions.get(candidate.name.text) ?? candidate
        : candidate,
  );
}

function mapExpressionTree(
  expression: DucklangExpression,
  transform: (expression: DucklangExpression) => DucklangExpression,
): DucklangExpression {
  const mapValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(mapValue);
    if (value === null || typeof value !== "object") return value;
    const mapped = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, mapValue(child)]),
    );
    const kind = (mapped as { readonly kind?: unknown }).kind;
    return typeof kind === "string" &&
        expressionKinds.has(kind as DucklangExpression["kind"])
      ? transform(mapped as DucklangExpression)
      : mapped;
  };
  return mapValue(expression) as DucklangExpression;
}

function cloneHandler(handler: Handler): Handler {
  return { ...handler, state: new Map(handler.state) };
}

function collectHandledEffects(
  expression: DucklangExpression,
  effects: Set<string>,
): void {
  if (expression.kind === "hostCall") effects.add(expression.effectName);
  for (const value of Object.values(expression)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isExpression(child)) collectHandledEffects(child, effects);
      }
    } else if (isExpression(value)) {
      collectHandledEffects(value, effects);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) {
        if (isExpression(child)) collectHandledEffects(child, effects);
      }
    }
  }
}

function isExpression(value: unknown): value is DucklangExpression {
  return value !== null && typeof value === "object" &&
    typeof (value as Record<string, unknown>).kind === "string";
}

function referenceResume(span: SourceSpan): DucklangExpression {
  return {
    kind: "reference",
    name: { text: "$duck_resume", span },
    span,
  };
}

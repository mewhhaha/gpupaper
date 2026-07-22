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
  let changed = false;
  const statements = module.statements.map((statement): DucklangStatement => {
    if (statement.kind !== "expression" && statement.kind !== "binding") {
      return statement;
    }
    const expression = statement.kind === "expression"
      ? statement.expression
      : statement.value;
    const elaborated = elaborateTryExpression(
      expression,
      bindings,
      handlers,
      removedBindings,
    );
    if (elaborated === expression) return statement;
    changed = true;
    return statement.kind === "expression"
      ? { ...statement, expression: elaborated }
      : { ...statement, value: elaborated };
  });
  if (!changed) return module;
  for (const handler of handlers.values()) {
    removedBindings.add(handler.bindingName);
  }
  return {
    ...module,
    statements: statements.filter((statement) =>
      !(statement.kind === "binding" &&
        removedBindings.has(statement.name.text))
    ),
  };
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
    expression.kind !== "call" || expression.callee.kind !== "reference" ||
    expression.callee.name.text !== "$duck_try" ||
    expression.arguments.length !== 2
  ) return expression;
  const bodyCall = expression.arguments[0];
  if (
    bodyCall.kind !== "call" || bodyCall.callee.kind !== "reference" ||
    bodyCall.arguments.length !== 0
  ) {
    throw new TypeError(
      `${expression.span.file}:${expression.span.start}: Ducklang handled body must be a zero-argument function call`,
    );
  }
  const bodyBinding = bindings.get(bodyCall.callee.name.text);
  if (
    bodyBinding?.value.kind !== "function" ||
    bodyBinding.value.parameters.length !== 0
  ) {
    throw new TypeError(
      `${bodyCall.span.file}:${bodyCall.span.start}: Ducklang handled function ${bodyCall.callee.name.text} is not a zero-argument function`,
    );
  }
  if (expression.arguments[1].kind === "unit") {
    const effects = new Set<string>();
    collectHandledEffects(bodyBinding.value.body, effects);
    if (effects.size === 0) {
      return {
        kind: "unionCase",
        caseName: "Some",
        value: bodyCall,
        span: expression.span,
      };
    }
  }
  removedBindings.add(bodyBinding.name.text);
  const selectedHandlers = selectHandlers(
    expression.arguments[1],
    bodyBinding.value.body,
    handlers,
  );
  let result = evaluateHandledBody(bodyBinding.value.body, selectedHandlers);
  for (
    const handler of selectedHandlers.toSorted((left, right) =>
      left.order - right.order
    )
  ) {
    const returnClause = handler.fields.get("return");
    if (returnClause === undefined) continue;
    result = applyClause(returnClause, [result], handler, expression.span);
  }
  return result;
}

function selectHandlers(
  explicit: DucklangExpression,
  body: DucklangExpression,
  handlers: ReadonlyMap<string, Handler>,
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

function evaluateHandledBody(
  body: DucklangExpression,
  handlers: readonly Handler[],
): DucklangExpression {
  if (body.kind !== "block") return substitute(body, new Map());
  const values = new Map<string, DucklangExpression>();
  let result: DucklangExpression = { kind: "unit", span: body.span };
  for (const statement of body.statements) {
    if (statement.kind === "binding") {
      const value = statement.value.kind === "hostCall"
        ? evaluateOperation(statement.value, handlers, values)
        : substitute(statement.value, values);
      values.set(statement.name.text, value);
      continue;
    }
    if (statement.kind === "expression") {
      result = statement.expression.kind === "hostCall"
        ? evaluateOperation(statement.expression, handlers, values)
        : substitute(statement.expression, values);
      continue;
    }
    throw new TypeError(
      `${statement.span.file}:${statement.span.start}: unsupported statement ${statement.kind} in handled Ducklang function`,
    );
  }
  return result;
}

function evaluateOperation(
  operation: Extract<DucklangExpression, { readonly kind: "hostCall" }>,
  handlers: readonly Handler[],
  values: ReadonlyMap<string, DucklangExpression>,
): DucklangExpression {
  const handler = handlers.find((candidate) =>
    candidate.effectName === operation.effectName
  );
  if (handler === undefined) {
    throw new ReferenceError(
      `${operation.span.file}:${operation.span.start}: Ducklang effect ${operation.effectName} is not handled`,
    );
  }
  const clause = handler.fields.get(operation.operationName);
  if (clause === undefined) {
    throw new ReferenceError(
      `${operation.span.file}:${operation.span.start}: Ducklang handler ${handler.effectName} has no operation ${operation.operationName}`,
    );
  }
  return applyClause(
    clause,
    operation.arguments.map((argument) => substitute(argument, values)),
    handler,
    operation.span,
  );
}

function applyClause(
  field: DucklangRecordField,
  arguments_: readonly DucklangExpression[],
  handler: Handler,
  span: SourceSpan,
): DucklangExpression {
  if (field.value.kind !== "function") {
    throw new TypeError(
      `${field.span.file}:${field.span.start}: Ducklang handler clause ${field.name} is not a function`,
    );
  }
  const parameters = field.value.parameters;
  const resume = parameters.at(-1)?.linear ? parameters.at(-1) : undefined;
  const ordinaryParameters = resume === undefined
    ? parameters
    : parameters.slice(0, -1);
  if (ordinaryParameters.length !== arguments_.length) {
    throw new TypeError(
      `${span.file}:${span.start}: Ducklang handler clause ${field.name} expects ${ordinaryParameters.length} arguments; received ${arguments_.length}`,
    );
  }
  const values = new Map(handler.state);
  ordinaryParameters.forEach((parameter, index) =>
    values.set(parameter.text, arguments_[index])
  );
  if (resume !== undefined) {
    values.set(resume.text, referenceResume(resume.span));
  }
  return evaluateClauseBody(field.value.body, values, handler, span);
}

function evaluateClauseBody(
  body: DucklangExpression,
  values: Map<string, DucklangExpression>,
  handler: Handler,
  span: SourceSpan,
): DucklangExpression {
  if (body.kind !== "block") return resumedValue(body, values, span);
  let result: DucklangExpression = { kind: "unit", span };
  for (const statement of body.statements) {
    if (statement.kind === "assignment") {
      const value = substitute(statement.value, values);
      handler.state.set(statement.name.text, value);
      values.set(statement.name.text, value);
      continue;
    }
    if (statement.kind === "expression") {
      result = resumedValue(statement.expression, values, span);
      continue;
    }
    throw new TypeError(
      `${statement.span.file}:${statement.span.start}: unsupported statement ${statement.kind} in Ducklang handler clause`,
    );
  }
  return result;
}

function resumedValue(
  expression: DucklangExpression,
  values: ReadonlyMap<string, DucklangExpression>,
  span: SourceSpan,
): DucklangExpression {
  const substituted = substitute(expression, values);
  if (
    substituted.kind === "call" && substituted.callee.kind === "reference" &&
    substituted.callee.name.text === "$duck_resume" &&
    substituted.arguments.length === 1
  ) return substituted.arguments[0];
  if (substituted.kind === "reference" || substituted.kind === "binary") {
    return substituted;
  }
  throw new TypeError(
    `${span.file}:${span.start}: Ducklang handler clause must resume exactly once or return a value`,
  );
}

function referenceResume(span: SourceSpan): DucklangExpression {
  return {
    kind: "reference",
    name: { text: "$duck_resume", span },
    span,
  };
}

function substitute(
  expression: DucklangExpression,
  values: ReadonlyMap<string, DucklangExpression>,
): DucklangExpression {
  const descend = (child: DucklangExpression) => substitute(child, values);
  switch (expression.kind) {
    case "reference":
      return values.get(expression.name.text) ?? expression;
    case "binary":
      return {
        ...expression,
        left: descend(expression.left),
        right: descend(expression.right),
      };
    case "unary":
      return { ...expression, operand: descend(expression.operand) };
    case "call":
      return {
        ...expression,
        callee: descend(expression.callee),
        arguments: expression.arguments.map(descend),
      };
    case "field":
      return { ...expression, product: descend(expression.product) };
    case "index":
      return {
        ...expression,
        collection: descend(expression.collection),
        index: descend(expression.index),
      };
    case "product":
      return { ...expression, values: expression.values.map(descend) };
    case "record":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: descend(field.value),
        })),
      };
    case "unionCase":
      return { ...expression, value: descend(expression.value) };
    case "integer":
    case "integer64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
    case "hostCall":
    case "optionDo":
    case "recordUpdate":
    case "function":
    case "recursiveCall":
    case "indexUpdate":
    case "if":
    case "ifUnion":
    case "block":
    case "comptime":
    case "scratch":
    case "loop":
      return expression;
  }
}

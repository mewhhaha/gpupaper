import type {
  TypedDucklangBinding,
  TypedDucklangBlockStep,
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";
import { PrimitiveId } from "./ducklang_primitives.ts";
import {
  ducklangReflectedLayout,
  type DucklangReflectedType,
} from "./ducklang_layout.ts";
import type { DucklangSymbol } from "./ducklang_resolution.ts";
import type { SourceSpan } from "./syntax.ts";

export function specializeStaticDucklangClosures(
  module: TypedDucklangModule,
): TypedDucklangModule {
  const values = new Map<number, TypedDucklangExpression>();
  const rewrittenBindings = module.bindings.map((
    binding,
  ): TypedDucklangBinding => {
    const value = rewriteExpression(binding.value, values);
    values.set(binding.symbol.id, value);
    return { ...binding, value };
  });
  const liftedBindings: TypedDucklangBinding[] = [];
  const liftedFunctionSymbols = new Set<number>();
  const rewrittenResult = rewriteExpression(module.result, values);
  const directFunctionSymbols = new Set<number>();
  const collectDirectFunctions = (
    expression: TypedDucklangExpression,
  ): void => {
    if (expression.kind === "block") {
      for (const step of expression.steps) {
        if (
          step.kind === "binding" && step.binding.value.kind === "function"
        ) {
          directFunctionSymbols.add(step.binding.symbol.id);
        }
      }
    }
    visitDucklangExpressionChildren(expression, collectDirectFunctions);
  };
  for (const binding of rewrittenBindings) {
    if (binding.value.kind === "function") {
      directFunctionSymbols.add(binding.symbol.id);
    }
    collectDirectFunctions(binding.value);
  }
  collectDirectFunctions(rewrittenResult);
  let nextSymbolId = Math.max(0, ...module.symbolTypes.keys()) + 1;
  const allocateSymbolId = (): number => {
    const symbolId = nextSymbolId;
    nextSymbolId += 1;
    return symbolId;
  };
  const bindings = rewrittenBindings.map((binding) => ({
    ...binding,
    value: liftGeneratedFunctions(
      binding.value,
      liftedBindings,
      liftedFunctionSymbols,
      directFunctionSymbols,
      allocateSymbolId,
    ),
  }));
  const result = liftGeneratedFunctions(
    rewrittenResult,
    liftedBindings,
    liftedFunctionSymbols,
    directFunctionSymbols,
    allocateSymbolId,
  );
  bindings.push(...liftedBindings);

  const bindingsBySymbol = new Map(
    bindings.map((binding) => [binding.symbol.id, binding]),
  );
  const reachable = new Set<number>();
  const visit = (expression: TypedDucklangExpression): void => {
    if (expression.kind === "reference") {
      if (reachable.has(expression.symbol.id)) return;
      const binding = bindingsBySymbol.get(expression.symbol.id);
      if (binding === undefined) return;
      reachable.add(expression.symbol.id);
      visit(binding.value);
      return;
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  visit(result);

  return {
    ...module,
    bindings: bindings.filter((binding) =>
      reachable.has(binding.symbol.id) ||
      (binding.stage === "runtime" && binding.value.kind !== "function")
    ),
    result,
  };
}

function liftGeneratedFunctions(
  expression: TypedDucklangExpression,
  liftedBindings: TypedDucklangBinding[],
  liftedFunctionSymbols: Set<number>,
  directFunctionSymbols: Set<number>,
  allocateSymbolId: () => number,
): TypedDucklangExpression {
  if (expression.kind !== "block") {
    return rewriteChildren(
      expression,
      (child) =>
        liftGeneratedFunctions(
          child,
          liftedBindings,
          liftedFunctionSymbols,
          directFunctionSymbols,
          allocateSymbolId,
        ),
    );
  }
  let block = expression;
  for (const originalStep of expression.steps) {
    if (originalStep.kind !== "binding") continue;
    const step = block.steps.find((candidate) =>
      candidate.kind === "binding" &&
      candidate.binding.symbol.id === originalStep.binding.symbol.id
    );
    if (
      step?.kind !== "binding" ||
      step.binding.value.kind !== "function" ||
      (!isGeneratedControlFunction(step.binding) &&
        !isOnlyDirectlyCalled(expression, step.binding.symbol.id))
    ) {
      continue;
    }
    const originalSymbol = step.binding.symbol;
    const functionSymbol = liftedFunctionSymbols.has(originalSymbol.id)
      ? { ...originalSymbol, id: allocateSymbolId() }
      : originalSymbol;
    liftedFunctionSymbols.add(functionSymbol.id);
    directFunctionSymbols.add(functionSymbol.id);
    const functionValue = functionSymbol === originalSymbol
      ? step.binding.value
      : renameSymbolReferences(
        step.binding.value,
        originalSymbol.id,
        functionSymbol,
      ) as Extract<TypedDucklangExpression, { readonly kind: "function" }>;
    const captures = collectFunctionCaptures(
      functionSymbol.id,
      functionValue,
      directFunctionSymbols,
    );
    const captureReferences = captures.map((capture) => ({
      kind: "reference" as const,
      symbol: capture.symbol,
      type: capture.type,
      span: capture.symbol.span,
    }));
    const appendCaptures = (
      candidate: TypedDucklangExpression,
    ): TypedDucklangExpression =>
      appendCallArguments(
        candidate,
        functionSymbol.id,
        captureReferences,
      );
    const preparedFunction = {
      ...functionValue,
      parameters: [
        ...functionValue.parameters,
        ...captures.map((capture) => capture.symbol),
      ],
      body: appendCaptures(functionValue.body),
    } satisfies Extract<
      TypedDucklangExpression,
      { readonly kind: "function" }
    >;
    const liftedFunction = liftGeneratedFunctions(
      preparedFunction,
      liftedBindings,
      liftedFunctionSymbols,
      directFunctionSymbols,
      allocateSymbolId,
    );
    if (liftedFunction.kind !== "function") {
      throw new TypeError(
        `${step.binding.span.file}:${step.binding.span.start}: generated Ducklang control binding ${step.binding.symbol.text} stopped being a function during closure conversion`,
      );
    }
    liftedBindings.push({
      ...step.binding,
      symbol: functionSymbol,
      value: liftedFunction,
    });
    const remainingBlock = {
      ...block,
      steps: removeGeneratedFunctionStep(block.steps, step.binding),
    } satisfies Extract<TypedDucklangExpression, { readonly kind: "block" }>;
    block = appendCaptures(
      functionSymbol === originalSymbol
        ? remainingBlock
        : renameSymbolReferences(
          remainingBlock,
          originalSymbol.id,
          functionSymbol,
        ),
    ) as Extract<TypedDucklangExpression, { readonly kind: "block" }>;
  }
  return rewriteChildren(
    block,
    (child) =>
      liftGeneratedFunctions(
        child,
        liftedBindings,
        liftedFunctionSymbols,
        directFunctionSymbols,
        allocateSymbolId,
      ),
  );
}

function removeGeneratedFunctionStep(
  steps: readonly TypedDucklangBlockStep[],
  binding: TypedDucklangBinding,
): readonly TypedDucklangBlockStep[] {
  let removed = false;
  return steps.filter((step) => {
    if (
      !removed && step.kind === "binding" &&
      step.binding.symbol.id === binding.symbol.id &&
      step.binding.span.start === binding.span.start
    ) {
      removed = true;
      return false;
    }
    return true;
  });
}

function renameSymbolReferences(
  expression: TypedDucklangExpression,
  symbolId: number,
  replacement: Extract<
    TypedDucklangExpression,
    { readonly kind: "reference" }
  >["symbol"],
): TypedDucklangExpression {
  if (
    expression.kind === "reference" && expression.symbol.id === symbolId
  ) {
    return { ...expression, symbol: replacement };
  }
  return rewriteChildren(
    expression,
    (child) => renameSymbolReferences(child, symbolId, replacement),
  );
}

/**
 * Whether a nested function is only ever called, never used as a value.
 *
 * Lifting appends a function's captures to its parameter list and adds matching
 * arguments at each call site. That is sound for a symbol that only appears as a
 * callee. A symbol also used as a value would need a closure carrying the captures,
 * which is a later item, so such a function is left where it is rather than lifted
 * into something whose arity no longer matches its uses.
 *
 * Loop-lowering artifacts skip this check because they are generated as call-only by
 * construction.
 */
function isOnlyDirectlyCalled(
  scope: TypedDucklangExpression,
  symbolId: number,
): boolean {
  let onlyCalled = true;
  const visit = (expression: TypedDucklangExpression): void => {
    if (!onlyCalled) return;
    if (expression.kind === "call") {
      // The callee position is fine; anything else in the call is not.
      if (
        !(expression.callee.kind === "reference" &&
          expression.callee.symbol.id === symbolId)
      ) {
        visit(expression.callee);
      }
      for (const argument of expression.arguments) visit(argument);
      return;
    }
    if (expression.kind === "reference" && expression.symbol.id === symbolId) {
      onlyCalled = false;
      return;
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  visitDucklangExpressionChildren(scope, visit);
  return onlyCalled;
}

function isGeneratedControlFunction(binding: TypedDucklangBinding): boolean {
  return binding.symbol.text.startsWith("$loop_") ||
    binding.symbol.text.startsWith("$range_loop_");
}

type FunctionCapture = {
  readonly symbol: Extract<
    TypedDucklangExpression,
    { readonly kind: "reference" }
  >["symbol"];
  readonly type: TypedDucklangExpression["type"];
};

export type DucklangFunctionFreeVariables = {
  /** Where the function appears, so nested functions stay distinguishable. */
  readonly span: SourceSpan;
  readonly parameters: readonly DucklangSymbol[];
  /** Symbols the body reads that the function neither declares nor parameterises. */
  readonly freeVariables: readonly DucklangSymbol[];
};

/**
 * Free variables of every runtime function in a module, including nested ones.
 *
 * Module-scope symbols are excluded: they are addressable from any function without
 * being captured, so a closure environment never has to carry one. What remains is
 * exactly what an environment would need to hold.
 *
 * The specializer computes the same thing on demand for the functions it rewrites.
 * This exposes it for every function so closure conversion has the whole picture
 * rather than the subset one pass happened to need.
 */
export function ducklangFunctionFreeVariables(
  module: TypedDucklangModule,
): readonly DucklangFunctionFreeVariables[] {
  const moduleFunctions = new Set(
    module.bindings.flatMap((binding) =>
      binding.value.kind === "function" ? [binding.symbol.id] : []
    ),
  );
  const results: DucklangFunctionFreeVariables[] = [];
  const visit = (
    expression: TypedDucklangExpression,
    owner: number | undefined,
  ): void => {
    if (expression.kind === "function") {
      results.push({
        span: expression.span,
        parameters: expression.parameters,
        freeVariables: collectFunctionCaptures(
          owner ?? -1,
          expression,
          moduleFunctions,
        ).map((capture) => capture.symbol),
      });
    }
    visitDucklangExpressionChildren(
      expression,
      (child) => visit(child, owner),
    );
  };
  for (const binding of module.bindings) {
    visit(binding.value, binding.symbol.id);
  }
  visit(module.result, undefined);
  return results;
}

function collectFunctionCaptures(
  functionSymbolId: number,
  function_: Extract<TypedDucklangExpression, { readonly kind: "function" }>,
  directFunctionSymbols: ReadonlySet<number>,
): readonly FunctionCapture[] {
  const defined = new Set([
    functionSymbolId,
    ...function_.parameters.map((parameter) => parameter.id),
    ...directFunctionSymbols,
  ]);
  collectDefinedSymbols(function_.body, defined);
  const captures = new Map<number, FunctionCapture>();
  const visit = (expression: TypedDucklangExpression): void => {
    if (
      expression.kind === "reference" &&
      expression.symbol.scope !== "module" &&
      !defined.has(expression.symbol.id) &&
      !captures.has(expression.symbol.id)
    ) {
      captures.set(expression.symbol.id, {
        symbol: expression.symbol,
        type: expression.type,
      });
      return;
    }
    visitDucklangExpressionChildren(expression, visit);
  };
  visit(function_.body);
  return [...captures.values()];
}

function collectDefinedSymbols(
  expression: TypedDucklangExpression,
  symbols: Set<number>,
): void {
  if (expression.kind === "function") {
    for (const parameter of expression.parameters) symbols.add(parameter.id);
  }
  if (expression.kind === "ifUnion" && expression.payloadSymbol !== undefined) {
    symbols.add(expression.payloadSymbol.id);
  }
  if (expression.kind === "block") {
    for (const step of expression.steps) {
      if (step.kind === "binding") symbols.add(step.binding.symbol.id);
    }
  }
  visitDucklangExpressionChildren(
    expression,
    (child) => collectDefinedSymbols(child, symbols),
  );
}

function appendCallArguments(
  expression: TypedDucklangExpression,
  functionSymbolId: number,
  arguments_: readonly TypedDucklangExpression[],
): TypedDucklangExpression {
  const rewritten = rewriteChildren(
    expression,
    (child) => appendCallArguments(child, functionSymbolId, arguments_),
  );
  if (
    rewritten.kind !== "call" || rewritten.callee.kind !== "reference" ||
    rewritten.callee.symbol.id !== functionSymbolId
  ) {
    return rewritten;
  }
  return {
    ...rewritten,
    arguments: [...rewritten.arguments, ...arguments_],
  };
}

function rewriteExpression(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  if (expression.kind === "reference") {
    const value = values.get(expression.symbol.id);
    if (value !== undefined && isInlineableScalar(value)) {
      return {
        ...value,
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      value?.kind === "reference" && value.symbol.id !== expression.symbol.id
    ) {
      return {
        ...value,
        type: expression.type,
        span: expression.span,
      };
    }
  }
  if (expression.kind === "block") {
    return rewriteBlock(expression, values);
  }
  const rewritten = rewriteChildren(
    expression,
    (child) => rewriteExpression(child, values),
  );
  if (
    rewritten.kind === "comptime" &&
    rewritten.context === "valuePattern"
  ) {
    return {
      ...rewritten,
      expression: staticValue(rewritten.expression, values),
    };
  }
  if (rewritten.kind === "ownership") {
    return rewritten.expression;
  }
  if (rewritten.kind === "optionDo") {
    const option = staticValue(rewritten.option, values);
    if (option.kind === "unionCase" && option.caseName === "Some") {
      return option.value;
    }
    if (option.kind === "unionCase" && option.caseName === "None") {
      throw new TypeError(
        `${rewritten.span.file}:${rewritten.span.start}: static Ducklang do encountered None without handler lowering`,
      );
    }
  }
  if (rewritten.kind === "scratch") {
    const body = collapseEmptyBlock(rewritten.body);
    return body;
  }
  if (rewritten.kind === "textAppend") {
    const left = staticValue(rewritten.left, values);
    const right = staticValue(rewritten.right, values);
    if (left.kind === "string" && right.kind === "string") {
      return {
        kind: "string",
        value: left.value + right.value,
        type: rewritten.type,
        span: rewritten.span,
      };
    }
  }
  if (rewritten.kind === "index") {
    const collection = staticValue(rewritten.collection, values);
    const index = staticValue(rewritten.index, values);
    if (collection.kind === "string" && index.kind === "integer") {
      const bytes = new TextEncoder().encode(collection.value);
      if (index.value < 0 || index.value >= bytes.length) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang text index ${index.value} is outside byte length ${bytes.length}`,
        );
      }
      return {
        kind: "integer",
        value: bytes[index.value],
        type: rewritten.type,
        span: rewritten.span,
      };
    }
    if (
      collection.kind === "product" &&
      collection.productKind === "array" && index.kind === "integer"
    ) {
      const value = collection.values[index.value];
      if (value === undefined) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang array index ${index.value} is outside length ${collection.values.length}`,
        );
      }
      return value;
    }
    if (collection.kind === "product" && collection.nominalType !== undefined) {
      if (index.kind === "integer") {
        const value = collection.values[index.value];
        if (value === undefined) {
          throw new RangeError(
            `${rewritten.span.file}:${rewritten.span.start}: Ducklang struct index ${index.value} is outside ${collection.values.length} fields`,
          );
        }
        return value;
      }
      return {
        kind: "selectProductElement",
        values: collection.values,
        index,
        type: rewritten.type,
        span: rewritten.span,
      };
    }
  }
  if (rewritten.kind === "project") {
    const product = staticValue(rewritten.product, values);
    if (product.kind === "product") {
      const value = product.values[rewritten.index];
      if (value === undefined) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang tuple projection ${rewritten.index} is outside arity ${product.values.length}`,
        );
      }
      return value;
    }
    if (product.kind === "if") {
      return rewriteExpression({
        ...product,
        consequence: {
          kind: "project",
          product: product.consequence,
          index: rewritten.index,
          type: rewritten.type,
          span: rewritten.span,
        },
        alternative: {
          kind: "project",
          product: product.alternative,
          index: rewritten.index,
          type: rewritten.type,
          span: rewritten.span,
        },
        type: rewritten.type,
        span: rewritten.span,
      }, values);
    }
  }
  if (rewritten.kind === "recordUpdate") {
    const product = staticValue(rewritten.product, values);
    if (product.kind === "product") {
      const updatedValues = [...product.values];
      for (const field of rewritten.fields) {
        updatedValues[field.index] = field.value;
      }
      return { ...product, values: updatedValues, type: rewritten.type };
    }
  }
  if (rewritten.kind === "indexUpdate") {
    const product = staticValue(rewritten.product, values);
    const index = staticValue(rewritten.index, values);
    if (product.kind === "product" && index.kind === "integer") {
      if (product.values[index.value] === undefined) {
        throw new RangeError(
          `${rewritten.span.file}:${rewritten.span.start}: Ducklang struct assignment index ${index.value} is outside ${product.values.length} fields`,
        );
      }
      const updatedValues = [...product.values];
      updatedValues[index.value] = rewritten.value;
      return { ...product, values: updatedValues, type: rewritten.type };
    }
  }
  if (rewritten.kind === "ifUnion") {
    const value = staticValue(rewritten.value, values);
    if (value.kind === "unionCase") {
      const matches = value.unionName === rewritten.unionName &&
        value.caseName === rewritten.caseName;
      const selected = matches ? rewritten.consequence : rewritten.alternative;
      if (
        matches && rewritten.payloadSymbol !== undefined
      ) {
        return rewriteExpression(
          substitute(
            selected,
            new Map([[rewritten.payloadSymbol.id, value.value]]),
          ),
          values,
        );
      }
      return rewriteExpression(selected, values);
    }
    if (value.kind === "if") {
      return rewriteExpression({
        ...value,
        consequence: {
          ...rewritten,
          value: value.consequence,
        },
        alternative: {
          ...rewritten,
          value: value.alternative,
        },
        type: rewritten.type,
        span: rewritten.span,
      }, values);
    }
  }
  if (rewritten.kind === "if") {
    const condition = staticValue(rewritten.condition, values);
    if (condition.kind === "boolean" || condition.kind === "integer") {
      const selected = condition.kind === "boolean"
        ? condition.value
        : condition.value !== 0;
      return rewriteExpression(
        selected ? rewritten.consequence : rewritten.alternative,
        values,
      );
    }
  }
  const foldedBinary = foldStaticBinary(rewritten, values);
  if (foldedBinary !== undefined) return foldedBinary;
  const foldedIntrinsic = foldStaticIntrinsic(rewritten, values);
  if (foldedIntrinsic !== undefined) return foldedIntrinsic;
  if (rewritten.kind !== "call") return collapseEmptyBlock(rewritten);
  const selectedCallee = staticValue(rewritten.callee, values);
  if (selectedCallee.kind === "if") {
    return rewriteExpression({
      ...selectedCallee,
      consequence: {
        kind: "call",
        callee: selectedCallee.consequence,
        arguments: rewritten.arguments,
        type: rewritten.type,
        span: rewritten.span,
      },
      alternative: {
        kind: "call",
        callee: selectedCallee.alternative,
        arguments: rewritten.arguments,
        type: rewritten.type,
        span: rewritten.span,
      },
      type: rewritten.type,
      span: rewritten.span,
    }, values);
  }
  if (selectedCallee.kind === "ifUnion") {
    return rewriteExpression({
      ...selectedCallee,
      consequence: {
        kind: "call",
        callee: selectedCallee.consequence,
        arguments: rewritten.arguments,
        type: rewritten.type,
        span: rewritten.span,
      },
      alternative: {
        kind: "call",
        callee: selectedCallee.alternative,
        arguments: rewritten.arguments,
        type: rewritten.type,
        span: rewritten.span,
      },
      type: rewritten.type,
      span: rewritten.span,
    }, values);
  }
  if (
    rewritten.arguments.length === 0 &&
    selectedCallee.kind !== "function" &&
    selectedCallee.type.kind !== "function"
  ) {
    return {
      ...selectedCallee,
      type: rewritten.type,
      span: rewritten.span,
    };
  }
  const factory = selectedCallee;
  if (
    factory.kind !== "function" || factory.recursive ||
    factory.parameters.length !== rewritten.arguments.length
  ) {
    return collapseEmptyBlock(rewritten);
  }
  const factoryBody = inlineableFunctionBody(factory.body);
  if (factoryBody === undefined) return collapseEmptyBlock(rewritten);
  const returnsFunction = rewritten.type.kind === "function";
  const returnsAggregate = rewritten.type.kind === "constructor" &&
    (rewritten.type.name === "tuple" || rewritten.type.name === "array");
  const specializesFunctionParameter = factory.parameters.some(
    (parameter, index) =>
      referencesSymbol(factoryBody, parameter.id) &&
      staticValue(rewritten.arguments[index], values).kind === "function",
  );
  const specializesTextParameter = factory.parameters.some(
    (parameter, index) =>
      referencesSymbol(factoryBody, parameter.id) &&
      staticValue(rewritten.arguments[index], values).kind === "string",
  );
  const specializesUnionParameter = factory.parameters.some(
    (parameter, index) =>
      referencesSymbol(factoryBody, parameter.id) &&
      staticValue(rewritten.arguments[index], values).kind === "unionCase",
  );
  const specializesProductParameter = factory.parameters.some(
    (parameter, index) =>
      referencesSymbol(factoryBody, parameter.id) &&
      staticValue(rewritten.arguments[index], values).kind === "product",
  );
  const specializesIntrinsicParameter = factory.parameters.some(
    (parameter, index) => {
      const argument = staticValue(rewritten.arguments[index], values);
      return argument.kind === "intrinsic" &&
        (isCalledParameter(factoryBody, parameter.id) ||
          (argument.modulePath.startsWith("duck:type/") &&
            referencesSymbol(factoryBody, parameter.id)));
    },
  );
  const specializesCompileTimeParameter = factory.parameters.some(
    (parameter) => parameter.compileTimeRecord === true,
  );
  const inlinesFunctionLiteral = rewritten.callee.kind === "function";
  if (
    !returnsFunction && !returnsAggregate && !inlinesFunctionLiteral &&
    !specializesFunctionParameter && !specializesTextParameter &&
    !specializesUnionParameter && !specializesProductParameter &&
    !specializesIntrinsicParameter && !specializesCompileTimeParameter
  ) {
    return collapseEmptyBlock(rewritten);
  }
  const substitutions = new Map(
    factory.parameters.map((parameter, index) => [
      parameter.id,
      rewritten.arguments[index],
    ]),
  );
  return rewriteExpression(substitute(factoryBody, substitutions), values);
}

function inlineableFunctionBody(
  body: TypedDucklangExpression,
): TypedDucklangExpression | undefined {
  const collapsed = collapseEmptyBlock(body);
  if (collapsed.kind === "return") return collapsed.expression;
  return containsReturn(collapsed) ? undefined : collapsed;
}

function containsReturn(expression: TypedDucklangExpression): boolean {
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === "return") return true;
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
  return false;
}

function referencesSymbol(
  expression: TypedDucklangExpression,
  symbolId: number,
): boolean {
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.kind === "reference" && current.symbol.id === symbolId
    ) {
      return true;
    }
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
  return false;
}

function rewriteBlock(
  block: Extract<TypedDucklangExpression, { readonly kind: "block" }>,
  outerValues: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  const values = new Map(outerValues);
  const steps = block.steps.map((step): TypedDucklangBlockStep => {
    if (step.kind === "expression") {
      return {
        kind: "expression",
        expression: rewriteExpression(step.expression, values),
      };
    }
    const binding = {
      ...step.binding,
      value: rewriteExpression(step.binding.value, values),
    };
    values.set(binding.symbol.id, binding.value);
    return { kind: "binding", binding };
  });
  const result = rewriteExpression(block.result, values);
  const live = new Set<number>();
  collectReferences(result, live);
  const retained: TypedDucklangBlockStep[] = [];
  for (const step of steps.toReversed()) {
    if (step.kind === "expression") {
      collectReferences(step.expression, live);
      retained.push(step);
      continue;
    }
    const referenced = live.delete(step.binding.symbol.id);
    if (!referenced && step.binding.stage === "compileTime") continue;
    collectReferences(step.binding.value, live);
    retained.push(step);
  }
  return collapseEmptyBlock({
    ...block,
    steps: retained.toReversed(),
    result,
  });
}

function isInlineableScalar(
  expression: TypedDucklangExpression,
): expression is Extract<
  TypedDucklangExpression,
  {
    readonly kind:
      | "integer"
      | "integer64"
      | "float32"
      | "float64"
      | "boolean"
      | "unit"
      | "string";
  }
> {
  return expression.kind === "integer" ||
    expression.kind === "integer64" ||
    expression.kind === "float32" ||
    expression.kind === "float64" ||
    expression.kind === "boolean" ||
    expression.kind === "unit" ||
    expression.kind === "string";
}

function collectReferences(
  expression: TypedDucklangExpression,
  references: Set<number>,
): void {
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === "reference") {
      references.add(current.symbol.id);
      continue;
    }
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
}

function isCalledParameter(
  expression: TypedDucklangExpression,
  parameterId: number,
): boolean {
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.kind === "call" && current.callee.kind === "reference" &&
      current.callee.symbol.id === parameterId
    ) {
      return true;
    }
    visitDucklangExpressionChildren(current, (child) => pending.push(child));
  }
  return false;
}

function foldStaticBinary(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression | undefined {
  if (expression.kind !== "binary") return undefined;
  const left = staticValue(expression.left, values);
  const right = staticValue(expression.right, values);
  if (
    (expression.operator === "==" || expression.operator === "!=") &&
    left.kind === "string" && right.kind === "string"
  ) {
    const equal = left.value === right.value;
    return {
      kind: "boolean",
      value: expression.operator === "==" ? equal : !equal,
      type: expression.type,
      span: expression.span,
    };
  }
  if (left.kind !== "integer" || right.kind !== "integer") return undefined;
  const comparison = expression.operator === "=="
    ? left.value === right.value
    : expression.operator === "!="
    ? left.value !== right.value
    : expression.operator === "<"
    ? left.value < right.value
    : expression.operator === "<="
    ? left.value <= right.value
    : expression.operator === ">"
    ? left.value > right.value
    : expression.operator === ">="
    ? left.value >= right.value
    : undefined;
  if (comparison !== undefined) {
    return {
      kind: "boolean",
      value: comparison,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    (expression.operator === "/" || expression.operator === "%") &&
    right.value === 0
  ) {
    return undefined;
  }
  const value = expression.operator === "+"
    ? (left.value + right.value) | 0
    : expression.operator === "-"
    ? (left.value - right.value) | 0
    : expression.operator === "*"
    ? Math.imul(left.value, right.value)
    : expression.operator === "/"
    ? Math.trunc(left.value / right.value) | 0
    : expression.operator === "%"
    ? (left.value % right.value) | 0
    : undefined;
  return value === undefined ? undefined : {
    kind: "integer",
    value,
    type: expression.type,
    span: expression.span,
  };
}

/**
 * The `$TypeDescription` value `@describe_type` answers with.
 *
 * The struct is synthesised by the parser whenever a source mentions
 * `@describe_type`, and inference types the call as that struct, so this builds the
 * product that matches rather than introducing a shape of its own.
 */
function typeDescription(
  size: number,
  expression: TypedDucklangExpression,
): TypedDucklangExpression {
  return {
    kind: "product",
    productKind: "tuple",
    values: [{
      kind: "integer",
      value: size,
      type: { kind: "constructor", name: "i32", arguments: [] },
      span: expression.span,
    }],
    nominalType: "$TypeDescription",
    type: expression.type,
    span: expression.span,
  };
}

function foldStaticIntrinsic(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression | undefined {
  if (expression.kind !== "call") return undefined;
  const callee = staticValue(expression.callee, values);
  const arguments_ = expression.arguments.map((argument) =>
    staticValue(argument, values)
  );
  if (callee.kind === "primitive") {
    if (
      callee.primitiveId === PrimitiveId.bytesGenerate &&
      arguments_.length === 2 && arguments_[0].kind === "integer" &&
      arguments_[1].kind === "function"
    ) {
      expression = { ...expression, arguments: arguments_ };
    }
    if (
      callee.primitiveId === PrimitiveId.booleanNot &&
      arguments_.length === 1
    ) {
      return {
        kind: "binary",
        operator: "==",
        left: arguments_[0],
        right: {
          kind: "boolean",
          value: false,
          type: arguments_[0].type,
          span: expression.span,
        },
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bytesGenerate &&
      arguments_.length === 2 && arguments_[1].kind === "function" &&
      arguments_[1].parameters.length === 1 &&
      !referencesSymbol(
        arguments_[1].body,
        arguments_[1].parameters[0].id,
      )
    ) {
      return {
        ...expression,
        callee: {
          ...callee,
          primitiveId: PrimitiveId.bytesFill,
          type: {
            kind: "function",
            parameter: arguments_[0].type,
            result: {
              kind: "function",
              parameter: arguments_[1].body.type,
              result: expression.type,
            },
          },
        },
        arguments: [arguments_[0], arguments_[1].body],
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bytesGenerate &&
      arguments_.length === 2 && arguments_[0].kind === "integer" &&
      arguments_[1].kind === "function"
    ) {
      return expression;
    }
    if (
      callee.primitiveId === PrimitiveId.panic && arguments_.length === 1 &&
      arguments_[0].kind === "string"
    ) {
      return { ...expression, callee, arguments: [] };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferLength &&
      arguments_.length === 1 && arguments_[0].kind === "if"
    ) {
      return rewriteExpression({
        ...arguments_[0],
        consequence: {
          ...expression,
          arguments: [arguments_[0].consequence],
        },
        alternative: {
          ...expression,
          arguments: [arguments_[0].alternative],
        },
        type: expression.type,
        span: expression.span,
      }, values);
    }
    if (
      callee.primitiveId === PrimitiveId.bufferLength &&
      arguments_.length === 1 && arguments_[0].kind === "string"
    ) {
      return {
        kind: "integer",
        value: new TextEncoder().encode(arguments_[0].value).length,
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferAppend &&
      arguments_.length === 2 && arguments_[0].kind === "string" &&
      arguments_[1].kind === "string"
    ) {
      return {
        kind: "string",
        value: arguments_[0].value + arguments_[1].value,
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferGet &&
      arguments_.length === 2 && arguments_[0].kind === "string" &&
      arguments_[1].kind === "integer"
    ) {
      const bytes = new TextEncoder().encode(arguments_[0].value);
      const index = arguments_[1].value;
      if (index < 0 || index >= bytes.length) {
        throw new RangeError(
          `${expression.span.file}:${expression.span.start}: Ducklang text index ${index} is outside byte length ${bytes.length}`,
        );
      }
      return {
        kind: "integer",
        value: bytes[index],
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId === PrimitiveId.bufferGet &&
      arguments_.length === 2 && arguments_[0].kind === "string"
    ) {
      return {
        kind: "selectProductElement",
        values: [...new TextEncoder().encode(arguments_[0].value)].map(
          (value): TypedDucklangExpression => ({
            kind: "integer",
            value,
            type: expression.type,
            span: expression.span,
          }),
        ),
        index: expression.arguments[1],
        type: expression.type,
        span: expression.span,
      };
    }
    if (
      callee.primitiveId !== PrimitiveId.bufferSlice ||
      arguments_.length !== 3 || arguments_[0].kind !== "string" ||
      arguments_[1].kind !== "integer" || arguments_[2].kind !== "integer"
    ) {
      return { ...expression, callee, arguments: arguments_ };
    }
    const bytes = new TextEncoder().encode(arguments_[0].value);
    const start = arguments_[1].value;
    const end = arguments_[2].value;
    if (start < 0 || end < start || end > bytes.length) {
      throw new RangeError(
        `${expression.span.file}:${expression.span.start}: Ducklang slice range ${start}..${end} is outside text byte length ${bytes.length}`,
      );
    }
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(start, end),
      );
    } catch (cause) {
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: Ducklang static slice ${start}..${end} splits a UTF-8 sequence`,
        { cause },
      );
    }
    return {
      kind: "string",
      value,
      type: expression.type,
      span: expression.span,
    };
  }
  if (callee.kind !== "intrinsic") return undefined;
  if (
    (callee.modulePath === "duck:prelude" ||
      callee.modulePath === "duck:prelude/types") &&
    callee.exportName === "cast" && arguments_.length === 2
  ) {
    return {
      ...expression.arguments[0],
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/testing" &&
    (callee.exportName === "assert" ||
      callee.exportName === "assert_false") &&
    expression.arguments.length === 1
  ) {
    const unit: TypedDucklangExpression = {
      kind: "unit",
      type: expression.type,
      span: expression.span,
    };
    const panic: TypedDucklangExpression = {
      kind: "call",
      callee: {
        kind: "primitive",
        primitiveId: PrimitiveId.panic,
        type: {
          kind: "function",
          parameter: { kind: "constructor", name: "text", arguments: [] },
          result: expression.type,
        },
        span: expression.span,
      },
      arguments: [],
      type: expression.type,
      span: expression.span,
    };
    const assertsTruth = callee.exportName === "assert";
    return rewriteExpression({
      kind: "if",
      condition: expression.arguments[0],
      consequence: assertsTruth ? unit : panic,
      alternative: assertsTruth ? panic : unit,
      type: expression.type,
      span: expression.span,
    }, values);
  }
  if (
    callee.modulePath === "duck:compiler/string-pattern" &&
    arguments_.length === 3 && arguments_[0].kind === "string" &&
    arguments_[1].kind === "string" && arguments_[2].kind === "string"
  ) {
    const value = arguments_[0].value;
    const prefix = arguments_[1].value;
    const suffix = arguments_[2].value;
    const matches = value.length >= prefix.length + suffix.length &&
      value.startsWith(prefix) && value.endsWith(suffix);
    if (callee.exportName === "matches") {
      return {
        kind: "boolean",
        value: matches,
        type: expression.type,
        span: expression.span,
      };
    }
    if (callee.exportName === "capture") {
      return {
        kind: "string",
        value: matches
          ? value.slice(prefix.length, value.length - suffix.length)
          : "",
        type: expression.type,
        span: expression.span,
      };
    }
  }
  if (
    callee.modulePath === "duck:compiler/reflect" &&
    callee.exportName === "describe_type" && arguments_.length === 1 &&
    arguments_[0].kind === "intrinsic" &&
    arguments_[0].modulePath.startsWith("duck:type/")
  ) {
    // The descriptor payload already carries the field types, so the size comes from
    // the same layout rules Core uses rather than from arithmetic invented here.
    // A builtin carries its bare source name while a struct carries a JSON payload,
    // so the shape has to be decided before parsing rather than after.
    if (arguments_[0].modulePath === "duck:type/builtin") {
      return typeDescription(
        ducklangReflectedLayout({
          kind: "builtin",
          name: arguments_[0].exportName,
        }).size,
        expression,
      );
    }
    const payload = JSON.parse(arguments_[0].exportName) as {
      readonly fields?: readonly { readonly type: string }[];
      readonly layout?: { readonly size: number };
    };
    // `reflectDucklangTypes` precomputes the layout when it has the declaration table,
    // which is the only way a nested or generic field can be answered. A bare struct
    // name resolved straight to an intrinsic carries no layout, so scalar fields are
    // laid out from the payload and anything else is refused rather than guessed.
    if (payload.layout !== undefined) {
      return typeDescription(payload.layout.size, expression);
    }
    const reflected: DucklangReflectedType = {
      kind: "struct",
      fields: payload.fields ?? [],
    };
    return {
      kind: "product",
      productKind: "tuple",
      values: [{
        kind: "integer",
        value: ducklangReflectedLayout(reflected).size,
        type: { kind: "constructor", name: "i32", arguments: [] },
        span: expression.span,
      }],
      nominalType: "$TypeDescription",
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:compiler/type-pattern" &&
    callee.exportName === "matches" && arguments_.length === 2 &&
    arguments_[0].kind === "intrinsic" &&
    arguments_[0].modulePath.startsWith("duck:type/") &&
    arguments_[1].kind === "string"
  ) {
    const declaration = JSON.parse(arguments_[0].exportName) as {
      readonly fields?: readonly {
        readonly name: string;
        readonly type: string;
      }[];
    };
    const pattern = JSON.parse(arguments_[1].value) as {
      readonly kind: string;
      readonly fields: readonly {
        readonly name: string;
        readonly type: string;
      }[];
      readonly open: boolean;
    };
    const declarationKind = arguments_[0].modulePath.slice(
      "duck:type/".length,
    );
    const declarationFields = declaration.fields ?? [];
    const fieldsMatch = pattern.fields.every((expected) =>
      declarationFields.some((field) =>
        field.name === expected.name && field.type === expected.type
      )
    );
    return {
      kind: "boolean",
      value: declarationKind === pattern.kind && fieldsMatch &&
        (pattern.open || declarationFields.length === pattern.fields.length),
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    ((callee.modulePath === "duck:prelude/functional" &&
      (callee.exportName === "apply" || callee.exportName === "pipe")) ||
      (callee.modulePath === "duck:prelude/abstractions" &&
        (callee.exportName === "patch_apply" ||
          callee.exportName === "predicate_test"))) &&
    arguments_.length === 2
  ) {
    const piped = callee.exportName === "pipe";
    const functionIndex = piped ? 1 : 0;
    const argumentIndex = piped ? 0 : 1;
    if (arguments_[functionIndex].kind !== "function") return undefined;
    return {
      kind: "call",
      callee: expression.arguments[functionIndex],
      arguments: [expression.arguments[argumentIndex]],
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    ((callee.modulePath === "duck:prelude/functional" &&
      callee.exportName === "identity") ||
      (callee.modulePath === "duck:prelude/abstractions" &&
        (callee.exportName === "patch" ||
          callee.exportName === "predicate"))) && arguments_.length === 1
  ) {
    return expression.arguments[0];
  }
  if (
    callee.modulePath === "duck:prelude/functional" &&
    callee.exportName === "option_unwrap_or" && arguments_.length === 2 &&
    arguments_[1].kind === "unionCase"
  ) {
    return arguments_[1].caseName === "Some"
      ? arguments_[1].value
      : expression.arguments[0];
  }
  if (
    callee.modulePath.startsWith("duck:struct/") &&
    callee.exportName === "new" && arguments_.length === 1
  ) {
    return expression.arguments[0];
  }
  if (
    ((callee.modulePath === "duck:prelude/functional" &&
      callee.exportName === "compose") ||
      (callee.modulePath === "duck:prelude/abstractions" &&
        callee.exportName === "patch_compose")) &&
    arguments_.length === 2 &&
    arguments_[0].kind === "function" &&
    arguments_[0].type.kind === "function" &&
    arguments_[0].parameters.length === 1 &&
    arguments_[1].kind === "function" &&
    arguments_[1].type.kind === "function" &&
    arguments_[1].parameters.length === 1
  ) {
    const parameter = arguments_[1].parameters[0];
    const parameterReference: TypedDucklangExpression = {
      kind: "reference",
      symbol: parameter,
      type: arguments_[1].type.parameter,
      span: expression.span,
    };
    const intermediate: TypedDucklangExpression = {
      kind: "call",
      callee: expression.arguments[1],
      arguments: [parameterReference],
      type: arguments_[1].body.type,
      span: expression.span,
    };
    return {
      kind: "function",
      recursive: false,
      parameters: [parameter],
      body: {
        kind: "call",
        callee: expression.arguments[0],
        arguments: [intermediate],
        type: arguments_[0].body.type,
        span: expression.span,
      },
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/abstractions" &&
    callee.exportName === "predicate_and" && arguments_.length === 2 &&
    arguments_[0].kind === "function" &&
    arguments_[0].type.kind === "function" &&
    arguments_[0].parameters.length === 1 &&
    arguments_[1].kind === "function"
  ) {
    const parameter = arguments_[0].parameters[0];
    const predicateResultType = arguments_[0].body.type;
    const parameterReference: TypedDucklangExpression = {
      kind: "reference",
      symbol: parameter,
      type: arguments_[0].type.parameter,
      span: expression.span,
    };
    return {
      kind: "function",
      recursive: false,
      parameters: [parameter],
      body: {
        kind: "binary",
        operator: "&&",
        left: {
          kind: "call",
          callee: expression.arguments[0],
          arguments: [parameterReference],
          type: predicateResultType,
          span: expression.span,
        },
        right: {
          kind: "call",
          callee: expression.arguments[1],
          arguments: [parameterReference],
          type: predicateResultType,
          span: expression.span,
        },
        type: predicateResultType,
        span: expression.span,
      },
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/abstractions" &&
    callee.exportName === "span" && arguments_.length === 2
  ) {
    return {
      kind: "product",
      productKind: "tuple",
      values: expression.arguments,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.modulePath === "duck:prelude/abstractions" &&
    callee.exportName === "span_contains" && arguments_.length === 2 &&
    arguments_[0].kind === "product" &&
    arguments_[0].values[0]?.kind === "integer" &&
    arguments_[0].values[1]?.kind === "integer" &&
    arguments_[1].kind === "integer"
  ) {
    return {
      kind: "boolean",
      value: arguments_[0].values[0].value <= arguments_[1].value &&
        arguments_[1].value < arguments_[0].values[1].value,
      type: expression.type,
      span: expression.span,
    };
  }
  return undefined;
}

function staticValue(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  const visited = new Set<number>();
  let value = expression;
  while (true) {
    if (value.kind === "comptime") {
      value = value.expression;
      continue;
    }
    if (value.kind !== "reference" || visited.has(value.symbol.id)) break;
    visited.add(value.symbol.id);
    const resolved = values.get(value.symbol.id);
    if (resolved === undefined) break;
    value = resolved;
  }
  return value;
}

function substitute(
  expression: TypedDucklangExpression,
  substitutions: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  const rewritten = new WeakMap<object, TypedDucklangExpression>();
  const pending: {
    readonly expression: TypedDucklangExpression;
    readonly childrenVisited: boolean;
  }[] = [{ expression, childrenVisited: false }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (rewritten.has(current.expression)) continue;
    if (current.expression.kind === "reference") {
      rewritten.set(
        current.expression,
        substitutions.get(current.expression.symbol.id) ?? current.expression,
      );
      continue;
    }
    if (!current.childrenVisited) {
      pending.push({ ...current, childrenVisited: true });
      visitDucklangExpressionChildren(current.expression, (child) => {
        if (!rewritten.has(child)) {
          pending.push({ expression: child, childrenVisited: false });
        }
      });
      continue;
    }
    rewritten.set(
      current.expression,
      rewriteChildren(current.expression, (child) => {
        const result = rewritten.get(child);
        if (result !== undefined) return result;
        throw new Error(
          `${current.expression.span.file}:${current.expression.span.start}: Ducklang substitution visited a parent before its child`,
        );
      }),
    );
  }
  return rewritten.get(expression)!;
}

function collapseEmptyBlock(
  expression: TypedDucklangExpression,
): TypedDucklangExpression {
  if (expression.kind === "block" && expression.steps.length === 0) {
    return expression.result;
  }
  return expression;
}

export function rewriteChildren(
  expression: TypedDucklangExpression,
  rewrite: (child: TypedDucklangExpression) => TypedDucklangExpression,
): TypedDucklangExpression {
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "intrinsic":
    case "primitive":
    case "reference":
      return expression;
    case "unionCase":
      return { ...expression, value: rewrite(expression.value) };
    case "product":
      return { ...expression, values: expression.values.map(rewrite) };
    case "project":
      return { ...expression, product: rewrite(expression.product) };
    case "namedProject":
      return { ...expression, product: rewrite(expression.product) };
    case "recordUpdate":
      return {
        ...expression,
        product: rewrite(expression.product),
        fields: expression.fields.map((field) => ({
          ...field,
          value: rewrite(field.value),
        })),
      };
    case "function":
      return { ...expression, body: rewrite(expression.body) };
    case "call":
      return {
        ...expression,
        callee: rewrite(expression.callee),
        arguments: expression.arguments.map(rewrite),
      };
    case "hostCall":
      return { ...expression, arguments: expression.arguments.map(rewrite) };
    case "optionDo":
      return { ...expression, option: rewrite(expression.option) };
    case "index":
      return {
        ...expression,
        collection: rewrite(expression.collection),
        index: rewrite(expression.index),
      };
    case "selectProductElement":
      return {
        ...expression,
        values: expression.values.map(rewrite),
        index: rewrite(expression.index),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: rewrite(expression.product),
        index: rewrite(expression.index),
        value: rewrite(expression.value),
      };
    case "textAppend":
      return {
        ...expression,
        left: rewrite(expression.left),
        right: rewrite(expression.right),
      };
    case "binary":
      return {
        ...expression,
        left: rewrite(expression.left),
        right: rewrite(expression.right),
      };
    case "ownership":
      return { ...expression, expression: rewrite(expression.expression) };
    case "return":
    case "comptime":
      return { ...expression, expression: rewrite(expression.expression) };
    case "scratch":
      return { ...expression, body: rewrite(expression.body) };
    case "if":
      return {
        ...expression,
        condition: rewrite(expression.condition),
        consequence: rewrite(expression.consequence),
        alternative: rewrite(expression.alternative),
      };
    case "ifUnion":
      return {
        ...expression,
        value: rewrite(expression.value),
        consequence: rewrite(expression.consequence),
        alternative: rewrite(expression.alternative),
      };
    case "block":
      return {
        ...expression,
        steps: expression.steps.map((step): TypedDucklangBlockStep =>
          step.kind === "expression"
            ? { kind: "expression", expression: rewrite(step.expression) }
            : {
              kind: "binding",
              binding: {
                ...step.binding,
                value: rewrite(step.binding.value),
              },
            }
        ),
        result: rewrite(expression.result),
      };
  }
}

export function visitDucklangExpressionChildren(
  expression: TypedDucklangExpression,
  visit: (child: TypedDucklangExpression) => void,
): void {
  rewriteChildren(expression, (child) => {
    visit(child);
    return child;
  });
}

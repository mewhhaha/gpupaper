import type {
  TypedDucklangBinding,
  TypedDucklangBlockStep,
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";

export function specializeStaticDucklangClosures(
  module: TypedDucklangModule,
): TypedDucklangModule {
  const values = new Map<number, TypedDucklangExpression>();
  const bindings = module.bindings.map((binding): TypedDucklangBinding => {
    const value = rewriteExpression(binding.value, values);
    values.set(binding.symbol.id, value);
    return { ...binding, value };
  });
  let result = rewriteExpression(module.result, values);
  if (result.kind === "block") {
    const retainedSteps: TypedDucklangBlockStep[] = [];
    for (const step of result.steps) {
      if (
        step.kind !== "binding" ||
        !step.binding.symbol.text.startsWith("$range_loop_") ||
        step.binding.value.kind !== "function"
      ) {
        retainedSteps.push(step);
        continue;
      }
      const permittedSymbols = new Set([
        step.binding.symbol.id,
        ...step.binding.value.parameters.map((parameter) => parameter.id),
      ]);
      const pending = [step.binding.value.body];
      let capturedSymbol: string | undefined;
      while (pending.length > 0 && capturedSymbol === undefined) {
        const expression = pending.pop();
        if (expression === undefined) break;
        if (
          expression.kind === "reference" &&
          expression.symbol.scope !== "module" &&
          !permittedSymbols.has(expression.symbol.id)
        ) {
          capturedSymbol = expression.symbol.text;
          break;
        }
        visitChildren(expression, (child) => pending.push(child));
      }
      if (capturedSymbol !== undefined) {
        throw new TypeError(
          `${module.file}:${step.binding.span.start}: generated Ducklang range function ${step.binding.symbol.text} captures ${capturedSymbol}`,
        );
      }
      bindings.push(step.binding);
    }
    result = { ...result, steps: retainedSteps };
  }

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
    visitChildren(expression, visit);
  };
  visit(result);

  return {
    ...module,
    bindings: bindings.filter((binding) => reachable.has(binding.symbol.id)),
    result,
  };
}

function rewriteExpression(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression {
  if (expression.kind === "block") {
    return rewriteBlock(expression, values);
  }
  const rewritten = rewriteChildren(
    expression,
    (child) => rewriteExpression(child, values),
  );
  if (rewritten.kind === "ownership") {
    const ownedValue = staticValue(rewritten.expression, values);
    if (ownedValue.kind === "string") return ownedValue;
  }
  if (rewritten.kind === "hostCall") {
    const runtimeArguments = rewritten.arguments.filter((argument) =>
      staticValue(argument, values).kind !== "string"
    );
    if (runtimeArguments.length !== rewritten.arguments.length) {
      return { ...rewritten, arguments: runtimeArguments };
    }
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
    if (body.kind === "string") return body;
    if (
      rewritten.type.kind === "constructor" &&
      rewritten.type.arguments.length === 0 &&
      ["i32", "i64", "bool"].includes(rewritten.type.name)
    ) {
      return body;
    }
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
      isCalledParameter(factoryBody, parameter.id) &&
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
  const inlinesFunctionLiteral = rewritten.callee.kind === "function";
  if (
    !returnsFunction && !returnsAggregate && !inlinesFunctionLiteral &&
    !specializesFunctionParameter && !specializesTextParameter &&
    !specializesUnionParameter && !specializesProductParameter &&
    !specializesIntrinsicParameter
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
  if (expression.kind === "return") return true;
  let found = false;
  visitChildren(expression, (child) => {
    if (!found && containsReturn(child)) found = true;
  });
  return found;
}

function referencesSymbol(
  expression: TypedDucklangExpression,
  symbolId: number,
): boolean {
  if (
    expression.kind === "reference" && expression.symbol.id === symbolId
  ) {
    return true;
  }
  let found = false;
  visitChildren(expression, (child) => {
    if (!found && referencesSymbol(child, symbolId)) found = true;
  });
  return found;
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
    if (!live.delete(step.binding.symbol.id)) continue;
    collectReferences(step.binding.value, live);
    retained.push(step);
  }
  return collapseEmptyBlock({
    ...block,
    steps: retained.toReversed(),
    result,
  });
}

function collectReferences(
  expression: TypedDucklangExpression,
  references: Set<number>,
): void {
  if (expression.kind === "reference") {
    references.add(expression.symbol.id);
    return;
  }
  visitChildren(expression, (child) => collectReferences(child, references));
}

function isCalledParameter(
  expression: TypedDucklangExpression,
  parameterId: number,
): boolean {
  if (
    expression.kind === "call" && expression.callee.kind === "reference" &&
    expression.callee.symbol.id === parameterId
  ) {
    return true;
  }
  let found = false;
  visitChildren(expression, (child) => {
    if (!found && isCalledParameter(child, parameterId)) found = true;
  });
  return found;
}

function foldStaticBinary(
  expression: TypedDucklangExpression,
  values: ReadonlyMap<number, TypedDucklangExpression>,
): TypedDucklangExpression | undefined {
  if (expression.kind !== "binary" || expression.operator !== "==") {
    return undefined;
  }
  const left = staticValue(expression.left, values);
  const right = staticValue(expression.right, values);
  if (left.kind !== "string" || right.kind !== "string") return undefined;
  return {
    kind: "boolean",
    value: left.value === right.value,
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
  if (
    callee.kind !== "intrinsic"
  ) {
    return undefined;
  }
  const arguments_ = expression.arguments.map((argument) =>
    staticValue(argument, values)
  );
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
  if (callee.modulePath !== "duck:prelude/runtime") return undefined;
  if (
    callee.exportName === "length" && arguments_.length === 1 &&
    arguments_[0].kind === "if"
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
    callee.exportName === "length" && arguments_.length === 1 &&
    arguments_[0].kind === "string"
  ) {
    return {
      kind: "integer",
      value: new TextEncoder().encode(arguments_[0].value).length,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.exportName === "append" && arguments_.length === 2 &&
    arguments_[0].kind === "string" && arguments_[1].kind === "string"
  ) {
    return {
      kind: "string",
      value: arguments_[0].value + arguments_[1].value,
      type: expression.type,
      span: expression.span,
    };
  }
  if (
    callee.exportName === "get" && arguments_.length === 2 &&
    arguments_[0].kind === "string" && arguments_[1].kind === "integer"
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
    callee.exportName !== "slice" || arguments_.length !== 3 ||
    arguments_[0].kind !== "string" || arguments_[1].kind !== "integer" ||
    arguments_[2].kind !== "integer"
  ) {
    return undefined;
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
  if (expression.kind === "reference") {
    return substitutions.get(expression.symbol.id) ?? expression;
  }
  return rewriteChildren(
    expression,
    (child) => substitute(child, substitutions),
  );
}

function collapseEmptyBlock(
  expression: TypedDucklangExpression,
): TypedDucklangExpression {
  if (expression.kind === "block" && expression.steps.length === 0) {
    return expression.result;
  }
  return expression;
}

function rewriteChildren(
  expression: TypedDucklangExpression,
  rewrite: (child: TypedDucklangExpression) => TypedDucklangExpression,
): TypedDucklangExpression {
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "boolean":
    case "unit":
    case "string":
    case "intrinsic":
    case "reference":
      return expression;
    case "unionCase":
      return { ...expression, value: rewrite(expression.value) };
    case "product":
      return { ...expression, values: expression.values.map(rewrite) };
    case "project":
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

function visitChildren(
  expression: TypedDucklangExpression,
  visit: (child: TypedDucklangExpression) => void,
): void {
  rewriteChildren(expression, (child) => {
    visit(child);
    return child;
  });
}

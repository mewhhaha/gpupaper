import type {
  DucklangExpression,
  DucklangExtensionMethod,
  DucklangFixityDeclaration,
  DucklangModule,
  DucklangStatement,
} from "./ducklang_ast.ts";

export function elaborateDucklangExtensions(
  module: DucklangModule,
): DucklangModule {
  const methods = collectExtensionMethods(module);
  const fixities = new Map(
    module.fixities.map((fixity) => [fixity.operator, fixity]),
  );
  validateFixities(module, methods);
  return {
    ...module,
    protocols: [],
    extensions: [],
    fixities: [],
    statements: module.statements.map((statement) =>
      elaborateStatement(statement, methods, fixities)
    ),
  };
}

function collectExtensionMethods(
  module: DucklangModule,
): ReadonlyMap<string, readonly DucklangExtensionMethod[]> {
  const methods = new Map<string, DucklangExtensionMethod[]>();
  for (const extension of module.extensions) {
    for (const method of extension.methods) {
      const implementations = methods.get(method.name) ?? [];
      implementations.push(method);
      methods.set(method.name, implementations);
    }
  }
  return methods;
}

function validateFixities(
  module: DucklangModule,
  methods: ReadonlyMap<string, readonly DucklangExtensionMethod[]>,
): void {
  const protocols = new Map(
    module.protocols.map((protocol) => [protocol.name, protocol]),
  );
  for (const fixity of module.fixities) {
    const protocol = protocols.get(fixity.protocolName);
    if (protocol === undefined) {
      throw new TypeError(
        `${module.file}:${fixity.span.start}: Ducklang fixity ${fixity.operator} targets unknown protocol ${fixity.protocolName}`,
      );
    }
    if (!protocol.methods.includes(fixity.methodName)) {
      throw new TypeError(
        `${module.file}:${fixity.span.start}: Ducklang protocol ${fixity.protocolName} has no method ${fixity.methodName}`,
      );
    }
    selectMethod(fixity.methodName, methods, fixity);
  }
}

function selectMethod(
  methodName: string,
  methods: ReadonlyMap<string, readonly DucklangExtensionMethod[]>,
  use: Pick<DucklangFixityDeclaration, "span">,
): DucklangExtensionMethod {
  const implementations = methods.get(methodName) ?? [];
  if (implementations.length === 1) return implementations[0];
  const evidence = implementations.length === 0
    ? "has no implementation"
    : `has ${implementations.length} implementations and requires type-directed selection`;
  throw new TypeError(
    `${use.span.file}:${use.span.start}: Ducklang extension method ${methodName} ${evidence}`,
  );
}

function elaborateStatement(
  statement: DucklangStatement,
  methods: ReadonlyMap<string, readonly DucklangExtensionMethod[]>,
  fixities: ReadonlyMap<string, DucklangFixityDeclaration>,
): DucklangStatement {
  switch (statement.kind) {
    case "binding":
    case "assignment":
      return {
        ...statement,
        value: elaborateExpression(statement.value, methods, fixities),
      };
    case "unionBinding":
      return {
        ...statement,
        value: elaborateExpression(statement.value, methods, fixities),
        alternative: elaborateExpression(
          statement.alternative,
          methods,
          fixities,
        ),
      };
    case "recursiveGroup":
      return {
        ...statement,
        bindings: statement.bindings.map((binding) => ({
          ...binding,
          value: elaborateExpression(binding.value, methods, fixities),
        })),
      };
    case "productBinding":
      return {
        ...statement,
        value: elaborateExpression(statement.value, methods, fixities),
      };
    case "forRange":
      return {
        ...statement,
        start: elaborateExpression(statement.start, methods, fixities),
        end: elaborateExpression(statement.end, methods, fixities),
        step: statement.step === undefined
          ? undefined
          : elaborateExpression(statement.step, methods, fixities),
        body: elaborateExpression(statement.body, methods, fixities),
      };
    case "forCollection":
      return {
        ...statement,
        collection: elaborateExpression(
          statement.collection,
          methods,
          fixities,
        ),
        body: elaborateExpression(statement.body, methods, fixities),
      };
    case "break":
      return {
        ...statement,
        value: statement.value === undefined
          ? undefined
          : elaborateExpression(statement.value, methods, fixities),
      };
    case "return":
    case "expression":
      return {
        ...statement,
        expression: elaborateExpression(
          statement.expression,
          methods,
          fixities,
        ),
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

function elaborateExpression(
  expression: DucklangExpression,
  methods: ReadonlyMap<string, readonly DucklangExtensionMethod[]>,
  fixities: ReadonlyMap<string, DucklangFixityDeclaration>,
): DucklangExpression {
  const descend = (child: DucklangExpression) =>
    elaborateExpression(child, methods, fixities);
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
      return { ...expression, arguments: expression.arguments.map(descend) };
    case "optionDo":
      return { ...expression, option: descend(expression.option) };
    case "unionCase":
      return { ...expression, value: descend(expression.value) };
    case "product":
      return { ...expression, values: expression.values.map(descend) };
    case "field":
      return { ...expression, product: descend(expression.product) };
    case "recordUpdate":
      return {
        ...expression,
        product: descend(expression.product),
        fields: expression.fields.map((field) => ({
          ...field,
          value: descend(field.value),
        })),
      };
    case "record":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: descend(field.value),
        })),
      };
    case "function":
      return { ...expression, body: descend(expression.body) };
    case "recursiveCall":
      return { ...expression, arguments: expression.arguments.map(descend) };
    case "call": {
      const intrinsic = elaborateWasmIntrinsic(expression, descend);
      if (intrinsic !== undefined) return intrinsic;
      const callee = descend(expression.callee);
      const arguments_ = expression.arguments.map(descend);
      if (
        callee.kind !== "field" || callee.product.kind !== "reference" ||
        !methods.has(callee.fieldName)
      ) {
        return { ...expression, callee, arguments: arguments_ };
      }
      const method = selectMethod(callee.fieldName, methods, expression);
      return applyExtensionMethod(method, arguments_, expression.span, descend);
    }
    case "index":
      return {
        ...expression,
        collection: descend(expression.collection),
        index: descend(expression.index),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: descend(expression.product),
        index: descend(expression.index),
        value: descend(expression.value),
      };
    case "binary": {
      const fixity = fixities.get(expression.operator);
      if (fixity === undefined) {
        return {
          ...expression,
          left: descend(expression.left),
          right: descend(expression.right),
        };
      }
      if (fixity.fixity === "prefix") {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: prefix Ducklang operator ${expression.operator} used as infix`,
        );
      }
      return applyExtensionMethod(
        selectMethod(fixity.methodName, methods, fixity),
        [descend(expression.left), descend(expression.right)],
        expression.span,
        descend,
      );
    }
    case "unary": {
      const fixity = fixities.get(expression.operator);
      if (fixity === undefined) {
        return { ...expression, operand: descend(expression.operand) };
      }
      if (fixity.fixity !== "prefix") {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: infix Ducklang operator ${expression.operator} used as prefix`,
        );
      }
      return applyExtensionMethod(
        selectMethod(fixity.methodName, methods, fixity),
        [descend(expression.operand)],
        expression.span,
        descend,
      );
    }
    case "if":
      return {
        ...expression,
        condition: descend(expression.condition),
        consequence: descend(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : descend(expression.alternative),
      };
    case "ifUnion":
      return {
        ...expression,
        value: descend(expression.value),
        consequence: descend(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : descend(expression.alternative),
      };
    case "block":
      return {
        ...expression,
        statements: expression.statements.map((statement) =>
          elaborateStatement(statement, methods, fixities)
        ),
      };
    case "comptime":
      return { ...expression, expression: descend(expression.expression) };
    case "scratch":
    case "loop":
      return { ...expression, body: descend(expression.body) };
  }
}

function applyExtensionMethod(
  method: DucklangExtensionMethod,
  arguments_: readonly DucklangExpression[],
  span: DucklangExpression["span"],
  descend: (expression: DucklangExpression) => DucklangExpression,
): DucklangExpression {
  const implementation = descend(method.value);
  if (implementation.kind !== "function") {
    return {
      kind: "call",
      callee: implementation,
      arguments: arguments_,
      span,
    };
  }
  if (implementation.parameters.length !== arguments_.length) {
    throw new TypeError(
      `${span.file}:${span.start}: Ducklang extension method ${method.name} expects ${implementation.parameters.length} arguments; received ${arguments_.length}`,
    );
  }
  return substituteExtensionParameters(
    implementation.body,
    new Map(
      implementation.parameters.map((parameter, index) => [
        parameter.text,
        arguments_[index],
      ]),
    ),
  );
}

function substituteExtensionParameters(
  expression: DucklangExpression,
  parameters: ReadonlyMap<string, DucklangExpression>,
): DucklangExpression {
  const descend = (child: DucklangExpression) =>
    substituteExtensionParameters(child, parameters);
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
      return expression;
    case "reference":
      return parameters.get(expression.name.text) ?? expression;
    case "hostCall":
      return { ...expression, arguments: expression.arguments.map(descend) };
    case "optionDo":
      return { ...expression, option: descend(expression.option) };
    case "unionCase":
      return { ...expression, value: descend(expression.value) };
    case "product":
      return { ...expression, values: expression.values.map(descend) };
    case "field":
      return { ...expression, product: descend(expression.product) };
    case "recordUpdate":
      return {
        ...expression,
        product: descend(expression.product),
        fields: expression.fields.map((field) => ({
          ...field,
          value: descend(field.value),
        })),
      };
    case "record":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: descend(field.value),
        })),
      };
    case "function": {
      const bodyParameters = new Map(parameters);
      for (const parameter of expression.parameters) {
        bodyParameters.delete(parameter.text);
      }
      return {
        ...expression,
        body: substituteExtensionParameters(expression.body, bodyParameters),
      };
    }
    case "recursiveCall":
      return { ...expression, arguments: expression.arguments.map(descend) };
    case "call":
      return {
        ...expression,
        callee: descend(expression.callee),
        arguments: expression.arguments.map(descend),
      };
    case "index":
      return {
        ...expression,
        collection: descend(expression.collection),
        index: descend(expression.index),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: descend(expression.product),
        index: descend(expression.index),
        value: descend(expression.value),
      };
    case "binary":
      return {
        ...expression,
        left: descend(expression.left),
        right: descend(expression.right),
      };
    case "unary":
      return { ...expression, operand: descend(expression.operand) };
    case "if":
      return {
        ...expression,
        condition: descend(expression.condition),
        consequence: descend(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : descend(expression.alternative),
      };
    case "ifUnion": {
      const consequenceParameters = new Map(parameters);
      if (expression.payloadName !== undefined) {
        consequenceParameters.delete(expression.payloadName.text);
      }
      return {
        ...expression,
        value: descend(expression.value),
        consequence: substituteExtensionParameters(
          expression.consequence,
          consequenceParameters,
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : descend(expression.alternative),
      };
    }
    case "block":
      return substituteExtensionBlock(expression, parameters);
    case "comptime":
      return { ...expression, expression: descend(expression.expression) };
    case "scratch":
    case "loop":
      return { ...expression, body: descend(expression.body) };
  }
}

function substituteExtensionBlock(
  block: Extract<DucklangExpression, { readonly kind: "block" }>,
  parameters: ReadonlyMap<string, DucklangExpression>,
): DucklangExpression {
  const statementParameters = new Map(parameters);
  const statements = block.statements.map((statement) => {
    const substituted = substituteExtensionStatement(
      statement,
      statementParameters,
    );
    if (statement.kind === "binding" || statement.kind === "assignment") {
      statementParameters.delete(statement.name.text);
    } else if (statement.kind === "unionBinding") {
      statementParameters.delete(statement.name.text);
    } else if (statement.kind === "productBinding") {
      for (const name of statement.names) {
        if (name !== undefined) statementParameters.delete(name.text);
      }
    } else if (statement.kind === "recursiveGroup") {
      for (const binding of statement.bindings) {
        statementParameters.delete(binding.name.text);
      }
    }
    return substituted;
  });
  return { ...block, statements };
}

function substituteExtensionStatement(
  statement: DucklangStatement,
  parameters: ReadonlyMap<string, DucklangExpression>,
): DucklangStatement {
  const descend = (expression: DucklangExpression) =>
    substituteExtensionParameters(expression, parameters);
  switch (statement.kind) {
    case "binding":
    case "assignment":
      return { ...statement, value: descend(statement.value) };
    case "unionBinding":
      return {
        ...statement,
        value: descend(statement.value),
        alternative: descend(statement.alternative),
      };
    case "recursiveGroup": {
      const bodyParameters = new Map(parameters);
      for (const binding of statement.bindings) {
        bodyParameters.delete(binding.name.text);
      }
      return {
        ...statement,
        bindings: statement.bindings.map((binding) => ({
          ...binding,
          value: substituteExtensionParameters(binding.value, bodyParameters),
        })),
      };
    }
    case "productBinding":
      return { ...statement, value: descend(statement.value) };
    case "forRange":
      return {
        ...statement,
        start: descend(statement.start),
        end: descend(statement.end),
        step: statement.step === undefined
          ? undefined
          : descend(statement.step),
        body: descend(statement.body),
      };
    case "forCollection":
      return {
        ...statement,
        collection: descend(statement.collection),
        body: descend(statement.body),
      };
    case "break":
      return {
        ...statement,
        value: statement.value === undefined
          ? undefined
          : descend(statement.value),
      };
    case "return":
    case "expression":
      return { ...statement, expression: descend(statement.expression) };
    case "effectDeclaration":
    case "structType":
    case "unionType":
    case "typeAlias":
    case "import":
    case "continue":
      return statement;
  }
}

function elaborateWasmIntrinsic(
  expression: Extract<DucklangExpression, { readonly kind: "call" }>,
  descend: (expression: DucklangExpression) => DucklangExpression,
): DucklangExpression | undefined {
  const intrinsicName = expression.callee.kind === "reference" &&
      expression.callee.name.text.startsWith("@wasm.")
    ? expression.callee.name.text.slice("@wasm.".length)
    : expression.callee.kind === "field" &&
        expression.callee.product.kind === "reference" &&
        expression.callee.product.name.text === "@wasm"
    ? expression.callee.fieldName
    : undefined;
  if (intrinsicName === undefined) return undefined;
  const operands = expression.arguments.length === 1 &&
      expression.arguments[0].kind === "product"
    ? expression.arguments[0].values
    : expression.arguments;
  if (operands.length !== 2) {
    throw new TypeError(
      `${expression.span.file}:${expression.span.start}: Ducklang ${intrinsicName} expects 2 operands; received ${operands.length}`,
    );
  }
  const operators: Readonly<Record<string, string>> = {
    add_i32: "+",
    eq_i32: "==",
  };
  const operator = operators[intrinsicName];
  if (operator === undefined) {
    throw new TypeError(
      `${expression.span.file}:${expression.span.start}: unsupported Ducklang Wasm intrinsic ${intrinsicName}`,
    );
  }
  return {
    kind: "binary",
    operator,
    left: descend(operands[0]),
    right: descend(operands[1]),
    span: expression.span,
  };
}

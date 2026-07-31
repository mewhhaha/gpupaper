import {
  type DucklangExpression,
  type DucklangExtensionMethod,
  type DucklangFixityDeclaration,
  type DucklangModule,
  type DucklangName,
  ducklangNamedType,
  type DucklangStatement,
  type DucklangTypeReference,
} from "./ducklang_ast.ts";

type ExtensionImplementation = {
  readonly targetType: string;
  readonly method: DucklangExtensionMethod;
};

type ExtensionTypeDeclarations = {
  readonly structFields: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly unionCases: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly aliases: ReadonlyMap<string, DucklangTypeReference>;
  readonly hostOperations: ReadonlyMap<string, string>;
  readonly functions: ReadonlyMap<
    string,
    Extract<DucklangExpression, { readonly kind: "function" }>
  >;
};

export function elaborateDucklangExtensions(
  module: DucklangModule,
): DucklangModule {
  const methods = collectExtensionMethods(module);
  const fixities = new Map(
    module.fixities.map((fixity) => [fixity.operator, fixity]),
  );
  const structDeclarations = module.statements.filter((
    statement,
  ): statement is Extract<DucklangStatement, { readonly kind: "structType" }> =>
    statement.kind === "structType"
  );
  const unionDeclarations = module.statements.filter((
    statement,
  ): statement is Extract<DucklangStatement, { readonly kind: "unionType" }> =>
    statement.kind === "unionType"
  );
  const typeDeclarations = {
    structFields: new Map(
      structDeclarations.map((declaration) => [
        declaration.name,
        new Map(
          declaration.fields.map((field) => [field.name, field.type.name]),
        ),
      ]),
    ),
    unionCases: new Map(
      unionDeclarations.map((declaration) => [
        declaration.name,
        new Map(
          declaration.cases.map((unionCase) => [
            unionCase.name,
            unionCase.payloadType.name,
          ]),
        ),
      ]),
    ),
    aliases: new Map(
      module.statements.flatMap((statement) =>
        statement.kind === "typeAlias"
          ? [[statement.name, statement.target] as const]
          : []
      ),
    ),
    hostOperations: new Map(
      module.statements.flatMap((statement) =>
        statement.kind !== "effectDeclaration"
          ? []
          : statement.operations.map((operation) =>
            [
              `${statement.name}.${operation.name}`,
              operation.resultType.name,
            ] as const
          )
      ),
    ),
    functions: new Map(
      module.statements.flatMap((statement) => {
        if (
          statement.kind === "binding" && statement.value.kind === "function"
        ) {
          return [[statement.name.text, statement.value] as const];
        }
        if (statement.kind !== "recursiveGroup") return [];
        return statement.bindings.flatMap((binding) =>
          binding.value.kind === "function"
            ? [[binding.name.text, binding.value] as const]
            : []
        );
      }),
    ),
  } satisfies ExtensionTypeDeclarations;
  let statements = module.statements;
  const parameterCount = statements.reduce((count, statement) => {
    if (statement.kind === "binding" && statement.value.kind === "function") {
      return count + statement.value.parameters.length;
    }
    if (statement.kind !== "recursiveGroup") return count;
    return count + statement.bindings.reduce(
      (bindingCount, binding) =>
        binding.value.kind === "function"
          ? bindingCount + binding.value.parameters.length
          : bindingCount,
      0,
    );
  }, 0);
  for (let iteration = 0; iteration <= parameterCount; iteration += 1) {
    const applied = applyInferredParameterTypes(
      statements,
      inferParameterTypesFromCalls(statements, typeDeclarations),
    );
    statements = applied.statements;
    if (!applied.changed) break;
    if (iteration === parameterCount) {
      throw new Error(
        `${module.file}:${module.span.start}: Ducklang parameter inference did not reach a fixed point after ${parameterCount} refinements`,
      );
    }
  }
  validateFixities(module, methods);
  return {
    ...module,
    protocols: [],
    extensions: module.extensions.map((extension) => ({
      ...extension,
      methods: extension.methods.filter((method) => method.name === "order"),
    })),
    fixities: [],
    statements: elaborateStatements(
      statements,
      methods,
      fixities,
      new Map(),
      typeDeclarations,
    ),
  };
}

function inferParameterTypesFromCalls(
  statements: readonly DucklangStatement[],
  typeDeclarations: ExtensionTypeDeclarations,
): ReadonlyMap<string, ReadonlyMap<number, string>> {
  const functions = new Map<
    string,
    Extract<
      DucklangExpression,
      { readonly kind: "function" }
    >
  >();
  for (const statement of statements) {
    if (statement.kind === "binding" && statement.value.kind === "function") {
      functions.set(statement.name.text, statement.value);
    }
    if (statement.kind === "recursiveGroup") {
      for (const binding of statement.bindings) {
        if (binding.value.kind === "function") {
          functions.set(binding.name.text, binding.value);
        }
      }
    }
  }
  const inferred = new Map<string, Map<number, string>>();
  const conflictingParameters = new Map<string, Set<number>>();
  const scanExpression = (
    expression: DucklangExpression,
    types: ReadonlyMap<string, string>,
  ): void => {
    if (
      expression.kind === "call" && expression.callee.kind === "reference"
    ) {
      const function_ = functions.get(expression.callee.name.text);
      if (function_ !== undefined) {
        const functionName = expression.callee.name.text;
        const parameterTypes = inferred.get(functionName) ??
          new Map<number, string>();
        const conflicts = conflictingParameters.get(functionName) ??
          new Set<number>();
        expression.arguments.forEach((argument, index) => {
          if (conflicts.has(index)) return;
          const type = expressionTypeName(argument, types, typeDeclarations);
          const previous = parameterTypes.get(index);
          if (type === undefined) return;
          if (previous === undefined || previous === type) {
            parameterTypes.set(index, type);
            return;
          }
          parameterTypes.delete(index);
          conflicts.add(index);
        });
        inferred.set(functionName, parameterTypes);
        conflictingParameters.set(functionName, conflicts);
      }
    }
    if (expression.kind === "function") {
      const bodyTypes = new Map(types);
      expression.parameters.forEach((parameter) => {
        if (parameter.declaredType !== undefined) {
          bodyTypes.set(parameter.text, parameter.declaredType.name);
        }
      });
      scanExpression(expression.body, bodyTypes);
      return;
    }
    if (expression.kind === "block") {
      scanStatements(expression.statements, new Map(types));
      return;
    }
    if (expression.kind === "ifUnion") {
      scanExpression(expression.value, types);
      const consequenceTypes = new Map(types);
      const unionName = expressionTypeName(
        expression.value,
        types,
        typeDeclarations,
      );
      const payloadType = unionName === undefined
        ? undefined
        : typeDeclarations.unionCases.get(unionName)?.get(expression.caseName);
      if (expression.payloadName !== undefined && payloadType !== undefined) {
        consequenceTypes.set(expression.payloadName.text, payloadType);
      }
      scanExpression(expression.consequence, consequenceTypes);
      if (expression.alternative !== undefined) {
        scanExpression(expression.alternative, types);
      }
      return;
    }
    for (const child of expressionChildren(expression)) {
      scanExpression(child, types);
    }
  };
  const scanStatements = (
    scopedStatements: readonly DucklangStatement[],
    types: Map<string, string>,
  ): void => {
    for (const statement of scopedStatements) {
      for (const expression of statementExpressions(statement)) {
        scanExpression(expression, types);
      }
      recordDeclaredTypes(statement, types, typeDeclarations);
      if (statement.kind !== "unionBinding") continue;
      const unionName = expressionTypeName(
        statement.value,
        types,
        typeDeclarations,
      );
      const payloadType = unionName === undefined
        ? undefined
        : typeDeclarations.unionCases.get(unionName)?.get(statement.caseName);
      if (payloadType !== undefined) {
        types.set(statement.name.text, payloadType);
      }
    }
  };
  scanStatements(statements, new Map());
  return inferred;
}

function applyInferredParameterTypes(
  statements: readonly DucklangStatement[],
  inferred: ReadonlyMap<string, ReadonlyMap<number, string>>,
): {
  readonly statements: readonly DucklangStatement[];
  readonly changed: boolean;
} {
  let changed = false;
  const annotateFunction = (
    name: string,
    expression: DucklangExpression,
  ): DucklangExpression => {
    if (expression.kind !== "function") return expression;
    const parameterTypes = inferred.get(name);
    if (parameterTypes === undefined) return expression;
    return {
      ...expression,
      parameters: expression.parameters.map((parameter, index) => {
        const declaredTypeName = parameter.declaredType?.name ??
          parameterTypes.get(index);
        if (
          declaredTypeName === undefined ||
          declaredTypeName === parameter.declaredType?.name
        ) {
          return parameter;
        }
        changed = true;
        return {
          ...parameter,
          declaredType: ducklangNamedType(declaredTypeName, parameter.span),
        };
      }),
    };
  };
  const annotated = statements.map((statement): DucklangStatement => {
    if (statement.kind === "binding") {
      return {
        ...statement,
        value: annotateFunction(statement.name.text, statement.value),
      };
    }
    if (statement.kind !== "recursiveGroup") return statement;
    return {
      ...statement,
      bindings: statement.bindings.map((binding) => ({
        ...binding,
        value: annotateFunction(binding.name.text, binding.value),
      })),
    };
  });
  return { statements: annotated, changed };
}

function statementExpressions(
  statement: DucklangStatement,
): readonly DucklangExpression[] {
  switch (statement.kind) {
    case "binding":
    case "assignment":
      return [statement.value];
    case "unionBinding":
      return [statement.value, statement.alternative];
    case "recursiveGroup":
      return statement.bindings.map((binding) => binding.value);
    case "productBinding":
    case "recordBinding":
      return [statement.value];
    case "typePattern":
      return [statement.target];
    case "forRange":
      return [
        statement.start,
        statement.end,
        ...(statement.step === undefined ? [] : [statement.step]),
        statement.body,
      ];
    case "forCollection":
      return [statement.collection, statement.body];
    case "break":
      return statement.value === undefined ? [] : [statement.value];
    case "return":
    case "expression":
      return [statement.expression];
    case "effectDeclaration":
    case "initDeclaration":
    case "structType":
    case "unionType":
    case "typeAlias":
    case "import":
    case "continue":
      return [];
  }
}

function expressionChildren(
  expression: DucklangExpression,
): readonly DucklangExpression[] {
  const children: DucklangExpression[] = [];
  for (const value of Object.values(expression)) {
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (
          candidate !== null && typeof candidate === "object" &&
          typeof (candidate as { readonly kind?: unknown }).kind === "string"
        ) {
          children.push(candidate as DucklangExpression);
        } else if (
          candidate !== null && typeof candidate === "object" &&
          "value" in candidate
        ) {
          children.push(
            (candidate as { readonly value: DucklangExpression }).value,
          );
        }
      }
      continue;
    }
    if (
      value !== null && typeof value === "object" &&
      typeof (value as { readonly kind?: unknown }).kind === "string"
    ) {
      children.push(value as DucklangExpression);
    }
  }
  return children;
}

function collectExtensionMethods(
  module: DucklangModule,
): ReadonlyMap<string, readonly ExtensionImplementation[]> {
  const methods = new Map<string, ExtensionImplementation[]>();
  for (const extension of module.extensions) {
    for (const method of extension.methods) {
      const implementations = methods.get(method.name) ?? [];
      implementations.push({
        targetType: extension.targetType,
        method,
      });
      methods.set(method.name, implementations);
    }
  }
  return methods;
}

function validateFixities(
  module: DucklangModule,
  methods: ReadonlyMap<string, readonly ExtensionImplementation[]>,
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
    if (!methods.has(fixity.methodName)) {
      throw new TypeError(
        `${module.file}:${fixity.span.start}: Ducklang extension method ${fixity.methodName} has no implementation`,
      );
    }
  }
}

function selectMethod(
  methodName: string,
  methods: ReadonlyMap<string, readonly ExtensionImplementation[]>,
  use: Pick<DucklangFixityDeclaration, "span">,
  receiver: DucklangExpression | undefined,
  types: ReadonlyMap<string, string>,
  typeDeclarations: ExtensionTypeDeclarations,
): DucklangExtensionMethod {
  const implementations = methods.get(methodName) ?? [];
  if (implementations.length === 1) return implementations[0].method;
  const implementationKeys = new Set(
    implementations.map((implementation) =>
      extensionImplementationKey(implementation.method)
    ),
  );
  if (implementationKeys.size === 1 && implementations[0] !== undefined) {
    return implementations[0].method;
  }
  const receiverType = receiver === undefined
    ? undefined
    : expressionTypeName(receiver, types, typeDeclarations);
  let receiverConstructor = receiverType === undefined
    ? undefined
    : typeConstructorName(receiverType);
  const visitedAliases = new Set<string>();
  while (
    receiverConstructor !== undefined &&
    !visitedAliases.has(receiverConstructor)
  ) {
    visitedAliases.add(receiverConstructor);
    const alias = typeDeclarations.aliases.get(receiverConstructor);
    if (alias === undefined) break;
    receiverConstructor = typeConstructorName(alias.name);
  }
  const matching = receiverConstructor === undefined
    ? []
    : implementations.filter((implementation) =>
      typeConstructorName(implementation.targetType) === receiverConstructor
    );
  if (matching.length === 1) return matching[0].method;
  const evidence = implementations.length === 0
    ? "has no implementation"
    : receiverType !== undefined && matching.length === 0
    ? `has no implementation for ${receiverType}`
    : matching.length > 1
    ? `has ${matching.length} incoherent implementations for ${receiverType}`
    : `has ${implementations.length} implementations and requires type-directed selection`;
  throw new TypeError(
    `${use.span.file}:${use.span.start}: Ducklang extension method ${methodName} ${evidence}`,
  );
}

function typeConstructorName(typeName: string): string {
  // The trailing `$` discriminator is part of the constructor's identity, not a type
  // argument. Matching only letters, digits, and underscores truncated a
  // file-qualified name like `Shape$85a31555` to `Shape`, so it stopped matching the
  // extension that targeted it and selection reported no implementation for a name it
  // was holding an implementation for. A space still ends the match, so type
  // arguments are dropped as before.
  return typeName.replace(/^&/, "")
    .match(/^[A-Za-z_][A-Za-z0-9_]*(?:\$[0-9a-f]{8})?/)?.[0] ??
    typeName;
}

function extensionImplementationKey(method: DucklangExtensionMethod): string {
  return JSON.stringify(method.value, (key, value) => {
    if (
      key === "span" || key === "declaredType" ||
      key === "declaredEffectRow"
    ) {
      return undefined;
    }
    return value;
  });
}

function elaborateStatements(
  statements: readonly DucklangStatement[],
  methods: ReadonlyMap<string, readonly ExtensionImplementation[]>,
  fixities: ReadonlyMap<string, DucklangFixityDeclaration>,
  parentTypes: ReadonlyMap<string, string>,
  typeDeclarations: ExtensionTypeDeclarations,
): readonly DucklangStatement[] {
  const types = new Map(parentTypes);
  const indexedCollections = new Map<string, DucklangExpression>();
  const result: DucklangStatement[] = [];
  for (const statement of statements) {
    let sourceStatement = statement;
    if (
      statement.kind === "expression" &&
      statement.expression.kind === "call" &&
      statement.expression.callee.kind === "reference" &&
      statement.expression.callee.name.text === "iterator_count" &&
      statement.expression.arguments[0]?.kind === "reference"
    ) {
      const collection = indexedCollections.get(
        statement.expression.arguments[0].name.text,
      );
      if (collection !== undefined) {
        sourceStatement = {
          ...statement,
          expression: {
            ...statement.expression,
            callee: {
              ...statement.expression.callee,
              name: {
                ...statement.expression.callee.name,
                text: "$indexed_collection_count",
              },
            },
            arguments: [collection, ...statement.expression.arguments.slice(1)],
          },
        };
      }
    }
    const elaboratedStatement = elaborateStatement(
      sourceStatement,
      methods,
      fixities,
      types,
      typeDeclarations,
    );
    if (
      statement.kind === "binding" &&
      statement.value.kind === "call" &&
      statement.value.callee.kind === "field" &&
      statement.value.callee.fieldName === "iterator" &&
      statement.value.callee.product.kind === "reference" &&
      statement.value.callee.product.name.text === "IntoIterator" &&
      statement.value.arguments.length === 1
    ) {
      indexedCollections.set(statement.name.text, statement.value.arguments[0]);
    }
    recordDeclaredTypes(statement, types, typeDeclarations);
    if (
      statement.kind === "forCollection" &&
      elaboratedStatement.kind === "expression" &&
      elaboratedStatement.expression.kind === "block" &&
      elaboratedStatement.expression.statements[0]?.kind === "binding" &&
      elaboratedStatement.expression.statements[0].name.text.startsWith(
        "$iterator_state_",
      )
    ) {
      result.push(...elaboratedStatement.expression.statements);
      continue;
    }
    result.push(elaboratedStatement);
  }
  return result;
}

function elaborateStatement(
  statement: DucklangStatement,
  methods: ReadonlyMap<string, readonly ExtensionImplementation[]>,
  fixities: ReadonlyMap<string, DucklangFixityDeclaration>,
  types: ReadonlyMap<string, string>,
  typeDeclarations: ExtensionTypeDeclarations,
): DucklangStatement {
  switch (statement.kind) {
    case "binding":
    case "assignment":
      return {
        ...statement,
        value: elaborateExpression(
          statement.value,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
      };
    case "unionBinding":
      return {
        ...statement,
        value: elaborateExpression(
          statement.value,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
        alternative: elaborateExpression(
          statement.alternative,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
      };
    case "recursiveGroup":
      return {
        ...statement,
        bindings: statement.bindings.map((binding) => ({
          ...binding,
          value: elaborateExpression(
            binding.value,
            methods,
            fixities,
            types,
            typeDeclarations,
          ),
        })),
      };
    case "productBinding":
    case "recordBinding":
      return {
        ...statement,
        value: elaborateExpression(
          statement.value,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
      };
    case "typePattern":
      return {
        ...statement,
        target: elaborateExpression(
          statement.target,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
      };
    case "forRange":
      return {
        ...statement,
        start: elaborateExpression(
          statement.start,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
        end: elaborateExpression(
          statement.end,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
        step: statement.step === undefined ? undefined : elaborateExpression(
          statement.step,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
        body: elaborateExpression(
          statement.body,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
      };
    case "forCollection": {
      const collection = elaborateExpression(
        statement.collection,
        methods,
        fixities,
        types,
        typeDeclarations,
      );
      const body = elaborateExpression(
        statement.body,
        methods,
        fixities,
        types,
        typeDeclarations,
      );
      const collectionType = expressionTypeName(
        collection,
        types,
        typeDeclarations,
      );
      if (
        collectionType === undefined ||
        collectionType === "Bytes" ||
        collectionType === "Text"
      ) {
        return { ...statement, collection, body };
      }
      const collectionConstructor = typeConstructorName(collectionType);
      if (
        !methods.get("has_next")?.some((implementation) =>
          implementation.targetType === collectionConstructor
        ) ||
        !methods.get("next")?.some((implementation) =>
          implementation.targetType === collectionConstructor
        )
      ) {
        return { ...statement, collection, body };
      }
      const hasNextMethod = selectMethod(
        "has_next",
        methods,
        statement,
        collection,
        types,
        typeDeclarations,
      );
      const nextMethod = selectMethod(
        "next",
        methods,
        statement,
        collection,
        types,
        typeDeclarations,
      );

      const stateName: DucklangName = {
        text: `$iterator_state_${statement.span.start}`,
        declaredType: ducklangNamedType(collectionType, statement.span),
        span: statement.span,
      };
      const nextStateName: DucklangName = {
        text: `$iterator_next_state_${statement.span.start}`,
        declaredType: ducklangNamedType(collectionType, statement.span),
        span: statement.span,
      };
      const stateReference: DucklangExpression = {
        kind: "reference",
        name: stateName,
        span: statement.span,
      };
      const loopStatements: DucklangStatement[] = [
        {
          kind: "expression",
          expression: {
            kind: "if",
            condition: {
              kind: "unary",
              operator: "!",
              operand: applyExtensionMethod(
                hasNextMethod,
                [stateReference],
                statement.span,
                (expression) =>
                  elaborateExpression(
                    expression,
                    methods,
                    fixities,
                    types,
                    typeDeclarations,
                  ),
              ),
              span: statement.span,
            },
            consequence: {
              kind: "block",
              statements: [{
                kind: "break",
                value: undefined,
                span: statement.span,
              }],
              span: statement.span,
            },
            alternative: undefined,
            span: statement.span,
          },
          span: statement.span,
        },
        {
          kind: "productBinding",
          declarationKind: "let",
          productKind: "tuple",
          names: [statement.value, nextStateName],
          value: applyExtensionMethod(
            nextMethod,
            [stateReference],
            statement.span,
            (expression) =>
              elaborateExpression(
                expression,
                methods,
                fixities,
                types,
                typeDeclarations,
              ),
          ),
          span: statement.span,
        },
        {
          kind: "assignment",
          operator: "=",
          name: stateName,
          value: {
            kind: "reference",
            name: nextStateName,
            span: statement.span,
          },
          span: statement.span,
        },
      ];
      if (statement.index !== undefined) {
        const positionName: DucklangName = {
          text: `$iterator_position_${statement.span.start}`,
          declaredType: ducklangNamedType("I32", statement.span),
          span: statement.span,
        };
        loopStatements.push(
          {
            kind: "binding",
            declarationKind: "let",
            recursive: false,
            name: statement.index,
            value: {
              kind: "reference",
              name: positionName,
              span: statement.span,
            },
            span: statement.span,
          },
          {
            kind: "assignment",
            operator: "=",
            name: positionName,
            value: {
              kind: "binary",
              operator: "+",
              left: {
                kind: "reference",
                name: positionName,
                span: statement.span,
              },
              right: {
                kind: "integer",
                value: 1,
                span: statement.span,
              },
              span: statement.span,
            },
            span: statement.span,
          },
        );
      }
      loopStatements.push({
        kind: "expression",
        expression: statement.caseName === undefined ? body : {
          kind: "ifUnion",
          caseName: statement.caseName,
          payloadName: statement.value,
          value: {
            kind: "reference",
            name: statement.value,
            span: statement.span,
          },
          consequence: body,
          alternative: undefined,
          span: statement.span,
        },
        span: statement.span,
      });
      const prefixStatements: DucklangStatement[] = [{
        kind: "binding",
        declarationKind: "let",
        recursive: false,
        name: stateName,
        value: collection,
        span: statement.span,
      }];
      if (statement.index !== undefined) {
        prefixStatements.push({
          kind: "binding",
          declarationKind: "let",
          recursive: false,
          name: {
            text: `$iterator_position_${statement.span.start}`,
            declaredType: ducklangNamedType("I32", statement.span),
            span: statement.span,
          },
          value: { kind: "integer", value: 0, span: statement.span },
          span: statement.span,
        });
      }
      return {
        kind: "expression",
        expression: {
          kind: "block",
          statements: [
            ...prefixStatements,
            {
              kind: "expression",
              expression: {
                kind: "loop",
                body: {
                  kind: "block",
                  statements: loopStatements,
                  span: statement.span,
                },
                span: statement.span,
              },
              span: statement.span,
            },
          ],
          span: statement.span,
        },
        span: statement.span,
      };
    }
    case "break":
      return {
        ...statement,
        value: statement.value === undefined ? undefined : elaborateExpression(
          statement.value,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
      };
    case "return":
    case "expression":
      return {
        ...statement,
        expression: elaborateExpression(
          statement.expression,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
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

function elaborateExpression(
  expression: DucklangExpression,
  methods: ReadonlyMap<string, readonly ExtensionImplementation[]>,
  fixities: ReadonlyMap<string, DucklangFixityDeclaration>,
  types: ReadonlyMap<string, string>,
  typeDeclarations: ExtensionTypeDeclarations,
): DucklangExpression {
  const descend = (child: DucklangExpression) =>
    elaborateExpression(
      child,
      methods,
      fixities,
      types,
      typeDeclarations,
    );
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
    case "reference": {
      const declaredType = types.get(expression.name.text);
      return declaredType === undefined ? expression : {
        ...expression,
        name: {
          ...expression.name,
          declaredType: ducklangNamedType(declaredType, expression.name.span),
        },
      };
    }
    case "hostCall":
      return { ...expression, arguments: expression.arguments.map(descend) };
    case "effectHandler":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: descend(field.value),
        })),
      };
    case "handle":
      return {
        ...expression,
        body: descend(expression.body),
        handler: descend(expression.handler),
      };
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
      const bodyTypes = new Map(types);
      for (const parameter of expression.parameters) {
        if (parameter.declaredType !== undefined) {
          bodyTypes.set(parameter.text, parameter.declaredType.name);
        }
      }
      return {
        ...expression,
        body: elaborateExpression(
          expression.body,
          methods,
          fixities,
          bodyTypes,
          typeDeclarations,
        ),
      };
    }
    case "recursiveCall":
      return { ...expression, arguments: expression.arguments.map(descend) };
    case "call": {
      const intrinsic = elaborateWasmIntrinsic(expression, descend);
      if (intrinsic !== undefined) return intrinsic;
      const callee = descend(expression.callee);
      const arguments_ = expression.arguments.map(descend);
      if (
        callee.kind === "reference" &&
        callee.name.text === "$indexed_collection_count" &&
        arguments_.length === 2
      ) {
        const countName = {
          text: `$indexed_collection_count_${expression.span.start}`,
          declaredType: ducklangNamedType("I32", expression.span),
          span: expression.span,
        };
        const valueName = {
          text: `$indexed_collection_value_${expression.span.start}`,
          declaredType: ducklangNamedType("I32", expression.span),
          span: expression.span,
        };
        const countReference: DucklangExpression = {
          kind: "reference",
          name: countName,
          span: expression.span,
        };
        return {
          kind: "block",
          statements: [
            {
              kind: "binding",
              declarationKind: "let",
              recursive: false,
              name: countName,
              value: {
                kind: "integer",
                value: 0,
                span: expression.span,
              },
              span: expression.span,
            },
            {
              kind: "forCollection",
              index: undefined,
              value: valueName,
              caseName: undefined,
              collection: arguments_[0],
              body: {
                kind: "block",
                statements: [{
                  kind: "expression",
                  expression: {
                    kind: "if",
                    condition: {
                      kind: "call",
                      callee: arguments_[1],
                      arguments: [{
                        kind: "reference",
                        name: valueName,
                        span: expression.span,
                      }],
                      span: expression.span,
                    },
                    consequence: {
                      kind: "block",
                      statements: [{
                        kind: "assignment",
                        operator: "=",
                        name: countName,
                        value: {
                          kind: "binary",
                          operator: "+",
                          left: countReference,
                          right: {
                            kind: "integer",
                            value: 1,
                            span: expression.span,
                          },
                          span: expression.span,
                        },
                        span: expression.span,
                      }],
                      span: expression.span,
                    },
                    alternative: undefined,
                    span: expression.span,
                  },
                  span: expression.span,
                }],
                span: expression.span,
              },
              span: expression.span,
            },
            {
              kind: "expression",
              expression: countReference,
              span: expression.span,
            },
          ],
          span: expression.span,
        };
      }
      if (
        callee.kind === "reference" &&
        callee.name.text === "iterator_count" &&
        arguments_.length === 2
      ) {
        const countName = {
          text: `$iterator_count_${expression.span.start}`,
          declaredType: ducklangNamedType("I32", expression.span),
          span: expression.span,
        };
        const sourceName = {
          text: `$iterator_source_${expression.span.start}`,
          span: expression.span,
        };
        const stateName = {
          text: `$iterator_state_${expression.span.start}`,
          span: expression.span,
        };
        const valueName = {
          text: `$iterator_value_${expression.span.start}`,
          span: expression.span,
        };
        const nextStateName = {
          text: `$iterator_next_state_${expression.span.start}`,
          span: expression.span,
        };
        const countReference: DucklangExpression = {
          kind: "reference",
          name: countName,
          span: expression.span,
        };
        const sourceReference: DucklangExpression = {
          kind: "reference",
          name: sourceName,
          span: expression.span,
        };
        const stateReference: DucklangExpression = {
          kind: "reference",
          name: stateName,
          span: expression.span,
        };
        const valueReference: DucklangExpression = {
          kind: "reference",
          name: valueName,
          span: expression.span,
        };
        return {
          kind: "block",
          statements: [
            {
              kind: "binding",
              declarationKind: "let",
              recursive: false,
              name: sourceName,
              value: arguments_[0],
              span: expression.span,
            },
            {
              kind: "binding",
              declarationKind: "let",
              recursive: false,
              name: stateName,
              value: {
                kind: "field",
                product: sourceReference,
                fieldName: "state",
                span: expression.span,
              },
              span: expression.span,
            },
            {
              kind: "binding",
              declarationKind: "let",
              recursive: false,
              name: countName,
              value: {
                kind: "integer",
                value: 0,
                span: expression.span,
              },
              span: expression.span,
            },
            {
              kind: "expression",
              expression: {
                kind: "loop",
                body: {
                  kind: "block",
                  statements: [
                    {
                      kind: "expression",
                      expression: {
                        kind: "if",
                        condition: {
                          kind: "unary",
                          operator: "!",
                          operand: {
                            kind: "call",
                            callee: {
                              kind: "field",
                              product: sourceReference,
                              fieldName: "has_next",
                              span: expression.span,
                            },
                            arguments: [stateReference],
                            span: expression.span,
                          },
                          span: expression.span,
                        },
                        consequence: {
                          kind: "block",
                          statements: [{
                            kind: "break",
                            value: undefined,
                            span: expression.span,
                          }],
                          span: expression.span,
                        },
                        alternative: undefined,
                        span: expression.span,
                      },
                      span: expression.span,
                    },
                    {
                      kind: "productBinding",
                      declarationKind: "let",
                      productKind: "tuple",
                      names: [valueName, nextStateName],
                      value: {
                        kind: "call",
                        callee: {
                          kind: "field",
                          product: sourceReference,
                          fieldName: "next",
                          span: expression.span,
                        },
                        arguments: [stateReference],
                        span: expression.span,
                      },
                      span: expression.span,
                    },
                    {
                      kind: "assignment",
                      operator: "=",
                      name: stateName,
                      value: {
                        kind: "reference",
                        name: nextStateName,
                        span: expression.span,
                      },
                      span: expression.span,
                    },
                    {
                      kind: "expression",
                      expression: {
                        kind: "if",
                        condition: {
                          kind: "call",
                          callee: arguments_[1],
                          arguments: [valueReference],
                          span: expression.span,
                        },
                        consequence: {
                          kind: "block",
                          statements: [{
                            kind: "assignment",
                            operator: "=",
                            name: countName,
                            value: {
                              kind: "binary",
                              operator: "+",
                              left: countReference,
                              right: {
                                kind: "integer",
                                value: 1,
                                span: expression.span,
                              },
                              span: expression.span,
                            },
                            span: expression.span,
                          }],
                          span: expression.span,
                        },
                        alternative: undefined,
                        span: expression.span,
                      },
                      span: expression.span,
                    },
                  ],
                  span: expression.span,
                },
                span: expression.span,
              },
              span: expression.span,
            },
            {
              kind: "expression",
              expression: countReference,
              span: expression.span,
            },
          ],
          span: expression.span,
        };
      }
      if (
        callee.kind !== "field" || !methods.has(callee.fieldName)
      ) {
        return { ...expression, callee, arguments: arguments_ };
      }
      const receiverType = expressionTypeName(
        callee.product,
        types,
        typeDeclarations,
      );
      const fieldCouldBelongToStruct = [...typeDeclarations.structFields]
        .some(([structName, fields]) =>
          fields.get(callee.fieldName) === "$function" &&
          (receiverType === undefined ||
            typeConstructorName(receiverType) === structName)
        );
      if (fieldCouldBelongToStruct) {
        return { ...expression, callee, arguments: arguments_ };
      }
      if (
        callee.product.kind === "reference" &&
        /^[A-Z]/.test(callee.product.name.text)
      ) {
        const method = selectMethod(
          callee.fieldName,
          methods,
          expression,
          arguments_[0],
          types,
          typeDeclarations,
        );
        return applyExtensionMethod(
          method,
          arguments_,
          expression.span,
          descend,
        );
      }
      const method = selectMethod(
        callee.fieldName,
        methods,
        expression,
        callee.product,
        types,
        typeDeclarations,
      );
      if (
        method.value.kind === "function" &&
        method.value.parameters.length === arguments_.length
      ) {
        return { ...expression, callee, arguments: arguments_ };
      }
      return applyExtensionMethod(
        method,
        [callee.product, ...arguments_],
        expression.span,
        descend,
      );
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
        selectMethod(
          fixity.methodName,
          methods,
          fixity,
          expression.left,
          types,
          typeDeclarations,
        ),
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
        selectMethod(
          fixity.methodName,
          methods,
          fixity,
          expression.operand,
          types,
          typeDeclarations,
        ),
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
    case "ifUnion": {
      const value = descend(expression.value);
      const consequenceTypes = new Map(types);
      const unionName = expressionTypeName(
        value,
        types,
        typeDeclarations,
      );
      const payloadType = unionName === undefined
        ? undefined
        : typeDeclarations.unionCases.get(unionName)?.get(expression.caseName);
      if (expression.payloadName !== undefined && payloadType !== undefined) {
        consequenceTypes.set(expression.payloadName.text, payloadType);
      }
      return {
        ...expression,
        value,
        consequence: elaborateExpression(
          expression.consequence,
          methods,
          fixities,
          consequenceTypes,
          typeDeclarations,
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : descend(expression.alternative),
      };
    }
    case "block":
      return {
        ...expression,
        statements: elaborateStatements(
          expression.statements,
          methods,
          fixities,
          types,
          typeDeclarations,
        ),
      };
    case "comptime":
      return { ...expression, expression: descend(expression.expression) };
    case "scratch":
    case "loop":
      return { ...expression, body: descend(expression.body) };
  }
}

function recordDeclaredTypes(
  statement: DucklangStatement,
  types: Map<string, string>,
  typeDeclarations: ExtensionTypeDeclarations,
): void {
  if (statement.kind === "binding" || statement.kind === "assignment") {
    if (statement.name.declaredType !== undefined) {
      types.set(statement.name.text, statement.name.declaredType.name);
      return;
    }
    const inferredType = expressionTypeName(
      statement.value,
      types,
      typeDeclarations,
    );
    if (inferredType !== undefined) {
      types.set(statement.name.text, inferredType);
    }
    return;
  }
  if (statement.kind !== "recursiveGroup") return;
  for (const binding of statement.bindings) {
    if (binding.name.declaredType !== undefined) {
      types.set(binding.name.text, binding.name.declaredType.name);
    }
  }
}

function expressionTypeName(
  expression: DucklangExpression,
  types: ReadonlyMap<string, string>,
  typeDeclarations: ExtensionTypeDeclarations,
  resolvingFunctions: ReadonlySet<string> = new Set(),
): string | undefined {
  switch (expression.kind) {
    case "integer":
      return "I32";
    case "integer64":
      return "I64";
    case "float32":
      return "F32";
    case "float64":
      return "F64";
    case "boolean":
      return "Bool";
    case "string":
      return "Text";
    case "unit":
      return "Unit";
    case "hostCall":
      return typeDeclarations.hostOperations.get(
        `${expression.effectName}.${expression.operationName}`,
      );
    case "reference":
      return types.get(expression.name.text);
    case "field": {
      const productType = expressionTypeName(
        expression.product,
        types,
        typeDeclarations,
      );
      if (productType !== undefined) {
        return typeDeclarations.structFields.get(
          typeConstructorName(productType),
        )?.get(expression.fieldName);
      }
      const fieldTypes = new Set(
        [...typeDeclarations.structFields.values()].flatMap((fields) => {
          const fieldType = fields.get(expression.fieldName);
          return fieldType === undefined ? [] : [fieldType];
        }),
      );
      return fieldTypes.size === 1 ? [...fieldTypes][0] : undefined;
    }
    case "product":
    case "record":
    case "unionCase":
      return expression.nominalType;
    case "call": {
      if (
        expression.callee.kind === "reference" &&
        ["@append", "@slice"].includes(expression.callee.name.text)
      ) {
        const firstArgument = expression.arguments[0];
        return firstArgument === undefined ? undefined : expressionTypeName(
          firstArgument,
          types,
          typeDeclarations,
          resolvingFunctions,
        );
      }
      if (
        expression.callee.kind === "reference" &&
        !resolvingFunctions.has(expression.callee.name.text)
      ) {
        const functionName = expression.callee.name.text;
        const function_ = typeDeclarations.functions.get(functionName);
        if (function_ !== undefined) {
          const bodyTypes = new Map(types);
          function_.parameters.forEach((parameter, index) => {
            const argument = expression.arguments[index];
            const argumentType = argument === undefined
              ? undefined
              : expressionTypeName(
                argument,
                types,
                typeDeclarations,
                resolvingFunctions,
              );
            const parameterType = parameter.declaredType?.name ?? argumentType;
            if (parameterType !== undefined) {
              bodyTypes.set(parameter.text, parameterType);
            }
          });
          return expressionTypeName(
            function_.body,
            bodyTypes,
            typeDeclarations,
            new Set([...resolvingFunctions, functionName]),
          );
        }
      }
      return expression.callee.kind === "field" &&
          expression.callee.fieldName === "new" &&
          expression.callee.product.kind === "reference" &&
          typeDeclarations.structFields.has(
            expression.callee.product.name.text,
          )
        ? expression.callee.product.name.text
        : undefined;
    }
    case "unary":
      return expressionTypeName(
        expression.operand,
        types,
        typeDeclarations,
      );
    case "recordUpdate":
      return expressionTypeName(
        expression.product,
        types,
        typeDeclarations,
        resolvingFunctions,
      );
    case "index":
      return "I32";
    case "binary":
      return ["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(
          expression.operator,
        )
        ? "Bool"
        : expressionTypeName(
          expression.left,
          types,
          typeDeclarations,
          resolvingFunctions,
        );
    case "if": {
      const consequence = expressionTypeName(
        expression.consequence,
        types,
        typeDeclarations,
        resolvingFunctions,
      );
      const alternative = expression.alternative === undefined
        ? consequence
        : expressionTypeName(
          expression.alternative,
          types,
          typeDeclarations,
          resolvingFunctions,
        );
      return consequence === alternative ? consequence : undefined;
    }
    case "block": {
      const blockTypes = new Map(types);
      for (const statement of expression.statements) {
        if (statement.kind !== "binding") continue;
        const type = statement.name.declaredType?.name ??
          expressionTypeName(
            statement.value,
            blockTypes,
            typeDeclarations,
            resolvingFunctions,
          );
        if (type !== undefined) blockTypes.set(statement.name.text, type);
      }
      const result = expression.statements.at(-1);
      return result?.kind === "expression"
        ? expressionTypeName(
          result.expression,
          blockTypes,
          typeDeclarations,
          resolvingFunctions,
        )
        : undefined;
    }
    case "comptime":
      return expressionTypeName(
        expression.expression,
        types,
        typeDeclarations,
        resolvingFunctions,
      );
    case "scratch":
      return expressionTypeName(
        expression.body,
        types,
        typeDeclarations,
        resolvingFunctions,
      );
    case "moduleImport":
    case "optionDo":
    case "function":
    case "recursiveCall":
    case "indexUpdate":
    case "ifUnion":
    case "loop":
      return undefined;
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
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
      return expression;
    case "reference":
      return parameters.get(expression.name.text) ?? expression;
    case "hostCall":
      return { ...expression, arguments: expression.arguments.map(descend) };
    case "effectHandler":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: descend(field.value),
        })),
      };
    case "handle":
      return {
        ...expression,
        body: descend(expression.body),
        handler: descend(expression.handler),
      };
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
    case "recordBinding":
      return { ...statement, value: descend(statement.value) };
    case "typePattern":
      return { ...statement, target: descend(statement.target) };
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
    case "initDeclaration":
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

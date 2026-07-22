import type {
  DucklangExpression,
  DucklangModule,
  DucklangName,
  DucklangStatement,
  DucklangStructField,
  DucklangTypeReference,
  DucklangUnionCase,
} from "./ducklang_ast.ts";
import type { SourceSpan } from "./syntax.ts";

type DerivationKind = "sum" | "equality";

type TypeDeclarations = {
  readonly structs: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "structType" }>
  >;
  readonly unions: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "unionType" }>
  >;
  readonly aliases: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "typeAlias" }>
  >;
};

export function elaborateDucklangDerivations(
  module: DucklangModule,
): DucklangModule {
  const bindings = new Map(
    module.statements.flatMap((statement) =>
      statement.kind === "binding" ? [[statement.name.text, statement]] : []
    ),
  );
  const declarations = collectTypeDeclarations(module.statements);
  const compileTimeDependencies = new Set<string>();
  let changed = false;
  const statements = module.statements.map((statement): DucklangStatement => {
    if (statement.kind !== "binding") return statement;
    const invocation = reflectionInvocation(statement.value);
    if (invocation === undefined) return statement;
    const factory = bindings.get(invocation.factoryName);
    if (factory?.value.kind !== "function") return statement;
    const derivationKind = classifyDerivation(factory.value);
    if (derivationKind === undefined) return statement;
    changed = true;
    collectCompileTimeDependencies(
      invocation.factoryName,
      bindings,
      compileTimeDependencies,
    );
    const value = derivationKind === "sum"
      ? deriveSumFunction(invocation.targetType, declarations, statement.span)
      : deriveEqualityFunction(
        invocation.targetType,
        declarations,
        statement.span,
      );
    return { ...statement, value };
  });
  if (!changed) return module;
  return {
    ...module,
    statements: statements.filter((statement) =>
      !(statement.kind === "binding" &&
        compileTimeDependencies.has(statement.name.text)) &&
      !(statement.kind === "structType" &&
        statement.name === "$TypeDescription")
    ),
  };
}

function reflectionInvocation(
  expression: DucklangExpression,
): { readonly factoryName: string; readonly targetType: string } | undefined {
  if (
    expression.kind !== "comptime" || expression.expression.kind !== "call" ||
    expression.expression.callee.kind !== "reference" ||
    expression.expression.arguments.length !== 1 ||
    expression.expression.arguments[0].kind !== "reference"
  ) return undefined;
  return {
    factoryName: expression.expression.callee.name.text,
    targetType: expression.expression.arguments[0].name.text,
  };
}

function classifyDerivation(
  factory: DucklangExpression,
): DerivationKind | undefined {
  const references = new Set<string>();
  collectReferencedNames(factory, references);
  if (
    references.has("@describe_type") || references.has("@describe_cases") ||
    references.has("@is_case")
  ) return "equality";
  if (references.has("@describe_fields")) return "sum";
  return undefined;
}

function collectCompileTimeDependencies(
  bindingName: string,
  bindings: ReadonlyMap<
    string,
    Extract<DucklangStatement, { readonly kind: "binding" }>
  >,
  dependencies: Set<string>,
): void {
  if (dependencies.has(bindingName)) return;
  dependencies.add(bindingName);
  const binding = bindings.get(bindingName);
  if (binding === undefined) return;
  const references = new Set<string>();
  collectReferencedNames(binding.value, references);
  const locallyBoundNames = new Set<string>();
  collectLocallyBoundNames(binding.value, locallyBoundNames);
  for (const reference of references) {
    if (locallyBoundNames.has(reference)) continue;
    const dependency = bindings.get(reference);
    if (dependency?.value.kind === "function") {
      collectCompileTimeDependencies(reference, bindings, dependencies);
    }
  }
}

function collectLocallyBoundNames(value: unknown, names: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node.kind === "function" && Array.isArray(node.parameters)) {
    for (const parameter of node.parameters) {
      const name = parameter as Record<string, unknown>;
      if (typeof name.text === "string") names.add(name.text);
    }
  }
  if (
    (node.kind === "binding" || node.kind === "unionBinding" ||
      node.kind === "assignment") && node.name !== undefined
  ) {
    const name = node.name as Record<string, unknown>;
    if (typeof name.text === "string") names.add(name.text);
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const element of child) collectLocallyBoundNames(element, names);
    } else {
      collectLocallyBoundNames(child, names);
    }
  }
}

function collectReferencedNames(value: unknown, names: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node.kind === "reference") {
    const name = node.name as Record<string, unknown> | undefined;
    if (typeof name?.text === "string") names.add(name.text);
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const element of child) collectReferencedNames(element, names);
    } else {
      collectReferencedNames(child, names);
    }
  }
}

function collectTypeDeclarations(
  statements: readonly DucklangStatement[],
): TypeDeclarations {
  return {
    structs: new Map(
      statements.flatMap((statement) =>
        statement.kind === "structType" ? [[statement.name, statement]] : []
      ),
    ),
    unions: new Map(
      statements.flatMap((statement) =>
        statement.kind === "unionType" ? [[statement.name, statement]] : []
      ),
    ),
    aliases: new Map(
      statements.flatMap((statement) =>
        statement.kind === "typeAlias" ? [[statement.name, statement]] : []
      ),
    ),
  };
}

function deriveSumFunction(
  targetType: string,
  declarations: TypeDeclarations,
  span: SourceSpan,
): DucklangExpression {
  const declaration = declarations.structs.get(targetType);
  if (declaration === undefined) {
    throw new TypeError(
      `${span.file}:${span.start}: Ducklang field-sum derivation requires a struct type; received ${targetType}`,
    );
  }
  const valueName = syntheticName("derived_value", span);
  const value = reference(valueName);
  const body = declaration.fields.reduce<DucklangExpression>(
    (sum, field) => ({
      kind: "binary",
      operator: "+",
      left: sum,
      right: fieldExpression(value, field, span),
      span,
    }),
    { kind: "integer", value: 0, span },
  );
  return {
    kind: "function",
    recursive: false,
    parameters: [{ ...valueName, declaredType: targetType }],
    body,
    span,
  };
}

function deriveEqualityFunction(
  targetType: string,
  declarations: TypeDeclarations,
  span: SourceSpan,
): DucklangExpression {
  const leftName = syntheticName("derived_left", span);
  const rightName = syntheticName("derived_right", span);
  const type = { name: targetType, arguments: [], span };
  return {
    kind: "function",
    recursive: false,
    parameters: [
      { ...leftName, declaredType: targetType },
      { ...rightName, declaredType: targetType },
    ],
    body: equalityExpression(
      type,
      reference(leftName),
      reference(rightName),
      declarations,
      span,
      [],
    ),
    span,
  };
}

function equalityExpression(
  type: DucklangTypeReference,
  left: DucklangExpression,
  right: DucklangExpression,
  declarations: TypeDeclarations,
  span: SourceSpan,
  expandingAliases: readonly string[],
): DucklangExpression {
  const alias = declarations.aliases.get(type.name);
  if (alias !== undefined) {
    if (expandingAliases.includes(alias.name)) {
      throw new TypeError(
        `${span.file}:${span.start}: recursive Ducklang derivation alias ${
          [...expandingAliases, alias.name].join(" -> ")
        }`,
      );
    }
    return equalityExpression(
      alias.target,
      left,
      right,
      declarations,
      span,
      [...expandingAliases, alias.name],
    );
  }
  const struct = declarations.structs.get(type.name);
  if (struct !== undefined) {
    return conjunction(
      struct.fields.map((field) =>
        equalityExpression(
          field.type,
          fieldExpression(left, field, span),
          fieldExpression(right, field, span),
          declarations,
          span,
          expandingAliases,
        )
      ),
      span,
    );
  }
  const union = declarations.unions.get(type.name);
  if (union !== undefined) {
    return unionEquality(union.cases, left, right, declarations, span);
  }
  return { kind: "binary", operator: "==", left, right, span };
}

function unionEquality(
  cases: readonly DucklangUnionCase[],
  left: DucklangExpression,
  right: DucklangExpression,
  declarations: TypeDeclarations,
  span: SourceSpan,
): DucklangExpression {
  let alternative: DucklangExpression = { kind: "boolean", value: false, span };
  for (const unionCase of cases.toReversed()) {
    const leftPayload = syntheticName(
      `derived_left_${unionCase.name}`,
      unionCase.span,
    );
    const rightPayload = syntheticName(
      `derived_right_${unionCase.name}`,
      unionCase.span,
    );
    const sameCase: DucklangExpression = {
      kind: "ifUnion",
      caseName: unionCase.name,
      payloadName: rightPayload,
      value: right,
      consequence: equalityExpression(
        unionCase.payloadType,
        reference(leftPayload),
        reference(rightPayload),
        declarations,
        span,
        [],
      ),
      alternative: { kind: "boolean", value: false, span },
      span,
    };
    alternative = {
      kind: "ifUnion",
      caseName: unionCase.name,
      payloadName: leftPayload,
      value: left,
      consequence: sameCase,
      alternative,
      span,
    };
  }
  return alternative;
}

function conjunction(
  expressions: readonly DucklangExpression[],
  span: SourceSpan,
): DucklangExpression {
  return expressions.reduceRight<DucklangExpression>(
    (right, left) => ({ kind: "binary", operator: "&&", left, right, span }),
    { kind: "boolean", value: true, span },
  );
}

function fieldExpression(
  product: DucklangExpression,
  field: DucklangStructField,
  span: SourceSpan,
): DucklangExpression {
  return field.name.startsWith("$")
    ? {
      kind: "index",
      collection: product,
      index: {
        kind: "integer",
        value: Number.parseInt(field.name.slice(1), 10),
        span,
      },
      span,
    }
    : { kind: "field", product, fieldName: field.name, span };
}

function syntheticName(subject: string, span: SourceSpan): DucklangName {
  return { text: `$${subject}_${span.start}`, span };
}

function reference(name: DucklangName): DucklangExpression {
  return { kind: "reference", name, span: name.span };
}

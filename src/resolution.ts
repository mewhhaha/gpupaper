import type {
  CaseAlternative,
  Expression,
  Module,
  Name,
  ValueDeclaration,
} from "./syntax.ts";

export type ResolvedReference = {
  readonly use: Name;
  readonly declaration: Name;
};

export type ResolutionResult = {
  readonly references: readonly ResolvedReference[];
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly strata: readonly (readonly ValueDeclaration[])[];
};

type LexicalBinding = { readonly name: Name; readonly topLevel: boolean };

export function resolveModuleNames(module: Module): ResolutionResult {
  const topLevelValues = module.declarations.filter((
    declaration,
  ): declaration is ValueDeclaration => declaration.kind === "value");
  const topLevelBindings: LexicalBinding[] = [];
  for (const declaration of module.declarations) {
    if (
      declaration.kind === "value" || declaration.kind === "datatype" ||
      declaration.kind === "class"
    ) {
      topLevelBindings.push({ name: declaration.name, topLevel: true });
    }
    if (declaration.kind === "datatype") {
      for (const constructor of declaration.constructors) {
        topLevelBindings.push({ name: constructor.name, topLevel: true });
      }
    }
    if (declaration.kind === "class") {
      topLevelBindings.push({ name: declaration.methodName, topLevel: true });
    }
  }

  const references: ResolvedReference[] = [];
  const dependencies = new Map<string, Set<string>>();
  const valueNames = new Set(
    topLevelValues.map((declaration) => declaration.name.text),
  );
  for (const declaration of topLevelValues) {
    const declarationDependencies = new Set<string>();
    dependencies.set(declaration.name.text, declarationDependencies);
    const lexicalBindings = [
      ...topLevelBindings,
      ...declaration.parameters.map((name) => ({ name, topLevel: false })),
    ];
    resolveExpression(
      declaration.expression,
      lexicalBindings,
      references,
      declarationDependencies,
      valueNames,
    );
  }

  return {
    references,
    dependencies,
    strata: buildDependencyStrata(topLevelValues, dependencies),
  };
}

function resolveExpression(
  expression: Expression,
  bindings: readonly LexicalBinding[],
  references: ResolvedReference[],
  dependencies: Set<string>,
  topLevelValueNames: ReadonlySet<string>,
): void {
  switch (expression.kind) {
    case "integer":
    case "boolean":
      return;
    case "variable": {
      const candidates = bindings.flatMap((binding, bindingIndex) =>
        binding.name.text === expression.name.text &&
          isScopeSubset(binding.name.scopes, expression.name.scopes)
          ? [{ binding, bindingIndex }]
          : []
      );
      if (candidates.length === 0) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: unbound name ${expression.name.text}`,
        );
      }
      candidates.sort((left, right) =>
        right.binding.name.scopes.length - left.binding.name.scopes.length ||
        right.bindingIndex - left.bindingIndex
      );
      if (
        candidates.length > 1 &&
        candidates[0].binding.name.scopes.length ===
          candidates[1].binding.name.scopes.length &&
        !haveEqualScopes(
          candidates[0].binding.name.scopes,
          candidates[1].binding.name.scopes,
        )
      ) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: ambiguous name ${expression.name.text}`,
        );
      }
      const resolved = candidates[0].binding;
      references.push({
        use: expression.name,
        declaration: resolved.name,
      });
      if (
        resolved.topLevel &&
        topLevelValueNames.has(resolved.name.text)
      ) dependencies.add(resolved.name.text);
      return;
    }
    case "lambda":
      resolveExpression(
        expression.body,
        [...bindings, { name: expression.parameter, topLevel: false }],
        references,
        dependencies,
        topLevelValueNames,
      );
      return;
    case "apply":
      resolveExpression(
        expression.callee,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      resolveExpression(
        expression.argument,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      return;
    case "let":
      resolveExpression(
        expression.value,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      resolveExpression(
        expression.body,
        [...bindings, { name: expression.name, topLevel: false }],
        references,
        dependencies,
        topLevelValueNames,
      );
      return;
    case "if":
      resolveExpression(
        expression.condition,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      resolveExpression(
        expression.thenBranch,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      resolveExpression(
        expression.elseBranch,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      return;
    case "binary":
      resolveExpression(
        expression.left,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      resolveExpression(
        expression.right,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      return;
    case "comptime":
      resolveExpression(
        expression.expression,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      return;
    case "case":
      resolveExpression(
        expression.scrutinee,
        bindings,
        references,
        dependencies,
        topLevelValueNames,
      );
      for (const alternative of expression.alternatives) {
        resolveCaseAlternative(
          alternative,
          bindings,
          references,
          dependencies,
          topLevelValueNames,
        );
      }
  }
}

function resolveCaseAlternative(
  alternative: CaseAlternative,
  bindings: readonly LexicalBinding[],
  references: ResolvedReference[],
  dependencies: Set<string>,
  topLevelValueNames: ReadonlySet<string>,
): void {
  if (alternative.pattern.kind !== "constructor") {
    resolveExpression(
      alternative.expression,
      bindings,
      references,
      dependencies,
      topLevelValueNames,
    );
    return;
  }
  const constructorUse: Expression = {
    kind: "variable",
    name: alternative.pattern.name,
    span: alternative.pattern.span,
  };
  resolveExpression(
    constructorUse,
    bindings,
    references,
    dependencies,
    topLevelValueNames,
  );
  const patternBindings = alternative.pattern.fields.map((name) => ({
    name,
    topLevel: false,
  }));
  resolveExpression(
    alternative.expression,
    [...bindings, ...patternBindings],
    references,
    dependencies,
    topLevelValueNames,
  );
}

function isScopeSubset(
  bindingScopes: readonly number[],
  useScopes: readonly number[],
): boolean {
  return bindingScopes.every((scope) => useScopes.includes(scope));
}

function haveEqualScopes(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length &&
    left.every((scope) => right.includes(scope));
}

function buildDependencyStrata(
  declarations: readonly ValueDeclaration[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly ValueDeclaration[])[] {
  const declarationByName = new Map(
    declarations.map((declaration) => [declaration.name.text, declaration]),
  );
  const indexByName = new Map<string, number>();
  const lowLinkByName = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (name: string): void => {
    indexByName.set(name, nextIndex);
    lowLinkByName.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    stacked.add(name);

    for (const dependency of dependencies.get(name) ?? []) {
      if (!declarationByName.has(dependency)) continue;
      if (!indexByName.has(dependency)) {
        visit(dependency);
        lowLinkByName.set(
          name,
          Math.min(lowLinkByName.get(name)!, lowLinkByName.get(dependency)!),
        );
      } else if (stacked.has(dependency)) {
        lowLinkByName.set(
          name,
          Math.min(lowLinkByName.get(name)!, indexByName.get(dependency)!),
        );
      }
    }

    if (lowLinkByName.get(name) !== indexByName.get(name)) return;
    const component: string[] = [];
    while (true) {
      const member = stack.pop()!;
      stacked.delete(member);
      component.push(member);
      if (member === name) break;
    }
    components.push(component);
  };

  for (const declaration of declarations) {
    if (!indexByName.has(declaration.name.text)) visit(declaration.name.text);
  }
  const componentByName = new Map<string, number>();
  components.forEach((component, componentIndex) =>
    component.forEach((name) => componentByName.set(name, componentIndex))
  );
  const depth = new Array(components.length).fill(-1);
  const componentDepth = (componentIndex: number): number => {
    if (depth[componentIndex] >= 0) return depth[componentIndex];
    let maximumDependencyDepth = -1;
    for (const name of components[componentIndex]) {
      for (const dependency of dependencies.get(name) ?? []) {
        const dependencyComponent = componentByName.get(dependency);
        if (
          dependencyComponent === undefined ||
          dependencyComponent === componentIndex
        ) continue;
        maximumDependencyDepth = Math.max(
          maximumDependencyDepth,
          componentDepth(dependencyComponent),
        );
      }
    }
    depth[componentIndex] = maximumDependencyDepth + 1;
    return depth[componentIndex];
  };
  components.forEach((_, componentIndex) => componentDepth(componentIndex));

  const strata: ValueDeclaration[][] = [];
  components.forEach((component, componentIndex) => {
    const stratum = strata[depth[componentIndex]] ?? [];
    for (const name of component.sort()) {
      stratum.push(declarationByName.get(name)!);
    }
    strata[depth[componentIndex]] = stratum;
  });
  return strata;
}

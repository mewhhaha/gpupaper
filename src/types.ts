import type {
  CaseAlternative,
  ClassDeclaration,
  Expression,
  InstanceDeclaration,
  Module,
  Pattern,
  SourceSpan,
  TypeSignature,
  TypeSyntax,
  ValueDeclaration,
} from "./syntax.ts";
import { type ResolutionResult, resolveModuleNames } from "./resolution.ts";

export type Type =
  | { readonly kind: "variable"; readonly id: number }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly arguments: readonly Type[];
  }
  | {
    readonly kind: "function";
    readonly parameter: Type;
    readonly result: Type;
    readonly effects?: CallableEffectRow;
    readonly nullary?: true;
  };

export type CallableEffectRow = {
  readonly operations: readonly string[];
  readonly parameterEffects: readonly number[];
  readonly variables?: readonly number[];
};

export type Predicate = {
  readonly className: string;
  readonly type: Type;
  readonly span: SourceSpan;
};

export type TypeScheme = {
  readonly quantified: readonly number[];
  readonly predicates: readonly Predicate[];
  readonly type: Type;
};

export type EqualityConstraint = {
  readonly left: Type;
  readonly right: Type;
  readonly span: SourceSpan;
};

export type TypedDeclaration = {
  readonly declaration: ValueDeclaration;
  readonly scheme: TypeScheme;
  readonly predicates: readonly Predicate[];
};

export type InferredModule = {
  readonly module: Module;
  readonly declarations: readonly TypedDeclaration[];
  readonly equalities: readonly EqualityConstraint[];
  readonly resolution: ResolutionResult;
  readonly instances: readonly InstanceDeclaration[];
};

type InferredExpression = {
  readonly type: Type;
  readonly predicates: readonly Predicate[];
};
type TypeEnvironment = ReadonlyMap<string, TypeScheme>;

const integerType: Type = { kind: "constructor", name: "Int", arguments: [] };
const booleanType: Type = { kind: "constructor", name: "Bool", arguments: [] };

export function inferModule(module: Module): InferredModule {
  const resolution = resolveModuleNames(module);
  const classes = module.declarations.filter((
    declaration,
  ): declaration is ClassDeclaration => declaration.kind === "class");
  const instances = module.declarations.filter((
    declaration,
  ): declaration is InstanceDeclaration => declaration.kind === "instance");
  const classByName = new Map<string, ClassDeclaration>();
  for (const declaration of classes) {
    const previous = classByName.get(declaration.name.text);
    if (previous !== undefined) {
      throw new TypeError(
        `${declaration.span.file}:${declaration.span.start}: duplicate class ${declaration.name.text}; first declared at ${previous.span.file}:${previous.span.start}`,
      );
    }
    classByName.set(declaration.name.text, declaration);
    if (declaration.methodType.predicates.length !== 0) {
      throw new TypeError(
        `${declaration.methodType.span.file}:${declaration.methodType.span.start}: class method predicates are outside this proof of concept`,
      );
    }
    const pendingTypes: TypeSyntax[] = [declaration.methodType.type];
    let parameterReferenced = false;
    while (pendingTypes.length !== 0) {
      const syntax = pendingTypes.pop()!;
      if (syntax.kind === "function") {
        pendingTypes.push(syntax.parameter, syntax.result);
        continue;
      }
      if (syntax.kind === "apply") {
        pendingTypes.push(syntax.constructor, syntax.argument);
        continue;
      }
      if (syntax.name[0] !== syntax.name[0].toLowerCase()) continue;
      if (syntax.name !== declaration.parameter) {
        throw new TypeError(
          `${syntax.span.file}:${syntax.span.start}: class method ${declaration.methodName.text} uses undeclared type variable ${syntax.name}`,
        );
      }
      parameterReferenced = true;
    }
    if (!parameterReferenced) {
      throw new TypeError(
        `${declaration.methodType.span.file}:${declaration.methodType.span.start}: class method ${declaration.methodName.text} does not mention class parameter ${declaration.parameter}`,
      );
    }
  }
  const instanceOrigins = new Map<string, InstanceDeclaration>();
  for (const instance of instances) {
    const classDeclaration = classByName.get(instance.className.text);
    if (classDeclaration === undefined) {
      throw new TypeError(
        `${instance.span.file}:${instance.span.start}: instance refers to unknown class ${instance.className.text}`,
      );
    }
    if (instance.methodName.text !== classDeclaration.methodName.text) {
      throw new TypeError(
        `${instance.methodName.span.file}:${instance.methodName.span.start}: instance for ${instance.className.text} must define ${classDeclaration.methodName.text}; found ${instance.methodName.text}`,
      );
    }
    const methodType = classDeclaration.methodType.type;
    const methodMatchesPrimitive =
      classDeclaration.methodType.predicates.length === 0 &&
      methodType.kind === "function" &&
      methodType.parameter.kind === "name" &&
      methodType.parameter.name === classDeclaration.parameter &&
      methodType.result.kind === "function" &&
      methodType.result.parameter.kind === "name" &&
      methodType.result.parameter.name === classDeclaration.parameter &&
      methodType.result.result.kind === "name" &&
      methodType.result.result.name === "Bool";
    if (!methodMatchesPrimitive) {
      throw new TypeError(
        `${classDeclaration.methodType.span.file}:${classDeclaration.methodType.span.start}: primEqInt method ${classDeclaration.methodName.text} must have type ${classDeclaration.parameter} -> ${classDeclaration.parameter} -> Bool`,
      );
    }
    if (instance.type.kind !== "name" || instance.type.name !== "Int") {
      throw new TypeError(
        `${instance.type.span.file}:${instance.type.span.start}: primEqInt instance requires type Int; found ${
          instance.type.kind === "name"
            ? instance.type.name
            : instance.type.kind
        }`,
      );
    }
    const instanceKey = `${instance.className.text}:${instance.type.name}`;
    const previous = instanceOrigins.get(instanceKey);
    if (previous !== undefined) {
      throw new TypeError(
        `${instance.span.file}:${instance.span.start}: duplicate instance ${instance.className.text} ${instance.type.name}; first declared at ${previous.span.file}:${previous.span.start}`,
      );
    }
    instanceOrigins.set(instanceKey, instance);
  }
  const state = new InferenceState(instances, classes);
  let environment = state.initialEnvironment(module, classes);
  const typedByName = new Map<string, TypedDeclaration>();

  for (const stratum of resolution.strata) {
    const placeholders = new Map<string, Type>();
    const recursiveEnvironment = new Map(environment);
    for (const declaration of stratum) {
      const placeholder = state.freshVariable();
      placeholders.set(declaration.name.text, placeholder);
      recursiveEnvironment.set(declaration.name.text, {
        quantified: [],
        predicates: [],
        type: placeholder,
      });
    }

    const inferredByName = new Map<string, InferredExpression>();
    for (const declaration of stratum) {
      const inferredBody = state.inferValueDeclaration(
        declaration,
        recursiveEnvironment,
      );
      let inferred = inferredBody;
      state.unify(
        placeholders.get(declaration.name.text)!,
        inferred.type,
        declaration.span,
      );
      if (declaration.signature !== undefined) {
        const declaredPredicates = state.checkSignature(
          declaration.signature,
          inferred,
          declaration.name.text,
        );
        inferred = {
          ...inferred,
          predicates: [...inferred.predicates, ...declaredPredicates],
        };
      }
      inferredByName.set(declaration.name.text, inferred);
    }

    const extendedEnvironment = new Map(environment);
    for (const declaration of stratum) {
      const inferred = inferredByName.get(declaration.name.text)!;
      const resolvedType = state.apply(
        placeholders.get(declaration.name.text)!,
      );
      const resolvedPredicates = inferred.predicates.map((predicate) => ({
        ...predicate,
        type: state.apply(predicate.type),
      }));
      const unsolvedPredicates = state.retainUnsolvedPredicates(
        resolvedPredicates,
        declaration.signature !== undefined,
      );
      const scheme = state.generalize(
        environment,
        resolvedType,
        unsolvedPredicates,
      );
      const typed = { declaration, scheme, predicates: unsolvedPredicates };
      typedByName.set(declaration.name.text, typed);
      extendedEnvironment.set(declaration.name.text, scheme);
    }
    environment = extendedEnvironment;
  }

  return {
    module,
    declarations: module.declarations
      .filter((declaration): declaration is ValueDeclaration =>
        declaration.kind === "value"
      )
      .map((declaration) => typedByName.get(declaration.name.text)!),
    equalities: state.equalities,
    resolution,
    instances,
  };
}

class InferenceState {
  readonly equalities: EqualityConstraint[] = [];
  readonly #substitution = new Map<number, Type>();
  readonly #instances: readonly InstanceDeclaration[];
  readonly #classNames: ReadonlySet<string>;
  readonly #typeConstructorArities = new Map<string, number>([["Int", 0], [
    "Bool",
    0,
  ]]);
  #nextVariable = 0;

  constructor(
    instances: readonly InstanceDeclaration[],
    classes: readonly ClassDeclaration[],
  ) {
    this.#instances = instances;
    this.#classNames = new Set(
      classes.map((declaration) => declaration.name.text),
    );
  }

  freshVariable(): Type {
    const variable: Type = { kind: "variable", id: this.#nextVariable };
    this.#nextVariable += 1;
    return variable;
  }

  initialEnvironment(
    module: Module,
    classes: readonly ClassDeclaration[],
  ): TypeEnvironment {
    const environment = new Map<string, TypeScheme>();
    for (const declaration of module.declarations) {
      if (declaration.kind !== "datatype") continue;
      const existingArity = this.#typeConstructorArities.get(
        declaration.name.text,
      );
      if (existingArity !== undefined) {
        throw new TypeError(
          `${declaration.name.span.file}:${declaration.name.span.start}: duplicate datatype ${declaration.name.text}; an arity-${existingArity} type already uses that name`,
        );
      }
      const uniqueParameters = new Set(declaration.parameters);
      if (uniqueParameters.size !== declaration.parameters.length) {
        throw new TypeError(
          `${declaration.span.file}:${declaration.span.start}: datatype ${declaration.name.text} repeats a type parameter`,
        );
      }
      this.#typeConstructorArities.set(
        declaration.name.text,
        declaration.parameters.length,
      );
    }
    for (const declaration of module.declarations) {
      if (declaration.kind !== "datatype") continue;
      const parameters = new Set(declaration.parameters);
      const validateFieldType = (syntax: TypeSyntax): void => {
        if (syntax.kind === "function") {
          validateFieldType(syntax.parameter);
          validateFieldType(syntax.result);
          return;
        }
        const typeArguments: TypeSyntax[] = [];
        let head: TypeSyntax = syntax;
        while (head.kind === "apply") {
          typeArguments.unshift(head.argument);
          head = head.constructor;
        }
        if (head.kind !== "name") {
          throw new TypeError(
            `${syntax.span.file}:${syntax.span.start}: only named type constructors may be applied`,
          );
        }
        const startsLowercase = head.name[0] === head.name[0].toLowerCase();
        if (startsLowercase) {
          if (!parameters.has(head.name)) {
            throw new TypeError(
              `${head.span.file}:${head.span.start}: datatype ${declaration.name.text} field uses undeclared type variable ${head.name}`,
            );
          }
          if (typeArguments.length !== 0) {
            throw new TypeError(
              `${syntax.span.file}:${syntax.span.start}: type variable ${head.name} cannot be applied`,
            );
          }
        } else {
          const expectedArity = this.#typeConstructorArities.get(head.name);
          if (expectedArity === undefined) {
            throw new TypeError(
              `${head.span.file}:${head.span.start}: unknown type constructor ${head.name}`,
            );
          }
          if (typeArguments.length !== expectedArity) {
            throw new TypeError(
              `${syntax.span.file}:${syntax.span.start}: type constructor ${head.name} expects ${expectedArity} arguments; received ${typeArguments.length}`,
            );
          }
        }
        for (const argument of typeArguments) validateFieldType(argument);
      };
      for (const constructor of declaration.constructors) {
        for (const field of constructor.fields) validateFieldType(field);
      }
    }
    for (const declaration of module.declarations) {
      if (declaration.kind !== "datatype") continue;
      for (
        const [constructorIndex, constructor] of declaration.constructors
          .entries()
      ) {
        const variables = new Map(
          declaration.parameters.map((
            parameter,
          ) => [parameter, this.freshVariable()]),
        );
        const result: Type = {
          kind: "constructor",
          name: declaration.name.text,
          arguments: declaration.parameters.map((parameter) =>
            variables.get(parameter)!
          ),
        };
        const constructorType = constructor.fields.reduceRight<Type>(
          (rest, field) => ({
            kind: "function",
            parameter: this.typeFromSyntax(field, variables),
            result: rest,
          }),
          result,
        );
        environment.set(constructor.name.text, {
          quantified: [...variables.values()].map((type) =>
            (type as { kind: "variable"; id: number }).id
          ),
          predicates: [],
          type: constructorType,
        });
        environment.set(`$tag:${constructor.name.text}`, {
          quantified: [],
          predicates: [],
          type: {
            kind: "constructor",
            name: String(constructorIndex),
            arguments: [],
          },
        });
      }
    }
    for (const classDeclaration of classes) {
      const variables = new Map<string, Type>();
      variables.set(classDeclaration.parameter, this.freshVariable());
      const methodType = this.typeFromSyntax(
        classDeclaration.methodType.type,
        variables,
      );
      const classType = variables.get(classDeclaration.parameter)!;
      environment.set(classDeclaration.methodName.text, {
        quantified: [classType.kind === "variable" ? classType.id : -1],
        predicates: [{
          className: classDeclaration.name.text,
          type: classType,
          span: classDeclaration.span,
        }],
        type: methodType,
      });
    }
    return environment;
  }

  inferValueDeclaration(
    declaration: ValueDeclaration,
    environment: TypeEnvironment,
  ): InferredExpression {
    let expression = declaration.expression;
    for (const parameter of declaration.parameters.toReversed()) {
      expression = {
        kind: "lambda",
        parameter,
        body: expression,
        span: declaration.span,
      };
    }
    return this.inferExpression(expression, environment);
  }

  inferExpression(
    expression: Expression,
    environment: TypeEnvironment,
  ): InferredExpression {
    switch (expression.kind) {
      case "integer":
        return { type: integerType, predicates: [] };
      case "boolean":
        return { type: booleanType, predicates: [] };
      case "variable": {
        const scheme = environment.get(expression.name.text);
        if (scheme === undefined) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: unbound name ${expression.name.text}`,
          );
        }
        return this.instantiate(scheme);
      }
      case "lambda": {
        const parameterType = this.freshVariable();
        const lambdaEnvironment = new Map(environment);
        lambdaEnvironment.set(expression.parameter.text, {
          quantified: [],
          predicates: [],
          type: parameterType,
        });
        const body = this.inferExpression(expression.body, lambdaEnvironment);
        return {
          type: {
            kind: "function",
            parameter: this.apply(parameterType),
            result: body.type,
          },
          predicates: body.predicates,
        };
      }
      case "apply": {
        const callee = this.inferExpression(expression.callee, environment);
        const argument = this.inferExpression(expression.argument, environment);
        const result = this.freshVariable();
        this.unify(callee.type, {
          kind: "function",
          parameter: argument.type,
          result,
        }, expression.span);
        return {
          type: this.apply(result),
          predicates: [...callee.predicates, ...argument.predicates],
        };
      }
      case "let": {
        const value = this.inferExpression(expression.value, environment);
        const scheme = this.generalize(
          environment,
          this.apply(value.type),
          value.predicates,
        );
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(expression.name.text, scheme);
        return this.inferExpression(expression.body, bodyEnvironment);
      }
      case "if": {
        const condition = this.inferExpression(
          expression.condition,
          environment,
        );
        const thenBranch = this.inferExpression(
          expression.thenBranch,
          environment,
        );
        const elseBranch = this.inferExpression(
          expression.elseBranch,
          environment,
        );
        this.unify(condition.type, booleanType, expression.condition.span);
        this.unify(thenBranch.type, elseBranch.type, expression.span);
        return {
          type: this.apply(thenBranch.type),
          predicates: [
            ...condition.predicates,
            ...thenBranch.predicates,
            ...elseBranch.predicates,
          ],
        };
      }
      case "binary": {
        const left = this.inferExpression(expression.left, environment);
        const right = this.inferExpression(expression.right, environment);
        this.unify(left.type, right.type, expression.span);
        if (expression.operator === "==") {
          return {
            type: booleanType,
            predicates: [...left.predicates, ...right.predicates, {
              className: "Eq",
              type: this.apply(left.type),
              span: expression.span,
            }],
          };
        }
        this.unify(left.type, integerType, expression.span);
        return {
          type: integerType,
          predicates: [...left.predicates, ...right.predicates],
        };
      }
      case "comptime":
        return this.inferExpression(expression.expression, environment);
      case "case":
        return this.inferCase(
          expression.scrutinee,
          expression.alternatives,
          environment,
        );
    }
  }

  inferCase(
    scrutineeExpression: Expression,
    alternatives: readonly CaseAlternative[],
    environment: TypeEnvironment,
  ): InferredExpression {
    const scrutinee = this.inferExpression(scrutineeExpression, environment);
    const result = this.freshVariable();
    const predicates: Predicate[] = [...scrutinee.predicates];
    for (const alternative of alternatives) {
      const pattern = this.inferPattern(alternative.pattern, environment);
      this.unify(scrutinee.type, pattern.type, alternative.span);
      const alternativeEnvironment = new Map(environment);
      for (const [name, type] of pattern.bindings) {
        alternativeEnvironment.set(name, {
          quantified: [],
          predicates: [],
          type,
        });
      }
      const branch = this.inferExpression(
        alternative.expression,
        alternativeEnvironment,
      );
      this.unify(result, branch.type, alternative.span);
      predicates.push(...pattern.predicates, ...branch.predicates);
    }
    return { type: this.apply(result), predicates };
  }

  inferPattern(
    pattern: Pattern,
    environment: TypeEnvironment,
  ): {
    readonly type: Type;
    readonly bindings: ReadonlyMap<string, Type>;
    readonly predicates: readonly Predicate[];
  } {
    if (pattern.kind === "integer") {
      return { type: integerType, bindings: new Map(), predicates: [] };
    }
    if (pattern.kind === "wildcard") {
      return {
        type: this.freshVariable(),
        bindings: new Map(),
        predicates: [],
      };
    }
    const scheme = environment.get(pattern.name.text);
    if (scheme === undefined) {
      throw new TypeError(
        `${pattern.span.file}:${pattern.span.start}: unknown constructor ${pattern.name.text}`,
      );
    }
    const instantiated = this.instantiate(scheme);
    let constructorType = instantiated.type;
    const bindings = new Map<string, Type>();
    for (const field of pattern.fields) {
      const fieldType = this.freshVariable();
      const remaining = this.freshVariable();
      this.unify(constructorType, {
        kind: "function",
        parameter: fieldType,
        result: remaining,
      }, field.span);
      bindings.set(field.text, this.apply(fieldType));
      constructorType = this.apply(remaining);
    }
    if (this.apply(constructorType).kind === "function") {
      throw new TypeError(
        `${pattern.span.file}:${pattern.span.start}: constructor ${pattern.name.text} expects more fields`,
      );
    }
    return {
      type: this.apply(constructorType),
      bindings,
      predicates: instantiated.predicates,
    };
  }

  checkSignature(
    signature: TypeSignature,
    inferred: InferredExpression,
    declarationName: string,
  ): readonly Predicate[] {
    const variables = new Map<string, Type>();
    const expected = this.typeFromSyntax(signature.type, variables);
    try {
      this.unify(inferred.type, expected, signature.span);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TypeError(
          `${signature.span.file}:${signature.span.start}: signature for ${declarationName} does not match: ${error.message}`,
        );
      }
      throw error;
    }
    for (const [name, variable] of variables) {
      if (variable.kind !== "variable") continue;
      const resolved = this.apply(variable);
      if (resolved.kind !== "variable" || resolved.id !== variable.id) {
        throw new TypeError(
          `${signature.span.file}:${signature.span.start}: signature for ${declarationName} claims polymorphic ${name}, but its definition requires ${
            formatType(resolved)
          }`,
        );
      }
    }
    const declaredPredicates = signature.predicates.map((predicate) => {
      if (!this.#classNames.has(predicate.className)) {
        throw new TypeError(
          `${predicate.span.file}:${predicate.span.start}: signature for ${declarationName} refers to unknown class ${predicate.className}`,
        );
      }
      return {
        className: predicate.className,
        type: this.apply(this.typeFromSyntax(predicate.argument, variables)),
        span: predicate.span,
      };
    });
    const declaredPredicateKeys = new Set(
      declaredPredicates.map(formatPredicate),
    );
    for (const predicate of inferred.predicates) {
      const resolved = { ...predicate, type: this.apply(predicate.type) };
      if (
        !this.predicateHasInstance(resolved) &&
        !declaredPredicateKeys.has(formatPredicate(resolved))
      ) {
        throw new TypeError(
          `${predicate.span.file}:${predicate.span.start}: signature for ${declarationName} is missing ${
            formatPredicate(resolved)
          }`,
        );
      }
    }
    return declaredPredicates;
  }

  typeFromSyntax(syntax: TypeSyntax, variables: Map<string, Type>): Type {
    if (syntax.kind === "function") {
      return {
        kind: "function",
        parameter: this.typeFromSyntax(syntax.parameter, variables),
        result: this.typeFromSyntax(syntax.result, variables),
      };
    }
    const typeArguments: TypeSyntax[] = [];
    let head: TypeSyntax = syntax;
    while (head.kind === "apply") {
      typeArguments.unshift(head.argument);
      head = head.constructor;
    }
    if (head.kind !== "name") {
      throw new TypeError(
        `${syntax.span.file}:${syntax.span.start}: only named type constructors may be applied`,
      );
    }
    if (head.name[0] === head.name[0].toLowerCase()) {
      if (typeArguments.length !== 0) {
        throw new TypeError(
          `${syntax.span.file}:${syntax.span.start}: type variable ${head.name} cannot be applied`,
        );
      }
      const existing = variables.get(head.name);
      if (existing !== undefined) return existing;
      const variable = this.freshVariable();
      variables.set(head.name, variable);
      return variable;
    }
    const expectedArity = this.#typeConstructorArities.get(head.name);
    if (expectedArity === undefined) {
      throw new TypeError(
        `${head.span.file}:${head.span.start}: unknown type constructor ${head.name}`,
      );
    }
    if (typeArguments.length !== expectedArity) {
      throw new TypeError(
        `${syntax.span.file}:${syntax.span.start}: type constructor ${head.name} expects ${expectedArity} arguments; received ${typeArguments.length}`,
      );
    }
    return {
      kind: "constructor",
      name: head.name,
      arguments: typeArguments.map((argument) =>
        this.typeFromSyntax(argument, variables)
      ),
    };
  }

  instantiate(scheme: TypeScheme): InferredExpression {
    const replacements = new Map<number, Type>(
      scheme.quantified.map((id) => [id, this.freshVariable()]),
    );
    return {
      type: replaceTypeVariables(scheme.type, replacements),
      predicates: scheme.predicates.map((predicate) => ({
        ...predicate,
        type: replaceTypeVariables(predicate.type, replacements),
      })),
    };
  }

  generalize(
    environment: TypeEnvironment,
    type: Type,
    predicates: readonly Predicate[],
  ): TypeScheme {
    const resolvedType = this.apply(type);
    const resolvedPredicates = predicates.map((predicate) => ({
      ...predicate,
      type: this.apply(predicate.type),
    }));
    const typeVariables = freeTypeVariables(resolvedType);
    for (const predicate of resolvedPredicates) {
      for (const variable of freeTypeVariables(predicate.type)) {
        if (typeVariables.has(variable)) continue;
        throw new TypeError(
          `${predicate.span.file}:${predicate.span.start}: ambiguous predicate ${
            formatPredicate(predicate)
          } does not constrain result type ${formatType(resolvedType)}`,
        );
      }
    }
    const environmentVariables = new Set<number>();
    for (const scheme of environment.values()) {
      const quantified = new Set(scheme.quantified);
      for (const id of freeTypeVariables(scheme.type)) {
        if (!quantified.has(id)) environmentVariables.add(id);
      }
      for (const predicate of scheme.predicates) {
        for (const id of freeTypeVariables(predicate.type)) {
          if (!quantified.has(id)) environmentVariables.add(id);
        }
      }
    }
    const quantified = [...typeVariables].filter((id) =>
      !environmentVariables.has(id)
    ).sort((left, right) => left - right);
    return {
      quantified,
      predicates: resolvedPredicates,
      type: resolvedType,
    };
  }

  retainUnsolvedPredicates(
    predicates: readonly Predicate[],
    signaturePresent: boolean,
  ): readonly Predicate[] {
    const unique = new Map<string, Predicate>();
    for (const predicate of predicates) {
      const resolved = { ...predicate, type: this.apply(predicate.type) };
      if (this.predicateHasInstance(resolved)) continue;
      if (resolved.type.kind !== "variable" && !signaturePresent) {
        throw new TypeError(
          `${resolved.span.file}:${resolved.span.start}: no instance for ${
            formatPredicate(resolved)
          }`,
        );
      }
      unique.set(formatPredicate(resolved), resolved);
    }
    return [...unique.values()];
  }

  predicateHasInstance(predicate: Predicate): boolean {
    const resolved = this.apply(predicate.type);
    if (resolved.kind !== "constructor") return false;
    return this.#instances.some((instance) =>
      instance.className.text === predicate.className &&
      instance.type.kind === "name" && instance.type.name === resolved.name
    );
  }

  unify(leftInput: Type, rightInput: Type, span: SourceSpan): void {
    this.equalities.push({ left: leftInput, right: rightInput, span });
    const left = this.apply(leftInput);
    const right = this.apply(rightInput);
    if (
      left.kind === "variable" && right.kind === "variable" &&
      left.id === right.id
    ) return;
    if (left.kind === "variable") {
      this.bind(left.id, right, span);
      return;
    }
    if (right.kind === "variable") {
      this.bind(right.id, left, span);
      return;
    }
    if (left.kind === "function" && right.kind === "function") {
      this.unify(left.parameter, right.parameter, span);
      this.unify(left.result, right.result, span);
      return;
    }
    if (
      left.kind === "constructor" && right.kind === "constructor" &&
      left.name === right.name &&
      left.arguments.length === right.arguments.length
    ) {
      for (let index = 0; index < left.arguments.length; index += 1) {
        this.unify(left.arguments[index], right.arguments[index], span);
      }
      return;
    }
    throw new TypeError(
      `${span.file}:${span.start}: cannot unify ${formatType(left)} with ${
        formatType(right)
      }`,
    );
  }

  bind(variable: number, type: Type, span: SourceSpan): void {
    if (freeTypeVariables(type).has(variable)) {
      throw new TypeError(
        `${span.file}:${span.start}: infinite type t${variable} = ${
          formatType(type)
        }`,
      );
    }
    this.#substitution.set(variable, type);
  }

  apply(type: Type): Type {
    if (type.kind === "variable") {
      const replacement = this.#substitution.get(type.id);
      if (replacement === undefined) return type;
      const resolved = this.apply(replacement);
      this.#substitution.set(type.id, resolved);
      return resolved;
    }
    if (type.kind === "function") {
      return {
        kind: "function",
        parameter: this.apply(type.parameter),
        result: this.apply(type.result),
      };
    }
    return {
      kind: "constructor",
      name: type.name,
      arguments: type.arguments.map((argument) => this.apply(argument)),
    };
  }
}

export function formatType(type: Type): string {
  if (type.kind === "variable") return variableName(type.id);
  if (type.kind === "function") {
    const parameter = type.parameter.kind === "function"
      ? `(${formatType(type.parameter)})`
      : formatType(type.parameter);
    return `${parameter} -> ${formatType(type.result)}`;
  }
  if (type.arguments.length === 0) return type.name;
  return `${type.name} ${
    type.arguments.map((argument) =>
      argument.kind === "function"
        ? `(${formatType(argument)})`
        : formatType(argument)
    ).join(" ")
  }`;
}

export function formatScheme(scheme: TypeScheme): string {
  const predicates = scheme.predicates.length === 0
    ? ""
    : `${scheme.predicates.map(formatPredicate).join(", ")} => `;
  return `${predicates}${formatType(scheme.type)}`;
}

function formatPredicate(predicate: Predicate): string {
  return `${predicate.className} ${formatType(predicate.type)}`;
}

function variableName(id: number): string {
  const letter = String.fromCharCode(97 + id % 26);
  const suffix = id < 26 ? "" : String(Math.floor(id / 26));
  return letter + suffix;
}

function freeTypeVariables(type: Type): Set<number> {
  if (type.kind === "variable") return new Set([type.id]);
  const variables = new Set<number>();
  if (type.kind === "function") {
    for (const id of freeTypeVariables(type.parameter)) variables.add(id);
    for (const id of freeTypeVariables(type.result)) variables.add(id);
    return variables;
  }
  for (const argument of type.arguments) {
    for (const id of freeTypeVariables(argument)) {
      variables.add(id);
    }
  }
  return variables;
}

function replaceTypeVariables(
  type: Type,
  replacements: ReadonlyMap<number, Type>,
): Type {
  if (type.kind === "variable") return replacements.get(type.id) ?? type;
  if (type.kind === "function") {
    return {
      kind: "function",
      parameter: replaceTypeVariables(type.parameter, replacements),
      result: replaceTypeVariables(type.result, replacements),
    };
  }
  return {
    kind: "constructor",
    name: type.name,
    arguments: type.arguments.map((argument) =>
      replaceTypeVariables(argument, replacements)
    ),
  };
}

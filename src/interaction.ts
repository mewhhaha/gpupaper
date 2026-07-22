import type { Expression, Module, ValueDeclaration } from "./syntax.ts";

export type InteractionResult = {
  readonly value: number | boolean;
  readonly interactions: number;
  readonly rules: ReadonlyMap<string, number>;
};

type InteractionTerm =
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | {
    readonly kind: "lambda";
    readonly parameter: string;
    readonly body: InteractionTerm;
  }
  | {
    readonly kind: "apply";
    readonly callee: InteractionTerm;
    readonly argument: InteractionTerm;
  }
  | {
    readonly kind: "binary";
    readonly operator: "+" | "-" | "*" | "==";
    readonly left: InteractionTerm;
    readonly right: InteractionTerm;
  }
  | {
    readonly kind: "if";
    readonly condition: InteractionTerm;
    readonly thenBranch: InteractionTerm;
    readonly elseBranch: InteractionTerm;
  }
  | {
    readonly kind: "superposition";
    readonly label: number;
    readonly left: InteractionTerm;
    readonly right: InteractionTerm;
  }
  | {
    readonly kind: "duplication";
    readonly label: number;
    readonly leftName: string;
    readonly rightName: string;
    readonly value: InteractionTerm;
    readonly continuation: InteractionTerm;
  };

type Reduction = { readonly term: InteractionTerm; readonly rule: string };

class InteractionNames {
  #nextName = 0;
  #nextLabel = 0;

  name(prefix: string): string {
    const name = `${prefix}$${this.#nextName}`;
    this.#nextName += 1;
    return name;
  }

  label(): number {
    const label = this.#nextLabel;
    this.#nextLabel += 1;
    return label;
  }
}

export function evaluateWithInteractionCalculus(
  expression: Expression,
  fuel = 100_000,
): InteractionResult {
  const names = new InteractionNames();
  let term = translateExpression(expression, new Map(), names);
  const rules = new Map<string, number>();
  let interactions = 0;
  while (interactions < fuel) {
    const reduction = reduceOnce(term, names);
    if (reduction === undefined) {
      if (term.kind === "integer" || term.kind === "boolean") {
        return { value: term.value, interactions, rules };
      }
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: interaction readback expected a scalar, found ${term.kind}`,
      );
    }
    term = reduction.term;
    interactions += 1;
    rules.set(reduction.rule, (rules.get(reduction.rule) ?? 0) + 1);
  }
  throw new Error(
    `${expression.span.file}:${expression.span.start}: interaction evaluator exceeded fuel ${fuel}`,
  );
}

export function evaluateModuleInteractionComptime(
  module: Module,
): { readonly module: Module; readonly results: readonly InteractionResult[] } {
  const results: InteractionResult[] = [];
  const declarations = module.declarations.map((declaration) => {
    if (declaration.kind !== "value") return declaration;
    const expression = replaceInteractionComptime(
      declaration.expression,
      results,
    );
    return { ...declaration, expression } satisfies ValueDeclaration;
  });
  return { module: { ...module, declarations }, results };
}

function translateExpression(
  expression: Expression,
  environment: ReadonlyMap<string, string>,
  names: InteractionNames,
): InteractionTerm {
  switch (expression.kind) {
    case "integer":
      return { kind: "integer", value: expression.value };
    case "boolean":
      return { kind: "boolean", value: expression.value };
    case "variable": {
      const resolved = environment.get(expression.name.text);
      if (resolved === undefined) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: interaction comptime expression is not closed; found ${expression.name.text}`,
        );
      }
      return { kind: "variable", name: resolved };
    }
    case "lambda": {
      const parameter = names.name(expression.parameter.text);
      const lambdaEnvironment = new Map(environment);
      lambdaEnvironment.set(expression.parameter.text, parameter);
      const body = translateExpression(
        expression.body,
        lambdaEnvironment,
        names,
      );
      const occurrences = countVariable(body, parameter);
      if (occurrences <= 1) return { kind: "lambda", parameter, body };
      if (occurrences > 2) {
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: interaction proof of concept supports at most two uses of lambda parameter ${expression.parameter.text}; found ${occurrences}`,
        );
      }
      const leftName = names.name(`${expression.parameter.text}0`);
      const rightName = names.name(`${expression.parameter.text}1`);
      const linearBody = replaceVariableOccurrences(body, parameter, [
        leftName,
        rightName,
      ]);
      return {
        kind: "lambda",
        parameter,
        body: {
          kind: "duplication",
          label: names.label(),
          leftName,
          rightName,
          value: { kind: "variable", name: parameter },
          continuation: linearBody,
        },
      };
    }
    case "apply":
      return {
        kind: "apply",
        callee: translateExpression(expression.callee, environment, names),
        argument: translateExpression(expression.argument, environment, names),
      };
    case "binary":
      return {
        kind: "binary",
        operator: expression.operator,
        left: translateExpression(expression.left, environment, names),
        right: translateExpression(expression.right, environment, names),
      };
    case "if":
      return {
        kind: "if",
        condition: translateExpression(
          expression.condition,
          environment,
          names,
        ),
        thenBranch: translateExpression(
          expression.thenBranch,
          environment,
          names,
        ),
        elseBranch: translateExpression(
          expression.elseBranch,
          environment,
          names,
        ),
      };
    case "comptime":
      return translateExpression(expression.expression, environment, names);
    default:
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: interaction comptime does not support ${expression.kind}`,
      );
  }
}

function reduceOnce(
  term: InteractionTerm,
  names: InteractionNames,
): Reduction | undefined {
  if (term.kind === "apply" && term.callee.kind === "lambda") {
    return {
      term: substitute(term.callee.body, term.callee.parameter, term.argument),
      rule: "APP-LAM",
    };
  }
  if (term.kind === "apply" && term.callee.kind === "superposition") {
    const leftName = names.name("arg0");
    const rightName = names.name("arg1");
    return {
      term: {
        kind: "duplication",
        label: term.callee.label,
        leftName,
        rightName,
        value: term.argument,
        continuation: {
          kind: "superposition",
          label: term.callee.label,
          left: {
            kind: "apply",
            callee: term.callee.left,
            argument: { kind: "variable", name: leftName },
          },
          right: {
            kind: "apply",
            callee: term.callee.right,
            argument: { kind: "variable", name: rightName },
          },
        },
      },
      rule: "APP-SUP",
    };
  }
  if (term.kind === "duplication") {
    if (term.value.kind === "integer" || term.value.kind === "boolean") {
      return {
        term: substitute(
          substitute(term.continuation, term.leftName, term.value),
          term.rightName,
          term.value,
        ),
        rule: "DUP-SCALAR",
      };
    }
    if (
      term.value.kind === "superposition" && term.value.label === term.label
    ) {
      return {
        term: substitute(
          substitute(term.continuation, term.leftName, term.value.left),
          term.rightName,
          term.value.right,
        ),
        rule: "DUP-SUP",
      };
    }
    if (term.value.kind === "lambda") {
      const parameterLeft = names.name("parameter0");
      const parameterRight = names.name("parameter1");
      const bodyLeft = names.name("body0");
      const bodyRight = names.name("body1");
      const duplicatedBody = substitute(term.value.body, term.value.parameter, {
        kind: "superposition",
        label: term.label,
        left: { kind: "variable", name: parameterLeft },
        right: { kind: "variable", name: parameterRight },
      });
      const continuation = substitute(
        substitute(term.continuation, term.leftName, {
          kind: "lambda",
          parameter: parameterLeft,
          body: { kind: "variable", name: bodyLeft },
        }),
        term.rightName,
        {
          kind: "lambda",
          parameter: parameterRight,
          body: { kind: "variable", name: bodyRight },
        },
      );
      return {
        term: {
          kind: "duplication",
          label: term.label,
          leftName: bodyLeft,
          rightName: bodyRight,
          value: duplicatedBody,
          continuation,
        },
        rule: "DUP-LAM",
      };
    }
  }
  if (term.kind === "binary" && isScalar(term.left) && isScalar(term.right)) {
    if (term.left.kind !== term.right.kind) {
      throw new TypeError(
        `interaction primitive ${term.operator} received unlike scalar kinds`,
      );
    }
    if (term.operator === "==") {
      return {
        term: { kind: "boolean", value: term.left.value === term.right.value },
        rule: "OP-EQ",
      };
    }
    if (term.left.kind !== "integer" || term.right.kind !== "integer") {
      throw new TypeError(
        `interaction primitive ${term.operator} requires integers`,
      );
    }
    const value = term.operator === "+"
      ? term.left.value + term.right.value
      : term.operator === "-"
      ? term.left.value - term.right.value
      : Math.imul(term.left.value, term.right.value);
    return {
      term: { kind: "integer", value: value | 0 },
      rule: `OP-${term.operator}`,
    };
  }
  if (term.kind === "if" && term.condition.kind === "boolean") {
    return {
      term: term.condition.value ? term.thenBranch : term.elseBranch,
      rule: "IF-BOOL",
    };
  }

  return reduceChild(term, names);
}

function reduceChild(
  term: InteractionTerm,
  names: InteractionNames,
): Reduction | undefined {
  if (term.kind === "lambda") {
    const reduced = reduceOnce(term.body, names);
    return reduced === undefined
      ? undefined
      : { term: { ...term, body: reduced.term }, rule: reduced.rule };
  }
  if (term.kind === "apply") {
    const callee = reduceOnce(term.callee, names);
    if (callee !== undefined) {
      return { term: { ...term, callee: callee.term }, rule: callee.rule };
    }
    const argument = reduceOnce(term.argument, names);
    return argument === undefined
      ? undefined
      : { term: { ...term, argument: argument.term }, rule: argument.rule };
  }
  if (term.kind === "binary") {
    const left = reduceOnce(term.left, names);
    if (left !== undefined) {
      return { term: { ...term, left: left.term }, rule: left.rule };
    }
    const right = reduceOnce(term.right, names);
    return right === undefined
      ? undefined
      : { term: { ...term, right: right.term }, rule: right.rule };
  }
  if (term.kind === "if") {
    const condition = reduceOnce(term.condition, names);
    return condition === undefined
      ? undefined
      : { term: { ...term, condition: condition.term }, rule: condition.rule };
  }
  if (term.kind === "superposition") {
    const left = reduceOnce(term.left, names);
    if (left !== undefined) {
      return { term: { ...term, left: left.term }, rule: left.rule };
    }
    const right = reduceOnce(term.right, names);
    return right === undefined
      ? undefined
      : { term: { ...term, right: right.term }, rule: right.rule };
  }
  if (term.kind === "duplication") {
    const value = reduceOnce(term.value, names);
    if (value !== undefined) {
      return { term: { ...term, value: value.term }, rule: value.rule };
    }
    const continuation = reduceOnce(term.continuation, names);
    return continuation === undefined ? undefined : {
      term: { ...term, continuation: continuation.term },
      rule: continuation.rule,
    };
  }
  return undefined;
}

function substitute(
  term: InteractionTerm,
  name: string,
  replacement: InteractionTerm,
): InteractionTerm {
  if (term.kind === "variable") return term.name === name ? replacement : term;
  if (term.kind === "lambda") {
    return term.parameter === name
      ? term
      : { ...term, body: substitute(term.body, name, replacement) };
  }
  if (term.kind === "apply") {
    return {
      ...term,
      callee: substitute(term.callee, name, replacement),
      argument: substitute(term.argument, name, replacement),
    };
  }
  if (term.kind === "binary") {
    return {
      ...term,
      left: substitute(term.left, name, replacement),
      right: substitute(term.right, name, replacement),
    };
  }
  if (term.kind === "if") {
    return {
      ...term,
      condition: substitute(term.condition, name, replacement),
      thenBranch: substitute(term.thenBranch, name, replacement),
      elseBranch: substitute(term.elseBranch, name, replacement),
    };
  }
  if (term.kind === "superposition") {
    return {
      ...term,
      left: substitute(term.left, name, replacement),
      right: substitute(term.right, name, replacement),
    };
  }
  if (term.kind === "duplication") {
    const value = substitute(term.value, name, replacement);
    if (term.leftName === name || term.rightName === name) {
      return { ...term, value };
    }
    return {
      ...term,
      value,
      continuation: substitute(term.continuation, name, replacement),
    };
  }
  return term;
}

function countVariable(term: InteractionTerm, name: string): number {
  if (term.kind === "variable") return term.name === name ? 1 : 0;
  if (term.kind === "lambda") {
    return term.parameter === name ? 0 : countVariable(term.body, name);
  }
  if (term.kind === "apply") {
    return countVariable(term.callee, name) +
      countVariable(term.argument, name);
  }
  if (term.kind === "binary" || term.kind === "superposition") {
    return countVariable(term.left, name) + countVariable(term.right, name);
  }
  if (term.kind === "if") {
    return countVariable(term.condition, name) +
      countVariable(term.thenBranch, name) +
      countVariable(term.elseBranch, name);
  }
  if (term.kind === "duplication") {
    return countVariable(term.value, name) +
      (term.leftName === name || term.rightName === name
        ? 0
        : countVariable(term.continuation, name));
  }
  return 0;
}

function replaceVariableOccurrences(
  term: InteractionTerm,
  name: string,
  replacements: readonly string[],
): InteractionTerm {
  let index = 0;
  const replace = (current: InteractionTerm): InteractionTerm => {
    if (current.kind === "variable") {
      if (current.name !== name) return current;
      const replacement = replacements[index];
      index += 1;
      return { kind: "variable", name: replacement };
    }
    if (current.kind === "lambda") {
      return current.parameter === name
        ? current
        : { ...current, body: replace(current.body) };
    }
    if (current.kind === "apply") {
      return {
        ...current,
        callee: replace(current.callee),
        argument: replace(current.argument),
      };
    }
    if (current.kind === "binary") {
      return {
        ...current,
        left: replace(current.left),
        right: replace(current.right),
      };
    }
    if (current.kind === "if") {
      return {
        ...current,
        condition: replace(current.condition),
        thenBranch: replace(current.thenBranch),
        elseBranch: replace(current.elseBranch),
      };
    }
    if (current.kind === "superposition") {
      return {
        ...current,
        left: replace(current.left),
        right: replace(current.right),
      };
    }
    if (current.kind === "duplication") {
      return {
        ...current,
        value: replace(current.value),
        continuation: current.leftName === name || current.rightName === name
          ? current.continuation
          : replace(current.continuation),
      };
    }
    return current;
  };
  const result = replace(term);
  if (index !== replacements.length) {
    throw new Error(
      `interaction linearization replaced ${index} occurrences of ${name}; expected ${replacements.length}`,
    );
  }
  return result;
}

function isScalar(
  term: InteractionTerm,
): term is Extract<InteractionTerm, { kind: "integer" | "boolean" }> {
  return term.kind === "integer" || term.kind === "boolean";
}

function replaceInteractionComptime(
  expression: Expression,
  results: InteractionResult[],
): Expression {
  if (expression.kind === "comptime" && expression.backend === "interaction") {
    const result = evaluateWithInteractionCalculus(expression.expression);
    results.push(result);
    return typeof result.value === "number"
      ? { kind: "integer", value: result.value, span: expression.span }
      : { kind: "boolean", value: result.value, span: expression.span };
  }
  switch (expression.kind) {
    case "lambda":
      return {
        ...expression,
        body: replaceInteractionComptime(expression.body, results),
      };
    case "apply":
      return {
        ...expression,
        callee: replaceInteractionComptime(expression.callee, results),
        argument: replaceInteractionComptime(expression.argument, results),
      };
    case "let":
      return {
        ...expression,
        value: replaceInteractionComptime(expression.value, results),
        body: replaceInteractionComptime(expression.body, results),
      };
    case "if":
      return {
        ...expression,
        condition: replaceInteractionComptime(expression.condition, results),
        thenBranch: replaceInteractionComptime(expression.thenBranch, results),
        elseBranch: replaceInteractionComptime(expression.elseBranch, results),
      };
    case "binary":
      return {
        ...expression,
        left: replaceInteractionComptime(expression.left, results),
        right: replaceInteractionComptime(expression.right, results),
      };
    case "case":
      return {
        ...expression,
        scrutinee: replaceInteractionComptime(expression.scrutinee, results),
        alternatives: expression.alternatives.map((alternative) => ({
          ...alternative,
          expression: replaceInteractionComptime(
            alternative.expression,
            results,
          ),
        })),
      };
    default:
      return expression;
  }
}

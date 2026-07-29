import type {
  DucklangExpression,
  DucklangName,
  DucklangStatement,
} from "./ducklang_ast.ts";

/**
 * Value-level hygiene for spliced Ducklang modules.
 *
 * A dependency's module-level bindings are spliced into the importer's statement
 * list, so its private names land in the importer's scope. That breaks both
 * directions: the importer's identically-named binding captures the
 * dependency's references, and the dependency's private bindings become visible
 * to the importer even though its export record does not list them.
 *
 * `renameDucklangValues` alpha-renames a chosen set of module-level names and
 * rewrites exactly the references that resolve to them, leaving any reference
 * that an inner binder shadows alone. The grammar's identifier rule admits only
 * letters, digits, and underscores, so a generated name carrying a marker
 * character can never collide with a source name.
 */

export type DucklangValueRenames = ReadonlyMap<string, string>;

export function renameDucklangValues(
  statements: readonly DucklangStatement[],
  renames: DucklangValueRenames,
): readonly DucklangStatement[] {
  if (renames.size === 0) return statements;
  // Module-level names are the ones being renamed, so nothing shadows them here.
  return rewriteStatements(statements, renames, new Set(), true);
}

/**
 * Renames references inside an expression that is not part of a statement list.
 *
 * An extension method body is inlined into whichever module calls the method, so its
 * free names have to be renamed with the module that declared it. Those bodies live
 * on `DucklangModule.extensions` rather than in `statements`, so renaming statements
 * alone left them referring to names that no longer exist.
 */
export function renameDucklangValuesInExpression(
  expression: DucklangExpression,
  renames: DucklangValueRenames,
): DucklangExpression {
  if (renames.size === 0) return expression;
  return rewriteExpression(expression, renames, new Set());
}

/**
 * A stable marker-separated name for a module-level binding, derived from the
 * declaring module's canonical source so the result does not depend on splice
 * order.
 */
export function hygienicDucklangName(name: string, source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${name}$${hash.toString(16).padStart(8, "0")}`;
}

function rewriteStatements(
  statements: readonly DucklangStatement[],
  renames: DucklangValueRenames,
  shadowed: ReadonlySet<string>,
  topLevel: boolean,
): readonly DucklangStatement[] {
  // Bindings take effect for the statements that follow them, so a nested scope
  // accumulates shadowed names as it goes. At the top level the bound names are
  // the renaming targets, so they must not be treated as shadowing.
  let scope = shadowed;
  const result: DucklangStatement[] = [];
  for (const statement of statements) {
    const bound = statementBoundNames(statement);
    const recursive = statement.kind === "binding" && statement.recursive ||
      statement.kind === "recursiveGroup";
    const valueScope = topLevel
      ? scope
      : recursive
      ? extend(scope, bound)
      : scope;
    result.push(rewriteStatement(statement, renames, valueScope, topLevel));
    if (!topLevel) scope = extend(scope, bound);
  }
  return result;
}

function rewriteStatement(
  statement: DucklangStatement,
  renames: DucklangValueRenames,
  shadowed: ReadonlySet<string>,
  topLevel: boolean,
): DucklangStatement {
  const name = (candidate: DucklangName): DucklangName =>
    topLevel ? renameName(candidate, renames, new Set()) : candidate;
  const expression = (candidate: DucklangExpression): DucklangExpression =>
    rewriteExpression(candidate, renames, shadowed);

  switch (statement.kind) {
    case "binding":
      return {
        ...statement,
        name: name(statement.name),
        value: expression(statement.value),
      };
    case "recursiveGroup":
      return {
        ...statement,
        bindings: statement.bindings.map((binding) => ({
          ...binding,
          name: name(binding.name),
          value: expression(binding.value),
        })),
      };
    case "unionBinding":
      return {
        ...statement,
        name: name(statement.name),
        value: expression(statement.value),
        alternative: expression(statement.alternative),
      };
    case "productBinding":
      return {
        ...statement,
        names: statement.names.map((candidate) =>
          candidate === undefined ? undefined : name(candidate)
        ),
        value: expression(statement.value),
      };
    case "recordBinding":
      return {
        ...statement,
        fields: statement.fields.map((field) => ({
          ...field,
          localName: name(field.localName),
        })),
        value: expression(statement.value),
      };
    case "assignment":
      return {
        ...statement,
        name: renameName(statement.name, renames, shadowed),
        value: expression(statement.value),
      };
    case "forRange":
      return {
        ...statement,
        start: expression(statement.start),
        end: expression(statement.end),
        step: statement.step === undefined
          ? undefined
          : expression(statement.step),
        body: rewriteExpression(
          statement.body,
          renames,
          extend(shadowed, boundNames([statement.iterator])),
        ),
      };
    case "forCollection":
      return {
        ...statement,
        collection: expression(statement.collection),
        body: rewriteExpression(
          statement.body,
          renames,
          extend(shadowed, boundNames([statement.index, statement.value])),
        ),
      };
    case "break":
      return {
        ...statement,
        value: statement.value === undefined
          ? undefined
          : expression(statement.value),
      };
    case "return":
      return { ...statement, expression: expression(statement.expression) };
    case "expression":
      return { ...statement, expression: expression(statement.expression) };
    case "effectDeclaration":
    case "initDeclaration":
    case "unionType":
    case "structType":
    case "typeAlias":
    case "continue":
      return statement;
    case "import":
      return {
        ...statement,
        namespace: statement.namespace === undefined
          ? undefined
          : name(statement.namespace),
        selections: statement.selections.map((selection) => {
          const localName = selection.localName ?? {
            text: selection.exportName,
            span: selection.span,
          };
          const renamed = name(localName);
          return renamed.text === selection.exportName
            ? selection
            : { ...selection, localName: renamed };
        }),
      };
    case "typePattern":
      return { ...statement, target: expression(statement.target) };
  }
}

function rewriteExpression(
  expression: DucklangExpression,
  renames: DucklangValueRenames,
  shadowed: ReadonlySet<string>,
): DucklangExpression {
  const recur = (candidate: DucklangExpression): DucklangExpression =>
    rewriteExpression(candidate, renames, shadowed);

  switch (expression.kind) {
    case "reference": {
      const renamed = renameName(expression.name, renames, shadowed);
      return renamed === expression.name
        ? expression
        : { ...expression, name: renamed };
    }
    case "function":
      return {
        ...expression,
        parameterTypeSources: expression.parameterTypeSources?.map(recur),
        body: rewriteExpression(
          expression.body,
          renames,
          extend(shadowed, boundNames(expression.parameters)),
        ),
      };
    case "block":
      return {
        ...expression,
        statements: rewriteStatements(
          expression.statements,
          renames,
          shadowed,
          false,
        ),
      };
    case "ifUnion":
      return {
        ...expression,
        value: recur(expression.value),
        consequence: rewriteExpression(
          expression.consequence,
          renames,
          extend(shadowed, boundNames([expression.payloadName])),
        ),
        alternative: expression.alternative === undefined
          ? undefined
          : recur(expression.alternative),
      };
    case "if":
      return {
        ...expression,
        condition: recur(expression.condition),
        consequence: recur(expression.consequence),
        alternative: expression.alternative === undefined
          ? undefined
          : recur(expression.alternative),
      };
    case "call":
      return {
        ...expression,
        callee: recur(expression.callee),
        arguments: expression.arguments.map(recur),
      };
    case "recursiveCall":
      return { ...expression, arguments: expression.arguments.map(recur) };
    case "hostCall":
      return { ...expression, arguments: expression.arguments.map(recur) };
    case "field":
      return { ...expression, product: recur(expression.product) };
    case "recordUpdate":
      return {
        ...expression,
        product: recur(expression.product),
        fields: expression.fields.map((field) => ({
          ...field,
          value: recur(field.value),
        })),
      };
    case "record":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          value: recur(field.value),
        })),
      };
    case "product":
      return { ...expression, values: expression.values.map(recur) };
    case "unionCase":
      return { ...expression, value: recur(expression.value) };
    case "index":
      return {
        ...expression,
        collection: recur(expression.collection),
        index: recur(expression.index),
      };
    case "indexUpdate":
      return {
        ...expression,
        product: recur(expression.product),
        index: recur(expression.index),
        value: recur(expression.value),
      };
    case "binary":
      return {
        ...expression,
        left: recur(expression.left),
        right: recur(expression.right),
      };
    case "unary":
      return { ...expression, operand: recur(expression.operand) };
    case "optionDo":
      return { ...expression, option: recur(expression.option) };
    case "comptime":
      return { ...expression, expression: recur(expression.expression) };
    case "scratch":
      return { ...expression, body: recur(expression.body) };
    case "loop":
      return { ...expression, body: recur(expression.body) };
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "moduleImport":
      return expression;
  }
}

function statementBoundNames(
  statement: DucklangStatement,
): readonly (DucklangName | undefined)[] {
  switch (statement.kind) {
    case "binding":
    case "unionBinding":
      return [statement.name];
    case "recursiveGroup":
      return statement.bindings.map((binding) => binding.name);
    case "productBinding":
      return statement.names;
    case "recordBinding":
      return statement.fields.map((field) => field.localName);
    case "import":
      return [
        statement.namespace,
        ...statement.selections.map((selection) =>
          selection.localName ?? {
            text: selection.exportName,
            span: selection.span,
          }
        ),
      ];
    default:
      return [];
  }
}

function boundNames(
  names: readonly (DucklangName | undefined)[],
): readonly string[] {
  return names.flatMap((name) => name === undefined ? [] : [name.text]);
}

function extend(
  shadowed: ReadonlySet<string>,
  names: readonly (DucklangName | undefined)[] | readonly string[],
): ReadonlySet<string> {
  const texts = names.map((name) =>
    typeof name === "string" ? name : name?.text
  ).filter((name): name is string => name !== undefined);
  if (texts.length === 0) return shadowed;
  const extended = new Set(shadowed);
  for (const text of texts) extended.add(text);
  return extended;
}

function renameName(
  name: DucklangName,
  renames: DucklangValueRenames,
  shadowed: ReadonlySet<string>,
): DucklangName {
  if (shadowed.has(name.text)) return name;
  const renamed = renames.get(name.text);
  return renamed === undefined ? name : { ...name, text: renamed };
}

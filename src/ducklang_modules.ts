import type {
  DucklangExpression,
  DucklangModule,
  DucklangStatement,
} from "./ducklang_ast.ts";
import { parseDucklangModule } from "./ducklang_parser.ts";

export async function resolveDucklangLocalImports(
  module: DucklangModule,
): Promise<DucklangModule> {
  return await resolveModuleImports(module, []);
}

async function resolveModuleImports(
  module: DucklangModule,
  ancestry: readonly string[],
): Promise<DucklangModule> {
  const statements: DucklangStatement[] = [];
  for (const statement of module.statements) {
    if (statement.kind !== "import" || !statement.path.startsWith(".")) {
      statements.push(statement);
      continue;
    }
    const separator = Math.max(
      module.file.lastIndexOf("/"),
      module.file.lastIndexOf("\\"),
    );
    const directory = separator < 0 ? "." : module.file.slice(0, separator);
    let dependencyFile: string;
    try {
      dependencyFile = await Deno.realPath(`${directory}/${statement.path}`);
    } catch (cause) {
      throw new TypeError(
        `${module.file}:${statement.span.start}: cannot resolve Ducklang import ${
          JSON.stringify(statement.path)
        }`,
        { cause },
      );
    }
    if (ancestry.includes(dependencyFile)) {
      throw new TypeError(
        `${module.file}:${statement.span.start}: cyclic Ducklang import ${
          [...ancestry, dependencyFile].join(" -> ")
        }`,
      );
    }
    const dependency = await resolveModuleImports(
      await parseDucklangModule(
        dependencyFile,
        await Deno.readTextFile(dependencyFile),
      ),
      [...ancestry, dependencyFile],
    );
    if (statement.open) {
      statements.push(
        ...openModuleBindings(module.file, statement, dependency),
      );
      continue;
    }
    if (statement.namespace === undefined) {
      throw new SyntaxError(
        `${module.file}:${statement.span.start}: local Ducklang import ${
          JSON.stringify(statement.path)
        } requires a namespace or open selection`,
      );
    }
    const namespace = statement.namespace;
    let dependencyStatements = dependency.statements;
    const parameters = dependency.parameters.map((parameter, index) => {
      const fieldNames = collectParameterFields(dependency, parameter.text);
      if (fieldNames.length === 0) return parameter;
      const typeName = `$module_${namespace.text}_parameter_${index}`;
      statements.push({
        kind: "structType",
        name: typeName,
        fields: fieldNames.map((name) => ({
          name,
          type: { name: "Int", arguments: [], span: parameter.span },
          span: parameter.span,
        })),
        span: parameter.span,
      });
      return { ...parameter, declaredType: typeName };
    });
    const dependencyResult = dependencyStatements.at(-1);
    if (
      dependencyResult?.kind === "expression" &&
      dependencyResult.expression.kind === "record"
    ) {
      const typeName = `$module_${namespace.text}_exports`;
      statements.push({
        kind: "structType",
        name: typeName,
        fields: dependencyResult.expression.fields.map((field) => ({
          name: field.name,
          type: { name: "Int", arguments: [], span: field.span },
          span: field.span,
        })),
        span: dependencyResult.span,
      });
      dependencyStatements = [
        ...dependencyStatements.slice(0, -1),
        {
          ...dependencyResult,
          expression: { ...dependencyResult.expression, nominalType: typeName },
        },
      ];
    }
    const body: DucklangExpression = {
      kind: "block",
      statements: dependencyStatements,
      span: dependency.span,
    };
    statements.push({
      kind: "binding",
      declarationKind: "const",
      recursive: false,
      name: namespace,
      value: parameters.length === 0 ? body : {
        kind: "function",
        recursive: false,
        parameters,
        body,
        span: dependency.span,
      },
      span: statement.span,
    });
  }
  return { ...module, statements };
}

function collectParameterFields(
  module: DucklangModule,
  parameterName: string,
): readonly string[] {
  const fields = new Set<string>();
  const pending: unknown[] = [...module.statements];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    const product = node.product as Record<string, unknown> | undefined;
    const name = product?.name as Record<string, unknown> | undefined;
    if (
      node.kind === "field" && product?.kind === "reference" &&
      name?.text === parameterName && typeof node.fieldName === "string"
    ) {
      fields.add(node.fieldName);
    }
    pending.push(...Object.values(node));
  }
  return [...fields];
}

function openModuleBindings(
  file: string,
  statement: Extract<DucklangStatement, { readonly kind: "import" }>,
  dependency: DucklangModule,
): readonly DucklangStatement[] {
  if (dependency.parameters.length !== 0) {
    throw new TypeError(
      `${file}:${statement.span.start}: open Ducklang import ${
        JSON.stringify(statement.path)
      } requires a parameterless module`,
    );
  }
  const result = dependency.statements.at(-1);
  if (result?.kind !== "expression" || result.expression.kind !== "record") {
    throw new TypeError(
      `${file}:${statement.span.start}: open Ducklang import ${
        JSON.stringify(statement.path)
      } does not return an export record`,
    );
  }
  const exportedNames = new Set(
    result.expression.fields.map((field) => field.name),
  );
  const selections = new Map(
    statement.selections.map((selection) => [selection.exportName, selection]),
  );
  for (const selection of statement.selections) {
    if (!exportedNames.has(selection.exportName)) {
      throw new ReferenceError(
        `${file}:${selection.span.start}: Ducklang module ${
          JSON.stringify(statement.path)
        } does not export ${selection.exportName}`,
      );
    }
  }
  return dependency.statements.flatMap((dependencyStatement) => {
    if (dependencyStatement.kind !== "binding") return [];
    if (!exportedNames.has(dependencyStatement.name.text)) return [];
    const selection = selections.get(dependencyStatement.name.text);
    if (selection?.localName === undefined && selection !== undefined) {
      return [];
    }
    const name = selection?.localName ?? dependencyStatement.name;
    return [{ ...dependencyStatement, name }];
  });
}

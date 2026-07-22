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

export function lowerDucklangEmptyModuleExports(
  module: DucklangModule,
): DucklangModule {
  const result = module.statements.at(-1);
  if (
    result?.kind !== "expression" || result.expression.kind !== "record" ||
    result.expression.fields.length !== 0
  ) {
    return module;
  }
  return {
    ...module,
    statements: [
      ...module.statements.slice(0, -1),
      {
        ...result,
        expression: { kind: "unit", span: result.expression.span },
      },
    ],
  };
}

export async function applyDucklangHostInterface(
  module: DucklangModule,
  interfaceFile: string,
): Promise<DucklangModule> {
  let canonicalFile: string;
  try {
    canonicalFile = await Deno.realPath(interfaceFile);
  } catch (cause) {
    throw new TypeError(
      `${module.file}: cannot resolve Ducklang host interface ${
        JSON.stringify(interfaceFile)
      }`,
      { cause },
    );
  }
  const hostModule = await parseDucklangModule(
    canonicalFile,
    await expandDucklangIncludes(
      canonicalFile,
      await Deno.readTextFile(canonicalFile),
    ),
  );
  if (hostModule.parameters.length > 0) {
    throw new TypeError(
      `${canonicalFile}: Ducklang host interface must not take module parameters`,
    );
  }
  const declarations = hostModule.statements.filter((statement) =>
    statement.kind === "effectDeclaration" ||
    statement.kind === "initDeclaration"
  );
  if (declarations.length === 0) {
    throw new TypeError(
      `${canonicalFile}: Ducklang host interface declares no effects or Init capabilities`,
    );
  }
  const executableStatement = hostModule.statements.find((statement, index) => {
    if (
      statement.kind === "effectDeclaration" ||
      statement.kind === "initDeclaration"
    ) {
      return false;
    }
    return !(index === hostModule.statements.length - 1 &&
      statement.kind === "expression" &&
      statement.expression.kind === "record" &&
      statement.expression.fields.length === 0);
  });
  if (executableStatement !== undefined) {
    throw new TypeError(
      `${canonicalFile}:${executableStatement.span.start}: Ducklang host interface must contain declarations only; found ${executableStatement.kind}`,
    );
  }
  return {
    ...module,
    statements: [...declarations, ...module.statements],
  };
}

export async function expandDucklangIncludes(
  file: string,
  source: string,
): Promise<string> {
  const matches = [...source.matchAll(/\binclude[ \t]+"([^"]+)"/g)];
  if (matches.length === 0) return source;
  const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const directory = separator < 0 ? "." : file.slice(0, separator);
  let expanded = "";
  let offset = 0;
  for (const match of matches) {
    const start = match.index;
    const path = match[1];
    let included: string;
    try {
      included = await Deno.readTextFile(`${directory}/${path}`);
    } catch (cause) {
      throw new TypeError(
        `${file}:${start}: cannot include Ducklang file ${
          JSON.stringify(path)
        }`,
        { cause },
      );
    }
    expanded += source.slice(offset, start) + JSON.stringify(included);
    offset = start + match[0].length;
  }
  return expanded + source.slice(offset);
}

async function resolveModuleImports(
  module: DucklangModule,
  ancestry: readonly string[],
): Promise<DucklangModule> {
  const statements: DucklangStatement[] = [];
  const specializedFunctionExports = new Map<
    string,
    ReadonlyMap<string, DucklangStatement & { readonly kind: "binding" }>
  >();
  for (const statement of module.statements) {
    if (statement.kind !== "import" || !statement.path.startsWith(".")) {
      if (statement.kind === "binding") {
        const selected = selectSpecializedFunctionExport(
          statement.value,
          specializedFunctionExports,
        );
        if (selected !== undefined) {
          statements.push({
            ...statement,
            value: {
              kind: "reference",
              name: selected.name,
              span: statement.value.span,
            },
          });
          continue;
        }
      }
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
        await expandDucklangIncludes(
          dependencyFile,
          await Deno.readTextFile(dependencyFile),
        ),
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
    const rawDependencyResult = dependency.statements.at(-1);
    if (
      dependency.parameters.every((parameter) =>
        !referencesName(dependency.statements, parameter.text)
      ) && rawDependencyResult?.kind === "expression" &&
      rawDependencyResult.expression.kind === "record"
    ) {
      const dependencyBindings = new Map(
        dependency.statements.flatMap((dependencyStatement) =>
          dependencyStatement.kind === "binding"
            ? [[dependencyStatement.name.text, dependencyStatement] as const]
            : []
        ),
      );
      const exportedFunctions = new Map<
        string,
        DucklangStatement & { readonly kind: "binding" }
      >();
      const renamedBindings: (DucklangStatement & {
        readonly kind: "binding";
      })[] = [];
      for (const field of rawDependencyResult.expression.fields) {
        if (field.value.kind !== "reference") continue;
        const binding = dependencyBindings.get(field.value.name.text);
        if (binding?.value.kind !== "function") continue;
        const renamed = {
          ...binding,
          name: {
            ...binding.name,
            text: `$module_${namespace.text}_${binding.name.text}`,
          },
        };
        renamedBindings.push(renamed);
        exportedFunctions.set(field.name, renamed);
      }
      if (
        exportedFunctions.size > 0 &&
        exportedFunctions.size === rawDependencyResult.expression.fields.length
      ) {
        statements.push(...renamedBindings);
        specializedFunctionExports.set(namespace.text, exportedFunctions);
        continue;
      }
    }
    let dependencyStatements = dependency.statements;
    const parameters = dependency.parameters.map((parameter, index) => {
      const fieldNames = collectParameterFields(dependency, parameter.text);
      if (fieldNames.length === 0) return parameter;
      const typeName = `$module_${namespace.text}_parameter_${index}`;
      statements.push({
        kind: "structType",
        name: typeName,
        parameters: [],
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
        parameters: [],
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

function selectSpecializedFunctionExport(
  expression: DucklangExpression,
  modules: ReadonlyMap<
    string,
    ReadonlyMap<string, DucklangStatement & { readonly kind: "binding" }>
  >,
): (DucklangStatement & { readonly kind: "binding" }) | undefined {
  if (expression.kind !== "field") return undefined;
  const namespace = expression.product.kind === "call" &&
      expression.product.callee.kind === "reference"
    ? expression.product.callee.name.text
    : expression.product.kind === "reference"
    ? expression.product.name.text
    : undefined;
  return namespace === undefined
    ? undefined
    : modules.get(namespace)?.get(expression.fieldName);
}

function referencesName(values: unknown, name: string): boolean {
  const pending: unknown[] = [values];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    const referenceName = node.name as Record<string, unknown> | undefined;
    if (
      node.kind === "reference" && referenceName?.text === name
    ) {
      return true;
    }
    pending.push(...Object.values(node));
  }
  return false;
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

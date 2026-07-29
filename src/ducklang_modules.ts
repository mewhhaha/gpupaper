import {
  type DucklangExpression,
  type DucklangModule,
  ducklangNamedType,
  type DucklangStatement,
} from "./ducklang_ast.ts";
import {
  buildDucklangModuleGraph,
  createDucklangFilesystemSourceProvider,
  createDucklangModuleInstanceCache,
  type DucklangModuleGraph,
  ducklangModuleInstanceKey,
  type DucklangModuleInstances,
  type DucklangSourceProvider,
  expandDucklangIncludes,
  type ModuleId,
  moduleId,
} from "./ducklang_module_graph.ts";
import {
  hygienicDucklangName,
  renameDucklangValues,
  renameDucklangValuesInExpression,
} from "./ducklang_hygiene.ts";
import { parseDucklangModule } from "./ducklang_parser.ts";
import { resolveImportedPrimitive } from "./ducklang_primitives.ts";
import type { SourceSpan } from "./syntax.ts";

export type DucklangLinkOptions = {
  readonly sourceProvider?: DucklangSourceProvider;
  /**
   * Analyzed module instances. Supplying a cache lets a caller share analyses
   * across roots and observe how many analyses the link actually performed.
   */
  readonly instances?: DucklangModuleInstances<DucklangModule>;
};

export async function resolveDucklangLocalImports(
  module: DucklangModule,
  rootSource?: string,
  options: DucklangLinkOptions = {},
): Promise<DucklangModule> {
  const instances = options.instances ??
    createDucklangModuleInstanceCache<DucklangModule>();
  const hasGraphImports = module.statements.some((statement) =>
    statement.kind === "import" &&
    (statement.path.startsWith(".") ||
      isSourceBackedDucklangModule(statement.path))
  );
  if (!hasGraphImports) {
    return await resolveModuleImports(module, moduleId(module.file), instances);
  }

  let canonicalSource: string;
  let source: string;
  if (rootSource !== undefined) {
    source = rootSource;
    try {
      canonicalSource = await Deno.realPath(module.file);
    } catch {
      canonicalSource = module.file;
    }
  } else {
    try {
      canonicalSource = await Deno.realPath(module.file);
      source = await Deno.readTextFile(canonicalSource);
    } catch (cause) {
      throw new TypeError(
        `${module.file}: cannot construct a module graph without readable root source`,
        { cause },
      );
    }
  }
  const graph = await buildDucklangModuleGraph({
    root: {
      canonicalSource,
      file: canonicalSource,
      source,
    },
    parsedRoot: module,
    sourceProvider: options.sourceProvider ??
      createDucklangFilesystemSourceProvider(),
    followImport: (importPath) =>
      importPath.startsWith(".") || isSourceBackedDucklangModule(importPath),
  });
  const linked = await resolveModuleImports(
    module,
    graph.rootId,
    instances,
    graph,
  );
  return mergeImportedDeclarations(linked, graph);
}

export function lowerDucklangModuleExports(
  module: DucklangModule,
): DucklangModule {
  const result = module.statements.at(-1);
  if (
    result?.kind !== "expression" || result.expression.kind !== "record" ||
    result.expression.nominalType !== undefined ||
    result.expression.fields.length !== module.exportNames.length ||
    !module.exportNames.every((name, index) =>
      result.expression.kind === "record" &&
      result.expression.fields[index]?.name === name
    )
  ) {
    return module;
  }
  const expression: DucklangExpression = result.expression.fields.length === 0
    ? { kind: "unit", span: result.expression.span }
    : result.expression.fields.length === 1
    ? result.expression.fields[0].value
    : {
      kind: "product",
      productKind: "tuple",
      values: result.expression.fields.map((field) => field.value),
      span: result.expression.span,
    };
  return {
    ...module,
    statements: [
      ...module.statements.slice(0, -1),
      {
        ...result,
        expression,
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
  const hostDeclarationKinds = new Set<DucklangStatement["kind"]>([
    "effectDeclaration",
    "initDeclaration",
    "structType",
    "unionType",
    "typeAlias",
  ]);
  const declarations = hostModule.statements.filter((statement) =>
    hostDeclarationKinds.has(statement.kind)
  );
  if (
    !declarations.some((statement) =>
      statement.kind === "effectDeclaration" ||
      statement.kind === "initDeclaration"
    )
  ) {
    throw new TypeError(
      `${canonicalFile}: Ducklang host interface declares no effects or Init capabilities`,
    );
  }
  const executableStatement = hostModule.statements.find((statement, index) => {
    if (hostDeclarationKinds.has(statement.kind)) return false;
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

async function resolveModuleImports(
  module: DucklangModule,
  currentModuleId: ModuleId,
  instances: DucklangModuleInstances<DucklangModule>,
  graph?: DucklangModuleGraph,
): Promise<DucklangModule> {
  const statements: DucklangStatement[] = [];
  for (const statement of module.statements) {
    if (
      statement.kind === "binding" &&
      statement.declarationKind === "module"
    ) {
      if (statement.value.kind !== "function") {
        throw new TypeError(
          `${module.file}:${statement.span.start}: Ducklang module binding ${statement.name.text} must be a function`,
        );
      }
      const parameters = statement.value.parameters.map((parameter, index) => {
        const fieldNames = collectParameterFields(
          statement.value,
          parameter.text,
        );
        if (fieldNames.length === 0) {
          return { ...parameter, compileTimeRecord: true };
        }
        const typeName = `$module_${statement.name.text}_parameter_${index}`;
        statements.push(moduleRecordStructType(
          typeName,
          fieldNames.map((name) => ({ name, span: parameter.span })),
          parameter.span,
        ));
        return {
          ...parameter,
          compileTimeRecord: true,
          declaredType: ducklangNamedType(typeName, parameter.span),
        };
      });
      const directResult = statement.value.body.kind === "record"
        ? statement.value.body
        : undefined;
      const trailingStatement = statement.value.body.kind === "block"
        ? statement.value.body.statements.at(-1)
        : undefined;
      const blockResult = trailingStatement?.kind === "expression" &&
          trailingStatement.expression.kind === "record"
        ? trailingStatement.expression
        : undefined;
      const result = directResult ?? blockResult;
      if (result === undefined) {
        throw new TypeError(
          `${module.file}:${statement.value.body.span.start}: Ducklang module binding ${statement.name.text} must return an export record`,
        );
      }
      const resultTypeName = `$module_${statement.name.text}_exports`;
      statements.push(moduleRecordStructType(
        resultTypeName,
        result.fields.map((field) => ({
          name: field.name,
          span: field.span,
        })),
        result.span,
      ));
      let body: DucklangExpression;
      if (directResult !== undefined) {
        body = { ...directResult, nominalType: resultTypeName };
      } else {
        if (
          statement.value.body.kind !== "block" ||
          trailingStatement?.kind !== "expression"
        ) {
          throw new Error(
            `${module.file}:${statement.value.body.span.start}: missing elaborated export record for module binding ${statement.name.text}`,
          );
        }
        body = {
          ...statement.value.body,
          statements: [
            ...statement.value.body.statements.slice(0, -1),
            {
              ...trailingStatement,
              expression: { ...result, nominalType: resultTypeName },
            },
          ],
        };
      }
      statements.push({
        ...statement,
        declarationKind: "const",
        value: {
          ...statement.value,
          parameters,
          body,
        },
      });
      continue;
    }
    if (
      statement.kind === "import" &&
      !statement.open &&
      statement.namespace === undefined &&
      statement.selections.length > 0 &&
      statement.selections.every((selection) =>
        resolveImportedPrimitive(statement.path, selection.exportName) !==
          undefined
      )
    ) {
      statements.push({
        ...statement,
        selections: statement.selections.map((selection) => ({
          ...selection,
          localName: selection.localName ?? {
            text: selection.exportName,
            span: selection.span,
          },
        })),
      });
      continue;
    }
    const graphImport = statement.kind === "import"
      ? graph?.modules.get(currentModuleId)?.imports.find((candidate) =>
        candidate.path === statement.path &&
        candidate.span.start === statement.span.start
      )
      : undefined;
    if (
      statement.kind !== "import" ||
      (!statement.path.startsWith(".") && graphImport === undefined)
    ) {
      statements.push(statement);
      continue;
    }
    // The module graph owns source resolution, parsing, and cycle detection, so
    // every followed import must already have a node. A missing node means the
    // graph and the linker disagree about which imports are followed.
    const dependencyNode = graph === undefined || graphImport === undefined
      ? undefined
      : graph.modules.get(graphImport.moduleId);
    if (dependencyNode === undefined) {
      throw new Error(
        `${module.file}:${statement.span.start}: module graph is missing ${
          JSON.stringify(statement.path)
        }`,
      );
    }
    const rawDependency = await instances.instantiate(
      ducklangModuleInstanceKey({
        moduleId: dependencyNode.id,
        sourceHash: dependencyNode.sourceHash,
        parameterNames: dependencyNode.module.parameters.map(
          (parameter) => parameter.text,
        ),
        // Module parameters stay unbound until compile-time evaluation applies
        // the export function, so every instance shares the empty environment.
        argumentKeys: [],
      }),
      () =>
        resolveModuleImports(
          dependencyNode.module,
          dependencyNode.id,
          instances,
          graph,
        ),
    );
    // Every splice path below receives a dependency whose private bindings
    // already carry hygienic names, so no path can capture or expose one.
    const dependency = hygieniseDucklangDependency(rawDependency);
    if (
      statement.open ||
      (statement.namespace === undefined && statement.selections.length > 0)
    ) {
      statements.push(
        ...openModuleBindings(module.file, statement, dependency),
      );
      continue;
    }
    if (
      statement.namespace === undefined && statement.selections.length === 0
    ) {
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
    const instanceRenames = new Map(
      dependency.statements.flatMap((dependencyStatement) =>
        statementValueNames(dependencyStatement).map((name) =>
          [
            name,
            hygienicDucklangName(
              `${namespace.text}_${name}`,
              dependency.file,
            ),
          ] as const
        )
      ),
    );
    const dependencyStatements = renameDucklangValues(
      dependency.statements,
      instanceRenames,
    );
    const trailingDependencyStatement = dependencyStatements.at(-1);
    const dependencyExportExpression =
      trailingDependencyStatement?.kind === "expression" &&
        trailingDependencyStatement.expression.kind === "record"
        ? trailingDependencyStatement.expression
        : trailingDependencyStatement?.kind === "expression" &&
            trailingDependencyStatement.expression.kind === "call" &&
            trailingDependencyStatement.expression.callee.kind ===
              "reference" &&
            trailingDependencyStatement.expression.callee.name.text ===
              "return" &&
            trailingDependencyStatement.expression.arguments.length === 1 &&
            trailingDependencyStatement.expression.arguments[0].kind ===
              "record"
        ? trailingDependencyStatement.expression.arguments[0]
        : undefined;
    if (
      trailingDependencyStatement === undefined ||
      dependencyExportExpression === undefined
    ) {
      throw new TypeError(
        `${module.file}:${statement.span.start}: Ducklang module ${
          JSON.stringify(statement.path)
        } does not return an export record`,
      );
    }

    const parameters = dependency.parameters.map((parameter, index) => {
      const fieldNames = collectParameterFields(dependency, parameter.text);
      if (fieldNames.length === 0) {
        return { ...parameter, compileTimeRecord: true };
      }
      const typeName = `$module_${namespace.text}_parameter_${index}`;
      statements.push(moduleRecordStructType(
        typeName,
        fieldNames.map((name) => ({ name, span: parameter.span })),
        parameter.span,
      ));
      return {
        ...parameter,
        compileTimeRecord: true,
        declaredType: ducklangNamedType(typeName, parameter.span),
      };
    });
    const exportTypeName = `$module_${namespace.text}_exports`;
    statements.push(moduleRecordStructType(
      exportTypeName,
      dependencyExportExpression.fields.map((field) => ({
        name: field.name,
        span: field.span,
      })),
      dependencyExportExpression.span,
    ));
    const exportExpression = {
      ...dependencyExportExpression,
      nominalType: exportTypeName,
    };

    const declarations = new Set<DucklangStatement["kind"]>([
      "effectDeclaration",
      "initDeclaration",
      "unionType",
      "structType",
      "typeAlias",
      "typePattern",
      "import",
    ]);
    const dependencyBodyStatements: DucklangStatement[] = [];
    const declaredTypeKeys = new Set(statements.flatMap(statementTypeKeys));
    for (const dependencyStatement of dependencyStatements.slice(0, -1)) {
      const typeKeys = statementTypeKeys(dependencyStatement);
      if (typeKeys.some((key) => declaredTypeKeys.has(key))) continue;
      if (
        parameters.length > 0 && !declarations.has(dependencyStatement.kind)
      ) {
        dependencyBodyStatements.push(dependencyStatement);
        continue;
      }
      statements.push(dependencyStatement);
      for (const key of typeKeys) declaredTypeKeys.add(key);
    }

    const renamedExtensions = dependency.extensions.map((extension) => ({
      ...extension,
      methods: extension.methods.map((method) => ({
        ...method,
        value: renameDucklangValuesInExpression(
          method.value,
          instanceRenames,
        ),
      })),
    }));
    const protocolNames = new Set(
      module.protocols.map((protocol) => protocol.name),
    );
    module = {
      ...module,
      protocols: [
        ...module.protocols,
        ...dependency.protocols.filter((protocol) =>
          !protocolNames.has(protocol.name)
        ),
      ],
      extensions: [...module.extensions, ...renamedExtensions],
      fixities: [...module.fixities, ...dependency.fixities],
    };

    const value: DucklangExpression = parameters.length === 0
      ? exportExpression
      : {
        kind: "function",
        recursive: false,
        parameters,
        body: {
          kind: "block",
          statements: [
            ...dependencyBodyStatements,
            {
              kind: "expression",
              expression: exportExpression,
              span: trailingDependencyStatement.span,
            },
          ],
          span: dependency.span,
        },
        span: dependency.span,
      };
    statements.push({
      kind: "binding",
      declarationKind: "const",
      recursive: false,
      name: namespace,
      value,
      span: statement.span,
    });
  }
  return { ...module, statements };
}

/**
 * A synthetic struct for a module parameter record or export record.
 *
 * Every field takes its own type parameter rather than a hardcoded `Int`, so an
 * annotation that supplies no arguments gets one fresh type variable per field
 * and inference decides each field's type. Hardcoding `Int` made any module
 * record carrying a non-i32 field fail to unify.
 */
function moduleRecordStructType(
  typeName: string,
  fieldSpans: readonly { readonly name: string; readonly span: SourceSpan }[],
  span: SourceSpan,
): DucklangStatement {
  const parameters = fieldSpans.map((_, index) => `t${index}`);
  return {
    kind: "structType",
    name: typeName,
    parameters,
    fields: fieldSpans.map((field, index) => ({
      name: field.name,
      type: { name: parameters[index], arguments: [], span: field.span },
      span: field.span,
    })),
    span,
  };
}

function statementValueNames(statement: DucklangStatement): readonly string[] {
  switch (statement.kind) {
    case "binding":
      return [statement.name.text];
    case "recursiveGroup":
      return statement.bindings.map((binding) => binding.name.text);
    case "unionBinding":
      return [statement.name.text];
    case "productBinding":
      return statement.names.flatMap((name) =>
        name === undefined ? [] : [name.text]
      );
    case "recordBinding":
      return statement.fields.map((field) => field.localName.text);
    case "import":
      return [
        ...(statement.namespace === undefined
          ? []
          : [statement.namespace.text]),
        ...statement.selections.flatMap((
          selection,
        ) => [selection.localName?.text ?? selection.exportName]),
      ];
    case "effectDeclaration":
    case "initDeclaration":
    case "unionType":
    case "structType":
    case "typeAlias":
    case "typePattern":
    case "forRange":
    case "forCollection":
    case "break":
    case "continue":
    case "assignment":
    case "return":
    case "expression":
      return [];
  }
}

function statementTypeNames(statement: DucklangStatement): readonly string[] {
  switch (statement.kind) {
    case "unionType":
    case "structType":
    case "typeAlias":
      return [statement.name];
    case "effectDeclaration":
    case "initDeclaration":
    case "recursiveGroup":
    case "typePattern":
    case "import":
    case "binding":
    case "unionBinding":
    case "productBinding":
    case "recordBinding":
    case "forRange":
    case "forCollection":
    case "break":
    case "continue":
    case "assignment":
    case "return":
    case "expression":
      return [];
  }
}

function statementTypeKeys(statement: DucklangStatement): readonly string[] {
  return statementTypeNames(statement).map((name) =>
    `${statement.span.file}\u0000${name}`
  );
}

function isSourceBackedDucklangModule(importPath: string): boolean {
  return importPath.startsWith("duck:");
}

function mergeImportedDeclarations(
  module: DucklangModule,
  graph: DucklangModuleGraph,
): DucklangModule {
  const declarationKinds = new Set<DucklangStatement["kind"]>([
    "effectDeclaration",
    "initDeclaration",
    "unionType",
    "structType",
    "typeAlias",
    "typePattern",
  ]);
  const seenDeclarations = new Set<string>();
  const linkedStatements = module.statements.filter((statement) => {
    if (!declarationKinds.has(statement.kind)) return true;
    const identity =
      `${statement.kind}\u0000${statement.span.file}\u0000${statement.span.start}`;
    if (seenDeclarations.has(identity)) return false;
    seenDeclarations.add(identity);
    return true;
  });
  const typeKeys = new Set(linkedStatements.flatMap(statementTypeKeys));
  const declarations: DucklangStatement[] = [];
  const protocols = [...module.protocols];
  const protocolNames = new Set(protocols.map((protocol) => protocol.name));
  const extensions = [...module.extensions];
  const extensionKeys = new Set(
    module.extensions.map((extension) =>
      `${extension.span.file}\u0000${extension.span.start}`
    ),
  );
  const fixities = [...module.fixities];

  for (const node of graph.modules.values()) {
    if (node.id === graph.rootId) continue;
    for (const statement of node.module.statements) {
      if (
        statement.kind !== "unionType" &&
        statement.kind !== "structType" &&
        statement.kind !== "typeAlias" &&
        statement.kind !== "typePattern"
      ) {
        continue;
      }
      const keys = statementTypeKeys(statement);
      if (keys.some((key) => typeKeys.has(key))) continue;
      declarations.push(statement);
      for (const key of keys) typeKeys.add(key);
    }
    for (const protocol of node.module.protocols) {
      if (protocolNames.has(protocol.name)) continue;
      protocols.push(protocol);
      protocolNames.add(protocol.name);
    }
    // The namespace path already appended this dependency's extensions, so
    // appending them again gave one receiver two identical implementations and
    // extension selection then refused the program. Span identity is what
    // distinguishes a genuine second implementation from the same one twice.
    for (const extension of node.module.extensions) {
      const key = `${extension.span.file}\u0000${extension.span.start}`;
      if (extensionKeys.has(key)) continue;
      extensionKeys.add(key);
      extensions.push(extension);
    }
    fixities.push(...node.module.fixities);
  }

  return {
    ...module,
    statements: [...declarations, ...linkedStatements],
    protocols,
    extensions,
    fixities,
  };
}

function collectParameterFields(
  value: unknown,
  parameterName: string,
): readonly string[] {
  const fields = new Set<string>();
  const pending: unknown[] = [value];
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
  const exportedBindings = new Map(
    result.expression.fields.flatMap((field) =>
      field.value.kind === "reference"
        ? [[field.name, field.value.name.text] as const]
        : []
    ),
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
  const providers = new Map(
    dependency.statements.flatMap((dependencyStatement) =>
      statementValueNames(dependencyStatement).map((name) =>
        [name, dependencyStatement] as const
      )
    ),
  );
  const requiredBindings = new Set<string>();
  const requiredNames = new Set<string>();
  const pendingBindings = statement.open || statement.selections.length === 0
    ? [...exportedBindings.values()]
    : statement.selections.flatMap((selection) => {
      const bindingName = exportedBindings.get(selection.exportName);
      return bindingName === undefined ? [] : [bindingName];
    });
  while (pendingBindings.length > 0) {
    const bindingName = pendingBindings.pop()!;
    if (requiredBindings.has(bindingName)) continue;
    requiredBindings.add(bindingName);
    const provider = providers.get(bindingName);
    if (provider === undefined) continue;
    for (const referencedName of collectReferencedNames(provider)) {
      requiredNames.add(referencedName);
      if (providers.has(referencedName)) pendingBindings.push(referencedName);
    }
  }
  const spliced = dependency.statements.flatMap<DucklangStatement>(
    (dependencyStatement) => {
      if (
        dependencyStatement.kind === "effectDeclaration" ||
        dependencyStatement.kind === "initDeclaration" ||
        dependencyStatement.kind === "unionType" ||
        dependencyStatement.kind === "structType" ||
        dependencyStatement.kind === "typeAlias" ||
        dependencyStatement.kind === "typePattern"
      ) {
        return [dependencyStatement];
      }
      if (dependencyStatement.kind === "import") {
        const selections = dependencyStatement.selections.filter((selection) =>
          selection.localName !== undefined &&
          requiredNames.has(selection.localName.text)
        );
        return selections.length === 0
          ? []
          : [{ ...dependencyStatement, selections }];
      }
      if (
        !statementValueNames(dependencyStatement).some((name) =>
          requiredBindings.has(name)
        )
      ) {
        return [];
      }
      if (dependencyStatement.kind === "recordBinding") {
        return [{
          ...dependencyStatement,
          fields: dependencyStatement.fields.map((field) => {
            const exportedName = [...exportedBindings].find(
              ([, bindingName]) => bindingName === field.localName.text,
            )?.[0];
            const selection = exportedName === undefined
              ? undefined
              : selections.get(exportedName);
            return selection?.localName === undefined
              ? field
              : { ...field, localName: selection.localName };
          }),
        }];
      }
      if (dependencyStatement.kind !== "binding") {
        return [dependencyStatement];
      }
      const exportedName = [...exportedBindings].find(([, bindingName]) =>
        bindingName === dependencyStatement.name.text
      )?.[0];
      const selection = exportedName === undefined
        ? undefined
        : selections.get(exportedName);
      if (selection !== undefined && selection.localName === undefined) {
        return [];
      }
      const name = selection?.localName ?? dependencyStatement.name;
      return [{ ...dependencyStatement, name }];
    },
  );
  return spliced;
}

/**
 * Alpha-renames a dependency's private module-level bindings.
 *
 * Only the bindings that back an export belong in the importer's scope. The
 * private bindings they depend on are spliced too, so renaming them keeps the
 * importer from capturing one by declaring the same name, and keeps them from
 * resolving for an importer that never selected them.
 */
function hygieniseDucklangDependency(
  dependency: DucklangModule,
): DucklangModule {
  const result = dependency.statements.at(-1);
  if (result?.kind !== "expression" || result.expression.kind !== "record") {
    return dependency;
  }
  const exported = new Set(
    result.expression.fields.flatMap((field) =>
      field.value.kind === "reference" ? [field.value.name.text] : []
    ),
  );
  const renames = new Map(
    dependency.statements.flatMap((statement) =>
      statementValueNames(statement).flatMap((name) =>
        exported.has(name)
          ? []
          : [[name, hygienicDucklangName(name, dependency.file)] as const]
      )
    ),
  );
  if (renames.size === 0) return dependency;
  return {
    ...dependency,
    statements: renameDucklangValues(dependency.statements, renames),
    // An extension method body is inlined into whichever module calls the method,
    // so its free names travel with it and must be renamed alongside the bindings
    // they refer to. These bodies are not in `statements`, so renaming statements
    // alone left them pointing at names that no longer existed.
    extensions: dependency.extensions.map((extension) => ({
      ...extension,
      methods: extension.methods.map((method) => ({
        ...method,
        value: renameDucklangValuesInExpression(method.value, renames),
      })),
    })),
  };
}

function collectReferencedNames(value: unknown): readonly string[] {
  const names = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    const name = node.name as Record<string, unknown> | undefined;
    if (node.kind === "reference" && typeof name?.text === "string") {
      names.add(name.text);
    }
    pending.push(...Object.values(node));
  }
  return [...names];
}

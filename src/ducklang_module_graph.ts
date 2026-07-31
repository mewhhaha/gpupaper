import type { DucklangModule } from "./ducklang_ast.ts";
import { contentIdentity } from "./content_identity.ts";
import { parseDucklangModule } from "./ducklang_parser.ts";
import type { SourceSpan } from "./syntax.ts";

declare const moduleIdBrand: unique symbol;
declare const moduleInstanceKeyBrand: unique symbol;

export type ModuleId = string & { readonly [moduleIdBrand]: true };

export type DucklangModuleInstanceKey = string & {
  readonly [moduleInstanceKeyBrand]: true;
};

/**
 * Identifies the analysis contract of this frontend. A module instance analyzed
 * by an older frontend must never be reused after the contract changes, so the
 * version participates in every instance key.
 */
export const ducklangFrontendVersion = "ducklang-frontend-2";

export type DucklangModuleSource = {
  readonly canonicalSource: string;
  readonly file: string;
  readonly source: string;
  readonly sharedBundledSyntax?: true;
};

export type DucklangModuleImport = {
  readonly path: string;
  readonly moduleId: ModuleId;
  readonly span: SourceSpan;
};

export type DucklangModuleNode = {
  readonly id: ModuleId;
  readonly canonicalSource: string;
  readonly sourceHash: string;
  readonly analysisHash: string;
  readonly module: DucklangModule;
  readonly imports: readonly DucklangModuleImport[];
};

export type DucklangModuleGraph = {
  readonly rootId: ModuleId;
  readonly modules: ReadonlyMap<ModuleId, DucklangModuleNode>;
  /**
   * Sources parsed while building this graph. The root arrives pre-parsed, so a
   * graph that parses each canonical source once reports
   * `modules.size - 1`.
   */
  readonly parsedSources: number;
};

export type DucklangModuleSyntaxCache = {
  parse(source: DucklangModuleSource): Promise<{
    readonly module: DucklangModule;
    readonly sourceHash: string;
  }>;
  readonly analyses: number;
  readonly reuses: number;
};

export type DucklangSourceProvider = {
  resolve(
    importer: DucklangModuleSource,
    importPath: string,
    span: SourceSpan,
  ): Promise<DucklangModuleSource>;
};

export async function buildDucklangModuleGraph(input: {
  readonly root: DucklangModuleSource;
  readonly parsedRoot: DucklangModule;
  readonly sourceProvider: DucklangSourceProvider;
  readonly syntaxCache?: DucklangModuleSyntaxCache;
  readonly followImport?: (importPath: string) => boolean;
}): Promise<DucklangModuleGraph> {
  const modules = new Map<ModuleId, DucklangModuleNode>();
  const loading = new Map<ModuleId, number>();
  const ancestry: DucklangModuleSource[] = [];
  let parsedSources = 0;

  const load = async (
    moduleSource: DucklangModuleSource,
    parsed: DucklangModule | undefined,
    importSpan: SourceSpan | undefined,
  ): Promise<ModuleId> => {
    const id = moduleId(moduleSource.canonicalSource);
    if (modules.has(id)) return id;

    const cycleStart = loading.get(id);
    if (cycleStart !== undefined) {
      const cycle = [
        ...ancestry.slice(cycleStart).map((source) => source.canonicalSource),
        moduleSource.canonicalSource,
      ];
      const location = importSpan === undefined
        ? moduleSource.file
        : `${importSpan.file}:${importSpan.start}`;
      throw new TypeError(
        `${location}: cyclic Ducklang import ${cycle.join(" -> ")}`,
      );
    }

    loading.set(id, ancestry.length);
    ancestry.push(moduleSource);
    let syntax: DucklangModule;
    let sourceHash: string;
    if (parsed === undefined) {
      if (input.syntaxCache === undefined) {
        syntax = await parseDucklangModule(
          moduleSource.file,
          moduleSource.source,
        );
        sourceHash = await ducklangSourceHash(moduleSource.source);
        parsedSources += 1;
      } else {
        const analysesBefore = input.syntaxCache.analyses;
        const cached = await input.syntaxCache.parse(moduleSource);
        syntax = cached.module;
        sourceHash = cached.sourceHash;
        parsedSources += input.syntaxCache.analyses - analysesBefore;
      }
    } else {
      syntax = parsed;
      sourceHash = await ducklangSourceHash(moduleSource.source);
    }
    const imports: DucklangModuleImport[] = [];
    for (const statement of syntax.statements) {
      if (statement.kind !== "import") continue;
      if (input.followImport?.(statement.path) === false) continue;
      const dependencySource = await input.sourceProvider.resolve(
        moduleSource,
        statement.path,
        statement.span,
      );
      const dependencyId = await load(
        dependencySource,
        undefined,
        statement.span,
      );
      imports.push({
        path: statement.path,
        moduleId: dependencyId,
        span: statement.span,
      });
    }
    ancestry.pop();
    loading.delete(id);

    const analysisHash = await ducklangSourceHash(contentIdentity({
      frontend: ducklangFrontendVersion,
      canonicalSource: moduleSource.canonicalSource,
      sourceHash,
      imports: imports.map((import_) => {
        const dependency = modules.get(import_.moduleId);
        if (dependency === undefined) {
          throw new Error(
            `${moduleSource.file}:${import_.span.start}: loaded Ducklang import ${import_.path} has no dependency identity`,
          );
        }
        return {
          path: import_.path,
          canonicalSource: dependency.canonicalSource,
          analysisHash: dependency.analysisHash,
        };
      }),
    }));
    modules.set(id, {
      id,
      canonicalSource: moduleSource.canonicalSource,
      sourceHash,
      analysisHash,
      module: syntax,
      imports,
    });
    return id;
  };

  const rootId = await load(input.root, input.parsedRoot, undefined);
  return { rootId, modules, parsedSources };
}

export function createDucklangModuleSyntaxCache(): DucklangModuleSyntaxCache {
  const modules = new Map<
    string,
    Promise<{ readonly module: DucklangModule; readonly sourceHash: string }>
  >();
  let analyses = 0;
  let reuses = 0;
  return {
    async parse(source) {
      const sourceHash = await ducklangSourceHash(source.source);
      const key = contentIdentity([
        ducklangFrontendVersion,
        source.canonicalSource,
        sourceHash,
      ]);
      const existing = modules.get(key);
      if (existing !== undefined) {
        reuses += 1;
        return await existing;
      }
      analyses += 1;
      const pending = parseDucklangModule(source.file, source.source)
        .then((module) => ({ module, sourceHash }));
      modules.set(key, pending);
      return await pending;
    },
    get analyses() {
      return analyses;
    },
    get reuses() {
      return reuses;
    },
  };
}

// Only the default compiler-owned provider marks sources for process reuse.
// Keeping one current hash per fixed prelude path bounds retention across edits.
const sharedBundledSyntax = new Map<
  string,
  {
    readonly sourceHash: string;
    readonly pending: Promise<{
      readonly module: DucklangModule;
      readonly sourceHash: string;
    }>;
  }
>();

export function createDucklangCompilerModuleSyntaxCache(): DucklangModuleSyntaxCache {
  const compilation = createDucklangModuleSyntaxCache();
  let sharedAnalyses = 0;
  let sharedReuses = 0;
  return {
    async parse(source) {
      if (source.sharedBundledSyntax !== true) {
        return await compilation.parse(source);
      }
      const sourceHash = await ducklangSourceHash(source.source);
      const existing = sharedBundledSyntax.get(source.canonicalSource);
      if (existing?.sourceHash === sourceHash) {
        sharedReuses += 1;
        return await existing.pending;
      }
      sharedAnalyses += 1;
      const pending = parseDucklangModule(source.file, source.source)
        .then((module) => ({ module, sourceHash }));
      sharedBundledSyntax.set(source.canonicalSource, {
        sourceHash,
        pending,
      });
      try {
        return await pending;
      } catch (cause) {
        if (
          sharedBundledSyntax.get(source.canonicalSource)?.pending === pending
        ) {
          sharedBundledSyntax.delete(source.canonicalSource);
        }
        throw cause;
      }
    },
    get analyses() {
      return compilation.analyses + sharedAnalyses;
    },
    get reuses() {
      return compilation.reuses + sharedReuses;
    },
  };
}

export function createDucklangFilesystemSourceProvider(options: {
  readonly bundledPreludeDirectory?: URL;
} = {}): DucklangSourceProvider {
  const sharesBundledSyntax = options.bundledPreludeDirectory === undefined;
  const bundledPreludeDirectory = options.bundledPreludeDirectory ??
    new URL("../examples/binned/live/src/frontend/", import.meta.url);

  return {
    async resolve(importer, importPath, span) {
      const requestedSource = importPath.startsWith("duck:")
        ? bundledPreludeUrl(bundledPreludeDirectory, importPath, span)
        : new URL(importPath, pathToFileUrl(importer.file));
      let file: string;
      let source: string;
      try {
        file = await Deno.realPath(requestedSource);
        source = await Deno.readTextFile(file);
      } catch (cause) {
        throw new TypeError(
          `${span.file}:${span.start}: cannot resolve Ducklang import ${
            JSON.stringify(importPath)
          } from ${JSON.stringify(importer.canonicalSource)}`,
          { cause },
        );
      }
      return {
        canonicalSource: file,
        file,
        source: await expandDucklangIncludes(file, source),
        ...(sharesBundledSyntax && importPath.startsWith("duck:")
          ? { sharedBundledSyntax: true as const }
          : {}),
      };
    },
  };
}

export function moduleId(canonicalSource: string): ModuleId {
  return canonicalSource as ModuleId;
}

/**
 * Canonical identity of one analyzed module instance. Two instantiations share a
 * key only when they agree on source identity, transitive analysis contents,
 * frontend version, and the compile-time arguments bound to the module
 * parameters.
 */
export function ducklangModuleInstanceKey(input: {
  readonly moduleId: ModuleId;
  readonly analysisHash: string;
  readonly parameterNames: readonly string[];
  readonly argumentKeys: readonly string[];
  readonly frontendVersion?: string;
}): DucklangModuleInstanceKey {
  if (input.argumentKeys.length > input.parameterNames.length) {
    throw new TypeError(
      `${input.moduleId}: Ducklang module instance binds ${input.argumentKeys.length} arguments to ${input.parameterNames.length} parameters`,
    );
  }
  const parts = [
    input.frontendVersion ?? ducklangFrontendVersion,
    input.moduleId,
    input.analysisHash,
    ...input.parameterNames,
    ...input.argumentKeys,
  ];
  // Length prefixes keep the encoding injective, so no part can spoof another
  // by containing the separator.
  return parts
    .map((part) => `${part.length}:${part}`)
    .join("\0") as DucklangModuleInstanceKey;
}

export type DucklangModuleInstances<Instance> = {
  /** Analyzed instances keyed by {@link ducklangModuleInstanceKey}. */
  instantiate(
    key: DucklangModuleInstanceKey,
    analyze: () => Promise<Instance>,
  ): Promise<Instance>;
  /** Number of analyses actually performed. */
  readonly analyses: number;
  /** Number of analyses avoided by reusing a cached instance. */
  readonly reuses: number;
};

export function createDucklangModuleInstanceCache<
  Instance,
>(): DucklangModuleInstances<Instance> {
  const instances = new Map<
    DucklangModuleInstanceKey,
    Promise<Instance>
  >();
  let analyses = 0;
  let reuses = 0;
  return {
    instantiate(key, analyze) {
      const existing = instances.get(key);
      if (existing !== undefined) {
        reuses += 1;
        return existing;
      }
      analyses += 1;
      const pending = analyze();
      instances.set(key, pending);
      return pending;
    },
    get analyses() {
      return analyses;
    },
    get reuses() {
      return reuses;
    },
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

function bundledPreludeUrl(
  directory: URL,
  importPath: string,
  span: SourceSpan,
): URL {
  const prefix = "duck:prelude";
  if (!importPath.startsWith(prefix)) {
    throw new TypeError(
      `${span.file}:${span.start}: no bundled Ducklang source for ${
        JSON.stringify(importPath)
      }`,
    );
  }
  const suffix = importPath.slice(prefix.length);
  const fileName = importPath === "duck:prelude/effects/defaults"
    ? "prelude_effect_defaults.duck"
    : suffix.length === 0
    ? "prelude.duck"
    : `prelude_${suffix.slice(1).replaceAll("/", "_")}.duck`;
  return new URL(fileName, directory);
}

function pathToFileUrl(path: string): URL {
  if (path.startsWith("file:")) return new URL(path);
  const absolute = path.startsWith("/") ? path : `${Deno.cwd()}/${path}`;
  return new URL(`file://${absolute}`);
}

export async function ducklangSourceHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

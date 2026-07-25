import type { DucklangModule } from "../src/ducklang_ast.ts";
import {
  buildDucklangModuleGraph,
  createDucklangFilesystemSourceProvider,
  createDucklangModuleInstanceCache,
  ducklangModuleInstanceKey,
  type DucklangModuleSource,
  type DucklangSourceProvider,
  moduleId,
} from "../src/ducklang_module_graph.ts";
import { resolveDucklangLocalImports } from "../src/ducklang_modules.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("Ducklang module graph shares a transitive dependency", async () => {
  const sources = new Map([
    [
      "memory:/root.duck",
      `const left = import "./left.duck"
const right = import "./right.duck"
0
`,
    ],
    ["memory:/left.duck", 'const shared = import "./shared.duck"\n1\n'],
    ["memory:/right.duck", 'const shared = import "./shared.duck"\n2\n'],
    ["memory:/shared.duck", "3\n"],
  ]);
  const root = moduleSource("memory:/root.duck", sources);
  const graph = await buildDucklangModuleGraph({
    root,
    parsedRoot: await parseDucklangModule(root.file, root.source),
    sourceProvider: memorySourceProvider(sources),
  });

  assertEquals(graph.rootId, moduleId("memory:/root.duck"));
  assertEquals(graph.modules.size, 4);
  assertEquals(graph.parsedSources, 3);
  const shared = graph.modules.get(moduleId("memory:/shared.duck"));
  if (shared === undefined) throw new Error("missing shared module");
  assertEquals(shared.sourceHash.length, 64);
  assertEquals(
    [...graph.modules.values()].filter((module) =>
      module.canonicalSource === "memory:/shared.duck"
    ).length,
    1,
  );
});

Deno.test("Ducklang linking analyzes each module once per canonical source", async () => {
  const sources = new Map([
    [
      "memory:/root.duck",
      `const left = import "./left.duck"
const right = import "./right.duck"
left.value + right.value
`,
    ],
    [
      "memory:/left.duck",
      'const shared = import "./shared.duck"\nreturn { .value = shared.base }\n',
    ],
    [
      "memory:/right.duck",
      'const shared = import "./shared.duck"\nreturn { .value = shared.base }\n',
    ],
    ["memory:/shared.duck", "return { .base = 3 }\n"],
  ]);
  const root = moduleSource("memory:/root.duck", sources);
  const provider = countingSourceProvider(memorySourceProvider(sources));
  const instances = createDucklangModuleInstanceCache<DucklangModule>();

  await resolveDucklangLocalImports(
    await parseRoot(root),
    root.source,
    { sourceProvider: provider.provider, instances },
  );

  // Left, right, and shared are each analyzed once; the second request for the
  // shared module reuses the first analysis instead of repeating it.
  assertEquals(instances.analyses, 3);
  assertEquals(instances.reuses, 1);
  assertEquals(provider.resolutions.length, 4);
  assertEquals(
    provider.resolutions.filter((path) => path === "./shared.duck").length,
    2,
  );
});

Deno.test("Ducklang module instance keys separate contents parameters and arguments", () => {
  const base = {
    moduleId: moduleId("memory:/score.duck"),
    sourceHash: "a".repeat(64),
    parameterNames: ["capabilities"],
    argumentKeys: [] as readonly string[],
  };
  const key = ducklangModuleInstanceKey(base);

  assertEquals(key, ducklangModuleInstanceKey({ ...base }));
  assertEquals(
    key === ducklangModuleInstanceKey({ ...base, sourceHash: "b".repeat(64) }),
    false,
  );
  assertEquals(
    key ===
      ducklangModuleInstanceKey({ ...base, frontendVersion: "other-frontend" }),
    false,
  );
  assertEquals(
    key === ducklangModuleInstanceKey({ ...base, argumentKeys: ["base=1"] }),
    false,
  );
  assertEquals(
    ducklangModuleInstanceKey({ ...base, argumentKeys: ["base=1"] }) ===
      ducklangModuleInstanceKey({ ...base, argumentKeys: ["base=2"] }),
    false,
  );

  // A parameter name may not impersonate the module identity that follows it.
  assertEquals(
    ducklangModuleInstanceKey({
      ...base,
      parameterNames: ["a b", "c"],
    }) === ducklangModuleInstanceKey({
      ...base,
      parameterNames: ["a", "b c"],
    }),
    false,
  );
});

Deno.test("Ducklang module instance keys reject over-applied parameters", () => {
  try {
    ducklangModuleInstanceKey({
      moduleId: moduleId("memory:/score.duck"),
      sourceHash: "a".repeat(64),
      parameterNames: [],
      argumentKeys: ["base=1"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/binds 1 arguments to 0 parameters/.test(message)) {
      throw new Error(`unexpected diagnostic ${JSON.stringify(message)}`);
    }
    return;
  }
  throw new Error("expected an over-application diagnostic");
});

Deno.test("Ducklang module graph reports the complete import cycle", async () => {
  const sources = new Map([
    ["memory:/root.duck", 'const child = import "./child.duck"\n0\n'],
    ["memory:/child.duck", 'const root = import "./root.duck"\n1\n'],
  ]);
  const root = moduleSource("memory:/root.duck", sources);
  const parsedRoot = await parseRoot(root);

  await assertRejects(
    () =>
      buildDucklangModuleGraph({
        root,
        parsedRoot,
        sourceProvider: memorySourceProvider(sources),
      }),
    /cyclic Ducklang import memory:\/root\.duck -> memory:\/child\.duck -> memory:\/root\.duck/,
  );
});

Deno.test("Ducklang bundled source provider resolves prelude modules", async () => {
  const provider = createDucklangFilesystemSourceProvider();
  const root: DucklangModuleSource = {
    canonicalSource: "/application.duck",
    file: "/application.duck",
    source: "",
  };
  const span = { file: root.file, start: 0, end: 0 };
  const iterators = await provider.resolve(
    root,
    "duck:prelude/iterators",
    span,
  );

  assertEquals(iterators.file.endsWith("prelude_iterators.duck"), true);
  assertEquals(iterators.source.includes("duck IntoIterator Self"), true);
});

Deno.test("Ducklang local module exports retain captured bindings", async () => {
  const file = await Deno.realPath(
    "tests/fixtures/captured_module_app.duck",
  );
  const source = await Deno.readTextFile(file);
  const linked = await resolveDucklangLocalImports(
    await parseDucklangModule(file, source),
    source,
  );
  const resolved = resolveDucklangModule(linked);
  inferDucklangModule(resolved);

  const captured = resolved.bindings.find((binding) =>
    binding.symbol.text === "captured"
  );
  const exported = resolved.bindings.find((binding) =>
    binding.symbol.text === "$module_captured_module_add_captured"
  );
  if (
    captured === undefined ||
    exported?.value.kind !== "function" ||
    exported.value.body.kind !== "binary" ||
    exported.value.body.left.kind !== "reference"
  ) {
    throw new Error("missing captured local module function");
  }
  assertEquals(exported.value.body.left.symbol.id, captured.symbol.id);
  assertEquals(
    exported.value.body.left.symbol.moduleId,
    captured.symbol.moduleId,
  );
  assertEquals(
    exported.value.body.left.symbol.moduleId.endsWith("captured_module.duck"),
    true,
  );
});

Deno.test("Codex citation parser import retains its texts environment", async () => {
  const file = await Deno.realPath(
    "examples/binned/live/case-studies/codex/codex.duck",
  );
  const source = await Deno.readTextFile(file);
  const linked = await resolveDucklangLocalImports(
    await parseDucklangModule(file, source),
    source,
  );

  const textsBinding = linked.statements.find((statement) =>
    statement.kind === "binding" && statement.name.text === "texts"
  );
  const pushBinding = linked.statements.find((statement) =>
    statement.kind === "binding" &&
    statement.name.text === "$module_citation_parser_module_push_citation_chunk"
  );
  assertEquals(textsBinding?.kind, "binding");
  assertEquals(referencesName(pushBinding, "texts"), true);
  assertEquals(
    linked.statements.some((statement) =>
      statement.kind === "unionType" && statement.name === "Option"
    ),
    true,
  );
});

Deno.test("Editor iterator import exposes protocol declarations and extensions", async () => {
  const file = await Deno.realPath(
    "examples/binned/live/case-studies/editor/editor.duck",
  );
  const source = await Deno.readTextFile(file);
  const linked = await resolveDucklangLocalImports(
    await parseDucklangModule(file, source),
    source,
  );

  assertEquals(
    linked.protocols.some((protocol) => protocol.name === "IntoIterator"),
    true,
  );
  assertEquals(
    linked.extensions
      .filter((extension) =>
        extension.methods.some((method) => method.name === "iterator")
      )
      .map((extension) => extension.targetType)
      .sort(),
    ["Bytes", "List", "Text"],
  );
});

function memorySourceProvider(
  sources: ReadonlyMap<string, string>,
): DucklangSourceProvider {
  return {
    resolve(importer, importPath, span) {
      const canonicalSource = new URL(
        importPath,
        importer.canonicalSource,
      ).href;
      const source = sources.get(canonicalSource);
      if (source === undefined) {
        throw new TypeError(
          `${span.file}:${span.start}: missing in-memory Ducklang source ${canonicalSource}`,
        );
      }
      return Promise.resolve({
        canonicalSource,
        file: canonicalSource,
        source,
      });
    },
  };
}

function countingSourceProvider(provider: DucklangSourceProvider): {
  readonly provider: DucklangSourceProvider;
  readonly resolutions: readonly string[];
} {
  const resolutions: string[] = [];
  return {
    resolutions,
    provider: {
      resolve(importer, importPath, span) {
        resolutions.push(importPath);
        return provider.resolve(importer, importPath, span);
      },
    },
  };
}

function moduleSource(
  canonicalSource: string,
  sources: ReadonlyMap<string, string>,
): DucklangModuleSource {
  const source = sources.get(canonicalSource);
  if (source === undefined) {
    throw new Error(`missing root source ${canonicalSource}`);
  }
  return { canonicalSource, file: canonicalSource, source };
}

async function parseRoot(source: DucklangModuleSource) {
  return await parseDucklangModule(source.file, source.source);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expected.test(message)) {
      throw new Error(
        `expected ${expected}, received ${JSON.stringify(message)}`,
      );
    }
    return;
  }
  throw new Error(`expected rejection matching ${expected}`);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function referencesName(value: unknown, name: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    const reference = node.name as Record<string, unknown> | undefined;
    if (node.kind === "reference" && reference?.text === name) return true;
    pending.push(...Object.values(node));
  }
  return false;
}

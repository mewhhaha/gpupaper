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
import { compileModuleSource, runMain } from "../src/compiler.ts";
import { resolveDucklangLocalImports } from "../src/ducklang_modules.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * A module's private binding must keep its own meaning no matter what the
 * importer happens to name its own bindings. Both applications call the same
 * exported `get`, which adds the dependency's private `helper = 100`, so both
 * must return 100. The only difference between them is that the colliding
 * application also declares an unrelated top-level `helper = 1`.
 */
Deno.test("Ducklang imports keep private bindings across a name collision", async () => {
  assertEquals(await runFixture("private_binding_app.duck"), 100);
  assertEquals(
    await runFixture("private_binding_collision_app.duck"),
    100,
  );
});

/**
 * A module's export record is its interface: selecting a name it does not export
 * is already rejected with "does not export", so referencing a non-exported
 * binding after an open import must be rejected the same way rather than
 * silently resolving to the dependency's private binding.
 */
Deno.test("Ducklang open imports do not leak private bindings", async () => {
  await assertRejects(
    () => runFixture("private_leak_app.duck"),
    /unknown Ducklang name secret/,
  );
});

/**
 * A struct field offset must come from the declaration the annotation names, not
 * from whichever same-named declaration happens to be emitted first. The
 * application declares `Point = struct { .b, .a }`, so `.a` is index 1 and
 * `[1, 2]` must project 2. Importing a module that declares its own unrelated
 * `Point = struct { .a, .b }` must not change that offset.
 */
Deno.test("Ducklang imports do not change a struct field offset", async () => {
  assertEquals(await runFixture("point_layout_app.duck"), 2);
});

/**
 * A module parameter record carries whatever types its fields hold. The
 * synthetic struct the linker builds for it gives every field its own type
 * parameter, so a `Text` capability infers as `Text`; hardcoding the field type
 * as `Int` made this fail with "cannot unify Ducklang i32 with text".
 */
Deno.test("Ducklang module parameter records accept non-integer fields", async () => {
  assertEquals(await runFixture("text_parameter_app.duck"), 5);
});

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

  const exported = resolved.bindings.find((binding) =>
    binding.symbol.text === "$module_captured_module_add_captured"
  );
  if (
    exported?.value.kind !== "function" ||
    exported.value.body.kind !== "binary" ||
    exported.value.body.left.kind !== "reference"
  ) {
    throw new Error("missing captured local module function");
  }
  // The dependency's private binding is alpha-renamed, so the invariant is the
  // resolved link rather than the spelling: the exported function's capture must
  // resolve to a real binding declared by the dependency, and that binding must
  // still hold the dependency's value.
  const capture = exported.value.body.left.symbol;
  const captured = resolved.bindings.find((binding) =>
    binding.symbol.id === capture.id
  );
  if (captured === undefined) {
    throw new Error(`capture ${capture.text} resolves to no binding`);
  }
  assertEquals(captured.symbol.moduleId, capture.moduleId);
  assertEquals(captured.symbol.moduleId.endsWith("captured_module.duck"), true);
  assertEquals(captured.symbol.text.startsWith("captured"), true);
  assertEquals(
    captured.value.kind === "integer" ? captured.value.value : undefined,
    40,
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

  const pushBinding = linked.statements.find((statement) =>
    statement.kind === "binding" &&
    statement.name.text === "$module_citation_parser_module_push_citation_chunk"
  );
  // The captured binding is alpha-renamed, so assert the capture is closed: the
  // `texts` name the exported function references must be bound by a statement
  // that linking actually emitted, not merely present as a string.
  const referenced = referencedNamesStartingWith(pushBinding, "texts");
  assertEquals(referenced.length > 0, true);
  const boundNames = new Set(
    linked.statements.flatMap((statement) =>
      statement.kind === "binding" ? [statement.name.text] : []
    ),
  );
  for (const name of referenced) {
    assertEquals(boundNames.has(name), true);
  }
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

async function runFixture(name: string): Promise<number | bigint> {
  const file = await Deno.realPath(`tests/fixtures/${name}`);
  const artifact = await compileModuleSource(
    file as `${string}.duck`,
    await Deno.readTextFile(file),
    { gpuMode: "off" },
  );
  return await runMain(artifact.wasm);
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

function referencedNamesStartingWith(
  value: unknown,
  prefix: string,
): string[] {
  const names = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    const reference = node.name as Record<string, unknown> | undefined;
    if (
      node.kind === "reference" && typeof reference?.text === "string" &&
      reference.text.startsWith(prefix)
    ) {
      names.add(reference.text);
    }
    pending.push(...Object.values(node));
  }
  return [...names];
}

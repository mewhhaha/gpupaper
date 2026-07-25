import { compileModuleSource, runMain } from "../src/compiler.ts";
import { expandDucklangIncludes } from "../src/ducklang_module_graph.ts";

/**
 * Binding-time environments across type aliases and extension layers.
 *
 * An extension method body is inlined into whichever module calls the method, so its
 * free names have to survive the trip. The cross-module case failed with "unknown
 * Ducklang name offset": the body referred to a const in the module that declared the
 * extension, and hygienic renaming covered that module's statements but not its
 * extensions, which are held separately on the module.
 *
 * The same-module cases are pinned alongside, so a fix that renamed everything into
 * oblivion would fail here rather than silently.
 */

const prelude = 'const { struct } = import "duck:prelude" ()\n\n';
const readProtocol = `
duck Read Self {
  type Out
  .read = Self -> Out
}
`;

Deno.test("Ducklang keeps a const visible inside an inlined extension", async () => {
  assertEquals(
    await run(
      `${prelude}type Box = struct { .v = Int }
${readProtocol}
const offset = 40

extend Box {
  type Out = Int
  .read = (b: Box) => b.v + offset
}

let b: Box = [.v = 2]
Read.read(b)
`,
    ),
    42,
  );
});

Deno.test("Ducklang keeps a comptime-folded const visible inside an extension", async () => {
  assertEquals(
    await run(
      `${prelude}type Box = struct { .v = Int }
${readProtocol}
const base = 20
const offset = comptime (base * 2)

extend Box {
  type Out = Int
  .read = (b: Box) => b.v + offset
}

let b: Box = [.v = 2]
Read.read(b)
`,
    ),
    42,
  );
});

Deno.test("Ducklang selects through a type alias without losing the environment", async () => {
  assertEquals(
    await run(
      `${prelude}type Box = struct { .v = Int }
type Alias = Box
${readProtocol}
const offset = 40

extend Box {
  type Out = Int
  .read = (b: Box) => b.v + offset
}

let b: Alias = [.v = 2]
Read.read(b)
`,
    ),
    42,
  );
});

Deno.test("Ducklang carries an extension's free names across a module boundary", async () => {
  // The provider declares the const, the extension that reads it, and a function
  // that calls the method; the consumer only imports. 40 + 1.
  const file = await Deno.realPath("tests/fixtures/offset_consumer.duck");
  const artifact = await compileModuleSource(
    file as `${string}.duck`,
    await expandDucklangIncludes(file, await Deno.readTextFile(file)),
    { gpuMode: "off" },
  );

  assertEquals(await runMain(artifact.wasm), 41);
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("binding_time.duck", source, {
    gpuMode: "off",
  });
  return await runMain(artifact.wasm);
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

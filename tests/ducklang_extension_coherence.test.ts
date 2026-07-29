import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Missing, ambiguous, and incoherent extension implementations.
 *
 * All three are refused during extension elaboration, well before Core. The
 * accepting cases are pinned alongside, because a selector that refused everything
 * would satisfy the rejections on its own.
 */

const addProtocol = `duck Add Self Other Output {
  .add = [Self, Other] -> Output
}
`;
const addFixity = "\ninfixl 60 +++ = Add.add\n\n20 +++ 22\n";

Deno.test("Ducklang selects a single extension implementation", async () => {
  assertEquals(
    await run(
      `${addProtocol}\nextend I32 {\n  .add = [left, right] => @wasm.add_i32 [left, right]\n}\n${addFixity}`,
    ),
    42,
  );
});

Deno.test("Ducklang rejects a missing extension implementation", async () => {
  await assertRejects(
    `${addProtocol}${addFixity}`,
    /Ducklang extension method add has no implementation/,
  );
});

Deno.test("Ducklang rejects two incoherent implementations for one receiver", async () => {
  await assertRejects(
    `${addProtocol}\nextend I32 {\n  .add = [left, right] => @wasm.add_i32 [left, right]\n}\n\nextend I32 {\n  .add = [left, right] => @wasm.sub_i32 [left, right]\n}\n${addFixity}`,
    /Ducklang extension method add has 2 incoherent implementations for I32/,
  );
});

const boxed = `const { struct } = import "duck:prelude" ()

type Box value = struct { .value = value }

duck Read Self {
  type Value
  .read = Self -> Value
}
`;
const genericRead = `
extend Box Element {
  type Value = Element
  .read = (box: Box Element) => box.value
}
`;
const useBox = `
type I32Box = Box I32
let box: I32Box = [.value = 42] as I32Box
Read.read(box)
`;

Deno.test("Ducklang selects a generic extension by receiver type", async () => {
  assertEquals(await run(`${boxed}${genericRead}${useBox}`), 42);
});

Deno.test("Ducklang rejects an overlapping generic and concrete extension", async () => {
  await assertRejects(
    `${boxed}${genericRead}\nextend Box I32 {\n  type Value = I32\n  .read = (box: Box I32) => 7\n}\n${useBox}`,
    /Ducklang extension method read has 2 incoherent implementations for I32Box/,
  );
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("extension.duck", source, {
    gpuMode: "off",
  });
  return await runMain(artifact.wasm);
}

async function assertRejects(
  source: string,
  expected: RegExp,
): Promise<void> {
  let message = "";
  try {
    await compileModuleSource("extension.duck", source, { gpuMode: "off" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === "") throw new Error("expected a rejection");
  if (!expected.test(message)) {
    throw new Error(
      `expected ${expected}, received ${JSON.stringify(message)}`,
    );
  }
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

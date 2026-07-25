import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Specialization of `const` parameters and `forall` type parameters.
 *
 * The evidence is that one `forall`-typed parameter is applied at two different
 * types in the same body: `identity(true)` supplies an `if` condition and
 * `identity(41)` is added to an integer. A single monomorphic instantiation cannot
 * satisfy both, so the program compiling at all is what shows two instantiations
 * were produced. Running it then shows the right one was used at each site.
 *
 * Both stages are covered, because specialization that only worked inside `comptime`
 * would satisfy the corpus example and still leave runtime polymorphism broken.
 */

const head = 'const { identity } = import "duck:prelude/functional" ()\n\n';
const rankN =
  `${head}const apply_identity: (forall value.value -> value) -> I32 =
  (const identity) => if identity(true) {
    identity(41) + 1
  } else {
    0
  }

`;

Deno.test("Ducklang specializes a forall parameter at compile time", async () => {
  assertEquals(await run(`${rankN}comptime apply_identity(identity)\n`), 42);
});

Deno.test("Ducklang specializes a forall parameter at runtime too", async () => {
  // Not wrapped in comptime, so specialization cannot be a comptime-only trick.
  assertEquals(await run(`${rankN}apply_identity(identity)\n`), 42);
});

Deno.test("Ducklang requires const on a forall parameter", async () => {
  // Without `const` the parameter would be a runtime value, which cannot be
  // instantiated at two types. The grammar refuses it rather than leaving it to
  // inference.
  await assertRejects(
    `${head}const apply_identity: (forall value.value -> value) -> I32 =
  (identity) => if identity(true) {
    identity(41) + 1
  } else {
    0
  }

comptime apply_identity(identity)
`,
    /Unexpected token/,
  );
});

Deno.test("Ducklang keeps both instantiations distinct", async () => {
  // The Bool instantiation drives the branch and the I32 one supplies the value, so
  // swapping the branch changes the answer. If one instantiation served both, this
  // would not be able to return 7.
  assertEquals(
    await run(
      `${head}const pick: (forall value.value -> value) -> I32 =
  (const identity) => if identity(false) {
    identity(41) + 1
  } else {
    identity(7)
  }

pick(identity)
`,
    ),
    7,
  );
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("specialize.duck", source, {
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
    await compileModuleSource("specialize.duck", source, { gpuMode: "off" });
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

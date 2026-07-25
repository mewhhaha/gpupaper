import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Type reflection is a stub, and this test exists to say so in executable form.
 *
 * `@type_of` and `@describe_type` are rewritten in the parser, before any type
 * information exists. `@type_of(x)` returns `x` unchanged, and `@describe_type(t)`
 * returns a hardcoded `{ size: 1 }`. So a program that asks a type for its size gets
 * 1 whatever the type is, which is a wrong answer rather than a missing feature.
 *
 * These assertions pin the stub deliberately, not the intended behaviour. When
 * structural reflection over canonical type values lands, this file should fail and
 * be replaced with real expectations. It is here so the stub cannot be mistaken for
 * a working implementation, and so the corpus expectation that depends on it is
 * visible: examples/compile_time/19_include_and_type_of.duck records 18, which is a
 * 17-byte include plus this constant 1. Real reflection over
 * `struct { .length = I32 }` would make that 21.
 */

const prelude = 'const { struct } = import "duck:prelude" ()\n\n';

Deno.test("Ducklang type reflection reports one size for every struct", async () => {
  const oneField = await run(
    `${prelude}type A = struct { .x = I32 }\nlet a: A = [.x = 1]\nlet d = @describe_type(@type_of(a))\nd.size\n`,
  );
  const fourFields = await run(
    `${prelude}type B = struct { .a = I32, .b = I32, .c = I32, .d = I32 }\nlet b: B = [.a = 1, .b = 2, .c = 3, .d = 4]\nlet d = @describe_type(@type_of(b))\nd.size\n`,
  );

  // Both report 1. A real implementation would report 4 and 16, so these two
  // assertions are what a correct reflection pass has to break.
  assertEquals(oneField, 1);
  assertEquals(fourFields, 1);
  assertEquals(oneField === fourFields, true);
});

Deno.test("Ducklang type reflection does not survive as a type value", async () => {
  // `@type_of(x)` is replaced by `x`, so the reflected "type" is the value itself
  // and carries the value's type rather than a type value. This is why an I64 field
  // fails to unify: the size expression is compared against the value's own type.
  await assertRejects(
    `${prelude}type C = struct { .x = I64 }\nlet c: C = [.x = 1]\nlet d = @describe_type(@type_of(c))\nd.size\n`,
    /cannot unify Ducklang i64 with i32/,
  );
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("reflection.duck", source, {
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
    await compileModuleSource("reflection.duck", source, { gpuMode: "off" });
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

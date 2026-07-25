import { compileModuleSource, runMain } from "../src/compiler.ts";
import { ducklangReflectedLayout } from "../src/ducklang_layout.ts";

/**
 * Structural type reflection answers from real layout, and this file replaces the one
 * that pinned the stub.
 *
 * Previously `@type_of` and `@describe_type` were rewritten in the parser, before any
 * type information existed: `@type_of(x)` became `x` and `@describe_type` became a
 * hardcoded `{ size: 1 }`, so every type reported size 1. That was a wrong answer a
 * program could read, not a missing feature, which is why the replaced test asserted
 * the wrong values on purpose.
 *
 * `@type_of` now folds to the same `duck:type/*` intrinsic a written type name resolves
 * to, so the two are indistinguishable afterwards; `@describe_type` folds from that
 * payload through `ducklangReflectedLayout`. The corpus confirms it end to end:
 * examples/compile_time/19_include_and_type_of.duck is a 17-byte include plus the size
 * of `struct { .length = I32 }`, and now answers 21 rather than 18. Upstream
 * ../binned/examples/manifest.ts already recorded 21, so this converged with the
 * contract rather than diverging from it.
 *
 * Padding is asserted directly against `ducklangReflectedLayout` rather than through a
 * program because a struct with an `I64` field cannot be built from source at all: an
 * integer literal does not widen, so `let c: C = [.x = 1]` fails to unify i64 with i32
 * whether reflection is involved or not. Reaching the padding rule through source would
 * mean waiting on literal widening, which is unrelated to reflection.
 */

const prelude = 'const { struct } = import "duck:prelude" ()\n\n';

Deno.test("Ducklang reflection reports a struct's real size", async () => {
  const oneField = await run(
    `${prelude}type A = struct { .x = I32 }\nlet a: A = [.x = 1]\nlet d = @describe_type(@type_of(a))\nd.size\n`,
  );
  const fourFields = await run(
    `${prelude}type B = struct { .a = I32, .b = I32, .c = I32, .d = I32 }\nlet b: B = [.a = 1, .b = 2, .c = 3, .d = 4]\nlet d = @describe_type(@type_of(b))\nd.size\n`,
  );

  // The stub reported 1 for both. These are the values that distinguish a real
  // answer from a constant.
  assertEquals(oneField, 4);
  assertEquals(fourFields, 16);
});

Deno.test("Ducklang reflection describes a written type name too", async () => {
  // `@type_of` folds to the intrinsic a bare type name already resolves to, so
  // describing a name and describing a value's type go through one path.
  assertEquals(await run(`${prelude}let d = @describe_type(I64)\nd.size\n`), 8);
  assertEquals(await run(`${prelude}let d = @describe_type(I32)\nd.size\n`), 4);
  // A scalar-typed binding reflects as that scalar rather than failing.
  assertEquals(
    await run(
      `${prelude}let n = 7\nlet d = @describe_type(@type_of(n))\nd.size\n`,
    ),
    4,
  );
});

Deno.test("Ducklang reflection sees a buffer field as its handle", async () => {
  // Text is a managed handle today, and reflection asks
  // `ducklangBufferRepresentation` rather than assuming a width, so this changes
  // with that representation instead of drifting from it.
  assertEquals(
    await run(
      `${prelude}type E = struct { .t = Text }\nlet e: E = [.t = "hi"]\nlet d = @describe_type(@type_of(e))\nd.size\n`,
    ),
    4,
  );
});

Deno.test("Ducklang reflected layouts pad and align like Core", () => {
  assertEquals(ducklangReflectedLayout({ kind: "builtin", name: "I32" }), {
    size: 4,
    alignment: 4,
  });
  assertEquals(ducklangReflectedLayout({ kind: "builtin", name: "I64" }), {
    size: 8,
    alignment: 8,
  });
  // Unit occupies nothing but stays usable as a field.
  assertEquals(ducklangReflectedLayout({ kind: "builtin", name: "Unit" }), {
    size: 0,
    alignment: 1,
  });

  // A four-byte field before an eight-byte one leaves four bytes of padding, and
  // the reverse order pads at the end instead. Both land on 16, which is why the
  // two orders are asserted together rather than one standing in for the other.
  assertEquals(
    ducklangReflectedLayout({
      kind: "struct",
      fields: [{ type: "I32" }, { type: "I64" }],
    }),
    { size: 16, alignment: 8 },
  );
  assertEquals(
    ducklangReflectedLayout({
      kind: "struct",
      fields: [{ type: "I64" }, { type: "I32" }],
    }),
    { size: 16, alignment: 8 },
  );
  // An empty struct has no alignment to inherit, so it falls back to one.
  assertEquals(ducklangReflectedLayout({ kind: "struct", fields: [] }), {
    size: 0,
    alignment: 1,
  });
});

Deno.test("Ducklang reflection refuses a type it has no layout for", () => {
  // Silently answering zero would be the stub's mistake in a new costume.
  let message = "";
  try {
    ducklangReflectedLayout({ kind: "builtin", name: "Nonexistent" });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(/has no reflected layout/.test(message), true);
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("reflection.duck", source, {
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

import { evaluateDucklangConst } from "../src/ducklang_const.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * Which `ConstValue` variants a source program can actually produce.
 *
 * The expression evaluator produces scalar, type, product, sum, and closure.
 * Module values are constructed by the module normalization boundary and covered
 * separately because they are not expression values.
 *
 * Each case asserts the variant rather than a value, because the point is the shape of
 * the domain. A test that only checked results would pass with several variants
 * collapsed onto scalars.
 */

const cases: readonly (readonly [string, string, string])[] = [
  ["an integer", "comptime (40 + 2)\n", "scalar"],
  ["text", 'comptime "hi"\n', "scalar"],
  [
    "a declared struct",
    "type P = struct { .x = Int, .y = Int }\ncomptime {\n  let p: P = [20, 22]\n  p\n}\n",
    "product",
  ],
  [
    "a union case",
    "type M = | `Some I32 | `None Unit\ncomptime {\n  let m: M = `Some 42\n  m\n}\n",
    "sum",
  ],
  [
    "a function",
    "comptime {\n  let f = value => value + 1\n  f\n}\n",
    "closure",
  ],
  ["a builtin type", "comptime I32\n", "type"],
];

for (const [description, source, expected] of cases) {
  Deno.test(`Ducklang compile-time evaluation produces a ${expected} for ${description}`, async () => {
    const typed = inferDucklangModule(
      resolveDucklangModule(await parseDucklangModule("domain.duck", source)),
    );
    const value = evaluateDucklangConst(typed.result, { fuel: 10_000 });

    assertEquals(value.kind, expected);
  });
}

Deno.test("Ducklang compile-time products and sums keep their contents", async () => {
  // The variant alone would pass for an empty product, so the contents are checked
  // too.
  const product = await evaluate(
    "type P = struct { .x = Int, .y = Int }\ncomptime {\n  let p: P = [20, 22]\n  p\n}\n",
  );
  assertEquals(product, {
    kind: "product",
    fields: [
      { value: { kind: "scalar", scalar: { kind: "i32", value: 20 } } },
      { value: { kind: "scalar", scalar: { kind: "i32", value: 22 } } },
    ],
  });

  const sum = await evaluate(
    "type M = | `Some I32 | `None Unit\ncomptime {\n  let m: M = `Some 42\n  m\n}\n",
  );
  if (sum.kind !== "sum") throw new Error("expected a sum");
  assertEquals(sum.caseName, "Some");
  assertEquals(sum.value, {
    kind: "scalar",
    scalar: { kind: "i32", value: 42 },
  });
});

Deno.test("Ducklang compile-time type applications have canonical identities", async () => {
  const first = await evaluate("comptime I32 I64\n");
  const second = await evaluate("comptime I32 I64\n");
  if (first.kind !== "type" || second.kind !== "type") {
    throw new Error("expected canonical type values");
  }
  assertEquals(first.typeId, second.typeId);
  assertEquals(
    JSON.parse(first.typeId),
    ["apply", "duck:type/builtin:I32", ["duck:type/builtin:I64"]],
  );
});

async function evaluate(source: string) {
  const typed = inferDucklangModule(
    resolveDucklangModule(await parseDucklangModule("domain.duck", source)),
  );
  return evaluateDucklangConst(typed.result, { fuel: 10_000 });
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

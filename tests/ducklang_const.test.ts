import {
  canonicalDucklangTypeId,
  type DucklangConstProduct,
  type DucklangConstValue,
  evaluateDucklangConst,
  extendDucklangConstProduct,
  projectDucklangConst,
} from "../src/ducklang_const.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("Ducklang const closures capture immutable lexical environments", async () => {
  const expression = await typedResult(`comptime {
  let base = 40
  let add = value => base + value
  add(2)
}
`);

  assertEquals(
    evaluateDucklangConst(expression, { fuel: 100 }),
    scalarI32(42),
  );
});

Deno.test("Ducklang const evaluator handles sums and payload bindings", async () => {
  const expression = await typedResult(`type Maybe = | \`Some I32 | \`None Unit
comptime {
  let selected: Maybe = \`Some 42
  if let \`Some value = selected { value } else { 0 }
}
`);

  assertEquals(
    evaluateDucklangConst(expression, { fuel: 100 }),
    scalarI32(42),
  );
});

Deno.test("Ducklang const evaluator executes canonical UTF-8 primitives", async () => {
  const expression = await typedResult(
    'comptime @Utf8.decode(@Utf8.encode("żółw"))\n',
  );

  assertEquals(evaluateDucklangConst(expression, { fuel: 100 }), {
    kind: "scalar",
    scalar: { kind: "text", value: "żółw" },
  });
});

Deno.test("Ducklang const products support projection and persistent extension", () => {
  const base: DucklangConstProduct = {
    kind: "product",
    fields: [
      { name: "left", value: scalarI32(20) },
      { name: "right", value: scalarI32(1) },
    ],
  };
  const extension: DucklangConstProduct = {
    kind: "product",
    fields: [
      { name: "right", value: scalarI32(22) },
    ],
  };
  const extended = extendDucklangConstProduct(base, extension);

  assertEquals(projectDucklangConst(extended, "right"), scalarI32(22));
  assertEquals(projectDucklangConst(base, "right"), scalarI32(1));
});

Deno.test("Ducklang canonical type IDs preserve semantic structure", () => {
  const left = canonicalDucklangTypeId({
    kind: "constructor",
    name: "tuple",
    arguments: [
      { kind: "constructor", name: "i32", arguments: [] },
      { kind: "constructor", name: "text", arguments: [] },
    ],
  });
  const right = canonicalDucklangTypeId({
    kind: "constructor",
    name: "tuple",
    arguments: [
      { kind: "constructor", name: "i32", arguments: [] },
      { kind: "constructor", name: "text", arguments: [] },
    ],
  });

  assertEquals(left, right);
});

Deno.test("Ducklang const evaluation reports exhausted fuel at the source", async () => {
  const expression = await typedResult("comptime (40 + 2)\n");

  assertThrows(
    () => evaluateDucklangConst(expression, { fuel: 1 }),
    /test\.duck:10: Ducklang compile-time evaluation exhausted its fuel/,
  );
});

async function typedResult(source: string) {
  return inferDucklangModule(
    resolveDucklangModule(await parseDucklangModule("test.duck", source)),
  ).result;
}

function scalarI32(value: number): DucklangConstValue {
  return { kind: "scalar", scalar: { kind: "i32", value } };
}

function assertThrows(operation: () => unknown, expected: RegExp): void {
  try {
    operation();
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

import { compileModuleSource, runMain } from "../src/compiler.ts";
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

Deno.test("Ducklang const closures keep their captured value after rebinding", async () => {
  // The capture is what makes the environment immutable rather than merely
  // present: rebinding `base` after the closure is built must not change what
  // the closure sees. A mutable environment would answer 102.
  const expression = await typedResult(`comptime {
  let base = 40
  let add = value => base + value
  let base = 100
  add(2)
}
`);

  assertEquals(
    evaluateDucklangConst(expression, { fuel: 100 }),
    scalarI32(42),
  );
});

Deno.test("Ducklang const evaluator builds products and projects their fields", async () => {
  const projected = await typedResult(
    "type Point = struct { .x = Int, .y = Int }\ncomptime {\n  let point: Point = [20, 22]\n  point.x + point.y\n}\n",
  );
  assertEquals(evaluateDucklangConst(projected, { fuel: 500 }), scalarI32(42));

  // The product itself is a compile-time value, not only a projection result.
  const product = await typedResult(
    "type Point = struct { .x = Int, .y = Int }\ncomptime {\n  let point: Point = [20, 22]\n  point\n}\n",
  );
  assertEquals(evaluateDucklangConst(product, { fuel: 500 }), {
    kind: "product",
    fields: [{ value: scalarI32(20) }, { value: scalarI32(22) }],
  });
});

Deno.test("Ducklang const evaluator applies a functional product update", async () => {
  const expression = await typedResult(
    "type Point = struct { .x = Int, .y = Int }\ncomptime {\n  let point: Point = [20, 1]\n  let moved = Point.with_y(point, 22)\n  moved.x + moved.y\n}\n",
  );

  assertEquals(evaluateDucklangConst(expression, { fuel: 500 }), scalarI32(42));
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

  // Canonicalization must also separate structures that differ, or equality
  // would be meaningless.
  const swapped = canonicalDucklangTypeId({
    kind: "constructor",
    name: "tuple",
    arguments: [
      { kind: "constructor", name: "text", arguments: [] },
      { kind: "constructor", name: "i32", arguments: [] },
    ],
  });
  assertEquals(left === swapped, false);
  const nested = canonicalDucklangTypeId({
    kind: "constructor",
    name: "tuple",
    arguments: [
      {
        kind: "constructor",
        name: "tuple",
        arguments: [{ kind: "constructor", name: "i32", arguments: [] }],
      },
      { kind: "constructor", name: "text", arguments: [] },
    ],
  });
  assertEquals(left === nested, false);
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

/**
 * Recursive compile-time evaluation.
 *
 * Module-level function bindings are supplied as closures that can see the
 * environment holding them, so a recursive function finds itself. Reference
 * substitution alone could not express that, and recursion previously failed with
 * "missing compile-time value for down#0".
 *
 * The values are chosen so a wrong recursion would give a different answer rather
 * than coincidentally the same one: a countdown returns 0, but a sum returns 36 and a
 * factorial 120.
 */
Deno.test("Ducklang evaluates recursive compile-time functions", async () => {
  assertEquals(
    await runComptime(
      "let rec down = value => if value == 0 { 0 } else { down(value - 1) }\ncomptime down(3)\n",
    ),
    0,
  );
  assertEquals(
    await runComptime(
      "let rec total = value => if value == 0 { 0 } else { value + total(value - 1) }\ncomptime total(8)\n",
    ),
    36,
  );
  assertEquals(
    await runComptime(
      "let rec fact = value => if value == 0 { 1 } else { value * fact(value - 1) }\ncomptime fact(5)\n",
    ),
    120,
  );
});

Deno.test("Ducklang reports non-terminating recursion at the source", async () => {
  // Fuel does not bound depth: each level costs a JavaScript frame, so before the
  // depth guard this exhausted the host stack and reported "Maximum call stack size
  // exceeded" with no source location.
  let message = "";
  try {
    await runComptime(
      "let rec forever = value => forever(value + 1)\ncomptime forever(0)\n",
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (
    !/Ducklang compile-time evaluation exceeded 2000 nested calls/.test(message)
  ) {
    throw new Error(
      `expected a depth diagnostic, received ${JSON.stringify(message)}`,
    );
  }
  if (/Maximum call stack/.test(message)) {
    throw new Error("host stack overflow still reaches the user");
  }
});

async function runComptime(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("recursive.duck", source, {
    gpuMode: "off",
  });
  return await runMain(artifact.wasm);
}

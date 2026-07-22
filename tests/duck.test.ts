import { compileModuleSource, runMain } from "../src/compiler.ts";

Deno.test("Ducklang arithmetic and assignment shadowing returns 42", async () => {
  await assertDuckFixture("01_arithmetic_and_shadowing.duck", 42);
});

Deno.test("Ducklang runtime imports specialize static UTF-8 byte lengths", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { .length = size } = import "duck:prelude/runtime" ()
size("Aλ") + 39
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.inferred.bindings, []);
});

Deno.test("Ducklang runtime imports specialize static text operations", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { append, length, slice } = import "duck:prelude/runtime" ()
let word = "Aλ"
let rebuilt = append(slice(word, 0, 1), slice(word, 1, length(word)))
if rebuilt == word { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes static text append and byte indexing", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let full = "Ada" <> " Lovelace"
length(full) + full[1]
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 112);
});

Deno.test("Ducklang erases proven static ownership operations", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let message = freeze "shared"
length(&message) * 7
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes borrowed static text parameters", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let measure = (message: Text) => length(&message)
measure("interaction") + 31
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes scalar results from scratch regions", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let total = scratch {
  let message = "temporary"
  length(message) + 33
}
total
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang multi-argument functions and local blocks return 42", async () => {
  await assertDuckFixture("06_functions_and_blocks.duck", 42);
});

Deno.test("Ducklang return exits its function while false conditions fall through", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let choose = value => {
  if value {
    return 42
  }
  0
}
choose(0)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 0);
});

Deno.test("Ducklang return values must match the function fallthrough type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        `let broken = flag => {
  if flag {
    return 1i64
  }
  0
}
broken(1)
`,
        { gpuMode: "off" },
      ),
    /cannot unify Ducklang i64 with i32|cannot unify Ducklang i32 with i64/,
  );
});

Deno.test("Ducklang else-if chains return 42", async () => {
  await assertDuckFixture("10_else_if.duck", 42);
});

Deno.test("Ducklang calls functions in conditions", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let positive = value => value > 0
if positive(1) { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang host effects import scalar runtime inputs", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `module (!init: Init) where
declare effect Input {
  flag: () => Bool
}
declare Init { input: Input }
flag <- Input.flag()
let result = if flag { 21 } else { 41 }
return { .result = result }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm, { input: { flag: 1 } }), 21);
  assertEquals(await runMain(artifact.wasm, { input: { flag: 0 } }), 41);
  await assertRejects(
    () => runMain(artifact.wasm),
    /host input input\.flag requires an input object/,
  );
});

Deno.test("Ducklang functions capture the module symbol visible at declaration", async () => {
  await assertDuckFixture("closure_capture.duck", 43);
});

Deno.test("Ducklang specializes a statically returned closure", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let make_adder = amount => {
  value => value + amount
}
let add_two = make_adder(2)
add_two(40)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    artifact.fcg.functions.map((function_) => function_.name),
    ["add_two__duck3", "main"],
  );
});

Deno.test("Ducklang comptime specializes a closure without a scalar GPU job", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const make_adder = amount => {
  value => value + amount
}
const add_three = comptime make_adder(3)
add_three(39)
`,
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.comptimeCpuValues, []);
  if (artifact.comptimeGpuResult?.status === "completed") {
    assertEquals(artifact.comptimeGpuResult.values, []);
  }
});

Deno.test("Ducklang functional imports specialize composition and pipelines", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { apply, compose, pipe } = import "duck:prelude/functional" ()
const increment = value => value + 1
const double = value => value * 2
const transform = comptime compose(increment, double)
pipe(apply(transform, 20), increment)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes invoked const function parameters", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let apply_twice = (value, const transform) => transform(transform(value))
const increment = value => value + 1
apply_twice(40, increment)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    artifact.fcg.functions.map((function_) => function_.name),
    ["increment__duck3", "main"],
  );
});

Deno.test("Ducklang resolves and specializes nominal union cases", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `type Result = | \`Ok Int | \`Err Text
let unwrap = (result: Result) => {
  if let \`Ok value = result { value } else { 21 }
}
unwrap(\`Ok (21)) + unwrap(\`Err ("no"))
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang resolves parameterized union aliases", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `type Option value = | \`Some value | \`None Unit
type IntOption = Option Int
let choice = \`Some (41)
if let \`Some value = choice { value + 1 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang lowers dynamic scalar unions to packed Wasm values", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `type Maybe = | \`Some Int | \`None Unit
let choose = flag => {
  let value = if flag { \`Some (40) } else { \`None () }
  if let \`Some found = value { found + 2 } else { 7 }
}
if choose(1) == 42 && choose(0) == 7 { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes tuple destructuring and array indexing", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let swap = (left, right) => (right, left)
let (first, second) = swap(1, 42)
let stored = [first, second]
stored[0]
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang runtime struct indexing traps outside its field range", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `module (!init: Init) where
const { struct } = import "duck:prelude" ()
declare effect Input { index: () => I32 }
declare Init { input: Input }
type Pair = struct { .first = Int, .second = Int }
let pair: Pair = [20, 22]
index <- Input.index()
return { .result = pair[index] }
`,
    { gpuMode: "off" },
  );
  await assertRejects(
    () => runMain(artifact.wasm, { input: { index: 2 } }),
    /unreachable/,
  );
});

Deno.test("Ducklang unrolls bounded ranges with break and continue", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let total = 27
for value in 0..10 {
  if value == 6 { break }
  if value % 2 == 1 { continue }
  total = total + value
}
total + 9
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang recursive functions resolve calls to their own symbol", async () => {
  await assertDuckFixture("recursion.duck", 42);
});

Deno.test("Ducklang comptime expressions are evaluated before FCG lowering", async () => {
  const artifact = await compileDuckFixture("comptime.duck");
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.comptimeCpuValues, [{ kind: "integer", value: 42 }]);
});

Deno.test("Ducklang scalar operators agree across comptime and Wasm", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `comptime (if 40 < 41 && 2 == 2 {
  100 / 5 * 2 + 5 % 3
} else {
  0
})
`,
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.comptimeCpuValues, [{ kind: "integer", value: 42 }]);
  if (artifact.comptimeGpuResult?.status === "completed") {
    assertEquals(
      artifact.comptimeGpuResult.values,
      artifact.comptimeCpuValues,
    );
  }
});

Deno.test("Ducklang rejects arithmetic between different integer widths", async () => {
  await assertRejects(
    () =>
      compileModuleSource("test.duck", "40i64 + 2i32\n", { gpuMode: "off" }),
    /cannot unify Ducklang i64 with i32|cannot unify Ducklang i32 with i64/,
  );
});

Deno.test("Ducklang preserves the largest signed i64 literal through Wasm", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "9223372036854775807i64\n",
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 9_223_372_036_854_775_807n);
});

Deno.test("unsupported Ducklang operators fail during typed IR elaboration", async () => {
  await assertRejects(
    () => compileModuleSource("test.duck", "40 || 2\n", { gpuMode: "off" }),
    /Ducklang operator \|\| has no typed IR operation/,
  );
});

Deno.test("Ducklang const bindings retain their compile-time stage", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "const answer = 42\nanswer\n",
    { gpuMode: "off" },
  );
  assertEquals(artifact.inferred.bindings[0].stage, "compileTime");
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang equals assignment preserves the preceding binding type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        "let value = 1\nvalue = true\nvalue\n",
        { gpuMode: "off" },
      ),
    /cannot unify Ducklang i32 with bool|cannot unify Ducklang bool with i32/,
  );
});

Deno.test("Ducklang local equals assignment preserves the preceding binding type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        `let choose = input => {
  let value = 1
  value = true
  value
}
choose(0)
`,
        { gpuMode: "off" },
      ),
    /cannot unify Ducklang i32 with bool|cannot unify Ducklang bool with i32/,
  );
});

Deno.test("Ducklang colon-equals assignment permits a new binding type", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let value = 1\nvalue := true\nif value { 42 } else { 0 }\n",
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang compilation exposes typed IR and FCG stages", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let add = (left, right) => left + right\nadd(20, 22)\n",
    { gpuMode: "off" },
  );
  assertEquals(artifact.language, "ducklang");
  assertEquals(artifact.finalTypes, ["add#0 :: i32 -> i32 -> i32"]);
  assertEquals(artifact.inferred.equalities.length > 0, true);
  assertEquals(
    artifact.fcg.functions.map((function_) => function_.name),
    ["add__duck0", "main"],
  );
});

Deno.test("Ducklang type and comptime jobs reach the GPU differential passes", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let answer = comptime 6 * 7\nanswer\n",
  );
  assertEquals(artifact.gpuTypeResult === undefined, false);
  assertEquals(artifact.comptimeGpuResult === undefined, false);
  assertEquals(await runMain(artifact.wasm), 42);
});

async function assertDuckFixture(
  filename: string,
  expected: number,
): Promise<void> {
  const artifact = await compileDuckFixture(filename);
  assertEquals(await runMain(artifact.wasm), expected);
}

async function compileDuckFixture(filename: string) {
  const file = new URL(`../examples/duck/${filename}`, import.meta.url);
  const source = await Deno.readTextFile(file);
  return await compileModuleSource(file.pathname, source, { gpuMode: "off" });
}

function assertEquals(actual: unknown, expected: unknown): void {
  const bigintReplacer = (_key: string, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value;
  const actualJson = JSON.stringify(actual, bigintReplacer);
  const expectedJson = JSON.stringify(expected, bigintReplacer);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  }
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

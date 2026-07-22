import { compileModuleSource, runMain } from "../src/compiler.ts";

Deno.test("Duck arithmetic and assignment shadowing returns 42", async () => {
  await assertDuckFixture("01_arithmetic_and_shadowing.duck", 42);
});

Deno.test("Duck multi-argument functions and local blocks return 42", async () => {
  await assertDuckFixture("06_functions_and_blocks.duck", 42);
});

Deno.test("Duck else-if chains return 42", async () => {
  await assertDuckFixture("10_else_if.duck", 42);
});

Deno.test("Duck closures capture the binding generation at declaration", async () => {
  await assertDuckFixture("closure_capture.duck", 43);
});

Deno.test("Duck top-level recursive functions call their own core declaration", async () => {
  await assertDuckFixture("recursion.duck", 42);
});

Deno.test("Duck comptime expressions are evaluated before Wasm lowering", async () => {
  const artifact = await compileDuckFixture("comptime.duck");
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.comptimeCpuValues, [{ kind: "integer", value: 42 }]);
});

Deno.test("unsupported Duck operators fail before type inference", async () => {
  await assertRejects(
    () => compileModuleSource("test.duck", "40 / 2\n", { gpuMode: "off" }),
    /Duck operator \/ is not yet represented by the shared scalar core/,
  );
});

Deno.test("Duck const reports its missing compile-time dependency semantics", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        "const answer = 42\nanswer\n",
        { gpuMode: "off" },
      ),
    /Duck const bindings require compile-time dependency evaluation/,
  );
});

Deno.test("Duck equals assignment preserves the preceding binding type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        "let value = 1\nvalue = true\nvalue\n",
        { gpuMode: "off" },
      ),
    /cannot unify Int with Bool|cannot unify Bool with Int/,
  );
});

Deno.test("Duck local equals assignment preserves the preceding binding type", async () => {
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
    /cannot unify Int with Bool|cannot unify Bool with Int/,
  );
});

Deno.test("Duck colon-equals assignment permits a new binding type", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let value = 1\nvalue := true\nif value { 42 } else { 0 }\n",
    { gpuMode: "off" },
  );
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
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
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

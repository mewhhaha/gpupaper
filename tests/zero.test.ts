import { compileZeroSource } from "../examples/zero/compiler.ts";
import { zeroWorkloads } from "../examples/zero/workloads.ts";
import { emitWasmPlanOnCpu } from "../src/wasm.ts";

Deno.test("Zero lowers shadowing, calls, and conditional values", async () => {
  const compiled = await compileZeroSource(
    "expressions.zero",
    `
      fn add(left, right) = left + right;
      export fn choose(value) =
        let value = value + 1 in
        if value > 10 then add(value, 2) else 0 - value;
    `,
  );
  const instance = await instantiate(compiled.wasm);
  const choose = exportedFunction(instance, "choose");
  assertEquals(choose(10), 13);
  assertEquals(choose(2), -3);
});

Deno.test("Zero complexity workloads agree with their reference semantics", async () => {
  for (const workload of zeroWorkloads) {
    const source = await Deno.readTextFile(workload.zeroSourceUrl);
    const compiled = await compileZeroSource(
      workload.zeroSourceUrl.pathname,
      source,
    );
    const run = exportedFunction(await instantiate(compiled.wasm), "run");
    for (
      const [seed, rounds] of [[0, -1], [0, 0], [1, 1], [-1, 2], [1, 10], [
        2_147_483_647,
        31,
      ]] as const
    ) {
      assertEquals(run(seed, rounds), workload.reference(seed, rounds));
    }
  }
});

Deno.test("every Zero workload has byte-identical Rust/Wasm and CPU plan emission", async () => {
  for (const workload of zeroWorkloads) {
    const source = await Deno.readTextFile(workload.zeroSourceUrl);
    const compiled = await compileZeroSource(
      workload.zeroSourceUrl.pathname,
      source,
    );
    assertEquals(
      Array.from(compiled.wasm),
      Array.from(emitWasmPlanOnCpu(compiled.wasmPlan)),
    );
  }
});

Deno.test("Zero rejects duplicate function parameters", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "duplicate.zero",
        "export fn run(value, value) = value;",
      ),
    /duplicate\.zero:\d+: duplicate parameter value/,
  );
});

Deno.test("Zero rejects unbound variables", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "unbound.zero",
        "export fn run(value) = missing;",
      ),
    /unbound\.zero:\d+: unbound variable missing/,
  );
});

Deno.test("Zero rejects direct-call arity mismatches", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "arity.zero",
        "fn add(left, right) = left + right; export fn run(value) = add(value);",
      ),
    /arity\.zero:\d+: function add expects 2 arguments; received 1/,
  );
});

Deno.test("Zero rejects integer literals outside signed i32", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "literal.zero",
        "export fn run() = 2147483648;",
      ),
    /literal\.zero:\d+: integer literal 2147483648 is outside signed i32/,
  );
});

Deno.test("Zero exposes only explicitly exported functions", async () => {
  const compiled = await compileZeroSource(
    "exports.zero",
    "fn hidden(value) = value + 1; export fn run(value) = hidden(value);",
  );
  const instance = await instantiate(compiled.wasm);
  assertEquals(Object.keys(instance.exports), ["run"]);
  assertEquals(exportedFunction(instance, "run")(41), 42);
});

Deno.test("Zero rejects a standalone module without an export", async () => {
  await assertRejects(
    () => compileZeroSource("closed.zero", "fn hidden(value) = value;"),
    /closed\.zero: Zero program has no exported functions/,
  );
});

Deno.test("Zero loop-call fusion preserves conditional arm laziness", async () => {
  const compiled = await compileZeroSource(
    "fusion.zero",
    `
      fn choose(value) = if value > 0 then 42 else 1 / value;
      export fn run(value, rounds) =
        repeat rounds from value as current { choose(current) };
    `,
  );
  const run = exportedFunction(await instantiate(compiled.wasm), "run");
  assertEquals(run(1, 1), 42);
  assertEquals(run(0, 0), 0);
});

async function instantiate(wasm: Uint8Array): Promise<WebAssembly.Instance> {
  const module = await WebAssembly.compile(Uint8Array.from(wasm));
  return await WebAssembly.instantiate(module);
}

function exportedFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...arguments_: number[]) => number {
  const exported = instance.exports[name];
  if (!(exported instanceof Function)) {
    throw new Error(`Zero module has no function export ${name}`);
  }
  return exported as (...arguments_: number[]) => number;
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof Error && expected.test(cause.message)) return;
    throw new Error(
      `expected rejection ${expected}; received ${String(cause)}`,
    );
  }
  throw new Error(`expected rejection ${expected}; operation completed`);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`,
    );
  }
}

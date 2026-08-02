import { compileZeroSource } from "../examples/zero/compiler.ts";
import { zeroWorkloads } from "../examples/zero/workloads.ts";
import { createBackendFunctionCache, lowerCoreToWasm } from "../mod.ts";
import { emitWasmPlanOnCpu } from "../src/wasm.ts";

Deno.test("Zero lowers shadowing, calls, and conditional values", async () => {
  const compiled = await compileZeroSource(
    "expressions.zero",
    `
      private: add left right = @left @right + ;
      export: choose value =
        @value 1 + let:value
        @value 10 > @value 2 call:add:2 0 @value - select! ;
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

Deno.test("structured Zero workloads avoid dispatch-size expansion", async () => {
  const maximumBytes = new Map([
    ["03-call-graph", 300],
    ["04-branch-forest", 300],
    ["05-nested-loop", 250],
  ]);
  for (const workload of zeroWorkloads) {
    const limit = maximumBytes.get(workload.name);
    if (limit === undefined) continue;
    const source = await Deno.readTextFile(workload.zeroSourceUrl);
    const compiled = await compileZeroSource(
      workload.zeroSourceUrl.pathname,
      source,
    );
    if (compiled.wasm.byteLength >= limit) {
      throw new Error(
        `${workload.name} emitted ${compiled.wasm.byteLength} bytes; expected fewer than ${limit}`,
      );
    }
  }
});

Deno.test("affine recurrence acceleration preserves a large dynamic count", async () => {
  const workload = zeroWorkloads[0];
  const source = await Deno.readTextFile(workload.zeroSourceUrl);
  const compiled = await compileZeroSource(
    workload.zeroSourceUrl.pathname,
    source,
  );
  const run = exportedFunction(await instantiate(compiled.wasm), "run");
  assertEquals(
    run(0x12345678, 1_000_000),
    workload.reference(0x12345678, 1_000_000),
  );
});

Deno.test("affine callee changes invalidate the cached caller", async () => {
  const first = await compileZeroSource(
    "first-affine.zero",
    "private: step value = @value 3 * 7 + ; export: run seed rounds = @rounds @seed repeat:step ;",
  );
  const second = await compileZeroSource(
    "second-affine.zero",
    "private: step value = @value 5 * 7 + ; export: run seed rounds = @rounds @seed repeat:step ;",
  );
  const cache = createBackendFunctionCache();
  const firstPlan = lowerCoreToWasm(first.core, {
    emission: "planOnly",
    target: "wasm-scalar",
    functions: cache,
    exports: [{ name: "run", functionId: first.core.entryFunction }],
  });
  const secondPlan = lowerCoreToWasm(second.core, {
    emission: "planOnly",
    target: "wasm-scalar",
    functions: cache,
    exports: [{ name: "run", functionId: second.core.entryFunction }],
  });
  const firstRun = exportedFunction(
    await instantiate(emitWasmPlanOnCpu(firstPlan.wasmPlan)),
    "run",
  );
  const secondRun = exportedFunction(
    await instantiate(emitWasmPlanOnCpu(secondPlan.wasmPlan)),
    "run",
  );
  assertEquals(firstRun(1, 1), 10);
  assertEquals(secondRun(1, 1), 12);
});

Deno.test("Zero rejects duplicate function parameters", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "duplicate.zero",
        "export: run value value = @value ;",
      ),
    /duplicate\.zero:\d+: duplicate parameter value/,
  );
});

Deno.test("Zero rejects unbound variables", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "unbound.zero",
        "export: run value = @missing ;",
      ),
    /unbound\.zero:\d+: unbound variable missing/,
  );
});

Deno.test("Zero rejects direct-call arity mismatches", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "arity.zero",
        "private: add left right = @left @right + ; export: run value = @value call:add:1 ;",
      ),
    /arity\.zero:\d+: function add expects 2 arguments; received 1/,
  );
});

Deno.test("Zero rejects postfix stack underflow", async () => {
  await assertRejects(
    () => compileZeroSource("stack.zero", "export: run = + ;"),
    /stack\.zero:\d+: instruction \+ underflows the stack/,
  );
});

Deno.test("Zero rejects integer literals outside signed i32", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "literal.zero",
        "export: run = 2147483648 ;",
      ),
    /literal\.zero:\d+: integer literal 2147483648 is outside signed i32/,
  );
});

Deno.test("Zero reports Baba Wasm lexer diagnostics", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "lexical.zero",
        "export: run value = @value ? ;",
      ),
    /lexical\.zero:\d+: PARSE_LEXICAL_ERROR: Unexpected character "\?"/,
  );
});

Deno.test("Zero reports Baba SIMD validator diagnostics", async () => {
  await assertRejects(
    () =>
      compileZeroSource(
        "syntax.zero",
        "export: run value = @value",
      ),
    /syntax\.zero:\d+: PARSE_UNEXPECTED_TOKEN: Unexpected token EOF/,
  );
});

Deno.test("Zero exposes only explicitly exported functions", async () => {
  const compiled = await compileZeroSource(
    "exports.zero",
    "private: hidden value = @value 1 + ; export: run value = @value call:hidden:1 ;",
  );
  const instance = await instantiate(compiled.wasm);
  assertEquals(Object.keys(instance.exports), ["run"]);
  assertEquals(exportedFunction(instance, "run")(41), 42);
});

Deno.test("Zero rejects a standalone module without an export", async () => {
  await assertRejects(
    () => compileZeroSource("closed.zero", "private: hidden value = @value ;"),
    /closed\.zero: Zero program has no exported functions/,
  );
});

Deno.test("Zero loop-call fusion preserves conditional arm laziness", async () => {
  const compiled = await compileZeroSource(
    "fusion.zero",
    `
      private: choose value = @value 0 > 42 1 @value / select! ;
      export: run value rounds = @rounds @value repeat:choose ;
    `,
  );
  const run = exportedFunction(await instantiate(compiled.wasm), "run");
  assertEquals(run(1, 1), 42);
  assertEquals(run(0, 0), 0);
});

Deno.test("Zero loop if-conversion preserves partial-arm laziness", async () => {
  const compiled = await compileZeroSource(
    "partial-loop.zero",
    `
      private: inner_step value = @value 0 == 42 1 @value / select! ;
      private: inner seed = 3 @seed repeat:inner_step ;
      export: run seed rounds = @rounds @seed repeat:inner ;
    `,
  );
  const run = exportedFunction(await instantiate(compiled.wasm), "run");
  assertEquals(run(0, 1), 42);
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

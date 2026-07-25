import { compileModuleSource, runMain } from "../src/compiler.ts";
import { specializeStaticDucklangClosures } from "../src/ducklang_closures.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * Static closure specialization.
 *
 * This pass runs on every Ducklang compilation and had no tests. It removes
 * higher-order structure by specializing a closure at each known call site, which
 * is what lets the backend emit direct calls only; Core has no call.indirect and
 * no closure.make.
 *
 * TASKS.md schedules it for replacement by real closure conversion "after
 * equivalent behavior is covered", so these tests exist to be the coverage that
 * replacement has to preserve. Each case pins both halves: the shape after
 * specialization, and the value the program still computes, because a
 * specialization that dropped a capture would change the answer while leaving the
 * shape plausible.
 */

Deno.test("Ducklang specialization removes a closure applied at a known site", async () => {
  const source =
    "let adder = amount => value => value + amount\nlet add_two = adder(2)\nadd_two(40)\n";
  const { before, after } = await specialize(source);

  // `adder` is a curried factory; after specialization only the specialized
  // result survives as a direct function.
  assertEquals(before.includes("adder#0:function"), true);
  assertEquals(before.includes("add_two#3:call"), true);
  assertEquals(after.some((entry) => entry.startsWith("adder#")), false);
  assertEquals(after.includes("add_two#3:function"), true);

  assertEquals(await run("adder.duck", source), 42);
});

Deno.test("Ducklang specialization removes a higher-order function", async () => {
  const source =
    "let apply = (f, v) => f(v)\nlet double = x => x * 2\napply(double, 21)\n";
  const { before, after } = await specialize(source);

  assertEquals(before.includes("apply#0:function"), true);
  assertEquals(after.some((entry) => entry.startsWith("apply#")), false);
  assertEquals(after.includes("double#3:function"), true);

  assertEquals(await run("apply.duck", source), 42);
});

Deno.test("Ducklang specialization leaves a nested capturing function unhandled", async () => {
  const source =
    "let outer = base => {\n  let inner = value => base + value\n  inner(2)\n}\nouter(40)\n";
  const { before, after } = await specialize(source);

  // The nested function is not lifted to a top-level binding, because lifting is
  // closure conversion's job and this pass does not do it.
  assertEquals(before, ["outer#0:function"]);
  assertEquals(after, ["outer#0:function"]);

  // So the program does not compile at all: the backend asks for the closure
  // conversion that Phase 6 has yet to implement. Recorded here as the current
  // boundary rather than as a passing program.
  let message = "";
  try {
    await run("nested.duck", source);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (
    !/local Ducklang function inner requires closure conversion/.test(message)
  ) {
    throw new Error(
      `expected a closure-conversion diagnostic, received ${
        JSON.stringify(message)
      }`,
    );
  }
});

Deno.test("Ducklang specialization preserves a capture through two levels", async () => {
  // If specialization substituted the wrong environment, the inner capture would
  // read `outer`'s parameter instead of the one it closed over, and the answer
  // would change rather than the program failing.
  const source =
    "let make = a => b => c => (a * 100) + (b * 10) + c\nlet step = make(1)\nlet more = step(2)\nmore(3)\n";

  assertEquals(await run("captures.duck", source), 123);
});

async function specialize(
  source: string,
): Promise<{ readonly before: string[]; readonly after: string[] }> {
  const typed = inferDucklangModule(
    resolveDucklangModule(await parseDucklangModule("closures.duck", source)),
  );
  const describe = (module: typeof typed) =>
    module.bindings.map((binding) =>
      `${binding.symbol.text}#${binding.symbol.id}:${binding.value.kind}`
    );
  return {
    before: describe(typed),
    after: describe(specializeStaticDucklangClosures(typed)),
  };
}

async function run(name: string, source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource(
    name as `${string}.duck`,
    source,
    { gpuMode: "off" },
  );
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

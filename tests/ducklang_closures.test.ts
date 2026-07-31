import { compileModuleSource, runMain } from "../src/compiler.ts";
import {
  rewriteChildren,
  specializeStaticDucklangClosures,
} from "../src/ducklang_closures.ts";
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

Deno.test("Ducklang lifts a call-only nested capturing function", async () => {
  const source =
    "let outer = base => {\n  let inner = value => base + value\n  inner(2)\n}\nouter(40)\n";
  const { before, after } = await specialize(source);

  // Lifting is directly observable: `inner` becomes its own top-level binding, with
  // its capture appended to its parameters and supplied at the call site.
  assertEquals(before, ["outer#0:function"]);
  assertEquals(after, ["outer#0:function", "inner#2:function"]);

  // It used to fail with "local Ducklang function inner requires closure conversion".
  assertEquals(await run("nested.duck", source), 42);
});

Deno.test("Ducklang lifts a nested function called more than once", async () => {
  // Both calls must receive the capture, so a lift that appended arguments at only one
  // site would give a different answer rather than failing.
  assertEquals(
    await run(
      "twice.duck",
      "let outer = base => {\n  let inner = value => base + value\n  inner(2) + inner(3)\n}\nouter(40)\n",
    ),
    85,
  );
});

Deno.test("Ducklang calls a nested function through its captured environment", async () => {
  assertEquals(
    await run(
      "value.duck",
      "let outer = base => {\n  let inner = value => base + value\n  inner\n}\nlet f = outer(40)\nf(2)\n",
    ),
    42,
  );
});

Deno.test("Ducklang specialization preserves a capture through two levels", async () => {
  // If specialization substituted the wrong environment, the inner capture would
  // read `outer`'s parameter instead of the one it closed over, and the answer
  // would change rather than the program failing.
  const source =
    "let make = a => b => c => (a * 100) + (b * 10) + c\nlet step = make(1)\nlet more = step(2)\nmore(3)\n";

  assertEquals(await run("captures.duck", source), 123);
});

Deno.test("Ducklang specialization distinguishes parameters from local and module captures", async () => {
  const source = `let module_value = 10
let apply = (f, value) => f(value)
let outer = parameter => {
  let local = parameter + module_value
  apply(value => value + local, 20)
}
outer(12)
`;

  assertEquals(await run("substitution_scopes.duck", source), 42);
});

Deno.test("Ducklang specialization resolves direct static aliases", async () => {
  assertEquals(
    await run(
      "static_aliases.duck",
      "let direct = 42\nlet first = direct\nlet second = first\nsecond\n",
    ),
    42,
  );
});

Deno.test("Ducklang specialization visits only demanded bindings", async () => {
  const source =
    "let unused = (value: I32) => value * 100\nlet answer = 42\nanswer\n";
  const typed = inferDucklangModule(
    resolveDucklangModule(await parseDucklangModule("demand.duck", source)),
  );
  const specialized = specializeStaticDucklangClosures(typed);

  assertEquals(
    specialized.module.bindings.map((binding) => binding.symbol.text),
    ["answer"],
  );
  assertEquals(specialized.metrics.inputBindingCount, 2);
  assertEquals(specialized.metrics.demandedBindingCount, 1);
  assertEquals(specialized.metrics.rewrittenBindingCount, 1);
  assertEquals(
    specialized.metrics.demandedInputNodeCount <
      specialized.metrics.inputNodeCount,
    true,
  );
});

Deno.test("Ducklang child rewriting preserves an unchanged expression", async () => {
  const typed = inferDucklangModule(
    resolveDucklangModule(
      await parseDucklangModule(
        "sharing.duck",
        "let add = value => value + 1\nadd(41)\n",
      ),
    ),
  );
  const expression = typed.bindings[0].value;

  assertEquals(
    rewriteChildren(expression, (child) => child) === expression,
    true,
  );
});

Deno.test("Ducklang specialization does not evaluate an unselected branch", async () => {
  assertEquals(
    await run(
      "static_branch.duck",
      'if false { "x"[99] } else { 42 }\n',
    ),
    42,
  );
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
    after: describe(specializeStaticDucklangClosures(typed).module),
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

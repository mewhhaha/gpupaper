import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Direct calls for statically known callees, and recursive groups surviving intact.
 *
 * The parameters are runtime values so nothing folds away: a folded call would leave no
 * call to inspect and the test would prove nothing, which is the trap the protocol
 * evidence test hit earlier.
 *
 * Absence of indirect dispatch is asserted alongside presence of the direct call,
 * because a graph with neither would satisfy the absence check on its own.
 */

Deno.test("Ducklang calls a statically known callee directly", async () => {
  const artifact = await compileModuleSource(
    "calls.duck",
    "let add = (a, b) => a + b\nlet use = x => add(x, 2)\nuse(40)\n",
    { gpuMode: "off" },
  );

  assertEquals(await runMain(artifact.wasm), 42);

  const use = named(artifact, "use__duck");
  assertEquals(
    use.operations.map((operation) => operation.opcode).includes("call"),
    true,
  );
  assertNoIndirectDispatch(artifact);
});

Deno.test("Ducklang preserves a self-recursive function", async () => {
  const artifact = await compileModuleSource(
    "recursive.duck",
    "let rec down = n => if n == 0 { 42 } else { down(n - 1) }\ndown(3)\n",
    { gpuMode: "off" },
  );

  assertEquals(await runMain(artifact.wasm), 42);
  // The function survives as its own code identity rather than being unrolled.
  const down = named(artifact, "down__duck");
  assertEquals(
    down.operations.map((operation) => operation.opcode).includes("call"),
    true,
  );
  assertNoIndirectDispatch(artifact);
});

Deno.test("Ducklang preserves a mutually recursive group", async () => {
  const artifact = await compileModuleSource(
    "mutual.duck",
    "let rec even = value => {\n  if value == 0 { 1 } else { odd(value - 1) }\n}\nand odd = value => {\n  if value == 0 { 0 } else { even(value - 1) }\n}\neven(4) + 41\n",
    { gpuMode: "off" },
  );

  // even(4) walks even -> odd -> even -> odd -> even and answers 1, so both members
  // have to exist and call each other for this to be 42.
  assertEquals(await runMain(artifact.wasm), 42);
  named(artifact, "even__duck");
  named(artifact, "odd__duck");
  assertNoIndirectDispatch(artifact);
});

function named(
  artifact: {
    readonly fcg: {
      readonly functions: readonly {
        readonly name: string;
        readonly operations: readonly { readonly opcode: string }[];
      }[];
    };
  },
  prefix: string,
) {
  const found = artifact.fcg.functions.find((candidate) =>
    candidate.name.startsWith(prefix)
  );
  if (found === undefined) {
    throw new Error(
      `no function starting with ${prefix}; found ${
        artifact.fcg.functions.map((candidate) => candidate.name).join(", ")
      }`,
    );
  }
  return found;
}

function assertNoIndirectDispatch(artifact: { readonly fcg: unknown }): void {
  const graph = JSON.stringify(artifact.fcg);
  for (const marker of ["callIndirect", "call_indirect"]) {
    if (graph.includes(marker)) {
      throw new Error(`graph contains ${marker}`);
    }
  }
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

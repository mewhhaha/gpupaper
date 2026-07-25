import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Protocol evidence is resolved at compile time, leaving nothing to dispatch.
 *
 * The values are runtime parameters on purpose. A constant-folded call collapses to
 * a single `const` and would prove nothing about dispatch, which is what a first
 * version of this test did.
 *
 * Three things together make the claim: the selected method appears as a direct
 * arithmetic instruction rather than a call, no indirect-call or table machinery
 * appears anywhere in the graph, and no protocol or method name survives into it.
 */

const source = `duck Add Self Other Output {
  .add = [Self, Other] -> Output
}

extend I32 {
  .add = [left, right] => @wasm.add_i32 [left, right]
}

duck Invert Self Output {
  .invert = Self -> Output
}

extend Bool {
  .invert = value => @wasm.eq_i32 [value, false]
}

infixl 60 +++ = Add.add
prefix 80 ^^ = Invert.invert

let combine = (a, b) => a +++ b
let flip = (flag) => ^^flag

let total = combine(20, 22)
if flip(false) { total } else { 0 }
`;

Deno.test("Ducklang resolves protocol evidence into direct instructions", async () => {
  const artifact = await compileModuleSource("evidence.duck", source, {
    gpuMode: "off",
  });

  assertEquals(await runMain(artifact.wasm), 42);

  const combine = artifact.fcg.functions.find((candidate) =>
    candidate.name.startsWith("combine__duck")
  );
  const flip = artifact.fcg.functions.find((candidate) =>
    candidate.name.startsWith("flip__duck")
  );
  if (combine === undefined || flip === undefined) {
    throw new Error(
      `missing lowered functions; found ${
        artifact.fcg.functions.map((f) => f.name).join(", ")
      }`,
    );
  }

  // Add.add on I32 becomes the arithmetic itself, not a call to a method.
  const combineOpcodes = combine.operations.map((operation) =>
    operation.opcode
  );
  assertEquals(combineOpcodes.includes("i32.+"), true);
  assertEquals(combineOpcodes.includes("call"), false);

  // Invert.invert on Bool likewise.
  const flipOpcodes = flip.operations.map((operation) => operation.opcode);
  assertEquals(flipOpcodes.includes("i32.=="), true);
  assertEquals(flipOpcodes.includes("call"), false);
});

Deno.test("Ducklang leaves no protocol dispatch in the graph", async () => {
  const artifact = await compileModuleSource("evidence.duck", source, {
    gpuMode: "off",
  });
  const graph = JSON.stringify(artifact.fcg);

  for (const marker of ["callIndirect", "call_indirect", "dictionary"]) {
    if (graph.includes(marker)) {
      throw new Error(`graph still contains ${marker}`);
    }
  }
  for (const name of ["Add", "Invert", "invert"]) {
    if (graph.includes(`"${name}"`)) {
      throw new Error(`protocol name ${name} survived into the graph`);
    }
  }
  // The graph is non-empty, so absence cannot pass by there being nothing to find.
  assertEquals(artifact.fcg.functions.length > 1, true);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

import {
  compileComptimeExpression,
  evaluateBytecodeOnCpu,
  evaluateBytecodeOnGpu,
} from "../src/comptime.ts";
import { compileModuleSource, runMain } from "../src/compiler.ts";
import { solveTypeEqualitiesOnGpu } from "../src/gpu_solver.ts";
import { evaluateWithInteractionCalculus } from "../src/interaction.ts";
import { expandMacros } from "../src/macros.ts";
import { parseModule } from "../src/parser.ts";
import type { EqualityConstraint, Type } from "../src/types.ts";
import { formatScheme, inferModule } from "../src/types.ts";
import { encodeSigned, encodeUnsigned } from "../src/wasm.ts";

const testSpan = { file: "test.hs", start: 0, end: 1 };

Deno.test("rank-1 inference generalizes identity across integer and boolean uses", () => {
  const module = parseModule(
    "test.hs",
    `identity x = x\ninteger = identity 42\nboolean = identity True\nmain = integer\n`,
  );
  const inferred = inferModule(module);
  const schemes = new Map(
    inferred.declarations.map((
      typed,
    ) => [typed.declaration.name.text, formatScheme(typed.scheme)]),
  );
  assertMatches(schemes.get("identity"), /^[a-z][0-9]* -> [a-z][0-9]*$/);
  assertEquals(schemes.get("integer"), "Int");
  assertEquals(schemes.get("boolean"), "Bool");
});

Deno.test("dependency analysis groups independent definitions before their callers", () => {
  const module = parseModule(
    "test.hs",
    `left = 1\nright = 2\nadd x y = x + y\nmain = add left right\n`,
  );
  const inferred = inferModule(module);
  assertEquals(
    inferred.resolution.strata.map((stratum) =>
      stratum.map((declaration) => declaration.name.text)
    ),
    [
      ["left", "right", "add"],
      ["main"],
    ],
  );
});

Deno.test("lexical bindings shadow top-level declarations", async () => {
  const artifact = await compileModuleSource(
    "test.hs",
    `value = 1\nidentity value = let value = value in value\nmain = identity 42\n`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    artifact.inferred.resolution.dependencies.get("identity")?.size,
    0,
  );
});

Deno.test("CPU inference rejects an infinite self-application type", () => {
  assertThrows(
    () => inferModule(parseModule("test.hs", `broken x = x x\nmain = 0\n`)),
    /infinite type/,
  );
});

Deno.test("CPU inference reports the conflicting source types", () => {
  assertThrows(
    () =>
      inferModule(
        parseModule("test.hs", `broken = 1 + False\nmain = broken\n`),
      ),
    /cannot unify Bool with Int|cannot unify Int with Bool/,
  );
});

Deno.test("source integer literals must fit the backend i32 representation", () => {
  assertThrows(
    () => parseModule("test.hs", `main = 2147483648\n`),
    /integer literal 2147483648 exceeds the supported i32 range/,
  );
});

Deno.test("a polymorphic signature cannot conceal a monomorphic definition", () => {
  assertThrows(
    () =>
      inferModule(
        parseModule(
          "test.hs",
          `constant :: a -> a\nconstant x = 1\nmain = constant 2\n`,
        ),
      ),
    /claims polymorphic a/,
  );
});

Deno.test("macro invocations cannot observe later macro declarations", async () => {
  await assertRejects(
    () =>
      expandMacros(
        parseModule(
          "test.hs",
          `makeIdentity!(generated)\nmacro makeIdentity = identity\nmain = 0\n`,
        ),
      ),
    /unknown macro makeIdentity/,
  );
});

Deno.test("WebGPU equality closure accepts compatible constructors", async () => {
  const variable: Type = { kind: "variable", id: 0 };
  const integer: Type = { kind: "constructor", name: "Int", arguments: [] };
  const equalities: EqualityConstraint[] = [{
    left: variable,
    right: integer,
    span: testSpan,
  }];
  const result = await solveTypeEqualitiesOnGpu(equalities);
  if (result.status === "unavailable") return;
  assertEquals(result.status, "solved");
});

Deno.test("WebGPU equality closure reports constructor clashes", async () => {
  const integer: Type = { kind: "constructor", name: "Int", arguments: [] };
  const boolean: Type = { kind: "constructor", name: "Bool", arguments: [] };
  const result = await solveTypeEqualitiesOnGpu([{
    left: integer,
    right: boolean,
    span: testSpan,
  }]);
  if (result.status === "unavailable") return;
  assertEquals(result.status, "constructorClash");
});

Deno.test("WebGPU quotient reachability reports infinite types", async () => {
  const variable: Type = { kind: "variable", id: 0 };
  const list: Type = {
    kind: "constructor",
    name: "List",
    arguments: [variable],
  };
  const result = await solveTypeEqualitiesOnGpu([{
    left: variable,
    right: list,
    span: testSpan,
  }]);
  if (result.status === "unavailable") return;
  assertEquals(result.status, "infiniteType");
});

Deno.test("CPU and WebGPU compile-time evaluators return the same batch", async () => {
  const module = parseModule(
    "test.hs",
    `main = comptime (if 2 == 2 then 6 * 7 else 0)\n`,
  );
  const declaration = module.declarations[0];
  if (
    declaration.kind !== "value" || declaration.expression.kind !== "comptime"
  ) throw new Error("test fixture did not parse as comptime");
  const program = compileComptimeExpression(declaration.expression.expression);
  const cpu = evaluateBytecodeOnCpu([program]);
  const gpu = await evaluateBytecodeOnGpu([program]);
  if (gpu.status === "unavailable") return;
  assertEquals(cpu, {
    status: "completed",
    values: [{ kind: "integer", value: 42 }],
    backend: "cpu",
  });
  assertEquals(gpu.values, cpu.status === "completed" ? cpu.values : []);
});

Deno.test("Wasm macro expansion keeps generated identity parameters hygienic", async () => {
  const module = parseModule(
    "test.hs",
    `x = 7\nmacro makeIdentity = identity\nmakeIdentity!(generated)\nmain = generated 42\n`,
  );
  const expanded = await expandMacros(module);
  const generated = expanded.module.declarations.find((declaration) =>
    declaration.kind === "value" && declaration.name.text === "generated"
  );
  if (generated?.kind !== "value" || generated.expression.kind !== "variable") {
    throw new Error("macro did not generate an identity declaration");
  }
  assertEquals(
    generated.parameters[0].scopes,
    generated.expression.name.scopes,
  );
  assertEquals(generated.parameters[0].scopes.length, 2);
  const artifact = await compileModuleSource(
    "test.hs",
    `x = 7\nmacro makeIdentity = identity\nmakeIdentity!(generated)\nmain = generated 42\n`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("interaction calculus makes duplicated lambda use explicit", () => {
  const module = parseModule("test.hs", `main = ic ((\\x -> x + x) 21)\n`);
  const declaration = module.declarations[0];
  if (
    declaration.kind !== "value" || declaration.expression.kind !== "comptime"
  ) throw new Error("test fixture did not parse as interaction comptime");
  const result = evaluateWithInteractionCalculus(
    declaration.expression.expression,
  );
  assertEquals(result.value, 42);
  assertEquals(Object.fromEntries(result.rules), {
    "APP-LAM": 1,
    "DUP-SCALAR": 1,
    "OP-+": 1,
  });
});

Deno.test("ADTs classes macros and both comptime backends compile to executable Wasm", async () => {
  const source = await Deno.readTextFile(
    new URL("../examples/all.hs", import.meta.url),
  );
  const artifact = await compileModuleSource("examples/all.hs", source, {
    gpuMode: "auto",
  });
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    WebAssembly.validate(new Uint8Array(artifact.wasm).buffer as ArrayBuffer),
    true,
  );
  assertEquals(Object.fromEntries(artifact.fcg.constructorTags), {
    Nothing: 0,
    Just: 1,
  });
  assertEquals(artifact.macros.generatedCount, 2);
  assertEquals(artifact.interactionResults[0].value, 42);
});

Deno.test("repeated CPU compilation emits byte-identical Wasm", async () => {
  const source = `identity x = x\nmain = identity 42\n`;
  const first = await compileModuleSource("test.hs", source, {
    gpuMode: "off",
  });
  const second = await compileModuleSource("test.hs", source, {
    gpuMode: "off",
  });
  assertEquals([...first.wasm], [...second.wasm]);
});

Deno.test("LEB128 encoders cover signed and unsigned boundaries", () => {
  assertEquals(encodeUnsigned(0), [0]);
  assertEquals(encodeUnsigned(127), [127]);
  assertEquals(encodeUnsigned(128), [128, 1]);
  assertEquals(encodeSigned(-1), [127]);
  assertEquals(encodeSigned(63), [63]);
  assertEquals(encodeSigned(64), [192, 0]);
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  }
}

function assertMatches(actual: string | undefined, expected: RegExp): void {
  if (actual === undefined || !expected.test(actual)) {
    throw new Error(`expected ${JSON.stringify(actual)} to match ${expected}`);
  }
}

function assertThrows(action: () => unknown, expected: RegExp): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && expected.test(error.message)) return;
    throw new Error(
      `expected error matching ${expected}, received ${String(error)}`,
    );
  }
  throw new Error(
    `expected error matching ${expected}, but no error was thrown`,
  );
}

async function assertRejects(
  action: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && expected.test(error.message)) return;
    throw new Error(
      `expected rejection matching ${expected}, received ${String(error)}`,
    );
  }
  throw new Error(
    `expected rejection matching ${expected}, but no error was thrown`,
  );
}

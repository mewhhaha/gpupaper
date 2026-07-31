import {
  CpuFrontend,
  decodeGpuFrontendPlan,
} from "@mewhhaha/baba/runtime/webgpu";
import {
  lowerBlotCompactProgram,
  lowerBlotI64ModuleToWasm,
} from "../src/blot_compiler.ts";
import { parseCommandLine } from "../src/cli.ts";
import { compileModuleSource, runMain } from "../src/compiler.ts";
import { emitWasmPlanOnCpu } from "../src/wasm.ts";

const plan = await Deno.readFile(
  new URL("../grammar/blot/generated/parser.plan", import.meta.url),
);
const cpuFrontend = CpuFrontend.create(plan);
const ruleNames = new Map(
  decodeGpuFrontendPlan(plan).islands.map((island) => [
    island.ruleId,
    island.ruleName,
  ]),
);

Deno.test("Blot I64 payload evaluates a literal return", async () => {
  const wasm = compileCompactOracle("return 42;");

  assertEquals(await runMain(wasm), 42n);
});

Deno.test("Blot I64 payload resolves preceding bindings", async () => {
  const wasm = compileCompactOracle("let answer = 42; return answer;");

  assertEquals(await runMain(wasm), 42n);
});

Deno.test("Blot I64 payload shadowing reads the previous immutable binding", async () => {
  const source = "let answer = 41; let answer = answer; return answer;";
  const core = lowerCompactOracle(source);

  assertEquals(core.bindings[1].value, {
    kind: "binding",
    binding: 0,
    name: "answer",
    span: { file: "test.blot", start: 30, end: 36 },
  });
  assertEquals(
    await runMain(emitWasmPlanOnCpu(lowerBlotI64ModuleToWasm(core))),
    41n,
  );
});

Deno.test("Blot I64 payload emission is deterministic", () => {
  const core = lowerCompactOracle("let answer = 42; return answer;");
  const first = emitWasmPlanOnCpu(lowerBlotI64ModuleToWasm(core));
  const second = emitWasmPlanOnCpu(lowerBlotI64ModuleToWasm(core));

  assertEquals(first, second);
});

Deno.test("Blot I64 payload rejects a use before its binding", () => {
  assertThrows(
    () => lowerCompactOracle("return answer;"),
    /name "answer" has no preceding I64 binding/,
  );
});

Deno.test("Blot GPU validation rejects literals above signed I32", () => {
  const result = cpuFrontend.ingest("return 2147483648;");

  if (
    result.ok ||
    result.diagnostics[0]?.code !== "GPU_FRONTEND_INTEGER_BOUNDS"
  ) {
    throw new Error(
      "Blot frontend did not enforce its signed I32 literal boundary",
    );
  }
});

Deno.test("Blot I64 payload rejects prelude-defined operators", () => {
  assertThrows(
    () => lowerCompactOracle("return 40 + 2;"),
    /expression is not one I64 atom/,
  );
});

Deno.test("Blot I64 payload rejects declarations after return", () => {
  assertThrows(
    () => lowerCompactOracle("return 1; let answer = 2;"),
    /let declaration follows return/,
  );
});

Deno.test("Blot CLI selects required unverified GPU execution", () => {
  const invocation = parseCommandLine(["compile", "program.blot"]);

  assertEquals(invocation.gpuMode, "required");
  assertEquals(invocation.gpuWasmVerification, "none");
});

Deno.test("Blot CLI rejects CPU compilation", () => {
  assertThrows(
    () => parseCommandLine(["compile", "program.blot", "--cpu"]),
    /Blot compilation requires GPU syntax and GPU Wasm emission/,
  );
});

Deno.test("Blot compilation uses GPU syntax and GPU Wasm emission", async () => {
  if (!(await hasWebGpuAdapter())) return;
  const artifact = await compileModuleSource(
    "test.blot",
    "let answer = 42; return answer;",
    { gpuWasmVerification: "differential" },
  );

  assertEquals(artifact.language, "blot");
  assertEquals(artifact.backends, {
    typeCheck: "cpu",
    comptime: "notApplicable",
    coreRewrite: "notApplicable",
    wasmEmission: "gpu",
    wasmVerification: "cpuDifferential",
  });
  assertEquals(await runMain(artifact.wasm), 42n);
});

function lowerCompactOracle(source: string) {
  const result = cpuFrontend.ingest(source);
  if (!result.ok) {
    throw new Error(
      `test fixture failed Blot syntax: ${
        result.diagnostics.map((diagnostic) => diagnostic.code).join(", ")
      }`,
    );
  }
  return lowerBlotCompactProgram(
    "test.blot",
    source,
    result.program,
    ruleNames,
  );
}

function compileCompactOracle(source: string): Uint8Array {
  return emitWasmPlanOnCpu(
    lowerBlotI64ModuleToWasm(lowerCompactOracle(source)),
  );
}

async function hasWebGpuAdapter(): Promise<boolean> {
  if (navigator.gpu === undefined) return false;
  return await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  }) !== null;
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual === expected) return;
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    if (
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    ) return;
  } else if (JSON.stringify(actual) === JSON.stringify(expected)) {
    return;
  }
  throw new Error(
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
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

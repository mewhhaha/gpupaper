import {
  CpuFrontend,
  decodeGpuFrontendPlan,
  WebGpuRuntime,
} from "@mewhhaha/baba/runtime/webgpu";
import {
  compileBlotPayload,
  lowerBlotCompactProgram,
  lowerBlotI64ModuleToWasm,
} from "../src/blot_compiler.ts";
import {
  blotGpuCompactSchema,
  lowerBlotResidentSyntax,
} from "../src/blot_gpu_lowering.ts";
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

Deno.test("Blot resident schema matches the pinned Baba compact IDs", () => {
  const source = "let answer = 42; return answer;";
  const result = cpuFrontend.ingest(source);
  if (!result.ok) throw new Error("schema witness did not parse");
  const terminals = new Map<string, number>();
  for (let offset = 0; offset < result.program.tokens.length; offset += 4) {
    const start = result.program.tokens[offset + 1];
    const end = result.program.tokens[offset + 2];
    terminals.set(source.slice(start, end), result.program.tokens[offset]);
  }
  assertEquals(terminals.get("let"), blotGpuCompactSchema.terminals.let);
  assertEquals(
    terminals.get("answer"),
    blotGpuCompactSchema.terminals.identifier,
  );
  assertEquals(terminals.get("42"), blotGpuCompactSchema.terminals.integer);
  assertEquals(terminals.get("="), blotGpuCompactSchema.terminals.equals);
  assertEquals(terminals.get(";"), blotGpuCompactSchema.terminals.semicolon);
  assertEquals(terminals.get("return"), blotGpuCompactSchema.terminals.return);

  const rules = new Set<number>();
  for (let offset = 0; offset < result.program.nodes.length; offset += 8) {
    rules.add(result.program.nodes[offset]);
  }
  for (const rule of Object.values(blotGpuCompactSchema.rules)) {
    if (!rules.has(rule)) {
      throw new Error(`schema witness did not produce compact rule ${rule}`);
    }
  }
  const fields = new Set<number>();
  for (let offset = 0; offset < result.program.edges.length; offset += 4) {
    fields.add(result.program.edges[offset] >>> 0);
  }
  for (const field of Object.values(blotGpuCompactSchema.fields)) {
    if (!fields.has(field)) {
      throw new Error(`schema witness did not produce compact field ${field}`);
    }
  }
});

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
    typeCheck: "gpu",
    comptime: "notApplicable",
    coreRewrite: "notApplicable",
    wasmEmission: "gpu",
    wasmVerification: "cpuDifferential",
  });
  assertEquals(await runMain(artifact.wasm), 42n);
});

Deno.test("Blot direct-ordinal and segmented resident lowering agree with the compact oracle", async () => {
  if (!(await hasWebGpuAdapter())) return;
  const source =
    "// UTF-16 😀\nlet answer = 41; let answer = answer; return answer;";
  const expected = lowerCompactOracle(source);

  const direct = await compileBlotPayload("test.blot", source, {
    payloadStrategy: "direct-ordinal-fused",
  });
  const segmented = await compileBlotPayload("test.blot", source, {
    payloadStrategy: "segmented-scan",
  });

  assertEquals(direct.core, expected);
  assertEquals(segmented.core, expected);
  assertEquals(direct.timings.payloadScanDispatchCount, 0);
  if (segmented.timings.payloadScanDispatchCount === 0) {
    throw new Error(
      "segmented Blot lowering did not execute its reference scan",
    );
  }
});

Deno.test("Blot resident kernels agree on every available WebGPU adapter", async () => {
  if (navigator.gpu === undefined) return;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) return;
  const source =
    "// UTF-16 😀\nlet answer = 41; let answer = answer; return answer;";
  const expected = lowerCompactOracle(source);
  const runtime = await WebGpuRuntime.create({ allowFallbackAdapter: true });
  const frontend = await runtime.compileFrontend(plan);
  let resident;
  try {
    resident = await frontend.ingestResident(source);
    const direct = await lowerBlotResidentSyntax(
      "test.blot",
      source,
      runtime.device,
      resident,
      "direct-ordinal-fused",
    );
    const segmented = await lowerBlotResidentSyntax(
      "test.blot",
      source,
      runtime.device,
      resident,
      "segmented-scan",
    );

    assertEquals(
      direct.bindings.map((binding) => ({
        id: binding.id,
        name: source.slice(binding.nameStart, binding.nameEnd),
      })),
      expected.bindings.map((binding) => ({
        id: binding.id,
        name: binding.name,
      })),
    );
    assertEquals(direct.bindings[0].value, {
      kind: "integer",
      value: 41,
      start: expected.bindings[0].value.span.start,
      end: expected.bindings[0].value.span.end,
    });
    assertEquals(direct.bindings[1].value, {
      kind: "binding",
      binding: 0,
      start: expected.bindings[1].value.span.start,
      end: expected.bindings[1].value.span.end,
    });
    assertEquals(direct.result, {
      kind: "binding",
      binding: 1,
      start: expected.result.span.start,
      end: expected.result.span.end,
    });
    assertEquals(segmented.bindings, direct.bindings);
    assertEquals(segmented.result, direct.result);
    assertEquals(direct.scanDispatchCount, 0);
    if (segmented.scanDispatchCount === 0) {
      throw new Error("segmented Blot lowering did not execute its scan");
    }
  } finally {
    resident?.dispose();
    frontend.dispose();
    runtime.dispose();
  }
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
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  return adapter?.info?.isFallbackAdapter === false;
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual === expected) return;
  const serialize = (value: unknown): string | undefined =>
    JSON.stringify(
      value,
      (_key, nested) =>
        typeof nested === "bigint" ? `${nested.toString()}n` : nested,
    );
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    if (
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    ) return;
  } else if (serialize(actual) === serialize(expected)) return;
  throw new Error(
    `expected ${serialize(expected)}, received ${serialize(actual)}`,
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

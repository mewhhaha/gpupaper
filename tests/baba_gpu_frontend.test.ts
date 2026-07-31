import {
  type CompactFrontendProgram,
  CpuFrontend,
  decodeLexerPlanTables,
  inspectGpuFrontendPlan,
} from "@mewhhaha/baba/runtime/webgpu";
import { BabaGpuSyntaxSession } from "../src/baba_gpu_syntax.ts";

const blotPlan = await Deno.readFile(
  new URL("../grammar/blot/generated/parser.plan", import.meta.url),
);
const duckPlan = await Deno.readFile(
  new URL("../grammar/generated/parser.plan", import.meta.url),
);
const minimalBlot = await Deno.readTextFile(
  new URL("../examples/blot/minimal.blot", import.meta.url),
);

Deno.test("Blot carries a strict proved GPU syntax profile", () => {
  const inspection = inspectGpuFrontendPlan(blotPlan);
  if (inspection === null) {
    throw new Error("Blot parser plan has no GPU frontend profile");
  }
  if (inspection.version !== 3 || inspection.throughput !== "strict") {
    throw new Error(
      `Blot GPU profile is version ${inspection.version} ${inspection.throughput}; expected version 3 strict`,
    );
  }
  if (inspection.rootLoopIsland === null) {
    throw new Error("Blot strict profile has no proved repeated root island");
  }
  const lexer = decodeLexerPlanTables(blotPlan);
  if (!lexer.guardFree) {
    throw new Error(
      `Blot GPU lexer carries guards: ${lexer.guardDiagnostics.join(", ")}`,
    );
  }
});

Deno.test("Duck contextual tokens reject GPU syntax before device work", () => {
  const inspection = inspectGpuFrontendPlan(duckPlan);
  if (inspection !== null) {
    throw new Error("contextual Duck grammar unexpectedly has a GPU profile");
  }
  const lexer = decodeLexerPlanTables(duckPlan);
  if (lexer.guardFree || lexer.guardDiagnostics.length === 0) {
    throw new Error("contextual Duck grammar did not expose its lexer guards");
  }
});

Deno.test("production syntax rejects Duck instead of falling back", async () => {
  try {
    await BabaGpuSyntaxSession.create(duckPlan);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "production syntax requires a version-3 GPU frontend profile",
      )
    ) {
      return;
    }
    throw error;
  }
  throw new Error("production syntax admitted contextual Duck");
});

Deno.test("Blot GPU syntax exactly matches the CPU oracle", async () => {
  await useBlotGpuFrontend(async (cpu, gpu) => {
    const acceptedCpu = cpu.ingest(minimalBlot);
    const acceptedGpu = await gpu.parseAndValidate(minimalBlot);
    if (!acceptedCpu.ok || !acceptedGpu.ok) {
      throw new Error(
        `accepted Blot failed: CPU=${diagnosticCodes(acceptedCpu)} GPU=${
          diagnosticCodes(acceptedGpu)
        }`,
      );
    }
    assertProgramEqual(acceptedCpu.program, acceptedGpu.program);

    const rejectedSource = "let answer = ;";
    const rejectedCpu = cpu.ingest(rejectedSource);
    const rejectedGpu = await gpu.parseAndValidate(rejectedSource);
    if (rejectedCpu.ok || rejectedGpu.ok) {
      throw new Error(
        `malformed Blot acceptance differed: CPU=${rejectedCpu.ok} GPU=${rejectedGpu.ok}`,
      );
    }
    const cpuDiagnostic = rejectedCpu.diagnostics[0];
    const gpuDiagnostic = rejectedGpu.diagnostics[0];
    if (
      rejectedCpu.diagnostics.length !== 1 ||
      rejectedGpu.diagnostics.length !== 1 ||
      cpuDiagnostic.code !== gpuDiagnostic.code ||
      cpuDiagnostic.start !== gpuDiagnostic.start ||
      cpuDiagnostic.end !== gpuDiagnostic.end
    ) {
      throw new Error(
        `malformed Blot diagnostics differ: CPU=${
          diagnosticCodes(rejectedCpu)
        } GPU=${diagnosticCodes(rejectedGpu)}`,
      );
    }
  });
});

Deno.test("Blot GPU syntax reports every explicit capacity", async () => {
  await useBlotGpuFrontend(async (_cpu, gpu) => {
    const limits = [
      {
        options: { lexerCapacityRecords: 1 },
        code: "GPU_FRONTEND_TOKEN_CAPACITY",
      },
      { options: { maxNodes: 1 }, code: "GPU_FRONTEND_NODE_CAPACITY" },
      { options: { maxEdges: 1 }, code: "GPU_FRONTEND_EDGE_CAPACITY" },
    ] as const;
    for (const limit of limits) {
      const result = await gpu.parseAndValidate(minimalBlot, limit.options);
      if (result.ok || result.diagnostics[0]?.code !== limit.code) {
        throw new Error(
          `${JSON.stringify(limit.options)} produced ${
            diagnosticCodes(result)
          }; expected ${limit.code}`,
        );
      }
    }
  });
});

Deno.test("resident Blot syntax releases its device ownership explicitly", async () => {
  await useBlotGpuFrontend(async (_cpu, gpu) => {
    const resident = await gpu.submitResidentSyntax(minimalBlot);
    if (
      resident.layout.statusWord !== 0 ||
      resident.layout.tokenCountWord !== 1 ||
      resident.layout.nodeCountWord !== 2 ||
      resident.layout.edgeCountWord !== 3
    ) {
      throw new Error("resident Blot syntax header does not match Baba 7.10");
    }
    await gpu.waitForSubmittedWork();
    resident.dispose();
    resident.dispose();
  });
});

function assertProgramEqual(
  expected: CompactFrontendProgram,
  actual: CompactFrontendProgram,
): void {
  for (
    const buffer of ["tokens", "nodes", "edges", "symbols", "types"] as const
  ) {
    assertWordsEqual(expected[buffer], actual[buffer], buffer);
  }
}

function assertWordsEqual(
  expected: ArrayLike<number>,
  actual: ArrayLike<number>,
  buffer: string,
): void {
  if (expected.length !== actual.length) {
    throw new Error(
      `${buffer} has ${actual.length} words; expected ${expected.length}`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) {
      throw new Error(
        `${buffer}[${index}] is ${actual[index]}; expected ${expected[index]}`,
      );
    }
  }
}

function diagnosticCodes(
  result: ReturnType<CpuFrontend["ingest"]>,
): string {
  return result.ok
    ? "accepted"
    : result.diagnostics.map((diagnostic) => diagnostic.code).join(",");
}

async function useBlotGpuFrontend(
  run: (
    cpu: CpuFrontend,
    gpu: BabaGpuSyntaxSession,
  ) => Promise<void>,
): Promise<void> {
  if (navigator.gpu === undefined) return;
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (adapter === null) return;

  const gpu = await BabaGpuSyntaxSession.create(blotPlan);
  try {
    await run(CpuFrontend.create(blotPlan), gpu);
  } finally {
    gpu.dispose();
  }
}

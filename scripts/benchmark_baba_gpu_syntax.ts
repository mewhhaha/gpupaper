import {
  type CompactFrontendProgram,
  CpuFrontend,
} from "@mewhhaha/baba/runtime/webgpu";
import { BabaGpuSyntaxSession } from "../src/baba_gpu_syntax.ts";

const bindingCounts = [32, 512, 8_192, 32_768] as const;
const sampleCount = requestedSampleCount(Deno.args);
const plan = await Deno.readFile(
  new URL("../grammar/blot/generated/parser.plan", import.meta.url),
);
const cpu = CpuFrontend.create(plan);

const gpu = await BabaGpuSyntaxSession.create(plan);

try {
  const warmup = await gpu.parseAndValidate(blotSource(1));
  if (!warmup.ok) {
    throw new Error(
      `Blot GPU syntax warmup failed: ${diagnosticSummary(warmup.diagnostics)}`,
    );
  }

  const measurements = [];
  for (const bindingCount of bindingCounts) {
    const source = blotSource(bindingCount);
    const sourceBytes = new TextEncoder().encode(source).byteLength;
    const expected = cpu.ingest(source);
    const actual = await gpu.parseAndValidate(source);
    if (!expected.ok || !actual.ok) {
      throw new Error(
        `${bindingCount} bindings failed: CPU=${
          diagnosticSummary(expected.diagnostics)
        } GPU=${diagnosticSummary(actual.diagnostics)}`,
      );
    }
    assertProgramEqual(expected.program, actual.program);

    const cpuMilliseconds = [];
    const ownedGpuMilliseconds = [];
    const residentSubmissionMilliseconds = [];
    const residentCompletionMilliseconds = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const cpuStart = performance.now();
      const cpuResult = cpu.ingest(source);
      cpuMilliseconds.push(performance.now() - cpuStart);
      if (!cpuResult.ok) {
        throw new Error(
          `CPU sample failed: ${diagnosticSummary(cpuResult.diagnostics)}`,
        );
      }

      const ownedStart = performance.now();
      const ownedResult = await gpu.parseAndValidate(source);
      ownedGpuMilliseconds.push(performance.now() - ownedStart);
      if (!ownedResult.ok) {
        throw new Error(
          `owned GPU sample failed: ${
            diagnosticSummary(ownedResult.diagnostics)
          }`,
        );
      }

      const residentStart = performance.now();
      const resident = await gpu.submitResidentSyntax(source);
      residentSubmissionMilliseconds.push(resident.timings.totalMs);
      await gpu.waitForSubmittedWork();
      residentCompletionMilliseconds.push(performance.now() - residentStart);
      resident.dispose();
    }
    measurements.push({
      bindingCount,
      sourceBytes,
      tokenCount: actual.program.tokens.length / 4,
      nodeCount: actual.program.nodes.length / 8,
      edgeCount: actual.program.edges.length / 4,
      cpuMilliseconds,
      cpuMedianMilliseconds: median(cpuMilliseconds),
      ownedGpuMilliseconds,
      ownedGpuMedianMilliseconds: median(ownedGpuMilliseconds),
      residentSubmissionMilliseconds,
      residentSubmissionMedianMilliseconds: median(
        residentSubmissionMilliseconds,
      ),
      residentCompletionMilliseconds,
      residentCompletionMedianMilliseconds: median(
        residentCompletionMilliseconds,
      ),
    });
  }

  const ownedBreakEven = measurements.find((measurement) =>
    measurement.ownedGpuMedianMilliseconds <= measurement.cpuMedianMilliseconds
  );
  console.log(JSON.stringify({
    adapter: gpu.capabilities,
    sampleCount,
    ...gpu.setupTimings,
    measurements,
    ownedBreakEven: ownedBreakEven === undefined
      ? {
        status: "not-observed",
        maximumMeasuredSourceBytes: measurements.at(-1)!.sourceBytes,
      }
      : {
        status: "observed",
        sourceBytes: ownedBreakEven.sourceBytes,
        bindingCount: ownedBreakEven.bindingCount,
      },
    residentBoundary:
      "submission retains unverified device status; completion waits for queue work but does not read diagnostics or run host semantic recipes",
  }));
} finally {
  gpu.dispose();
}

function blotSource(bindingCount: number): string {
  const bindings = Array.from(
    { length: bindingCount },
    (_, index) => `let value_${index} = ${index};`,
  );
  return `${bindings.join("\n")}\nreturn value_${bindingCount - 1};\n`;
}

function assertProgramEqual(
  expected: CompactFrontendProgram,
  actual: CompactFrontendProgram,
): void {
  for (
    const buffer of ["tokens", "nodes", "edges", "symbols", "types"] as const
  ) {
    const left = expected[buffer];
    const right = actual[buffer];
    if (left.length !== right.length) {
      throw new Error(
        `${buffer} has ${right.length} words on GPU; CPU produced ${left.length}`,
      );
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        throw new Error(
          `${buffer}[${index}] is ${right[index]} on GPU; CPU produced ${
            left[index]
          }`,
        );
      }
    }
  }
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const argument = arguments_[0];
  if (argument === undefined) return 5;
  const sampleCount = Number(argument);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
    throw new Error(
      `sample count must be a positive safe integer; received ${argument}`,
    );
  }
  return sampleCount;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("cannot take the median of an empty measurement set");
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function diagnosticSummary(
  diagnostics: readonly { readonly code: string; readonly message: string }[],
): string {
  return diagnostics.length === 0
    ? "none"
    : diagnostics.map((diagnostic) =>
      `${diagnostic.code}: ${diagnostic.message}`
    ).join("; ");
}

import {
  type CompactFrontendProgram,
  CpuFrontend,
} from "@mewhhaha/baba/runtime/webgpu";
import { BabaGpuSyntaxSession } from "../src/baba_gpu_syntax.ts";
import { lowerBlotResidentSyntax } from "../src/blot_gpu_lowering.ts";

const bindingCounts = [32, 512, 8_192, 32_768] as const;
const resolutionBindingCounts = [32, 512, 2_048] as const;
const sampleCount = requestedSampleCount(Deno.args);
const plan = await Deno.readFile(
  new URL("../grammar/blot/generated/parser.plan", import.meta.url),
);
const cpu = CpuFrontend.create(plan);

const benchmarkAdapter = await navigator.gpu?.requestAdapter({
  powerPreference: "high-performance",
});
if (benchmarkAdapter?.info?.isFallbackAdapter !== false) {
  throw new Error(
    `Blot benchmark requires a hardware adapter; received ${
      benchmarkAdapter?.info?.description ?? "none"
    }`,
  );
}
const gpu = await BabaGpuSyntaxSession.create(plan);

try {
  const warmup = await gpu.parseAndValidate(blotSource(1));
  if (!warmup.ok) {
    throw new Error(
      `Blot GPU syntax warmup failed: ${diagnosticSummary(warmup.diagnostics)}`,
    );
  }
  for (
    const strategy of ["direct-ordinal-fused", "segmented-scan"] as const
  ) {
    const source = blotSource(1);
    const resident = await gpu.submitResidentSyntax(source);
    try {
      await lowerBlotResidentSyntax(
        "warmup.blot",
        source,
        gpu.device,
        resident,
        strategy,
      );
    } finally {
      resident.dispose();
    }
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
    const directOrdinalLoweringMilliseconds = [];
    const segmentedLoweringMilliseconds = [];
    let directOrdinalReadbackBytes = 0;
    let declarationCapacity = 0;
    let scheduledDeclarationInvocationCount = 0;
    let segmentedScanDispatchCount = 0;
    let segmentedScanAdditionWork = 0;
    let segmentedScanAdditionWorkUpperBound = 0;
    let segmentedScanScheduledInvocationCount = 0;
    let segmentedScanTemporaryBytes = 0;
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

      for (
        const strategy of ["direct-ordinal-fused", "segmented-scan"] as const
      ) {
        const loweringResident = await gpu.submitResidentSyntax(source);
        await gpu.waitForSubmittedWork();
        try {
          const lowering = await lowerBlotResidentSyntax(
            "benchmark.blot",
            source,
            gpu.device,
            loweringResident,
            strategy,
          );
          if (lowering.bindings.length !== bindingCount) {
            throw new Error(
              `resident payload has ${lowering.bindings.length} bindings; expected ${bindingCount}`,
            );
          }
          if (strategy === "direct-ordinal-fused") {
            directOrdinalLoweringMilliseconds.push(
              lowering.completionMilliseconds,
            );
            directOrdinalReadbackBytes = lowering.residentReadbackBytes;
            declarationCapacity = lowering.declarationCapacity;
            scheduledDeclarationInvocationCount =
              lowering.scheduledDeclarationInvocationCount;
          } else {
            segmentedLoweringMilliseconds.push(
              lowering.completionMilliseconds,
            );
            segmentedScanDispatchCount = lowering.scanDispatchCount;
            segmentedScanAdditionWork = lowering.scanAdditionWork;
            segmentedScanAdditionWorkUpperBound =
              lowering.scanAdditionWorkUpperBound;
            segmentedScanScheduledInvocationCount =
              lowering.scanScheduledInvocationCount;
            segmentedScanTemporaryBytes = lowering.scanTemporaryBytes;
          }
        } finally {
          loweringResident.dispose();
        }
      }
    }
    measurements.push({
      bindingCount,
      sourceBytes,
      tokenCount: actual.program.tokens.length / 4,
      nodeCount: actual.program.nodes.length / 8,
      edgeCount: actual.program.edges.length / 4,
      declarationCapacity,
      paddedDeclarationLaneCount: declarationCapacity - bindingCount - 1,
      scheduledDeclarationInvocationCount,
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
      directOrdinalLoweringMilliseconds,
      directOrdinalLoweringMedianMilliseconds: median(
        directOrdinalLoweringMilliseconds,
      ),
      directOrdinalReadbackBytes,
      segmentedLoweringMilliseconds,
      segmentedLoweringMedianMilliseconds: median(
        segmentedLoweringMilliseconds,
      ),
      segmentedScanDispatchCount,
      segmentedScanAdditionWork,
      segmentedScanAdditionWorkUpperBound,
      segmentedScanScheduledInvocationCount,
      segmentedScanTemporaryBytes,
      directOrdinalSpeedupOverSegmented: median(segmentedLoweringMilliseconds) /
        median(directOrdinalLoweringMilliseconds),
    });
  }

  const ownedBreakEven = measurements.find((measurement) =>
    measurement.ownedGpuMedianMilliseconds <= measurement.cpuMedianMilliseconds
  );
  const resolutionMeasurements = [];
  for (const bindingCount of resolutionBindingCounts) {
    const source = blotResolutionSource(bindingCount);
    const directOrdinalLoweringMilliseconds = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const resident = await gpu.submitResidentSyntax(source);
      await gpu.waitForSubmittedWork();
      try {
        const lowering = await lowerBlotResidentSyntax(
          "resolution-benchmark.blot",
          source,
          gpu.device,
          resident,
          "direct-ordinal-fused",
        );
        if (lowering.bindings.length !== bindingCount) {
          throw new Error(
            `resolution payload has ${lowering.bindings.length} bindings; expected ${bindingCount}`,
          );
        }
        directOrdinalLoweringMilliseconds.push(
          lowering.completionMilliseconds,
        );
      } finally {
        resident.dispose();
      }
    }
    resolutionMeasurements.push({
      bindingCount,
      sourceBytes: new TextEncoder().encode(source).byteLength,
      predecessorCandidateComparisons: bindingCount * (bindingCount + 1) / 2,
      directOrdinalLoweringMilliseconds,
      directOrdinalLoweringMedianMilliseconds: median(
        directOrdinalLoweringMilliseconds,
      ),
    });
  }
  console.log(JSON.stringify({
    adapter: gpu.capabilities,
    sampleCount,
    ...gpu.setupTimings,
    measurements,
    resolutionMeasurements,
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

function blotResolutionSource(bindingCount: number): string {
  const bindings = ["let root = 0;"];
  for (let index = 1; index < bindingCount; index += 1) {
    bindings.push(`let value_${index} = root;`);
  }
  return `${bindings.join("\n")}\nreturn root;\n`;
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

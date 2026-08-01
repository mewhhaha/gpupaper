import { compileModuleSource } from "../src/compiler.ts";
import { lowerDucklangCoreToFcgAndWasm } from "../src/ducklang_core_wasm.ts";
import {
  type FlatDucklangCore,
  inflateFlatDucklangCore,
} from "../src/flat_ducklang_core.ts";
import { emitWasmPlanOnCpu, type WasmBinaryPlan } from "../src/wasm.ts";
import {
  emitWasmPlanOnGpu,
  type GpuWasmLowWordLayout,
} from "../src/gpu_wasm.ts";

const targets = [
  target("editor", "editor/editor.duck", "editor/host.duck"),
  target("codex", "codex/codex.duck", "codex/host.duck"),
  target("grep", "grep/grep.duck", "grep/host.duck"),
  target("tar", "tar/tar.duck", "tar/host.duck"),
  target("wav", "wav/wav.duck"),
  target("raytracer", "raytracer/raytracer.duck"),
] as const;
const sampleCount = requestedSampleCount(Deno.args);
const preparedTargets = await Promise.all(targets.map(prepareTarget));
const planningSamples = new Map(
  preparedTargets.map((prepared) => [
    prepared.name,
    [] as ReturnType<typeof measureFlatCorePlanning>[],
  ]),
);
for (const prepared of preparedTargets) {
  for (let warmup = 0; warmup < 3; warmup += 1) {
    measureFlatCorePlanning(prepared);
  }
}
for (let sample = 0; sample < sampleCount; sample += 1) {
  const orderedTargets = sample % 2 === 0
    ? preparedTargets
    : [...preparedTargets].reverse();
  for (const prepared of orderedTargets) {
    planningSamples.get(prepared.name)!.push(
      measureFlatCorePlanning(prepared),
    );
  }
}
const cpuSampleCount = 101;
const cpuSamples = new Map(
  preparedTargets.map((prepared) => [prepared.name, [] as number[]]),
);
for (const prepared of preparedTargets) {
  for (let warmup = 0; warmup < 10; warmup += 1) {
    measureCpuEmission(prepared);
  }
}
for (let sample = 0; sample < cpuSampleCount; sample += 1) {
  const orderedTargets = sample % 2 === 0
    ? preparedTargets
    : [...preparedTargets].reverse();
  for (const prepared of orderedTargets) {
    cpuSamples.get(prepared.name)!.push(measureCpuEmission(prepared));
  }
}

const measuredLayouts = ["dense", "ranked"] as const;
for (const prepared of preparedTargets) {
  for (const lowWordLayout of measuredLayouts) {
    await measureEmission(prepared, lowWordLayout);
  }
}

const samples = new Map(
  preparedTargets.map((prepared) => [
    prepared.name,
    {
      dense: [] as Awaited<ReturnType<typeof measureEmission>>[],
      ranked: [] as Awaited<ReturnType<typeof measureEmission>>[],
    },
  ]),
);
const work = new Map<
  string,
  Partial<
    Record<
      Exclude<GpuWasmLowWordLayout, "adaptive">,
      Awaited<ReturnType<typeof measureEmission>>
    >
  >
>();
for (let sample = 0; sample < sampleCount; sample += 1) {
  const orderedTargets = sample % 2 === 0
    ? preparedTargets
    : [...preparedTargets].reverse();
  for (const prepared of orderedTargets) {
    const targetIndex = preparedTargets.indexOf(prepared);
    const orderedLayouts = (sample + targetIndex) % 2 === 0
      ? measuredLayouts
      : [...measuredLayouts].reverse();
    for (const lowWordLayout of orderedLayouts) {
      const measurement = await measureEmission(prepared, lowWordLayout);
      samples.get(prepared.name)![lowWordLayout].push(measurement);
      const targetWork = work.get(prepared.name) ?? {};
      targetWork[lowWordLayout] = measurement;
      work.set(prepared.name, targetWork);
    }
  }
}

console.log(JSON.stringify({
  schemaVersion: 2,
  validity: {
    status: "diagnostic",
    reason: "Wasm benchmark does not inspect competing process or GPU load",
  },
  sampleCount,
  warmupCountPerLayout: 1,
  targetOrder: "alternatingForwardReverse",
  layoutOrder: "alternatingDenseRanked",
  cpuSampleCount,
  planningWarmupCountPerTarget: 3,
  planningBoundaryId:
    "validated-flat-core-through-object-stackifier-to-wasm-plan",
  planningMeasuredBoundary:
    "validated flat Core through object reconstruction and stackification to Wasm plan",
  cpuWarmupCountPerTarget: 10,
  cpuTargetOrder: "alternatingForwardReverse",
  cpuMeasuredBoundary: "planValidationThroughCpuByteEmission",
  cpuBoundaryId: "wasm-plan-to-cpu-bytes",
  measuredBoundary: "hostPlanAnalysisThroughMappedGpuReadbackAndByteCopy",
  boundaryId: "wasm-plan-to-gpu-bytes-and-mapped-readback",
  targets: preparedTargets.map((prepared) => {
    const targetSamples = samples.get(prepared.name)!;
    const targetWork = work.get(prepared.name)!;
    const targetPlanning = planningSamples.get(prepared.name)!;
    const planningTotals = targetPlanning.map((sample) =>
      sample.totalMilliseconds
    );
    const denseMedian = median(
      targetSamples.dense.map((sample) => sample.milliseconds),
    );
    const rankedMedian = median(
      targetSamples.ranked.map((sample) => sample.milliseconds),
    );
    return {
      target: prepared.name,
      atomCount: prepared.plan.atoms.length,
      wasmBytes: prepared.expectedBytes.length,
      planning: {
        medianMilliseconds: median(planningTotals),
        p95Milliseconds: percentile(planningTotals, 0.95),
        minimumMilliseconds: Math.min(...planningTotals),
        maximumMilliseconds: Math.max(...planningTotals),
        rawMeasurements: targetPlanning,
      },
      cpuOracle: {
        medianMilliseconds: median(cpuSamples.get(prepared.name)!),
        p95Milliseconds: percentile(cpuSamples.get(prepared.name)!, 0.95),
        minimumMilliseconds: Math.min(...cpuSamples.get(prepared.name)!),
        maximumMilliseconds: Math.max(...cpuSamples.get(prepared.name)!),
        rawMilliseconds: cpuSamples.get(prepared.name)!,
      },
      dense: reportLayout(targetSamples.dense, targetWork.dense!),
      ranked: reportLayout(targetSamples.ranked, targetWork.ranked!),
      rankedToDenseMedianRatio: rankedMedian / denseMedian,
    };
  }),
}));

type PreparedTarget = {
  readonly name: string;
  readonly flatCore: FlatDucklangCore;
  readonly plan: WasmBinaryPlan;
  readonly expectedBytes: Uint8Array;
};

async function prepareTarget(
  target_: ReturnType<typeof target>,
): Promise<PreparedTarget> {
  const source = await Deno.readTextFile(target_.source);
  const artifact = await compileModuleSource(target_.source, source, {
    gpuMode: "off",
    hostInterface: target_.hostInterface,
  });
  if (artifact.language !== "ducklang") {
    throw new Error(
      `${target_.name} Wasm benchmark compiled ${artifact.language}`,
    );
  }
  return {
    name: target_.name,
    flatCore: artifact.optimizedFlatCore,
    plan: lowerDucklangCoreToFcgAndWasm(artifact.optimizedCore, {
      emission: "planOnly",
    }).wasmPlan,
    expectedBytes: artifact.wasm,
  };
}

function measureFlatCorePlanning(prepared: PreparedTarget): {
  readonly totalMilliseconds: number;
  readonly objectInflationMilliseconds: number;
  readonly objectStackificationAndPlanningMilliseconds: number;
} {
  const start = performance.now();
  const core = inflateFlatDucklangCore(prepared.flatCore);
  const objectInflationMilliseconds = performance.now() - start;
  const planningStart = performance.now();
  const plan = lowerDucklangCoreToFcgAndWasm(core, {
    emission: "planOnly",
  }).wasmPlan;
  const objectStackificationAndPlanningMilliseconds = performance.now() -
    planningStart;
  const totalMilliseconds = performance.now() - start;
  const bytes = emitWasmPlanOnCpu(plan);
  if (!equalBytes(bytes, prepared.expectedBytes)) {
    throw new Error(
      `${prepared.name} flat Core planning benchmark changed Wasm output`,
    );
  }
  return {
    totalMilliseconds,
    objectInflationMilliseconds,
    objectStackificationAndPlanningMilliseconds,
  };
}

async function measureEmission(
  prepared: PreparedTarget,
  lowWordLayout: Exclude<GpuWasmLowWordLayout, "adaptive">,
) {
  const start = performance.now();
  const emitted = await emitWasmPlanOnGpu(prepared.plan, { lowWordLayout });
  const milliseconds = performance.now() - start;
  if (emitted.status === "unavailable") {
    throw new Error(
      `${prepared.name} Wasm benchmark requires WebGPU: ${emitted.reason}`,
    );
  }
  if (!equalBytes(emitted.bytes, prepared.expectedBytes)) {
    throw new Error(
      `${prepared.name} Wasm benchmark disagrees with CPU emission`,
    );
  }
  if (emitted.lowWordLayout !== lowWordLayout) {
    throw new Error(
      `${prepared.name} requested ${lowWordLayout} low words but measured ${emitted.lowWordLayout}`,
    );
  }
  return {
    milliseconds,
    timings: emitted.timings,
    atomInputBytes: emitted.atomInputBytes,
    resolvedOffsetBytes: emitted.resolvedOffsetBytes,
    resolvedOffsetBitWidth: emitted.resolvedOffsetBitWidth,
    dispatchedInvocationCount: emitted.dispatchedInvocationCount,
    sparseLengthSizing: emitted.sparseLengthSizing,
    lengthSizingDependencyAtomCount: emitted.lengthSizingDependencyAtomCount,
    lengthSizingWorkEstimate: emitted.lengthSizingWorkEstimate,
    lowWordBytes: emitted.lowWordBytes,
    byteRankBitWidth: emitted.byteRankBitWidth,
    byteRankBytes: emitted.byteRankBytes,
    maximumByteRank: emitted.maximumByteRank,
  };
}

function measureCpuEmission(prepared: PreparedTarget): number {
  const start = performance.now();
  const bytes = emitWasmPlanOnCpu(prepared.plan);
  const milliseconds = performance.now() - start;
  if (!equalBytes(bytes, prepared.expectedBytes)) {
    throw new Error(
      `${prepared.name} CPU Wasm benchmark disagrees with expected emission`,
    );
  }
  return milliseconds;
}

function reportLayout(
  samples: readonly Awaited<ReturnType<typeof measureEmission>>[],
  work: Awaited<ReturnType<typeof measureEmission>>,
) {
  const wallMilliseconds = samples.map((sample) => sample.milliseconds);
  return {
    medianMilliseconds: median(wallMilliseconds),
    p95Milliseconds: percentile(wallMilliseconds, 0.95),
    minimumMilliseconds: Math.min(...wallMilliseconds),
    maximumMilliseconds: Math.max(...wallMilliseconds),
    rawMilliseconds: wallMilliseconds,
    rawGpuTimings: samples.map((sample) => sample.timings),
    rawHarnessMinusGpuTotalMilliseconds: samples.map((sample) =>
      sample.milliseconds - sample.timings.totalMilliseconds
    ),
    atomInputBytes: work.atomInputBytes,
    lowWordBytes: work.lowWordBytes,
    byteRankBitWidth: work.byteRankBitWidth,
    byteRankBytes: work.byteRankBytes,
    maximumByteRank: work.maximumByteRank,
    resolvedOffsetBytes: work.resolvedOffsetBytes,
    resolvedOffsetBitWidth: work.resolvedOffsetBitWidth,
    dispatchedInvocationCount: work.dispatchedInvocationCount,
    sparseLengthSizing: work.sparseLengthSizing,
    lengthSizingDependencyAtomCount: work.lengthSizingDependencyAtomCount,
    lengthSizingWorkEstimate: work.lengthSizingWorkEstimate,
  };
}

function target(
  name: string,
  source: string,
  hostInterface?: string,
) {
  const root = new URL(
    "../examples/binned/live/case-studies/",
    import.meta.url,
  );
  return {
    name,
    source: new URL(source, root).pathname,
    hostInterface: hostInterface === undefined
      ? undefined
      : new URL(hostInterface, root).pathname,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil((ordered.length - 1) * quantile)]!;
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const sampleArgument = arguments_.find((argument) =>
    argument.startsWith("--samples=")
  );
  if (sampleArgument === undefined) return 21;
  const count = Number.parseInt(sampleArgument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 3 || count % 2 === 0) {
    throw new TypeError(
      `--samples must be an odd integer of at least 3; received ${sampleArgument}`,
    );
  }
  return count;
}

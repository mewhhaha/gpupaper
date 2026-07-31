import { compileModuleSource } from "../src/compiler.ts";
import { lowerDucklangCoreToFcgAndWasm } from "../src/ducklang_core_wasm.ts";
import {
  emitWasmPlanOnGpu,
  type GpuWasmLowWordLayout,
} from "../src/gpu_wasm.ts";
import type { WasmBinaryPlan } from "../src/wasm.ts";

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

const measuredLayouts = ["dense", "ranked"] as const;
for (const prepared of preparedTargets) {
  for (const lowWordLayout of measuredLayouts) {
    await measureEmission(prepared, lowWordLayout);
  }
}

const samples = new Map(
  preparedTargets.map((prepared) => [
    prepared.name,
    { dense: [] as number[], ranked: [] as number[] },
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
      samples.get(prepared.name)![lowWordLayout].push(
        measurement.milliseconds,
      );
      const targetWork = work.get(prepared.name) ?? {};
      targetWork[lowWordLayout] = measurement;
      work.set(prepared.name, targetWork);
    }
  }
}

console.log(JSON.stringify({
  sampleCount,
  warmupCountPerLayout: 1,
  targetOrder: "alternatingForwardReverse",
  layoutOrder: "alternatingDenseRanked",
  measuredBoundary: "hostPlanAnalysisThroughMappedGpuReadbackAndByteCopy",
  targets: preparedTargets.map((prepared) => {
    const targetSamples = samples.get(prepared.name)!;
    const targetWork = work.get(prepared.name)!;
    const denseMedian = median(targetSamples.dense);
    const rankedMedian = median(targetSamples.ranked);
    return {
      target: prepared.name,
      atomCount: prepared.plan.atoms.length,
      wasmBytes: prepared.expectedBytes.length,
      dense: reportLayout(targetSamples.dense, targetWork.dense!),
      ranked: reportLayout(targetSamples.ranked, targetWork.ranked!),
      rankedToDenseMedianRatio: rankedMedian / denseMedian,
    };
  }),
}));

type PreparedTarget = {
  readonly name: string;
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
    plan: lowerDucklangCoreToFcgAndWasm(artifact.optimizedCore, {
      emission: "planOnly",
    }).wasmPlan,
    expectedBytes: artifact.wasm,
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
    atomInputBytes: emitted.atomInputBytes,
    resolvedOffsetBytes: emitted.resolvedOffsetBytes,
    resolvedOffsetBitWidth: emitted.resolvedOffsetBitWidth,
    dispatchedInvocationCount: emitted.dispatchedInvocationCount,
    lowWordBytes: emitted.lowWordBytes,
  };
}

function reportLayout(
  samples: readonly number[],
  work: Awaited<ReturnType<typeof measureEmission>>,
) {
  return {
    medianMilliseconds: median(samples),
    p95Milliseconds: percentile(samples, 0.95),
    minimumMilliseconds: Math.min(...samples),
    maximumMilliseconds: Math.max(...samples),
    atomInputBytes: work.atomInputBytes,
    lowWordBytes: work.lowWordBytes,
    resolvedOffsetBytes: work.resolvedOffsetBytes,
    resolvedOffsetBitWidth: work.resolvedOffsetBitWidth,
    dispatchedInvocationCount: work.dispatchedInvocationCount,
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

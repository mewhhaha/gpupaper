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
import {
  createRustWasmEmitter,
  type RustWasmColdEmission,
  type RustWasmEmission,
  type RustWasmResidentPlan,
} from "../src/rust_wasm_emitter.ts";
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
  runtimeIdentity,
  sha256,
} from "./benchmark_environment.ts";
import { median, summarizeSamples } from "./benchmark_statistics.ts";

const targets = [
  target("editor", "editor/editor.duck", "editor/host.duck"),
  target("codex", "codex/codex.duck", "codex/host.duck"),
  target("grep", "grep/grep.duck", "grep/host.duck"),
  target("tar", "tar/tar.duck", "tar/host.duck"),
  target("wav", "wav/wav.duck"),
  target("raytracer", "raytracer/raytracer.duck"),
] as const;
const sampleCount = requestedSampleCount(Deno.args);
const allowContended = Deno.args.includes("--allow-contended");
const environmentAtStart = await inspectBenchmarkEnvironment();
if (environmentAtStart.status !== "clear" && !allowContended) {
  console.log(JSON.stringify({
    status: "refused",
    reason: "competing compiler or GPU work is active or inspection failed",
    environment: environmentAtStart,
  }));
  Deno.exit(2);
}
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) throw new Error("Wasm benchmark has no GPU adapter");
const preparedTargets = await Promise.all(targets.map(prepareTarget));
const rustWasmInitialization = await createRustWasmEmitter();
const rustWasmResidents = new Map(
  preparedTargets.map((prepared) => [
    prepared.name,
    rustWasmInitialization.emitter.prepare(prepared.plan),
  ]),
);
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
const rustWasmColdSamples = new Map(
  preparedTargets.map((prepared) => [
    prepared.name,
    [] as ReturnType<typeof measureRustWasmCold>[],
  ]),
);
const rustWasmResidentSamples = new Map(
  preparedTargets.map((prepared) => [
    prepared.name,
    [] as ReturnType<typeof measureRustWasmResident>[],
  ]),
);
for (const prepared of preparedTargets) {
  for (let warmup = 0; warmup < 10; warmup += 1) {
    measureCpuEmission(prepared);
    measureRustWasmCold(prepared, rustWasmInitialization.emitter);
    measureRustWasmResident(
      prepared,
      rustWasmResidents.get(prepared.name)!,
    );
  }
}
for (let sample = 0; sample < cpuSampleCount; sample += 1) {
  const orderedTargets = sample % 2 === 0
    ? preparedTargets
    : [...preparedTargets].reverse();
  for (const prepared of orderedTargets) {
    const targetIndex = preparedTargets.indexOf(prepared);
    const measurements = [
      () => cpuSamples.get(prepared.name)!.push(measureCpuEmission(prepared)),
      () =>
        rustWasmColdSamples.get(prepared.name)!.push(
          measureRustWasmCold(prepared, rustWasmInitialization.emitter),
        ),
      () =>
        rustWasmResidentSamples.get(prepared.name)!.push(
          measureRustWasmResident(
            prepared,
            rustWasmResidents.get(prepared.name)!,
          ),
        ),
    ];
    for (let backend = 0; backend < measurements.length; backend += 1) {
      measurements[(backend + sample + targetIndex) % measurements.length]!();
    }
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

const environmentAtEnd = await inspectBenchmarkEnvironment();
for (const resident of rustWasmResidents.values()) resident.release();
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";
console.log(JSON.stringify({
  status: environmentClear || allowContended ? "completed" : "refused",
  schemaVersion: 3,
  validity: environmentClear ? { status: "admissible" } : allowContended
    ? {
      status: "diagnostic",
      reason: "competing compiler or GPU work was present during measurement",
    }
    : {
      status: "refused",
      reason: "competing compiler or GPU work appeared during measurement",
    },
  runtime: runtimeIdentity(),
  repositories: {
    gpupaper: await repositoryIdentity(
      new URL("../", import.meta.url).pathname,
    ),
  },
  adapter: {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  },
  environmentAtStart,
  environmentAtEnd,
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
  rustWasmInitialization: {
    moduleBytes: rustWasmInitialization.moduleBytes,
    timings: rustWasmInitialization.timings,
  },
  rustWasmColdBoundaryId:
    "host-wasm-plan-through-column-copy-rust-validation-emission-and-owned-byte-copy",
  rustWasmResidentBoundaryId:
    "resident-rust-wasm-plan-through-emission-and-owned-byte-copy",
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
      inputSha256: prepared.inputSha256,
      outputSha256: prepared.outputSha256,
      atomCount: prepared.plan.atoms.length,
      atomKinds: prepared.atomKinds,
      wasmBytes: prepared.expectedBytes.length,
      planning: {
        timing: summarizeSamples(planningTotals),
        rawMeasurements: targetPlanning,
      },
      cpuOracle: {
        timing: summarizeSamples(cpuSamples.get(prepared.name)!),
        rawMilliseconds: cpuSamples.get(prepared.name)!,
      },
      rustWasm: {
        preparation: rustWasmResidents.get(prepared.name)!
          .preparationTimings,
        cold: reportRustWasm(
          rustWasmColdSamples.get(prepared.name)!,
        ),
        resident: reportRustWasm(
          rustWasmResidentSamples.get(prepared.name)!,
        ),
      },
      dense: reportLayout(targetSamples.dense, targetWork.dense!),
      ranked: reportLayout(targetSamples.ranked, targetWork.ranked!),
      rankedToDenseMedianRatio: rankedMedian / denseMedian,
    };
  }),
}));
if (!environmentClear && !allowContended) Deno.exit(2);

type PreparedTarget = {
  readonly name: string;
  readonly flatCore: FlatDucklangCore;
  readonly plan: WasmBinaryPlan;
  readonly atomKinds: {
    readonly byte: number;
    readonly unsigned: number;
    readonly signed32: number;
    readonly signed64: number;
    readonly length: number;
    readonly simdGroupCount: number;
    readonly simdTailCount: number;
    readonly allByteSimdGroupCount: number;
  };
  readonly expectedBytes: Uint8Array;
  readonly inputSha256: string;
  readonly outputSha256: string;
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
  const plan = lowerDucklangCoreToFcgAndWasm(artifact.optimizedCore, {
    emission: "planOnly",
  }).wasmPlan;
  const atomKinds = {
    byte: 0,
    unsigned: 0,
    signed32: 0,
    signed64: 0,
    length: 0,
  };
  for (const atom of plan.atoms) atomKinds[atom.kind] += 1;
  let allByteSimdGroupCount = 0;
  for (let atomIndex = 0; atomIndex + 4 <= plan.atoms.length; atomIndex += 4) {
    if (
      plan.atoms.slice(atomIndex, atomIndex + 4).every((atom) =>
        atom.kind === "byte"
      )
    ) {
      allByteSimdGroupCount += 1;
    }
  }
  return {
    name: target_.name,
    flatCore: artifact.optimizedFlatCore,
    plan,
    atomKinds: {
      ...atomKinds,
      simdGroupCount: Math.floor(plan.atoms.length / 4),
      simdTailCount: plan.atoms.length % 4,
      allByteSimdGroupCount,
    },
    expectedBytes: artifact.wasm,
    inputSha256: await sha256(new TextEncoder().encode(source)),
    outputSha256: await sha256(artifact.wasm),
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

function measureRustWasmCold(
  prepared: PreparedTarget,
  emitter: Awaited<ReturnType<typeof createRustWasmEmitter>>["emitter"],
): { readonly milliseconds: number; readonly emission: RustWasmColdEmission } {
  const start = performance.now();
  const emission = emitter.emit(prepared.plan);
  const milliseconds = performance.now() - start;
  requireExpectedRustWasmBytes(prepared, emission.bytes, "cold");
  return { milliseconds, emission };
}

function measureRustWasmResident(
  prepared: PreparedTarget,
  resident: RustWasmResidentPlan,
): { readonly milliseconds: number; readonly emission: RustWasmEmission } {
  const start = performance.now();
  const emission = resident.emit();
  const milliseconds = performance.now() - start;
  requireExpectedRustWasmBytes(prepared, emission.bytes, "resident");
  return { milliseconds, emission };
}

function requireExpectedRustWasmBytes(
  prepared: PreparedTarget,
  bytes: Uint8Array,
  boundary: "cold" | "resident",
): void {
  if (!equalBytes(bytes, prepared.expectedBytes)) {
    throw new Error(
      `${prepared.name} ${boundary} Rust/Wasm emission disagrees with expected bytes`,
    );
  }
}

function reportRustWasm(
  samples: readonly {
    readonly milliseconds: number;
    readonly emission: RustWasmEmission;
  }[],
) {
  const milliseconds = samples.map((sample) => sample.milliseconds);
  return {
    timing: summarizeSamples(milliseconds),
    rawMilliseconds: milliseconds,
    rawTimings: samples.map((sample) => sample.emission.timings),
    rawPreparationTimings: samples.map((sample) =>
      "preparationTimings" in sample.emission
        ? sample.emission.preparationTimings
        : undefined
    ),
  };
}

function reportLayout(
  samples: readonly Awaited<ReturnType<typeof measureEmission>>[],
  work: Awaited<ReturnType<typeof measureEmission>>,
) {
  const wallMilliseconds = samples.map((sample) => sample.milliseconds);
  return {
    timing: summarizeSamples(wallMilliseconds),
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

function requestedSampleCount(arguments_: readonly string[]): number {
  const sampleArgument = arguments_.find((argument) =>
    argument.startsWith("--samples=")
  );
  if (sampleArgument === undefined) return 20;
  const count = Number.parseInt(sampleArgument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 2 || count % 2 !== 0) {
    throw new TypeError(
      `--samples must be an even integer of at least 2; received ${sampleArgument}`,
    );
  }
  return count;
}

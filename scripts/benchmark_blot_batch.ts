import {
  buildGpupaperBatch,
  type GpupaperBuildOutcome,
} from "../../blot/src/backend/gpupaper.ts";
import { prepareGpupaperHir } from "../../blot/src/backend/compile.ts";
import { refreshLoadedModules } from "../../blot/src/load.ts";
import { validateBlotRuntimeModule } from "../src/blot_runtime_hir.ts";
import { compileBlotRuntimeModulesOnGpu } from "../src/blot_runtime_target.ts";
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
  runtimeIdentity,
  sha256,
} from "./benchmark_environment.ts";
import {
  median,
  summarizePairedSamples,
  summarizeSamples,
} from "./benchmark_statistics.ts";

const samples = requestedSamples(Deno.args);
const allowContended = Deno.args.includes("--allow-contended");
const environmentAtStart = await inspectBenchmarkEnvironment();
if (environmentAtStart.status !== "clear" && !allowContended) {
  console.log(JSON.stringify({
    status: "refused",
    reason: environmentAtStart.status === "contended"
      ? "competing compiler or GPU work is active"
      : "compiler or GPU load inspection failed",
    environment: environmentAtStart,
  }));
  Deno.exit(2);
}

const root = new URL("../../blot/examples/", import.meta.url);
const corpusPaths: string[] = [];
for await (const entry of Deno.readDir(root)) {
  if (entry.isFile && entry.name.endsWith(".blot")) {
    corpusPaths.push(new URL(entry.name, root).pathname);
  }
}
corpusPaths.sort();
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) {
  throw new Error("Blot batch benchmark has no GPU adapter");
}
const warmup = await buildGpupaperBatch(corpusPaths);
requireSuccessfulArtifactSource(warmup, "compiled", "packed warmup");
const paths = warmup.flatMap((outcome) =>
  outcome.status === "built" ? [outcome.path] : []
);
const warmupRejections = warmup.flatMap((outcome) =>
  outcome.status === "failed"
    ? [{ path: outcome.path, cause: String(outcome.cause) }]
    : []
);
if (paths.length === 0) {
  throw new Error(
    `Blot batch benchmark admitted none of ${corpusPaths.length} candidates`,
  );
}

const packedMilliseconds: number[] = [];
const singletonMilliseconds: number[] = [];
let lastPacked: readonly GpupaperBuildOutcome[] = [];
let lastSingleton: readonly GpupaperBuildOutcome[] = [];
for (let sample = 0; sample < samples; sample += 1) {
  const order = sample % 2 === 0
    ? ["packed", "singleton"] as const
    : ["singleton", "packed"] as const;
  for (const mode of order) {
    const started = performance.now();
    if (mode === "packed") {
      lastPacked = await buildGpupaperBatch(paths);
      requireBuilt(lastPacked, `packed sample ${sample}`);
      requireSuccessfulArtifactSource(
        lastPacked,
        "revision-cache",
        `packed sample ${sample}`,
      );
      packedMilliseconds.push(performance.now() - started);
      continue;
    }
    const outcomes: GpupaperBuildOutcome[] = [];
    for (const path of paths) {
      outcomes.push(...await buildGpupaperBatch([path]));
    }
    lastSingleton = outcomes;
    requireBuilt(lastSingleton, `singleton sample ${sample}`);
    requireSuccessfulArtifactSource(
      lastSingleton,
      "revision-cache",
      `singleton sample ${sample}`,
    );
    singletonMilliseconds.push(performance.now() - started);
  }
}
requireEqualArtifacts(lastPacked, lastSingleton);
const fixedStageProfiles = [];
const capacityStageProfiles = [];
const pipelineProfiles = [];
for (let sample = 0; sample < Math.min(samples, 6); sample += 1) {
  const modes = ["fixed", "capacity", "pipeline"] as const;
  const order = modes.map((_, index) =>
    modes[(index + sample) % modes.length]!
  );
  for (const mode of order) {
    if (mode === "pipeline") {
      pipelineProfiles.push(await profilePipelinedTarget(paths, 2));
      continue;
    }
    const profile = await profilePackedTarget(
      paths,
      mode === "capacity" ? paths.length : 16,
    );
    if (mode === "fixed") fixedStageProfiles.push(profile);
    else capacityStageProfiles.push(profile);
  }
}
for (const [sample, capacity] of capacityStageProfiles.entries()) {
  requireEqualProfileArtifacts(
    capacity.artifacts,
    pipelineProfiles[sample]!.artifacts,
    `capacity and depth-two pipeline sample ${sample}`,
  );
}

const environmentAtEnd = await inspectBenchmarkEnvironment();
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";
const validity = environmentClear
  ? { status: "admissible" as const }
  : allowContended
  ? {
    status: "diagnostic" as const,
    reason: "competing compiler or GPU work was present during measurement",
  }
  : {
    status: "refused" as const,
    reason: "competing compiler or GPU work appeared during measurement",
  };
const packedP50 = median(packedMilliseconds);
const singletonP50 = median(singletonMilliseconds);
const built = lastPacked.filter((outcome) => outcome.status === "built");
const corpusInputBytes = await concatenateFiles(corpusPaths);
const admittedInputBytes = await concatenateFiles(paths);
const outputBytes = concatenateBytes(
  built.map((outcome) => outcome.wasm),
);
const hirCacheFootprint = await inspectCachedHirFootprint(paths);
const artifactCacheFootprint = {
  artifacts: built.length,
  wasmBytes: built.reduce(
    (sum, outcome) => sum + outcome.wasm.byteLength,
    0,
  ),
  manifestBytes: built.reduce(
    (sum, outcome) => sum + outcome.manifestBytes.byteLength,
    0,
  ),
  capabilityNameBytes: new TextEncoder().encode(
    JSON.stringify(built.map((outcome) => outcome.capabilities)),
  ).byteLength,
};
console.log(JSON.stringify(
  {
    status: validity.status === "refused" ? "refused" : "completed",
    validity,
    schemaVersion: 6,
    workload: "target-admitted ../blot/examples/*.blot",
    corpusCandidates: corpusPaths.length,
    files: paths.length,
    warmupRejections,
    samples,
    warmups: 1,
    inputSha256: await sha256(corpusInputBytes),
    admittedInputSha256: await sha256(admittedInputBytes),
    outputSha256: await sha256(outputBytes),
    boundary: "separate unchanged-revision rebuild and compiler throughput",
    repositories: {
      gpupaper: await repositoryIdentity(
        new URL("../", import.meta.url).pathname,
      ),
      blot: await repositoryIdentity(
        new URL("../../blot/", import.meta.url).pathname,
      ),
    },
    runtime: runtimeIdentity(),
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
    },
    environmentAtStart,
    environmentAtEnd,
    hirCacheFootprint,
    artifactCacheFootprint: {
      ...artifactCacheFootprint,
      totalLogicalBytes: artifactCacheFootprint.wasmBytes +
        artifactCacheFootprint.manifestBytes +
        artifactCacheFootprint.capabilityNameBytes,
    },
    wasmBytes: artifactCacheFootprint.wasmBytes,
    incrementalRebuild: {
      boundary:
        "unchanged loaded revisions to defensive artifact copies through the public Blot batch API",
      runOrder: Array.from(
        { length: samples },
        (_, sample) =>
          sample % 2 === 0 ? ["packed", "singleton"] : ["singleton", "packed"],
      ).flat(),
      packed: {
        timing: summarizeSamples(packedMilliseconds),
        rawMilliseconds: packedMilliseconds,
        modulesPerSecond: paths.length / (packedP50 / 1_000),
      },
      singleton: {
        timing: summarizeSamples(singletonMilliseconds),
        rawMilliseconds: singletonMilliseconds,
        modulesPerSecond: paths.length / (singletonP50 / 1_000),
      },
      marginalMedianRatio: singletonP50 / packedP50,
      pairedPackedToSingleton: summarizePairedSamples(
        packedMilliseconds,
        singletonMilliseconds,
      ),
    },
    compilerThroughput: {
      boundary:
        "frozen Runtime HIR through validation, Wasm planning, GPU emission, and artifact validation with Blot artifact reuse bypassed",
      stageProfile: {
        samples: fixedStageProfiles.length,
        fixedCount16: summarizeProfiles(fixedStageProfiles),
        capacity: summarizeProfiles(capacityStageProfiles),
        pipelinedDepth2: summarizePipelineProfiles(pipelineProfiles),
        fixedToCapacityP50Ratio: percentile(
          fixedStageProfiles.map((profile) => profile.totalMilliseconds),
          0.5,
        ) / percentile(
          capacityStageProfiles.map((profile) => profile.totalMilliseconds),
          0.5,
        ),
        capacityToPipelineP50Ratio: percentile(
          capacityStageProfiles.map((profile) => profile.totalMilliseconds),
          0.5,
        ) / percentile(
          pipelineProfiles.map((profile) => profile.totalMilliseconds),
          0.5,
        ),
      },
    },
  },
  null,
  2,
));
if (validity.status === "refused") Deno.exit(2);

async function profilePackedTarget(
  paths: readonly string[],
  maximumPhysicalPayloadCount: number | undefined,
) {
  const totalStart = performance.now();
  const refreshStart = performance.now();
  await refreshLoadedModules();
  const refreshModulesMilliseconds = performance.now() - refreshStart;
  const modules = [];
  let prepareHirMilliseconds = 0;
  let validateHirMilliseconds = 0;
  for (const path of paths) {
    const prepareStart = performance.now();
    const hir = await prepareGpupaperHir(path);
    prepareHirMilliseconds += performance.now() - prepareStart;
    const validationStart = performance.now();
    modules.push(validateBlotRuntimeModule(hir));
    validateHirMilliseconds += performance.now() - validationStart;
  }
  const batch = await compileBlotRuntimeModulesOnGpu(modules, {
    maximumPhysicalPayloadCount,
  });
  if (batch.gpuBatch === undefined) {
    throw new Error("non-empty profiled target omitted its GPU batch evidence");
  }
  return {
    totalMilliseconds: performance.now() - totalStart,
    refreshModulesMilliseconds,
    prepareHirMilliseconds,
    validateHirMilliseconds,
    target: batch.timings,
    gpuBatch: batch.gpuBatch,
    artifacts: batch.artifacts.map((artifact) => artifact.wasm),
  };
}

async function profilePipelinedTarget(
  paths: readonly string[],
  depth: number,
) {
  const totalStart = performance.now();
  const refreshStart = performance.now();
  await refreshLoadedModules();
  const refreshModulesMilliseconds = performance.now() - refreshStart;
  const groupSize = Math.ceil(paths.length / depth);
  const pending = [];
  let prepareHirMilliseconds = 0;
  let validateHirMilliseconds = 0;
  for (let start = 0; start < paths.length; start += groupSize) {
    const modules = [];
    for (const path of paths.slice(start, start + groupSize)) {
      const prepareStart = performance.now();
      const hir = await prepareGpupaperHir(path);
      prepareHirMilliseconds += performance.now() - prepareStart;
      const validationStart = performance.now();
      modules.push(validateBlotRuntimeModule(hir));
      validateHirMilliseconds += performance.now() - validationStart;
    }
    pending.push(compileBlotRuntimeModulesOnGpu(modules, {
      maximumPhysicalPayloadCount: modules.length,
    }));
  }
  const batches = await Promise.all(pending);
  const gpuBatches = batches.map((batch, index) => {
    if (batch.gpuBatch !== undefined) return batch.gpuBatch;
    throw new Error(`pipelined target batch ${index} omitted GPU evidence`);
  });
  return {
    totalMilliseconds: performance.now() - totalStart,
    refreshModulesMilliseconds,
    prepareHirMilliseconds,
    validateHirMilliseconds,
    targetWork: {
      planWasmMilliseconds: batches.reduce(
        (sum, batch) => sum + batch.timings.planWasmMilliseconds,
        0,
      ),
      summedGpuBatchSpanMilliseconds: gpuBatches.reduce(
        (sum, batch) => sum + batch.timings.totalMilliseconds,
        0,
      ),
      wasmValidationMilliseconds: batches.reduce(
        (sum, batch) => sum + batch.timings.wasmValidationMilliseconds,
        0,
      ),
      manifestValidationMilliseconds: batches.reduce(
        (sum, batch) => sum + batch.timings.manifestValidationMilliseconds,
        0,
      ),
    },
    physicalBatchCount: gpuBatches.reduce(
      (sum, batch) => sum + batch.physicalPlans.length,
      0,
    ),
    maximumInFlightLeasedBufferBytes: batches.reduce(
      (sum, batch) =>
        sum + batch.gpuEmissions.reduce(
          (batchSum, emission) => batchSum + emission.leasedBufferBytes,
          0,
        ),
      0,
    ),
    artifacts: batches.flatMap((batch) =>
      batch.artifacts.map((artifact) => artifact.wasm)
    ),
  };
}

function requireEqualProfileArtifacts(
  left: readonly Uint8Array[],
  right: readonly Uint8Array[],
  subject: string,
): void {
  if (left.length !== right.length) {
    throw new Error(
      `${subject} returned ${left.length} and ${right.length} artifacts`,
    );
  }
  for (const [index, bytes] of left.entries()) {
    if (byteArraysEqual(bytes, right[index]!)) continue;
    throw new Error(`${subject} differs at artifact ${index}`);
  }
}

function summarizeProfiles(
  profiles: readonly Awaited<ReturnType<typeof profilePackedTarget>>[],
) {
  return {
    stages: {
      refreshModules: summarizeStage(
        profiles.map((profile) => profile.refreshModulesMilliseconds),
      ),
      prepareHir: summarizeStage(
        profiles.map((profile) => profile.prepareHirMilliseconds),
      ),
      validateHir: summarizeStage(
        profiles.map((profile) => profile.validateHirMilliseconds),
      ),
      planWasm: summarizeStage(
        profiles.map((profile) => profile.target.planWasmMilliseconds),
      ),
      emitWasmOnGpu: summarizeStage(
        profiles.map((profile) => profile.target.emitWasmOnGpuMilliseconds),
      ),
      wasmValidation: summarizeStage(
        profiles.map((profile) => profile.target.wasmValidationMilliseconds),
      ),
      manifestValidation: summarizeStage(
        profiles.map((profile) =>
          profile.target.manifestValidationMilliseconds
        ),
      ),
      targetUnaccounted: summarizeStage(
        profiles.map((profile) => profile.target.unaccountedMilliseconds),
      ),
      total: summarizeStage(
        profiles.map((profile) => profile.totalMilliseconds),
      ),
    },
    gpuBatch: profiles.at(-1)!.gpuBatch,
  };
}

function summarizePipelineProfiles(
  profiles: readonly Awaited<ReturnType<typeof profilePipelinedTarget>>[],
) {
  return {
    stages: {
      refreshModules: summarizeStage(
        profiles.map((profile) => profile.refreshModulesMilliseconds),
      ),
      prepareHir: summarizeStage(
        profiles.map((profile) => profile.prepareHirMilliseconds),
      ),
      validateHir: summarizeStage(
        profiles.map((profile) => profile.validateHirMilliseconds),
      ),
      planWasmWork: summarizeStage(
        profiles.map((profile) => profile.targetWork.planWasmMilliseconds),
      ),
      summedGpuBatchSpan: summarizeStage(
        profiles.map((profile) =>
          profile.targetWork.summedGpuBatchSpanMilliseconds
        ),
      ),
      total: summarizeStage(
        profiles.map((profile) => profile.totalMilliseconds),
      ),
    },
    physicalBatchCounts: profiles.map((profile) => profile.physicalBatchCount),
    maximumInFlightLeasedBufferBytes: Math.max(
      ...profiles.map((profile) => profile.maximumInFlightLeasedBufferBytes),
    ),
  };
}

function requireBuilt(
  outcomes: readonly GpupaperBuildOutcome[],
  subject: string,
): void {
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  if (failed.length === 0) return;
  throw new Error(
    `${subject} failed: ${
      failed.map((outcome) => `${outcome.path}: ${String(outcome.cause)}`).join(
        "; ",
      )
    }`,
  );
}

function requireSuccessfulArtifactSource(
  outcomes: readonly GpupaperBuildOutcome[],
  artifactSource: "compiled" | "revision-cache",
  subject: string,
): void {
  const unexpected = outcomes.flatMap((outcome) => {
    if (
      outcome.status !== "built" || outcome.artifactSource === artifactSource
    ) return [];
    return [outcome];
  });
  if (unexpected.length === 0) return;
  throw new Error(
    `${subject} expected successful artifacts from ${artifactSource}; received ${
      unexpected.map((outcome) => `${outcome.path}: ${outcome.artifactSource}`)
        .join("; ")
    }`,
  );
}

function requireEqualArtifacts(
  packed: readonly GpupaperBuildOutcome[],
  singleton: readonly GpupaperBuildOutcome[],
): void {
  if (packed.length !== singleton.length) {
    throw new Error(
      `packed target returned ${packed.length} outcomes; singleton target returned ${singleton.length}`,
    );
  }
  for (const [index, packedOutcome] of packed.entries()) {
    const singletonOutcome = singleton[index];
    if (
      packedOutcome.status !== "built" || singletonOutcome?.status !== "built"
    ) {
      throw new Error(`target artifact ${index} was not built on both paths`);
    }
    if (
      packedOutcome.path !== singletonOutcome.path ||
      !byteArraysEqual(packedOutcome.wasm, singletonOutcome.wasm) ||
      !byteArraysEqual(
        packedOutcome.manifestBytes,
        singletonOutcome.manifestBytes,
      ) ||
      packedOutcome.capabilities.join("\0") !==
        singletonOutcome.capabilities.join("\0")
    ) {
      throw new Error(
        `packed artifact ${index} differs from singleton compilation`,
      );
    }
  }
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function requestedSamples(arguments_: readonly string[]): number {
  const argument = arguments_.find((candidate) =>
    candidate.startsWith("--samples=")
  );
  const value = argument === undefined
    ? 24
    : Number(argument.slice("--samples=".length));
  if (!Number.isSafeInteger(value) || value < 2 || value % 6 !== 0) {
    throw new RangeError(
      `--samples must be a positive multiple of six; received ${value}`,
    );
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = fraction * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function summarizeStage(milliseconds: readonly number[]) {
  return {
    timing: summarizeSamples(milliseconds),
    rawMilliseconds: milliseconds,
  };
}

async function inspectCachedHirFootprint(paths: readonly string[]) {
  let logicalJsonBytes = 0;
  let reachableObjects = 0;
  const encoder = new TextEncoder();
  for (const path of paths) {
    const seen = new WeakSet<object>();
    const encoded = JSON.stringify(
      await prepareGpupaperHir(path),
      (_key, value) => {
        if (typeof value === "bigint") return `${value}n`;
        if (value !== null && typeof value === "object" && !seen.has(value)) {
          seen.add(value);
          reachableObjects += 1;
        }
        return value;
      },
    );
    if (encoded === undefined) {
      throw new TypeError(`gpupaper HIR for ${path} is not JSON-encodable`);
    }
    logicalJsonBytes += encoder.encode(encoded).byteLength;
  }
  return { logicalJsonBytes, reachableObjects };
}

async function concatenateFiles(paths: readonly string[]): Promise<Uint8Array> {
  const encodedPaths = paths.map((path) => new TextEncoder().encode(path));
  const contents = await Promise.all(paths.map((path) => Deno.readFile(path)));
  return concatenateBytes(
    encodedPaths.flatMap((path, index) => [path, contents[index]!]),
  );
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(
    parts.reduce((length, part) => length + 4 + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    new DataView(combined.buffer).setUint32(offset, part.byteLength, true);
    offset += 4;
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

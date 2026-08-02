import {
  BlotCompilerSession,
  prepareGpupaperHir,
} from "../../blot/src/backend/compile.ts";
import { refreshLoadedModules } from "../../blot/src/load.ts";
import { compileBlotRuntimeModule } from "../src/blot_runtime_target.ts";
import { validateBlotRuntimeModule } from "../src/blot_runtime_hir.ts";
import { emitWasmPlanOnGpu, emitWasmPlansOnGpu } from "../src/gpu_wasm.ts";
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

const sampleCount = requestedSampleCount(Deno.args);
const allowContended = Deno.args.includes("--allow-contended");
const file = requestedFile(Deno.args);
const source = new TextEncoder().encode(await Deno.readTextFile(file));
const sourceBytes = source.byteLength;
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
const session = await BlotCompilerSession.create();
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) {
  throw new Error("Blot target benchmark has no GPU adapter");
}

try {
  await emitGpupaper(file);
  await session.build(file);

  const gpupaperSamples = [];
  const gpufuckMilliseconds: number[] = [];
  let gpufuckWasm: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let gpufuckManifest: unknown;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const order = sample % 2 === 0
      ? ["gpupaper", "gpufuck"] as const
      : ["gpufuck", "gpupaper"] as const;
    for (const compiler of order) {
      if (compiler === "gpupaper") {
        gpupaperSamples.push(await emitGpupaper(file));
        continue;
      }
      const started = performance.now();
      const artifact = await session.build(file);
      gpufuckMilliseconds.push(performance.now() - started);
      gpufuckWasm = artifact.wasm;
      gpufuckManifest = artifact.manifest;
    }
  }

  const lastGpupaper = gpupaperSamples.at(-1);
  if (lastGpupaper === undefined) {
    throw new Error("gpupaper produced no samples");
  }
  if (
    JSON.stringify(lastGpupaper.manifest) !== JSON.stringify(gpufuckManifest)
  ) {
    throw new Error("gpupaper and gpufuck ABI manifests differ");
  }
  if (!WebAssembly.validate(Uint8Array.from(lastGpupaper.wasm))) {
    throw new Error("gpupaper emitted invalid Wasm");
  }
  if (!WebAssembly.validate(Uint8Array.from(gpufuckWasm))) {
    throw new Error("gpufuck emitted invalid Wasm");
  }
  await requireEquivalentDefault(lastGpupaper.wasm, gpufuckWasm);

  const gpupaperMilliseconds = gpupaperSamples.map((sample) =>
    sample.totalMilliseconds
  );
  const gpupaperMedian = median(gpupaperMilliseconds);
  const gpufuckMedian = median(gpufuckMilliseconds);
  const batchMeasurements = await measureGpuEmissionBatches(
    lastGpupaper.wasmPlan,
    sampleCount,
  );
  const rebuildMeasurements = await measureLiteralRebuilds(
    session,
    await Deno.readTextFile(file),
    sampleCount,
  );
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
  console.log(JSON.stringify(
    {
      status: validity.status === "refused" ? "refused" : "completed",
      validity,
      schemaVersion: 6,
      workload: file,
      sourceBytes,
      inputSha256: await sha256(source),
      samples: sampleCount,
      warmups: 1,
      boundary:
        "warm process and Blot preparation cache, Blot source path to ABI-equivalent Wasm",
      runOrder: Array.from(
        { length: sampleCount },
        (_, sample) =>
          sample % 2 === 0 ? ["gpupaper", "gpufuck"] : ["gpufuck", "gpupaper"],
      )
        .flat(),
      semanticEvidence:
        "ABI manifests equal, both modules validate, and blot:default observations agree when exported",
      runtime: runtimeIdentity(),
      repositories: {
        gpupaper: await repositoryIdentity(
          new URL("../", import.meta.url).pathname,
        ),
        blot: await repositoryIdentity(
          new URL("../../blot/", import.meta.url).pathname,
        ),
      },
      environmentAtStart,
      environmentAtEnd,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      gpupaper: {
        timing: summarizeSamples(gpupaperMilliseconds),
        rawMilliseconds: gpupaperMilliseconds,
        stages: {
          produceHir: summarizeStage(
            gpupaperSamples.map((sample) => sample.produceHirMilliseconds),
          ),
          validateHir: summarizeStage(
            gpupaperSamples.map((sample) => sample.validateHirMilliseconds),
          ),
          planWasm: summarizeStage(
            gpupaperSamples.map((sample) => sample.planWasmMilliseconds),
          ),
          emitWasmOnGpu: summarizeStage(
            gpupaperSamples.map((sample) => sample.emitWasmOnGpuMilliseconds),
          ),
        },
        wasmBytes: lastGpupaper.wasm.byteLength,
        wasmSha256: await sha256(lastGpupaper.wasm),
        hirWork: lastGpupaper.hirWork,
        logicalMemory: lastGpupaper.logicalMemory,
        physicalWork: lastGpupaper.physicalWork,
      },
      gpufuck: {
        timing: summarizeSamples(gpufuckMilliseconds),
        rawMilliseconds: gpufuckMilliseconds,
        wasmBytes: gpufuckWasm.byteLength,
        wasmSha256: await sha256(gpufuckWasm),
      },
      pairedGpupaperToGpufuck: summarizePairedSamples(
        gpupaperMilliseconds,
        gpufuckMilliseconds,
      ),
      marginalMedianRatio: gpupaperMedian / gpufuckMedian,
      gpuEmissionBatches: batchMeasurements,
      literalRebuilds: rebuildMeasurements,
    },
    null,
    2,
  ));
  if (validity.status === "refused") Deno.exit(2);
} finally {
  session.destroy();
}

async function emitGpupaper(file: string) {
  const started = performance.now();
  const hir = await prepareGpupaperHir(file);
  const produced = performance.now();
  const validatedModule = validateBlotRuntimeModule(hir);
  const validationFinished = performance.now();
  const artifact = compileBlotRuntimeModule(validatedModule, {
    emission: "planOnly",
  });
  const planned = performance.now();
  const gpuEmission = await emitWasmPlanOnGpu(artifact.wasmPlan);
  const emitted = performance.now();
  if (gpuEmission.status === "unavailable") {
    throw new Error(`gpupaper GPU emission unavailable: ${gpuEmission.reason}`);
  }
  return {
    produceHirMilliseconds: produced - started,
    validateHirMilliseconds: validationFinished - produced,
    planWasmMilliseconds: planned - validationFinished,
    emitWasmOnGpuMilliseconds: emitted - planned,
    totalMilliseconds: emitted - started,
    wasm: gpuEmission.bytes,
    wasmPlan: artifact.wasmPlan,
    manifest: artifact.manifest,
    hirWork: {
      types: hir.types.length,
      signatures: hir.signatures.length,
      functions: hir.functions.length,
      blocks: hir.functions.reduce(
        (count, function_) => count + function_.blocks.length,
        0,
      ),
      operations: hir.functions.reduce(
        (count, function_) =>
          count + function_.blocks.reduce(
            (blockCount, block) => blockCount + block.operations.length,
            0,
          ),
        0,
      ),
      capabilities: hir.capabilities.length,
      exports: hir.exports.length,
    },
    logicalMemory: {
      runtimeHirDiagnosticJsonBytes: new TextEncoder().encode(
        JSON.stringify(
          hir,
          (_key, value) => typeof value === "bigint" ? `${value}n` : value,
        ),
      ).byteLength,
      manifestBytes: artifact.manifestBytes.byteLength,
      wasmBytes: gpuEmission.bytes.byteLength,
    },
    physicalWork: {
      wasmPlanAtoms: artifact.wasmPlan.atoms.length,
      atomInputBytes: gpuEmission.atomInputBytes,
      outputBufferBytes: gpuEmission.outputBufferBytes,
      resolvedOffsetBytes: gpuEmission.resolvedOffsetBytes,
      lowWordBytes: gpuEmission.lowWordBytes,
      byteRankBytes: gpuEmission.byteRankBytes,
      signed64HighWordBytes: gpuEmission.signed64HighWordBytes,
      dispatchedInvocations: gpuEmission.dispatchedInvocationCount,
    },
  };
}

async function measureGpuEmissionBatches(
  plan: ReturnType<typeof compileBlotRuntimeModule>["wasmPlan"],
  samples: number,
) {
  const measurements = [];
  for (const batchSize of [1, 4, 16, 64]) {
    const queuedMilliseconds: number[] = [];
    const packedMilliseconds: number[] = [];
    const capacityPackedMilliseconds: number[] = [];
    let queuedSubmissionBatchSize = 0;
    let packedSubmissionBatchSize = 0;
    let capacityPackedSubmissionBatchSize = 0;
    let physicalPackedBatchCount = 0;
    let capacityPhysicalBatchCount = 0;
    const plans = Array.from({ length: batchSize }, () => plan);
    for (let sample = 0; sample < Math.min(samples, 5); sample += 1) {
      const modes = ["queued", "packed", "capacity-packed"] as const;
      const order = modes.map((_, index) =>
        modes[(index + sample) % modes.length]!
      );
      for (const mode of order) {
        const started = performance.now();
        if (mode === "queued") {
          const batch = await Promise.all(
            plans.map(() =>
              emitWasmPlanOnGpu(plan, { scheduling: "throughput" })
            ),
          );
          queuedMilliseconds.push(performance.now() - started);
          for (const result of batch) {
            if (result.status === "unavailable") {
              throw new Error(
                `queued GPU emission unavailable: ${result.reason}`,
              );
            }
            queuedSubmissionBatchSize = Math.max(
              queuedSubmissionBatchSize,
              result.submissionBatchSize,
            );
          }
          continue;
        }
        const packed = await emitWasmPlansOnGpu(plans, {
          scheduling: "throughput",
          maximumPhysicalPayloadCount: mode === "capacity-packed"
            ? batchSize
            : 16,
        });
        const elapsed = performance.now() - started;
        if (mode === "packed") {
          packedMilliseconds.push(elapsed);
        } else {
          capacityPackedMilliseconds.push(elapsed);
        }
        if (packed.status === "unavailable") {
          throw new Error(
            `packed GPU emission unavailable: ${packed.reason}`,
          );
        }
        if (mode === "packed") {
          physicalPackedBatchCount = packed.physicalEmissions.length;
          packedSubmissionBatchSize = Math.max(
            packedSubmissionBatchSize,
            ...packed.physicalEmissions.map((emission) =>
              emission.submissionBatchSize
            ),
          );
        } else {
          capacityPhysicalBatchCount = packed.physicalEmissions.length;
          capacityPackedSubmissionBatchSize = Math.max(
            capacityPackedSubmissionBatchSize,
            ...packed.physicalEmissions.map((emission) =>
              emission.submissionBatchSize
            ),
          );
        }
        for (const bytes of packed.bytes) {
          if (!WebAssembly.validate(Uint8Array.from(bytes))) {
            throw new Error("packed GPU emission produced invalid Wasm");
          }
        }
      }
    }
    const queuedMedian = percentile(queuedMilliseconds, 0.5);
    const packedMedian = percentile(packedMilliseconds, 0.5);
    const capacityPackedMedian = percentile(
      capacityPackedMilliseconds,
      0.5,
    );
    measurements.push({
      batchSize,
      queued: {
        submissionBatchSize: queuedSubmissionBatchSize,
        timing: summarizeSamples(queuedMilliseconds),
        modulesPerSecond: batchSize / (queuedMedian / 1_000),
        rawMilliseconds: queuedMilliseconds,
      },
      packed: {
        physicalBatchCount: physicalPackedBatchCount,
        submissionBatchSize: packedSubmissionBatchSize,
        timing: summarizeSamples(packedMilliseconds),
        modulesPerSecond: batchSize / (packedMedian / 1_000),
        rawMilliseconds: packedMilliseconds,
      },
      capacityPacked: {
        maximumPhysicalPayloadCount: batchSize,
        physicalBatchCount: capacityPhysicalBatchCount,
        submissionBatchSize: capacityPackedSubmissionBatchSize,
        timing: summarizeSamples(capacityPackedMilliseconds),
        modulesPerSecond: batchSize / (capacityPackedMedian / 1_000),
        rawMilliseconds: capacityPackedMilliseconds,
      },
      queuedToPackedP50Ratio: queuedMedian / packedMedian,
      fixedToCapacityPackedP50Ratio: packedMedian / capacityPackedMedian,
    });
  }
  return measurements;
}

async function measureLiteralRebuilds(
  session: BlotCompilerSession,
  source: string,
  samples: number,
) {
  const originalLiteral = "return 42;";
  if (!source.includes(originalLiteral)) {
    return {
      status: "not-applicable" as const,
      reason: `workload does not contain ${JSON.stringify(originalLiteral)}`,
    };
  }
  const directory = await Deno.makeTempDir();
  const gpupaperPath = `${directory}/gpupaper.blot`;
  const gpufuckPath = `${directory}/gpufuck.blot`;
  await Deno.writeTextFile(gpupaperPath, source);
  await Deno.writeTextFile(gpufuckPath, source);
  try {
    await emitGpupaper(gpupaperPath);
    await session.build(gpufuckPath);
    const measuredSamples = Math.min(samples, 4);
    const gpupaperMilliseconds: number[] = [];
    const gpupaperInvalidationMilliseconds: number[] = [];
    const gpufuckMilliseconds: number[] = [];
    for (let sample = 0; sample < measuredSamples; sample += 1) {
      const value = sample % 2 === 0 ? 43 : 44;
      const edited = source.replace(originalLiteral, `return ${value};`);
      const order = sample % 2 === 0
        ? ["gpupaper", "gpufuck"] as const
        : ["gpufuck", "gpupaper"] as const;
      await Deno.writeTextFile(gpupaperPath, edited);
      await Deno.writeTextFile(gpufuckPath, edited);
      for (const compiler of order) {
        if (compiler === "gpupaper") {
          const started = performance.now();
          await refreshLoadedModules();
          const invalidated = performance.now();
          const artifact = await emitGpupaper(gpupaperPath);
          gpupaperMilliseconds.push(performance.now() - started);
          gpupaperInvalidationMilliseconds.push(invalidated - started);
          await requireRebuiltValue(artifact.wasm, BigInt(value));
          continue;
        }
        const started = performance.now();
        const artifact = await session.build(gpufuckPath);
        gpufuckMilliseconds.push(performance.now() - started);
        await requireRebuiltValue(artifact.wasm, BigInt(value));
      }
    }
    return {
      status: "completed" as const,
      samples: measuredSamples,
      edit: "replace the top-level integer literal with alternating 43 and 44",
      gpupaper: {
        timing: summarizeSamples(gpupaperMilliseconds),
        rawMilliseconds: gpupaperMilliseconds,
        invalidation: summarizeStage(gpupaperInvalidationMilliseconds),
      },
      gpufuck: {
        timing: summarizeSamples(gpufuckMilliseconds),
        rawMilliseconds: gpufuckMilliseconds,
      },
      pairedGpupaperToGpufuck: summarizePairedSamples(
        gpupaperMilliseconds,
        gpufuckMilliseconds,
      ),
    };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function requireRebuiltValue(
  wasm: Uint8Array<ArrayBufferLike>,
  expected: bigint,
): Promise<void> {
  const instance = await WebAssembly.instantiate(
    Uint8Array.from(wasm),
    {},
  );
  const exported = instance.instance.exports["blot:default"];
  if (!(exported instanceof Function)) {
    throw new Error("rebuilt Wasm omitted blot:default");
  }
  const actual = exported();
  if (actual !== expected) {
    throw new Error(
      `rebuilt blot:default returned ${String(actual)}; expected ${expected}`,
    );
  }
}

async function requireEquivalentDefault(
  gpupaperWasm: Uint8Array,
  gpufuckWasm: Uint8Array,
): Promise<void> {
  const [gpupaperModule, gpufuckModule] = await Promise.all([
    WebAssembly.compile(Uint8Array.from(gpupaperWasm)),
    WebAssembly.compile(Uint8Array.from(gpufuckWasm)),
  ]);
  if (
    WebAssembly.Module.imports(gpupaperModule).length > 0 ||
    WebAssembly.Module.imports(gpufuckModule).length > 0
  ) return;
  const [gpupaper, gpufuck] = await Promise.all([
    WebAssembly.instantiate(gpupaperModule, {}),
    WebAssembly.instantiate(gpufuckModule, {}),
  ]);
  const gpupaperDefault = gpupaper.exports["blot:default"];
  const gpufuckDefault = gpufuck.exports["blot:default"];
  if (!(gpupaperDefault instanceof Function)) return;
  if (!(gpufuckDefault instanceof Function)) {
    throw new Error("gpufuck omitted blot:default exported by gpupaper");
  }
  const gpupaperResult = gpupaperDefault();
  const gpufuckResult = gpufuckDefault();
  if (Object.is(gpupaperResult, gpufuckResult)) return;
  throw new Error(
    `blot:default observations differ: gpupaper ${
      String(gpupaperResult)
    }, gpufuck ${String(gpufuckResult)}`,
  );
}

function summarizeStage(milliseconds: readonly number[]) {
  return {
    timing: summarizeSamples(milliseconds),
    rawMilliseconds: milliseconds,
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const rank = quantile * (ordered.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return ordered[lower]!;
  const weight = rank - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const argument = arguments_.find((candidate) =>
    candidate.startsWith("--samples=")
  );
  if (argument === undefined) return 20;
  const count = Number.parseInt(argument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 2 || count % 2 !== 0) {
    throw new TypeError(
      `samples must be an even integer of at least 2; received ${argument}`,
    );
  }
  return count;
}

function requestedFile(arguments_: readonly string[]): string {
  const argument = arguments_.find((candidate) =>
    candidate.startsWith("--file=")
  );
  if (argument !== undefined) return argument.slice("--file=".length);
  return new URL("../../blot/examples/minimal.blot", import.meta.url).pathname;
}

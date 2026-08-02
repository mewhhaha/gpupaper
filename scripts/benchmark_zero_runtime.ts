import {
  compileZeroSource,
  type ZeroCompilation,
  type ZeroCompilationTimings,
} from "../examples/zero/compiler.ts";
import {
  type ZeroWorkload,
  zeroWorkloads,
} from "../examples/zero/workloads.ts";
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
  runtimeIdentity,
  sha256,
} from "./benchmark_environment.ts";
import {
  summarizePairedSamples,
  summarizeSamples,
} from "./benchmark_statistics.ts";
import { measureCoreStructure } from "./core_structure.ts";

type OwnedBytes = Uint8Array<ArrayBuffer>;
type LoadedWorkload = {
  readonly definition: ZeroWorkload;
  readonly zeroSource: string;
  readonly rustSource: string;
};
type WorkloadMeasurements = {
  readonly loaded: LoadedWorkload;
  readonly coldZero: ZeroCompilation;
  zeroCompilation: ZeroCompilation;
  rustWasm: OwnedBytes;
  readonly zeroCompilationSamples: ZeroCompilationTimings[];
  readonly rustCompilationSamples: number[];
};

const sampleCount = requestedPositiveInteger(Deno.args, "samples", 30);
const rounds = requestedPositiveInteger(Deno.args, "rounds", 100_000);
const minimumRuntimeBatchMilliseconds = 5;
const maximumRuntimeRepetitions = 131_072;
const selectedWorkload = requestedString(Deno.args, "workload");
const allowContended = Deno.args.includes("--allow-contended");
const gpupaperDirectory = new URL("../", import.meta.url).pathname;
const textEncoder = new TextEncoder();
const definitions = selectedWorkload === undefined
  ? zeroWorkloads
  : zeroWorkloads.filter((workload) => workload.name === selectedWorkload);
if (definitions.length === 0) {
  throw new TypeError(
    `unknown Zero workload ${selectedWorkload}; expected one of ${
      zeroWorkloads.map((workload) => workload.name).join(", ")
    }`,
  );
}
const loadedWorkloads = await Promise.all(definitions.map(loadWorkload));

const environmentAtStart = await inspectBenchmarkEnvironment({
  gpuWork: "ignore",
});
if (environmentAtStart.status !== "clear" && !allowContended) {
  console.log(JSON.stringify({
    status: "refused",
    reason: "competing compiler work is active or inspection failed",
    environment: environmentAtStart,
  }));
  Deno.exit(2);
}

const temporaryDirectory = await Deno.makeTempDir({ prefix: "gpupaper-zero-" });
try {
  const measurements = await initializeMeasurements(
    temporaryDirectory,
    loadedWorkloads,
  );
  await sampleCompilation(temporaryDirectory, measurements, sampleCount);
  const reports = [];
  for (const measurement of measurements) {
    reports.push(await measureWorkload(measurement, sampleCount, rounds));
  }

  const environmentAtEnd = await inspectBenchmarkEnvironment({
    gpuWork: "ignore",
  });
  const environmentClear = environmentAtStart.status === "clear" &&
    environmentAtEnd.status === "clear";
  const validity = environmentClear
    ? { status: "admissible" as const }
    : allowContended
    ? {
      status: "diagnostic" as const,
      reason: "competing compiler work was present during measurement",
    }
    : {
      status: "refused" as const,
      reason: "competing compiler work appeared during measurement",
    };

  console.log(JSON.stringify(
    {
      status: validity.status === "refused" ? "refused" : "completed",
      validity,
      schemaVersion: 3,
      benchmark: "zero-complexity-ladder-versus-rust",
      runtime: runtimeIdentity(),
      repositories: { gpupaper: await repositoryIdentity(gpupaperDirectory) },
      environmentAtStart,
      environmentAtEnd,
      sampleCount,
      roundsPerInvocation: rounds,
      workloads: reports,
    },
    null,
    2,
  ));
  if (validity.status === "refused") Deno.exit(2);
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

async function loadWorkload(definition: ZeroWorkload): Promise<LoadedWorkload> {
  return {
    definition,
    zeroSource: await Deno.readTextFile(definition.zeroSourceUrl),
    rustSource: await Deno.readTextFile(definition.rustSourceUrl),
  };
}

async function initializeMeasurements(
  temporaryDirectory: string,
  workloads: readonly LoadedWorkload[],
): Promise<WorkloadMeasurements[]> {
  const measurements: WorkloadMeasurements[] = [];
  for (const loaded of workloads) {
    const coldZero = await compileZeroSource(
      loaded.definition.zeroSourceUrl.pathname,
      loaded.zeroSource,
    );
    const rustWasm = await compileRustBaseline(
      temporaryDirectory,
      loaded.definition,
    );
    measurements.push({
      loaded,
      coldZero,
      zeroCompilation: coldZero,
      rustWasm,
      zeroCompilationSamples: [],
      rustCompilationSamples: [],
    });
  }
  return measurements;
}

async function sampleCompilation(
  temporaryDirectory: string,
  measurements: WorkloadMeasurements[],
  samples: number,
): Promise<void> {
  for (let sample = 0; sample < samples; sample += 1) {
    const ordered = sample % 2 === 0 ? measurements : measurements.toReversed();
    for (const measurement of ordered) {
      if (sample % 2 === 0) {
        await measureZeroCompilation(measurement);
        await measureRustCompilation(temporaryDirectory, measurement);
      } else {
        await measureRustCompilation(temporaryDirectory, measurement);
        await measureZeroCompilation(measurement);
      }
    }
  }
}

async function measureZeroCompilation(
  measurement: WorkloadMeasurements,
): Promise<void> {
  const { definition, zeroSource } = measurement.loaded;
  measurement.zeroCompilation = await compileZeroSource(
    definition.zeroSourceUrl.pathname,
    zeroSource,
  );
  measurement.zeroCompilationSamples.push(measurement.zeroCompilation.timings);
}

async function measureRustCompilation(
  temporaryDirectory: string,
  measurement: WorkloadMeasurements,
): Promise<void> {
  const start = performance.now();
  measurement.rustWasm = await compileRustBaseline(
    temporaryDirectory,
    measurement.loaded.definition,
  );
  measurement.rustCompilationSamples.push(performance.now() - start);
}

async function compileRustBaseline(
  temporaryDirectory: string,
  workload: ZeroWorkload,
): Promise<OwnedBytes> {
  const outputPath = `${temporaryDirectory}/${workload.name}.wasm`;
  const output = await new Deno.Command("rustc", {
    args: [
      workload.rustSourceUrl.pathname,
      "--target",
      "wasm32-unknown-unknown",
      "--crate-type=cdylib",
      "--edition=2024",
      "-C",
      "opt-level=3",
      "-C",
      "codegen-units=1",
      "-C",
      "panic=abort",
      "-C",
      "strip=symbols",
      "-o",
      outputPath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `rustc failed for ${workload.rustSourceUrl.pathname}: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return Uint8Array.from(await Deno.readFile(outputPath));
}

async function measureWorkload(
  measurement: WorkloadMeasurements,
  samples: number,
  roundsPerInvocation: number,
): Promise<Record<string, unknown>> {
  const { definition, zeroSource, rustSource } = measurement.loaded;
  const zeroBytes = Uint8Array.from(measurement.zeroCompilation.wasm);
  requireEquivalentResults(definition, zeroBytes, measurement.rustWasm);
  const moduleMeasurements = measureModuleBoundaries(
    zeroBytes,
    measurement.rustWasm,
    samples,
  );
  const zeroRun = exportedRun(
    new WebAssembly.Instance(new WebAssembly.Module(zeroBytes.buffer)),
    "Zero",
  );
  const rustRun = exportedRun(
    new WebAssembly.Instance(
      new WebAssembly.Module(measurement.rustWasm.buffer),
    ),
    "Rust",
  );
  warmRuntime(zeroRun);
  warmRuntime(rustRun);
  const runtimeMeasurements = measureRuntime(
    definition,
    zeroRun,
    rustRun,
    roundsPerInvocation,
    samples,
  );
  const structure = measureCoreStructure(measurement.zeroCompilation.core);

  return {
    name: definition.name,
    challenge: definition.challenge,
    semanticModel: "wrapping-i32-bounded-fold",
    structure: {
      zeroSourceBytes: textEncoder.encode(zeroSource).byteLength,
      rustSourceBytes: textEncoder.encode(rustSource).byteLength,
      ...structure,
      wasmPlanAtoms: measurement.zeroCompilation.wasmPlan.atoms.length,
    },
    sourceHashes: {
      zero: await sha256(textEncoder.encode(zeroSource)),
      rust: await sha256(textEncoder.encode(rustSource)),
    },
    output: {
      zeroWasmBytes: zeroBytes.byteLength,
      rustWasmBytes: measurement.rustWasm.byteLength,
      zeroWasmSha256: await sha256(zeroBytes),
      rustWasmSha256: await sha256(measurement.rustWasm),
    },
    compilationMilliseconds: {
      boundariesComparable: false,
      reason:
        "Zero is an initialized in-process frontend and emitter; Rust is a fresh rustc process",
      zeroCold: measurement.coldZero.timings,
      zeroWarm: summarizeZeroCompilation(measurement.zeroCompilationSamples),
      rustcProcess: summarizeSamples(measurement.rustCompilationSamples),
      rustcProcessRaw: measurement.rustCompilationSamples,
    },
    moduleConstructionMilliseconds: moduleMeasurements.construction,
    instantiationMilliseconds: moduleMeasurements.instantiation,
    runtimeNanosecondsPerOuterRound: runtimeMeasurements,
  };
}

function requireEquivalentResults(
  workload: ZeroWorkload,
  zeroWasm: OwnedBytes,
  rustWasm: OwnedBytes,
): void {
  const zero = exportedRun(
    new WebAssembly.Instance(new WebAssembly.Module(zeroWasm.buffer)),
    "Zero",
  );
  const rust = exportedRun(
    new WebAssembly.Instance(new WebAssembly.Module(rustWasm.buffer)),
    "Rust",
  );
  for (const [seed, rounds] of probes()) {
    const expected = workload.reference(seed, rounds);
    const zeroResult = zero(seed, rounds);
    const rustResult = rust(seed, rounds);
    if (zeroResult !== expected || rustResult !== expected) {
      throw new Error(
        `${workload.name} disagreement for seed ${seed}, rounds ${rounds}: Zero ${zeroResult}, Rust ${rustResult}, reference ${expected}`,
      );
    }
  }
}

function probes(): readonly (readonly [number, number])[] {
  let state = 0x6d2b79f5;
  const values: [number, number][] = [
    [0, -1],
    [0, 0],
    [1, 1],
    [-1, 2],
    [2_147_483_647, 31],
    [-2_147_483_648, 32],
  ];
  for (let probe = 0; probe < 64; probe += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    values.push([state | 0, probe * 17]);
  }
  return values;
}

function measureRuntime(
  workload: ZeroWorkload,
  zeroRun: (seed: number, rounds: number) => number,
  rustRun: (seed: number, rounds: number) => number,
  roundsPerInvocation: number,
  samples: number,
): Record<string, unknown> {
  const seeds = [
    0,
    1,
    -1,
    17,
    -31,
    0x12345678,
    2_147_483_647,
    -2_147_483_648,
  ] as const;
  const expectedChecksum = seeds.reduce<number>(
    (sum, seed) => sum + workload.reference(seed, roundsPerInvocation),
    0,
  );
  const zeroSamples: number[] = [];
  const rustSamples: number[] = [];
  const zeroCalibration = calibrateRuntimeRepetitions(
    zeroRun,
    seeds,
    roundsPerInvocation,
    expectedChecksum,
  );
  const rustCalibration = calibrateRuntimeRepetitions(
    rustRun,
    seeds,
    roundsPerInvocation,
    expectedChecksum,
  );
  const zeroRepetitions = zeroCalibration.repetitions;
  const rustRepetitions = rustCalibration.repetitions;
  for (let sample = 0; sample < samples; sample += 1) {
    const ordered = sample % 2 === 0
      ? [[zeroRun, zeroSamples, zeroRepetitions], [
        rustRun,
        rustSamples,
        rustRepetitions,
      ]] as const
      : [[rustRun, rustSamples, rustRepetitions], [
        zeroRun,
        zeroSamples,
        zeroRepetitions,
      ]] as const;
    for (const [run, measurements, repetitions] of ordered) {
      measurements.push(
        measureRuntimeSample(
          run,
          seeds,
          roundsPerInvocation,
          repetitions,
          expectedChecksum,
        ),
      );
    }
  }
  return {
    repetitions: { zero: zeroRepetitions, rust: rustRepetitions },
    calibration: {
      targetMilliseconds: minimumRuntimeBatchMilliseconds,
      maximumRepetitions: maximumRuntimeRepetitions,
      zero: zeroCalibration,
      rust: rustCalibration,
    },
    invocationsPerSample: {
      zero: seeds.length * zeroRepetitions,
      rust: seeds.length * rustRepetitions,
    },
    outerRoundsPerSample: {
      zero: roundsPerInvocation * seeds.length * zeroRepetitions,
      rust: roundsPerInvocation * seeds.length * rustRepetitions,
    },
    zero: summarizeSamples(zeroSamples),
    rust: summarizeSamples(rustSamples),
    pair: summarizePairedSamples(zeroSamples, rustSamples),
    zeroRaw: zeroSamples,
    rustRaw: rustSamples,
  };
}

function measureRuntimeSample(
  run: (seed: number, rounds: number) => number,
  seeds: readonly number[],
  rounds: number,
  repetitions: number,
  expectedChecksum: number,
): number {
  const elapsed = measureRuntimeBatch(
    run,
    seeds,
    rounds,
    repetitions,
    expectedChecksum,
  );
  return elapsed * 1_000_000 / (rounds * seeds.length * repetitions);
}

function calibrateRuntimeRepetitions(
  run: (seed: number, rounds: number) => number,
  seeds: readonly number[],
  rounds: number,
  expectedChecksum: number,
): {
  readonly repetitions: number;
  readonly elapsedMilliseconds: number;
  readonly targetReached: boolean;
} {
  for (
    let repetitions = 1;
    repetitions <= maximumRuntimeRepetitions;
    repetitions *= 2
  ) {
    const elapsed = measureRuntimeBatch(
      run,
      seeds,
      rounds,
      repetitions,
      expectedChecksum,
    );
    if (
      elapsed >= minimumRuntimeBatchMilliseconds ||
      repetitions === maximumRuntimeRepetitions
    ) {
      return {
        repetitions,
        elapsedMilliseconds: elapsed,
        targetReached: elapsed >= minimumRuntimeBatchMilliseconds,
      };
    }
  }
  throw new Error("runtime calibration exceeded its repetition bound");
}

function measureRuntimeBatch(
  run: (seed: number, rounds: number) => number,
  seeds: readonly number[],
  rounds: number,
  repetitions: number,
  expectedChecksum: number,
): number {
  let checksum = 0;
  const start = performance.now();
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const seed of seeds) checksum += run(seed, rounds);
  }
  const elapsed = performance.now() - start;
  const repeatedChecksum = expectedChecksum * repetitions;
  if (checksum !== repeatedChecksum) {
    throw new Error(
      `runtime batch produced checksum ${checksum}; expected ${repeatedChecksum}`,
    );
  }
  return elapsed;
}

function measureModuleBoundaries(
  zeroWasm: OwnedBytes,
  rustWasm: OwnedBytes,
  samples: number,
): {
  readonly construction: Record<string, unknown>;
  readonly instantiation: Record<string, unknown>;
} {
  const zeroConstruction: number[] = [];
  const rustConstruction: number[] = [];
  const zeroInstantiation: number[] = [];
  const rustInstantiation: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const ordered = sample % 2 === 0
      ? [[zeroWasm, zeroConstruction, zeroInstantiation], [
        rustWasm,
        rustConstruction,
        rustInstantiation,
      ]] as const
      : [[rustWasm, rustConstruction, rustInstantiation], [
        zeroWasm,
        zeroConstruction,
        zeroInstantiation,
      ]] as const;
    for (const [wasm, construction, instantiation] of ordered) {
      const constructionStart = performance.now();
      const module = new WebAssembly.Module(wasm.buffer);
      construction.push(performance.now() - constructionStart);
      const instantiationStart = performance.now();
      new WebAssembly.Instance(module);
      instantiation.push(performance.now() - instantiationStart);
    }
  }
  return {
    construction: pairedMeasurement(zeroConstruction, rustConstruction),
    instantiation: pairedMeasurement(zeroInstantiation, rustInstantiation),
  };
}

function pairedMeasurement(
  zero: readonly number[],
  rust: readonly number[],
): Record<string, unknown> {
  return {
    zero: summarizeSamples(zero),
    rust: summarizeSamples(rust),
    pair: summarizePairedSamples(zero, rust),
    zeroRaw: zero,
    rustRaw: rust,
  };
}

function warmRuntime(run: (seed: number, rounds: number) => number): void {
  let checksum = 0;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    checksum += run(iteration, 10_000);
  }
  if (!Number.isFinite(checksum)) {
    throw new Error(`runtime warmup produced invalid checksum ${checksum}`);
  }
}

function exportedRun(
  instance: WebAssembly.Instance,
  compiler: string,
): (seed: number, rounds: number) => number {
  const run = instance.exports.run;
  if (!(run instanceof Function)) {
    throw new Error(`${compiler} Wasm module has no run export`);
  }
  return run as (seed: number, rounds: number) => number;
}

function summarizeZeroCompilation(
  samples: readonly ZeroCompilationTimings[],
): Record<string, unknown> {
  const fields = [
    "parserInitializationMilliseconds",
    "parsingMilliseconds",
    "coreLoweringMilliseconds",
    "wasmPlanningMilliseconds",
    "emitterInitializationMilliseconds",
    "wasmEmissionMilliseconds",
    "totalMilliseconds",
  ] as const;
  return Object.fromEntries(fields.map((field) => [field, {
    summary: summarizeSamples(samples.map((sample) => sample[field])),
    raw: samples.map((sample) => sample[field]),
  }]));
}

function requestedPositiveInteger(
  arguments_: readonly string[],
  name: string,
  defaultValue: number,
): number {
  const value = requestedString(arguments_, name);
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(
      `--${name} must be a positive integer; received ${parsed}`,
    );
  }
  return parsed;
}

function requestedString(
  arguments_: readonly string[],
  name: string,
): string | undefined {
  const prefix = `--${name}=`;
  return arguments_.find((candidate) => candidate.startsWith(prefix))?.slice(
    prefix.length,
  );
}

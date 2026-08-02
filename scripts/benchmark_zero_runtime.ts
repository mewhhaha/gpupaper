import {
  compileZeroSource,
  type ZeroCompilation,
  type ZeroCompilationTimings,
} from "../examples/zero/compiler.ts";
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

type OwnedBytes = Uint8Array<ArrayBuffer>;

const sampleCount = requestedPositiveInteger(Deno.args, "samples", 30);
const rounds = requestedPositiveInteger(Deno.args, "rounds", 100_000);
const allowContended = Deno.args.includes("--allow-contended");
const gpupaperDirectory = new URL("../", import.meta.url).pathname;
const zeroSourceUrl = new URL("../examples/zero/kernel.zero", import.meta.url);
const rustSourceUrl = new URL("../examples/zero/kernel.rs", import.meta.url);
const zeroSource = await Deno.readTextFile(zeroSourceUrl);
const rustSource = await Deno.readTextFile(rustSourceUrl);
const textEncoder = new TextEncoder();

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
  const coldZero = await compileZeroSource(zeroSourceUrl.pathname, zeroSource);
  await compileRustBaseline(temporaryDirectory, rustSourceUrl.pathname);

  const zeroCompilationSamples: ZeroCompilationTimings[] = [];
  const rustCompilationSamples: number[] = [];
  let zeroCompilation = coldZero;
  let rustWasm = new Uint8Array();
  for (let sample = 0; sample < sampleCount; sample += 1) {
    if (sample % 2 === 0) {
      zeroCompilation = await measureZeroCompilation(
        zeroSourceUrl.pathname,
        zeroSource,
        zeroCompilationSamples,
      );
      rustWasm = await measureRustCompilation(
        temporaryDirectory,
        rustSourceUrl.pathname,
        rustCompilationSamples,
      );
    } else {
      rustWasm = await measureRustCompilation(
        temporaryDirectory,
        rustSourceUrl.pathname,
        rustCompilationSamples,
      );
      zeroCompilation = await measureZeroCompilation(
        zeroSourceUrl.pathname,
        zeroSource,
        zeroCompilationSamples,
      );
    }
  }

  const zeroBytes = Uint8Array.from(zeroCompilation.wasm);
  requireEquivalentResults(zeroBytes, rustWasm);

  const moduleMeasurements = measureModuleBoundaries(
    zeroBytes,
    rustWasm,
    sampleCount,
  );
  const zeroModule = new WebAssembly.Module(zeroBytes.buffer);
  const rustModule = new WebAssembly.Module(rustWasm.buffer);
  const zeroRun = exportedRun(new WebAssembly.Instance(zeroModule), "Zero");
  const rustRun = exportedRun(new WebAssembly.Instance(rustModule), "Rust");
  warmRuntime(zeroRun);
  warmRuntime(rustRun);

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
    (sum, seed) => sum + referenceRun(seed, rounds),
    0,
  );
  const zeroRuntimeSamples: number[] = [];
  const rustRuntimeSamples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const order = sample % 2 === 0
      ? [[zeroRun, zeroRuntimeSamples], [rustRun, rustRuntimeSamples]] as const
      : [[rustRun, rustRuntimeSamples], [zeroRun, zeroRuntimeSamples]] as const;
    for (const [run, samples] of order) {
      samples.push(
        measureRuntimeNanosecondsPerIteration(
          run,
          seeds,
          rounds,
          expectedChecksum,
        ),
      );
    }
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
      schemaVersion: 1,
      benchmark: "zero-runtime-versus-rust",
      runtime: runtimeIdentity(),
      repositories: {
        gpupaper: await repositoryIdentity(gpupaperDirectory),
      },
      environmentAtStart,
      environmentAtEnd,
      workload: {
        semanticModel: "wrapping-i32-bounded-fold",
        sampleCount,
        roundsPerInvocation: rounds,
        invocationsPerSample: seeds.length,
        iterationsPerSample: rounds * seeds.length,
        zeroSourceBytes: textEncoder.encode(zeroSource).byteLength,
        rustSourceBytes: textEncoder.encode(rustSource).byteLength,
        zeroSourceSha256: await sha256(textEncoder.encode(zeroSource)),
        rustSourceSha256: await sha256(textEncoder.encode(rustSource)),
      },
      output: {
        zeroWasmBytes: zeroBytes.byteLength,
        rustWasmBytes: rustWasm.byteLength,
        zeroWasmSha256: await sha256(zeroBytes),
        rustWasmSha256: await sha256(rustWasm),
      },
      compilationMilliseconds: {
        boundariesComparable: false,
        reason:
          "Zero is an in-process incremental frontend plus Rust/Wasm plan emitter; Rust is a fresh rustc process",
        zeroCold: coldZero.timings,
        zeroWarm: summarizeZeroCompilation(zeroCompilationSamples),
        rustcProcess: summarizeSamples(rustCompilationSamples),
        rustcProcessRaw: rustCompilationSamples,
      },
      moduleConstructionMilliseconds: moduleMeasurements.construction,
      instantiationMilliseconds: moduleMeasurements.instantiation,
      runtimeNanosecondsPerIteration: {
        zero: summarizeSamples(zeroRuntimeSamples),
        rust: summarizeSamples(rustRuntimeSamples),
        pair: summarizePairedSamples(zeroRuntimeSamples, rustRuntimeSamples),
        zeroRaw: zeroRuntimeSamples,
        rustRaw: rustRuntimeSamples,
      },
    },
    null,
    2,
  ));
  if (validity.status === "refused") Deno.exit(2);
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

async function measureZeroCompilation(
  file: string,
  source: string,
  samples: ZeroCompilationTimings[],
): Promise<ZeroCompilation> {
  const compilation = await compileZeroSource(file, source);
  samples.push(compilation.timings);
  return compilation;
}

async function measureRustCompilation(
  temporaryDirectory: string,
  sourcePath: string,
  samples: number[],
): Promise<OwnedBytes> {
  const start = performance.now();
  const wasm = await compileRustBaseline(temporaryDirectory, sourcePath);
  samples.push(performance.now() - start);
  return wasm;
}

async function compileRustBaseline(
  temporaryDirectory: string,
  sourcePath: string,
): Promise<OwnedBytes> {
  const outputPath = `${temporaryDirectory}/kernel.wasm`;
  const output = await new Deno.Command("rustc", {
    args: [
      sourcePath,
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
      `rustc failed for ${sourcePath}: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return Uint8Array.from(await Deno.readFile(outputPath));
}

function requireEquivalentResults(
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
  let state = 0x6d2b79f5;
  const probes: [number, number][] = [
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
    probes.push([state | 0, probe * 17]);
  }
  for (const [seed, rounds] of probes) {
    const expected = referenceRun(seed, rounds);
    const zeroResult = zero(seed, rounds);
    const rustResult = rust(seed, rounds);
    if (zeroResult !== expected || rustResult !== expected) {
      throw new Error(
        `runtime disagreement for seed ${seed}, rounds ${rounds}: Zero ${zeroResult}, Rust ${rustResult}, reference ${expected}`,
      );
    }
  }
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
    const order = sample % 2 === 0
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
    for (const [wasm, construction, instantiation] of order) {
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
    checksum += run(iteration, 25_000);
  }
  if (!Number.isFinite(checksum)) {
    throw new Error(`runtime warmup produced invalid checksum ${checksum}`);
  }
}

function measureRuntimeNanosecondsPerIteration(
  run: (seed: number, rounds: number) => number,
  seeds: readonly number[],
  rounds: number,
  expectedChecksum: number,
): number {
  let checksum = 0;
  const start = performance.now();
  for (const seed of seeds) checksum += run(seed, rounds);
  const elapsed = performance.now() - start;
  if (checksum !== expectedChecksum) {
    throw new Error(
      `runtime sample produced checksum ${checksum}; expected ${expectedChecksum}`,
    );
  }
  return elapsed * 1_000_000 / (rounds * seeds.length);
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

function referenceRun(seed: number, rounds: number): number {
  let state = seed | 0;
  for (let remaining = rounds; remaining > 0; remaining -= 1) {
    const mixed = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    state = mixed < 0 ? (mixed + 12_345) | 0 : (mixed - 12_345) | 0;
  }
  return state;
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
  return Object.fromEntries(fields.map((field) => [
    field,
    {
      summary: summarizeSamples(samples.map((sample) => sample[field])),
      raw: samples.map((sample) => sample[field]),
    },
  ]));
}

function requestedPositiveInteger(
  arguments_: readonly string[],
  name: string,
  defaultValue: number,
): number {
  const prefix = `--${name}=`;
  const argument = arguments_.find((candidate) => candidate.startsWith(prefix));
  if (argument === undefined) return defaultValue;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      `--${name} must be a positive integer; received ${value}`,
    );
  }
  return value;
}

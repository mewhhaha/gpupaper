import { compileModuleSource, runMain } from "../src/compiler.ts";
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
  runtimeIdentity,
  sha256,
} from "./benchmark_environment.ts";
import {
  representativeSample,
  summarizePairedSamples,
  summarizeSamples,
} from "./benchmark_statistics.ts";

const warmupCount = 3;
const sampleCount = requestedSampleCount(Deno.args);
const runtimeSampleCount = 32;
const chainCounts = [1, 2, 4, 8, 32] as const;
const allowContended = Deno.args.includes("--allow-contended");
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

const results = [];
for (const chainCount of chainCounts) {
  const source = vectorSource(chainCount);
  for (let warmup = 0; warmup < warmupCount; warmup += 1) {
    await compileModuleSource("simd_benchmark.duck", source, {
      gpuMode: "off",
      wasmTarget: "wasm-scalar",
    });
    await compileModuleSource("simd_benchmark.duck", source, {
      gpuMode: "off",
      wasmTarget: "wasm-simd128",
    });
  }

  const scalarSamples: CompilationSample[] = [];
  const simdSamples: CompilationSample[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const order = sample % 2 === 0
      ? ["wasm-scalar", "wasm-simd128"] as const
      : ["wasm-simd128", "wasm-scalar"] as const;
    for (const target of order) {
      const measured = await compileSample(source, target);
      if (target === "wasm-scalar") scalarSamples.push(measured);
      else simdSamples.push(measured);
    }
  }
  const scalar = representativeSample(
    scalarSamples,
    (sample) => sample.totalMilliseconds,
  );
  const simd = representativeSample(
    simdSamples,
    (sample) => sample.totalMilliseconds,
  );
  const scalarArtifact = await compileModuleSource(
    "simd_benchmark.duck",
    source,
    {
      gpuMode: "off",
      wasmTarget: "wasm-scalar",
    },
  );
  const simdArtifact = await compileModuleSource(
    "simd_benchmark.duck",
    source,
    {
      gpuMode: "off",
      wasmTarget: "wasm-simd128",
    },
  );
  const inputs = { input: { seed: 1 } };
  const scalarResult = await runMain(scalarArtifact.wasm, inputs);
  const simdResult = await runMain(simdArtifact.wasm, inputs);
  if (!Object.is(simdResult, scalarResult)) {
    throw new Error(
      `${chainCount}-chain SIMD result ${
        String(simdResult)
      } differs from scalar ${String(scalarResult)}`,
    );
  }
  if (simdArtifact.profile.work.vectorAcceptedPlanCount !== chainCount) {
    throw new Error(
      `${chainCount}-chain fixture accepted ${simdArtifact.profile.work.vectorAcceptedPlanCount} vector plans`,
    );
  }
  const execution = await benchmarkExecutionPair(
    scalarArtifact.wasm,
    simdArtifact.wasm,
  );
  results.push({
    chainCount,
    sourceBytes: new TextEncoder().encode(source).byteLength,
    sourceSha256: await sha256(new TextEncoder().encode(source)),
    scalar: {
      representative: scalar,
      total: summarizeSamples(
        scalarSamples.map((sample) => sample.totalMilliseconds),
      ),
      raw: scalarSamples,
    },
    simd: {
      representative: simd,
      total: summarizeSamples(
        simdSamples.map((sample) => sample.totalMilliseconds),
      ),
      raw: simdSamples,
    },
    compilationPair: summarizePairedSamples(
      simdSamples.map((sample) => sample.totalMilliseconds),
      scalarSamples.map((sample) => sample.totalMilliseconds),
    ),
    execution,
    wasmByteRatio: simd.wasmBytes / scalar.wasmBytes,
    vectorWork: {
      candidateWindows: simdArtifact.profile.work.vectorCandidateWindowCount,
      acceptedPlans: simdArtifact.profile.work.vectorAcceptedPlanCount,
      scalarOperations: simdArtifact.profile.work.vectorScalarOperationCount,
      vectorOperations: simdArtifact.profile.work.vectorOperationCount,
      packs: simdArtifact.profile.work.vectorPackCount,
      splats: simdArtifact.profile.work.vectorSplatCount,
      extracts: simdArtifact.profile.work.vectorExtractCount,
      estimatedScalarCost: simdArtifact.profile.work.vectorEstimatedScalarCost,
      estimatedVectorCost: simdArtifact.profile.work.vectorEstimatedCost,
    },
  });
}

const environmentAtEnd = await inspectBenchmarkEnvironment({
  gpuWork: "ignore",
});
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";

async function benchmarkExecutionPair(
  scalarWasm: Uint8Array,
  simdWasm: Uint8Array,
): Promise<{
  readonly scalar: ReturnType<typeof summarizeSamples>;
  readonly simd: ReturnType<typeof summarizeSamples>;
  readonly pair: ReturnType<typeof summarizePairedSamples>;
  readonly scalarRawNanoseconds: readonly number[];
  readonly simdRawNanoseconds: readonly number[];
}> {
  const scalar = await instantiateMain(scalarWasm);
  const simd = await instantiateMain(simdWasm);
  for (let warmup = 0; warmup < 100_000; warmup += 1) {
    scalar();
    simd();
  }
  const iterations = 100_000;
  const scalarSamples: number[] = [];
  const simdSamples: number[] = [];
  for (let sample = 0; sample < runtimeSampleCount; sample += 1) {
    const first = sample % 2 === 0
      ? [scalar, scalarSamples, simd, simdSamples] as const
      : [simd, simdSamples, scalar, scalarSamples] as const;
    first[1].push(measureExecution(first[0], iterations));
    first[3].push(measureExecution(first[2], iterations));
  }
  return {
    scalar: summarizeSamples(scalarSamples),
    simd: summarizeSamples(simdSamples),
    pair: summarizePairedSamples(simdSamples, scalarSamples),
    scalarRawNanoseconds: scalarSamples,
    simdRawNanoseconds: simdSamples,
  };
}

async function instantiateMain(wasm: Uint8Array): Promise<() => number> {
  const module = await WebAssembly.compile(
    new Uint8Array(wasm).buffer as ArrayBuffer,
  );
  const imports: WebAssembly.Imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    if (descriptor.kind !== "function") {
      throw new TypeError(
        `SIMD benchmark cannot provide ${descriptor.kind} import ${descriptor.module}.${descriptor.name}`,
      );
    }
    const namespace = imports[descriptor.module] ?? {};
    namespace[descriptor.name] = () => 1;
    imports[descriptor.module] = namespace;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const main = instance.exports.main;
  if (!(main instanceof Function)) {
    throw new Error("SIMD benchmark module has no main export");
  }
  return main as () => number;
}

function measureExecution(main: () => number, iterations: number): number {
  let checksum = 0;
  const start = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    checksum += main();
  }
  const elapsed = performance.now() - start;
  if (!Number.isFinite(checksum) || checksum === 0) {
    throw new Error(`SIMD benchmark produced checksum ${checksum}`);
  }
  return elapsed * 1_000_000 / iterations;
}

console.log(
  JSON.stringify(
    {
      status: environmentClear || allowContended ? "completed" : "refused",
      validity: environmentClear ? { status: "admissible" } : allowContended
        ? {
          status: "diagnostic",
          reason: "competing compiler work was present during measurement",
        }
        : {
          status: "refused",
          reason: "competing compiler work appeared during measurement",
        },
      schemaVersion: 1,
      warmupCount,
      sampleCount,
      runtimeSampleCount,
      compilationOrder: "balancedScalarFirstAndSimdFirstPairs",
      runtimeOrder: "balancedScalarFirstAndSimdFirstPairs",
      runtime: runtimeIdentity(),
      repositories: {
        gpupaper: await repositoryIdentity(
          new URL("../", import.meta.url).pathname,
        ),
      },
      environmentAtStart,
      environmentAtEnd,
      results,
    },
    null,
    2,
  ),
);
if (!environmentClear && !allowContended) Deno.exit(2);

type CompilationSample = {
  readonly totalMilliseconds: number;
  readonly vectorizationMilliseconds: number;
  readonly vectorValidationMilliseconds: number;
  readonly vectorPlanningMilliseconds: number;
  readonly vectorRebuildMilliseconds: number;
  readonly vectorFlatCoreMilliseconds: number;
  readonly wasmMilliseconds: number;
  readonly wasmBytes: number;
};

async function compileSample(
  source: string,
  wasmTarget: "wasm-scalar" | "wasm-simd128",
): Promise<CompilationSample> {
  const artifact = await compileModuleSource("simd_benchmark.duck", source, {
    gpuMode: "off",
    wasmTarget,
  });
  return {
    totalMilliseconds: artifact.profile.totalMilliseconds,
    vectorizationMilliseconds:
      artifact.profile.stages.coreVectorizationMilliseconds,
    vectorValidationMilliseconds:
      artifact.profile.details.vectorValidationMilliseconds,
    vectorPlanningMilliseconds:
      artifact.profile.details.vectorPlanningMilliseconds,
    vectorRebuildMilliseconds:
      artifact.profile.details.vectorRebuildMilliseconds,
    vectorFlatCoreMilliseconds:
      artifact.profile.details.vectorFlatCoreMilliseconds,
    wasmMilliseconds:
      artifact.profile.stages.wasmPlanningAndCpuEmissionMilliseconds,
    wasmBytes: artifact.wasm.byteLength,
  };
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const argument = arguments_.find((candidate) =>
    candidate.startsWith("--samples=")
  );
  if (argument === undefined) return 16;
  const count = Number.parseInt(argument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 2 || count % 2 !== 0) {
    throw new TypeError(
      `--samples must be an even integer of at least 2; received ${argument}`,
    );
  }
  return count;
}

function vectorSource(chainCount: number): string {
  const chains = Array.from(
    { length: chainCount },
    (_, chain) => vectorChain(chain),
  );
  const results = Array.from(
    { length: chainCount },
    (_, chain) => `chain_${chain}_result`,
  );
  return `module (!init: Init) where

declare effect Input {
  seed: () => F32
}

declare Init { input: Input }

seed <- Input.seed()
${chains.join("\n")}
return { .result = ${results.join(" + ")} }
`;
}

function vectorChain(chain: number): string {
  let previous = ["seed", "seed", "seed", "seed"];
  const lines: string[] = [];
  const operators = ["+", "*", "-", "/", "+", "*"] as const;
  for (let group = 0; group < operators.length; group += 1) {
    const current = Array.from(
      { length: 4 },
      (_, lane) => `chain_${chain}_${group}_${lane}`,
    );
    const operands = group === 0
      ? Array.from({ length: 4 }, (_, lane) => chain * 4 + lane + 1)
      : [2, 2, 2, 2];
    for (let lane = 0; lane < 4; lane += 1) {
      lines.push(
        `let ${current[lane]} = ${previous[lane]} ${operators[group]} ${
          operands[lane]
        }.0f32`,
      );
    }
    previous = current;
  }
  lines.push(
    `let chain_${chain}_low = ${previous[0]} + ${previous[1]}`,
    `let chain_${chain}_high = ${previous[2]} + ${previous[3]}`,
    `let chain_${chain}_result = chain_${chain}_low + chain_${chain}_high`,
  );
  return lines.join("\n");
}

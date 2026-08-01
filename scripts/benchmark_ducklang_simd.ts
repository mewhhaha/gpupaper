import { compileModuleSource, runMain } from "../src/compiler.ts";

const warmupCount = 3;
const sampleCount = 15;
const runtimeSampleCount = 31;
const chainCounts = [1, 2, 4, 8, 32] as const;

const results = [];
for (const chainCount of chainCounts) {
  const source = vectorSource(chainCount);
  for (let warmup = 0; warmup < warmupCount; warmup += 1) {
    await compileModuleSource("simd_benchmark.duck", source, {
      gpuMode: "off",
      wasmTarget: "wasm-simd128",
    });
  }

  const scalarSamples: CompilationSample[] = [];
  const simdSamples: CompilationSample[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    scalarSamples.push(await compileSample(source, "wasm-scalar"));
    simdSamples.push(await compileSample(source, "wasm-simd128"));
  }
  const scalar = medianSample(scalarSamples);
  const simd = medianSample(simdSamples);
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
    scalar,
    simd,
    compilerRatio: simd.totalMilliseconds / scalar.totalMilliseconds,
    executionRatio: execution.simdNanoseconds / execution.scalarNanoseconds,
    scalarExecutionNanoseconds: execution.scalarNanoseconds,
    simdExecutionNanoseconds: execution.simdNanoseconds,
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

async function benchmarkExecutionPair(
  scalarWasm: Uint8Array,
  simdWasm: Uint8Array,
): Promise<{
  readonly scalarNanoseconds: number;
  readonly simdNanoseconds: number;
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
    scalarNanoseconds: median(scalarSamples),
    simdNanoseconds: median(simdSamples),
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
    { warmupCount, sampleCount, runtimeSampleCount, results },
    null,
    2,
  ),
);

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

function medianSample(
  samples: readonly CompilationSample[],
): CompilationSample {
  return {
    totalMilliseconds: median(
      samples.map((sample) => sample.totalMilliseconds),
    ),
    vectorizationMilliseconds: median(
      samples.map((sample) => sample.vectorizationMilliseconds),
    ),
    vectorValidationMilliseconds: median(
      samples.map((sample) => sample.vectorValidationMilliseconds),
    ),
    vectorPlanningMilliseconds: median(
      samples.map((sample) => sample.vectorPlanningMilliseconds),
    ),
    vectorRebuildMilliseconds: median(
      samples.map((sample) => sample.vectorRebuildMilliseconds),
    ),
    vectorFlatCoreMilliseconds: median(
      samples.map((sample) => sample.vectorFlatCoreMilliseconds),
    ),
    wasmMilliseconds: median(samples.map((sample) => sample.wasmMilliseconds)),
    wasmBytes: median(samples.map((sample) => sample.wasmBytes)),
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
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

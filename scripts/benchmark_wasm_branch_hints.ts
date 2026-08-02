import { wasmInstruction, WasmModuleBuilder, wasmType } from "../src/wasm.ts";
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

const moduleSampleCount = 100;
const runtimeSampleCount = 32;
const runtimeIterations = 1_000_000;
const hintedBytes = buildBranchModule({ likelihood: "likely" });
const unhintedBytes = buildBranchModule({});
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

const hintedModuleSamples: number[] = [];
const unhintedModuleSamples: number[] = [];
for (let sample = 0; sample < moduleSampleCount; sample += 1) {
  const order = sample % 2 === 0
    ? [[hintedBytes, hintedModuleSamples], [
      unhintedBytes,
      unhintedModuleSamples,
    ]] as const
    : [[unhintedBytes, unhintedModuleSamples], [
      hintedBytes,
      hintedModuleSamples,
    ]] as const;
  for (const [bytes, samples] of order) {
    const start = performance.now();
    new WebAssembly.Module(bytes.buffer as ArrayBuffer);
    samples.push(performance.now() - start);
  }
}

const hintedMain = instantiateMain(hintedBytes);
const unhintedMain = instantiateMain(unhintedBytes);
for (let iteration = 0; iteration < 100_000; iteration += 1) {
  const condition = iteration % 1_000 === 0 ? 0 : 1;
  hintedMain(condition, iteration);
  unhintedMain(condition, iteration);
}

const hintedRuntimeSamples: number[] = [];
const unhintedRuntimeSamples: number[] = [];
for (let sample = 0; sample < runtimeSampleCount; sample += 1) {
  const order = sample % 2 === 0
    ? [[hintedMain, hintedRuntimeSamples], [
      unhintedMain,
      unhintedRuntimeSamples,
    ]] as const
    : [[unhintedMain, unhintedRuntimeSamples], [
      hintedMain,
      hintedRuntimeSamples,
    ]] as const;
  for (const [main, samples] of order) {
    samples.push(measureRuntime(main));
  }
}

const probeInputs = [[1, 41], [0, 41], [1, -4]] as const;
for (const [condition, value] of probeInputs) {
  const hinted = hintedMain(condition, value);
  const unhinted = unhintedMain(condition, value);
  if (hinted !== unhinted) {
    throw new Error(
      `branch-hint benchmark disagrees for (${condition}, ${value}): ${hinted} versus ${unhinted}`,
    );
  }
}

const environmentAtEnd = await inspectBenchmarkEnvironment({
  gpuWork: "ignore",
});
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";
console.log(JSON.stringify(
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
    runtime: runtimeIdentity(),
    repositories: {
      gpupaper: await repositoryIdentity(
        new URL("../", import.meta.url).pathname,
      ),
    },
    environmentAtStart,
    environmentAtEnd,
    trueConditionFrequency: 0.999,
    moduleSampleCount,
    runtimeSampleCount,
    runtimeIterations,
    hintedBytes: hintedBytes.length,
    unhintedBytes: unhintedBytes.length,
    metadataBytes: hintedBytes.length - unhintedBytes.length,
    outputs: {
      hintedSha256: await sha256(hintedBytes),
      unhintedSha256: await sha256(unhintedBytes),
    },
    moduleConstructionMilliseconds: {
      hinted: summarizeSamples(hintedModuleSamples),
      unhinted: summarizeSamples(unhintedModuleSamples),
      pair: summarizePairedSamples(
        hintedModuleSamples,
        unhintedModuleSamples,
      ),
      hintedRaw: hintedModuleSamples,
      unhintedRaw: unhintedModuleSamples,
    },
    runtimeNanosecondsPerCall: {
      hinted: summarizeSamples(hintedRuntimeSamples),
      unhinted: summarizeSamples(unhintedRuntimeSamples),
      pair: summarizePairedSamples(
        hintedRuntimeSamples,
        unhintedRuntimeSamples,
      ),
      hintedRaw: hintedRuntimeSamples,
      unhintedRaw: unhintedRuntimeSamples,
    },
  },
  null,
  2,
));
if (!environmentClear && !allowContended) Deno.exit(2);

function buildBranchModule(
  options: { readonly likelihood?: "likely" },
): Uint8Array {
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType(
    [wasmType.i32, wasmType.i32],
    [wasmType.i32],
  );
  const functionIndex = builder.addFunction(type, [], [
    ...wasmInstruction.localGet(0),
    ...(options.likelihood === undefined
      ? []
      : wasmInstruction.branchHint(options.likelihood)),
    ...wasmInstruction.ifI32,
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.else,
    ...wasmInstruction.i32Constant(-1),
    ...wasmInstruction.end,
  ]);
  builder.exportFunction("main", functionIndex);
  return builder.finish();
}

function instantiateMain(
  bytes: Uint8Array,
): (condition: number, value: number) => number {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(bytes.buffer as ArrayBuffer),
  );
  const main = instance.exports.main;
  if (!(main instanceof Function)) {
    throw new Error("branch-hint benchmark module has no main export");
  }
  return main as (condition: number, value: number) => number;
}

function measureRuntime(
  main: (condition: number, value: number) => number,
): number {
  let checksum = 0;
  const start = performance.now();
  for (let iteration = 0; iteration < runtimeIterations; iteration += 1) {
    const condition = iteration % 1_000 === 0 ? 0 : 1;
    checksum += main(condition, iteration & 1_023);
  }
  const elapsed = performance.now() - start;
  if (checksum !== 511_855_984) {
    throw new Error(`branch-hint benchmark produced checksum ${checksum}`);
  }
  return elapsed * 1_000_000 / runtimeIterations;
}

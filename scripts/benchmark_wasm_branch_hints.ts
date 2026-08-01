import { wasmInstruction, WasmModuleBuilder, wasmType } from "../src/wasm.ts";

const moduleSampleCount = 101;
const runtimeSampleCount = 31;
const runtimeIterations = 1_000_000;
const hintedBytes = buildBranchModule({ likelihood: "likely" });
const unhintedBytes = buildBranchModule({});

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

console.log(JSON.stringify(
  {
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    platform: `${Deno.build.os}-${Deno.build.arch}`,
    trueConditionFrequency: 0.999,
    moduleSampleCount,
    runtimeSampleCount,
    runtimeIterations,
    hintedBytes: hintedBytes.length,
    unhintedBytes: unhintedBytes.length,
    metadataBytes: hintedBytes.length - unhintedBytes.length,
    moduleConstructionMilliseconds: {
      hintedMedian: median(hintedModuleSamples),
      unhintedMedian: median(unhintedModuleSamples),
    },
    runtimeNanosecondsPerCall: {
      hintedMedian: median(hintedRuntimeSamples),
      unhintedMedian: median(unhintedRuntimeSamples),
    },
  },
  null,
  2,
));

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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

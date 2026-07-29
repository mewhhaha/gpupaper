import { compileModuleSource } from "../src/compiler.ts";

const batchSizes = [1, 2, 4, 8] as const;
const sampleCount = 5;
const sourceFile = new URL(
  "../examples/binned/live/case-studies/grep/grep.duck",
  import.meta.url,
).pathname;
const hostInterface = new URL(
  "../examples/binned/live/case-studies/grep/host.duck",
  import.meta.url,
).pathname;
const source = await Deno.readTextFile(sourceFile);

await compile("cpu");
await compile("gpu");

const measurements: {
  readonly batchSize: number;
  readonly cpuMedianMilliseconds: number;
  readonly gpuMedianMilliseconds: number;
  readonly cpuMillisecondsPerCompilation: number;
  readonly gpuMillisecondsPerCompilation: number;
  readonly gpuToCpuRatio: number;
}[] = [];
for (const batchSize of batchSizes) {
  const cpuSamples: number[] = [];
  const gpuSamples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    cpuSamples.push(await measureBatch(batchSize, "cpu"));
    gpuSamples.push(await measureBatch(batchSize, "gpu"));
  }
  const cpuMedianMilliseconds = median(cpuSamples);
  const gpuMedianMilliseconds = median(gpuSamples);
  measurements.push({
    batchSize,
    cpuMedianMilliseconds,
    gpuMedianMilliseconds,
    cpuMillisecondsPerCompilation: cpuMedianMilliseconds / batchSize,
    gpuMillisecondsPerCompilation: gpuMedianMilliseconds / batchSize,
    gpuToCpuRatio: gpuMedianMilliseconds / cpuMedianMilliseconds,
  });
}

const observedBreakEven = measurements.find((measurement) =>
  measurement.gpuMedianMilliseconds <= measurement.cpuMedianMilliseconds
);
console.log(JSON.stringify({
  target: "grep",
  sampleCount,
  gpuMode: "required",
  gpuWasmVerification: "none",
  measurements,
  breakEven: observedBreakEven === undefined
    ? { status: "notObserved", batchSizeLowerBound: batchSizes.at(-1)! }
    : { status: "observed", batchSize: observedBreakEven.batchSize },
}));

async function measureBatch(
  batchSize: number,
  backend: "cpu" | "gpu",
): Promise<number> {
  const start = performance.now();
  await Promise.all(
    Array.from({ length: batchSize }, () => compile(backend)),
  );
  return performance.now() - start;
}

async function compile(backend: "cpu" | "gpu"): Promise<void> {
  const artifact = await compileModuleSource(sourceFile, source, {
    gpuMode: backend === "cpu" ? "off" : "required",
    gpuWasmVerification: backend === "cpu" ? "differential" : "none",
    hostInterface,
  });
  if (backend === "gpu" && artifact.backends.wasmEmission !== "gpu") {
    throw new Error(
      `GPU break-even sample used ${artifact.backends.wasmEmission} Wasm emission`,
    );
  }
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

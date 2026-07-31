import {
  compileModuleSource,
  type GpuSchedulingPolicy,
} from "../src/compiler.ts";

const batchSizes = [1, 2, 4, 8, 16] as const;
const sampleCount = requestedSampleCount(Deno.args);
const sourceFile = new URL(
  "../examples/binned/live/case-studies/grep/grep.duck",
  import.meta.url,
).pathname;
const hostInterface = new URL(
  "../examples/binned/live/case-studies/grep/host.duck",
  import.meta.url,
).pathname;
const source = await Deno.readTextFile(sourceFile);

await compile("cpu", "latency");
await compile("gpu", "latency");

const policies = ["latency", "throughput"] as const;
const policyMeasurements = [];
for (const gpuScheduling of policies) {
  const measurements: BatchReport[] = [];
  for (const batchSize of batchSizes) {
    const cpuSamples: BatchMeasurement[] = [];
    const gpuSamples: BatchMeasurement[] = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      if (sample % 2 === 0) {
        cpuSamples.push(await measureBatch(batchSize, "cpu", gpuScheduling));
        gpuSamples.push(await measureBatch(batchSize, "gpu", gpuScheduling));
      } else {
        gpuSamples.push(await measureBatch(batchSize, "gpu", gpuScheduling));
        cpuSamples.push(await measureBatch(batchSize, "cpu", gpuScheduling));
      }
    }
    const cpuMedianMilliseconds = median(
      cpuSamples.map((sample) => sample.milliseconds),
    );
    const gpuMedianMilliseconds = median(
      gpuSamples.map((sample) => sample.milliseconds),
    );
    measurements.push({
      batchSize,
      cpuMedianMilliseconds,
      cpuP95Milliseconds: percentile(
        cpuSamples.map((sample) => sample.milliseconds),
        0.95,
      ),
      gpuMedianMilliseconds,
      gpuP95Milliseconds: percentile(
        gpuSamples.map((sample) => sample.milliseconds),
        0.95,
      ),
      cpuMillisecondsPerCompilation: cpuMedianMilliseconds / batchSize,
      gpuMillisecondsPerCompilation: gpuMedianMilliseconds / batchSize,
      gpuToCpuRatio: gpuMedianMilliseconds / cpuMedianMilliseconds,
      gpuTypeSubmissionBatchSize: median(
        gpuSamples.map((sample) => sample.typeSubmissionBatchSize),
      ),
      gpuTypePayloadBatchSize: median(
        gpuSamples.map((sample) => sample.typePayloadBatchSize),
      ),
      gpuCoreSubmissionBatchSize: median(
        gpuSamples.map((sample) => sample.coreSubmissionBatchSize),
      ),
      gpuCorePayloadBatchSize: median(
        gpuSamples.map((sample) => sample.corePayloadBatchSize),
      ),
      gpuWasmSubmissionBatchSize: median(
        gpuSamples.map((sample) => sample.wasmSubmissionBatchSize),
      ),
      gpuWasmPayloadBatchSize: median(
        gpuSamples.map((sample) => sample.wasmPayloadBatchSize),
      ),
      gpuQueueWaitMilliseconds: median(
        gpuSamples.map((sample) => sample.queueWaitMilliseconds),
      ),
    });
  }
  const observedBreakEven = measurements.find((measurement) =>
    measurement.gpuMedianMilliseconds <= measurement.cpuMedianMilliseconds
  );
  policyMeasurements.push({
    gpuScheduling,
    measurements,
    breakEven: observedBreakEven === undefined
      ? { status: "notObserved", batchSizeLowerBound: batchSizes.at(-1)! }
      : { status: "observed", batchSize: observedBreakEven.batchSize },
  });
}

console.log(JSON.stringify({
  target: "grep",
  sampleCount,
  gpuMode: "required",
  gpuWasmVerification: "none",
  pairOrder: "alternatingCpuFirst",
  pairCount: sampleCount / 2,
  policies: policyMeasurements,
}));

async function measureBatch(
  batchSize: number,
  backend: "cpu" | "gpu",
  gpuScheduling: GpuSchedulingPolicy,
): Promise<BatchMeasurement> {
  const start = performance.now();
  const compilations = await Promise.all(
    Array.from(
      { length: batchSize },
      () => compile(backend, gpuScheduling),
    ),
  );
  return {
    milliseconds: performance.now() - start,
    typeSubmissionBatchSize: Math.max(
      ...compilations.map((compilation) => compilation.typeSubmissionBatchSize),
    ),
    typePayloadBatchSize: Math.max(
      ...compilations.map((compilation) => compilation.typePayloadBatchSize),
    ),
    coreSubmissionBatchSize: Math.max(
      ...compilations.map((compilation) => compilation.coreSubmissionBatchSize),
    ),
    corePayloadBatchSize: Math.max(
      ...compilations.map((compilation) => compilation.corePayloadBatchSize),
    ),
    wasmSubmissionBatchSize: Math.max(
      ...compilations.map((compilation) => compilation.wasmSubmissionBatchSize),
    ),
    wasmPayloadBatchSize: Math.max(
      ...compilations.map((compilation) => compilation.wasmPayloadBatchSize),
    ),
    queueWaitMilliseconds: Math.max(
      ...compilations.map((compilation) => compilation.queueWaitMilliseconds),
    ),
  };
}

type BatchMeasurement = {
  readonly milliseconds: number;
  readonly typeSubmissionBatchSize: number;
  readonly typePayloadBatchSize: number;
  readonly coreSubmissionBatchSize: number;
  readonly corePayloadBatchSize: number;
  readonly wasmSubmissionBatchSize: number;
  readonly wasmPayloadBatchSize: number;
  readonly queueWaitMilliseconds: number;
};

type BatchReport = {
  readonly batchSize: number;
  readonly cpuMedianMilliseconds: number;
  readonly cpuP95Milliseconds: number;
  readonly gpuMedianMilliseconds: number;
  readonly gpuP95Milliseconds: number;
  readonly cpuMillisecondsPerCompilation: number;
  readonly gpuMillisecondsPerCompilation: number;
  readonly gpuToCpuRatio: number;
  readonly gpuTypeSubmissionBatchSize: number;
  readonly gpuTypePayloadBatchSize: number;
  readonly gpuCoreSubmissionBatchSize: number;
  readonly gpuCorePayloadBatchSize: number;
  readonly gpuWasmSubmissionBatchSize: number;
  readonly gpuWasmPayloadBatchSize: number;
  readonly gpuQueueWaitMilliseconds: number;
};

async function compile(
  backend: "cpu" | "gpu",
  gpuScheduling: GpuSchedulingPolicy,
): Promise<{
  readonly typeSubmissionBatchSize: number;
  readonly typePayloadBatchSize: number;
  readonly coreSubmissionBatchSize: number;
  readonly corePayloadBatchSize: number;
  readonly wasmSubmissionBatchSize: number;
  readonly wasmPayloadBatchSize: number;
  readonly queueWaitMilliseconds: number;
}> {
  const artifact = await compileModuleSource(sourceFile, source, {
    gpuMode: backend === "cpu" ? "off" : "required",
    gpuWasmVerification: backend === "cpu" ? "differential" : "none",
    gpuScheduling,
    hostInterface,
  });
  if (backend === "gpu" && artifact.backends.wasmEmission !== "gpu") {
    throw new Error(
      `GPU break-even sample used ${artifact.backends.wasmEmission} Wasm emission`,
    );
  }
  if (artifact.language !== "ducklang") {
    throw new Error(`GPU break-even sample compiled ${artifact.language}`);
  }
  return {
    typeSubmissionBatchSize: artifact.profile.work.gpuTypeSubmissionBatchSize,
    typePayloadBatchSize: artifact.profile.work.gpuTypePayloadBatchSize,
    coreSubmissionBatchSize: artifact.profile.work.gpuCoreSubmissionBatchSize,
    corePayloadBatchSize: artifact.profile.work.gpuCorePayloadBatchSize,
    wasmSubmissionBatchSize: artifact.profile.work.gpuWasmSubmissionBatchSize,
    wasmPayloadBatchSize: artifact.profile.work.gpuWasmPayloadBatchSize,
    queueWaitMilliseconds:
      artifact.profile.details.gpuTypeQueueWaitMilliseconds +
      artifact.profile.details.gpuCoreQueueWaitMilliseconds +
      artifact.profile.details.gpuWasmQueueWaitMilliseconds,
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered.length / 2;
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[Math.floor(middle)];
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil((ordered.length - 1) * quantile)]!;
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const sampleArgument = arguments_.find((argument) =>
    argument.startsWith("--samples=")
  );
  if (sampleArgument === undefined) return 16;
  const count = Number.parseInt(sampleArgument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 2 || count % 2 !== 0) {
    throw new TypeError(
      `--samples must be a positive even integer of at least 2; received ${sampleArgument}`,
    );
  }
  return count;
}

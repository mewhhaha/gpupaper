import {
  compileModuleSource,
  type GpuSchedulingPolicy,
} from "../src/compiler.ts";
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

const batchSizes = [1, 2, 4, 8, 16, 32, 64] as const;
const policies = ["latency", "throughput"] as const;
const sampleCount = requestedSampleCount(Deno.args);
const allowContended = Deno.args.includes("--allow-contended");
const sourceFile = new URL(
  "../examples/binned/live/case-studies/grep/grep.duck",
  import.meta.url,
).pathname;
const hostInterface = new URL(
  "../examples/binned/live/case-studies/grep/host.duck",
  import.meta.url,
).pathname;
const source = await Deno.readTextFile(sourceFile);
const environmentAtStart = await inspectBenchmarkEnvironment();
if (environmentAtStart.status !== "clear" && !allowContended) {
  console.log(JSON.stringify({
    status: "refused",
    reason: "competing compiler or GPU work is active or inspection failed",
    environment: environmentAtStart,
  }));
  Deno.exit(2);
}
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) {
  throw new Error("break-even benchmark has no GPU adapter");
}

type Cell = {
  readonly gpuScheduling: GpuSchedulingPolicy;
  readonly batchSize: number;
};
type CellSamples = {
  readonly cpu: BatchMeasurement[];
  readonly gpu: BatchMeasurement[];
};
const cells: readonly Cell[] = policies.flatMap((gpuScheduling) =>
  batchSizes.map((batchSize) => ({ gpuScheduling, batchSize }))
);
const samplesByCell = new Map<string, CellSamples>(
  cells.map((cell) => [cellKey(cell), { cpu: [], gpu: [] }]),
);

for (const cell of cells) {
  await measurePair(cell, 0);
}
for (let sample = 0; sample < sampleCount; sample += 1) {
  const orderedCells = sample % 2 === 0 ? cells : [...cells].reverse();
  for (const cell of orderedCells) {
    const pair = await measurePair(cell, sample);
    const retained = samplesByCell.get(cellKey(cell))!;
    retained.cpu.push(pair.cpu);
    retained.gpu.push(pair.gpu);
  }
}

const policyMeasurements = policies.map((gpuScheduling) => {
  const measurements = batchSizes.map((batchSize) => {
    const samples = samplesByCell.get(cellKey({ gpuScheduling, batchSize }))!;
    return reportBatch(batchSize, samples.cpu, samples.gpu);
  });
  const observedBreakEven = measurements.find((measurement) =>
    measurement.pairedGpuToCpu.difference.median <= 0
  );
  return {
    gpuScheduling,
    measurements,
    breakEven: observedBreakEven === undefined
      ? { status: "notObserved", maximumMeasuredBatchSize: batchSizes.at(-1)! }
      : { status: "observed", batchSize: observedBreakEven.batchSize },
  };
});

const environmentAtEnd = await inspectBenchmarkEnvironment();
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";
console.log(JSON.stringify({
  status: environmentClear || allowContended ? "completed" : "refused",
  validity: environmentClear ? { status: "admissible" } : allowContended
    ? {
      status: "diagnostic",
      reason: "competing compiler or GPU work was present during measurement",
    }
    : {
      status: "refused",
      reason: "competing compiler or GPU work appeared during measurement",
    },
  schemaVersion: 2,
  target: "grep",
  inputSha256: await sha256(new TextEncoder().encode(source)),
  sampleCount,
  warmupCountPerCell: 1,
  gpuMode: "required",
  gpuWasmVerification: "none",
  backendOrder: "balancedCpuFirstAndGpuFirstPairs",
  cellOrder: "balancedForwardAndReversePolicyBatchTraversal",
  runtime: runtimeIdentity(),
  repositories: {
    gpupaper: await repositoryIdentity(
      new URL("../", import.meta.url).pathname,
    ),
  },
  adapter: {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  },
  environmentAtStart,
  environmentAtEnd,
  policies: policyMeasurements,
}));
if (!environmentClear && !allowContended) Deno.exit(2);

async function measurePair(
  cell: Cell,
  pairIndex: number,
): Promise<{ readonly cpu: BatchMeasurement; readonly gpu: BatchMeasurement }> {
  const order = pairIndex % 2 === 0
    ? ["cpu", "gpu"] as const
    : ["gpu", "cpu"] as const;
  let cpu: BatchMeasurement | undefined;
  let gpu: BatchMeasurement | undefined;
  for (const backend of order) {
    const measurement = await measureBatch(
      cell.batchSize,
      backend,
      cell.gpuScheduling,
    );
    if (backend === "cpu") cpu = measurement;
    else gpu = measurement;
  }
  if (cpu === undefined || gpu === undefined) {
    throw new Error(`incomplete ${cellKey(cell)} CPU/GPU pair ${pairIndex}`);
  }
  if (cpu.wasmSha256 !== gpu.wasmSha256) {
    throw new Error(
      `${
        cellKey(cell)
      } pair ${pairIndex} emitted CPU ${cpu.wasmSha256} and GPU ${gpu.wasmSha256}`,
    );
  }
  return { cpu, gpu };
}

async function measureBatch(
  batchSize: number,
  backend: "cpu" | "gpu",
  gpuScheduling: GpuSchedulingPolicy,
): Promise<BatchMeasurement> {
  const start = performance.now();
  const compilations = await Promise.all(
    Array.from({ length: batchSize }, () => compile(backend, gpuScheduling)),
  );
  const firstWasm = compilations[0]!.wasm;
  if (
    compilations.some((compilation) => !equalBytes(firstWasm, compilation.wasm))
  ) {
    throw new Error(
      `${backend} ${gpuScheduling} batch ${batchSize} emitted unequal artifacts`,
    );
  }
  return {
    milliseconds: performance.now() - start,
    wasmSha256: await sha256(firstWasm),
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

function reportBatch(
  batchSize: number,
  cpuSamples: readonly BatchMeasurement[],
  gpuSamples: readonly BatchMeasurement[],
) {
  const cpuMilliseconds = cpuSamples.map((sample) => sample.milliseconds);
  const gpuMilliseconds = gpuSamples.map((sample) => sample.milliseconds);
  const cpu = summarizeSamples(cpuMilliseconds);
  const gpu = summarizeSamples(gpuMilliseconds);
  return {
    batchSize,
    cpu: { ...cpu, rawMilliseconds: cpuMilliseconds },
    gpu: { ...gpu, rawMilliseconds: gpuMilliseconds },
    pairedGpuToCpu: summarizePairedSamples(gpuMilliseconds, cpuMilliseconds),
    cpuMillisecondsPerCompilation: cpu.median / batchSize,
    gpuMillisecondsPerCompilation: gpu.median / batchSize,
    outputSha256: cpuSamples[0]!.wasmSha256,
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
  };
}

type BatchMeasurement = {
  readonly milliseconds: number;
  readonly wasmSha256: string;
  readonly coreSubmissionBatchSize: number;
  readonly corePayloadBatchSize: number;
  readonly wasmSubmissionBatchSize: number;
  readonly wasmPayloadBatchSize: number;
  readonly queueWaitMilliseconds: number;
};

async function compile(
  backend: "cpu" | "gpu",
  gpuScheduling: GpuSchedulingPolicy,
) {
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
    wasm: artifact.wasm,
    coreSubmissionBatchSize: artifact.profile.work.gpuCoreSubmissionBatchSize,
    corePayloadBatchSize: artifact.profile.work.gpuCorePayloadBatchSize,
    wasmSubmissionBatchSize: artifact.profile.work.gpuWasmSubmissionBatchSize,
    wasmPayloadBatchSize: artifact.profile.work.gpuWasmPayloadBatchSize,
    queueWaitMilliseconds:
      artifact.profile.details.gpuCoreQueueWaitMilliseconds +
      artifact.profile.details.gpuWasmQueueWaitMilliseconds,
  };
}

function cellKey(cell: Cell): string {
  return `${cell.gpuScheduling}:${cell.batchSize}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
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

import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
  type ValidatedBlotRuntimeModule,
} from "../src/blot_runtime_hir.ts";
import {
  compileBlotRuntimeModule,
  compileBlotRuntimeModulesOnGpu,
  type GpuBlotRuntimeBatchTimings,
} from "../src/blot_runtime_target.ts";
import {
  createGpuResidentWasmPlans,
  emitResidentWasmPlansOnGpu,
  emitWasmPlansOnGpu,
  type GpuResidentWasmPlans,
  type GpuWasmBatchEmissionTimings,
  type GpuWasmEmissionTimings,
} from "../src/gpu_wasm.ts";
import { emitWasmPlanOnCpu, type WasmBinaryPlan } from "../src/wasm.ts";
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

const chainLengths = [16, 256, 4_096, 32_768] as const;
const batchSizes = [1, 8, 64, 256] as const;
const maximumOperationsPerCell = 262_144;
const sampleCount = requestedSampleCount(Deno.args);
const allowContended = Deno.args.includes("--allow-contended");
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
  throw new Error("Blot crossover benchmark has no GPU adapter");
}

type Boundary =
  | "emission"
  | "residentEmission"
  | "runtimeHirToValidatedWasm";
type Backend = "cpu" | "gpu";
type Cell = {
  readonly chainLength: number;
  readonly batchSize: number;
};
type Measurement = {
  readonly milliseconds: number;
  readonly physicalPlanCount: number;
  readonly physicalPayloadCounts: readonly number[];
  readonly gpuBatchTimings?: GpuWasmBatchEmissionTimings;
  readonly gpuPhysicalTimings?: readonly GpuWasmEmissionTimings[];
  readonly gpuTargetTimings?: GpuBlotRuntimeBatchTimings;
};
type BoundarySamples = {
  readonly cpu: Measurement[];
  readonly gpu: Measurement[];
};
type CellSamples = Record<Boundary, BoundarySamples>;
type PreparedShape = {
  readonly module: ValidatedBlotRuntimeModule;
  readonly plan: WasmBinaryPlan;
  readonly expectedBytes: Uint8Array;
  readonly outputSha256: string;
};
const boundaries = [
  "emission",
  "residentEmission",
  "runtimeHirToValidatedWasm",
] as const;

const cells: readonly Cell[] = chainLengths.flatMap((chainLength) =>
  batchSizes
    .filter((batchSize) => chainLength * batchSize <= maximumOperationsPerCell)
    .map((batchSize) => ({ chainLength, batchSize }))
);
const preparedByChainLength = new Map<number, PreparedShape>();
for (const chainLength of chainLengths) {
  const module = validateBlotRuntimeModule(arithmeticChainModule(chainLength));
  const artifact = compileBlotRuntimeModule(module, { emission: "planOnly" });
  const expectedBytes = emitWasmPlanOnCpu(artifact.wasmPlan);
  preparedByChainLength.set(chainLength, {
    module,
    plan: artifact.wasmPlan,
    expectedBytes,
    outputSha256: await sha256(expectedBytes),
  });
}
const residentByCell = new Map<string, GpuResidentWasmPlans>();
for (const cell of cells) {
  const prepared = preparedByChainLength.get(cell.chainLength)!;
  const creation = await createGpuResidentWasmPlans(
    Array.from({ length: cell.batchSize }, () => prepared.plan),
    { maximumPhysicalPayloadCount: cell.batchSize },
  );
  if (creation.status === "unavailable") {
    throw new Error(
      `resident GPU emission unavailable for ${
        cellKey(cell)
      }: ${creation.reason}`,
    );
  }
  residentByCell.set(cellKey(cell), creation.resident);
}

const samplesByCell = new Map<string, CellSamples>(
  cells.map((cell) => [cellKey(cell), emptyCellSamples()]),
);
for (const cell of cells) await measureCell(cell, -1);
for (let sample = 0; sample < sampleCount; sample += 1) {
  const orderedCells = sample % 2 === 0 ? cells : [...cells].reverse();
  for (const cell of orderedCells) {
    const measurements = await measureCell(cell, sample);
    const retained = samplesByCell.get(cellKey(cell))!;
    for (const boundary of boundaries) {
      retained[boundary].cpu.push(measurements[boundary].cpu);
      retained[boundary].gpu.push(measurements[boundary].gpu);
    }
  }
}

const measurements = cells.map((cell) => {
  const prepared = preparedByChainLength.get(cell.chainLength)!;
  const samples = samplesByCell.get(cellKey(cell))!;
  return {
    ...cell,
    operationCountPerModule: cell.chainLength + 1,
    atomCountPerModule: prepared.plan.atoms.length,
    totalAtomCount: prepared.plan.atoms.length * cell.batchSize,
    wasmBytesPerModule: prepared.expectedBytes.length,
    totalWasmBytes: prepared.expectedBytes.length * cell.batchSize,
    outputSha256: prepared.outputSha256,
    residentPreparation: residentByCell.get(cellKey(cell))!.preparationTimings,
    residentCertificate: residentByCell.get(cellKey(cell))!.certificate,
    emission: reportBoundary(samples.emission),
    residentEmission: reportBoundary(samples.residentEmission),
    runtimeHirToValidatedWasm: reportBoundary(
      samples.runtimeHirToValidatedWasm,
    ),
  };
});
for (const resident of residentByCell.values()) resident.release();
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
  schemaVersion: 1,
  sampleCount,
  warmupCountPerCell: 1,
  workload: {
    name: "dynamic-checked-i64-add-chain",
    chainLengths,
    batchSizes,
    maximumOperationsPerCell,
    cellAdmission: "chainLength * batchSize <= maximumOperationsPerCell",
  },
  boundaries: {
    emission: "validated-wasm-plan-to-owned-bytes",
    residentEmission:
      "retained-validated-device-columns-through-scratch-sizing-emission-and-owned-byte-readback",
    runtimeHirToValidatedWasm:
      "validated-runtime-hir-through-core-planning-emission-and-wasm-manifest-validation",
  },
  order: "alternatingCellsBoundariesAndCpuGpuPairs",
  correctness: "every GPU artifact byte-equal to independent CPU emission",
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
  measurements,
  observedCrossovers: {
    emission: observedCrossovers(measurements, "emission"),
    residentEmission: observedCrossovers(measurements, "residentEmission"),
    runtimeHirToValidatedWasm: observedCrossovers(
      measurements,
      "runtimeHirToValidatedWasm",
    ),
  },
  descriptiveFits: {
    equation:
      "gpuMinusCpuMilliseconds = intercept + perModule * n + perAtom * A",
    status: "empiricalInterpolationNotProof",
    emission: fitDifferenceModel(measurements, "emission"),
    residentEmission: fitDifferenceModel(measurements, "residentEmission"),
    runtimeHirToValidatedWasm: fitDifferenceModel(
      measurements,
      "runtimeHirToValidatedWasm",
    ),
  },
}));
if (!environmentClear && !allowContended) Deno.exit(2);

async function measureCell(
  cell: Cell,
  pairIndex: number,
): Promise<Record<Boundary, Record<Backend, Measurement>>> {
  const boundaryOrder = pairIndex % 2 === 0
    ? boundaries
    : [...boundaries].reverse();
  const retained = {} as Record<Boundary, Record<Backend, Measurement>>;
  for (const boundary of boundaryOrder) {
    const backendOrder: readonly Backend[] = pairIndex % 2 === 0
      ? ["cpu", "gpu"]
      : ["gpu", "cpu"];
    const pair = {} as Record<Backend, Measurement>;
    for (const backend of backendOrder) {
      pair[backend] = await measure(cell, boundary, backend);
    }
    retained[boundary] = pair;
  }
  return retained;
}

async function measure(
  cell: Cell,
  boundary: Boundary,
  backend: Backend,
): Promise<Measurement> {
  const prepared = preparedByChainLength.get(cell.chainLength)!;
  let outputs: readonly Uint8Array[];
  let physicalPayloadCounts: readonly number[] = [];
  let gpuBatchTimings: GpuWasmBatchEmissionTimings | undefined;
  let gpuPhysicalTimings: readonly GpuWasmEmissionTimings[] | undefined;
  let gpuTargetTimings: GpuBlotRuntimeBatchTimings | undefined;
  const started = performance.now();
  if (
    (boundary === "emission" || boundary === "residentEmission") &&
    backend === "cpu"
  ) {
    outputs = Array.from(
      { length: cell.batchSize },
      () => emitWasmPlanOnCpu(prepared.plan),
    );
  } else if (boundary === "emission") {
    const emitted = await emitWasmPlansOnGpu(
      Array.from({ length: cell.batchSize }, () => prepared.plan),
      {
        scheduling: "throughput",
        maximumPhysicalPayloadCount: cell.batchSize,
      },
    );
    if (emitted.status === "unavailable") {
      throw new Error(
        `GPU emission unavailable for ${cellKey(cell)}: ${emitted.reason}`,
      );
    }
    outputs = emitted.bytes;
    gpuBatchTimings = emitted.timings;
    gpuPhysicalTimings = emitted.physicalEmissions.map((emission) =>
      emission.timings
    );
    physicalPayloadCounts = emitted.physicalPlans.map((plan) =>
      plan.payloadCount
    );
  } else if (boundary === "residentEmission") {
    const emitted = await emitResidentWasmPlansOnGpu(
      residentByCell.get(cellKey(cell))!,
      { scheduling: "throughput" },
    );
    if (emitted.status === "unavailable") {
      throw new Error(
        `resident GPU emission unavailable for ${
          cellKey(cell)
        }: ${emitted.reason}`,
      );
    }
    outputs = emitted.bytes;
    gpuBatchTimings = emitted.timings;
    gpuPhysicalTimings = emitted.physicalEmissions.map((emission) =>
      emission.timings
    );
    physicalPayloadCounts = emitted.physicalPlans.map((plan) =>
      plan.payloadCount
    );
  } else if (backend === "cpu") {
    outputs = Array.from({ length: cell.batchSize }, () => {
      const artifact = compileBlotRuntimeModule(prepared.module);
      if (artifact.wasm === undefined) {
        throw new Error(`CPU compilation omitted Wasm for ${cellKey(cell)}`);
      }
      return artifact.wasm;
    });
  } else {
    const compiled = await compileBlotRuntimeModulesOnGpu(
      Array.from({ length: cell.batchSize }, () => prepared.module),
      {
        scheduling: "throughput",
        maximumPhysicalPayloadCount: cell.batchSize,
      },
    );
    outputs = compiled.artifacts.map((artifact) => artifact.wasm);
    gpuBatchTimings = compiled.gpuBatch?.timings;
    gpuPhysicalTimings = compiled.gpuEmissions.map((emission) =>
      emission.timings
    );
    gpuTargetTimings = compiled.timings;
    physicalPayloadCounts = compiled.gpuBatch?.physicalPlans.map((plan) =>
      plan.payloadCount
    ) ?? [];
  }
  const milliseconds = performance.now() - started;
  requireExpectedOutputs(
    cell,
    boundary,
    backend,
    outputs,
    prepared.expectedBytes,
  );
  return {
    milliseconds,
    physicalPlanCount: physicalPayloadCounts.length,
    physicalPayloadCounts,
    ...(gpuBatchTimings === undefined ? {} : { gpuBatchTimings }),
    ...(gpuPhysicalTimings === undefined ? {} : { gpuPhysicalTimings }),
    ...(gpuTargetTimings === undefined ? {} : { gpuTargetTimings }),
  };
}

function requireExpectedOutputs(
  cell: Cell,
  boundary: Boundary,
  backend: Backend,
  outputs: readonly Uint8Array[],
  expected: Uint8Array,
): void {
  if (outputs.length !== cell.batchSize) {
    throw new Error(
      `${boundary} ${backend} ${
        cellKey(cell)
      } returned ${outputs.length} artifacts`,
    );
  }
  const mismatch = outputs.findIndex((output) => !equalBytes(output, expected));
  if (mismatch >= 0) {
    throw new Error(
      `${boundary} ${backend} ${
        cellKey(cell)
      } artifact ${mismatch} differs from CPU oracle`,
    );
  }
}

function reportBoundary(samples: BoundarySamples) {
  const cpuMilliseconds = samples.cpu.map((sample) => sample.milliseconds);
  const gpuMilliseconds = samples.gpu.map((sample) => sample.milliseconds);
  return {
    cpu: {
      timing: summarizeSamples(cpuMilliseconds),
      rawMilliseconds: cpuMilliseconds,
    },
    gpu: {
      timing: summarizeSamples(gpuMilliseconds),
      rawMilliseconds: gpuMilliseconds,
      rawPhysicalPlanCounts: samples.gpu.map((sample) =>
        sample.physicalPlanCount
      ),
      rawPhysicalPayloadCounts: samples.gpu.map((sample) =>
        sample.physicalPayloadCounts
      ),
      rawBatchTimings: samples.gpu.map((sample) => sample.gpuBatchTimings),
      rawPhysicalTimings: samples.gpu.map((sample) =>
        sample.gpuPhysicalTimings
      ),
      rawTargetTimings: samples.gpu.map((sample) => sample.gpuTargetTimings),
    },
    pairedGpuMinusCpu: summarizePairedSamples(
      gpuMilliseconds,
      cpuMilliseconds,
    ),
  };
}

type ReportedBoundary = ReturnType<typeof reportBoundary>;
type ReportedMeasurement = {
  readonly chainLength: number;
  readonly batchSize: number;
  readonly atomCountPerModule: number;
  readonly totalAtomCount: number;
  readonly emission: ReportedBoundary;
  readonly residentEmission: ReportedBoundary;
  readonly runtimeHirToValidatedWasm: ReportedBoundary;
};

function fitDifferenceModel(
  measurements: readonly ReportedMeasurement[],
  boundary: Boundary,
) {
  const rows = measurements.map((measurement) => ({
    predictors: [
      1,
      measurement.batchSize,
      measurement.totalAtomCount,
    ] as const,
    observed: measurement[boundary].pairedGpuMinusCpu.difference.median,
  }));
  const coefficients = solveLeastSquares(rows);
  const residuals = rows.map((row) =>
    row.observed - dot(coefficients, row.predictors)
  );
  const observedMean = rows.reduce((sum, row) => sum + row.observed, 0) /
    rows.length;
  const residualSquares = residuals.reduce(
    (sum, residual) => sum + residual * residual,
    0,
  );
  const totalSquares = rows.reduce(
    (sum, row) => sum + (row.observed - observedMean) ** 2,
    0,
  );
  const [intercept, perModule, perAtom] = coefficients;
  return {
    interceptMilliseconds: intercept,
    perModuleMilliseconds: perModule,
    perAtomMilliseconds: perAtom,
    rootMeanSquareResidualMilliseconds: Math.sqrt(
      residualSquares / rows.length,
    ),
    coefficientOfDetermination: totalSquares === 0
      ? undefined
      : 1 - residualSquares / totalSquares,
    singletonAtomCrossover: perAtom < 0
      ? {
        status: "fitted" as const,
        atomCount: -(intercept + perModule) / perAtom,
      }
      : {
        status: "notPredicted" as const,
        reason: "fitted GPU-minus-CPU atom slope is nonnegative",
      },
    batchCrossovers: chainLengths.map((chainLength) => {
      const atomCount = measurements.find((measurement) =>
        measurement.batchSize === 1 &&
        measurement.chainLength === chainLength
      )?.atomCountPerModule;
      if (atomCount === undefined) {
        throw new Error(`fit omitted singleton chain ${chainLength}`);
      }
      const marginal = perModule + perAtom * atomCount;
      return marginal < 0
        ? {
          chainLength,
          atomCountPerModule: atomCount,
          status: "fitted" as const,
          moduleCount: -intercept / marginal,
        }
        : {
          chainLength,
          atomCountPerModule: atomCount,
          status: "notPredicted" as const,
          reason: "fitted GPU-minus-CPU per-module marginal is nonnegative",
        };
    }),
  };
}

function observedCrossovers(
  measurements: readonly ReportedMeasurement[],
  boundary: Boundary,
) {
  return chainLengths.map((chainLength) => {
    const matching = measurements.filter((measurement) =>
      measurement.chainLength === chainLength
    );
    const crossover = matching.find((measurement) =>
      measurement[boundary].pairedGpuMinusCpu.difference.median <= 0
    );
    return crossover === undefined
      ? {
        chainLength,
        status: "notObserved" as const,
        maximumMeasuredBatchSize: matching.at(-1)!.batchSize,
      }
      : {
        chainLength,
        status: "observed" as const,
        batchSize: crossover.batchSize,
      };
  });
}

function solveLeastSquares(
  rows: readonly {
    readonly predictors: readonly [number, number, number];
    readonly observed: number;
  }[],
): readonly [number, number, number] {
  const normal = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const row of rows) {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        normal[i]![j] += row.predictors[i]! * row.predictors[j]!;
      }
      normal[i]![3] += row.predictors[i]! * row.observed;
    }
  }
  for (let pivot = 0; pivot < 3; pivot += 1) {
    let selected = pivot;
    for (let row = pivot + 1; row < 3; row += 1) {
      if (
        Math.abs(normal[row]![pivot]!) > Math.abs(normal[selected]![pivot]!)
      ) {
        selected = row;
      }
    }
    [normal[pivot], normal[selected]] = [normal[selected]!, normal[pivot]!];
    const divisor = normal[pivot]![pivot]!;
    if (Math.abs(divisor) < Number.EPSILON) {
      throw new Error("crossover fit design matrix is singular");
    }
    for (let column = pivot; column < 4; column += 1) {
      normal[pivot]![column] /= divisor;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === pivot) continue;
      const factor = normal[row]![pivot]!;
      for (let column = pivot; column < 4; column += 1) {
        normal[row]![column] -= factor * normal[pivot]![column]!;
      }
    }
  }
  return [normal[0]![3]!, normal[1]![3]!, normal[2]![3]!];
}

function dot(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function arithmeticChainModule(chainLength: number): BlotRuntimeModule {
  const span = { file: `chain-${chainLength}.blot`, start: 0, end: 0 };
  const operations:
    BlotRuntimeModule["functions"][number]["blocks"][number]["operations"] = [
      {
        kind: "constant",
        result: 1,
        type: 1,
        operands: [],
        ownership: "plain",
        value: 1n,
        span,
      },
      ...Array.from({ length: chainLength }, (_, index) => ({
        kind: "scalar" as const,
        result: index + 2,
        type: 1,
        operands: [index === 0 ? 0 : index + 1, 1],
        ownership: "plain" as const,
        operator: "add" as const,
        span,
      })),
    ];
  return {
    format: "blot-runtime-hir",
    schemaVersion: 1,
    source: span.file,
    types: [
      { kind: "unit" },
      { kind: "signed-integer-64" },
      { kind: "boolean" },
    ],
    signatures: [{ parameters: [1], result: 1, effects: [] }],
    functions: [{
      id: 0,
      name: "add_chain",
      signature: 0,
      entryBlock: 0,
      blocks: [{
        id: 0,
        parameters: [{ value: 0, type: 1, ownership: "plain", span }],
        operations,
        terminator: {
          kind: "return",
          value: chainLength + 1,
          span,
        },
      }],
      span,
    }],
    capabilities: [],
    exports: [{
      sourceName: "add_chain",
      phase: "runtime",
      wasmName: "blot:add_chain",
      function: 0,
      signature: 0,
      ownership: "owned",
    }],
  };
}

function emptyCellSamples(): CellSamples {
  return {
    emission: emptyBoundarySamples(),
    residentEmission: emptyBoundarySamples(),
    runtimeHirToValidatedWasm: emptyBoundarySamples(),
  };
}

function emptyBoundarySamples(): BoundarySamples {
  return { cpu: [], gpu: [] };
}

function cellKey(cell: Cell): string {
  return `${cell.chainLength}:${cell.batchSize}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const sampleArgument = arguments_.find((argument) =>
    argument.startsWith("--samples=")
  );
  if (sampleArgument === undefined) return 6;
  const count = Number.parseInt(sampleArgument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 2 || count % 2 !== 0) {
    throw new TypeError(
      `--samples must be an even integer of at least 2; received ${sampleArgument}`,
    );
  }
  return count;
}

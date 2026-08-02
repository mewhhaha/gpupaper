import {
  buildGpupaperBatch,
  type GpupaperBuildOutcome,
} from "../../blot/src/backend/gpupaper.ts";
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
} from "./benchmark_environment.ts";

const samples = requestedSamples(Deno.args);
const allowContended = Deno.args.includes("--allow-contended");
const environmentAtStart = await inspectBenchmarkEnvironment();
if (environmentAtStart.status !== "clear" && !allowContended) {
  console.log(JSON.stringify({
    status: "refused",
    reason: environmentAtStart.status === "contended"
      ? "competing compiler or GPU work is active"
      : "compiler or GPU load inspection failed",
    environment: environmentAtStart,
  }));
  Deno.exit(2);
}

const root = new URL("../../blot/examples/", import.meta.url);
const paths: string[] = [];
for await (const entry of Deno.readDir(root)) {
  if (entry.isFile && entry.name.endsWith(".blot")) {
    paths.push(new URL(entry.name, root).pathname);
  }
}
paths.sort();
requireBuilt(await buildGpupaperBatch(paths), "packed warmup");

const packedMilliseconds: number[] = [];
const singletonMilliseconds: number[] = [];
let lastPacked: readonly GpupaperBuildOutcome[] = [];
let lastSingleton: readonly GpupaperBuildOutcome[] = [];
for (let sample = 0; sample < samples; sample += 1) {
  const order = sample % 2 === 0
    ? ["packed", "singleton"] as const
    : ["singleton", "packed"] as const;
  for (const mode of order) {
    const started = performance.now();
    if (mode === "packed") {
      lastPacked = await buildGpupaperBatch(paths);
      requireBuilt(lastPacked, `packed sample ${sample}`);
      packedMilliseconds.push(performance.now() - started);
      continue;
    }
    const outcomes: GpupaperBuildOutcome[] = [];
    for (const path of paths) {
      outcomes.push(...await buildGpupaperBatch([path]));
    }
    lastSingleton = outcomes;
    requireBuilt(lastSingleton, `singleton sample ${sample}`);
    singletonMilliseconds.push(performance.now() - started);
  }
}
requireEqualArtifacts(lastPacked, lastSingleton);

const environmentAtEnd = await inspectBenchmarkEnvironment();
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";
const validity = environmentClear
  ? { status: "admissible" as const }
  : allowContended
  ? {
    status: "diagnostic" as const,
    reason: "competing compiler or GPU work was present during measurement",
  }
  : {
    status: "refused" as const,
    reason: "competing compiler or GPU work appeared during measurement",
  };
const packedP50 = percentile(packedMilliseconds, 0.5);
const singletonP50 = percentile(singletonMilliseconds, 0.5);
const built = lastPacked.filter((outcome) => outcome.status === "built");
console.log(JSON.stringify(
  {
    status: validity.status === "refused" ? "refused" : "completed",
    validity,
    schemaVersion: 1,
    workload: "../blot/examples/*.blot",
    files: paths.length,
    samples,
    warmups: 1,
    boundary:
      "warm process and Blot preparation cache, all top-level examples to byte-identical Wasm",
    runOrder: Array.from(
      { length: samples },
      (_, sample) =>
        sample % 2 === 0 ? ["packed", "singleton"] : ["singleton", "packed"],
    ).flat(),
    repositories: {
      gpupaper: await repositoryIdentity(
        new URL("../", import.meta.url).pathname,
      ),
      blot: await repositoryIdentity(
        new URL("../../blot/", import.meta.url).pathname,
      ),
    },
    environmentAtStart,
    environmentAtEnd,
    packed: {
      p50Milliseconds: packedP50,
      p95Milliseconds: percentile(packedMilliseconds, 0.95),
      rawMilliseconds: packedMilliseconds,
      modulesPerSecond: paths.length / (packedP50 / 1_000),
    },
    singleton: {
      p50Milliseconds: singletonP50,
      p95Milliseconds: percentile(singletonMilliseconds, 0.95),
      rawMilliseconds: singletonMilliseconds,
      modulesPerSecond: paths.length / (singletonP50 / 1_000),
    },
    singletonToPackedP50Ratio: singletonP50 / packedP50,
    pairedPackedMinusSingletonMilliseconds: packedMilliseconds.map(
      (milliseconds, index) => milliseconds - singletonMilliseconds[index],
    ),
    wasmBytes: built.reduce(
      (sum, outcome) => sum + outcome.wasm.byteLength,
      0,
    ),
  },
  null,
  2,
));
if (validity.status === "refused") Deno.exit(2);

function requireBuilt(
  outcomes: readonly GpupaperBuildOutcome[],
  subject: string,
): void {
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  if (failed.length === 0) return;
  throw new Error(
    `${subject} failed: ${
      failed.map((outcome) => `${outcome.path}: ${String(outcome.cause)}`).join(
        "; ",
      )
    }`,
  );
}

function requireEqualArtifacts(
  packed: readonly GpupaperBuildOutcome[],
  singleton: readonly GpupaperBuildOutcome[],
): void {
  if (packed.length !== singleton.length) {
    throw new Error(
      `packed target returned ${packed.length} outcomes; singleton target returned ${singleton.length}`,
    );
  }
  for (const [index, packedOutcome] of packed.entries()) {
    const singletonOutcome = singleton[index];
    if (
      packedOutcome.status !== "built" || singletonOutcome?.status !== "built"
    ) {
      throw new Error(`target artifact ${index} was not built on both paths`);
    }
    if (
      packedOutcome.path !== singletonOutcome.path ||
      !byteArraysEqual(packedOutcome.wasm, singletonOutcome.wasm) ||
      !byteArraysEqual(
        packedOutcome.manifestBytes,
        singletonOutcome.manifestBytes,
      )
    ) {
      throw new Error(
        `packed artifact ${index} differs from singleton compilation`,
      );
    }
  }
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function requestedSamples(arguments_: readonly string[]): number {
  const argument = arguments_.find((candidate) =>
    candidate.startsWith("--samples=")
  );
  const value = argument === undefined
    ? 4
    : Number(argument.slice("--samples=".length));
  if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
    throw new RangeError(
      `--samples must be a positive even integer; received ${value}`,
    );
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = fraction * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

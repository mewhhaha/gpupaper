import { compileModuleSource } from "../src/compiler.ts";
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
} from "./benchmark_environment.ts";

const sampleCount = requestedSampleCount(Deno.args);
const allowContended = Deno.args.includes("--allow-contended");
const textEncoder = new TextEncoder();
const gpupaperDirectory = new URL("../", import.meta.url).pathname;
const gpufuckDirectory = new URL("../../gpufuck/", import.meta.url).pathname;
const blotDirectory = new URL("../../blot/", import.meta.url).pathname;
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
const gpupaperFile = new URL(
  "../examples/binned/live/case-studies/grep/grep.duck",
  import.meta.url,
).pathname;
const gpupaperHost = new URL(
  "../examples/binned/live/case-studies/grep/host.duck",
  import.meta.url,
).pathname;
const blotFile = new URL("../../blot/examples/tour.blot", import.meta.url)
  .pathname;
const gpupaperSource = await Deno.readTextFile(gpupaperFile);
const blotSource = await Deno.readTextFile(blotFile);
const gpupaperSourceSha256 = await sha256(textEncoder.encode(gpupaperSource));
const blotSourceSha256 = await sha256(textEncoder.encode(blotSource));
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) throw new Error("peer benchmark has no WebGPU adapter");

const gpupaper = await measure(async () => {
  const artifact = await compileModuleSource(gpupaperFile, gpupaperSource, {
    gpuMode: "required",
    gpuWasmVerification: "none",
    gpuScheduling: "latency",
    hostInterface: gpupaperHost,
  });
  return artifact.wasm;
});

const blot = await measurePeer(
  "Blot",
  () => measureBlot(blotFile, sampleCount),
);

const gpufuck = await measurePeer("gpufuck", () => measureGpufuck(sampleCount));
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
    reason: environmentAtEnd.status === "contended"
      ? "competing compiler or GPU work appeared during measurement"
      : "compiler or GPU load inspection failed after measurement",
  };

console.log(JSON.stringify({
  status: validity.status === "refused" ? "refused" : "completed",
  validity,
  schemaVersion: 4,
  sampleCount,
  warmupCount: 1,
  measurementOrder: [
    "gpupaper-source",
    "blot-source",
    "gpufuck-surface",
    "alternating-equal-blot-source-boundary",
  ],
  runtime: {
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    typescript: Deno.version.typescript,
    os: Deno.build.os,
    architecture: Deno.build.arch,
  },
  repositories: {
    gpupaper: await repositoryIdentity(gpupaperDirectory),
    gpufuck: await repositoryIdentity(gpufuckDirectory),
    blot: await repositoryIdentity(blotDirectory),
  },
  environmentAtStart,
  environmentAtEnd,
  adapter: {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  },
  measurements: [
    {
      compiler: "gpupaper",
      boundaryId: "duck-source-to-wasm",
      boundary: "Ducklang source to Wasm",
      boundaryComparable: false,
      workload: "Binned grep",
      sourceBytes: textEncoder.encode(gpupaperSource).byteLength,
      inputSha256: gpupaperSourceSha256,
      ...gpupaper,
    },
    {
      compiler: "blot",
      boundaryId: "blot-source-to-wasm-through-gpufuck",
      boundary: "Blot source to Wasm through gpufuck",
      boundaryComparable: false,
      workload: "Blot tour",
      sourceBytes: textEncoder.encode(blotSource).byteLength,
      inputSha256: blotSourceSha256,
      ...blot,
    },
    {
      compiler: "gpufuck",
      boundaryId: "prepared-surface-to-wasm",
      boundary: "prepared Surface module to Wasm",
      boundaryComparable: false,
      workload: "synthetic integer addition",
      sourceBytes: textEncoder.encode("main = 40 + 2").byteLength,
      inputSha256: await sha256(textEncoder.encode("main = 40 + 2")),
      ...gpufuck,
    },
  ],
}));
if (validity.status === "refused") Deno.exit(2);

async function measure(
  compile: () => Promise<Uint8Array>,
): Promise<{
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly rawMilliseconds: readonly number[];
  readonly wasmBytes: number;
  readonly wasmSha256: string;
}> {
  await compile();
  const samples: number[] = [];
  let lastWasm: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    const wasm = await compile();
    samples.push(performance.now() - start);
    lastWasm = wasm;
  }
  return {
    p50Milliseconds: percentile(samples, 0.5),
    p95Milliseconds: percentile(samples, 0.95),
    rawMilliseconds: samples,
    wasmBytes: lastWasm.byteLength,
    wasmSha256: await sha256(lastWasm),
  };
}

async function measurePeer<Measurement extends Record<string, unknown>>(
  peer: string,
  measurePeerBoundary: () => Promise<Measurement>,
): Promise<
  ({ readonly status: "ok" } & Measurement) | {
    readonly status: "error";
    readonly error: string;
  }
> {
  try {
    return { status: "ok", ...await measurePeerBoundary() };
  } catch (cause) {
    return {
      status: "error",
      error: cause instanceof Error
        ? cause.message
        : `${peer} peer benchmark failed: ${String(cause)}`,
    };
  }
}

async function measureBlot(
  file: string,
  samples: number,
): Promise<{
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly rawMilliseconds: readonly number[];
  readonly wasmBytes: number;
  readonly wasmSha256: string;
}> {
  const blotDirectory = new URL("../../blot/", import.meta.url).pathname;
  const source = `
    import { build } from "./src/backend/compile.ts";
    const file = ${JSON.stringify(file)};
    const sampleCount = ${samples};
    await build(file);
    const timings = [];
    let lastWasm = new Uint8Array();
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const start = performance.now();
      const built = await build(file);
      timings.push(performance.now() - start);
      lastWasm = built.wasm;
    }
    const percentile = (quantile) => {
      const ordered = [...timings].sort((left, right) => left - right);
      return ordered[Math.ceil((ordered.length - 1) * quantile)];
    };
    console.log(JSON.stringify({
      p50Milliseconds: percentile(0.5),
      p95Milliseconds: percentile(0.95),
      wasmBytes: lastWasm.byteLength,
      rawMilliseconds: timings,
      wasmSha256: Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", lastWasm)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    }));
  `;
  const command = new Deno.Command(Deno.execPath(), {
    cwd: blotDirectory,
    args: [
      "eval",
      "--unstable-webgpu",
      source,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `Blot peer benchmark failed: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

async function measureGpufuck(
  samples: number,
): Promise<{
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly rawMilliseconds: readonly number[];
  readonly wasmBytes: number;
  readonly wasmSha256: string;
}> {
  const gpufuckDirectory = new URL("../../gpufuck/", import.meta.url).pathname;
  const source = `
    import {
      BinaryOperator,
      buildSurfaceModule,
      compileModuleToWasm,
      GpuCompiler,
      requestWebGpuDevice,
      surface,
    } from "./functional.ts";
    const sampleCount = ${samples};
    const device = await requestWebGpuDevice();
    const compiler = await GpuCompiler.create(device);
    const compile = async () => {
      const module = buildSurfaceModule(
        [{
          name: "main",
          parameters: [],
          annotation: null,
          body: surface.binary(
            BinaryOperator.Add,
            surface.integer(40),
            surface.integer(2),
          ),
        }],
        [],
        "main",
        new TextEncoder().encode("main = 40 + 2").byteLength,
        {},
      );
      const compilation = await compiler.compileModule(module);
      if (!compilation.ok) {
        throw new Error(
          compilation.diagnostics.map((diagnostic) => diagnostic.message)
            .join("; "),
        );
      }
      try {
        return await compileModuleToWasm(compilation.module);
      } finally {
        compilation.module.destroy();
      }
    };
    await compile();
    const timings = [];
    let lastWasm = new Uint8Array();
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const start = performance.now();
      const wasm = await compile();
      timings.push(performance.now() - start);
      lastWasm = wasm;
    }
    device.destroy();
    const percentile = (quantile) => {
      const ordered = [...timings].sort((left, right) => left - right);
      return ordered[Math.ceil((ordered.length - 1) * quantile)];
    };
    console.log(JSON.stringify({
      p50Milliseconds: percentile(0.5),
      p95Milliseconds: percentile(0.95),
      wasmBytes: lastWasm.byteLength,
      rawMilliseconds: timings,
      wasmSha256: Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", lastWasm)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    }));
  `;
  const command = new Deno.Command(Deno.execPath(), {
    cwd: gpufuckDirectory,
    args: ["eval", "--no-check", "--unstable-webgpu", source],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `gpufuck peer benchmark failed: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil((ordered.length - 1) * quantile)]!;
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const sampleArgument = arguments_.find((argument) =>
    argument.startsWith("--samples=")
  );
  if (sampleArgument === undefined) return 15;
  const count = Number.parseInt(sampleArgument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new TypeError(
      `--samples must be a positive integer; received ${sampleArgument}`,
    );
  }
  return count;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

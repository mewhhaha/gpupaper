import { compileModuleSource } from "../src/compiler.ts";

const sampleCount = requestedSampleCount(Deno.args);
const textEncoder = new TextEncoder();
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

console.log(JSON.stringify({
  sampleCount,
  adapter: {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  },
  measurements: [
    {
      compiler: "gpupaper",
      boundary: "Ducklang source to Wasm",
      workload: "Binned grep",
      sourceBytes: textEncoder.encode(gpupaperSource).byteLength,
      ...gpupaper,
    },
    {
      compiler: "blot",
      boundary: "Blot source to Wasm through gpufuck",
      workload: "Blot tour",
      sourceBytes: textEncoder.encode(blotSource).byteLength,
      ...blot,
    },
    {
      compiler: "gpufuck",
      boundary: "prepared Surface module to Wasm",
      workload: "synthetic integer addition",
      sourceBytes: textEncoder.encode("main = 40 + 2").byteLength,
      ...gpufuck,
    },
  ],
}));

async function measure(
  compile: () => Promise<Uint8Array>,
): Promise<{
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly wasmBytes: number;
}> {
  await compile();
  const samples: number[] = [];
  let wasmBytes = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    const wasm = await compile();
    samples.push(performance.now() - start);
    wasmBytes = wasm.byteLength;
  }
  return {
    p50Milliseconds: percentile(samples, 0.5),
    p95Milliseconds: percentile(samples, 0.95),
    wasmBytes,
  };
}

async function measurePeer(
  peer: string,
  measurePeerBoundary: () => Promise<{
    readonly p50Milliseconds: number;
    readonly p95Milliseconds: number;
    readonly wasmBytes: number;
  }>,
): Promise<
  | {
    readonly status: "ok";
    readonly p50Milliseconds: number;
    readonly p95Milliseconds: number;
    readonly wasmBytes: number;
  }
  | { readonly status: "error"; readonly error: string }
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
  readonly wasmBytes: number;
}> {
  const blotDirectory = new URL("../../blot/", import.meta.url).pathname;
  const source = `
    import { build } from "./src/backend/compile.ts";
    const file = ${JSON.stringify(file)};
    const sampleCount = ${samples};
    await build(file);
    const timings = [];
    let wasmBytes = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const start = performance.now();
      const built = await build(file);
      timings.push(performance.now() - start);
      wasmBytes = built.wasm.byteLength;
    }
    timings.sort((left, right) => left - right);
    const percentile = (quantile) =>
      timings[Math.ceil((timings.length - 1) * quantile)];
    console.log(JSON.stringify({
      p50Milliseconds: percentile(0.5),
      p95Milliseconds: percentile(0.95),
      wasmBytes,
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
  readonly wasmBytes: number;
}> {
  const gpufuckDirectory = new URL("../../gpufuck/", import.meta.url).pathname;
  const source = `
    import {
      BinaryOperator,
      buildSurfaceModule,
      compileModuleToWasm,
      EvaluationProfile,
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
        { evaluationProfile: EvaluationProfile.StrictEager },
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
    let wasmBytes = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const start = performance.now();
      const wasm = await compile();
      timings.push(performance.now() - start);
      wasmBytes = wasm.byteLength;
    }
    device.destroy();
    timings.sort((left, right) => left - right);
    const percentile = (quantile) =>
      timings[Math.ceil((timings.length - 1) * quantile)];
    console.log(JSON.stringify({
      p50Milliseconds: percentile(0.5),
      p95Milliseconds: percentile(0.95),
      wasmBytes,
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

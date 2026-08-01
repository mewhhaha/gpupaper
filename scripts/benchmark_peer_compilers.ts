import { compileModuleSource } from "../src/compiler.ts";

const sampleCount = requestedSampleCount(Deno.args);
const textEncoder = new TextEncoder();
const gpupaperDirectory = new URL("../", import.meta.url).pathname;
const gpufuckDirectory = new URL("../../gpufuck/", import.meta.url).pathname;
const blotDirectory = new URL("../../blot/", import.meta.url).pathname;
const environmentAtStart = await inspectBenchmarkEnvironment();
if (environmentAtStart.status !== "clear") {
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
const equalBlotSource = "return 42;\n";
const gpupaperSourceSha256 = await sha256(textEncoder.encode(gpupaperSource));
const blotSourceSha256 = await sha256(textEncoder.encode(blotSource));
const equalBlotSourceSha256 = await sha256(
  textEncoder.encode(equalBlotSource),
);
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
const equalBlotBoundary = await measurePeer(
  "equal Blot source boundary",
  () =>
    measureEqualBlotSourceBoundary(
      equalBlotSource,
      equalBlotSourceSha256,
      sampleCount,
    ),
);
const environmentAtEnd = await inspectBenchmarkEnvironment();
const validity = environmentAtEnd.status === "clear"
  ? { status: "admissible" as const }
  : {
    status: "refused" as const,
    reason: environmentAtEnd.status === "contended"
      ? "competing compiler or GPU work appeared during measurement"
      : "compiler or GPU load inspection failed after measurement",
  };

console.log(JSON.stringify({
  status: validity.status === "admissible" ? "completed" : "refused",
  validity,
  schemaVersion: 3,
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
    ...(equalBlotBoundary.status === "ok" ? equalBlotBoundary.measurements : [{
      compiler: "equal-boundary",
      boundaryId: "warm-process-cold-session-blot-source-to-wasm",
      boundary: "warm-process, cold-session Blot source to Wasm",
      boundaryComparable: true,
      workload: "return one I64 literal",
      sourceBytes: textEncoder.encode(equalBlotSource).byteLength,
      inputSha256: equalBlotSourceSha256,
      ...equalBlotBoundary,
    }]),
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

async function measureEqualBlotSourceBoundary(
  sourceText: string,
  sourceSha256: string,
  samples: number,
): Promise<{ readonly measurements: readonly Record<string, unknown>[] }> {
  const gpupaperCompilerUrl = new URL(
    "../src/compiler.ts",
    import.meta.url,
  ).href;
  const blotCompilerUrl = new URL(
    "../../blot/src/backend/compile.ts",
    import.meta.url,
  ).href;
  const localGpufuckUrl = new URL(
    "../../gpufuck/functional.ts",
    import.meta.url,
  ).href;
  const importMap = `data:application/json,${
    encodeURIComponent(JSON.stringify({
      imports: {
        gpufuck: localGpufuckUrl,
        "@mewhhaha/baba": "jsr:@mewhhaha/baba@7.10.0",
        "@mewhhaha/baba/runtime/generated-wasm":
          "jsr:@mewhhaha/baba@7.10.0/runtime/generated-wasm",
        "@mewhhaha/baba/runtime/webgpu":
          "jsr:@mewhhaha/baba@7.10.0/runtime/webgpu",
        "@std/path": "jsr:@std/path@1.1.6",
      },
    }))
  }`;
  const source = `
    import { compileModuleSource } from ${JSON.stringify(gpupaperCompilerUrl)};
    import { build } from ${JSON.stringify(blotCompilerUrl)};

    const sampleCount = ${samples};
    const sourceText = ${JSON.stringify(sourceText)};
    const sourceSha256 = ${JSON.stringify(sourceSha256)};
    const sourcePath = await Deno.makeTempFile({ suffix: ".blot" });
    await Deno.writeTextFile(sourcePath, sourceText);
    const emitGpupaper = async () => {
      const artifact = await compileModuleSource(sourcePath, sourceText, {
        gpuMode: "required",
        gpuWasmVerification: "none",
        gpuScheduling: "latency",
      });
      if (artifact.language !== "blot") {
        throw new Error("gpupaper selected " + artifact.language + " for Blot source");
      }
      return artifact.wasm;
    };
    const emitGpufuck = async () => (await build(sourcePath)).wasm;
    try {
      await emitGpupaper();
      await emitGpufuck();
      const gpupaperTimes = [];
      const gpufuckTimes = [];
      let gpupaperBytes = new Uint8Array();
      let gpufuckBytes = new Uint8Array();
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const ordered = sample % 2 === 0
          ? [["gpupaper", emitGpupaper], ["gpufuck", emitGpufuck]]
          : [["gpufuck", emitGpufuck], ["gpupaper", emitGpupaper]];
        for (const [compiler, emit] of ordered) {
          const start = performance.now();
          const bytes = await emit();
          const elapsed = performance.now() - start;
          if (compiler === "gpupaper") {
            gpupaperTimes.push(elapsed);
            gpupaperBytes = bytes;
          } else {
            gpufuckTimes.push(elapsed);
            gpufuckBytes = bytes;
          }
        }
      }
      const validate = async (compiler, exportName, bytes) => {
        if (!WebAssembly.validate(bytes)) {
          throw new Error(compiler + " emitted invalid Wasm");
        }
        const { instance } = await WebAssembly.instantiate(bytes);
        const exported = instance.exports[exportName];
        if (typeof exported !== "function") {
          throw new Error(compiler + " omitted function export " + exportName);
        }
        const result = exported();
        if (result !== 42n) {
          throw new Error(compiler + " returned " + result + "; expected 42");
        }
      };
      await validate("gpupaper", "main", gpupaperBytes);
      await validate("gpufuck", "blot:default", gpufuckBytes);
      const digest = async (bytes) => Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const summarize = async (compiler, timings, bytes) => {
        const ordered = [...timings].sort((left, right) => left - right);
        const percentile = (quantile) =>
          ordered[Math.ceil((ordered.length - 1) * quantile)];
        return {
          compiler,
          boundaryId: "warm-process-cold-session-blot-source-to-wasm",
          boundary: "warm-process, cold-session Blot source to Wasm",
          boundaryComparable: true,
          workload: "return one I64 literal",
          sourceBytes: new TextEncoder().encode(sourceText).byteLength,
          inputSha256: sourceSha256,
          p50Milliseconds: percentile(0.5),
          p95Milliseconds: percentile(0.95),
          rawMilliseconds: timings,
          runOrder: Array.from({ length: sampleCount }, (_, sample) =>
            sample % 2 === 0
              ? ["gpupaper", "gpufuck"]
              : ["gpufuck", "gpupaper"]
          ).flat(),
          wasmBytes: bytes.byteLength,
          wasmSha256: await digest(bytes),
          semanticResult: "42n",
        };
      };
      console.log(JSON.stringify({
        measurements: [
          await summarize("gpupaper", gpupaperTimes, gpupaperBytes),
          await summarize("gpufuck", gpufuckTimes, gpufuckBytes),
        ],
      }));
    } finally {
      await Deno.remove(sourcePath);
    }
  `;
  const command = new Deno.Command(Deno.execPath(), {
    cwd: blotDirectory,
    args: [
      "eval",
      "--no-check",
      "--unstable-webgpu",
      `--config=${new URL("../../blot/deno.json", import.meta.url).pathname}`,
      `--import-map=${importMap}`,
      source,
    ],
    stdout: "piped",
    stderr: "piped",
    env: { GPUPAPER_DIRECTORY: gpupaperDirectory },
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `equal Blot source boundary failed: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
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

type BenchmarkEnvironment = {
  readonly status: "clear" | "contended" | "unknown";
  readonly competingProcesses: readonly {
    readonly pid: number;
    readonly command: string;
  }[];
  readonly gpuProcesses: readonly {
    readonly pid: number;
    readonly command: string;
    readonly memoryMiB: number;
  }[];
  readonly nvidiaDevices: readonly {
    readonly name: string;
    readonly driverVersion: string;
    readonly pciDeviceId: string;
  }[];
  readonly inspectionErrors: readonly string[];
};

async function inspectBenchmarkEnvironment(): Promise<BenchmarkEnvironment> {
  const inspections = await Promise.allSettled([
    inspectCompilerProcesses(),
    inspectNvidiaComputeProcesses(),
    inspectNvidiaDevices(),
  ]);
  const inspectionErrors = inspections.flatMap((inspection) =>
    inspection.status === "rejected"
      ? [
        inspection.reason instanceof Error
          ? inspection.reason.message
          : String(inspection.reason),
      ]
      : []
  );
  const competingProcesses = inspections[0].status === "fulfilled"
    ? inspections[0].value
    : [];
  const gpuProcesses = inspections[1].status === "fulfilled"
    ? inspections[1].value
    : [];
  const nvidiaDevices = inspections[2].status === "fulfilled"
    ? inspections[2].value
    : [];
  return {
    status: inspectionErrors.length > 0
      ? "unknown"
      : competingProcesses.length === 0 && gpuProcesses.length === 0
      ? "clear"
      : "contended",
    competingProcesses,
    gpuProcesses,
    nvidiaDevices,
    inspectionErrors,
  };
}

async function inspectCompilerProcesses(): Promise<
  readonly { readonly pid: number; readonly command: string }[]
> {
  if (Deno.build.os !== "linux") {
    throw new Error(
      `compiler process inspection is unsupported on ${Deno.build.os}`,
    );
  }
  const output = await new Deno.Command("ps", {
    args: ["-eo", "pid=,ppid=,args="],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `ps process inspection failed: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  const records = new TextDecoder().decode(output.stdout).split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match === null ? [] : [{
        pid: Number.parseInt(match[1], 10),
        parentPid: Number.parseInt(match[2], 10),
        command: match[3],
      }];
    });
  const parentByPid = new Map(
    records.map((record) => [record.pid, record.parentPid]),
  );
  const ancestors = new Set<number>([Deno.pid]);
  let ancestor = parentByPid.get(Deno.pid);
  while (ancestor !== undefined && ancestor > 0 && !ancestors.has(ancestor)) {
    ancestors.add(ancestor);
    ancestor = parentByPid.get(ancestor);
  }
  return records.flatMap(({ pid, command }) => {
    if (ancestors.has(pid)) return [];
    if (!/(?:deno|node|cargo|cabal).*(?:test|bench|benchmark)/i.test(command)) {
      return [];
    }
    return [{ pid, command }];
  });
}

async function inspectNvidiaComputeProcesses(): Promise<
  readonly {
    readonly pid: number;
    readonly command: string;
    readonly memoryMiB: number;
  }[]
> {
  const output = await new Deno.Command("nvidia-smi", {
    args: [
      "--query-compute-apps=pid,process_name,used_gpu_memory",
      "--format=csv,noheader,nounits",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `NVIDIA process inspection failed: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim().split("\n").flatMap(
    (line) => {
      if (line.length === 0) return [];
      const [pidText, command, memoryText] = line.split(",").map((field) =>
        field.trim()
      );
      const pid = Number.parseInt(pidText, 10);
      if (pid === Deno.pid) return [];
      if (!/(?:deno|node|cargo|cabal|gpupaper|gpufuck)/i.test(command)) {
        return [];
      }
      return [{
        pid,
        command,
        memoryMiB: Number.parseInt(memoryText, 10),
      }];
    },
  );
}

async function inspectNvidiaDevices(): Promise<
  readonly {
    readonly name: string;
    readonly driverVersion: string;
    readonly pciDeviceId: string;
  }[]
> {
  const output = await new Deno.Command("nvidia-smi", {
    args: [
      "--query-gpu=name,driver_version,pci.device_id",
      "--format=csv,noheader,nounits",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `NVIDIA device inspection failed: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim().split("\n").flatMap(
    (line) => {
      if (line.length === 0) return [];
      const [name, driverVersion, pciDeviceId] = line.split(",").map((field) =>
        field.trim()
      );
      return [{ name, driverVersion, pciDeviceId }];
    },
  );
}

async function repositoryIdentity(directory: string): Promise<{
  readonly revision: string;
  readonly status: readonly string[];
  readonly trackedDiffSha256: string;
  readonly untrackedFiles: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}> {
  const revision = new TextDecoder().decode(
    await runGit(directory, ["rev-parse", "HEAD"]),
  ).trim();
  const status = new TextDecoder().decode(
    await runGit(directory, ["status", "--short"]),
  ).trim().split("\n").filter((line) => line.length > 0);
  const trackedDiffSha256 = await sha256(
    await runGit(directory, ["diff", "--binary", "HEAD", "--"]),
  );
  const untrackedPaths = new TextDecoder().decode(
    await runGit(directory, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ).split("\0").filter((path) => path.length > 0).sort();
  const untrackedFiles = await Promise.all(
    untrackedPaths.map(async (path) => ({
      path,
      sha256: await sha256(await Deno.readFile(`${directory}/${path}`)),
    })),
  );
  return { revision, status, trackedDiffSha256, untrackedFiles };
}

async function runGit(
  directory: string,
  arguments_: readonly string[],
): Promise<Uint8Array> {
  const output = await new Deno.Command("git", {
    args: ["-C", directory, ...arguments_],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `git ${arguments_.join(" ")} failed for ${directory}: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return output.stdout;
}

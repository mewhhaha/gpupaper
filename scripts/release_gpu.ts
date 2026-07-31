import { compileModuleSource } from "../src/compiler.ts";
import { requestCompilerGpuDevice } from "../src/gpu_device.ts";

const targets = [
  target("editor", 24_460, 5_000, "editor/host.duck"),
  target("codex", 226_134, 10_000, "codex/host.duck"),
  target("grep", 3_911, 3_000, "grep/host.duck"),
  target("tar", 26_106, 3_000, "tar/host.duck"),
  target("wav", 2_520, 3_000),
  target("raytracer", 3_864, 3_000),
] as const;

const deviceRequest = await requestCompilerGpuDevice();
if (deviceRequest.status === "unavailable") {
  throw new Error(`GPU release gate requires WebGPU: ${deviceRequest.reason}`);
}
console.log(JSON.stringify({
  gate: "adapter",
  status: "completed",
  limits: {
    maxBufferSize: deviceRequest.device.limits.maxBufferSize,
    maxStorageBufferBindingSize:
      deviceRequest.device.limits.maxStorageBufferBindingSize,
    maxUniformBufferBindingSize:
      deviceRequest.device.limits.maxUniformBufferBindingSize,
    maxComputeWorkgroupsPerDimension:
      deviceRequest.device.limits.maxComputeWorkgroupsPerDimension,
    maxStorageBuffersPerShaderStage:
      deviceRequest.device.limits.maxStorageBuffersPerShaderStage,
    maxUniformBuffersPerShaderStage:
      deviceRequest.device.limits.maxUniformBuffersPerShaderStage,
  },
}));

await requireMalformedInputRejection();

for (const target_ of targets) {
  const source = await Deno.readTextFile(target_.source);
  const samples: number[] = [];
  let expectedBytes: Uint8Array | undefined;
  for (let sample = 0; sample < 2; sample += 1) {
    const start = performance.now();
    const artifact = await compileModuleSource(target_.source, source, {
      gpuMode: "required",
      gpuWasmVerification: "differential",
      hostInterface: target_.hostInterface,
    });
    const milliseconds = performance.now() - start;
    samples.push(milliseconds);
    if (milliseconds > target_.maximumMilliseconds) {
      throw new Error(
        `${target_.name} release compilation took ${
          milliseconds.toFixed(2)
        }ms; budget is ${target_.maximumMilliseconds}ms`,
      );
    }
    if (artifact.wasm.length !== target_.wasmBytes) {
      throw new Error(
        `${target_.name} emitted ${artifact.wasm.length} bytes; release contract is ${target_.wasmBytes}`,
      );
    }
    if (
      artifact.backends.typeCheck !== "cpu" ||
      artifact.backends.comptime !== "cpu" ||
      artifact.backends.coreRewrite !== "gpu" ||
      artifact.backends.wasmEmission !== "gpu" ||
      artifact.backends.wasmVerification !== "cpuDifferential"
    ) {
      throw new Error(
        `${target_.name} did not complete every required GPU boundary: ${
          JSON.stringify(artifact.backends)
        }`,
      );
    }
    if (expectedBytes === undefined) {
      expectedBytes = artifact.wasm;
    } else if (!equalBytes(expectedBytes, artifact.wasm)) {
      throw new Error(
        `${target_.name} emitted different bytes across release samples`,
      );
    }
  }
  console.log(JSON.stringify({
    gate: "target",
    target: target_.name,
    status: "completed",
    wasmBytes: target_.wasmBytes,
    samplesMilliseconds: samples,
  }));
}

function target(
  name: string,
  wasmBytes: number,
  maximumMilliseconds: number,
  relativeHostInterface?: string,
) {
  const directory = new URL(
    "../examples/binned/live/case-studies/",
    import.meta.url,
  );
  return {
    name,
    wasmBytes,
    maximumMilliseconds,
    source: new URL(`${name}/${name}.duck`, directory).pathname,
    hostInterface: relativeHostInterface === undefined
      ? undefined
      : new URL(relativeHostInterface, directory).pathname,
  };
}

async function requireMalformedInputRejection(): Promise<void> {
  try {
    await compileModuleSource("malformed.duck", "let =\n", {
      gpuMode: "required",
    });
  } catch (error) {
    console.log(JSON.stringify({
      gate: "malformedInput",
      status: "completed",
      diagnostic: error instanceof Error ? error.message : String(error),
    }));
    return;
  }
  throw new Error("malformed Ducklang passed the release compiler");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

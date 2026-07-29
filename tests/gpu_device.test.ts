import {
  awaitCompilerGpuCommand,
  compilerGpuCapacityViolation,
  type CompilerGpuLimits,
  compilerGpuUnavailabilityReason,
} from "../src/gpu_device.ts";

const limits: CompilerGpuLimits = {
  maxBufferSize: 1_024,
  maxStorageBufferBindingSize: 512,
  maxUniformBufferBindingSize: 256,
  maxComputeWorkgroupsPerDimension: 64,
  maxStorageBuffersPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 4,
};

Deno.test("GPU capacity accepts requests at every device limit", () => {
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "buffer",
      label: "Core operations",
      byteLength: 512,
      binding: "storage",
    }),
    undefined,
  );
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "pipelineBindings",
      label: "Core rewrite",
      storageBufferCount: 8,
      uniformBufferCount: 1,
    }),
    undefined,
  );
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "buffer",
      label: "readback",
      byteLength: 1_024,
      binding: "copy",
    }),
    undefined,
  );
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "dispatch",
      label: "Core rewrite",
      workgroupCount: 64,
    }),
    undefined,
  );
});

Deno.test("GPU capacity reports the exact exceeded boundary", () => {
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "buffer",
      label: "Core operations",
      byteLength: 516,
      binding: "storage",
    }),
    "GPU Core operations storage binding requires 516 bytes; device storage binding limit is 512",
  );
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "buffer",
      label: "readback",
      byteLength: 1_028,
      binding: "copy",
    }),
    "GPU readback buffer requires 1028 bytes; device buffer limit is 1024",
  );
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "dispatch",
      label: "Core rewrite",
      workgroupCount: 65,
    }),
    "GPU Core rewrite dispatch requires 65 workgroups; device limit is 64",
  );
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "pipelineBindings",
      label: "Core rewrite",
      storageBufferCount: 9,
      uniformBufferCount: 1,
    }),
    "GPU Core rewrite pipeline requires 9 storage buffers; device shader-stage limit is 8",
  );
});

Deno.test("GPU capacity rejects unsafe sizes before WebGPU coercion", () => {
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "buffer",
      label: "generated output",
      byteLength: Number.MAX_SAFE_INTEGER + 1,
      binding: "storage",
    }),
    `GPU generated output buffer requires a positive safe-integer byte length; received ${
      Number.MAX_SAFE_INTEGER + 1
    }`,
  );
  assertEquals(
    compilerGpuCapacityViolation(limits, {
      kind: "dispatch",
      label: "generated work",
      workgroupCount: 0,
    }),
    "GPU generated work dispatch requires a positive safe-integer workgroup count; received 0",
  );
});

Deno.test("GPU command wait reports device loss with driver evidence", async () => {
  const device = {
    lost: Promise.resolve({
      reason: "unknown",
      message: "adapter reset",
    }),
  } as GPUDevice;

  await assertRejects(
    () =>
      awaitCompilerGpuCommand(
        device,
        "Core rewrite",
        new Promise<never>(() => {}),
      ),
    /Core rewrite: WebGPU device was lost \(unknown\): adapter reset/,
  );
});

Deno.test("GPU out-of-memory errors are classified as unavailability", () => {
  const error = new Error("allocation failed");
  error.name = "GPUOutOfMemoryError";

  assertEquals(
    compilerGpuUnavailabilityReason("Wasm emission", error),
    "Wasm emission: WebGPU ran out of memory: allocation failed",
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}; received ${String(actual)}`);
  }
}

async function assertRejects(
  action: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected ${pattern}; action completed`);
}

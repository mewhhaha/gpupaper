import {
  compilerGpuCapacityViolation,
  type CompilerGpuLimits,
} from "../src/gpu_device.ts";

const limits: CompilerGpuLimits = {
  maxBufferSize: 1_024,
  maxStorageBufferBindingSize: 512,
  maxUniformBufferBindingSize: 256,
  maxComputeWorkgroupsPerDimension: 64,
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

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}; received ${String(actual)}`);
  }
}

import {
  awaitCompilerGpuCommand,
  createCompilerGpuBuffer,
  requestCompilerGpuDevice,
  submitCompilerGpuCommand,
} from "../src/gpu_device.ts";
import {
  encodeGpuExclusiveScan,
  encodeGpuSegmentedExclusiveScan,
  type GpuExclusiveScanPipelines,
  requestGpuExclusiveScanPipelines,
  requestGpuSegmentedExclusiveScanPipelines,
} from "../src/gpu_segmented_work.ts";

Deno.test("exclusive scan preserves zero and nonuniform counts", async () => {
  await assertExclusiveScan([0, 3, 1, 0, 2], [0, 0, 3, 4, 4, 6]);
});

Deno.test("exclusive scan gives an empty family one zero offset", async () => {
  await assertExclusiveScan([], [0]);
});

Deno.test("exclusive scan preserves prefixes across workgroup boundaries", async () => {
  const counts = Array.from({ length: 257 }, (_, index) => index % 5);
  const expected = [0];
  for (const count of counts) {
    expected.push(expected.at(-1)! + count);
  }

  await assertExclusiveScan(counts, expected);
});

Deno.test("exclusive scan rejects an unrepresentable terminal offset", () => {
  try {
    encodeGpuExclusiveScan(
      {} as GPUDevice,
      {} as GPUCommandEncoder,
      {} as GpuExclusiveScanPipelines,
      {} as GPUBuffer,
      0xffff_ffff,
    );
  } catch (error) {
    if (
      error instanceof RangeError &&
      /cannot be represented with its terminal offset in u32/.test(
        error.message,
      )
    ) return;
    throw new Error(
      `expected u32 terminal-offset rejection, received ${error}`,
    );
  }
  throw new Error("unrepresentable terminal offset was accepted");
});

Deno.test("segmented scan restarts the prefix at every marked head", async () => {
  await assertSegmentedExclusiveScan(
    [3, 2, 7, 5, 11, 13],
    [1, 0, 1, 0, 0, 1],
  );
});

Deno.test("segmented scan preserves sparse segments across workgroups", async () => {
  const values = Array.from({ length: 389 }, (_, index) => (index * 17) % 23);
  const heads = values.map((_, index) =>
    index === 0 || index === 127 || index === 129 || index === 300 ? 1 : 0
  );
  await assertSegmentedExclusiveScan(values, heads);
});

Deno.test("segmented scan treats nonzero heads as the same boundary marker", async () => {
  await assertSegmentedExclusiveScan([5, 7, 11, 13], [9, 0, 4, 0]);
});

Deno.test("segmented scan uses u32 modular addition", async () => {
  await assertSegmentedExclusiveScan([0xffff_ffff, 1, 2], [1, 0, 0]);
});

Deno.test("segmented scan submits no work for an empty domain", async () => {
  await assertSegmentedExclusiveScan([], []);
});

async function assertExclusiveScan(
  counts: readonly number[],
  expected: readonly number[],
): Promise<void> {
  const request = await requestCompilerGpuDevice();
  if (request.status === "unavailable") return;
  const device = request.device;
  const countWords = Uint32Array.from(counts);
  const countBuffer = createCompilerGpuBuffer(
    device,
    "segmented scan test counts",
    {
      size: Math.max(4, countWords.byteLength),
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    },
    "storage",
  );
  new Uint32Array(countBuffer.getMappedRange()).set(countWords);
  countBuffer.unmap();
  const readback = createCompilerGpuBuffer(
    device,
    "segmented scan test readback",
    {
      size: expected.length * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const pipelines = await requestGpuExclusiveScanPipelines(device);
  const encoder = device.createCommandEncoder();
  const scan = encodeGpuExclusiveScan(
    device,
    encoder,
    pipelines,
    countBuffer,
    counts.length,
  );
  const metrics = expectedHierarchicalMetrics(counts.length);
  if (scan.dispatchCount !== metrics.dispatchCount) {
    throw new Error(
      `exclusive scan reported ${scan.dispatchCount} dispatches; expected ${metrics.dispatchCount}`,
    );
  }
  if (scan.additionWorkUpperBound !== metrics.additionWork) {
    throw new Error(
      `exclusive scan reported ${scan.additionWorkUpperBound} additions; expected upper bound ${metrics.additionWork}`,
    );
  }
  if (scan.additionWork !== metrics.additionWork) {
    throw new Error(
      `exclusive scan reported ${scan.additionWork} additions; expected ${metrics.additionWork}`,
    );
  }
  if (scan.scheduledInvocationCount !== metrics.scheduledInvocationCount) {
    throw new Error(
      `exclusive scan scheduled ${scan.scheduledInvocationCount} invocations; expected ${metrics.scheduledInvocationCount}`,
    );
  }
  if (scan.temporaryBytes !== metrics.temporaryBytes) {
    throw new Error(
      `exclusive scan allocated ${scan.temporaryBytes} temporary bytes; expected ${metrics.temporaryBytes}`,
    );
  }
  encoder.copyBufferToBuffer(
    scan.offsets,
    0,
    readback,
    0,
    expected.length * 4,
  );
  let mapped = false;
  try {
    await submitCompilerGpuCommand(
      device,
      "segmented scan test",
      encoder.finish(),
      "latency",
    );
    await awaitCompilerGpuCommand(
      device,
      "segmented scan test",
      readback.mapAsync(GPUMapMode.READ),
    );
    mapped = true;
    const actual = new Uint32Array(readback.getMappedRange());
    if (
      actual.length !== expected.length ||
      actual.some((word, index) => word !== expected[index])
    ) {
      throw new Error(
        `exclusive scan produced [${actual.join(", ")}]; expected [${
          expected.join(", ")
        }]`,
      );
    }
  } finally {
    if (mapped) readback.unmap();
    countBuffer.destroy();
    readback.destroy();
    scan.ownedBuffers.forEach((buffer) => buffer.destroy());
  }
}

async function assertSegmentedExclusiveScan(
  values: readonly number[],
  heads: readonly number[],
): Promise<void> {
  if (values.length !== heads.length) {
    throw new Error(
      `segmented scan fixture has ${values.length} values but ${heads.length} heads`,
    );
  }
  const request = await requestCompilerGpuDevice();
  if (request.status === "unavailable") return;
  const device = request.device;
  const valueBuffer = createTestStorageBuffer(
    device,
    "segmented scan test values",
    values,
  );
  const headBuffer = createTestStorageBuffer(
    device,
    "segmented scan test heads",
    heads,
  );
  const expected = cpuSegmentedExclusiveScan(values, heads);
  const readback = createCompilerGpuBuffer(
    device,
    "segmented scan test readback",
    {
      size: Math.max(4, expected.byteLength),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const pipelines = await requestGpuSegmentedExclusiveScanPipelines(device);
  const encoder = device.createCommandEncoder();
  const scan = encodeGpuSegmentedExclusiveScan(
    device,
    encoder,
    pipelines,
    valueBuffer,
    headBuffer,
    values.length,
  );
  if (values.length === 0 && scan.dispatchCount !== 0) {
    throw new Error(
      `empty segmented scan submitted ${scan.dispatchCount} dispatches`,
    );
  }
  if (values.length > 0) {
    encoder.copyBufferToBuffer(
      scan.values,
      0,
      readback,
      0,
      expected.byteLength,
    );
  }
  let mapped = false;
  try {
    await submitCompilerGpuCommand(
      device,
      "segmented scan test",
      encoder.finish(),
      "latency",
    );
    if (values.length === 0) return;
    await awaitCompilerGpuCommand(
      device,
      "segmented scan test",
      readback.mapAsync(GPUMapMode.READ),
    );
    mapped = true;
    const actual = new Uint32Array(readback.getMappedRange());
    if (
      actual.length !== expected.length ||
      actual.some((word, index) => word !== expected[index])
    ) {
      throw new Error(
        `segmented scan produced [${actual.join(", ")}]; expected [${
          expected.join(", ")
        }]`,
      );
    }
  } finally {
    if (mapped) readback.unmap();
    valueBuffer.destroy();
    headBuffer.destroy();
    readback.destroy();
    scan.ownedBuffers.forEach((buffer) => buffer.destroy());
  }
}

function createTestStorageBuffer(
  device: GPUDevice,
  label: string,
  words: readonly number[],
): GPUBuffer {
  const buffer = createCompilerGpuBuffer(
    device,
    label,
    {
      size: Math.max(4, words.length * Uint32Array.BYTES_PER_ELEMENT),
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    },
    "storage",
  );
  new Uint32Array(buffer.getMappedRange()).set(words);
  buffer.unmap();
  return buffer;
}

function cpuSegmentedExclusiveScan(
  values: readonly number[],
  heads: readonly number[],
): Uint32Array {
  const expected = new Uint32Array(values.length);
  let prefix = 0;
  for (let index = 0; index < values.length; index++) {
    if (index === 0 || heads[index] !== 0) prefix = 0;
    expected[index] = prefix;
    prefix = (prefix + values[index]) >>> 0;
  }
  return expected;
}

function expectedHierarchicalMetrics(count: number): {
  readonly dispatchCount: number;
  readonly additionWork: number;
  readonly scheduledInvocationCount: number;
  readonly temporaryBytes: number;
} {
  if (count === 0) {
    return {
      dispatchCount: 0,
      additionWork: 0,
      scheduledInvocationCount: 0,
      temporaryBytes: 4,
    };
  }
  return expectedScanLevelMetrics(count + 1);
}

function expectedScanLevelMetrics(length: number): {
  readonly dispatchCount: number;
  readonly additionWork: number;
  readonly scheduledInvocationCount: number;
  readonly temporaryBytes: number;
} {
  const workgroups = Math.ceil(length / 128);
  const localAdditions = workgroups * 254;
  const localInvocations = workgroups * 128;
  const localBytes = length * 4 + workgroups * 4 + 16;
  if (workgroups === 1) {
    return {
      dispatchCount: 1,
      additionWork: localAdditions,
      scheduledInvocationCount: localInvocations,
      temporaryBytes: localBytes,
    };
  }
  const blocks = expectedScanLevelMetrics(workgroups);
  return {
    dispatchCount: blocks.dispatchCount + 2,
    additionWork: localAdditions + blocks.additionWork + length - 128,
    scheduledInvocationCount: 2 * localInvocations +
      blocks.scheduledInvocationCount,
    temporaryBytes: localBytes + blocks.temporaryBytes + 16,
  };
}

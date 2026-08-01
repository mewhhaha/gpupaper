import {
  awaitCompilerGpuCommand,
  createCompilerGpuBuffer,
  requestCompilerGpuDevice,
  submitCompilerGpuCommand,
} from "../src/gpu_device.ts";
import {
  encodeGpuExclusiveScan,
  type GpuExclusiveScanPipelines,
  requestGpuExclusiveScanPipelines,
} from "../src/gpu_segmented_work.ts";

Deno.test("segmented exclusive scan preserves zero and nonuniform counts", async () => {
  await assertExclusiveScan([0, 3, 1, 0, 2], [0, 0, 3, 4, 4, 6]);
});

Deno.test("segmented exclusive scan gives an empty family one zero offset", async () => {
  await assertExclusiveScan([], [0]);
});

Deno.test("segmented exclusive scan preserves prefixes across workgroup boundaries", async () => {
  const counts = Array.from({ length: 257 }, (_, index) => index % 5);
  const expected = [0];
  for (const count of counts) {
    expected.push(expected.at(-1)! + count);
  }

  await assertExclusiveScan(counts, expected);
});

Deno.test("segmented exclusive scan rejects an unrepresentable terminal offset", () => {
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
  const rounds = Math.ceil(Math.log2(Math.max(1, counts.length + 1)));
  if (scan.dispatchCount !== rounds + 1) {
    throw new Error(
      `exclusive scan reported ${scan.dispatchCount} dispatches; expected ${
        rounds + 1
      }`,
    );
  }
  const expectedAdditionUpperBound = (counts.length + 1) * rounds;
  if (scan.additionWorkUpperBound !== expectedAdditionUpperBound) {
    throw new Error(
      `exclusive scan reported ${scan.additionWorkUpperBound} additions; expected upper bound ${expectedAdditionUpperBound}`,
    );
  }
  const expectedAdditionWork = rounds * (counts.length + 1) -
    (2 ** rounds - 1);
  if (scan.additionWork !== expectedAdditionWork) {
    throw new Error(
      `exclusive scan reported ${scan.additionWork} conditional additions; expected ${expectedAdditionWork}`,
    );
  }
  const workgroupCount = Math.ceil((counts.length + 1) / 128);
  const expectedScheduledInvocations = workgroupCount * 128 * (rounds + 1);
  if (scan.scheduledInvocationCount !== expectedScheduledInvocations) {
    throw new Error(
      `exclusive scan scheduled ${scan.scheduledInvocationCount} invocations; expected ${expectedScheduledInvocations}`,
    );
  }
  const parameterRecordBytes = Math.max(
    8,
    device.limits.minStorageBufferOffsetAlignment,
  );
  const expectedTemporaryBytes = 8 * (counts.length + 1) +
    (rounds + 1) * parameterRecordBytes;
  if (scan.temporaryBytes !== expectedTemporaryBytes) {
    throw new Error(
      `exclusive scan allocated ${scan.temporaryBytes} temporary bytes; expected ${expectedTemporaryBytes}`,
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

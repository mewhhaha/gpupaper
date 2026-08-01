import {
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requireCompilerGpuCapacity,
} from "./gpu_device.ts";

const scanWorkgroupSize = 128;

const scanShader = /* wgsl */ `
struct ScanParameters {
  length: u32,
  stride: u32,
};

@group(0) @binding(0) var<storage, read> input_words: array<u32>;
@group(0) @binding(1) var<storage, read_write> output_words: array<u32>;
@group(0) @binding(2) var<storage, read> parameters: ScanParameters;

@compute @workgroup_size(${scanWorkgroupSize})
fn initialize_exclusive(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.length) {
    return;
  }
  if (index == 0u) {
    output_words[index] = 0u;
    return;
  }
  output_words[index] = input_words[index - 1u];
}

@compute @workgroup_size(${scanWorkgroupSize})
fn add_predecessor(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.length) {
    return;
  }
  var value = input_words[index];
  if (index >= parameters.stride) {
    value += input_words[index - parameters.stride];
  }
  output_words[index] = value;
}
`;

export type GpuExclusiveScanPipelines = {
  readonly initialize: GPUComputePipeline;
  readonly addPredecessor: GPUComputePipeline;
};

export type GpuExclusiveScanEncoding = {
  readonly offsets: GPUBuffer;
  readonly ownedBuffers: readonly GPUBuffer[];
  readonly dispatchCount: number;
  readonly additionWork: number;
  readonly additionWorkUpperBound: number;
  readonly scheduledInvocationCount: number;
  readonly temporaryBytes: number;
};

const pipelineRequests = new WeakMap<
  GPUDevice,
  Promise<GpuExclusiveScanPipelines>
>();

export function requestGpuExclusiveScanPipelines(
  device: GPUDevice,
): Promise<GpuExclusiveScanPipelines> {
  const existing = pipelineRequests.get(device);
  if (existing !== undefined) return existing;

  const request = (async () => {
    requireCompilerGpuCapacity(device, {
      kind: "pipelineBindings",
      label: "segmented exclusive scan",
      storageBufferCount: 3,
      uniformBufferCount: 0,
    });
    const module = device.createShaderModule({ code: scanShader });
    const errors = (await module.getCompilationInfo()).messages.filter(
      (message) => message.type === "error",
    );
    if (errors.length > 0) {
      throw new Error(
        `segmented exclusive-scan shader failed: ${
          errors.map((message) => message.message).join("; ")
        }`,
      );
    }
    const [initialize, addPredecessor] = await Promise.all([
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "initialize_exclusive" },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "add_predecessor" },
      }),
    ]);
    return { initialize, addPredecessor };
  })();
  pipelineRequests.set(device, request);
  void device.lost.then(() => pipelineRequests.delete(device));
  return request;
}

export function encodeGpuExclusiveScan(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GpuExclusiveScanPipelines,
  counts: GPUBuffer,
  count: number,
): GpuExclusiveScanEncoding {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`exclusive-scan count ${count} is not non-negative`);
  }
  if (count > 0xffff_fffe) {
    throw new RangeError(
      `exclusive-scan count ${count} cannot be represented with its terminal offset in u32`,
    );
  }
  const length = count + 1;
  const byteLength = Math.max(4, length * Uint32Array.BYTES_PER_ELEMENT);
  const firstScratch = createCompilerGpuBuffer(
    device,
    "segmented scan first scratch",
    {
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const secondScratch = createCompilerGpuBuffer(
    device,
    "segmented scan second scratch",
    {
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );

  const rounds = Math.ceil(Math.log2(Math.max(1, length)));
  const parameterAlignment = device.limits.minStorageBufferOffsetAlignment;
  const parameterWordsPerRecord = Math.max(2, parameterAlignment / 4);
  const parameterWords = new Uint32Array(
    (rounds + 1) * parameterWordsPerRecord,
  );
  parameterWords[0] = length;
  for (let round = 0; round < rounds; round += 1) {
    const offset = (round + 1) * parameterWordsPerRecord;
    parameterWords[offset] = length;
    parameterWords[offset + 1] = 2 ** round;
  }
  const parameterBuffer = createCompilerGpuBuffer(
    device,
    "segmented scan parameters",
    {
      size: Math.max(4, parameterWords.byteLength),
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    },
    "storage",
  );
  new Uint32Array(parameterBuffer.getMappedRange()).set(parameterWords);
  parameterBuffer.unmap();

  const workgroupCount = Math.ceil(length / scanWorkgroupSize);
  {
    const pass = encoder.beginComputePass({
      label: "segmented exclusive-scan initialization",
    });
    pass.setPipeline(pipelines.initialize);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipelines.initialize.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: counts } },
          { binding: 1, resource: { buffer: firstScratch } },
          {
            binding: 2,
            resource: { buffer: parameterBuffer, size: 8 },
          },
        ],
      }),
    );
    dispatchCompilerGpuWorkgroups(
      device,
      pass,
      "segmented exclusive-scan initialization",
      workgroupCount,
    );
    pass.end();
  }

  let input = firstScratch;
  let output = secondScratch;
  for (let round = 0; round < rounds; round += 1) {
    const pass = encoder.beginComputePass({
      label: `segmented exclusive-scan round ${round}`,
    });
    pass.setPipeline(pipelines.addPredecessor);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipelines.addPredecessor.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          {
            binding: 2,
            resource: {
              buffer: parameterBuffer,
              offset: (round + 1) * parameterAlignment,
              size: 8,
            },
          },
        ],
      }),
    );
    dispatchCompilerGpuWorkgroups(
      device,
      pass,
      `segmented exclusive-scan round ${round}`,
      workgroupCount,
    );
    pass.end();
    [input, output] = [output, input];
  }

  return {
    offsets: input,
    ownedBuffers: [firstScratch, secondScratch, parameterBuffer],
    dispatchCount: rounds + 1,
    additionWork: rounds * length - (2 ** rounds - 1),
    additionWorkUpperBound: length * rounds,
    scheduledInvocationCount: workgroupCount * scanWorkgroupSize * (rounds + 1),
    temporaryBytes: 2 * byteLength + parameterWords.byteLength,
  };
}

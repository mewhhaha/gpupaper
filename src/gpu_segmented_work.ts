import {
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requireCompilerGpuCapacity,
} from "./gpu_device.ts";

const scanWorkgroupSize = 128;
const scanParameterBytes = 16;

const scanShader = /* wgsl */ `
struct ScanParameters {
  length: u32,
  terminal_padding: u32,
  reserved_0: u32,
  reserved_1: u32,
};

@group(0) @binding(0) var<storage, read> input_words: array<u32>;
@group(0) @binding(1) var<storage, read_write> output_words: array<u32>;
@group(0) @binding(2) var<storage, read_write> block_totals: array<u32>;
@group(0) @binding(3) var<uniform> parameters: ScanParameters;
var<workgroup> scan_values: array<u32, ${scanWorkgroupSize}>;

@compute @workgroup_size(${scanWorkgroupSize})
fn scan_blocks(
  @builtin(local_invocation_id) local_invocation: vec3<u32>,
  @builtin(workgroup_id) workgroup: vec3<u32>,
) {
  let local_index = local_invocation.x;
  let index = workgroup.x * ${scanWorkgroupSize}u + local_index;
  var value = 0u;
  if (index < parameters.length) {
    if (parameters.terminal_padding == 0u) {
      value = input_words[index];
    } else if (index + 1u < parameters.length) {
      value = input_words[index];
    }
  }
  scan_values[local_index] = value;
  workgroupBarrier();

  var stride = 1u;
  while (stride < ${scanWorkgroupSize}u) {
    let tree_index = (local_index + 1u) * stride * 2u - 1u;
    if (tree_index < ${scanWorkgroupSize}u) {
      scan_values[tree_index] += scan_values[tree_index - stride];
    }
    workgroupBarrier();
    stride *= 2u;
  }

  if (local_index == 0u) {
    block_totals[workgroup.x] = scan_values[${scanWorkgroupSize - 1}u];
    scan_values[${scanWorkgroupSize - 1}u] = 0u;
  }
  workgroupBarrier();

  stride = ${scanWorkgroupSize / 2}u;
  loop {
    let tree_index = (local_index + 1u) * stride * 2u - 1u;
    if (tree_index < ${scanWorkgroupSize}u) {
      let preceding = scan_values[tree_index - stride];
      scan_values[tree_index - stride] = scan_values[tree_index];
      scan_values[tree_index] += preceding;
    }
    workgroupBarrier();
    if (stride == 1u) {
      break;
    }
    stride /= 2u;
  }

  if (index < parameters.length) {
    output_words[index] = scan_values[local_index];
  }
}

@group(1) @binding(0) var<storage, read> scanned_block_totals: array<u32>;
@group(1) @binding(1) var<storage, read_write> carry_outputs: array<u32>;
@group(1) @binding(2) var<uniform> carry_parameters: ScanParameters;

@compute @workgroup_size(${scanWorkgroupSize})
fn add_block_carries(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= carry_parameters.length) {
    return;
  }
  let block = index / ${scanWorkgroupSize}u;
  if (block > 0u) {
    carry_outputs[index] += scanned_block_totals[block];
  }
}
`;

const segmentedScanShader = /* wgsl */ `
struct ScanParameters {
  length: u32,
  reserved_0: u32,
  reserved_1: u32,
  reserved_2: u32,
};

struct SegmentPair {
  head: u32,
  value: u32,
};

fn combine(left: SegmentPair, right: SegmentPair) -> SegmentPair {
  var combined: SegmentPair;
  combined.head = left.head | right.head;
  combined.value = select(left.value + right.value, right.value, right.head != 0u);
  return combined;
}

@group(0) @binding(0) var<storage, read> input_values: array<u32>;
@group(0) @binding(1) var<storage, read> input_heads: array<u32>;
@group(0) @binding(2) var<storage, read_write> initial_outputs: array<SegmentPair>;
@group(0) @binding(3) var<storage, read_write> initial_totals: array<SegmentPair>;
@group(0) @binding(4) var<uniform> initial_parameters: ScanParameters;
var<workgroup> initial_pairs: array<SegmentPair, ${scanWorkgroupSize}>;

@compute @workgroup_size(${scanWorkgroupSize})
fn scan_initial_blocks(
  @builtin(local_invocation_id) local_invocation: vec3<u32>,
  @builtin(workgroup_id) workgroup: vec3<u32>,
) {
  let local_index = local_invocation.x;
  let index = workgroup.x * ${scanWorkgroupSize}u + local_index;
  var pair = SegmentPair(0u, 0u);
  if (index < initial_parameters.length) {
    pair = SegmentPair(select(0u, 1u, input_heads[index] != 0u), input_values[index]);
  }
  initial_pairs[local_index] = pair;
  workgroupBarrier();

  var stride = 1u;
  while (stride < ${scanWorkgroupSize}u) {
    let tree_index = (local_index + 1u) * stride * 2u - 1u;
    if (tree_index < ${scanWorkgroupSize}u) {
      initial_pairs[tree_index] = combine(
        initial_pairs[tree_index - stride],
        initial_pairs[tree_index],
      );
    }
    workgroupBarrier();
    stride *= 2u;
  }

  if (local_index == 0u) {
    initial_totals[workgroup.x] = initial_pairs[${scanWorkgroupSize - 1}u];
    initial_pairs[${scanWorkgroupSize - 1}u] = SegmentPair(0u, 0u);
  }
  workgroupBarrier();

  stride = ${scanWorkgroupSize / 2}u;
  loop {
    let tree_index = (local_index + 1u) * stride * 2u - 1u;
    if (tree_index < ${scanWorkgroupSize}u) {
      let preceding = initial_pairs[tree_index - stride];
      initial_pairs[tree_index - stride] = initial_pairs[tree_index];
      initial_pairs[tree_index] = combine(initial_pairs[tree_index], preceding);
    }
    workgroupBarrier();
    if (stride == 1u) {
      break;
    }
    stride /= 2u;
  }

  if (index < initial_parameters.length) {
    initial_outputs[index] = initial_pairs[local_index];
  }
}

@group(1) @binding(0) var<storage, read> pair_inputs: array<SegmentPair>;
@group(1) @binding(1) var<storage, read_write> pair_outputs: array<SegmentPair>;
@group(1) @binding(2) var<storage, read_write> pair_totals: array<SegmentPair>;
@group(1) @binding(3) var<uniform> pair_parameters: ScanParameters;
var<workgroup> scan_pairs: array<SegmentPair, ${scanWorkgroupSize}>;

@compute @workgroup_size(${scanWorkgroupSize})
fn scan_pair_blocks(
  @builtin(local_invocation_id) local_invocation: vec3<u32>,
  @builtin(workgroup_id) workgroup: vec3<u32>,
) {
  let local_index = local_invocation.x;
  let index = workgroup.x * ${scanWorkgroupSize}u + local_index;
  var pair = SegmentPair(0u, 0u);
  if (index < pair_parameters.length) {
    pair = pair_inputs[index];
  }
  scan_pairs[local_index] = pair;
  workgroupBarrier();

  var stride = 1u;
  while (stride < ${scanWorkgroupSize}u) {
    let tree_index = (local_index + 1u) * stride * 2u - 1u;
    if (tree_index < ${scanWorkgroupSize}u) {
      scan_pairs[tree_index] = combine(
        scan_pairs[tree_index - stride],
        scan_pairs[tree_index],
      );
    }
    workgroupBarrier();
    stride *= 2u;
  }

  if (local_index == 0u) {
    pair_totals[workgroup.x] = scan_pairs[${scanWorkgroupSize - 1}u];
    scan_pairs[${scanWorkgroupSize - 1}u] = SegmentPair(0u, 0u);
  }
  workgroupBarrier();

  stride = ${scanWorkgroupSize / 2}u;
  loop {
    let tree_index = (local_index + 1u) * stride * 2u - 1u;
    if (tree_index < ${scanWorkgroupSize}u) {
      let preceding = scan_pairs[tree_index - stride];
      scan_pairs[tree_index - stride] = scan_pairs[tree_index];
      scan_pairs[tree_index] = combine(scan_pairs[tree_index], preceding);
    }
    workgroupBarrier();
    if (stride == 1u) {
      break;
    }
    stride /= 2u;
  }

  if (index < pair_parameters.length) {
    pair_outputs[index] = scan_pairs[local_index];
  }
}

@group(2) @binding(0) var<storage, read> scanned_pair_totals: array<SegmentPair>;
@group(2) @binding(1) var<storage, read_write> carried_pairs: array<SegmentPair>;
@group(2) @binding(2) var<uniform> carry_parameters: ScanParameters;

@compute @workgroup_size(${scanWorkgroupSize})
fn add_pair_carries(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= carry_parameters.length) {
    return;
  }
  let block = index / ${scanWorkgroupSize}u;
  if (block > 0u) {
    carried_pairs[index] = combine(scanned_pair_totals[block], carried_pairs[index]);
  }
}

@group(3) @binding(0) var<storage, read> projection_heads: array<u32>;
@group(3) @binding(1) var<storage, read> projection_pairs: array<SegmentPair>;
@group(3) @binding(2) var<storage, read_write> projection_values: array<u32>;
@group(3) @binding(3) var<uniform> projection_parameters: ScanParameters;

@compute @workgroup_size(${scanWorkgroupSize})
fn project_segment_values(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= projection_parameters.length) {
    return;
  }
  projection_values[index] = select(
    projection_pairs[index].value,
    0u,
    index == 0u || projection_heads[index] != 0u,
  );
}
`;

export type GpuExclusiveScanPipelines = {
  readonly scanBlocks: GPUComputePipeline;
  readonly addBlockCarries: GPUComputePipeline;
};

export type GpuSegmentedExclusiveScanPipelines = {
  readonly scanInitialBlocks: GPUComputePipeline;
  readonly scanPairBlocks: GPUComputePipeline;
  readonly addPairCarries: GPUComputePipeline;
  readonly projectSegmentValues: GPUComputePipeline;
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

type EncodedScanLevel = GpuExclusiveScanEncoding;

export type GpuSegmentedExclusiveScanEncoding = {
  readonly values: GPUBuffer;
  readonly ownedBuffers: readonly GPUBuffer[];
  readonly dispatchCount: number;
  readonly combineWork: number;
  readonly scheduledInvocationCount: number;
  readonly temporaryBytes: number;
};

const pipelineRequests = new WeakMap<
  GPUDevice,
  Promise<GpuExclusiveScanPipelines>
>();
const segmentedPipelineRequests = new WeakMap<
  GPUDevice,
  Promise<GpuSegmentedExclusiveScanPipelines>
>();

export function requestGpuExclusiveScanPipelines(
  device: GPUDevice,
): Promise<GpuExclusiveScanPipelines> {
  const existing = pipelineRequests.get(device);
  if (existing !== undefined) return existing;

  const request = (async () => {
    requireCompilerGpuCapacity(device, {
      kind: "pipelineBindings",
      label: "hierarchical exclusive scan",
      storageBufferCount: 3,
      uniformBufferCount: 1,
    });
    const module = device.createShaderModule({ code: scanShader });
    const errors = (await module.getCompilationInfo()).messages.filter(
      (message) => message.type === "error",
    );
    if (errors.length > 0) {
      throw new Error(
        `hierarchical exclusive-scan shader failed: ${
          errors.map((message) => message.message).join("; ")
        }`,
      );
    }
    const [scanBlocks, addBlockCarries] = await Promise.all([
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "scan_blocks" },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "add_block_carries" },
      }),
    ]);
    return { scanBlocks, addBlockCarries };
  })();
  pipelineRequests.set(device, request);
  void device.lost.then(() => pipelineRequests.delete(device));
  return request;
}

export function requestGpuSegmentedExclusiveScanPipelines(
  device: GPUDevice,
): Promise<GpuSegmentedExclusiveScanPipelines> {
  const existing = segmentedPipelineRequests.get(device);
  if (existing !== undefined) return existing;

  const request = (async () => {
    requireCompilerGpuCapacity(device, {
      kind: "pipelineBindings",
      label: "hierarchical segmented exclusive scan",
      storageBufferCount: 4,
      uniformBufferCount: 1,
    });
    const module = device.createShaderModule({ code: segmentedScanShader });
    const errors = (await module.getCompilationInfo()).messages.filter(
      (message) => message.type === "error",
    );
    if (errors.length > 0) {
      throw new Error(
        `hierarchical segmented exclusive-scan shader failed: ${
          errors.map((message) => message.message).join("; ")
        }`,
      );
    }
    const [
      scanInitialBlocks,
      scanPairBlocks,
      addPairCarries,
      projectSegmentValues,
    ] = await Promise.all([
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "scan_initial_blocks" },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "scan_pair_blocks" },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "add_pair_carries" },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "project_segment_values" },
      }),
    ]);
    return {
      scanInitialBlocks,
      scanPairBlocks,
      addPairCarries,
      projectSegmentValues,
    };
  })();
  segmentedPipelineRequests.set(device, request);
  void device.lost.then(() => segmentedPipelineRequests.delete(device));
  return request;
}

export function encodeGpuSegmentedExclusiveScan(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GpuSegmentedExclusiveScanPipelines,
  values: GPUBuffer,
  segmentHeads: GPUBuffer,
  count: number,
): GpuSegmentedExclusiveScanEncoding {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(
      `segmented exclusive-scan count ${count} is not non-negative`,
    );
  }
  if (count === 0) return encodeEmptySegmentedScan(device);

  const scannedPairs = encodeInitialSegmentedScanLevel(
    device,
    encoder,
    pipelines,
    values,
    segmentHeads,
    count,
  );
  const outputBytes = count * Uint32Array.BYTES_PER_ELEMENT;
  const output = createCompilerGpuBuffer(
    device,
    "segmented exclusive-scan values",
    {
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const parameters = createSegmentedScanParameterBuffer(
    device,
    "segmented exclusive-scan projection parameters",
    count,
  );
  const pass = encoder.beginComputePass({
    label: "segmented exclusive-scan projection",
  });
  pass.setPipeline(pipelines.projectSegmentValues);
  pass.setBindGroup(
    3,
    device.createBindGroup({
      layout: pipelines.projectSegmentValues.getBindGroupLayout(3),
      entries: [
        { binding: 0, resource: { buffer: segmentHeads } },
        { binding: 1, resource: { buffer: scannedPairs.pairs } },
        { binding: 2, resource: { buffer: output } },
        { binding: 3, resource: { buffer: parameters } },
      ],
    }),
  );
  dispatchCompilerGpuWorkgroups(
    device,
    pass,
    "segmented exclusive-scan projection",
    Math.ceil(count / scanWorkgroupSize),
  );
  pass.end();

  return {
    values: output,
    ownedBuffers: [...scannedPairs.ownedBuffers, output, parameters],
    dispatchCount: scannedPairs.dispatchCount + 1,
    combineWork: scannedPairs.combineWork,
    scheduledInvocationCount: scannedPairs.scheduledInvocationCount +
      Math.ceil(count / scanWorkgroupSize) * scanWorkgroupSize,
    temporaryBytes: scannedPairs.temporaryBytes + outputBytes +
      scanParameterBytes,
  };
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
  if (count === 0) return encodeEmptyScan(device);
  return encodeScanLevel(
    device,
    encoder,
    pipelines,
    counts,
    count + 1,
    true,
    0,
  );
}

function encodeEmptyScan(device: GPUDevice): GpuExclusiveScanEncoding {
  const offsets = createCompilerGpuBuffer(
    device,
    "empty exclusive-scan offset",
    {
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    },
    "storage",
  );
  new Uint32Array(offsets.getMappedRange())[0] = 0;
  offsets.unmap();
  return {
    offsets,
    ownedBuffers: [offsets],
    dispatchCount: 0,
    additionWork: 0,
    additionWorkUpperBound: 0,
    scheduledInvocationCount: 0,
    temporaryBytes: 4,
  };
}

type EncodedSegmentPairLevel = {
  readonly pairs: GPUBuffer;
  readonly ownedBuffers: readonly GPUBuffer[];
  readonly dispatchCount: number;
  readonly combineWork: number;
  readonly scheduledInvocationCount: number;
  readonly temporaryBytes: number;
};

function encodeEmptySegmentedScan(
  device: GPUDevice,
): GpuSegmentedExclusiveScanEncoding {
  const values = createCompilerGpuBuffer(
    device,
    "empty segmented exclusive-scan values",
    {
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    },
    "storage",
  );
  new Uint32Array(values.getMappedRange())[0] = 0;
  values.unmap();
  return {
    values,
    ownedBuffers: [values],
    dispatchCount: 0,
    combineWork: 0,
    scheduledInvocationCount: 0,
    temporaryBytes: 4,
  };
}

function encodeInitialSegmentedScanLevel(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GpuSegmentedExclusiveScanPipelines,
  values: GPUBuffer,
  segmentHeads: GPUBuffer,
  length: number,
): EncodedSegmentPairLevel {
  const workgroupCount = Math.ceil(length / scanWorkgroupSize);
  const pairBytes = length * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const blockTotalBytes = workgroupCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const pairs = createCompilerGpuBuffer(
    device,
    "segmented scan level 0 pairs",
    { size: pairBytes, usage: GPUBufferUsage.STORAGE },
    "storage",
  );
  const blockTotals = createCompilerGpuBuffer(
    device,
    "segmented scan level 0 totals",
    { size: blockTotalBytes, usage: GPUBufferUsage.STORAGE },
    "storage",
  );
  const parameters = createSegmentedScanParameterBuffer(
    device,
    "segmented scan level 0 parameters",
    length,
  );
  const pass = encoder.beginComputePass({ label: "segmented scan level 0" });
  pass.setPipeline(pipelines.scanInitialBlocks);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipelines.scanInitialBlocks.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: values } },
        { binding: 1, resource: { buffer: segmentHeads } },
        { binding: 2, resource: { buffer: pairs } },
        { binding: 3, resource: { buffer: blockTotals } },
        { binding: 4, resource: { buffer: parameters } },
      ],
    }),
  );
  dispatchCompilerGpuWorkgroups(
    device,
    pass,
    "segmented scan level 0",
    workgroupCount,
  );
  pass.end();
  return finishSegmentedScanLevel(
    device,
    encoder,
    pipelines,
    pairs,
    blockTotals,
    parameters,
    length,
    workgroupCount,
    0,
  );
}

function encodeSegmentPairScanLevel(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GpuSegmentedExclusiveScanPipelines,
  input: GPUBuffer,
  length: number,
  depth: number,
): EncodedSegmentPairLevel {
  const workgroupCount = Math.ceil(length / scanWorkgroupSize);
  const pairBytes = length * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const blockTotalBytes = workgroupCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const pairs = createCompilerGpuBuffer(
    device,
    `segmented scan level ${depth} pairs`,
    { size: pairBytes, usage: GPUBufferUsage.STORAGE },
    "storage",
  );
  const blockTotals = createCompilerGpuBuffer(
    device,
    `segmented scan level ${depth} totals`,
    { size: blockTotalBytes, usage: GPUBufferUsage.STORAGE },
    "storage",
  );
  const parameters = createSegmentedScanParameterBuffer(
    device,
    `segmented scan level ${depth} parameters`,
    length,
  );
  const pass = encoder.beginComputePass({
    label: `segmented scan level ${depth}`,
  });
  pass.setPipeline(pipelines.scanPairBlocks);
  pass.setBindGroup(
    1,
    device.createBindGroup({
      layout: pipelines.scanPairBlocks.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: pairs } },
        { binding: 2, resource: { buffer: blockTotals } },
        { binding: 3, resource: { buffer: parameters } },
      ],
    }),
  );
  dispatchCompilerGpuWorkgroups(
    device,
    pass,
    `segmented scan level ${depth}`,
    workgroupCount,
  );
  pass.end();
  return finishSegmentedScanLevel(
    device,
    encoder,
    pipelines,
    pairs,
    blockTotals,
    parameters,
    length,
    workgroupCount,
    depth,
  );
}

function finishSegmentedScanLevel(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GpuSegmentedExclusiveScanPipelines,
  pairs: GPUBuffer,
  blockTotals: GPUBuffer,
  parameters: GPUBuffer,
  length: number,
  workgroupCount: number,
  depth: number,
): EncodedSegmentPairLevel {
  const pairBytes = length * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const blockTotalBytes = workgroupCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const localCombineWork = workgroupCount * 2 * (scanWorkgroupSize - 1);
  const localScheduledInvocations = workgroupCount * scanWorkgroupSize;
  if (workgroupCount === 1) {
    return {
      pairs,
      ownedBuffers: [pairs, blockTotals, parameters],
      dispatchCount: 1,
      combineWork: localCombineWork,
      scheduledInvocationCount: localScheduledInvocations,
      temporaryBytes: pairBytes + blockTotalBytes + scanParameterBytes,
    };
  }

  const scannedBlocks = encodeSegmentPairScanLevel(
    device,
    encoder,
    pipelines,
    blockTotals,
    workgroupCount,
    depth + 1,
  );
  const carryParameters = createSegmentedScanParameterBuffer(
    device,
    `segmented scan level ${depth} carry parameters`,
    length,
  );
  const carryPass = encoder.beginComputePass({
    label: `segmented scan level ${depth} carries`,
  });
  carryPass.setPipeline(pipelines.addPairCarries);
  carryPass.setBindGroup(
    2,
    device.createBindGroup({
      layout: pipelines.addPairCarries.getBindGroupLayout(2),
      entries: [
        { binding: 0, resource: { buffer: scannedBlocks.pairs } },
        { binding: 1, resource: { buffer: pairs } },
        { binding: 2, resource: { buffer: carryParameters } },
      ],
    }),
  );
  dispatchCompilerGpuWorkgroups(
    device,
    carryPass,
    `segmented scan level ${depth} carries`,
    workgroupCount,
  );
  carryPass.end();
  const carryCombineWork = length - scanWorkgroupSize;
  return {
    pairs,
    ownedBuffers: [
      pairs,
      blockTotals,
      parameters,
      ...scannedBlocks.ownedBuffers,
      carryParameters,
    ],
    dispatchCount: scannedBlocks.dispatchCount + 2,
    combineWork: localCombineWork + scannedBlocks.combineWork +
      carryCombineWork,
    scheduledInvocationCount: localScheduledInvocations +
      scannedBlocks.scheduledInvocationCount + localScheduledInvocations,
    temporaryBytes: pairBytes + blockTotalBytes + scanParameterBytes +
      scannedBlocks.temporaryBytes + scanParameterBytes,
  };
}

function encodeScanLevel(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipelines: GpuExclusiveScanPipelines,
  input: GPUBuffer,
  length: number,
  terminalPadding: boolean,
  depth: number,
): EncodedScanLevel {
  const workgroupCount = Math.ceil(length / scanWorkgroupSize);
  const outputBytes = length * Uint32Array.BYTES_PER_ELEMENT;
  const blockTotalBytes = workgroupCount * Uint32Array.BYTES_PER_ELEMENT;
  const output = createCompilerGpuBuffer(
    device,
    `hierarchical scan level ${depth} output`,
    {
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const blockTotals = createCompilerGpuBuffer(
    device,
    `hierarchical scan level ${depth} totals`,
    {
      size: blockTotalBytes,
      usage: GPUBufferUsage.STORAGE,
    },
    "storage",
  );
  const parameters = createScanParameterBuffer(
    device,
    `hierarchical scan level ${depth} parameters`,
    length,
    terminalPadding,
  );
  {
    const pass = encoder.beginComputePass({
      label: `hierarchical exclusive-scan level ${depth}`,
    });
    pass.setPipeline(pipelines.scanBlocks);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipelines.scanBlocks.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: blockTotals } },
          { binding: 3, resource: { buffer: parameters } },
        ],
      }),
    );
    dispatchCompilerGpuWorkgroups(
      device,
      pass,
      `hierarchical exclusive-scan level ${depth}`,
      workgroupCount,
    );
    pass.end();
  }

  const localAdditionWork = workgroupCount * 2 * (scanWorkgroupSize - 1);
  const localScheduledInvocations = workgroupCount * scanWorkgroupSize;
  if (workgroupCount === 1) {
    return {
      offsets: output,
      ownedBuffers: [output, blockTotals, parameters],
      dispatchCount: 1,
      additionWork: localAdditionWork,
      additionWorkUpperBound: localAdditionWork,
      scheduledInvocationCount: localScheduledInvocations,
      temporaryBytes: outputBytes + blockTotalBytes + scanParameterBytes,
    };
  }

  const scannedBlocks = encodeScanLevel(
    device,
    encoder,
    pipelines,
    blockTotals,
    workgroupCount,
    false,
    depth + 1,
  );
  const carryParameters = createScanParameterBuffer(
    device,
    `hierarchical scan level ${depth} carry parameters`,
    length,
    false,
  );
  {
    const pass = encoder.beginComputePass({
      label: `hierarchical exclusive-scan level ${depth} carries`,
    });
    pass.setPipeline(pipelines.addBlockCarries);
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: pipelines.addBlockCarries.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: scannedBlocks.offsets } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: carryParameters } },
        ],
      }),
    );
    dispatchCompilerGpuWorkgroups(
      device,
      pass,
      `hierarchical exclusive-scan level ${depth} carries`,
      workgroupCount,
    );
    pass.end();
  }
  const carryAdditionWork = length - scanWorkgroupSize;
  return {
    offsets: output,
    ownedBuffers: [
      output,
      blockTotals,
      parameters,
      ...scannedBlocks.ownedBuffers,
      carryParameters,
    ],
    dispatchCount: scannedBlocks.dispatchCount + 2,
    additionWork: localAdditionWork + scannedBlocks.additionWork +
      carryAdditionWork,
    additionWorkUpperBound: localAdditionWork +
      scannedBlocks.additionWorkUpperBound + carryAdditionWork,
    scheduledInvocationCount: localScheduledInvocations +
      scannedBlocks.scheduledInvocationCount + localScheduledInvocations,
    temporaryBytes: outputBytes + blockTotalBytes + scanParameterBytes +
      scannedBlocks.temporaryBytes + scanParameterBytes,
  };
}

function createScanParameterBuffer(
  device: GPUDevice,
  label: string,
  length: number,
  terminalPadding: boolean,
): GPUBuffer {
  const parameters = createCompilerGpuBuffer(
    device,
    label,
    {
      size: scanParameterBytes,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true,
    },
    "uniform",
  );
  new Uint32Array(parameters.getMappedRange()).set([
    length,
    terminalPadding ? 1 : 0,
    0,
    0,
  ]);
  parameters.unmap();
  return parameters;
}

function createSegmentedScanParameterBuffer(
  device: GPUDevice,
  label: string,
  length: number,
): GPUBuffer {
  const parameters = createCompilerGpuBuffer(
    device,
    label,
    {
      size: scanParameterBytes,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true,
    },
    "uniform",
  );
  new Uint32Array(parameters.getMappedRange()).set([length, 0, 0, 0]);
  parameters.unmap();
  return parameters;
}

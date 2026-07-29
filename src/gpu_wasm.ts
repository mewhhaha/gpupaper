import {
  acquireCompilerGpuErrorScope,
  compilerGpuCapacityViolation,
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requestCompilerGpuDevice,
} from "./gpu_device.ts";
import {
  validateWasmBinaryPlan,
  type WasmAtom,
  type WasmBinaryPlan,
} from "./wasm.ts";

export type GpuWasmEmissionResult =
  | {
    readonly status: "completed";
    readonly bytes: Uint8Array;
    readonly atomCount: number;
    readonly byteCount: number;
    readonly outputBufferBytes: number;
    readonly lengthRounds: number;
    readonly scanRounds: number;
  }
  | { readonly status: "unavailable"; readonly reason: string };

type GpuWasmContextRequest =
  | {
    readonly status: "available";
    readonly device: GPUDevice;
    readonly sizePipeline: GPUComputePipeline;
    readonly lengthPipeline: GPUComputePipeline;
    readonly scanPipeline: GPUComputePipeline;
    readonly emissionPipeline: GPUComputePipeline;
  }
  | { readonly status: "unavailable"; readonly reason: string };

const atomByte = 0;
const atomUnsigned = 1;
const atomSigned32 = 2;
const atomSigned64 = 3;
const atomLength = 4;
const maximumEncodedAtomSize = 10;
let contextPromise: Promise<GpuWasmContextRequest> | undefined;

const encodingFunctions = `
fn unsigned_size(value: u32) -> u32 {
  var remaining = value;
  var size = 1u;
  while (remaining >= 128u) {
    remaining >>= 7u;
    size += 1u;
  }
  return size;
}

fn signed32_size(value_bits: u32) -> u32 {
  var remaining = bitcast<i32>(value_bits);
  var size = 0u;
  loop {
    let encoded_byte = u32(remaining) & 127u;
    remaining >>= 7;
    size += 1u;
    let sign_set = (encoded_byte & 64u) != 0u;
    if ((remaining == 0 && !sign_set) || (remaining == -1 && sign_set)) {
      return size;
    }
  }
  return size;
}

fn signed64_size(low_value: u32, high_value: u32) -> u32 {
  var low = low_value;
  var high = high_value;
  var size = 0u;
  loop {
    let encoded_byte = low & 127u;
    let next_low = (low >> 7u) | (high << 25u);
    let next_high = bitcast<u32>(bitcast<i32>(high) >> 7);
    size += 1u;
    let sign_set = (encoded_byte & 64u) != 0u;
    let positive_end = next_low == 0u && next_high == 0u && !sign_set;
    let negative_end =
      next_low == 0xffffffffu && next_high == 0xffffffffu && sign_set;
    if (positive_end || negative_end) { return size; }
    low = next_low;
    high = next_high;
  }
  return size;
}
`;

const sizeShader = `
${encodingFunctions}
struct Parameters { count: u32 }
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read> low_words: array<u32>;
@group(0) @binding(2) var<storage, read> high_words: array<u32>;
@group(0) @binding(3) var<storage, read_write> atom_sizes: array<u32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn calculate_sizes(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  let kind = atom_kinds[index];
  if (kind == ${atomByte}u) {
    atom_sizes[index] = 1u;
  } else if (kind == ${atomUnsigned}u) {
    atom_sizes[index] = unsigned_size(low_words[index]);
  } else if (kind == ${atomSigned32}u) {
    atom_sizes[index] = signed32_size(low_words[index]);
  } else if (kind == ${atomSigned64}u) {
    atom_sizes[index] = signed64_size(low_words[index], high_words[index]);
  } else {
    atom_sizes[index] = 0u;
  }
}
`;

const lengthShader = `
${encodingFunctions}
struct Parameters { count: u32, level: u32 }
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read_write> low_words: array<u32>;
@group(0) @binding(2) var<storage, read> range_starts: array<u32>;
@group(0) @binding(3) var<storage, read> range_counts: array<u32>;
@group(0) @binding(4) var<storage, read> dependency_levels: array<u32>;
@group(0) @binding(5) var<storage, read_write> atom_sizes: array<u32>;
@group(0) @binding(6) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn calculate_lengths(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (
    index >= parameters.count ||
    atom_kinds[index] != ${atomLength}u ||
    dependency_levels[index] != parameters.level
  ) {
    return;
  }
  let range_start = range_starts[index];
  let range_end = range_start + range_counts[index];
  var byte_length = 0u;
  for (
    var dependency = range_start;
    dependency < range_end;
    dependency += 1u
  ) {
    byte_length += atom_sizes[dependency];
  }
  low_words[index] = byte_length;
  atom_sizes[index] = unsigned_size(byte_length);
}
`;

const scanShader = `
struct Parameters { count: u32, distance: u32 }
@group(0) @binding(0) var<storage, read> input_prefixes: array<u32>;
@group(0) @binding(1) var<storage, read_write> output_prefixes: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn scan_step(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  var prefix = input_prefixes[index];
  if (index >= parameters.distance) {
    prefix += input_prefixes[index - parameters.distance];
  }
  output_prefixes[index] = prefix;
}
`;

const emissionShader = `
struct Parameters { count: u32 }
@group(0) @binding(0) var<storage, read> atom_kinds: array<u32>;
@group(0) @binding(1) var<storage, read> low_words: array<u32>;
@group(0) @binding(2) var<storage, read> high_words: array<u32>;
@group(0) @binding(3) var<storage, read> atom_sizes: array<u32>;
@group(0) @binding(4) var<storage, read> inclusive_offsets: array<u32>;
@group(0) @binding(5) var<storage, read_write> output_words: array<atomic<u32>>;
@group(0) @binding(6) var<uniform> parameters: Parameters;

fn emit_byte(offset: u32, value: u32) {
  let word_index = offset >> 2u;
  let shift = (offset & 3u) << 3u;
  atomicOr(&output_words[word_index], (value & 255u) << shift);
}

@compute @workgroup_size(64)
fn emit_atoms(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= parameters.count) { return; }
  let kind = atom_kinds[index];
  let size = atom_sizes[index];
  let output_start = inclusive_offsets[index] - size;
  if (kind == ${atomByte}u) {
    emit_byte(output_start, low_words[index]);
    return;
  }
  if (kind == ${atomUnsigned}u || kind == ${atomLength}u) {
    var remaining = low_words[index];
    for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
      var encoded_byte = remaining & 127u;
      remaining >>= 7u;
      if (byte_index + 1u < size) { encoded_byte |= 128u; }
      emit_byte(output_start + byte_index, encoded_byte);
    }
    return;
  }
  if (kind == ${atomSigned32}u) {
    var remaining = bitcast<i32>(low_words[index]);
    for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
      var encoded_byte = u32(remaining) & 127u;
      remaining >>= 7;
      if (byte_index + 1u < size) { encoded_byte |= 128u; }
      emit_byte(output_start + byte_index, encoded_byte);
    }
    return;
  }
  var low = low_words[index];
  var high = high_words[index];
  for (var byte_index = 0u; byte_index < size; byte_index += 1u) {
    var encoded_byte = low & 127u;
    let next_low = (low >> 7u) | (high << 25u);
    let next_high = bitcast<u32>(bitcast<i32>(high) >> 7);
    if (byte_index + 1u < size) { encoded_byte |= 128u; }
    emit_byte(output_start + byte_index, encoded_byte);
    low = next_low;
    high = next_high;
  }
}
`;

export async function emitWasmPlanOnGpu(
  plan: WasmBinaryPlan,
): Promise<GpuWasmEmissionResult> {
  validateWasmBinaryPlan(plan);
  const columns = atomColumns(plan.atoms);
  const context = await requestGpuWasmContext();
  if (context.status === "unavailable") return context;
  const {
    device,
    emissionPipeline,
    lengthPipeline,
    scanPipeline,
    sizePipeline,
  } = context;
  const maximumByteCount = plan.atoms.length * maximumEncodedAtomSize;
  if (
    !Number.isSafeInteger(maximumByteCount) || maximumByteCount > 0xffff_ffff
  ) {
    throw new RangeError(
      `GPU Wasm plan contains ${plan.atoms.length} atoms; its maximum encoded size exceeds u32`,
    );
  }
  const maximumOutputWordCount = Math.ceil(maximumByteCount / 4);
  const atomBytes = Math.max(4, columns.kinds.byteLength);
  const outputBytes = maximumOutputWordCount * 4;
  const capacityRequests = [
    ["atom kinds", atomBytes, "storage"],
    ["atom low words", atomBytes, "storage"],
    ["atom high words", atomBytes, "storage"],
    ["range starts", atomBytes, "storage"],
    ["range counts", atomBytes, "storage"],
    ["dependency levels", atomBytes, "storage"],
    ["atom sizes", atomBytes, "storage"],
    ["prefixes", atomBytes, "storage"],
    ["alternate prefixes", atomBytes, "storage"],
    ["packed output", outputBytes, "storage"],
    ["count parameters", 4, "uniform"],
    ["pass parameters", 8, "uniform"],
    ["readback", 4 + outputBytes, "copy"],
  ] as const;
  for (const [label, byteLength, binding] of capacityRequests) {
    const reason = compilerGpuCapacityViolation(device.limits, {
      kind: "buffer",
      label: `Wasm ${label}`,
      byteLength,
      binding,
    });
    if (reason !== undefined) return { status: "unavailable", reason };
  }
  const workgroupCount = Math.ceil(plan.atoms.length / 64);
  const dispatchReason = compilerGpuCapacityViolation(device.limits, {
    kind: "dispatch",
    label: "Wasm emission",
    workgroupCount,
  });
  if (dispatchReason !== undefined) {
    return { status: "unavailable", reason: dispatchReason };
  }

  const kindBuffer = createBuffer(
    device,
    "Wasm atom kinds",
    columns.kinds,
    GPUBufferUsage.STORAGE,
  );
  const lowWordBuffer = createBuffer(
    device,
    "Wasm atom low words",
    columns.lowWords,
    GPUBufferUsage.STORAGE,
  );
  const highWordBuffer = createBuffer(
    device,
    "Wasm atom high words",
    columns.highWords,
    GPUBufferUsage.STORAGE,
  );
  const rangeStartBuffer = createBuffer(
    device,
    "Wasm range starts",
    columns.rangeStarts,
    GPUBufferUsage.STORAGE,
  );
  const rangeCountBuffer = createBuffer(
    device,
    "Wasm range counts",
    columns.rangeCounts,
    GPUBufferUsage.STORAGE,
  );
  const dependencyLevelBuffer = createBuffer(
    device,
    "Wasm dependency levels",
    columns.dependencyLevels,
    GPUBufferUsage.STORAGE,
  );
  const sizeBuffer = createCompilerGpuBuffer(
    device,
    "Wasm atom sizes",
    {
      size: atomBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const prefixBuffer = createCompilerGpuBuffer(
    device,
    "Wasm prefixes",
    {
      size: atomBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const alternatePrefixBuffer = createCompilerGpuBuffer(
    device,
    "Wasm alternate prefixes",
    {
      size: atomBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const outputBuffer = createCompilerGpuBuffer(
    device,
    "Wasm packed output",
    {
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const countParameterBuffer = createBuffer(
    device,
    "Wasm count parameters",
    new Uint32Array([plan.atoms.length]),
    GPUBufferUsage.UNIFORM,
  );
  const readback = createCompilerGpuBuffer(
    device,
    "Wasm readback",
    {
      size: 4 + outputBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const transientParameterBuffers: GPUBuffer[] = [];
  const buffers = [
    kindBuffer,
    lowWordBuffer,
    highWordBuffer,
    rangeStartBuffer,
    rangeCountBuffer,
    dependencyLevelBuffer,
    sizeBuffer,
    prefixBuffer,
    alternatePrefixBuffer,
    outputBuffer,
    countParameterBuffer,
    readback,
  ];
  const releaseEmission = await acquireCompilerGpuErrorScope();
  let readbackMapped = false;
  let validationScopePending = false;
  try {
    device.pushErrorScope("validation");
    validationScopePending = true;
    const encoder = device.createCommandEncoder();
    const sizeBindGroup = device.createBindGroup({
      layout: sizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: kindBuffer } },
        { binding: 1, resource: { buffer: lowWordBuffer } },
        { binding: 2, resource: { buffer: highWordBuffer } },
        { binding: 3, resource: { buffer: sizeBuffer } },
        { binding: 4, resource: { buffer: countParameterBuffer } },
      ],
    });
    const sizePass = encoder.beginComputePass();
    sizePass.setPipeline(sizePipeline);
    sizePass.setBindGroup(0, sizeBindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      sizePass,
      "Wasm size calculation",
      workgroupCount,
    );
    sizePass.end();

    for (
      let level = 1;
      level <= plan.maximumDependencyLevel;
      level += 1
    ) {
      const parameterBuffer = createBuffer(
        device,
        `Wasm length parameters ${level}`,
        new Uint32Array([plan.atoms.length, level]),
        GPUBufferUsage.UNIFORM,
      );
      transientParameterBuffers.push(parameterBuffer);
      const bindGroup = device.createBindGroup({
        layout: lengthPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: kindBuffer } },
          { binding: 1, resource: { buffer: lowWordBuffer } },
          { binding: 2, resource: { buffer: rangeStartBuffer } },
          { binding: 3, resource: { buffer: rangeCountBuffer } },
          { binding: 4, resource: { buffer: dependencyLevelBuffer } },
          { binding: 5, resource: { buffer: sizeBuffer } },
          { binding: 6, resource: { buffer: parameterBuffer } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(lengthPipeline);
      pass.setBindGroup(0, bindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        `Wasm length level ${level}`,
        workgroupCount,
      );
      pass.end();
    }

    encoder.copyBufferToBuffer(
      sizeBuffer,
      0,
      prefixBuffer,
      0,
      columns.kinds.byteLength,
    );
    let inputPrefixBuffer = prefixBuffer;
    let outputPrefixBuffer = alternatePrefixBuffer;
    let scanRounds = 0;
    for (let distance = 1; distance < plan.atoms.length; distance *= 2) {
      const parameterBuffer = createBuffer(
        device,
        `Wasm scan parameters ${distance}`,
        new Uint32Array([plan.atoms.length, distance]),
        GPUBufferUsage.UNIFORM,
      );
      transientParameterBuffers.push(parameterBuffer);
      const bindGroup = device.createBindGroup({
        layout: scanPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputPrefixBuffer } },
          { binding: 1, resource: { buffer: outputPrefixBuffer } },
          { binding: 2, resource: { buffer: parameterBuffer } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(scanPipeline);
      pass.setBindGroup(0, bindGroup);
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        `Wasm scan distance ${distance}`,
        workgroupCount,
      );
      pass.end();
      [inputPrefixBuffer, outputPrefixBuffer] = [
        outputPrefixBuffer,
        inputPrefixBuffer,
      ];
      scanRounds += 1;
    }

    const emissionBindGroup = device.createBindGroup({
      layout: emissionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: kindBuffer } },
        { binding: 1, resource: { buffer: lowWordBuffer } },
        { binding: 2, resource: { buffer: highWordBuffer } },
        { binding: 3, resource: { buffer: sizeBuffer } },
        { binding: 4, resource: { buffer: inputPrefixBuffer } },
        { binding: 5, resource: { buffer: outputBuffer } },
        { binding: 6, resource: { buffer: countParameterBuffer } },
      ],
    });
    const emissionPass = encoder.beginComputePass();
    emissionPass.setPipeline(emissionPipeline);
    emissionPass.setBindGroup(0, emissionBindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      emissionPass,
      "Wasm byte emission",
      workgroupCount,
    );
    emissionPass.end();
    encoder.copyBufferToBuffer(
      inputPrefixBuffer,
      (plan.atoms.length - 1) * 4,
      readback,
      0,
      4,
    );
    encoder.copyBufferToBuffer(
      outputBuffer,
      0,
      readback,
      4,
      maximumOutputWordCount * 4,
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    readbackMapped = true;
    const validationError = await device.popErrorScope();
    validationScopePending = false;
    if (validationError !== null) {
      throw new Error(
        `WebGPU Wasm emission validation failed: ${validationError.message}`,
      );
    }
    const mapped = readback.getMappedRange();
    const byteCount = new Uint32Array(mapped, 0, 1)[0];
    if (byteCount > maximumByteCount) {
      throw new RangeError(
        `WebGPU Wasm emitter returned ${byteCount} bytes; plan maximum is ${maximumByteCount}`,
      );
    }
    const bytes = new Uint8Array(mapped, 4, byteCount).slice();
    return {
      status: "completed",
      bytes,
      atomCount: plan.atoms.length,
      byteCount,
      outputBufferBytes: maximumOutputWordCount * 4,
      lengthRounds: plan.maximumDependencyLevel,
      scanRounds,
    };
  } finally {
    if (validationScopePending) await device.popErrorScope();
    if (readbackMapped) readback.unmap();
    for (const buffer of [...buffers, ...transientParameterBuffers]) {
      buffer.destroy();
    }
    releaseEmission();
  }
}

function atomColumns(atoms: readonly WasmAtom[]): {
  readonly kinds: Uint32Array;
  readonly lowWords: Uint32Array;
  readonly highWords: Uint32Array;
  readonly rangeStarts: Uint32Array;
  readonly rangeCounts: Uint32Array;
  readonly dependencyLevels: Uint32Array;
} {
  const kinds = new Uint32Array(atoms.length);
  const lowWords = new Uint32Array(atoms.length);
  const highWords = new Uint32Array(atoms.length);
  const rangeStarts = new Uint32Array(atoms.length);
  const rangeCounts = new Uint32Array(atoms.length);
  const dependencyLevels = new Uint32Array(atoms.length);
  for (const [index, atom] of atoms.entries()) {
    if (atom.kind === "byte") {
      kinds[index] = atomByte;
      lowWords[index] = atom.value;
      continue;
    }
    if (atom.kind === "unsigned") {
      kinds[index] = atomUnsigned;
      lowWords[index] = atom.value;
      continue;
    }
    if (atom.kind === "signed32") {
      kinds[index] = atomSigned32;
      lowWords[index] = atom.value >>> 0;
      continue;
    }
    if (atom.kind === "signed64") {
      kinds[index] = atomSigned64;
      lowWords[index] = Number(BigInt.asUintN(32, atom.value));
      highWords[index] = Number(BigInt.asUintN(32, atom.value >> 32n));
      continue;
    }
    kinds[index] = atomLength;
    rangeStarts[index] = atom.rangeStart;
    rangeCounts[index] = atom.rangeCount;
    dependencyLevels[index] = atom.dependencyLevel;
  }
  return {
    kinds,
    lowWords,
    highWords,
    rangeStarts,
    rangeCounts,
    dependencyLevels,
  };
}

function requestGpuWasmContext(): Promise<GpuWasmContextRequest> {
  if (contextPromise !== undefined) return contextPromise;
  const pendingContext: Promise<GpuWasmContextRequest> = (async () => {
    try {
      const request = await requestCompilerGpuDevice();
      if (request.status === "unavailable") return request;
      const device = request.device;
      const modules = [
        device.createShaderModule({ code: sizeShader }),
        device.createShaderModule({ code: lengthShader }),
        device.createShaderModule({ code: scanShader }),
        device.createShaderModule({ code: emissionShader }),
      ];
      const compilationMessages = (await Promise.all(
        modules.map((module) => module.getCompilationInfo()),
      )).flatMap((info) => info.messages).filter((message) =>
        message.type === "error"
      );
      if (compilationMessages.length > 0) {
        throw new Error(
          `WebGPU Wasm emitter shader failed: ${
            compilationMessages.map((message) => message.message).join("; ")
          }`,
        );
      }
      const [
        sizePipeline,
        lengthPipeline,
        scanPipeline,
        emissionPipeline,
      ] = await Promise.all(
        [
          [modules[0], "calculate_sizes"],
          [modules[1], "calculate_lengths"],
          [modules[2], "scan_step"],
          [modules[3], "emit_atoms"],
        ].map(([module, entryPoint]) =>
          device.createComputePipelineAsync({
            layout: "auto",
            compute: {
              module: module as GPUShaderModule,
              entryPoint: entryPoint as string,
            },
          })
        ),
      );
      return {
        status: "available",
        device,
        sizePipeline,
        lengthPipeline,
        scanPipeline,
        emissionPipeline,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: `WebGPU Wasm emitter initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  })();
  contextPromise = pendingContext;
  void pendingContext.then((context) => {
    if (context.status === "unavailable") {
      if (contextPromise === pendingContext) contextPromise = undefined;
      return;
    }
    void context.device.lost.then(() => {
      if (contextPromise === pendingContext) contextPromise = undefined;
    });
  });
  return pendingContext;
}

function createBuffer(
  device: GPUDevice,
  label: string,
  words: Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const binding = (usage & GPUBufferUsage.UNIFORM) !== 0
    ? "uniform"
    : "storage";
  const buffer = createCompilerGpuBuffer(
    device,
    label,
    {
      size: Math.max(4, words.byteLength),
      usage,
      mappedAtCreation: true,
    },
    binding,
  );
  new Uint32Array(buffer.getMappedRange()).set(words);
  buffer.unmap();
  return buffer;
}

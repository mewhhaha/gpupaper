export type CompilerGpuDeviceRequest =
  | { readonly status: "available"; readonly device: GPUDevice }
  | { readonly status: "unavailable"; readonly reason: string };

export type CompilerGpuBinding = "storage" | "uniform" | "copy";

export type CompilerGpuLimits = {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxUniformBufferBindingSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
  readonly maxStorageBuffersPerShaderStage: number;
  readonly maxUniformBuffersPerShaderStage: number;
};

export type CompilerGpuCapacityRequest =
  | {
    readonly kind: "buffer";
    readonly label: string;
    readonly byteLength: number;
    readonly binding: CompilerGpuBinding;
    readonly bindingByteLength?: number;
  }
  | {
    readonly kind: "dispatch";
    readonly label: string;
    readonly workgroupCount: number;
  }
  | {
    readonly kind: "pipelineBindings";
    readonly label: string;
    readonly storageBufferCount: number;
    readonly uniformBufferCount: number;
  };

let devicePromise: Promise<CompilerGpuDeviceRequest> | undefined;
let previousErrorScope = Promise.resolve();

export function requestCompilerGpuDevice(): Promise<CompilerGpuDeviceRequest> {
  if (devicePromise !== undefined) return devicePromise;
  const pendingRequest: Promise<CompilerGpuDeviceRequest> = (async () => {
    if (navigator.gpu === undefined) {
      return {
        status: "unavailable",
        reason: "WebGPU is unavailable in this runtime",
      };
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) {
        return {
          status: "unavailable",
          reason: "WebGPU adapter is unavailable",
        };
      }
      return { status: "available", device: await adapter.requestDevice() };
    } catch (error) {
      return {
        status: "unavailable",
        reason: `WebGPU device request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  })();
  devicePromise = pendingRequest;
  void pendingRequest.then((request) => {
    if (request.status === "unavailable") {
      if (devicePromise === pendingRequest) devicePromise = undefined;
      return;
    }
    void request.device.lost.then(() => {
      if (devicePromise === pendingRequest) devicePromise = undefined;
    });
  });
  return pendingRequest;
}

export async function acquireCompilerGpuErrorScope(): Promise<() => void> {
  const precedingScope = previousErrorScope;
  let release = () => {};
  previousErrorScope = new Promise<void>((resolve) => {
    release = resolve;
  });
  await precedingScope;
  return release;
}

export async function awaitCompilerGpuCommand<T>(
  device: GPUDevice,
  subject: string,
  completion: Promise<T>,
): Promise<T> {
  const lost = device.lost.then((loss) => {
    throw new CompilerGpuUnavailableError(
      `${subject}: WebGPU device was lost (${loss.reason}): ${
        loss.message || "no driver message"
      }`,
    );
  });
  try {
    return await Promise.race([completion, lost]);
  } catch (error) {
    const reason = compilerGpuUnavailabilityReason(subject, error);
    if (reason !== undefined) {
      throw new CompilerGpuUnavailableError(reason);
    }
    throw error;
  }
}

export function compilerGpuUnavailabilityReason(
  subject: string,
  error: unknown,
): string | undefined {
  if (error instanceof CompilerGpuUnavailableError) return error.message;
  if (
    typeof error === "object" && error !== null &&
    "name" in error && error.name === "GPUOutOfMemoryError"
  ) {
    const message = "message" in error && typeof error.message === "string"
      ? error.message
      : "no driver message";
    return `${subject}: WebGPU ran out of memory: ${message}`;
  }
  return undefined;
}

export function compilerGpuCapacityViolation(
  limits: CompilerGpuLimits,
  request: CompilerGpuCapacityRequest,
): string | undefined {
  if (request.kind === "pipelineBindings") {
    if (
      !Number.isSafeInteger(request.storageBufferCount) ||
      request.storageBufferCount < 0 ||
      !Number.isSafeInteger(request.uniformBufferCount) ||
      request.uniformBufferCount < 0
    ) {
      return `GPU ${request.label} pipeline requires non-negative safe-integer binding counts; received ${request.storageBufferCount} storage and ${request.uniformBufferCount} uniform`;
    }
    if (
      request.storageBufferCount > limits.maxStorageBuffersPerShaderStage
    ) {
      return `GPU ${request.label} pipeline requires ${request.storageBufferCount} storage buffers; device shader-stage limit is ${limits.maxStorageBuffersPerShaderStage}`;
    }
    if (
      request.uniformBufferCount > limits.maxUniformBuffersPerShaderStage
    ) {
      return `GPU ${request.label} pipeline requires ${request.uniformBufferCount} uniform buffers; device shader-stage limit is ${limits.maxUniformBuffersPerShaderStage}`;
    }
    return undefined;
  }
  if (request.kind === "dispatch") {
    if (
      !Number.isSafeInteger(request.workgroupCount) ||
      request.workgroupCount < 1
    ) {
      return `GPU ${request.label} dispatch requires a positive safe-integer workgroup count; received ${request.workgroupCount}`;
    }
    if (
      request.workgroupCount > limits.maxComputeWorkgroupsPerDimension
    ) {
      return `GPU ${request.label} dispatch requires ${request.workgroupCount} workgroups; device limit is ${limits.maxComputeWorkgroupsPerDimension}`;
    }
    return undefined;
  }

  if (!Number.isSafeInteger(request.byteLength) || request.byteLength < 1) {
    return `GPU ${request.label} buffer requires a positive safe-integer byte length; received ${request.byteLength}`;
  }
  if (request.byteLength > limits.maxBufferSize) {
    return `GPU ${request.label} buffer requires ${request.byteLength} bytes; device buffer limit is ${limits.maxBufferSize}`;
  }
  const bindingByteLength = request.bindingByteLength ?? request.byteLength;
  if (
    !Number.isSafeInteger(bindingByteLength) ||
    bindingByteLength < 1 ||
    bindingByteLength > request.byteLength
  ) {
    return `GPU ${request.label} buffer has ${request.byteLength} bytes but requests an invalid ${bindingByteLength}-byte binding`;
  }
  if (
    request.binding === "storage" &&
    bindingByteLength > limits.maxStorageBufferBindingSize
  ) {
    return `GPU ${request.label} storage binding requires ${bindingByteLength} bytes; device storage binding limit is ${limits.maxStorageBufferBindingSize}`;
  }
  if (
    request.binding === "uniform" &&
    bindingByteLength > limits.maxUniformBufferBindingSize
  ) {
    return `GPU ${request.label} uniform binding requires ${bindingByteLength} bytes; device uniform binding limit is ${limits.maxUniformBufferBindingSize}`;
  }
  return undefined;
}

export function createCompilerGpuBuffer(
  device: GPUDevice,
  label: string,
  descriptor: GPUBufferDescriptor,
  binding: CompilerGpuBinding,
  bindingByteLength?: number,
): GPUBuffer {
  const reason = compilerGpuCapacityViolation(device.limits, {
    kind: "buffer",
    label,
    byteLength: Number(descriptor.size),
    binding,
    bindingByteLength,
  });
  if (reason !== undefined) throw new CompilerGpuCapacityError(reason);
  return device.createBuffer(descriptor);
}

export function requireCompilerGpuCapacity(
  device: GPUDevice,
  request: CompilerGpuCapacityRequest,
): void {
  const reason = compilerGpuCapacityViolation(device.limits, request);
  if (reason !== undefined) throw new CompilerGpuCapacityError(reason);
}

export function dispatchCompilerGpuWorkgroups(
  device: GPUDevice,
  pass: GPUComputePassEncoder,
  label: string,
  workgroupCount: number,
): void {
  requireCompilerGpuCapacity(device, {
    kind: "dispatch",
    label,
    workgroupCount,
  });
  pass.dispatchWorkgroups(workgroupCount);
}

export class CompilerGpuCapacityError extends Error {
  override readonly name = "CompilerGpuCapacityError";
}

export class CompilerGpuUnavailableError extends Error {
  override readonly name = "CompilerGpuUnavailableError";
}

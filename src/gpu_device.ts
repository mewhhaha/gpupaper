export type CompilerGpuDeviceRequest =
  | { readonly status: "available"; readonly device: GPUDevice }
  | { readonly status: "unavailable"; readonly reason: string };

export type CompilerGpuBinding = "storage" | "uniform" | "copy";
export type CompilerGpuSchedulingPolicy = "latency" | "throughput";

export type CompilerGpuSubmissionMetrics = {
  readonly submissionBatchSize: number;
  readonly queueWaitMilliseconds: number;
};

export type CompilerGpuBatchResult<Output> = {
  readonly output: Output;
  readonly payloadBatchSize: number;
  readonly queueWaitMilliseconds: number;
};

export type CompilerGpuBatchQueue<Input, Output> = {
  enqueue(
    input: Input,
    scheduling?: CompilerGpuSchedulingPolicy,
  ): Promise<CompilerGpuBatchResult<Output>>;
};

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
const pendingSubmissions = new WeakMap<GPUDevice, CompilerGpuSubmission[]>();
const scheduledSubmissionFlushes = new WeakMap<
  GPUDevice,
  ReturnType<typeof setTimeout>
>();
const maximumThroughputSubmissionBatchSize = 16;
const maximumThroughputQueueDelayMilliseconds = 2;

type CompilerGpuSubmission = {
  readonly subject: string;
  readonly command: GPUCommandBuffer;
  readonly enqueuedAt: number;
  readonly scheduling: CompilerGpuSchedulingPolicy;
  readonly resolve: (metrics: CompilerGpuSubmissionMetrics) => void;
  readonly reject: (cause: unknown) => void;
};

type CompilerGpuBatchJob<Input, Output> = {
  readonly input: Input;
  readonly enqueuedAt: number;
  readonly scheduling: CompilerGpuSchedulingPolicy;
  readonly resolve: (result: CompilerGpuBatchResult<Output>) => void;
  readonly reject: (cause: unknown) => void;
};

export function createCompilerGpuBatchQueue<Input, Output>(
  executeBatch: (inputs: readonly Input[]) => Promise<readonly Output[]>,
): CompilerGpuBatchQueue<Input, Output> {
  let pending: CompilerGpuBatchJob<Input, Output>[] = [];
  let scheduledFlush: ReturnType<typeof setTimeout> | undefined;

  const flush = async (): Promise<void> => {
    if (scheduledFlush !== undefined) {
      clearTimeout(scheduledFlush);
      scheduledFlush = undefined;
    }
    const jobs = pending;
    pending = [];
    if (jobs.length === 0) return;
    const executionStart = performance.now();
    try {
      const outputs = await executeBatch(jobs.map((job) => job.input));
      if (outputs.length !== jobs.length) {
        throw new Error(
          `GPU batch returned ${outputs.length} results for ${jobs.length} jobs`,
        );
      }
      for (const [index, job] of jobs.entries()) {
        job.resolve({
          output: outputs[index]!,
          payloadBatchSize: jobs.length,
          queueWaitMilliseconds: Math.max(
            0,
            executionStart - job.enqueuedAt,
          ),
        });
      }
    } catch (cause) {
      for (const job of jobs) job.reject(cause);
    }
  };

  const schedule = (): void => {
    const requiresLatencyFlush = pending.some((job) =>
      job.scheduling === "latency"
    );
    if (
      pending.length >= maximumThroughputSubmissionBatchSize ||
      requiresLatencyFlush
    ) {
      if (scheduledFlush !== undefined) clearTimeout(scheduledFlush);
      scheduledFlush = setTimeout(() => void flush(), 0);
      return;
    }
    if (scheduledFlush !== undefined) return;
    scheduledFlush = setTimeout(
      () => void flush(),
      maximumThroughputQueueDelayMilliseconds,
    );
  };

  return {
    enqueue(input, scheduling = "latency") {
      return new Promise<CompilerGpuBatchResult<Output>>((resolve, reject) => {
        pending.push({
          input,
          enqueuedAt: performance.now(),
          scheduling,
          resolve,
          reject,
        });
        schedule();
      });
    },
  };
}

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

export function submitCompilerGpuCommand(
  device: GPUDevice,
  subject: string,
  command: GPUCommandBuffer,
  scheduling: CompilerGpuSchedulingPolicy = "latency",
): Promise<CompilerGpuSubmissionMetrics> {
  return new Promise<CompilerGpuSubmissionMetrics>((resolve, reject) => {
    const pending = pendingSubmissions.get(device);
    const submission = {
      subject,
      command,
      enqueuedAt: performance.now(),
      scheduling,
      resolve,
      reject,
    };
    if (pending !== undefined) {
      pending.push(submission);
      scheduleCompilerGpuSubmissionFlush(device, pending);
      return;
    }
    const submissions = [submission];
    pendingSubmissions.set(device, submissions);
    scheduleCompilerGpuSubmissionFlush(device, submissions);
  });
}

function scheduleCompilerGpuSubmissionFlush(
  device: GPUDevice,
  submissions: readonly CompilerGpuSubmission[],
): void {
  const scheduledFlush = scheduledSubmissionFlushes.get(device);
  const requiresLatencyFlush = submissions.some((submission) =>
    submission.scheduling === "latency"
  );
  if (
    submissions.length >= maximumThroughputSubmissionBatchSize ||
    requiresLatencyFlush
  ) {
    if (scheduledFlush !== undefined) clearTimeout(scheduledFlush);
    const timeout = setTimeout(() => {
      scheduledSubmissionFlushes.delete(device);
      void flushCompilerGpuSubmissions(device);
    }, 0);
    scheduledSubmissionFlushes.set(device, timeout);
    return;
  }
  if (scheduledFlush !== undefined) return;
  const timeout = setTimeout(() => {
    scheduledSubmissionFlushes.delete(device);
    void flushCompilerGpuSubmissions(device);
  }, maximumThroughputQueueDelayMilliseconds);
  scheduledSubmissionFlushes.set(device, timeout);
}

async function flushCompilerGpuSubmissions(device: GPUDevice): Promise<void> {
  const submissions = pendingSubmissions.get(device);
  if (submissions === undefined) return;
  pendingSubmissions.delete(device);
  const scheduledFlush = scheduledSubmissionFlushes.get(device);
  if (scheduledFlush !== undefined) {
    clearTimeout(scheduledFlush);
    scheduledSubmissionFlushes.delete(device);
  }

  const release = await acquireCompilerGpuErrorScope();
  let validationScopePending = false;
  try {
    const submissionStart = performance.now();
    const queueWaits = submissions.map((submission) =>
      Math.max(0, submissionStart - submission.enqueuedAt)
    );
    device.pushErrorScope("validation");
    validationScopePending = true;
    device.queue.submit(submissions.map((submission) => submission.command));
    await awaitCompilerGpuCommand(
      device,
      submissions.map((submission) => submission.subject).join(", "),
      device.queue.onSubmittedWorkDone(),
    );
    const validationError = await device.popErrorScope();
    validationScopePending = false;
    if (validationError !== null) {
      throw new Error(
        `WebGPU compiler submission validation failed: ${validationError.message}`,
      );
    }
    for (const [index, submission] of submissions.entries()) {
      submission.resolve({
        submissionBatchSize: submissions.length,
        queueWaitMilliseconds: queueWaits[index]!,
      });
    }
  } catch (cause) {
    for (const submission of submissions) submission.reject(cause);
  } finally {
    if (validationScopePending) await device.popErrorScope();
    release();
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

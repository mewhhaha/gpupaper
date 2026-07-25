export type CompilerGpuDeviceRequest =
  | { readonly status: "available"; readonly device: GPUDevice }
  | { readonly status: "unavailable"; readonly reason: string };

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

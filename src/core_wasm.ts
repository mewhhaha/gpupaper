export type {
  DucklangBackendFunctionCache as BackendFunctionCache,
  DucklangCoreWasmArtifact as CoreWasmArtifact,
  DucklangCoreWasmOptions as CoreWasmOptions,
  DucklangWasmTarget as WasmTarget,
} from "./ducklang_core_wasm.ts";

export {
  createDucklangBackendFunctionCache as createBackendFunctionCache,
  lowerDucklangCoreToFcgAndWasm as lowerCoreToWasm,
  validateDucklangCoreWasmTarget as validateCoreWasmTarget,
} from "./ducklang_core_wasm.ts";

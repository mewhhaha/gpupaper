/**
 * A deterministic compiler backend from monomorphic typed SSA/CFG Core to
 * WebAssembly.
 *
 * @module
 */

export * from "./src/core.ts";
export * from "./src/core_wasm.ts";
export * from "./src/rust_wasm_emitter.ts";
export {
  emitWasmPlanOnCpu,
  type WasmBinaryPlan,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./src/wasm.ts";

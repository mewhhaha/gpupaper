import {
  emitWasmPlanOnCpu,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "../src/wasm.ts";

Deno.test("v128 load and store preserve sixteen contiguous bytes", () => {
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType([], [wasmType.i32]);
  const memory = builder.addMemory(1);
  builder.addActiveData(
    memory,
    0,
    Uint8Array.from({ length: 16 }, (_, index) => index),
  );
  const run = builder.addFunction(type, [wasmType.v128], [
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.v128Load(),
    ...wasmInstruction.localSet(0),
    ...wasmInstruction.i32Constant(16),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.v128Store(),
    ...wasmInstruction.i32Constant(16),
    ...wasmInstruction.i32Load(),
  ]);
  builder.exportFunction("run", run);
  builder.exportMemory("memory", memory);
  const bytes = emitWasmPlanOnCpu(builder.finishPlan());
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(Uint8Array.from(bytes)),
  );
  const exportedRun = instance.exports.run;
  if (typeof exportedRun !== "function") {
    throw new Error("SIMD memory module did not export run");
  }

  assertEquals(exportedRun(), 0x0302_0100);
  const exportedMemory = instance.exports.memory;
  if (!(exportedMemory instanceof WebAssembly.Memory)) {
    throw new Error("SIMD memory module did not export memory");
  }
  assertEquals(
    Array.from(new Uint8Array(exportedMemory.buffer, 16, 16)),
    Array.from({ length: 16 }, (_, index) => index),
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  throw new Error(
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

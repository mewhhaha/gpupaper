import type {
  CoreBlockId,
  CoreFunctionId,
  CoreModule,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
} from "../src/core.ts";
import { validateCore } from "../src/core.ts";
import { lowerCoreToWasm } from "../src/core_wasm.ts";
import { emitWasmPlanOnCpu } from "../src/wasm.ts";

Deno.test("generic Core API emits an executable exported function", async () => {
  const i32 = 0 as CoreTypeId;
  const signature = 0 as CoreSignatureId;
  const main = 0 as CoreFunctionId;
  const entry = 0 as CoreBlockId;
  const answer = 0 as CoreValueId;
  const span = { file: "answer.example", start: 0, end: 9 };
  const core: CoreModule = {
    schemaVersion: 1,
    file: span.file,
    types: [{ kind: "scalar", scalar: "i32" }],
    signatures: [{ parameters: [], result: i32 }],
    functions: [{
      id: main,
      name: "answer",
      sourceSymbolId: undefined,
      signature,
      entryBlock: entry,
      blocks: [{
        id: entry,
        parameters: [],
        operations: [{
          kind: "constant",
          result: answer,
          type: i32,
          operands: [],
          value: 42,
          span,
        }],
        terminator: { kind: "return", values: [answer], span },
      }],
      span,
    }],
    entryFunction: main,
  };

  validateCore(core);
  const lowered = lowerCoreToWasm(core, {
    emission: "planOnly",
    target: "wasm-scalar",
    exports: [{ name: "answer", functionId: main }],
  });
  const bytes = emitWasmPlanOnCpu(lowered.wasmPlan);
  const compiled = await WebAssembly.compile(Uint8Array.from(bytes));
  const instance = await WebAssembly.instantiate(compiled);
  const exported = instance.exports.answer;
  if (!(exported instanceof Function)) {
    throw new Error("generic Core API omitted answer export");
  }
  const result = exported();
  if (result !== 42) {
    throw new Error(`generic Core API returned ${String(result)}`);
  }
});

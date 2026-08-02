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
      sourceIdentity: undefined,
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

Deno.test("closed Core emission removes imports reachable only from dead functions", async () => {
  const i32 = 0 as CoreTypeId;
  const signature = 0 as CoreSignatureId;
  const main = 0 as CoreFunctionId;
  const dead = 1 as CoreFunctionId;
  const entry = 0 as CoreBlockId;
  const value = 0 as CoreValueId;
  const span = { file: "reachability.example", start: 0, end: 1 };
  const core: CoreModule = {
    schemaVersion: 1,
    file: span.file,
    types: [{ kind: "scalar", scalar: "i32" }],
    signatures: [{ parameters: [], result: i32 }],
    functions: [{
      id: main,
      name: "main",
      sourceIdentity: undefined,
      signature,
      entryBlock: entry,
      blocks: [{
        id: entry,
        parameters: [],
        operations: [{
          kind: "constant",
          result: value,
          type: i32,
          operands: [],
          value: 42,
          span,
        }],
        terminator: { kind: "return", values: [value], span },
      }],
      span,
    }, {
      id: dead,
      name: "dead",
      sourceIdentity: undefined,
      signature,
      entryBlock: entry,
      blocks: [{
        id: entry,
        parameters: [],
        operations: [{
          kind: "host.call",
          effectName: "Dead",
          operationName: "observe",
          result: value,
          type: i32,
          operands: [],
          span,
        }],
        terminator: { kind: "return", values: [value], span },
      }],
      span,
    }],
    entryFunction: main,
  };

  const lowered = lowerCoreToWasm(core, {
    emission: "planOnly",
    target: "wasm-scalar",
    exports: [{ name: "main", functionId: main }],
  });
  const module = await WebAssembly.compile(
    Uint8Array.from(emitWasmPlanOnCpu(lowered.wasmPlan)),
  );
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error("dead Core function retained its host import");
  }
  const instance = await WebAssembly.instantiate(module);
  const exported = instance.exports.main;
  if (!(exported instanceof Function) || exported() !== 42) {
    throw new Error("reachable Core export changed after dead-code removal");
  }
});

Deno.test("canonical natural loop preserves reverse edges and parallel assignments", async () => {
  const i32 = 0 as CoreTypeId;
  const signature = 0 as CoreSignatureId;
  const rotate = 0 as CoreFunctionId;
  const span = { file: "rotate.example", start: 0, end: 1 };
  const value = (id: number) => id as CoreValueId;
  const block = (id: number) => id as CoreBlockId;
  const core: CoreModule = {
    schemaVersion: 1,
    file: span.file,
    types: [{ kind: "scalar", scalar: "i32" }],
    signatures: [{ parameters: [i32, i32, i32], result: i32 }],
    functions: [{
      id: rotate,
      name: "rotate",
      sourceIdentity: undefined,
      signature,
      entryBlock: block(0),
      blocks: [{
        id: block(0),
        parameters: [0, 1, 2].map((id) => ({
          value: value(id),
          type: i32,
          span,
        })),
        operations: [],
        terminator: {
          kind: "branch",
          target: block(1),
          arguments: [value(2), value(0), value(1)],
          span,
        },
      }, {
        id: block(1),
        parameters: [3, 4, 5].map((id) => ({
          value: value(id),
          type: i32,
          span,
        })),
        operations: [{
          kind: "constant",
          result: value(6),
          type: i32,
          operands: [],
          value: 0,
          span,
        }, {
          kind: "scalar.binary",
          result: value(7),
          type: i32,
          operands: [value(3), value(6)],
          operator: "==",
          span,
        }],
        terminator: {
          kind: "conditional_branch",
          condition: value(7),
          trueTarget: block(3),
          trueArguments: [value(4)],
          falseTarget: block(2),
          falseArguments: [value(3), value(4), value(5)],
          span,
        },
      }, {
        id: block(2),
        parameters: [8, 9, 10].map((id) => ({
          value: value(id),
          type: i32,
          span,
        })),
        operations: [{
          kind: "constant",
          result: value(11),
          type: i32,
          operands: [],
          value: 1,
          span,
        }, {
          kind: "scalar.binary",
          result: value(12),
          type: i32,
          operands: [value(8), value(11)],
          operator: "-",
          span,
        }],
        terminator: {
          kind: "branch",
          target: block(1),
          arguments: [value(12), value(10), value(9)],
          span,
        },
      }, {
        id: block(3),
        parameters: [{ value: value(13), type: i32, span }],
        operations: [],
        terminator: { kind: "return", values: [value(13)], span },
      }],
      span,
    }],
    entryFunction: rotate,
  };

  validateCore(core);
  const lowered = lowerCoreToWasm(core, {
    emission: "planOnly",
    target: "wasm-scalar",
    exports: [{ name: "rotate", functionId: rotate }],
  });
  const wasm = Uint8Array.from(emitWasmPlanOnCpu(lowered.wasmPlan));
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(wasm),
  );
  const exported = instance.exports.rotate;
  if (!(exported instanceof Function)) throw new Error("missing rotate export");
  for (const [rounds, expected] of [[0, 7], [1, 9], [2, 7], [3, 9]]) {
    const actual = exported(7, 9, rounds);
    if (actual !== expected) {
      throw new Error(
        `rotate(7, 9, ${rounds}) returned ${
          String(actual)
        }; expected ${expected}`,
      );
    }
  }
  if (wasm.byteLength >= 160) {
    throw new Error(
      `structured natural-loop module is ${wasm.byteLength} bytes; expected less than 160`,
    );
  }
});

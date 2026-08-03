import {
  emitWasmPlanOnCpu,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "../src/wasm.ts";
import type {
  CoreBlockId,
  CoreFunctionId,
  CoreModule,
  CoreOperation,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
} from "../src/core.ts";
import { PrimitiveId } from "../src/core.ts";
import { lowerCoreToWasm } from "../src/core_wasm.ts";
import { flattenCore, inflateFlatCore } from "../src/flat_core.ts";

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

Deno.test("Core vector memory operations remain ordered and observable", () => {
  const core = coreMemoryModule();

  const artifact = lowerCoreToWasm(core, { emission: "cpu" });
  const inflated = inflateFlatCore(flattenCore(core));
  assertEquals(inflated.memory, core.memory);
  const inflatedOperations = inflated.functions[0].blocks[0].operations;
  assertEquals(inflatedOperations[3].kind, "vector.store");
  assertEquals(inflatedOperations[4].kind, "vector.load");
  if (artifact.wasm === undefined) {
    throw new Error("Core memory Wasm was not emitted");
  }
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(Uint8Array.from(artifact.wasm)),
  );
  const run = instance.exports.main;
  if (typeof run !== "function") {
    throw new Error("Core memory module did not export main");
  }
  assertEquals(run(), 7);
});

Deno.test("Core rejects vector memory operations outside the memory model", () => {
  const core = coreMemoryModule();
  const load = core.functions[0].blocks[0].operations[4];
  if (load.kind !== "vector.load") {
    throw new Error(
      `memory fixture operation 4 is ${load.kind}, not vector.load`,
    );
  }
  const vector = core.functions[0].blocks[0].operations[2].result;
  assertThrows(
    () => lowerCoreToWasm({ ...core, memory: undefined }),
    /requires a declared linear memory/,
  );
  assertThrows(
    () =>
      lowerCoreToWasm({
        ...core,
        memory: { minimumPages: 65_537 },
      }),
    /memory minimum must be in 0\.\.65536 pages; received 65537/,
  );
  assertThrows(
    () =>
      lowerCoreToWasm(
        replaceEntryOperation(core, 4, {
          ...load,
          mode: "8x8_s",
        }),
      ),
    /8x8_s returns i16x8, not i8x16/,
  );
  assertThrows(
    () =>
      lowerCoreToWasm(
        replaceEntryOperation(core, 4, {
          ...load,
          mode: "8_lane",
          lane: 16,
          operands: [load.operands[0], vector],
        }),
      ),
    /invalid i8 lane 16/,
  );
});

Deno.test("portable and relaxed SIMD opcode families validate together", () => {
  const vector = wasmInstruction.v128Constant(
    Array.from({ length: 16 }, (_, index) => index),
  );
  const unaryVector = [
    wasmInstruction.i8x16Absolute,
    wasmInstruction.i8x16Negate,
    wasmInstruction.i8x16PopulationCount,
    wasmInstruction.i16x8Absolute,
    wasmInstruction.i16x8Negate,
    wasmInstruction.i16x8ExtendLowI8x16Signed,
    wasmInstruction.i16x8ExtendHighI8x16Unsigned,
    wasmInstruction.i16x8ExtendedAddPairwiseI8x16Signed,
    wasmInstruction.i32x4Absolute,
    wasmInstruction.i32x4Negate,
    wasmInstruction.i32x4ExtendLowI16x8Signed,
    wasmInstruction.i32x4ExtendedAddPairwiseI16x8Unsigned,
    wasmInstruction.i64x2Absolute,
    wasmInstruction.i64x2Negate,
    wasmInstruction.i64x2ExtendLowI32x4Signed,
    wasmInstruction.f32x4DemoteF64x2Zero,
    wasmInstruction.f64x2PromoteLowF32x4,
    wasmInstruction.f64x2SquareRoot,
    wasmInstruction.i32x4TruncateSaturateF64x2SignedZero,
    wasmInstruction.f64x2ConvertLowI32x4Unsigned,
    wasmInstruction.i32x4RelaxedTruncateF32x4Signed,
    wasmInstruction.i32x4RelaxedTruncateF32x4Unsigned,
    wasmInstruction.i32x4RelaxedTruncateF64x2SignedZero,
    wasmInstruction.i32x4RelaxedTruncateF64x2UnsignedZero,
  ];
  const binaryVector = [
    wasmInstruction.i8x16Swizzle,
    wasmInstruction.v128AndNot,
    wasmInstruction.i8x16NotEqual,
    wasmInstruction.i8x16GreaterThanUnsigned,
    wasmInstruction.i8x16AddSaturateSigned,
    wasmInstruction.i8x16SubtractSaturateUnsigned,
    wasmInstruction.i8x16NarrowI16x8Signed,
    wasmInstruction.i8x16AverageUnsigned,
    wasmInstruction.i16x8NotEqual,
    wasmInstruction.i16x8GreaterThanOrEqualUnsigned,
    wasmInstruction.i16x8Q15MultiplyRoundSaturateSigned,
    wasmInstruction.i16x8NarrowI32x4Unsigned,
    wasmInstruction.i16x8ExtendedMultiplyHighI8x16Signed,
    wasmInstruction.i32x4DotI16x8Signed,
    wasmInstruction.i32x4ExtendedMultiplyLowI16x8Unsigned,
    wasmInstruction.i64x2Multiply,
    wasmInstruction.i64x2GreaterThanOrEqualSigned,
    wasmInstruction.i64x2ExtendedMultiplyHighI32x4Unsigned,
    wasmInstruction.f64x2Add,
    wasmInstruction.f64x2GreaterThan,
    wasmInstruction.f64x2PseudoMaximum,
    wasmInstruction.i8x16RelaxedSwizzle,
    wasmInstruction.f32x4RelaxedMinimum,
    wasmInstruction.f32x4RelaxedMaximum,
    wasmInstruction.f64x2RelaxedMinimum,
    wasmInstruction.f64x2RelaxedMaximum,
    wasmInstruction.i16x8RelaxedQ15MultiplyRoundSigned,
    wasmInstruction.i16x8RelaxedDotI8x16I7x16Signed,
  ];
  const ternaryVector = [
    wasmInstruction.f32x4RelaxedMultiplyAdd,
    wasmInstruction.f32x4RelaxedNegativeMultiplyAdd,
    wasmInstruction.f64x2RelaxedMultiplyAdd,
    wasmInstruction.f64x2RelaxedNegativeMultiplyAdd,
    wasmInstruction.i8x16RelaxedLaneSelect,
    wasmInstruction.i16x8RelaxedLaneSelect,
    wasmInstruction.i32x4RelaxedLaneSelect,
    wasmInstruction.i64x2RelaxedLaneSelect,
    wasmInstruction.i32x4RelaxedDotI8x16I7x16AddSigned,
  ];
  const reductions = [
    wasmInstruction.i8x16AllTrue,
    wasmInstruction.i16x8Bitmask,
    wasmInstruction.i32x4AllTrue,
    wasmInstruction.i64x2Bitmask,
    wasmInstruction.v128AnyTrue,
  ];
  const shifts = [
    wasmInstruction.i8x16ShiftLeft,
    wasmInstruction.i16x8ShiftRightUnsigned,
    wasmInstruction.i32x4ShiftRightSigned,
    wasmInstruction.i64x2ShiftLeft,
  ];
  const body = unaryVector.flatMap((operation) => [
    ...vector,
    ...operation,
    ...wasmInstruction.drop,
  ]);
  for (const operation of binaryVector) {
    body.push(...vector, ...vector, ...operation, ...wasmInstruction.drop);
  }
  for (const operation of ternaryVector) {
    body.push(
      ...vector,
      ...vector,
      ...vector,
      ...operation,
      ...wasmInstruction.drop,
    );
  }
  for (const operation of reductions) {
    body.push(...vector, ...operation, ...wasmInstruction.drop);
  }
  for (const operation of shifts) {
    body.push(
      ...vector,
      ...wasmInstruction.i32Constant(3),
      ...operation,
      ...wasmInstruction.drop,
    );
  }
  body.push(
    ...wasmInstruction.i32Constant(7),
    ...wasmInstruction.i8x16Splat,
    ...wasmInstruction.i8x16ExtractLaneUnsigned(0),
    ...wasmInstruction.drop,
    ...wasmInstruction.i64Constant(7n),
    ...wasmInstruction.i64x2Splat,
    ...wasmInstruction.i64x2ExtractLane(1),
    ...wasmInstruction.drop,
    ...wasmInstruction.f64Constant(7),
    ...wasmInstruction.f64x2Splat,
    ...wasmInstruction.f64x2ExtractLane(0),
    ...wasmInstruction.drop,
    ...wasmInstruction.i32Constant(0),
  );
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType([], [wasmType.i32]);
  const run = builder.addFunction(type, [], body);
  builder.exportFunction("run", run);
  const bytes = Uint8Array.from(emitWasmPlanOnCpu(builder.finishPlan()));

  assertEquals(WebAssembly.validate(bytes), true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const exportedRun = instance.exports.run;
  if (typeof exportedRun !== "function") {
    throw new Error("SIMD catalog module did not export run");
  }
  assertEquals(exportedRun(), 0);
});

Deno.test("every portable SIMD memory form validates", () => {
  const vector = wasmInstruction.v128Constant(new Array(16).fill(1));
  const loads = [
    wasmInstruction.v128Load(),
    wasmInstruction.v128Load8x8Signed(),
    wasmInstruction.v128Load8x8Unsigned(),
    wasmInstruction.v128Load16x4Signed(),
    wasmInstruction.v128Load16x4Unsigned(),
    wasmInstruction.v128Load32x2Signed(),
    wasmInstruction.v128Load32x2Unsigned(),
    wasmInstruction.v128Load8Splat(),
    wasmInstruction.v128Load16Splat(),
    wasmInstruction.v128Load32Splat(),
    wasmInstruction.v128Load64Splat(),
    wasmInstruction.v128Load32Zero(),
    wasmInstruction.v128Load64Zero(),
  ];
  const body = loads.flatMap((operation) => [
    ...wasmInstruction.i32Constant(0),
    ...operation,
    ...wasmInstruction.drop,
  ]);
  for (const laneBits of [8, 16, 32, 64] as const) {
    body.push(
      ...wasmInstruction.i32Constant(0),
      ...vector,
      ...wasmInstruction.v128LoadLane(laneBits, 0),
      ...wasmInstruction.drop,
      ...wasmInstruction.i32Constant(0),
      ...vector,
      ...wasmInstruction.v128StoreLane(laneBits, 0),
    );
  }
  body.push(...wasmInstruction.i32Constant(0));
  const builder = new WasmModuleBuilder();
  builder.addMemory(1);
  const type = builder.addFunctionType([], [wasmType.i32]);
  const run = builder.addFunction(type, [], body);
  builder.exportFunction("run", run);
  const bytes = Uint8Array.from(emitWasmPlanOnCpu(builder.finishPlan()));

  assertEquals(WebAssembly.validate(bytes), true);
});

Deno.test("packed SIMD boundaries preserve saturation, extension, pairing, and Q15", () => {
  const words = wasmInstruction.v128Constant(
    [1, 2, 3, 4, 5, 6, 7, 8].flatMap((value) => [value, 0]),
  );
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType([], [wasmType.i32]);
  const run = builder.addFunction(type, [], [
    ...wasmInstruction.i32Constant(250),
    ...wasmInstruction.i8x16Splat,
    ...wasmInstruction.i32Constant(20),
    ...wasmInstruction.i8x16Splat,
    ...wasmInstruction.i8x16AddSaturateUnsigned,
    ...wasmInstruction.i8x16ExtractLaneUnsigned(0),
    ...wasmInstruction.i32Constant(-1),
    ...wasmInstruction.i8x16Splat,
    ...wasmInstruction.i16x8ExtendLowI8x16Signed,
    ...wasmInstruction.i16x8ExtractLaneSigned(0),
    ...wasmInstruction.i32Add,
    ...words,
    ...words,
    ...wasmInstruction.i32x4DotI16x8Signed,
    ...wasmInstruction.i32x4ExtractLane(0),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.i32Constant(-32_768),
    ...wasmInstruction.i16x8Splat,
    ...wasmInstruction.i32Constant(-32_768),
    ...wasmInstruction.i16x8Splat,
    ...wasmInstruction.i16x8Q15MultiplyRoundSaturateSigned,
    ...wasmInstruction.i16x8ExtractLaneSigned(0),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.i32Constant(300),
    ...wasmInstruction.i16x8Splat,
    ...wasmInstruction.i32Constant(-200),
    ...wasmInstruction.i16x8Splat,
    ...wasmInstruction.i8x16NarrowI16x8Signed,
    ...wasmInstruction.i8x16ExtractLaneSigned(0),
    ...wasmInstruction.i32Add,
  ]);
  builder.exportFunction("run", run);
  const bytes = Uint8Array.from(emitWasmPlanOnCpu(builder.finishPlan()));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const exportedRun = instance.exports.run;
  if (typeof exportedRun !== "function") {
    throw new Error("packed boundary module did not export run");
  }

  assertEquals(exportedRun(), 33_153);
});

function coreMemoryModule(): CoreModule {
  const i32 = 0 as CoreTypeId;
  const unit = 1 as CoreTypeId;
  const bytes = 2 as CoreTypeId;
  const address = 0 as CoreValueId;
  const scalar = 1 as CoreValueId;
  const vector = 2 as CoreValueId;
  const stored = 3 as CoreValueId;
  const loaded = 4 as CoreValueId;
  const result = 5 as CoreValueId;
  const span = { file: "memory.core", start: 0, end: 1 };
  return {
    schemaVersion: 1,
    file: span.file,
    types: [
      { kind: "scalar", scalar: "i32" },
      { kind: "scalar", scalar: "unit" },
      { kind: "vector", lanes: 16, element: "i8" },
    ],
    signatures: [{ parameters: [], result: i32 }],
    functions: [{
      id: 0 as CoreFunctionId,
      name: "run",
      sourceIdentity: undefined,
      signature: 0 as CoreSignatureId,
      entryBlock: 0 as CoreBlockId,
      blocks: [{
        id: 0 as CoreBlockId,
        parameters: [],
        operations: [{
          kind: "constant",
          result: address,
          type: i32,
          operands: [],
          value: 0,
          span,
        }, {
          kind: "constant",
          result: scalar,
          type: i32,
          operands: [],
          value: 7,
          span,
        }, {
          kind: "primitive",
          result: vector,
          type: bytes,
          operands: [scalar],
          primitiveId: PrimitiveId.i8x16Splat,
          span,
        }, {
          kind: "vector.store",
          result: stored,
          type: unit,
          operands: [address, vector],
          mode: "128",
          alignmentExponent: 0,
          offset: 0,
          span,
        }, {
          kind: "vector.load",
          result: loaded,
          type: bytes,
          operands: [address],
          mode: "128",
          alignmentExponent: 0,
          offset: 0,
          span,
        }, {
          kind: "primitive",
          result,
          type: i32,
          operands: [loaded],
          primitiveId: PrimitiveId.i8x16ExtractLaneUnsigned0,
          span,
        }],
        terminator: { kind: "return", values: [result], span },
      }],
      span,
    }],
    entryFunction: 0 as CoreFunctionId,
    memory: { minimumPages: 1, maximumPages: 1, exportName: "memory" },
  };
}

function replaceEntryOperation(
  module: CoreModule,
  index: number,
  operation: CoreOperation,
): CoreModule {
  const function_ = module.functions[0];
  const block = function_.blocks[0];
  return {
    ...module,
    functions: [{
      ...function_,
      blocks: [{
        ...block,
        operations: block.operations.map((candidate, candidateIndex) =>
          candidateIndex === index ? operation : candidate
        ),
      }],
    }],
  };
}

function assertThrows(operation: () => unknown, expected: RegExp): void {
  try {
    operation();
  } catch (cause) {
    if (cause instanceof Error && expected.test(cause.message)) return;
    throw new Error(
      `expected rejection ${expected}; received ${String(cause)}`,
    );
  }
  throw new Error(`expected rejection ${expected}; operation completed`);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  throw new Error(
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

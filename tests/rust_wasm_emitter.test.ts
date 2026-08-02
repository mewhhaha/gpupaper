import {
  createRustWasmEmitter,
  emitWasmPlanOnRustWasm,
} from "../src/rust_wasm_emitter.ts";
import {
  emitWasmPlanOnCpu,
  type WasmBinaryPlan,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "../src/wasm.ts";

Deno.test("Rust/Wasm emission covers every scalar atom boundary", async () => {
  const { emitter } = await createRustWasmEmitter();
  const plan: WasmBinaryPlan = {
    atoms: [
      { kind: "byte", value: 0 },
      { kind: "byte", value: 255 },
      { kind: "unsigned", value: 0 },
      { kind: "unsigned", value: 127 },
      { kind: "unsigned", value: 128 },
      { kind: "unsigned", value: 0xffff_ffff },
      { kind: "signed32", value: -0x8000_0000 },
      { kind: "signed32", value: -65 },
      { kind: "signed32", value: 63 },
      { kind: "signed32", value: 0x7fff_ffff },
      { kind: "signed64", value: -0x8000_0000_0000_0000n },
      { kind: "signed64", value: -65n },
      { kind: "signed64", value: 63n },
      { kind: "signed64", value: 0x7fff_ffff_ffff_ffffn },
    ],
    maximumDependencyLevel: 0,
  };

  assertBytes(emitter.emit(plan).bytes, emitWasmPlanOnCpu(plan));
});

Deno.test("Rust/Wasm constant-work sizing preserves every LEB transition", async () => {
  const { emitter } = await createRustWasmEmitter();
  const atoms: WasmBinaryPlan["atoms"][number][] = [];
  for (let group = 1; group <= 4; group += 1) {
    const boundary = 2 ** (group * 7);
    atoms.push(
      { kind: "unsigned", value: boundary - 1 },
      { kind: "unsigned", value: boundary },
    );
  }
  atoms.push({ kind: "unsigned", value: 0xffff_ffff });
  for (let group = 1; group <= 4; group += 1) {
    const positiveBoundary = 2 ** (group * 7 - 1);
    atoms.push(
      { kind: "signed32", value: -positiveBoundary },
      { kind: "signed32", value: positiveBoundary - 1 },
      { kind: "signed32", value: -positiveBoundary - 1 },
      { kind: "signed32", value: positiveBoundary },
    );
  }
  atoms.push(
    { kind: "signed32", value: -0x8000_0000 },
    { kind: "signed32", value: 0x7fff_ffff },
  );
  for (let group = 1n; group <= 9n; group += 1n) {
    const positiveBoundary = 1n << (group * 7n - 1n);
    atoms.push(
      { kind: "signed64", value: -positiveBoundary },
      { kind: "signed64", value: positiveBoundary - 1n },
      { kind: "signed64", value: -positiveBoundary - 1n },
      { kind: "signed64", value: positiveBoundary },
    );
  }
  atoms.push(
    { kind: "signed64", value: -0x8000_0000_0000_0000n },
    { kind: "signed64", value: 0x7fff_ffff_ffff_ffffn },
  );
  const plan: WasmBinaryPlan = { atoms, maximumDependencyLevel: 0 };

  assertBytes(emitter.emit(plan).bytes, emitWasmPlanOnCpu(plan));
});

Deno.test("Rust/Wasm emission resolves nested module lengths", async () => {
  const { emitter } = await createRustWasmEmitter();
  const plan = buildModule(130).finishPlan();
  const emitted = emitter.emit(plan);

  assertBytes(emitted.bytes, emitWasmPlanOnCpu(plan));
  assertEquals(
    WebAssembly.validate(emitted.bytes.slice().buffer as ArrayBuffer),
    true,
  );
  assertEquals(emitted.preparationTimings.inputBytes, plan.atoms.length * 16);
  assertNonNegativeTimings(emitted.preparationTimings);
  assertNonNegativeTimings(emitted.timings);
});

Deno.test("Rust/Wasm emission skips empty dependency levels", async () => {
  const { emitter } = await createRustWasmEmitter();
  const plan: WasmBinaryPlan = {
    atoms: [
      { kind: "byte", value: 42 },
      {
        kind: "length",
        rangeStart: 0,
        rangeCount: 1,
        dependencyLevel: 1_000_000_000,
      },
    ],
    maximumDependencyLevel: 1_000_000_000,
  };

  assertBytes(emitter.emit(plan).bytes, emitWasmPlanOnCpu(plan));
});

Deno.test("Rust/Wasm SIMD length sums preserve vector boundaries", async () => {
  const { emitter } = await createRustWasmEmitter();
  for (
    const range of [
      { start: 0, count: 15 },
      { start: 0, count: 16 },
      { start: 0, count: 17 },
      { start: 1, count: 32 },
    ]
  ) {
    const atoms: WasmBinaryPlan["atoms"] = [
      ...Array.from(
        { length: range.start + range.count },
        (_, value) => ({ kind: "byte" as const, value: value & 0xff }),
      ),
      {
        kind: "length",
        rangeStart: range.start,
        rangeCount: range.count,
        dependencyLevel: 1,
      },
    ];
    const plan: WasmBinaryPlan = { atoms, maximumDependencyLevel: 1 };
    assertBytes(emitter.emit(plan).bytes, emitWasmPlanOnCpu(plan));
  }
});

Deno.test("Rust/Wasm validation rejects a same-level length dependency", async () => {
  const { emitter } = await createRustWasmEmitter();
  const plan: WasmBinaryPlan = {
    atoms: [
      {
        kind: "length",
        rangeStart: 1,
        rangeCount: 1,
        dependencyLevel: 1,
      },
      {
        kind: "length",
        rangeStart: 0,
        rangeCount: 0,
        dependencyLevel: 1,
      },
    ],
    maximumDependencyLevel: 1,
  };

  assertThrows(
    () => emitter.prepare(plan),
    /length atom 0 at level 1 depends on atom 1 at level 1/,
  );
});

Deno.test("Rust/Wasm SIMD validation preserves exact lane diagnostics", async () => {
  const bytes = await Deno.readFile(
    new URL(
      "../src/generated/rust_wasm_emitter.wasm",
      import.meta.url,
    ),
  );
  const instance = await WebAssembly.instantiate(bytes);
  const exports = instance.instance.exports as {
    readonly memory: WebAssembly.Memory;
    readonly abi_version: () => number;
    readonly input_resize: (wordCount: number) => number;
    readonly prepare_plan: (atomCount: number, maximumLevel: number) => number;
    readonly last_error_ptr: () => number;
    readonly last_error_len: () => number;
  };
  assertEquals(exports.abi_version(), 2);

  const invalidVectorLane = new Uint32Array([
    0,
    0,
    0,
    0,
    1,
    2,
    256,
    4,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  writeRawWords(exports, invalidVectorLane);
  assertEquals(exports.prepare_plan(4, 0) >>> 0, 0xffff_ffff);
  assertEquals(
    readRawError(exports),
    "Rust/Wasm byte atom 2 must fit u8; received 256",
  );

  const invalidScalarTail = new Uint32Array(5 * 4);
  invalidScalarTail[4] = 9;
  writeRawWords(exports, invalidScalarTail);
  assertEquals(exports.prepare_plan(5, 0) >>> 0, 0xffff_ffff);
  assertEquals(readRawError(exports), "Rust/Wasm atom 4 has unknown kind 9");
});

Deno.test("Rust/Wasm resident output remains isolated and release is affine", async () => {
  const { emitter } = await createRustWasmEmitter();
  const plan = buildModule(8).finishPlan();
  const expected = emitWasmPlanOnCpu(plan);
  const resident = emitter.prepare(plan);
  const first = resident.emit().bytes;
  first[0] = 255;
  const second = resident.emit().bytes;

  assertBytes(second, expected);
  assertEquals(first.buffer === second.buffer, false);
  resident.release();
  assertEquals(resident.released, true);
  assertThrows(() => resident.emit(), /cannot emit after release/);
  assertThrows(() => resident.release(), /already been released/);
});

Deno.test("Rust/Wasm resident handles keep independent plans", async () => {
  const { emitter } = await createRustWasmEmitter();
  const firstPlan = buildModule(1).finishPlan();
  const secondPlan = buildModule(20).finishPlan();
  const first = emitter.prepare(firstPlan);
  const second = emitter.prepare(secondPlan);
  try {
    assertBytes(second.emit().bytes, emitWasmPlanOnCpu(secondPlan));
    assertBytes(first.emit().bytes, emitWasmPlanOnCpu(firstPlan));
  } finally {
    first.release();
    second.release();
  }
});

Deno.test("Rust/Wasm ingestion rejects an unrepresentable scalar before coercion", async () => {
  const { emitter } = await createRustWasmEmitter();
  const plan: WasmBinaryPlan = {
    atoms: [{ kind: "unsigned", value: 0x1_0000_0000 }],
    maximumDependencyLevel: 0,
  };

  assertThrows(() => emitter.prepare(plan), /unsigned atom 0 must fit u32/);
});

Deno.test("Rust/Wasm ingestion rejects columns outside memory32 before allocation", async () => {
  const { emitter } = await createRustWasmEmitter();
  const atoms = { length: 0x1000_0000 } as unknown as WasmBinaryPlan["atoms"];

  assertThrows(
    () => emitter.prepare({ atoms, maximumDependencyLevel: 0 }),
    /4294967296 column bytes.*memory32 ABI maximum is 4294967295/,
  );
});

Deno.test("shared Rust/Wasm cold emission preserves the public plan boundary", async () => {
  const plan = buildModule(3).finishPlan();
  const emitted = await emitWasmPlanOnRustWasm(plan);

  assertBytes(emitted.bytes, emitWasmPlanOnCpu(plan));
});

function buildModule(functionCount: number): WasmModuleBuilder {
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType([wasmType.i64], [wasmType.i64]);
  for (let index = 0; index < functionCount; index += 1) {
    builder.addFunction(type, [], [
      ...wasmInstruction.localGet(0),
      ...wasmInstruction.i64Constant(BigInt(index) - 65n),
      ...wasmInstruction.i64Add,
    ]);
  }
  builder.exportFunction("main", 0);
  return builder;
}

function assertBytes(actual: Uint8Array, expected: Uint8Array): void {
  if (
    actual.length !== expected.length ||
    actual.some((byte, index) => byte !== expected[index])
  ) {
    throw new Error(
      `byte mismatch: expected ${expected.length} bytes, received ${actual.length}`,
    );
  }
}

function writeRawWords(
  exports: {
    readonly memory: WebAssembly.Memory;
    readonly input_resize: (wordCount: number) => number;
  },
  words: Uint32Array,
): void {
  const pointer = exports.input_resize(words.length) >>> 0;
  const view = new DataView(exports.memory.buffer);
  for (const [wordIndex, word] of words.entries()) {
    view.setUint32(pointer + wordIndex * 4, word, true);
  }
}

function readRawError(exports: {
  readonly memory: WebAssembly.Memory;
  readonly last_error_ptr: () => number;
  readonly last_error_len: () => number;
}): string {
  const pointer = exports.last_error_ptr() >>> 0;
  const length = exports.last_error_len() >>> 0;
  return new TextDecoder().decode(
    new Uint8Array(exports.memory.buffer, pointer, length),
  );
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assertThrows(action: () => unknown, expected: RegExp): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && expected.test(error.message)) return;
    throw error;
  }
  throw new Error(`expected action to throw ${expected}`);
}

function assertNonNegativeTimings(
  timings: Record<string, number>,
): void {
  for (const [name, milliseconds] of Object.entries(timings)) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error(`timing ${name} is invalid: ${milliseconds}`);
    }
  }
}

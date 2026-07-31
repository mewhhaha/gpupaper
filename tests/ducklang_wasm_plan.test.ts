import {
  analyzeWasmBinaryPlan,
  emitWasmPlanOnCpu,
  validateWasmBinaryPlan,
  wasmBinaryPlanByteLength,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "../src/wasm.ts";

/**
 * Binary sizes and offsets are calculated by count-scan-write.
 *
 * A section's length cannot be written until its contents are sized, and a nested length
 * depends on the lengths inside it, so the plan carries `length` atoms with a dependency
 * level and resolves them level by level before writing bytes.
 *
 * `WebAssembly.validate` is the check that a length is right, and it was chosen by
 * measurement rather than assumption. A hand-written walk over declared section sizes
 * looked like the obvious verifier, but corrupting a section length by one byte still
 * walked cleanly in one direction even after adding section-id checks, so it would have
 * given false confidence. The engine rejects the same module in both directions, so it is
 * what the tests assert against.
 *
 * The existing plan test in tests/compiler.test.ts compares CPU and GPU emission and
 * returns early when no adapter is present, so it asserts nothing without GPU hardware.
 * These run on the CPU path alone.
 */

function buildModule(functionCount: number): WasmModuleBuilder {
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType([wasmType.i32], [wasmType.i32]);
  for (let index = 0; index < functionCount; index += 1) {
    builder.addFunction(type, [], [
      ...wasmInstruction.localGet(0),
      ...wasmInstruction.i32Constant(index + 1),
      ...wasmInstruction.i32Add,
    ]);
  }
  builder.exportFunction("main", 0);
  return builder;
}

Deno.test("Ducklang Wasm plans resolve nested lengths before writing", () => {
  const builder = buildModule(3);
  const plan = builder.finishPlan();

  validateWasmBinaryPlan(plan);
  // Code sections nest a body length inside the section length, so resolution needs
  // more than a single pass.
  assertEquals(plan.maximumDependencyLevel >= 1, true);
  assertEquals(plan.atoms.some((atom) => atom.kind === "length"), true);
});

Deno.test("Ducklang Wasm modules with resolved lengths validate", () => {
  // Several sizes, so the code section's nested body lengths vary and a single wrong
  // length would land differently in each case.
  for (const functionCount of [1, 3, 8, 20]) {
    const bytes = buildModule(functionCount).finish();

    assertEquals([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
    assertEquals(
      WebAssembly.validate(new Uint8Array(bytes).buffer as ArrayBuffer),
      true,
    );
  }
});

Deno.test("Ducklang Wasm emission is byte-identical for the same plan", () => {
  const plan = buildModule(4).finishPlan();

  assertEquals([...emitWasmPlanOnCpu(plan)], [...emitWasmPlanOnCpu(plan)]);
});

Deno.test("Ducklang Wasm plan byte length equals emitted length", () => {
  const plan = buildModule(4).finishPlan();

  assertEquals(wasmBinaryPlanByteLength(plan), emitWasmPlanOnCpu(plan).length);
});

Deno.test("Ducklang Wasm analysis resolves exact atom byte boundaries", () => {
  const plan = {
    atoms: [
      { kind: "byte" as const, value: 0xaa },
      { kind: "unsigned" as const, value: 128 },
      { kind: "signed32" as const, value: -1 },
      {
        kind: "length" as const,
        rangeStart: 0,
        rangeCount: 3,
        dependencyLevel: 1,
      },
    ],
    maximumDependencyLevel: 1,
  };

  const analysis = analyzeWasmBinaryPlan(plan);

  assertEquals([...analysis.atomByteOffsets], [0, 1, 3, 4, 5]);
  assertEquals(analysis.byteLength, 5);
  assertEquals(analysis.byteAtomCount, 1);
  assertEquals(analysis.maximumByteRank, 0);
  assertEquals(analysis.signed64AtomCount, 0);
  assertEquals(analysis.lengthSizing, "direct");
  assertEquals(analysis.lengthSizingDependencyAtomCount, 3);
  assertEquals(analysis.lengthSizingWorkEstimate, 3);
});

Deno.test("Ducklang Wasm analysis rejects an invalid scalar before sizing", () => {
  let caught: unknown;
  try {
    analyzeWasmBinaryPlan({
      atoms: [{ kind: "byte", value: 256 }],
      maximumDependencyLevel: 0,
    });
  } catch (error) {
    caught = error;
  }

  assertEquals(
    caught instanceof Error ? caught.message : caught,
    "Wasm byte atom 0 must fit u8; received 256",
  );
});

Deno.test("Ducklang Wasm analysis counts only resolved lengths inside a range", () => {
  const scalarAtoms = Array.from(
    { length: 40 },
    () => ({ kind: "byte" as const, value: 0xaa }),
  );
  const analysis = analyzeWasmBinaryPlan({
    atoms: [
      ...scalarAtoms,
      { kind: "length", rangeStart: 0, rangeCount: 40, dependencyLevel: 1 },
      { kind: "unsigned", value: 128 },
      { kind: "length", rangeStart: 0, rangeCount: 40, dependencyLevel: 1 },
      { kind: "length", rangeStart: 40, rangeCount: 2, dependencyLevel: 2 },
    ],
    maximumDependencyLevel: 2,
  });

  assertEquals(analysis.lengthSizing, "sparse");
  assertEquals(analysis.lengthSizingDependencyAtomCount, 82);
  assertEquals(analysis.lengthSizingWorkEstimate, 77);
  assertEquals([...analysis.atomByteOffsets.slice(40)], [40, 41, 43, 44, 45]);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

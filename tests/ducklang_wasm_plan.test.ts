import {
  analyzeWasmBinaryPlan,
  emitWasmPlanOnCpu,
  validateWasmBinaryPlan,
  wasmBinaryPlanByteLength,
  wasmBranchHintSectionName,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "../src/wasm.ts";
import {
  createGpuResidentWasmPlans,
  emitResidentWasmPlansOnGpu,
  emitWasmPlanOnGpu,
  emitWasmPlansOnGpu,
  packWasmBinaryPlans,
  partitionWasmBinaryPlans,
} from "../src/gpu_wasm.ts";
import type { CompilerGpuLimits } from "../src/gpu_device.ts";

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

Deno.test("packed Wasm plans rebase only local length dependencies", () => {
  const plans = [buildModule(1).finishPlan(), buildModule(130).finishPlan()];
  const packed = packWasmBinaryPlans(plans);
  const firstAtomCount = plans[0].atoms.length;
  const secondLengths = plans[1].atoms.filter((atom) => atom.kind === "length");
  const packedSecondLengths = packed.plan.atoms.slice(firstAtomCount).filter(
    (atom) => atom.kind === "length",
  );

  assertEquals(packed.endAtomIndices, [
    firstAtomCount,
    packed.plan.atoms.length,
  ]);
  assertEquals(
    packedSecondLengths.map((atom) =>
      atom.kind === "length" ? atom.rangeStart : -1
    ),
    secondLengths.map((atom) =>
      atom.kind === "length" ? firstAtomCount + atom.rangeStart : -1
    ),
  );
  assertEquals(
    Array.from(emitWasmPlanOnCpu(packed.plan)),
    plans.flatMap((plan) => Array.from(emitWasmPlanOnCpu(plan))),
  );

  const lengthIndex = plans[0].atoms.findIndex((atom) =>
    atom.kind === "length" && atom.rangeCount > 0
  );
  const length = plans[0].atoms[lengthIndex];
  if (length?.kind !== "length") throw new Error("test plan omitted a length");
  const escaped = {
    ...plans[0],
    atoms: plans[0].atoms.with(lengthIndex, {
      ...length,
      rangeStart: plans[0].atoms.length,
    }),
  };
  assertThrows(
    () => packWasmBinaryPlans([escaped, plans[1]]),
    /outside/,
  );
});

Deno.test("Wasm plan partitioning takes the longest stable capacity prefix", () => {
  const plans = [1, 2, 3].map((count) => buildModule(count).finishPlan());
  const permissiveLimits = gpuLimits();
  const firstTwo = partitionWasmBinaryPlans(
    plans.slice(0, 2),
    permissiveLimits,
    { maximumPayloadCount: 64 },
  )[0]!;
  const partitions = partitionWasmBinaryPlans(plans, {
    ...permissiveLimits,
    maxStorageBufferBindingSize: firstTwo.resources.maximumStorageBindingBytes,
  }, { maximumPayloadCount: 64 });

  assertEquals(
    partitions.map((partition) => [
      partition.firstPayloadIndex,
      partition.payloadCount,
    ]),
    [[0, 2], [2, 1]],
  );
  assertEquals(partitions[0].endAtomIndices.length, 2);
  assertEquals(partitions[1].plan === plans[2], true);
  assertEquals(
    partitions.every((partition) =>
      partition.resources.maximumStorageBindingBytes <=
        firstTwo.resources.maximumStorageBindingBytes
    ),
    true,
  );
  assertEquals(
    partitionWasmBinaryPlans(plans, {
      ...permissiveLimits,
      maxComputeWorkgroupsPerDimension: firstTwo.resources.workgroupCount,
    }, { maximumPayloadCount: 64 }).map((partition) => partition.payloadCount),
    [2, 1],
  );
  assertEquals(
    partitionWasmBinaryPlans(plans, permissiveLimits, {
      maximumPayloadCount: 2,
    }).map((partition) => partition.payloadCount),
    [2, 1],
  );
  assertThrows(
    () =>
      partitionWasmBinaryPlans(plans, permissiveLimits, {
        maximumPayloadCount: 0,
      }),
    /positive safe integer/,
  );
});

Deno.test("packed GPU Wasm emission preserves ordinal bytes and isolation", async () => {
  const plans = [1, 3, 130].map((count) => buildModule(count).finishPlan());
  const emitted = await emitWasmPlansOnGpu(plans, { scheduling: "latency" });
  if (emitted.status === "unavailable") return;

  assertEquals(emitted.physicalEmissions.length, 1);
  assertEquals(emitted.physicalEmissions[0].payloadBatchSize, 3);
  assertEquals(emitted.physicalEmissions[0].timings.scope, "batch");
  assertEquals(emitted.physicalEmissions[0].payloadByteOffsets.length, 4);
  assertEquals(emitted.physicalPlans[0].firstPayloadIndex, 0);
  assertEquals(emitted.physicalPlans[0].payloadCount, 3);
  assertEquals(emitted.physicalPlans[0].resources.payloadCount, 3);
  assertEquals(emitted.timings.totalMilliseconds >= 0, true);
  for (const [index, bytes] of emitted.bytes.entries()) {
    assertEquals(
      Array.from(bytes),
      Array.from(emitWasmPlanOnCpu(plans[index])),
    );
  }
  assertEquals(emitted.bytes[0].buffer === emitted.bytes[1].buffer, false);
});

Deno.test("singleton GPU Wasm batches reuse the direct emitted bytes", async () => {
  const plan = buildModule(3).finishPlan();
  const emitted = await emitWasmPlansOnGpu([plan], { scheduling: "latency" });
  if (emitted.status === "unavailable") return;

  assertEquals(emitted.physicalPlans.length, 1);
  assertEquals(emitted.physicalPlans[0].payloadCount, 1);
  assertEquals(emitted.bytes[0] === emitted.physicalEmissions[0].bytes, true);
  assertEquals(emitted.timings.partitioningMilliseconds, 0);
  assertEquals(
    emitted.physicalPlans[0].resources.atomCount,
    emitted.physicalEmissions[0].atomCount,
  );
  assertEquals(emitted.timings.artifactIsolationMilliseconds >= 0, true);
});

Deno.test("packed GPU Wasm emission crosses the command batching cap when capacity permits", async () => {
  const plans = Array.from(
    { length: 17 },
    (_, index) => buildModule(index + 1).finishPlan(),
  );
  const emitted = await emitWasmPlansOnGpu(plans, { scheduling: "latency" });
  if (emitted.status === "unavailable") return;

  assertEquals(
    emitted.physicalEmissions.map((emission) => emission.payloadBatchSize),
    [17],
  );
  assertEquals(emitted.bytes.length, plans.length);
  for (const [index, bytes] of emitted.bytes.entries()) {
    assertEquals(
      Array.from(bytes),
      Array.from(emitWasmPlanOnCpu(plans[index])),
    );
  }
});

Deno.test("resident GPU Wasm plans preserve nested lengths across repeated emissions", async () => {
  const plans = [1, 3, 130].map((count) => buildModule(count).finishPlan());
  const creation = await createGpuResidentWasmPlans(plans, {
    maximumPhysicalPayloadCount: 2,
  });
  if (creation.status === "unavailable") return;
  const { resident } = creation;
  try {
    assertEquals(resident.certificate.payloadCount, 3);
    assertEquals(resident.certificate.physicalPlanCount, 2);
    assertEquals(
      resident.certificate.atomCount,
      plans.reduce(
        (count, plan) => count + plan.atoms.length,
        0,
      ),
    );
    assertEquals(resident.certificate.retainedInputBytes > 0, true);
    const first = await emitResidentWasmPlansOnGpu(resident, {
      scheduling: "latency",
    });
    const second = await emitResidentWasmPlansOnGpu(resident, {
      scheduling: "latency",
    });
    if (first.status === "unavailable") return;
    if (second.status === "unavailable") return;

    for (
      const emission of [
        ...first.physicalEmissions,
        ...second.physicalEmissions,
      ]
    ) {
      assertEquals(emission.timings.planInspectionMilliseconds, 0);
      assertEquals(emission.timings.columnConstructionMilliseconds, 0);
      assertEquals(emission.readbackMode, "capacity-single-map");
      assertEquals(
        emission.physicalReadbackBytes - emission.logicalReadbackBytes,
        emission.readbackPaddingBytes,
      );
    }
    for (const output of [first.bytes, second.bytes]) {
      for (const [index, bytes] of output.entries()) {
        assertEquals(
          Array.from(bytes),
          Array.from(emitWasmPlanOnCpu(plans[index]!)),
        );
      }
      assertEquals(output[0]!.buffer === output[1]!.buffer, false);
    }
  } finally {
    if (!resident.released) resident.release();
  }
});

Deno.test("resident GPU Wasm release waits for an active borrow and rejects later use", async () => {
  const creation = await createGpuResidentWasmPlans([
    buildModule(20).finishPlan(),
  ]);
  if (creation.status === "unavailable") return;
  const { resident } = creation;
  const pendingEmission = emitResidentWasmPlansOnGpu(resident, {
    scheduling: "latency",
  });
  resident.release();
  assertEquals(resident.released, true);
  const emitted = await pendingEmission;
  if (emitted.status === "unavailable") return;
  assertEquals(
    WebAssembly.validate(emitted.bytes[0]!.slice().buffer as ArrayBuffer),
    true,
  );
  await assertRejects(
    () => emitResidentWasmPlansOnGpu(resident),
    /cannot be emitted after release/,
  );
  assertThrows(() => resident.release(), /already been released/);
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

Deno.test("Wasm branch hints use function-relative instruction offsets", () => {
  const hinted = new WasmModuleBuilder();
  const hintedType = hinted.addFunctionType([wasmType.i32], [wasmType.i32]);
  const hintedFunction = hinted.addFunction(
    hintedType,
    [wasmType.i32, wasmType.i64],
    [
      ...wasmInstruction.localGet(0),
      ...wasmInstruction.branchHint("likely"),
      ...wasmInstruction.ifI32,
      ...wasmInstruction.i32Constant(11),
      ...wasmInstruction.else,
      ...wasmInstruction.i32Constant(22),
      ...wasmInstruction.end,
    ],
  );
  hinted.exportFunction("main", hintedFunction);

  const unhinted = new WasmModuleBuilder();
  const unhintedType = unhinted.addFunctionType(
    [wasmType.i32],
    [wasmType.i32],
  );
  const unhintedFunction = unhinted.addFunction(
    unhintedType,
    [wasmType.i32, wasmType.i64],
    [
      ...wasmInstruction.localGet(0),
      ...wasmInstruction.ifI32,
      ...wasmInstruction.i32Constant(11),
      ...wasmInstruction.else,
      ...wasmInstruction.i32Constant(22),
      ...wasmInstruction.end,
    ],
  );
  unhinted.exportFunction("main", unhintedFunction);

  const hintedBytes = hinted.finish();
  const unhintedBytes = unhinted.finish();
  const module = new WebAssembly.Module(
    new Uint8Array(hintedBytes).buffer as ArrayBuffer,
  );
  const sections = WebAssembly.Module.customSections(
    module,
    wasmBranchHintSectionName,
  );

  assertEquals(sections.length, 1);
  assertEquals([...new Uint8Array(sections[0])], [1, 0, 1, 7, 1, 1]);
  assertEquals(sectionIds(hintedBytes), [1, 3, 7, 0, 10]);
  assertEquals(hintedBytes.length - unhintedBytes.length, 34);
  assertEquals(
    [...removeBranchHintSection(hintedBytes)],
    [...unhintedBytes],
  );
  const hintedMain = new WebAssembly.Instance(module).exports.main as (
    condition: number,
  ) => number;
  const unhintedMain = new WebAssembly.Instance(
    new WebAssembly.Module(
      new Uint8Array(unhintedBytes).buffer as ArrayBuffer,
    ),
  ).exports.main as (condition: number) => number;
  assertEquals([hintedMain(0), hintedMain(1)], [22, 11]);
  assertEquals([hintedMain(0), hintedMain(1)], [
    unhintedMain(0),
    unhintedMain(1),
  ]);
});

Deno.test("Wasm branch hints encode multi-byte offsets and GPU-identical bytes", async () => {
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType([], [wasmType.i32]);
  const functionIndex = builder.addFunction(type, [], [
    ...wasmInstruction.blockVoid,
    ...Array.from({ length: 130 }, () => wasmInstruction.nop).flat(),
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.branchHint("unlikely"),
    ...wasmInstruction.branchIf(0),
    ...wasmInstruction.end,
    ...wasmInstruction.i32Constant(7),
  ]);
  builder.exportFunction("main", functionIndex);
  const plan = builder.finishPlan();
  const cpuBytes = emitWasmPlanOnCpu(plan);
  const section = WebAssembly.Module.customSections(
    new WebAssembly.Module(
      new Uint8Array(cpuBytes).buffer as ArrayBuffer,
    ),
    wasmBranchHintSectionName,
  )[0];
  const contents = new Uint8Array(section);
  const decodedOffset = decodeUnsigned(contents, 3);

  assertEquals(decodedOffset.value, 135);
  assertEquals([...contents.slice(decodedOffset.end)], [1, 0]);

  const gpu = await emitWasmPlanOnGpu(plan);
  if (gpu.status === "unavailable") return;
  assertEquals([...gpu.bytes], [...cpuBytes]);
});

Deno.test("Wasm branch hints reject unattached metadata", () => {
  const builder = new WasmModuleBuilder();
  const type = builder.addFunctionType([], [wasmType.i32]);

  assertThrows(
    () =>
      builder.addFunction(type, [], [
        ...wasmInstruction.branchHint("likely"),
        ...wasmInstruction.i32Constant(0),
      ]),
    /branch hint at instruction 0 must immediately precede if or br_if/,
  );
  assertThrows(
    () => wasmInstruction.branchHint("sometimes" as "likely"),
    /branch likelihood must be likely or unlikely; received sometimes/,
  );
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

Deno.test("Ducklang Wasm emission rejects a same-level length dependency", () => {
  let caught: unknown;
  try {
    emitWasmPlanOnCpu({
      atoms: [
        { kind: "length", rangeStart: 1, rangeCount: 1, dependencyLevel: 1 },
        { kind: "length", rangeStart: 2, rangeCount: 0, dependencyLevel: 1 },
      ],
      maximumDependencyLevel: 1,
    });
  } catch (error) {
    caught = error;
  }

  assertEquals(
    caught instanceof Error ? caught.message : caught,
    "Wasm length atom 0 at level 1 depends on atom 1 at level 1",
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
  assertEquals(analysis.lengthSizingWorkEstimate, 74);
  assertEquals(
    analysis.lengthLevels.flatMap((level) =>
      level.atoms.map((atom) => [atom.atomIndex, atom.lengthAtomRank])
    ),
    [[40, 0], [42, 1], [43, 2]],
  );
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

function assertThrows(action: () => unknown, expected: RegExp): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && expected.test(error.message)) return;
    throw error;
  }
  throw new Error(`expected action to throw ${expected}`);
}

async function assertRejects(
  action: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && expected.test(error.message)) return;
    throw error;
  }
  throw new Error(`expected action to reject ${expected}`);
}

function gpuLimits(): CompilerGpuLimits {
  return {
    maxBufferSize: 1_000_000_000,
    maxStorageBufferBindingSize: 1_000_000_000,
    maxUniformBufferBindingSize: 1_000_000_000,
    maxComputeWorkgroupsPerDimension: 1_000_000,
    maxStorageBuffersPerShaderStage: 16,
    maxUniformBuffersPerShaderStage: 16,
  };
}

function removeBranchHintSection(bytes: Uint8Array): Uint8Array {
  const retained = [bytes.slice(0, 8)];
  let sectionStart = 8;
  while (sectionStart < bytes.length) {
    const sectionId = bytes[sectionStart];
    const sectionSize = decodeUnsigned(bytes, sectionStart + 1);
    const sectionEnd = sectionSize.end + sectionSize.value;
    let remove = false;
    if (sectionId === 0) {
      const nameLength = decodeUnsigned(bytes, sectionSize.end);
      const nameEnd = nameLength.end + nameLength.value;
      const name = new TextDecoder().decode(
        bytes.slice(nameLength.end, nameEnd),
      );
      remove = name === wasmBranchHintSectionName;
    }
    if (!remove) retained.push(bytes.slice(sectionStart, sectionEnd));
    sectionStart = sectionEnd;
  }
  const byteLength = retained.reduce(
    (length, section) => length + section.length,
    0,
  );
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const section of retained) {
    result.set(section, offset);
    offset += section.length;
  }
  return result;
}

function sectionIds(bytes: Uint8Array): number[] {
  const ids: number[] = [];
  let sectionStart = 8;
  while (sectionStart < bytes.length) {
    ids.push(bytes[sectionStart]);
    const sectionSize = decodeUnsigned(bytes, sectionStart + 1);
    sectionStart = sectionSize.end + sectionSize.value;
  }
  return ids;
}

function decodeUnsigned(
  bytes: Uint8Array,
  start: number,
): { readonly value: number; readonly end: number } {
  let value = 0;
  let scale = 1;
  let offset = start;
  while (true) {
    const current = bytes[offset];
    value += (current & 0x7f) * scale;
    offset += 1;
    if ((current & 0x80) === 0) return { value, end: offset };
    scale *= 128;
  }
}

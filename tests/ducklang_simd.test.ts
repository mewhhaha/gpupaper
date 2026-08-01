import { compileModuleSource, runMain } from "../src/compiler.ts";
import type {
  CoreBlockId,
  CoreFunctionId,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
  DucklangCoreModule,
  DucklangCoreOperation,
} from "../src/ducklang_core.ts";
import { validateDucklangCore } from "../src/ducklang_core.ts";
import { lowerDucklangCoreToFcgAndWasm } from "../src/ducklang_core_wasm.ts";
import { PrimitiveId } from "../src/ducklang_primitives.ts";
import {
  flattenDucklangCore,
  inflateFlatDucklangCore,
} from "../src/flat_ducklang_core.ts";

Deno.test("Ducklang f32x4 arithmetic exposes each selected scalar lane", async () => {
  const artifact = await compileModuleSource(
    "simd_arithmetic.duck",
    `let left = @f32x4(1.0f32, 2.0f32, 3.0f32, 4.0f32)
let right = @f32x4_splat(2.0f32)
let sum = @f32x4_add(left, right)
let product = @f32x4_mul(sum, right)
let replaced = @f32x4_replace_lane_2(product, 42.0f32)
@f32x4_extract_lane_2(replaced)
`,
    { wasmTarget: "wasm-simd128" },
  );

  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.wasmTarget, "wasm-simd128");
});

Deno.test("Ducklang f32x4 comparisons produce masks only select can consume", async () => {
  const artifact = await compileModuleSource(
    "simd_mask.duck",
    `let left = @f32x4(1.0f32, 4.0f32, 3.0f32, 8.0f32)
let right = @f32x4(2.0f32, 3.0f32, 4.0f32, 7.0f32)
let mask = @f32x4_lt(left, right)
let selected = @f32x4_select(mask, left, right)
@f32x4_extract_lane_2(selected)
`,
    { wasmTarget: "wasm-simd128" },
  );

  assertEquals(await runMain(artifact.wasm), 3);
});

Deno.test("Ducklang strict f32x4 preserves signed zero and subnormal bits", async () => {
  const negativeZero = await compileModuleSource(
    "simd_negative_zero.duck",
    `let bits = -2147483647 - 1
let value = @unsafe_f32_reinterpret_i32(bits)
let vector = @f32x4_splat(value)
@unsafe_i32_reinterpret_f32(@f32x4_extract_lane_3(vector))
`,
    { wasmTarget: "wasm-simd128" },
  );
  const subnormal = await compileModuleSource(
    "simd_subnormal.duck",
    `let value = @unsafe_f32_reinterpret_i32(1)
let vector = @f32x4_splat(value)
@unsafe_i32_reinterpret_f32(@f32x4_extract_lane_1(vector))
`,
    { wasmTarget: "wasm-simd128" },
  );

  assertEquals(await runMain(negativeZero.wasm), -2147483648);
  assertEquals(await runMain(subnormal.wasm), 1);
});

Deno.test("Ducklang strict f32x4 treats NaN comparisons lane-wise", async () => {
  const artifact = await compileModuleSource(
    "simd_nan.duck",
    `let nan = @unsafe_f32_reinterpret_i32(2143289345)
let values = @f32x4_splat(nan)
let mask = @f32x4_ne(values, values)
let ones = @f32x4_splat(1.0f32)
let zeros = @f32x4_splat(0.0f32)
let selected = @f32x4_select(mask, ones, zeros)
@f32x4_extract_lane_0(selected)
`,
    { wasmTarget: "wasm-simd128" },
  );

  assertEquals(await runMain(artifact.wasm), 1);
});

Deno.test("Ducklang scalar target rejects an internal vector type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "simd_scalar_target.duck",
        `let vector = @f32x4_splat(1.0f32)
@f32x4_extract_lane_0(vector)
`,
        { wasmTarget: "wasm-scalar" },
      ),
    /target wasm-scalar cannot represent Core vector type .* select wasm-simd128/,
  );
});

Deno.test("Ducklang managed ABI rejects a vector result", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "simd_host_boundary.duck",
        "@f32x4_splat(1.0f32)\n",
        { wasmTarget: "wasm-simd128" },
      ),
    /managed JavaScript ABI cannot return Core vector type/,
  );
});

Deno.test("Ducklang vector shuffle preserves its explicit lane permutation", async () => {
  const core = shuffleCore([0, 5, 2, 7]);
  validateDucklangCore(core);
  const roundTrip = inflateFlatDucklangCore(flattenDucklangCore(core));
  assertEquals(JSON.stringify(roundTrip.types), JSON.stringify(core.types));
  const shuffle = roundTrip.functions[0].blocks[0].operations[10];
  assertEquals(shuffle.kind, "vector.shuffle");
  if (shuffle.kind !== "vector.shuffle") throw new Error("shuffle was lost");
  assertEquals(JSON.stringify(shuffle.lanes), "[0,5,2,7]");
  const wasm = lowerDucklangCoreToFcgAndWasm(roundTrip, {
    emission: "cpu",
    target: "wasm-simd128",
  }).wasm;
  if (wasm === undefined) throw new Error("SIMD fixture emitted no Wasm");

  assertEquals(await runMain(wasm), 6);
});

Deno.test("Ducklang vector shuffle rejects a lane outside both inputs", () => {
  const core = shuffleCore([0, 1, 2, 8]);

  assertThrows(
    () => validateDucklangCore(core),
    /has lanes \[0, 1, 2, 8\]; expected 4 indices in 0\.\.7/,
  );
});

function shuffleCore(lanes: readonly number[]): DucklangCoreModule {
  const f32 = 0 as CoreTypeId;
  const f32x4 = 1 as CoreTypeId;
  const operations: DucklangCoreOperation[] = [1, 2, 3, 4, 5, 6, 7, 8].map((
    value,
    index,
  ) => ({
    kind: "constant" as const,
    value,
    result: index as CoreValueId,
    type: f32,
    operands: [],
    span: simdSpan(),
  }));
  operations.push({
    kind: "primitive" as const,
    primitiveId: PrimitiveId.f32x4Make,
    result: 8 as CoreValueId,
    type: f32x4,
    operands: [0, 1, 2, 3] as CoreValueId[],
    span: simdSpan(),
  });
  operations.push({
    kind: "primitive" as const,
    primitiveId: PrimitiveId.f32x4Make,
    result: 9 as CoreValueId,
    type: f32x4,
    operands: [4, 5, 6, 7] as CoreValueId[],
    span: simdSpan(),
  });
  operations.push({
    kind: "vector.shuffle" as const,
    result: 10 as CoreValueId,
    type: f32x4,
    operands: [8, 9] as CoreValueId[],
    lanes,
    span: simdSpan(),
  });
  operations.push({
    kind: "primitive" as const,
    primitiveId: PrimitiveId.f32x4ExtractLane1,
    result: 11 as CoreValueId,
    type: f32,
    operands: [10] as CoreValueId[],
    span: simdSpan(),
  });
  return {
    schemaVersion: 1,
    file: "simd_shuffle.duck",
    types: [
      { kind: "scalar", scalar: "f32" },
      { kind: "vector", lanes: 4, element: "f32" },
    ],
    signatures: [{ parameters: [], result: f32 }],
    functions: [{
      id: 0 as CoreFunctionId,
      name: "main",
      sourceSymbolId: undefined,
      signature: 0 as CoreSignatureId,
      entryBlock: 0 as CoreBlockId,
      blocks: [{
        id: 0 as CoreBlockId,
        parameters: [],
        operations,
        terminator: {
          kind: "return",
          values: [11 as CoreValueId],
          span: simdSpan(),
        },
      }],
      span: simdSpan(),
    }],
    entryFunction: 0 as CoreFunctionId,
  };
}

function simdSpan() {
  return { file: "simd_shuffle.duck", start: 0, end: 1 };
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}; received ${String(actual)}`);
  }
}

async function assertRejects(
  action: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected rejection ${pattern}`);
}

function assertThrows(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected rejection ${pattern}`);
}

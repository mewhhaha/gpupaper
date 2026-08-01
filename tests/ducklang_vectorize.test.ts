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
import { lowerDucklangCoreToFcgAndWasm } from "../src/ducklang_core_wasm.ts";
import { PrimitiveId } from "../src/ducklang_primitives.ts";
import {
  resolveDucklangVectorPlanConflicts,
  vectorizeDucklangCore,
} from "../src/ducklang_vectorize.ts";

Deno.test("profitable f32 scalar chains vectorize without changing their result", async () => {
  const scalar = scalarChainCore(6);
  const vectorized = vectorizeDucklangCore(scalar);

  assertEquals(vectorized.proposals.length, 1);
  assertEquals(vectorized.accepted.length, 1);
  assertEquals(vectorized.metrics.scalarOperationCount, 24);
  assertEquals(vectorized.metrics.vectorOperationCount, 6);
  assertEquals(vectorized.metrics.packCount, 2);
  assertEquals(vectorized.metrics.splatCount, 5);
  assertEquals(vectorized.metrics.extractCount, 1);
  if (
    vectorized.metrics.estimatedVectorCost >=
      vectorized.metrics.estimatedScalarCost
  ) {
    throw new Error(
      `accepted non-profitable vector plan: ${
        JSON.stringify(vectorized.metrics)
      }`,
    );
  }

  assertEquals(await executeCore(vectorized.module), await executeCore(scalar));
});

Deno.test("vectorized f32 chains agree on IEEE-754 edge values", async () => {
  const cases = [
    { name: "negative zero", value: -0, right: 0 },
    { name: "minimum subnormal", value: 1.401298464324817e-45, right: 0 },
    { name: "positive infinity", value: Infinity, right: 1 },
    { name: "NaN", value: NaN, right: 1 },
  ];
  for (const edge of cases) {
    const scalar = scalarChainCore(6, false, {
      left: [edge.value, 2, 3, 4],
      right: [edge.right, 1, 1, 1],
    });
    const vectorized = vectorizeDucklangCore(scalar);
    assertEquals(vectorized.accepted.length, 1);
    const expected = await executeCore(scalar);
    const actual = await executeCore(vectorized.module);
    if (!Object.is(actual, expected)) {
      throw new Error(
        `${edge.name} changed from ${String(expected)} to ${String(actual)}`,
      );
    }
  }
});

Deno.test("an unprofitable scalar window preserves the Core snapshot identity", () => {
  const scalar = scalarChainCore(1);
  const vectorized = vectorizeDucklangCore(scalar);

  assertEquals(vectorized.proposals.length, 0);
  assertEquals(vectorized.accepted.length, 0);
  if (vectorized.module !== scalar) {
    throw new Error("empty vector plan rebuilt an unchanged Core snapshot");
  }
});

Deno.test("automatic SIMD preserves a module that can observe NaN payload bits", () => {
  const scalar = scalarChainCore(6);
  const function_ = scalar.functions[0];
  const block = function_.blocks[0];
  const scalarResult = block.terminator.kind === "return"
    ? block.terminator.values[0]
    : undefined;
  if (scalarResult === undefined) {
    throw new Error("fixture has no scalar result");
  }
  const bitResult = 100 as CoreValueId;
  const i32 = 2 as CoreTypeId;
  const observable: DucklangCoreModule = {
    ...scalar,
    types: [...scalar.types, { kind: "scalar", scalar: "i32" }],
    signatures: [{ parameters: [], result: i32 }],
    functions: [{
      ...function_,
      blocks: [{
        ...block,
        operations: [...block.operations, {
          kind: "primitive",
          primitiveId: PrimitiveId.i32ReinterpretF32,
          result: bitResult,
          type: i32,
          operands: [scalarResult],
          span: vectorSpan(),
        }],
        terminator: {
          kind: "return",
          values: [bitResult],
          span: vectorSpan(),
        },
      }],
    }],
  };
  const vectorized = vectorizeDucklangCore(observable);

  assertEquals(vectorized.metrics.candidateWindowCount, 0);
  if (vectorized.module !== observable) {
    throw new Error("bit-observable module lost snapshot identity");
  }
});

Deno.test("non-overlapping plans in one block rebuild independently", async () => {
  const scalar = scalarChainCore(12, false, undefined, 6);
  const vectorized = vectorizeDucklangCore(scalar);

  assertEquals(vectorized.accepted.length, 2);
  assertEquals(vectorized.metrics.vectorOperationCount, 12);
  assertEquals(await executeCore(vectorized.module), await executeCore(scalar));
});

Deno.test("vector planning starts after a Core operation it cannot cross", async () => {
  const scalar = scalarChainCore(6, true);
  const vectorized = vectorizeDucklangCore(scalar);

  assertEquals(vectorized.metrics.candidateWindowCount, 5);
  assertEquals(vectorized.accepted.length, 1);
  const crossedBarrier = vectorized.accepted[0].groups.some((group) =>
    group.operationIndices.some((operationIndex) => operationIndex <= 10)
  );
  if (crossedBarrier) {
    throw new Error("vector plan moved a scalar lane across operation 10");
  }
  assertEquals(await executeCore(vectorized.module), await executeCore(scalar));
});

Deno.test("conflict resolution rejects a plan whose cost proof was changed", () => {
  const scalar = scalarChainCore(6);
  const plan = vectorizeDucklangCore(scalar).proposals[0];
  const forged = { ...plan, profit: plan.profit + 1 };

  assertThrows(
    () => resolveDucklangVectorPlanConflicts(scalar, [forged]),
    /does not match the validated snapshot/,
  );
});

Deno.test("the compiler profiles an accepted source-level vector plan", async () => {
  const artifact = await compileModuleSource(
    "vector_profile.duck",
    `module (!init: Init) where

declare effect Input {
  a: () => F32
}

declare Init { input: Input }

a <- Input.a()
let p0 = a + 1.0f32
let p1 = a + 2.0f32
let p2 = a + 3.0f32
let p3 = a + 4.0f32
let q0 = p0 * 2.0f32
let q1 = p1 * 2.0f32
let q2 = p2 * 2.0f32
let q3 = p3 * 2.0f32
let r0 = q0 - 2.0f32
let r1 = q1 - 2.0f32
let r2 = q2 - 2.0f32
let r3 = q3 - 2.0f32
let s0 = r0 / 2.0f32
let s1 = r1 / 2.0f32
let s2 = r2 / 2.0f32
let s3 = r3 / 2.0f32
let t0 = s0 + 2.0f32
let t1 = s1 + 2.0f32
let t2 = s2 + 2.0f32
let t3 = s3 + 2.0f32
let u0 = t0 * 2.0f32
let u1 = t1 * 2.0f32
let u2 = t2 * 2.0f32
let u3 = t3 * 2.0f32
let low = u0 + u1
let high = u2 + u3
return { .result = low + high }
`,
    { gpuMode: "off", wasmTarget: "wasm-simd128" },
  );

  if (artifact.profile.work.vectorAcceptedPlanCount !== 1) {
    throw new Error(
      `compiler vector profile ${
        JSON.stringify({
          candidates: artifact.profile.work.vectorCandidateWindowCount,
          proposed: artifact.profile.work.vectorProposedPlanCount,
          accepted: artifact.profile.work.vectorAcceptedPlanCount,
        })
      } for ${
        JSON.stringify(artifact.optimizedCore.functions.flatMap((function_) =>
          function_.blocks.flatMap((block) =>
            block.operations.map((operation) =>
              operation.kind
            )
          )
        ))
      }`,
    );
  }
  assertEquals(artifact.profile.work.vectorOperationCount, 6);
  if (artifact.profile.stages.coreVectorizationMilliseconds <= 0) {
    throw new Error("compiler omitted the Core vectorization stage timing");
  }
  assertEquals(
    await runMain(artifact.wasm, {
      input: { a: 1 },
    }),
    36,
  );
});

function scalarChainCore(
  chainLength: number,
  insertBarrier = false,
  inputs: {
    readonly left: readonly number[];
    readonly right: readonly number[];
  } = { left: [2, 4, 6, 8], right: [1, 2, 3, 4] },
  restartAt: number | undefined = undefined,
): DucklangCoreModule {
  const f32 = 0 as CoreTypeId;
  const f32x4 = 1 as CoreTypeId;
  let nextValue = 0;
  const operations: DucklangCoreOperation[] = [];
  const initialValues = [...inputs.left, ...inputs.right].map((value) => {
    const result = nextValue++ as CoreValueId;
    operations.push({
      kind: "constant",
      value,
      result,
      type: f32,
      operands: [],
      span: vectorSpan(),
    });
    return result;
  });
  const operators = ["+", "*", "-", "/", "+", "*"] as const;
  let previous = initialValues.slice(0, 4);
  for (let group = 0; group < chainLength; group += 1) {
    if (group === restartAt) previous = initialValues.slice(0, 4);
    const right = group === 0 ? initialValues.slice(4, 8) : [
      initialValues[0],
      initialValues[0],
      initialValues[0],
      initialValues[0],
    ];
    const results: CoreValueId[] = [];
    for (let lane = 0; lane < 4; lane += 1) {
      if (insertBarrier && group === 0 && lane === 2) {
        operations.push({
          kind: "primitive",
          primitiveId: PrimitiveId.f32x4Splat,
          result: nextValue++ as CoreValueId,
          type: f32x4,
          operands: [initialValues[0]],
          span: vectorSpan(),
        });
      }
      const result = nextValue++ as CoreValueId;
      operations.push({
        kind: "scalar.binary",
        operator: operators[group % operators.length],
        result,
        type: f32,
        operands: [previous[lane], right[lane]],
        span: vectorSpan(),
      });
      results.push(result);
    }
    previous = results;
  }
  return {
    schemaVersion: 1,
    file: "vectorize.duck",
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
          values: [previous[0]],
          span: vectorSpan(),
        },
      }],
      span: vectorSpan(),
    }],
    entryFunction: 0 as CoreFunctionId,
  };
}

async function executeCore(core: DucklangCoreModule): Promise<number | bigint> {
  const lowered = lowerDucklangCoreToFcgAndWasm(core, {
    emission: "cpu",
    target: "wasm-simd128",
  });
  if (lowered.wasm === undefined) throw new Error("Core emitted no Wasm");
  return await runMain(lowered.wasm);
}

function vectorSpan() {
  return { file: "vectorize.duck", start: 0, end: 1 };
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}; received ${String(actual)}`);
  }
}

function assertThrows(callback: () => void, pattern: RegExp): void {
  try {
    callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected ${pattern}; callback did not throw`);
}

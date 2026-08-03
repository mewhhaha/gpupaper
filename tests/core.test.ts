import type {
  CoreBlockId,
  CoreFunctionId,
  CoreModule,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
} from "../src/core.ts";
import { PrimitiveId, validateCore } from "../src/core.ts";
import { planCoreLayouts } from "../src/core_layout.ts";
import { rewriteFlatCore } from "../src/core_rewrite.ts";
import {
  flattenCore,
  inflateFlatCore,
  validateFlatCore,
} from "../src/flat_core.ts";
import { runCoreGpuPass } from "../src/gpu_core.ts";

const i32 = 0 as CoreTypeId;
const entry = 0 as CoreBlockId;
const main = 0 as CoreFunctionId;
const signature = 0 as CoreSignatureId;
const span = { file: "core.example", start: 0, end: 1 };

Deno.test("Core validation accepts a closed dominating SSA graph", () => {
  validateCore(constantModule());
});

Deno.test("Core validation rejects a value without a dominating definition", () => {
  const module = constantModule();
  const malformed: CoreModule = {
    ...module,
    functions: [{
      ...module.functions[0],
      blocks: [{
        ...module.functions[0].blocks[0],
        terminator: {
          kind: "return",
          values: [99 as CoreValueId],
          span,
        },
      }],
    }],
  };

  assertThrows(
    () => validateCore(malformed),
    /uses undefined value 99/,
  );
});

Deno.test("Core validation rejects an i32x4 select without a mask", () => {
  const first = 0 as CoreValueId;
  const second = 1 as CoreValueId;
  const third = 2 as CoreValueId;
  const fourth = 3 as CoreValueId;
  const lanes = 4 as CoreValueId;
  const selected = 5 as CoreValueId;
  const result = 6 as CoreValueId;
  const vector = 1 as CoreTypeId;
  const malformed: CoreModule = {
    schemaVersion: 1,
    file: span.file,
    types: [
      { kind: "scalar", scalar: "i32" },
      { kind: "vector", lanes: 4, element: "i32" },
      { kind: "mask", lanes: 4, element: "i32" },
    ],
    signatures: [{ parameters: [i32, i32, i32, i32], result: i32 }],
    functions: [{
      id: main,
      name: "malformed_select",
      sourceIdentity: undefined,
      signature,
      entryBlock: entry,
      blocks: [{
        id: entry,
        parameters: [first, second, third, fourth].map((value) => ({
          value,
          type: i32,
          span,
        })),
        operations: [{
          kind: "primitive",
          result: lanes,
          type: vector,
          operands: [first, second, third, fourth],
          primitiveId: PrimitiveId.i32x4Make,
          span,
        }, {
          kind: "primitive",
          result: selected,
          type: vector,
          operands: [lanes, lanes, lanes],
          primitiveId: PrimitiveId.i32x4Select,
          span,
        }, {
          kind: "primitive",
          result,
          type: i32,
          operands: [selected],
          primitiveId: PrimitiveId.i32x4ExtractLane0,
          span,
        }],
        terminator: { kind: "return", values: [result], span },
      }],
      span,
    }],
    entryFunction: main,
  };

  assertThrows(
    () => validateCore(malformed),
    /Core SIMD primitive i32x4\.select malformed_select:5 has an invalid signature/,
  );
});

Deno.test("Core layout interns equal scalar representations", () => {
  const module: CoreModule = {
    ...constantModule(),
    types: [
      { kind: "scalar", scalar: "i32" },
      { kind: "scalar", scalar: "f32" },
      { kind: "scalar", scalar: "i64" },
      { kind: "product", fields: [i32, 2 as CoreTypeId] },
    ],
  };
  const plan = planCoreLayouts(module);

  assertEquals(plan.typeLayouts[0], plan.typeLayouts[1]);
  const product = plan.layouts[plan.typeLayouts[3]];
  if (product.kind !== "product") {
    throw new Error(`product type received ${product.kind} layout`);
  }
  assertEquals(product.offsets, [0, 8]);
  assertEquals(product.size, 16);
  assertEquals(product.alignment, 8);
});

Deno.test("flat Core round-trips every column of a validated module", () => {
  const module = identityAdditionModule();
  const flat = flattenCore(module);
  validateFlatCore(flat);

  assertEquals(inflateFlatCore(flat), module);
});

Deno.test("flat Core round-trips narrow 128-bit vector shapes", () => {
  const module: CoreModule = {
    ...constantModule(),
    types: [
      { kind: "scalar", scalar: "i32" },
      { kind: "vector", lanes: 16, element: "i8" },
      { kind: "mask", lanes: 16, element: "i8" },
      { kind: "vector", lanes: 8, element: "i16" },
      { kind: "mask", lanes: 8, element: "i16" },
    ],
  };
  validateCore(module);
  const flat = flattenCore(module);
  validateFlatCore(flat);

  assertEquals(inflateFlatCore(flat), module);
});

Deno.test("Core identity rewrites preserve the input snapshot", () => {
  const flat = flattenCore(identityAdditionModule());
  const operationCount = flat.operationKinds.length;
  const rewritten = rewriteFlatCore(flat);

  assertEquals(flat.operationKinds.length, operationCount);
  assertEquals(rewritten.accepted.map((proposal) => proposal.rule), [
    "addZero",
  ]);
  assertEquals(rewritten.package.operationKinds.length, operationCount - 1);
  validateFlatCore(rewritten.package);
});

Deno.test("WebGPU and CPU select the same Core identity rewrite", async () => {
  const flat = flattenCore(identityAdditionModule());
  const expected = rewriteFlatCore(flat);
  const actual = await runCoreGpuPass(flat);
  if (actual.status === "unavailable") return;
  if (actual.status !== "completed") {
    throw new Error(`GPU rejected validated Core: ${actual.reason}`);
  }

  assertEquals(actual.accepted, expected.accepted);
  assertEquals(actual.package.operationKinds, expected.package.operationKinds);
  assertEquals(
    actual.package.operationOperandCounts,
    expected.package.operationOperandCounts,
  );
});

function constantModule(): CoreModule {
  const answer = 0 as CoreValueId;
  return {
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
}

function identityAdditionModule(): CoreModule {
  const value = 0 as CoreValueId;
  const zero = 1 as CoreValueId;
  const result = 2 as CoreValueId;
  return {
    ...constantModule(),
    functions: [{
      ...constantModule().functions[0],
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
        }, {
          kind: "constant",
          result: zero,
          type: i32,
          operands: [],
          value: 0,
          span,
        }, {
          kind: "scalar.binary",
          result,
          type: i32,
          operands: [value, zero],
          operator: "+",
          span,
        }],
        terminator: { kind: "return", values: [result], span },
      }],
    }],
  };
}

function assertThrows(operation: () => unknown, pattern: RegExp): void {
  try {
    operation();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected ${pattern}; operation completed`);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const normalizedActual = JSON.stringify(canonicalValue(actual));
  const normalizedExpected = JSON.stringify(canonicalValue(expected));
  if (normalizedActual !== normalizedExpected) {
    throw new Error(
      `expected ${normalizedExpected}; received ${normalizedActual}`,
    );
  }
}

function canonicalValue(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as Uint32Array);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined).sort(
      ([left], [right]) => left.localeCompare(right),
    ).map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

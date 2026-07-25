import {
  flattenFcgModule,
  inflateFlatFcgPackage,
  validateFlatFcgPackage,
} from "../src/flat_fcg.ts";
import type { FcgModule } from "../src/fcg.ts";

Deno.test("flat FCG round-trips functions operations operands and constructors", () => {
  const module: FcgModule = {
    functions: [{
      name: "main",
      parameters: ["left", "right"],
      localCount: 1,
      operations: [
        { opcode: "const", operands: [-1], sourceStart: 4, regionId: 0 },
        {
          opcode: "call",
          operands: ["compare", 0xffff_ffff],
          sourceStart: 9,
          regionId: 1,
        },
      ],
    }],
    constructorTags: new Map([["Some", 1], ["None", 0]]),
  };

  const flat = flattenFcgModule(module);

  assertEquals(validateFlatFcgPackage(flat), [
    "None",
    "Some",
    "call",
    "compare",
    "const",
    "left",
    "main",
    "right",
  ]);
  assertEquals(inflateFlatFcgPackage(flat), {
    ...module,
    constructorTags: new Map([["None", 0], ["Some", 1]]),
  });
});

Deno.test("flat FCG validation rejects overlapping operation ranges", () => {
  const flat = flattenFcgModule({
    functions: [
      {
        name: "first",
        parameters: [],
        localCount: 0,
        operations: [{
          opcode: "const",
          operands: [1],
          sourceStart: 0,
          regionId: 0,
        }],
      },
      {
        name: "second",
        parameters: [],
        localCount: 0,
        operations: [{
          opcode: "const",
          operands: [2],
          sourceStart: 1,
          regionId: 0,
        }],
      },
    ],
    constructorTags: new Map(),
  });
  flat.functionOperationStarts[1] = 0;

  assertThrows(
    () => validateFlatFcgPackage(flat),
    /function operation 1 starts at 0; expected contiguous start 1/,
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (
    JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))
  ) {
    throw new Error(
      `expected ${JSON.stringify(normalize(expected))}; received ${
        JSON.stringify(normalize(actual))
      }`,
    );
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Map) return [...value];
  if (ArrayBuffer.isView(value)) return [...value as Uint8Array];
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function assertThrows(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected action to throw ${pattern}`);
}

/**
 * Every cross-reference is an integer ID, and every range is validated.
 *
 * The overlapping-range case above covers one of the validator's checks. These cover the
 * rest, each by breaking exactly one field of a package the validator accepts: a string ID
 * past the table, columns of unequal length, a value too wide for a u32 word, and a range
 * that starts where the previous one did not end.
 *
 * Without them a validator that only checked overlap would pass, which is most of the
 * reason to have this item at all.
 */

function acceptedPackage() {
  return flattenFcgModule({
    functions: [{
      name: "main",
      parameters: ["a"],
      localCount: 1,
      operations: [
        { opcode: "const", operands: [1], sourceStart: 0, regionId: 0 },
        { opcode: "drop", operands: [], sourceStart: 1, regionId: 0 },
      ],
    }],
    constructorTags: new Map(),
  });
}

Deno.test("flat FCG validation accepts a well-formed package", () => {
  validateFlatFcgPackage(acceptedPackage());
});

Deno.test("flat FCG validation rejects a string ID past the table", () => {
  const flat = acceptedPackage();
  assertRejects(
    () =>
      validateFlatFcgPackage({
        ...flat,
        functionNameIds: Uint32Array.from([flat.stringStarts.length + 5]),
      }),
    /uses string ID \d+; package contains \d+ strings/,
  );
});

Deno.test("flat FCG validation rejects columns of unequal length", () => {
  const flat = acceptedPackage();
  assertRejects(
    () =>
      validateFlatFcgPackage({
        ...flat,
        operationSourceStarts: flat.operationSourceStarts.slice(0, 1),
      }),
    /columns must have equal lengths/,
  );
});

Deno.test("flat FCG flattening rejects a value too wide for a word", () => {
  // The width guard runs while flattening, not while validating: the columns are
  // Uint32Array, so a package that exists already holds coerced values and cannot carry
  // an out-of-range one. What it protects is the FcgModule going in.
  assertRejects(
    () =>
      flattenFcgModule({
        functions: [{
          name: "main",
          parameters: [],
          localCount: 2 ** 32,
          operations: [],
        }],
        constructorTags: new Map(),
      }),
    /local count must fit a u32 word/,
  );
  assertRejects(
    () =>
      flattenFcgModule({
        functions: [{
          name: "main",
          parameters: [],
          localCount: 0,
          operations: [{
            opcode: "const",
            operands: [1],
            sourceStart: -1,
            regionId: 0,
          }],
        }],
        constructorTags: new Map(),
      }),
    /operation source start must fit a u32 word/,
  );
});

Deno.test("flat FCG validation rejects a non-contiguous range start", () => {
  const flat = acceptedPackage();
  assertRejects(
    () =>
      validateFlatFcgPackage({
        ...flat,
        functionOperationStarts: Uint32Array.from([1]),
      }),
    /starts at 1; expected contiguous start 0/,
  );
});

function assertRejects(operation: () => unknown, expected: RegExp): void {
  let message = "";
  try {
    operation();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === "") throw new Error("expected a rejection");
  if (!expected.test(message)) {
    throw new Error(
      `expected ${expected}, received ${JSON.stringify(message)}`,
    );
  }
}

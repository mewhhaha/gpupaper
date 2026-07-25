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

import type {
  CoreBlockId,
  CoreFunctionId,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
  DucklangCoreBlock,
  DucklangCoreModule,
} from "../src/ducklang_core.ts";
import {
  lowerDucklangToCore,
  validateDucklangCore,
} from "../src/ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * Core tables and the Core validator.
 *
 * Every rejection below is constructed by taking a module the validator accepts
 * and breaking exactly one property, so a passing case cannot be mistaken for a
 * validator that accepts everything. The accepted baseline is asserted first for
 * that reason.
 */

const i32 = 0 as CoreTypeId;
const unit = 1 as CoreTypeId;

/** A two-block function whose edge carries one i32 argument. */
function acceptedModule(): DucklangCoreModule {
  return {
    schemaVersion: 1,
    file: "core.duck",
    types: [
      { kind: "scalar", scalar: "i32" },
      { kind: "scalar", scalar: "unit" },
    ],
    signatures: [{ parameters: [], result: i32 }],
    functions: [
      {
        id: 0 as CoreFunctionId,
        name: "main",
        sourceSymbolId: undefined,
        signature: 0 as CoreSignatureId,
        entryBlock: 0 as CoreBlockId,
        blocks: [entryBlock(), joinBlock()],
        span: span(),
      },
    ],
    entryFunction: 0 as CoreFunctionId,
  };
}

function entryBlock(): DucklangCoreBlock {
  return {
    id: 0 as CoreBlockId,
    parameters: [],
    operations: [
      {
        kind: "constant",
        value: 7,
        result: 0 as CoreValueId,
        type: i32,
        operands: [],
        span: span(),
      },
    ],
    terminator: {
      kind: "branch",
      target: 1 as CoreBlockId,
      arguments: [0 as CoreValueId],
      span: span(),
    },
  };
}

function joinBlock(): DucklangCoreBlock {
  return {
    id: 1 as CoreBlockId,
    parameters: [{ value: 1 as CoreValueId, type: i32, span: span() }],
    operations: [],
    terminator: {
      kind: "return",
      values: [1 as CoreValueId],
      span: span(),
    },
  };
}

Deno.test("Core validation accepts a well-formed module", () => {
  validateDucklangCore(acceptedModule());
});

Deno.test("Core tables carry spans for every element", () => {
  const module = acceptedModule();
  const function_ = module.functions[0];

  assertEquals(typeof function_.span.file, "string");
  for (const block of function_.blocks) {
    for (const parameter of block.parameters) {
      assertEquals(typeof parameter.span.file, "string");
    }
    for (const operation of block.operations) {
      assertEquals(typeof operation.span.file, "string");
    }
    assertEquals(typeof block.terminator.span.file, "string");
  }
  // Types, signatures, and functions are separate tables addressed by integer
  // ID, and a block always has a terminator by construction.
  assertEquals(module.types.length, 2);
  assertEquals(module.signatures.length, 1);
  assertEquals(
    function_.blocks.every((block) => block.terminator !== undefined),
    true,
  );
});

const rejections: readonly (readonly [
  string,
  (module: DucklangCoreModule) => DucklangCoreModule,
  RegExp,
])[] = [
  [
    "an out-of-range entry function",
    (module) => ({ ...module, entryFunction: 5 as CoreFunctionId }),
    /entry function 5 is outside table length 1/,
  ],
  [
    "a function table index that disagrees with its ID",
    (module) => ({
      ...module,
      functions: [{ ...module.functions[0], id: 3 as CoreFunctionId }],
    }),
    /function table index 0 contains ID 3/,
  ],
  [
    "an out-of-range signature",
    (module) => ({
      ...module,
      functions: [{
        ...module.functions[0],
        signature: 9 as CoreSignatureId,
      }],
    }),
    /signature 9 is outside table length 1/,
  ],
  [
    "a block table index that disagrees with its ID",
    (module) =>
      withBlocks(module, [
        { ...entryBlock(), id: 4 as CoreBlockId },
        joinBlock(),
      ]),
    /block table index 0 contains ID 4/,
  ],
  [
    "a value defined twice",
    (module) =>
      withBlocks(module, [
        entryBlock(),
        {
          ...joinBlock(),
          parameters: [{ value: 0 as CoreValueId, type: i32, span: span() }],
          terminator: {
            kind: "return",
            values: [0 as CoreValueId],
            span: span(),
          },
        },
      ]),
    /defines value 0 in blocks/,
  ],
  [
    "an edge whose arity disagrees with its target",
    (module) =>
      withBlocks(module, [
        {
          ...entryBlock(),
          terminator: {
            kind: "branch",
            target: 1 as CoreBlockId,
            arguments: [],
            span: span(),
          },
        },
        joinBlock(),
      ]),
    /supplies 0 arguments for 1 parameters/,
  ],
  [
    "an edge whose argument type disagrees with its target parameter",
    (module) =>
      withBlocks(module, [
        entryBlock(),
        {
          ...joinBlock(),
          parameters: [{ value: 1 as CoreValueId, type: unit, span: span() }],
        },
      ]),
    /argument 0 has type 0; target 1 expects 1/,
  ],
  [
    "an out-of-range branch target",
    (module) =>
      withBlocks(module, [
        {
          ...entryBlock(),
          terminator: {
            kind: "branch",
            target: 7 as CoreBlockId,
            arguments: [0 as CoreValueId],
            span: span(),
          },
        },
        joinBlock(),
      ]),
    /branch target 7 is outside table length 2/,
  ],
  [
    "a use of an undefined value",
    (module) =>
      withBlocks(module, [
        entryBlock(),
        {
          ...joinBlock(),
          terminator: {
            kind: "return",
            values: [42 as CoreValueId],
            span: span(),
          },
        },
      ]),
    /undefined value 42/,
  ],
  [
    "a use of a value its block does not dominate",
    (module) =>
      withBlocks(module, [
        {
          ...entryBlock(),
          terminator: {
            kind: "conditional_branch",
            condition: 0 as CoreValueId,
            trueTarget: 1 as CoreBlockId,
            trueArguments: [0 as CoreValueId],
            falseTarget: 2 as CoreBlockId,
            falseArguments: [],
            span: span(),
          },
        },
        joinBlock(),
        {
          id: 2 as CoreBlockId,
          parameters: [],
          operations: [],
          // Value 1 is defined only as block 1's parameter, which does not
          // dominate block 2.
          terminator: {
            kind: "return",
            values: [1 as CoreValueId],
            span: span(),
          },
        },
      ]),
    /value 1 from block 1 does not dominate block 2/,
  ],
];

for (const [description, mutate, expected] of rejections) {
  Deno.test(`Core validation rejects ${description}`, () => {
    let message = "";
    try {
      validateDucklangCore(mutate(acceptedModule()));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (message === "") {
      throw new Error(`expected a rejection for ${description}`);
    }
    if (!expected.test(message)) {
      throw new Error(
        `expected ${expected} for ${description}, received ${
          JSON.stringify(message)
        }`,
      );
    }
  });
}

Deno.test("Core lowering produces a module its own validator accepts", async () => {
  const parsed = await parseDucklangModule(
    "core_lowering.duck",
    "let double = value => value + value\ndouble(21)\n",
  );
  const core = lowerDucklangToCore(
    inferDucklangModule(resolveDucklangModule(parsed)),
  );

  validateDucklangCore(core);
  assertEquals(core.schemaVersion, 1);
  assertEquals(core.functions.length > 0, true);
  assertEquals(
    core.functions.every((function_) => function_.blocks.length > 0),
    true,
  );
});

function withBlocks(
  module: DucklangCoreModule,
  blocks: readonly DucklangCoreBlock[],
): DucklangCoreModule {
  return {
    ...module,
    functions: [{ ...module.functions[0], blocks }],
  };
}

function span() {
  return { file: "core.duck", start: 0, end: 1 };
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

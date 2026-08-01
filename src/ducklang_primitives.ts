export const BuiltinTypeId = {
  i32: 0,
  i64: 1,
  f32: 2,
  f64: 3,
  f32x4: 4,
  bool: 5,
  char: 6,
  text: 7,
  bytes: 8,
  unit: 9,
  f32x4Mask: 10,
} as const;

export type BuiltinTypeId = typeof BuiltinTypeId[keyof typeof BuiltinTypeId];

export const PrimitiveId = {
  add: 0,
  subtract: 1,
  multiply: 2,
  divide: 3,
  remainder: 4,
  negate: 5,
  equal: 6,
  notEqual: 7,
  lessThan: 8,
  lessThanOrEqual: 9,
  greaterThan: 10,
  greaterThanOrEqual: 11,
  booleanNot: 12,
  booleanAnd: 13,
  booleanOr: 14,
  bitAnd: 15,
  bitOr: 16,
  bitXor: 17,
  shiftLeft: 18,
  shiftRightUnsigned: 19,
  f32SquareRoot: 20,
  f32FromI32: 21,
  i32FromF32: 22,
  f64FromI32: 23,
  i32FromF64: 24,
  i32WrapI64: 25,
  i64ExtendI32Signed: 26,
  i64ExtendI32Unsigned: 27,
  i32ReinterpretF32: 28,
  f32ReinterpretI32: 29,
  f32x4Make: 30,
  f32x4Splat: 31,
  f32x4Add: 32,
  f32x4Subtract: 33,
  f32x4Multiply: 34,
  f32x4Divide: 35,
  bufferLength: 36,
  bufferGet: 37,
  bufferSlice: 38,
  bufferAppend: 39,
  bytesGenerate: 40,
  utf8Encode: 41,
  utf8Decode: 42,
  panic: 43,
  bufferSet: 44,
  bytesFill: 45,
  bufferEqual: 46,
  f32Format: 47,
  f32x4ExtractLane0: 48,
  f32x4ExtractLane1: 49,
  f32x4ExtractLane2: 50,
  f32x4ExtractLane3: 51,
  f32x4ReplaceLane0: 52,
  f32x4ReplaceLane1: 53,
  f32x4ReplaceLane2: 54,
  f32x4ReplaceLane3: 55,
  f32x4Equal: 56,
  f32x4NotEqual: 57,
  f32x4LessThan: 58,
  f32x4LessThanOrEqual: 59,
  f32x4GreaterThan: 60,
  f32x4GreaterThanOrEqual: 61,
  f32x4Select: 62,
} as const;

export type PrimitiveId = typeof PrimitiveId[keyof typeof PrimitiveId];

export const ducklangRuntimeImportModule = "__duck_runtime";

export function primitiveRuntimeImportName(id: PrimitiveId): string {
  return `primitive_${id}`;
}

export type PrimitiveStage = "compileTime" | "runtime";
export type PrimitiveEffect =
  | "pure"
  | "read"
  | "allocate"
  | "trap";

export type PrimitiveValueType =
  | BuiltinTypeId
  | {
    readonly kind: "function";
    readonly parameters: readonly PrimitiveValueType[];
    readonly result: PrimitiveValueType;
  };

export type PrimitiveOperandPattern =
  | BuiltinTypeId
  | "numeric"
  | "integer"
  | "buffer"
  | { readonly sameAs: number }
  | {
    readonly function: {
      readonly parameters: readonly PrimitiveOperandPattern[];
      readonly result: ResultPattern;
    };
  };

type ResultPattern =
  | BuiltinTypeId
  | "bottom"
  | { readonly sameAs: number };

export type PrimitiveSignature = {
  readonly operands: readonly PrimitiveOperandPattern[];
  readonly result: ResultPattern;
};

export type PrimitiveDescriptor = {
  readonly id: PrimitiveId;
  readonly name: string;
  readonly signature: PrimitiveSignature;
  readonly stages: readonly PrimitiveStage[];
  readonly effects: readonly PrimitiveEffect[];
  readonly lowering: string;
  readonly sourceNames: readonly string[];
  readonly imports: readonly {
    readonly modulePath: string;
    readonly exportName: string;
  }[];
};

const bothStages = ["compileTime", "runtime"] as const;
const pure = ["pure"] as const;
const numericBinary: PrimitiveSignature = {
  operands: ["numeric", { sameAs: 0 }],
  result: { sameAs: 0 },
};
const numericComparison: PrimitiveSignature = {
  operands: ["numeric", { sameAs: 0 }],
  result: BuiltinTypeId.bool,
};
const integerBinary: PrimitiveSignature = {
  operands: ["integer", { sameAs: 0 }],
  result: { sameAs: 0 },
};
const f32x4Binary: PrimitiveSignature = {
  operands: [BuiltinTypeId.f32x4, BuiltinTypeId.f32x4],
  result: BuiltinTypeId.f32x4,
};

export const primitiveDescriptors: readonly PrimitiveDescriptor[] = [
  scalarBinary(PrimitiveId.add, "scalar.add", numericBinary, [
    "@syntax.add",
  ]),
  scalarBinary(PrimitiveId.subtract, "scalar.subtract", numericBinary, [
    "@syntax.sub",
  ]),
  scalarBinary(PrimitiveId.multiply, "scalar.multiply", numericBinary, [
    "@syntax.mul",
  ]),
  scalarBinary(PrimitiveId.divide, "scalar.divide", numericBinary, [
    "@syntax.div",
  ]),
  scalarBinary(PrimitiveId.remainder, "scalar.remainder", numericBinary, [
    "@syntax.rem",
  ]),
  {
    id: PrimitiveId.negate,
    name: "scalar.negate",
    signature: { operands: ["numeric"], result: { sameAs: 0 } },
    stages: bothStages,
    effects: pure,
    lowering: "wasm.numeric.negate",
    sourceNames: ["@syntax.negate"],
    imports: [],
  },
  scalarBinary(PrimitiveId.equal, "scalar.equal", numericComparison, [
    "@syntax.eq",
  ]),
  scalarBinary(PrimitiveId.notEqual, "scalar.not_equal", numericComparison, [
    "@syntax.ne",
  ]),
  scalarBinary(PrimitiveId.lessThan, "scalar.less_than", numericComparison, [
    "@syntax.lt",
  ]),
  scalarBinary(
    PrimitiveId.lessThanOrEqual,
    "scalar.less_than_or_equal",
    numericComparison,
    ["@syntax.le"],
  ),
  scalarBinary(
    PrimitiveId.greaterThan,
    "scalar.greater_than",
    numericComparison,
    ["@syntax.gt"],
  ),
  scalarBinary(
    PrimitiveId.greaterThanOrEqual,
    "scalar.greater_than_or_equal",
    numericComparison,
    ["@syntax.ge"],
  ),
  {
    id: PrimitiveId.booleanNot,
    name: "bool.not",
    signature: {
      operands: [BuiltinTypeId.bool],
      result: BuiltinTypeId.bool,
    },
    stages: bothStages,
    effects: pure,
    lowering: "wasm.i32.eqz",
    sourceNames: ["@syntax.not"],
    imports: [{ modulePath: "duck:prelude", exportName: "not" }],
  },
  booleanBinary(PrimitiveId.booleanAnd, "bool.and", "@syntax.and"),
  booleanBinary(PrimitiveId.booleanOr, "bool.or", "@syntax.or"),
  integerOperation(
    PrimitiveId.bitAnd,
    "integer.bit_and",
    "@bit_and",
    "bit_and",
  ),
  integerOperation(
    PrimitiveId.bitOr,
    "integer.bit_or",
    "@bit_or",
    "bit_or",
  ),
  integerOperation(
    PrimitiveId.bitXor,
    "integer.bit_xor",
    "@bit_xor",
    "bit_xor",
  ),
  integerOperation(
    PrimitiveId.shiftLeft,
    "integer.shift_left",
    "@shift_left",
    "shift_left",
  ),
  integerOperation(
    PrimitiveId.shiftRightUnsigned,
    "integer.shift_right_unsigned",
    "@shift_right_u",
    "shift_right_unsigned",
  ),
  conversion(
    PrimitiveId.f32SquareRoot,
    "f32.sqrt",
    BuiltinTypeId.f32,
    BuiltinTypeId.f32,
    "@f32_sqrt",
    "sqrt_f32",
  ),
  conversion(
    PrimitiveId.f32FromI32,
    "f32.from_i32",
    BuiltinTypeId.i32,
    BuiltinTypeId.f32,
    "@f32_from_i32",
    "f32_from_i32",
  ),
  conversion(
    PrimitiveId.i32FromF32,
    "i32.from_f32",
    BuiltinTypeId.f32,
    BuiltinTypeId.i32,
    "@i32_from_f32",
    "i32_from_f32",
  ),
  conversion(
    PrimitiveId.f64FromI32,
    "f64.from_i32",
    BuiltinTypeId.i32,
    BuiltinTypeId.f64,
    "@f64_from_i32",
    "f64_from_i32",
  ),
  conversion(
    PrimitiveId.i32FromF64,
    "i32.from_f64",
    BuiltinTypeId.f64,
    BuiltinTypeId.i32,
    "@i32_from_f64",
    "i32_from_f64",
  ),
  conversion(
    PrimitiveId.i32WrapI64,
    "i32.wrap_i64",
    BuiltinTypeId.i64,
    BuiltinTypeId.i32,
    "@unsafe_i32_wrap_i64",
    "unsafe_i32_wrap_i64",
  ),
  conversion(
    PrimitiveId.i64ExtendI32Signed,
    "i64.extend_i32_signed",
    BuiltinTypeId.i32,
    BuiltinTypeId.i64,
    "@unsafe_i64_extend_i32_signed",
    "unsafe_i64_extend_i32_signed",
  ),
  conversion(
    PrimitiveId.i64ExtendI32Unsigned,
    "i64.extend_i32_unsigned",
    BuiltinTypeId.i32,
    BuiltinTypeId.i64,
    "@unsafe_i64_extend_i32_unsigned",
    "unsafe_i64_extend_i32_unsigned",
  ),
  conversion(
    PrimitiveId.i32ReinterpretF32,
    "i32.reinterpret_f32",
    BuiltinTypeId.f32,
    BuiltinTypeId.i32,
    "@unsafe_i32_reinterpret_f32",
    "unsafe_i32_reinterpret_f32",
  ),
  conversion(
    PrimitiveId.f32ReinterpretI32,
    "f32.reinterpret_i32",
    BuiltinTypeId.i32,
    BuiltinTypeId.f32,
    "@unsafe_f32_reinterpret_i32",
    "unsafe_f32_reinterpret_i32",
  ),
  {
    id: PrimitiveId.f32x4Make,
    name: "f32x4.make",
    signature: {
      operands: [
        BuiltinTypeId.f32,
        BuiltinTypeId.f32,
        BuiltinTypeId.f32,
        BuiltinTypeId.f32,
      ],
      result: BuiltinTypeId.f32x4,
    },
    stages: ["runtime"],
    effects: pure,
    lowering: "wasm.f32x4.make",
    sourceNames: ["@f32x4"],
    imports: runtimeImports(["f32x4"]),
  },
  conversion(
    PrimitiveId.f32x4Splat,
    "f32x4.splat",
    BuiltinTypeId.f32,
    BuiltinTypeId.f32x4,
    "@f32x4_splat",
    "f32x4_splat",
    ["runtime"],
  ),
  simdBinary(
    PrimitiveId.f32x4Add,
    "f32x4.add",
    "@f32x4_add",
    "f32x4_add",
  ),
  simdBinary(
    PrimitiveId.f32x4Subtract,
    "f32x4.subtract",
    "@f32x4_sub",
    "f32x4_subtract",
  ),
  simdBinary(
    PrimitiveId.f32x4Multiply,
    "f32x4.multiply",
    "@f32x4_mul",
    "f32x4_multiply",
  ),
  simdBinary(
    PrimitiveId.f32x4Divide,
    "f32x4.divide",
    "@f32x4_div",
    "f32x4_divide",
  ),
  {
    id: PrimitiveId.bufferLength,
    name: "buffer.length",
    signature: { operands: ["buffer"], result: BuiltinTypeId.i32 },
    stages: bothStages,
    effects: pure,
    lowering: "buffer.length",
    sourceNames: ["@len"],
    imports: runtimeImports(["length", "text_length"]),
  },
  {
    id: PrimitiveId.bufferGet,
    name: "buffer.get",
    signature: {
      operands: ["buffer", BuiltinTypeId.i32],
      result: BuiltinTypeId.i32,
    },
    stages: bothStages,
    effects: ["read", "trap"],
    lowering: "buffer.get",
    sourceNames: ["@get"],
    imports: runtimeImports(["get", "text_get"]),
  },
  {
    id: PrimitiveId.bufferSlice,
    name: "buffer.slice",
    signature: {
      operands: ["buffer", BuiltinTypeId.i32, BuiltinTypeId.i32],
      result: { sameAs: 0 },
    },
    stages: bothStages,
    effects: ["read", "allocate", "trap"],
    lowering: "buffer.slice",
    sourceNames: ["@slice"],
    imports: [
      ...runtimeImports(["slice", "text_slice"]),
      { modulePath: "duck:prelude", exportName: "slice" },
    ],
  },
  {
    id: PrimitiveId.bufferAppend,
    name: "buffer.append",
    signature: {
      operands: ["buffer", { sameAs: 0 }],
      result: { sameAs: 0 },
    },
    stages: bothStages,
    effects: ["read", "allocate"],
    lowering: "buffer.concat",
    sourceNames: ["@append"],
    imports: runtimeImports(["append", "text_append"]),
  },
  {
    id: PrimitiveId.bufferEqual,
    name: "buffer.equal",
    signature: {
      operands: ["buffer", { sameAs: 0 }],
      result: BuiltinTypeId.bool,
    },
    stages: bothStages,
    effects: ["read"],
    lowering: "buffer.equal",
    sourceNames: [],
    imports: [],
  },
  {
    id: PrimitiveId.bufferSet,
    name: "buffer.set",
    signature: {
      operands: [
        BuiltinTypeId.bytes,
        BuiltinTypeId.i32,
        BuiltinTypeId.i32,
      ],
      result: { sameAs: 0 },
    },
    stages: ["runtime"],
    effects: ["read", "allocate", "trap"],
    lowering: "buffer.set",
    sourceNames: ["@set"],
    imports: runtimeImports(["bytes_set"]),
  },
  {
    id: PrimitiveId.bytesGenerate,
    name: "bytes.generate",
    signature: {
      operands: [
        BuiltinTypeId.i32,
        {
          function: {
            parameters: [BuiltinTypeId.i32],
            result: BuiltinTypeId.i32,
          },
        },
      ],
      result: BuiltinTypeId.bytes,
    },
    stages: ["runtime"],
    effects: ["allocate"],
    lowering: "buffer.generate",
    sourceNames: ["@Bytes.generate"],
    imports: runtimeImports(["generate_bytes"]),
  },
  {
    id: PrimitiveId.bytesFill,
    name: "bytes.fill",
    signature: {
      operands: [BuiltinTypeId.i32, BuiltinTypeId.i32],
      result: BuiltinTypeId.bytes,
    },
    stages: ["runtime"],
    effects: ["allocate", "trap"],
    lowering: "buffer.fill",
    sourceNames: ["@Bytes.fill"],
    imports: runtimeImports(["fill_bytes"]),
  },
  {
    id: PrimitiveId.utf8Encode,
    name: "utf8.encode",
    signature: {
      operands: [BuiltinTypeId.text],
      result: BuiltinTypeId.bytes,
    },
    stages: bothStages,
    effects: ["read", "allocate"],
    lowering: "utf8.encode",
    sourceNames: ["@Utf8.encode"],
    imports: runtimeImports(["encode_utf8"]),
  },
  {
    id: PrimitiveId.utf8Decode,
    name: "utf8.decode",
    signature: {
      operands: [BuiltinTypeId.bytes],
      result: BuiltinTypeId.text,
    },
    stages: bothStages,
    effects: ["read", "allocate", "trap"],
    lowering: "utf8.decode",
    sourceNames: ["@Utf8.decode"],
    imports: runtimeImports(["decode_utf8"]),
  },
  {
    id: PrimitiveId.f32Format,
    name: "f32.format",
    signature: {
      operands: [BuiltinTypeId.f32, BuiltinTypeId.i32],
      result: BuiltinTypeId.text,
    },
    stages: bothStages,
    effects: ["allocate", "trap"],
    lowering: "buffer.format_f32",
    sourceNames: ["@format_f32"],
    imports: runtimeImports(["format_f32"]),
  },
  ...([0, 1, 2, 3] as const).map((lane) => ({
    id: [
      PrimitiveId.f32x4ExtractLane0,
      PrimitiveId.f32x4ExtractLane1,
      PrimitiveId.f32x4ExtractLane2,
      PrimitiveId.f32x4ExtractLane3,
    ][lane],
    name: `f32x4.extract_lane_${lane}`,
    signature: {
      operands: [BuiltinTypeId.f32x4],
      result: BuiltinTypeId.f32,
    },
    stages: ["runtime"] as const,
    effects: pure,
    lowering: `wasm.f32x4.extract_lane ${lane}`,
    sourceNames: [`@f32x4_extract_lane_${lane}`],
    imports: [],
  })),
  ...([0, 1, 2, 3] as const).map((lane) => ({
    id: [
      PrimitiveId.f32x4ReplaceLane0,
      PrimitiveId.f32x4ReplaceLane1,
      PrimitiveId.f32x4ReplaceLane2,
      PrimitiveId.f32x4ReplaceLane3,
    ][lane],
    name: `f32x4.replace_lane_${lane}`,
    signature: {
      operands: [BuiltinTypeId.f32x4, BuiltinTypeId.f32],
      result: BuiltinTypeId.f32x4,
    },
    stages: ["runtime"] as const,
    effects: pure,
    lowering: `wasm.f32x4.replace_lane ${lane}`,
    sourceNames: [`@f32x4_replace_lane_${lane}`],
    imports: [],
  })),
  ...([
    [PrimitiveId.f32x4Equal, "equal", "eq"],
    [PrimitiveId.f32x4NotEqual, "not_equal", "ne"],
    [PrimitiveId.f32x4LessThan, "less_than", "lt"],
    [PrimitiveId.f32x4LessThanOrEqual, "less_than_or_equal", "le"],
    [PrimitiveId.f32x4GreaterThan, "greater_than", "gt"],
    [PrimitiveId.f32x4GreaterThanOrEqual, "greater_than_or_equal", "ge"],
  ] as const).map(([id, name, source]) => ({
    id,
    name: `f32x4.${name}`,
    signature: {
      operands: [BuiltinTypeId.f32x4, BuiltinTypeId.f32x4],
      result: BuiltinTypeId.f32x4Mask,
    },
    stages: ["runtime"] as const,
    effects: pure,
    lowering: `wasm.f32x4.${source}`,
    sourceNames: [`@f32x4_${source}`],
    imports: [],
  })),
  {
    id: PrimitiveId.f32x4Select,
    name: "f32x4.select",
    signature: {
      operands: [
        BuiltinTypeId.f32x4Mask,
        BuiltinTypeId.f32x4,
        BuiltinTypeId.f32x4,
      ],
      result: BuiltinTypeId.f32x4,
    },
    stages: ["runtime"],
    effects: pure,
    lowering: "wasm.v128.bitselect",
    sourceNames: ["@f32x4_select"],
    imports: [],
  },
  {
    id: PrimitiveId.panic,
    name: "control.panic",
    signature: {
      operands: [BuiltinTypeId.text],
      result: "bottom",
    },
    stages: bothStages,
    effects: ["trap"],
    lowering: "wasm.unreachable",
    sourceNames: ["@panic", "$duck_panic"],
    imports: runtimeImports(["panic"]),
  },
];

const descriptorsById = new Map(
  primitiveDescriptors.map((descriptor) => [descriptor.id, descriptor]),
);
const descriptorsBySourceName = new Map(
  primitiveDescriptors.flatMap((descriptor) =>
    descriptor.sourceNames.map((name) => [name, descriptor] as const)
  ),
);
const descriptorsByImport = new Map(
  primitiveDescriptors.flatMap((descriptor) =>
    descriptor.imports.map((source) =>
      [
        importKey(source.modulePath, source.exportName),
        descriptor,
      ] as const
    )
  ),
);

assertUniqueRegistry();

export function primitiveDescriptor(id: PrimitiveId): PrimitiveDescriptor {
  const descriptor = descriptorsById.get(id);
  if (descriptor === undefined) {
    throw new RangeError(`unknown Ducklang primitive ID ${id}`);
  }
  return descriptor;
}

export function resolveSourcePrimitive(
  sourceName: string,
): PrimitiveDescriptor | undefined {
  return descriptorsBySourceName.get(sourceName);
}

export function resolveImportedPrimitive(
  modulePath: string,
  exportName: string,
): PrimitiveDescriptor | undefined {
  return descriptorsByImport.get(importKey(modulePath, exportName));
}

export function validatePrimitiveCall(input: {
  readonly id: PrimitiveId;
  readonly stage: PrimitiveStage;
  readonly operandTypes: readonly PrimitiveValueType[];
  readonly source: string;
}): PrimitiveValueType | "bottom" {
  const descriptor = primitiveDescriptor(input.id);
  if (!descriptor.stages.includes(input.stage)) {
    throw new TypeError(
      `${input.source}: Ducklang primitive ${descriptor.name} is unavailable during ${input.stage}`,
    );
  }
  if (input.operandTypes.length !== descriptor.signature.operands.length) {
    throw new TypeError(
      `${input.source}: Ducklang primitive ${descriptor.name} expects ${descriptor.signature.operands.length} operands; received ${input.operandTypes.length}`,
    );
  }
  for (const [index, expected] of descriptor.signature.operands.entries()) {
    const actual = input.operandTypes[index];
    if (!matchesOperand(expected, actual, input.operandTypes)) {
      throw new TypeError(
        `${input.source}: Ducklang primitive ${descriptor.name} operand ${index} expects ${
          formatOperandPattern(expected)
        }; received ${primitiveValueTypeName(actual)}`,
      );
    }
  }
  const result = descriptor.signature.result;
  if (result === "bottom") return result;
  return typeof result === "number"
    ? result
    : input.operandTypes[result.sameAs];
}

export function builtinTypeName(id: BuiltinTypeId): string {
  const entry = Object.entries(BuiltinTypeId).find(([, candidate]) =>
    candidate === id
  );
  if (entry === undefined) {
    throw new RangeError(`unknown builtin type ID ${id}`);
  }
  return entry[0];
}

function scalarBinary(
  id: PrimitiveId,
  name: string,
  signature: PrimitiveSignature,
  sourceNames: readonly string[],
): PrimitiveDescriptor {
  return {
    id,
    name,
    signature,
    stages: bothStages,
    effects: pure,
    lowering: `wasm.${name}`,
    sourceNames,
    imports: [],
  };
}

function booleanBinary(
  id: PrimitiveId,
  name: string,
  sourceName: string,
): PrimitiveDescriptor {
  return {
    id,
    name,
    signature: {
      operands: [BuiltinTypeId.bool, BuiltinTypeId.bool],
      result: BuiltinTypeId.bool,
    },
    stages: bothStages,
    effects: pure,
    lowering: `wasm.${name}`,
    sourceNames: [sourceName],
    imports: [],
  };
}

function integerOperation(
  id: PrimitiveId,
  name: string,
  sourceName: string,
  runtimeExport: string,
): PrimitiveDescriptor {
  return {
    id,
    name,
    signature: integerBinary,
    stages: bothStages,
    effects: pure,
    lowering: `wasm.${name}`,
    sourceNames: [sourceName],
    imports: runtimeImports([runtimeExport]),
  };
}

function conversion(
  id: PrimitiveId,
  name: string,
  operand: BuiltinTypeId,
  result: BuiltinTypeId,
  sourceName: string,
  runtimeExport?: string,
  stages: readonly PrimitiveStage[] = bothStages,
): PrimitiveDescriptor {
  return {
    id,
    name,
    signature: { operands: [operand], result },
    stages,
    effects: pure,
    lowering: `wasm.${name}`,
    sourceNames: [sourceName],
    imports: runtimeExport === undefined ? [] : runtimeImports([runtimeExport]),
  };
}

function simdBinary(
  id: PrimitiveId,
  name: string,
  sourceName: string,
  runtimeExport: string,
): PrimitiveDescriptor {
  return {
    id,
    name,
    signature: f32x4Binary,
    stages: ["runtime"],
    effects: pure,
    lowering: `wasm.${name}`,
    sourceNames: [sourceName],
    imports: runtimeImports([runtimeExport]),
  };
}

function runtimeImports(
  exportNames: readonly string[],
): PrimitiveDescriptor["imports"] {
  return exportNames.map((exportName) => ({
    modulePath: "duck:prelude/runtime",
    exportName,
  }));
}

function importKey(modulePath: string, exportName: string): string {
  return `${modulePath}\0${exportName}`;
}

function matchesOperand(
  expected: PrimitiveOperandPattern,
  actual: PrimitiveValueType,
  operands: readonly PrimitiveValueType[],
): boolean {
  if (typeof expected === "number") return actual === expected;
  if (typeof expected === "object") {
    if ("function" in expected) {
      if (typeof actual === "number") return false;
      const signature = expected.function;
      return actual.parameters.length === signature.parameters.length &&
        signature.parameters.every((parameter, index) =>
          matchesOperand(parameter, actual.parameters[index], operands)
        ) &&
        matchesResult(signature.result, actual.result, operands);
    }
    return actual === operands[expected.sameAs];
  }
  if (typeof actual !== "number") return false;
  if (expected === "integer") {
    return actual === BuiltinTypeId.i32 || actual === BuiltinTypeId.i64;
  }
  if (expected === "buffer") {
    return actual === BuiltinTypeId.text || actual === BuiltinTypeId.bytes;
  }
  return actual === BuiltinTypeId.i32 || actual === BuiltinTypeId.i64 ||
    actual === BuiltinTypeId.f32 || actual === BuiltinTypeId.f64;
}

function formatOperandPattern(pattern: PrimitiveOperandPattern): string {
  if (typeof pattern === "number") return builtinTypeName(pattern);
  if (typeof pattern === "object") {
    if ("function" in pattern) {
      return `function (${
        pattern.function.parameters.map(formatOperandPattern).join(", ")
      }) -> ${formatResultPattern(pattern.function.result)}`;
    }
    return `the type of operand ${pattern.sameAs}`;
  }
  return pattern;
}

function matchesResult(
  expected: ResultPattern,
  actual: PrimitiveValueType,
  operands: readonly PrimitiveValueType[],
): boolean {
  if (expected === "bottom") return false;
  return typeof expected === "number"
    ? actual === expected
    : actual === operands[expected.sameAs];
}

function formatResultPattern(pattern: ResultPattern): string {
  if (pattern === "bottom") return pattern;
  return typeof pattern === "number"
    ? builtinTypeName(pattern)
    : `the type of operand ${pattern.sameAs}`;
}

function primitiveValueTypeName(type: PrimitiveValueType): string {
  return typeof type === "number"
    ? builtinTypeName(type)
    : `function (${
      type.parameters.map(primitiveValueTypeName).join(", ")
    }) -> ${primitiveValueTypeName(type.result)}`;
}

function assertUniqueRegistry(): void {
  if (descriptorsById.size !== primitiveDescriptors.length) {
    throw new Error("Ducklang primitive registry contains a duplicate ID");
  }
  const sourceNameCount = primitiveDescriptors.reduce(
    (count, descriptor) => count + descriptor.sourceNames.length,
    0,
  );
  if (descriptorsBySourceName.size !== sourceNameCount) {
    throw new Error(
      "Ducklang primitive registry contains a duplicate source name",
    );
  }
  const importCount = primitiveDescriptors.reduce(
    (count, descriptor) => count + descriptor.imports.length,
    0,
  );
  if (descriptorsByImport.size !== importCount) {
    throw new Error("Ducklang primitive registry contains a duplicate import");
  }
}

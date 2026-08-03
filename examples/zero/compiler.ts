import type {
  RuleCursor,
  TokenCursor,
} from "@mewhhaha/baba/runtime/generated-wasm";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import type {
  CoreBlock,
  CoreBlockId,
  CoreFunction,
  CoreFunctionId,
  CoreModule,
  CoreOperation,
  CoreSignatureId,
  CoreTerminator,
  CoreTypeId,
  CoreValueId,
} from "../../src/core.ts";
import {
  primitiveDescriptor,
  PrimitiveId,
  validateCore,
} from "../../src/core.ts";
import { lowerCoreToWasm } from "../../src/core_wasm.ts";
import { createRustWasmEmitter } from "../../src/rust_wasm_emitter.ts";
import type { WasmBinaryPlan } from "../../src/wasm.ts";

const parserWasmUrl = new URL(
  "../../grammar/zero-generated/parser.wasm",
  import.meta.url,
);
const parserPlanUrl = new URL(
  "../../grammar/zero-generated/parser.plan",
  import.meta.url,
);
const maximumI32 = 2_147_483_647;
const zeroBinaryOperators = new Set<ZeroBinaryOperator>([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
]);
const i32 = 0 as CoreTypeId;
const i32x4 = 1 as CoreTypeId;
const i32x4Mask = 2 as CoreTypeId;
const f32x4 = 3 as CoreTypeId;
const f32x4Mask = 4 as CoreTypeId;
const i8x16 = 5 as CoreTypeId;
const i8x16Mask = 6 as CoreTypeId;
const i16x8 = 7 as CoreTypeId;
const i16x8Mask = 8 as CoreTypeId;

type ZeroType =
  | "i32"
  | "i32x4"
  | "i32x4-mask"
  | "f32x4"
  | "f32x4-mask"
  | "i8x16"
  | "i8x16-mask"
  | "i16x8"
  | "i16x8-mask";

type SourceSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

type ZeroProgram = {
  readonly file: string;
  readonly functions: readonly ZeroFunction[];
};

type ZeroFunction = {
  readonly exported: boolean;
  readonly name: string;
  readonly parameters: readonly ZeroParameter[];
  readonly resultType: ZeroType;
  readonly usesSimd: boolean;
  readonly body: ZeroExpression;
  readonly span: SourceSpan;
};

type ZeroBinding = {
  readonly name: string;
  readonly span: SourceSpan;
};

type ZeroParameter = ZeroBinding & {
  readonly type: ZeroType;
};

type ZeroBinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">=";

type ZeroPrimitiveInstruction = {
  readonly primitiveId: PrimitiveId;
  readonly operandTypes: readonly ZeroType[];
  readonly resultType: ZeroType;
};

function unaryPrimitive(
  name: string,
  primitiveId: PrimitiveId,
  operandType: ZeroType,
  resultType: ZeroType,
): readonly [string, ZeroPrimitiveInstruction] {
  return [name, { primitiveId, operandTypes: [operandType], resultType }];
}

function binaryPrimitive(
  name: string,
  primitiveId: PrimitiveId,
  operandType: ZeroType,
  resultType: ZeroType = operandType,
): readonly [string, ZeroPrimitiveInstruction] {
  return [
    name,
    { primitiveId, operandTypes: [operandType, operandType], resultType },
  ];
}

function shiftPrimitive(
  name: string,
  primitiveId: PrimitiveId,
  vectorType: ZeroType,
): readonly [string, ZeroPrimitiveInstruction] {
  return [
    name,
    { primitiveId, operandTypes: [vectorType, "i32"], resultType: vectorType },
  ];
}

function selectPrimitive(
  name: string,
  primitiveId: PrimitiveId,
  maskType: ZeroType,
  vectorType: ZeroType,
): readonly [string, ZeroPrimitiveInstruction] {
  return [
    name,
    {
      primitiveId,
      operandTypes: [maskType, vectorType, vectorType],
      resultType: vectorType,
    },
  ];
}

const zeroPrimitiveInstructions = new Map<string, ZeroPrimitiveInstruction>([
  [
    "i32x4.make",
    {
      primitiveId: PrimitiveId.i32x4Make,
      operandTypes: ["i32", "i32", "i32", "i32"],
      resultType: "i32x4",
    },
  ],
  [
    "i32x4.splat",
    {
      primitiveId: PrimitiveId.i32x4Splat,
      operandTypes: ["i32"],
      resultType: "i32x4",
    },
  ],
  [
    "i32x4.add",
    {
      primitiveId: PrimitiveId.i32x4Add,
      operandTypes: ["i32x4", "i32x4"],
      resultType: "i32x4",
    },
  ],
  [
    "i32x4.and",
    {
      primitiveId: PrimitiveId.i32x4And,
      operandTypes: ["i32x4", "i32x4"],
      resultType: "i32x4",
    },
  ],
  [
    "i32x4.shl",
    {
      primitiveId: PrimitiveId.i32x4ShiftLeft,
      operandTypes: ["i32x4", "i32"],
      resultType: "i32x4",
    },
  ],
  [
    "i32x4.shr_u",
    {
      primitiveId: PrimitiveId.i32x4ShiftRightUnsigned,
      operandTypes: ["i32x4", "i32"],
      resultType: "i32x4",
    },
  ],
  [
    "i32x4.eq",
    {
      primitiveId: PrimitiveId.i32x4Equal,
      operandTypes: ["i32x4", "i32x4"],
      resultType: "i32x4-mask",
    },
  ],
  [
    "i32x4.select",
    {
      primitiveId: PrimitiveId.i32x4Select,
      operandTypes: ["i32x4-mask", "i32x4", "i32x4"],
      resultType: "i32x4",
    },
  ],
  ...[0, 1, 2, 3].map((lane) =>
    [
      `i32x4.extract_lane_${lane}`,
      {
        primitiveId: (PrimitiveId.i32x4ExtractLane0 + lane) as PrimitiveId,
        operandTypes: ["i32x4"] as const,
        resultType: "i32" as const,
      },
    ] as const
  ),
  ...[0, 1, 2, 3].map((lane) =>
    [
      `i32x4.replace_lane_${lane}`,
      {
        primitiveId: (PrimitiveId.i32x4ReplaceLane0 + lane) as PrimitiveId,
        operandTypes: ["i32x4", "i32"] as const,
        resultType: "i32x4" as const,
      },
    ] as const
  ),
  binaryPrimitive("i32x4.sub", PrimitiveId.i32x4Subtract, "i32x4"),
  binaryPrimitive("i32x4.mul", PrimitiveId.i32x4Multiply, "i32x4"),
  binaryPrimitive("i32x4.or", PrimitiveId.i32x4Or, "i32x4"),
  binaryPrimitive("i32x4.xor", PrimitiveId.i32x4Xor, "i32x4"),
  unaryPrimitive("i32x4.not", PrimitiveId.i32x4Not, "i32x4", "i32x4"),
  shiftPrimitive("i32x4.shr_s", PrimitiveId.i32x4ShiftRightSigned, "i32x4"),
  binaryPrimitive("i32x4.ne", PrimitiveId.i32x4NotEqual, "i32x4", "i32x4-mask"),
  binaryPrimitive(
    "i32x4.lt_s",
    PrimitiveId.i32x4LessThanSigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive(
    "i32x4.lt_u",
    PrimitiveId.i32x4LessThanUnsigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive(
    "i32x4.gt_s",
    PrimitiveId.i32x4GreaterThanSigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive(
    "i32x4.gt_u",
    PrimitiveId.i32x4GreaterThanUnsigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive(
    "i32x4.le_s",
    PrimitiveId.i32x4LessThanOrEqualSigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive(
    "i32x4.le_u",
    PrimitiveId.i32x4LessThanOrEqualUnsigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive(
    "i32x4.ge_s",
    PrimitiveId.i32x4GreaterThanOrEqualSigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive(
    "i32x4.ge_u",
    PrimitiveId.i32x4GreaterThanOrEqualUnsigned,
    "i32x4",
    "i32x4-mask",
  ),
  binaryPrimitive("i32x4.min_s", PrimitiveId.i32x4MinimumSigned, "i32x4"),
  binaryPrimitive("i32x4.min_u", PrimitiveId.i32x4MinimumUnsigned, "i32x4"),
  binaryPrimitive("i32x4.max_s", PrimitiveId.i32x4MaximumSigned, "i32x4"),
  binaryPrimitive("i32x4.max_u", PrimitiveId.i32x4MaximumUnsigned, "i32x4"),
  unaryPrimitive(
    "i32x4.mask_bitmask",
    PrimitiveId.i32x4MaskBitmask,
    "i32x4-mask",
    "i32",
  ),
  unaryPrimitive(
    "i32x4.mask_all_true",
    PrimitiveId.i32x4MaskAllTrue,
    "i32x4-mask",
    "i32",
  ),
  unaryPrimitive(
    "i32x4.mask_any_true",
    PrimitiveId.i32x4MaskAnyTrue,
    "i32x4-mask",
    "i32",
  ),
  unaryPrimitive(
    "i32x4.trunc_sat_f32x4_s",
    PrimitiveId.i32x4TruncateSaturateF32x4Signed,
    "f32x4",
    "i32x4",
  ),
  unaryPrimitive(
    "i32x4.trunc_sat_f32x4_u",
    PrimitiveId.i32x4TruncateSaturateF32x4Unsigned,
    "f32x4",
    "i32x4",
  ),
  unaryPrimitive(
    "f32x4.convert_i32x4_s",
    PrimitiveId.f32x4ConvertI32x4Signed,
    "i32x4",
    "f32x4",
  ),
  unaryPrimitive(
    "f32x4.convert_i32x4_u",
    PrimitiveId.f32x4ConvertI32x4Unsigned,
    "i32x4",
    "f32x4",
  ),
  ...[
    ["abs", PrimitiveId.f32x4Absolute],
    ["neg", PrimitiveId.f32x4Negate],
    ["sqrt", PrimitiveId.f32x4SquareRoot],
    ["ceil", PrimitiveId.f32x4Ceiling],
    ["floor", PrimitiveId.f32x4Floor],
    ["trunc", PrimitiveId.f32x4Truncate],
    ["nearest", PrimitiveId.f32x4Nearest],
  ].map(([name, primitiveId]) =>
    unaryPrimitive(
      `f32x4.${name}`,
      primitiveId as PrimitiveId,
      "f32x4",
      "f32x4",
    )
  ),
  ...[
    ["add", PrimitiveId.f32x4Add],
    ["sub", PrimitiveId.f32x4Subtract],
    ["mul", PrimitiveId.f32x4Multiply],
    ["div", PrimitiveId.f32x4Divide],
    ["min", PrimitiveId.f32x4Minimum],
    ["max", PrimitiveId.f32x4Maximum],
    ["pmin", PrimitiveId.f32x4PseudoMinimum],
    ["pmax", PrimitiveId.f32x4PseudoMaximum],
  ].map(([name, primitiveId]) =>
    binaryPrimitive(`f32x4.${name}`, primitiveId as PrimitiveId, "f32x4")
  ),
  ...[
    ["eq", PrimitiveId.f32x4Equal],
    ["ne", PrimitiveId.f32x4NotEqual],
    ["lt", PrimitiveId.f32x4LessThan],
    ["le", PrimitiveId.f32x4LessThanOrEqual],
    ["gt", PrimitiveId.f32x4GreaterThan],
    ["ge", PrimitiveId.f32x4GreaterThanOrEqual],
  ].map(([name, primitiveId]) =>
    binaryPrimitive(
      `f32x4.${name}`,
      primitiveId as PrimitiveId,
      "f32x4",
      "f32x4-mask",
    )
  ),
  selectPrimitive(
    "f32x4.select",
    PrimitiveId.f32x4Select,
    "f32x4-mask",
    "f32x4",
  ),
  unaryPrimitive(
    "f32x4.mask_bitmask",
    PrimitiveId.f32x4MaskBitmask,
    "f32x4-mask",
    "i32",
  ),
  unaryPrimitive(
    "f32x4.mask_all_true",
    PrimitiveId.f32x4MaskAllTrue,
    "f32x4-mask",
    "i32",
  ),
  unaryPrimitive(
    "f32x4.mask_any_true",
    PrimitiveId.f32x4MaskAnyTrue,
    "f32x4-mask",
    "i32",
  ),
  unaryPrimitive("i8x16.splat", PrimitiveId.i8x16Splat, "i32", "i8x16"),
  ...[
    ["add", PrimitiveId.i8x16Add],
    ["sub", PrimitiveId.i8x16Subtract],
    ["and", PrimitiveId.i8x16And],
    ["or", PrimitiveId.i8x16Or],
    ["xor", PrimitiveId.i8x16Xor],
    ["min_s", PrimitiveId.i8x16MinimumSigned],
    ["min_u", PrimitiveId.i8x16MinimumUnsigned],
    ["max_s", PrimitiveId.i8x16MaximumSigned],
    ["max_u", PrimitiveId.i8x16MaximumUnsigned],
  ].map(([name, primitiveId]) =>
    binaryPrimitive(`i8x16.${name}`, primitiveId as PrimitiveId, "i8x16")
  ),
  unaryPrimitive("i8x16.not", PrimitiveId.i8x16Not, "i8x16", "i8x16"),
  shiftPrimitive("i8x16.shl", PrimitiveId.i8x16ShiftLeft, "i8x16"),
  shiftPrimitive("i8x16.shr_s", PrimitiveId.i8x16ShiftRightSigned, "i8x16"),
  shiftPrimitive("i8x16.shr_u", PrimitiveId.i8x16ShiftRightUnsigned, "i8x16"),
  binaryPrimitive("i8x16.eq", PrimitiveId.i8x16Equal, "i8x16", "i8x16-mask"),
  binaryPrimitive(
    "i8x16.lt_s",
    PrimitiveId.i8x16LessThanSigned,
    "i8x16",
    "i8x16-mask",
  ),
  binaryPrimitive(
    "i8x16.lt_u",
    PrimitiveId.i8x16LessThanUnsigned,
    "i8x16",
    "i8x16-mask",
  ),
  selectPrimitive(
    "i8x16.select",
    PrimitiveId.i8x16Select,
    "i8x16-mask",
    "i8x16",
  ),
  unaryPrimitive(
    "i8x16.mask_bitmask",
    PrimitiveId.i8x16MaskBitmask,
    "i8x16-mask",
    "i32",
  ),
  unaryPrimitive(
    "i8x16.mask_all_true",
    PrimitiveId.i8x16MaskAllTrue,
    "i8x16-mask",
    "i32",
  ),
  unaryPrimitive(
    "i8x16.mask_any_true",
    PrimitiveId.i8x16MaskAnyTrue,
    "i8x16-mask",
    "i32",
  ),
  unaryPrimitive("i16x8.splat", PrimitiveId.i16x8Splat, "i32", "i16x8"),
  ...[
    ["add", PrimitiveId.i16x8Add],
    ["sub", PrimitiveId.i16x8Subtract],
    ["mul", PrimitiveId.i16x8Multiply],
    ["and", PrimitiveId.i16x8And],
    ["or", PrimitiveId.i16x8Or],
    ["xor", PrimitiveId.i16x8Xor],
    ["min_s", PrimitiveId.i16x8MinimumSigned],
    ["min_u", PrimitiveId.i16x8MinimumUnsigned],
    ["max_s", PrimitiveId.i16x8MaximumSigned],
    ["max_u", PrimitiveId.i16x8MaximumUnsigned],
  ].map(([name, primitiveId]) =>
    binaryPrimitive(`i16x8.${name}`, primitiveId as PrimitiveId, "i16x8")
  ),
  unaryPrimitive("i16x8.not", PrimitiveId.i16x8Not, "i16x8", "i16x8"),
  shiftPrimitive("i16x8.shl", PrimitiveId.i16x8ShiftLeft, "i16x8"),
  shiftPrimitive("i16x8.shr_s", PrimitiveId.i16x8ShiftRightSigned, "i16x8"),
  shiftPrimitive("i16x8.shr_u", PrimitiveId.i16x8ShiftRightUnsigned, "i16x8"),
  binaryPrimitive("i16x8.eq", PrimitiveId.i16x8Equal, "i16x8", "i16x8-mask"),
  binaryPrimitive(
    "i16x8.lt_s",
    PrimitiveId.i16x8LessThanSigned,
    "i16x8",
    "i16x8-mask",
  ),
  binaryPrimitive(
    "i16x8.lt_u",
    PrimitiveId.i16x8LessThanUnsigned,
    "i16x8",
    "i16x8-mask",
  ),
  selectPrimitive(
    "i16x8.select",
    PrimitiveId.i16x8Select,
    "i16x8-mask",
    "i16x8",
  ),
  unaryPrimitive(
    "i16x8.mask_bitmask",
    PrimitiveId.i16x8MaskBitmask,
    "i16x8-mask",
    "i32",
  ),
  unaryPrimitive(
    "i16x8.mask_all_true",
    PrimitiveId.i16x8MaskAllTrue,
    "i16x8-mask",
    "i32",
  ),
  unaryPrimitive(
    "i16x8.mask_any_true",
    PrimitiveId.i16x8MaskAnyTrue,
    "i16x8-mask",
    "i32",
  ),
]);

type ZeroExpression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "variable";
    readonly name: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: ZeroBinaryOperator;
    readonly left: ZeroExpression;
    readonly right: ZeroExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "let";
    readonly binding: ZeroBinding;
    readonly value: ZeroExpression;
    readonly body: ZeroExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: ZeroExpression;
    readonly consequent: ZeroExpression;
    readonly alternate: ZeroExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "call";
    readonly functionName: string;
    readonly arguments: readonly ZeroExpression[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "repeat";
    readonly count: ZeroExpression;
    readonly initial: ZeroExpression;
    readonly binding: ZeroBinding;
    readonly body: ZeroExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "primitive";
    readonly primitiveId: PrimitiveId;
    readonly operands: readonly ZeroExpression[];
    readonly resultType: ZeroType;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "vector.shuffle";
    readonly operands: readonly [ZeroExpression, ZeroExpression];
    readonly lanes: readonly number[];
    readonly resultType: "i8x16" | "i16x8" | "i32x4" | "f32x4";
    readonly span: SourceSpan;
  };

export type ZeroCompilationTimings = {
  readonly parserInitializationMilliseconds: number;
  readonly parsingMilliseconds: number;
  readonly coreLoweringMilliseconds: number;
  readonly wasmPlanningMilliseconds: number;
  readonly emitterInitializationMilliseconds: number;
  readonly wasmEmissionMilliseconds: number;
  readonly totalMilliseconds: number;
};

export type ZeroCompilation = {
  readonly core: CoreModule;
  readonly wasmPlan: WasmBinaryPlan;
  readonly wasm: Uint8Array;
  readonly timings: ZeroCompilationTimings;
};

type ParsedZeroProgram = {
  readonly program: ZeroProgram;
  readonly parserInitializationMilliseconds: number;
  readonly parsingMilliseconds: number;
};

type ZeroFunctionDescription = {
  readonly id: CoreFunctionId;
  readonly signature: CoreSignatureId;
  readonly parameterTypes: readonly ZeroType[];
  readonly resultType: ZeroType;
};

type BuildingBlock = {
  readonly id: CoreBlockId;
  readonly parameters: readonly {
    readonly value: CoreValueId;
    readonly type: CoreTypeId;
    readonly span: SourceSpan;
  }[];
  readonly operations: CoreOperation[];
  terminator: CoreTerminator | undefined;
};

type LoweredExpression = {
  readonly block: BuildingBlock;
  readonly value: CoreValueId;
  readonly type: ZeroType;
};

type LoweredBinding = Pick<LoweredExpression, "value" | "type">;

type CoreOperationWithoutResult = CoreOperation extends infer Operation
  ? Operation extends CoreOperation ? Omit<Operation, "result"> : never
  : never;

type ZeroParser = ReturnType<typeof createParser>;
let parserPromise: Promise<ZeroParser> | undefined;

export async function compileZeroSource(
  file: string,
  source: string,
): Promise<ZeroCompilation> {
  const totalStart = performance.now();
  const parsed = await parseZeroProgram(file, source);

  const coreStart = performance.now();
  const core = lowerZeroProgramToCore(parsed.program);
  validateCore(core);
  const coreLoweringMilliseconds = performance.now() - coreStart;

  const planningStart = performance.now();
  const lowered = lowerCoreToWasm(core, {
    emission: "planOnly",
    target: core.types.some((type) =>
        type.kind === "vector" || type.kind === "mask"
      )
      ? "wasm-simd128"
      : "wasm-scalar",
    exports: parsed.program.functions.flatMap((function_, index) =>
      function_.exported
        ? [{
          name: function_.name,
          functionId: index as CoreFunctionId,
        }]
        : []
    ),
  });
  const wasmPlanningMilliseconds = performance.now() - planningStart;

  const emitterInitialization = await createRustWasmEmitter();
  const emissionStart = performance.now();
  const emitted = emitterInitialization.emitter.emit(lowered.wasmPlan);
  const wasmEmissionMilliseconds = performance.now() - emissionStart;
  if (!WebAssembly.validate(Uint8Array.from(emitted.bytes))) {
    throw new Error(`${file}: Rust/WebAssembly emitter produced invalid Wasm`);
  }

  return {
    core,
    wasmPlan: lowered.wasmPlan,
    wasm: emitted.bytes,
    timings: {
      parserInitializationMilliseconds: parsed.parserInitializationMilliseconds,
      parsingMilliseconds: parsed.parsingMilliseconds,
      coreLoweringMilliseconds,
      wasmPlanningMilliseconds,
      emitterInitializationMilliseconds:
        emitterInitialization.timings.totalMilliseconds,
      wasmEmissionMilliseconds,
      totalMilliseconds: performance.now() - totalStart,
    },
  };
}

export function lowerZeroProgramToCore(program: ZeroProgram): CoreModule {
  if (program.functions.length === 0) {
    throw new TypeError(`${program.file}: Zero program has no functions`);
  }
  const entryFunction = program.functions.findIndex((function_) =>
    function_.exported
  );
  if (entryFunction < 0) {
    throw new TypeError(
      `${program.file}: Zero program has no exported functions`,
    );
  }
  const descriptions = new Map<string, ZeroFunctionDescription>();
  for (const [index, function_] of program.functions.entries()) {
    if (descriptions.has(function_.name)) {
      throw semanticError(
        function_.span,
        `duplicate function ${function_.name}`,
      );
    }
    descriptions.set(function_.name, {
      id: index as CoreFunctionId,
      signature: index as CoreSignatureId,
      parameterTypes: function_.parameters.map((parameter) => parameter.type),
      resultType: function_.resultType,
    });
  }

  const functions = program.functions.map((function_, index) => {
    const description = descriptions.get(function_.name);
    if (description === undefined) {
      throw new Error(`${program.file}: function table lost ${function_.name}`);
    }
    return new ZeroCoreFunctionBuilder(
      function_,
      index as CoreFunctionId,
      description.signature,
      descriptions,
    ).lower();
  });
  return {
    schemaVersion: 1,
    file: program.file,
    types: program.functions.some((function_) => function_.usesSimd)
      ? [
        { kind: "scalar", scalar: "i32" },
        { kind: "vector", lanes: 4, element: "i32" },
        { kind: "mask", lanes: 4, element: "i32" },
        { kind: "vector", lanes: 4, element: "f32" },
        { kind: "mask", lanes: 4, element: "f32" },
        { kind: "vector", lanes: 16, element: "i8" },
        { kind: "mask", lanes: 16, element: "i8" },
        { kind: "vector", lanes: 8, element: "i16" },
        { kind: "mask", lanes: 8, element: "i16" },
      ]
      : [{ kind: "scalar", scalar: "i32" }],
    signatures: program.functions.map((function_) => ({
      parameters: function_.parameters.map((parameter) =>
        coreType(parameter.type)
      ),
      result: coreType(function_.resultType),
    })),
    functions,
    entryFunction: entryFunction as CoreFunctionId,
  };
}

class ZeroCoreFunctionBuilder {
  readonly #blocks: BuildingBlock[] = [];
  readonly #function: ZeroFunction;
  readonly #id: CoreFunctionId;
  readonly #signature: CoreSignatureId;
  readonly #functions: ReadonlyMap<string, ZeroFunctionDescription>;
  #nextValue = 0;

  constructor(
    function_: ZeroFunction,
    id: CoreFunctionId,
    signature: CoreSignatureId,
    functions: ReadonlyMap<string, ZeroFunctionDescription>,
  ) {
    this.#function = function_;
    this.#id = id;
    this.#signature = signature;
    this.#functions = functions;
  }

  lower(): CoreFunction {
    const parameterNames = new Set<string>();
    const entry = this.#createBlock(
      this.#function.parameters.map((parameter) => {
        if (parameterNames.has(parameter.name)) {
          throw semanticError(
            parameter.span,
            `duplicate parameter ${parameter.name}`,
          );
        }
        parameterNames.add(parameter.name);
        return { span: parameter.span, type: parameter.type };
      }),
    );
    const environment = new Map(
      this.#function.parameters.map((parameter, index) => [
        parameter.name,
        {
          value: entry.parameters[index]!.value,
          type: parameter.type,
        },
      ]),
    );
    const body = this.#lowerExpression(this.#function.body, entry, environment);
    if (body.type !== this.#function.resultType) {
      throw semanticError(
        this.#function.body.span,
        `function ${this.#function.name} returns ${body.type}; declared ${this.#function.resultType}`,
      );
    }
    this.#terminate(body.block, {
      kind: "return",
      values: [body.value],
      span: this.#function.body.span,
    });
    return {
      id: this.#id,
      name: this.#function.name,
      sourceIdentity: undefined,
      signature: this.#signature,
      entryBlock: entry.id,
      blocks: this.#blocks.map((block): CoreBlock => {
        if (block.terminator === undefined) {
          throw new Error(
            `${this.#function.span.file}: Zero block ${block.id} has no terminator`,
          );
        }
        return {
          id: block.id,
          parameters: block.parameters,
          operations: block.operations,
          terminator: block.terminator,
        };
      }),
      span: this.#function.span,
    };
  }

  #lowerExpression(
    expression: ZeroExpression,
    block: BuildingBlock,
    environment: ReadonlyMap<string, LoweredBinding>,
  ): LoweredExpression {
    switch (expression.kind) {
      case "integer":
        return {
          block,
          value: this.#emit(block, {
            kind: "constant",
            type: i32,
            operands: [],
            value: expression.value,
            span: expression.span,
          }),
          type: "i32",
        };
      case "variable": {
        const value = environment.get(expression.name);
        if (value === undefined) {
          throw semanticError(
            expression.span,
            `unbound variable ${expression.name}`,
          );
        }
        return { block, value: value.value, type: value.type };
      }
      case "binary": {
        const left = this.#lowerExpression(expression.left, block, environment);
        const right = this.#lowerExpression(
          expression.right,
          left.block,
          environment,
        );
        if (left.type !== "i32" || right.type !== "i32") {
          throw semanticError(
            expression.span,
            `operator ${expression.operator} requires i32 operands; received ${left.type} and ${right.type}`,
          );
        }
        return {
          block: right.block,
          value: this.#emit(right.block, {
            kind: "scalar.binary",
            type: i32,
            operands: [left.value, right.value],
            operator: expression.operator,
            span: expression.span,
          }),
          type: "i32",
        };
      }
      case "let": {
        const value = this.#lowerExpression(
          expression.value,
          block,
          environment,
        );
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(expression.binding.name, {
          value: value.value,
          type: value.type,
        });
        return this.#lowerExpression(
          expression.body,
          value.block,
          bodyEnvironment,
        );
      }
      case "call": {
        const target = this.#functions.get(expression.functionName);
        if (target === undefined) {
          throw semanticError(
            expression.span,
            `unknown function ${expression.functionName}`,
          );
        }
        if (expression.arguments.length !== target.parameterTypes.length) {
          throw semanticError(
            expression.span,
            `function ${expression.functionName} expects ${target.parameterTypes.length} arguments; received ${expression.arguments.length}`,
          );
        }
        let currentBlock = block;
        const operands: CoreValueId[] = [];
        for (const [index, argument] of expression.arguments.entries()) {
          const lowered = this.#lowerExpression(
            argument,
            currentBlock,
            environment,
          );
          const expectedType = target.parameterTypes[index]!;
          if (lowered.type !== expectedType) {
            throw semanticError(
              argument.span,
              `function ${expression.functionName} argument ${index} is ${lowered.type}; expected ${expectedType}`,
            );
          }
          currentBlock = lowered.block;
          operands.push(lowered.value);
        }
        return {
          block: currentBlock,
          value: this.#emit(currentBlock, {
            kind: "call.direct",
            type: coreType(target.resultType),
            operands,
            functionId: target.id,
            span: expression.span,
          }),
          type: target.resultType,
        };
      }
      case "primitive": {
        const instruction = [...zeroPrimitiveInstructions.values()].find(
          (candidate) => candidate.primitiveId === expression.primitiveId,
        );
        if (instruction === undefined) {
          throw new Error(
            `${this.#function.span.file}: Zero lost primitive ${expression.primitiveId}`,
          );
        }
        let currentBlock = block;
        const operands: CoreValueId[] = [];
        for (const [index, operand] of expression.operands.entries()) {
          const lowered = this.#lowerExpression(
            operand,
            currentBlock,
            environment,
          );
          const expectedType = instruction.operandTypes[index]!;
          if (lowered.type !== expectedType) {
            throw semanticError(
              operand.span,
              `primitive ${
                primitiveDescriptor(expression.primitiveId).name
              } operand ${index} is ${lowered.type}; expected ${expectedType}`,
            );
          }
          currentBlock = lowered.block;
          operands.push(lowered.value);
        }
        return {
          block: currentBlock,
          value: this.#emit(currentBlock, {
            kind: "primitive",
            primitiveId: expression.primitiveId,
            type: coreType(expression.resultType),
            operands,
            span: expression.span,
          }),
          type: expression.resultType,
        };
      }
      case "vector.shuffle": {
        const left = this.#lowerExpression(
          expression.operands[0],
          block,
          environment,
        );
        const right = this.#lowerExpression(
          expression.operands[1],
          left.block,
          environment,
        );
        if (
          left.type !== expression.resultType ||
          right.type !== expression.resultType
        ) {
          throw semanticError(
            expression.span,
            `shuffle ${expression.resultType} requires two ${expression.resultType} operands; received ${left.type} and ${right.type}`,
          );
        }
        return {
          block: right.block,
          value: this.#emit(right.block, {
            kind: "vector.shuffle",
            type: coreType(expression.resultType),
            operands: [left.value, right.value],
            lanes: expression.lanes,
            span: expression.span,
          }),
          type: expression.resultType,
        };
      }
      case "if":
        return this.#lowerConditional(expression, block, environment);
      case "repeat":
        return this.#lowerRepeat(expression, block, environment);
    }
  }

  #lowerConditional(
    expression: Extract<ZeroExpression, { readonly kind: "if" }>,
    block: BuildingBlock,
    environment: ReadonlyMap<string, LoweredBinding>,
  ): LoweredExpression {
    const condition = this.#lowerExpression(
      expression.condition,
      block,
      environment,
    );
    if (condition.type !== "i32") {
      throw semanticError(
        expression.condition.span,
        `select! condition is ${condition.type}; expected i32`,
      );
    }
    const consequentBlock = this.#createBlock([]);
    const alternateBlock = this.#createBlock([]);
    this.#terminate(condition.block, {
      kind: "conditional_branch",
      condition: condition.value,
      trueTarget: consequentBlock.id,
      trueArguments: [],
      falseTarget: alternateBlock.id,
      falseArguments: [],
      span: expression.condition.span,
    });

    const consequent = this.#lowerExpression(
      expression.consequent,
      consequentBlock,
      environment,
    );
    const alternate = this.#lowerExpression(
      expression.alternate,
      alternateBlock,
      environment,
    );
    if (consequent.type !== alternate.type) {
      throw semanticError(
        expression.span,
        `select! branches produce ${consequent.type} and ${alternate.type}`,
      );
    }
    const joinBlock = this.#createBlock([
      { span: expression.span, type: consequent.type },
    ]);
    this.#terminate(consequent.block, {
      kind: "branch",
      target: joinBlock.id,
      arguments: [consequent.value],
      span: expression.consequent.span,
    });
    this.#terminate(alternate.block, {
      kind: "branch",
      target: joinBlock.id,
      arguments: [alternate.value],
      span: expression.alternate.span,
    });
    return {
      block: joinBlock,
      value: joinBlock.parameters[0]!.value,
      type: consequent.type,
    };
  }

  #lowerRepeat(
    expression: Extract<ZeroExpression, { readonly kind: "repeat" }>,
    block: BuildingBlock,
    environment: ReadonlyMap<string, LoweredBinding>,
  ): LoweredExpression {
    const count = this.#lowerExpression(expression.count, block, environment);
    const initial = this.#lowerExpression(
      expression.initial,
      count.block,
      environment,
    );
    if (count.type !== "i32") {
      throw semanticError(
        expression.count.span,
        `repeat count is ${count.type}; expected i32`,
      );
    }
    const header = this.#createBlock([
      { span: expression.count.span, type: "i32" },
      { span: expression.span, type: initial.type },
    ]);
    const bodyBlock = this.#createBlock([]);
    const exit = this.#createBlock([
      { span: expression.span, type: initial.type },
    ]);
    this.#terminate(initial.block, {
      kind: "branch",
      target: header.id,
      arguments: [count.value, initial.value],
      span: expression.span,
    });

    const [remaining, state] = header.parameters;
    const zero = this.#emit(header, {
      kind: "constant",
      type: i32,
      operands: [],
      value: 0,
      span: expression.count.span,
    });
    const hasNext = this.#emit(header, {
      kind: "scalar.binary",
      type: i32,
      operands: [remaining!.value, zero],
      operator: ">",
      span: expression.count.span,
    });
    this.#terminate(header, {
      kind: "conditional_branch",
      condition: hasNext,
      trueTarget: bodyBlock.id,
      trueArguments: [],
      falseTarget: exit.id,
      falseArguments: [state!.value],
      span: expression.span,
    });

    const bodyEnvironment = new Map(environment);
    bodyEnvironment.set(expression.binding.name, {
      value: state!.value,
      type: initial.type,
    });
    const body = this.#lowerExpression(
      expression.body,
      bodyBlock,
      bodyEnvironment,
    );
    if (body.type !== initial.type) {
      throw semanticError(
        expression.body.span,
        `repeat step returns ${body.type}; state is ${initial.type}`,
      );
    }
    const one = this.#emit(body.block, {
      kind: "constant",
      type: i32,
      operands: [],
      value: 1,
      span: expression.count.span,
    });
    const nextRemaining = this.#emit(body.block, {
      kind: "scalar.binary",
      type: i32,
      operands: [remaining!.value, one],
      operator: "-",
      span: expression.count.span,
    });
    this.#terminate(body.block, {
      kind: "branch",
      target: header.id,
      arguments: [nextRemaining, body.value],
      span: expression.body.span,
    });
    return {
      block: exit,
      value: exit.parameters[0]!.value,
      type: initial.type,
    };
  }

  #createBlock(
    parameterDescriptions: readonly {
      readonly span: SourceSpan;
      readonly type: ZeroType;
    }[],
  ): BuildingBlock {
    const block: BuildingBlock = {
      id: this.#blocks.length as CoreBlockId,
      parameters: parameterDescriptions.map(({ span, type }) => ({
        value: this.#nextValue++ as CoreValueId,
        type: coreType(type),
        span,
      })),
      operations: [],
      terminator: undefined,
    };
    this.#blocks.push(block);
    return block;
  }

  #emit(
    block: BuildingBlock,
    operation: CoreOperationWithoutResult,
  ): CoreValueId {
    if (block.terminator !== undefined) {
      throw new Error(
        `${this.#function.span.file}: cannot emit after block ${block.id} terminator`,
      );
    }
    const result = this.#nextValue++ as CoreValueId;
    block.operations.push({ ...operation, result } as CoreOperation);
    return result;
  }

  #terminate(block: BuildingBlock, terminator: CoreTerminator): void {
    if (block.terminator !== undefined) {
      throw new Error(
        `${this.#function.span.file}: block ${block.id} already has a terminator`,
      );
    }
    block.terminator = terminator;
  }
}

async function parseZeroProgram(
  file: string,
  source: string,
): Promise<ParsedZeroProgram> {
  const parserInitializationStart = performance.now();
  const parser = await getZeroParser();
  const parserInitializationMilliseconds = performance.now() -
    parserInitializationStart;
  const parsingStart = performance.now();
  const parsed = parser.parse(source, { preserveTrivia: false });
  if (!parsed.ok) {
    const diagnostic = parsed.diagnostics[0];
    throw new SyntaxError(
      `${file}:${diagnostic.span.start}: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
  const functions = ruleFieldArray(parsed.cursor, "functions").map((node) =>
    parseZeroFunction(file, node)
  );
  return {
    program: { file, functions },
    parserInitializationMilliseconds,
    parsingMilliseconds: performance.now() - parsingStart,
  };
}

async function getZeroParser(): Promise<ZeroParser> {
  parserPromise ??= Promise.all([
    Deno.readFile(parserWasmUrl),
    Deno.readFile(parserPlanUrl),
  ]).then(([bytes, plan]) => createParser({ bytes, plan }));
  return await parserPromise;
}

function parseZeroFunction(file: string, node: RuleCursor): ZeroFunction {
  const visibility = requiredToken(node, "visibility");
  const name = requiredToken(node, "name");
  if (name.text.includes("[")) {
    throw semanticError(
      sourceSpan(file, name),
      `function name ${name.text} cannot have a type annotation`,
    );
  }
  const parameters = tokenFieldArray(node, "parameters");
  const assignment = requiredToken(node, "assignment");
  const instructions = tokenFieldArray(node, "body");
  const parsedParameters = parameters.map((token): ZeroParameter => {
    const match = /^(.*)\[(i8x16|i16x8|i32x4|f32x4)\]$/.exec(token.text);
    return {
      name: match?.[1] ?? token.text,
      type: (match?.[2] as ZeroType | undefined) ?? "i32",
      span: sourceSpan(file, token),
    };
  });
  const resultType: ZeroType = assignment.text === "="
    ? "i32"
    : assignment.text === "=>"
    ? "i32x4"
    : assignment.text.slice(2) as ZeroType;
  return {
    exported: visibility.text === "export:",
    name: name.text,
    parameters: parsedParameters,
    resultType,
    usesSimd: resultType !== "i32" ||
      parsedParameters.some((parameter) => parameter.type !== "i32") ||
      instructions.some((instruction) =>
        zeroPrimitiveInstructions.has(instruction.text) ||
        instruction.text.includes(".shuffle:")
      ),
    body: parseZeroInstructions(file, instructions),
    span: sourceSpan(file, node),
  };
}

function parseZeroInstructions(
  file: string,
  instructions: readonly TokenCursor[],
  startIndex = 0,
): ZeroExpression {
  const stack: ZeroExpression[] = [];
  for (let index = startIndex; index < instructions.length; index += 1) {
    const instruction = instructions[index]!;
    const span = sourceSpan(file, instruction);
    const text = instruction.text;
    if (/^[0-9]+$/.test(text)) {
      const value = Number(text);
      if (!Number.isSafeInteger(value) || value > maximumI32) {
        throw semanticError(
          span,
          `integer literal ${text} is outside signed i32`,
        );
      }
      stack.push({ kind: "integer", value, span });
      continue;
    }
    if (text.startsWith("@")) {
      stack.push({ kind: "variable", name: text.slice(1), span });
      continue;
    }
    if (zeroBinaryOperators.has(text as ZeroBinaryOperator)) {
      const right = popZeroExpression(stack, span, text);
      const left = popZeroExpression(stack, span, text);
      stack.push({
        kind: "binary",
        operator: text as ZeroBinaryOperator,
        left,
        right,
        span: { file, start: left.span.start, end: span.end },
      });
      continue;
    }
    const shuffle = /^(i8x16|i16x8|i32x4|f32x4)\.shuffle:([0-9,]+)$/.exec(text);
    if (shuffle !== null) {
      if (stack.length < 2) {
        throw semanticError(
          span,
          `shuffle ${
            shuffle[1]
          } requests 2 operands; stack contains ${stack.length}`,
        );
      }
      const resultType = shuffle[1] as "i8x16" | "i16x8" | "i32x4" | "f32x4";
      const laneCount = resultType === "i8x16"
        ? 16
        : resultType === "i16x8"
        ? 8
        : 4;
      const lanes = shuffle[2]!.split(",").map(Number);
      if (
        lanes.length !== laneCount ||
        lanes.some((lane) =>
          !Number.isSafeInteger(lane) || lane < 0 || lane >= laneCount * 2
        )
      ) {
        throw semanticError(
          span,
          `shuffle ${resultType} requires ${laneCount} lanes in 0..${
            laneCount * 2 - 1
          }; received [${lanes.join(", ")}]`,
        );
      }
      const operands = stack.splice(stack.length - 2, 2) as [
        ZeroExpression,
        ZeroExpression,
      ];
      stack.push({
        kind: "vector.shuffle",
        operands,
        lanes,
        resultType,
        span: { file, start: operands[0].span.start, end: span.end },
      });
      continue;
    }
    const primitive = zeroPrimitiveInstructions.get(text);
    if (primitive !== undefined) {
      if (primitive.operandTypes.length > stack.length) {
        throw semanticError(
          span,
          `primitive ${text} requests ${primitive.operandTypes.length} operands; stack contains ${stack.length}`,
        );
      }
      const operands = stack.splice(
        stack.length - primitive.operandTypes.length,
        primitive.operandTypes.length,
      );
      stack.push({
        kind: "primitive",
        primitiveId: primitive.primitiveId,
        operands,
        resultType: primitive.resultType,
        span: {
          file,
          start: operands[0]?.span.start ?? span.start,
          end: span.end,
        },
      });
      continue;
    }
    if (text.startsWith("let:")) {
      if (stack.length !== 1) {
        throw semanticError(
          span,
          `binding ${text} requires one value; stack contains ${stack.length}`,
        );
      }
      const value = stack[0]!;
      const body = parseZeroInstructions(file, instructions, index + 1);
      return {
        kind: "let",
        binding: { name: text.slice(4), span },
        value,
        body,
        span: { file, start: value.span.start, end: body.span.end },
      };
    }
    if (text.startsWith("call:")) {
      const segments = text.split(":");
      const functionName = segments[1]!;
      const arity = Number(segments[2]);
      if (!Number.isSafeInteger(arity) || arity < 0 || arity > stack.length) {
        throw semanticError(
          span,
          `call ${functionName} requests ${
            String(arity)
          } arguments; stack contains ${stack.length}`,
        );
      }
      const arguments_ = stack.splice(stack.length - arity, arity);
      stack.push({
        kind: "call",
        functionName,
        arguments: arguments_,
        span: {
          file,
          start: arguments_[0]?.span.start ?? span.start,
          end: span.end,
        },
      });
      continue;
    }
    if (text === "select!") {
      const alternate = popZeroExpression(stack, span, text);
      const consequent = popZeroExpression(stack, span, text);
      const condition = popZeroExpression(stack, span, text);
      stack.push({
        kind: "if",
        condition,
        consequent,
        alternate,
        span: { file, start: condition.span.start, end: span.end },
      });
      continue;
    }
    if (text.startsWith("repeat:")) {
      const functionName = text.slice(7);
      const initial = popZeroExpression(stack, span, text);
      const count = popZeroExpression(stack, span, text);
      const binding: ZeroBinding = {
        name: `#repeat_${span.start}`,
        span,
      };
      stack.push({
        kind: "repeat",
        count,
        initial,
        binding,
        body: {
          kind: "call",
          functionName,
          arguments: [{ kind: "variable", name: binding.name, span }],
          span,
        },
        span: { file, start: count.span.start, end: span.end },
      });
      continue;
    }
    throw semanticError(span, `unsupported instruction ${text}`);
  }
  if (stack.length !== 1) {
    const start = instructions[startIndex]?.span.start ?? 0;
    throw semanticError(
      { file, start, end: instructions.at(-1)?.span.end ?? start },
      `function body leaves ${stack.length} values; expected one`,
    );
  }
  return stack[0]!;
}

function ruleFieldArray(node: RuleCursor, name: string): readonly RuleCursor[] {
  return node.fieldArray(name).map((value) => {
    if (!isRuleCursor(value)) {
      throw new Error(`expected rule array field ${name} on ${node.name}`);
    }
    return value;
  });
}

function tokenFieldArray(
  node: RuleCursor,
  name: string,
): readonly TokenCursor[] {
  return node.fieldArray(name).map((value) => {
    if (!isTokenCursor(value)) {
      throw new Error(`expected token array field ${name} on ${node.name}`);
    }
    return value;
  });
}

function requiredToken(node: RuleCursor, name: string): TokenCursor {
  const value = node.field(name);
  if (!isTokenCursor(value)) {
    throw new Error(`expected token field ${name} on ${node.name}`);
  }
  return value;
}

function isRuleCursor(value: unknown): value is RuleCursor {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && "type" in value && value.type === "rule";
}

function popZeroExpression(
  stack: ZeroExpression[],
  span: SourceSpan,
  instruction: string,
): ZeroExpression {
  const expression = stack.pop();
  if (expression === undefined) {
    throw semanticError(
      span,
      `instruction ${instruction} underflows the stack`,
    );
  }
  return expression;
}

function isTokenCursor(value: unknown): value is TokenCursor {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && "type" in value && value.type === "token";
}

function sourceSpan(
  file: string,
  cursor: RuleCursor | TokenCursor,
): SourceSpan {
  return { file, start: cursor.span.start, end: cursor.span.end };
}

function semanticError(span: SourceSpan, message: string): TypeError {
  return new TypeError(`${span.file}:${span.start}: ${message}`);
}

function coreType(type: ZeroType): CoreTypeId {
  if (type === "i32") return i32;
  if (type === "i32x4") return i32x4;
  if (type === "i32x4-mask") return i32x4Mask;
  if (type === "f32x4") return f32x4;
  if (type === "f32x4-mask") return f32x4Mask;
  if (type === "i8x16") return i8x16;
  if (type === "i8x16-mask") return i8x16Mask;
  if (type === "i16x8") return i16x8;
  return i16x8Mask;
}

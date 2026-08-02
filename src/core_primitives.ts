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
  textCodePointLength: 63,
  textFromI64: 64,
  textCompare: 65,
  textContains: 66,
} as const;

export type PrimitiveId = typeof PrimitiveId[keyof typeof PrimitiveId];

export type PrimitiveDescriptor = {
  readonly id: PrimitiveId;
  readonly name: string;
  readonly lowering: string;
};

export const coreRuntimeImportModule = "__gpupaper_runtime";

const descriptors = new Map<PrimitiveId, PrimitiveDescriptor>(
  Object.entries(PrimitiveId).map(([identifier, id]) => {
    const name = identifier.replace(/([a-z0-9])([A-Z])/g, "$1.$2")
      .toLowerCase();
    return [id, { id, name, lowering: `core.${name}` }];
  }),
);

export function primitiveRuntimeImportName(id: PrimitiveId): string {
  return `primitive_${id}`;
}

export function primitiveDescriptor(id: PrimitiveId): PrimitiveDescriptor {
  const descriptor = descriptors.get(id);
  if (descriptor !== undefined) return descriptor;
  throw new RangeError(`unknown Core primitive ID ${id}`);
}

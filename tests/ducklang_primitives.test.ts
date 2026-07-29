import {
  BuiltinTypeId,
  builtinTypeName,
  primitiveDescriptor,
  primitiveDescriptors,
  PrimitiveId,
  resolveImportedPrimitive,
  resolveSourcePrimitive,
  validatePrimitiveCall,
} from "../src/ducklang_primitives.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import {
  formatDucklangType,
  inferDucklangModule,
} from "../src/ducklang_types.ts";

Deno.test("Ducklang primitive IDs remain unique and stable", () => {
  assertEquals(primitiveDescriptors.length, 48);
  assertEquals(primitiveDescriptor(PrimitiveId.add).name, "scalar.add");
  assertEquals(
    primitiveDescriptor(PrimitiveId.utf8Decode).name,
    "utf8.decode",
  );
  assertEquals(primitiveDescriptor(PrimitiveId.panic).name, "control.panic");
  assertEquals(primitiveDescriptor(PrimitiveId.bufferSet).name, "buffer.set");
  assertEquals(primitiveDescriptor(PrimitiveId.bytesFill).name, "bytes.fill");
  assertEquals(
    primitiveDescriptor(PrimitiveId.bufferEqual).name,
    "buffer.equal",
  );
  assertEquals(primitiveDescriptor(PrimitiveId.f32Format).name, "f32.format");
});

Deno.test("Ducklang builtin type IDs cover the source builtin universe", () => {
  assertEquals(
    Object.values(BuiltinTypeId).map((id) => builtinTypeName(id)),
    [
      "i32",
      "i64",
      "f32",
      "f64",
      "f32x4",
      "bool",
      "char",
      "text",
      "bytes",
      "unit",
    ],
  );
});

Deno.test("Ducklang source aliases resolve to the same primitive as imports", () => {
  const source = resolveSourcePrimitive("@append");
  const imported = resolveImportedPrimitive(
    "duck:prelude/runtime",
    "text_append",
  );
  assertEquals(source?.id, PrimitiveId.bufferAppend);
  assertEquals(imported?.id, source?.id);
});

Deno.test("Ducklang runtime primitive wrappers resolve without name dispatch", () => {
  const expected = new Map([
    ["text_length", PrimitiveId.bufferLength],
    ["text_get", PrimitiveId.bufferGet],
    ["text_slice", PrimitiveId.bufferSlice],
    ["bit_and", PrimitiveId.bitAnd],
    ["shift_right_unsigned", PrimitiveId.shiftRightUnsigned],
    ["sqrt_f32", PrimitiveId.f32SquareRoot],
    ["unsafe_i32_wrap_i64", PrimitiveId.i32WrapI64],
    ["generate_bytes", PrimitiveId.bytesGenerate],
    ["encode_utf8", PrimitiveId.utf8Encode],
    ["decode_utf8", PrimitiveId.utf8Decode],
    ["f32x4_multiply", PrimitiveId.f32x4Multiply],
  ]);
  for (const [exportName, primitiveId] of expected) {
    assertEquals(
      resolveImportedPrimitive("duck:prelude/runtime", exportName)?.id,
      primitiveId,
    );
  }
});

Deno.test("Ducklang primitive validation preserves matching buffer kinds", () => {
  assertEquals(
    validatePrimitiveCall({
      id: PrimitiveId.bufferAppend,
      stage: "runtime",
      operandTypes: [BuiltinTypeId.bytes, BuiltinTypeId.bytes],
      source: "test.duck:12",
    }),
    BuiltinTypeId.bytes,
  );
});

Deno.test("Ducklang byte updates preserve the Bytes type", () => {
  assertEquals(
    validatePrimitiveCall({
      id: PrimitiveId.bufferSet,
      stage: "runtime",
      operandTypes: [
        BuiltinTypeId.bytes,
        BuiltinTypeId.i32,
        BuiltinTypeId.i32,
      ],
      source: "test.duck:15",
    }),
    BuiltinTypeId.bytes,
  );
});

Deno.test("Ducklang primitive validation rejects mixed buffer kinds", () => {
  assertThrows(
    () =>
      validatePrimitiveCall({
        id: PrimitiveId.bufferAppend,
        stage: "runtime",
        operandTypes: [BuiltinTypeId.text, BuiltinTypeId.bytes],
        source: "test.duck:18",
      }),
    /test\.duck:18: Ducklang primitive buffer\.append operand 1 expects the type of operand 0; received bytes/,
  );
});

Deno.test("Ducklang bytes generation validates its generator function", () => {
  assertEquals(
    validatePrimitiveCall({
      id: PrimitiveId.bytesGenerate,
      stage: "runtime",
      operandTypes: [
        BuiltinTypeId.i32,
        {
          kind: "function",
          parameters: [BuiltinTypeId.i32],
          result: BuiltinTypeId.i32,
        },
      ],
      source: "test.duck:21",
    }),
    BuiltinTypeId.bytes,
  );
});

Deno.test("Ducklang primitive validation rejects unavailable stages", () => {
  assertThrows(
    () =>
      validatePrimitiveCall({
        id: PrimitiveId.f32x4Splat,
        stage: "compileTime",
        operandTypes: [BuiltinTypeId.f32],
        source: "test.duck:24",
      }),
    /test\.duck:24: Ducklang primitive f32x4\.splat is unavailable during compileTime/,
  );
});

Deno.test("Ducklang panic is a trapping polymorphic bottom primitive", () => {
  const descriptor = primitiveDescriptor(PrimitiveId.panic);
  assertEquals(descriptor.effects, ["trap"]);
  assertEquals(descriptor.lowering, "wasm.unreachable");
  assertEquals(
    validatePrimitiveCall({
      id: PrimitiveId.panic,
      stage: "runtime",
      operandTypes: [BuiltinTypeId.text],
      source: "test.duck:27",
    }),
    "bottom",
  );
});

Deno.test("Ducklang primitive validation reports arity at the source", () => {
  assertThrows(
    () =>
      validatePrimitiveCall({
        id: PrimitiveId.utf8Encode,
        stage: "runtime",
        operandTypes: [],
        source: "test.duck:30",
      }),
    /test\.duck:30: Ducklang primitive utf8\.encode expects 1 operands; received 0/,
  );
});

Deno.test("Ducklang resolves direct builtin calls to canonical primitives", async () => {
  const parsed = await parseDucklangModule(
    "direct_primitive.duck",
    '@append("left", "right")\n',
  );
  const resolved = resolveDucklangModule(parsed);
  if (
    resolved.result.kind !== "call" ||
    resolved.result.callee.kind !== "primitive"
  ) {
    throw new Error(
      `expected a canonical primitive call, received ${resolved.result.kind}`,
    );
  }
  assertEquals(
    resolved.result.callee.primitiveId,
    PrimitiveId.bufferAppend,
  );

  const typed = inferDucklangModule(resolved);
  assertEquals(formatDucklangType(typed.resultType), "text");
});

Deno.test("Ducklang resolves runtime imports to canonical primitives", async () => {
  const parsed = await parseDucklangModule(
    "imported_primitive.duck",
    `const { append } = import "duck:prelude/runtime" ()
append("left", "right")
`,
  );
  const resolved = resolveDucklangModule(parsed);
  assertEquals(resolved.bindings[0].value, {
    kind: "primitive",
    primitiveId: PrimitiveId.bufferAppend,
    span: resolved.bindings[0].value.span,
  });

  const typed = inferDucklangModule(resolved);
  assertEquals(formatDucklangType(typed.resultType), "text");
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

function assertThrows(operation: () => unknown, expected: RegExp): void {
  try {
    operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expected.test(message)) {
      throw new Error(
        `expected ${expected}, received ${JSON.stringify(message)}`,
      );
    }
    return;
  }
  throw new Error(`expected rejection matching ${expected}`);
}

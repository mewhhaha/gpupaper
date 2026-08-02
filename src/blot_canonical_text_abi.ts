import type { BlotAbiManifest, BlotAbiType } from "./blot_runtime_abi.ts";
import { flattenedAbiType } from "./blot_runtime_abi.ts";
import type {
  BlotRuntimeFunction,
  BlotRuntimeModule,
  BlotRuntimeOperation,
} from "./blot_runtime_hir.ts";
import { addBlotAbiModuleShell } from "./ducklang_core_wasm.ts";
import {
  emitWasmPlanOnCpu,
  type WasmBinaryPlan,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./wasm.ts";

export type BlotCanonicalTextAbiArtifact = {
  readonly wasmPlan: WasmBinaryPlan;
  readonly wasm: Uint8Array;
};

type ValueLocals = ReadonlyMap<number, readonly number[]>;

export function supportsBlotCanonicalTextAbi(
  module: BlotRuntimeModule,
  manifest: BlotAbiManifest,
): boolean {
  const admittedTypes = new Set(["unit", "boolean", "integer-32", "text"]);
  if (
    module.types.some((type) =>
      admittedTypes.has(type.kind) ? false : type.kind !== "sum" ||
        type.cases.some((case_) =>
          module.types[case_.payloadType].kind !== "unit"
        )
    )
  ) return false;
  for (const exported of manifest.exports) {
    if (exported.function === null) continue;
    if (exported.function.parameters.length !== 0) return false;
    if (exported.function.result.kind !== "unit") return false;
  }
  for (const imported of manifest.imports) {
    if (
      imported.function.parameters.some((type) => !admittedAbiType(type)) ||
      !admittedAbiType(imported.function.result)
    ) return false;
  }
  for (const function_ of module.functions) {
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (!admittedOperation(operation)) return false;
      }
    }
  }
  return true;
}

export function compileBlotCanonicalTextAbi(
  module: BlotRuntimeModule,
  manifest: BlotAbiManifest,
  manifestBytes: Uint8Array,
): BlotCanonicalTextAbiArtifact {
  if (!supportsBlotCanonicalTextAbi(module, manifest)) {
    throw new TypeError(
      `${module.source}: module is outside the canonical Unit/Bool/I32/Text calculus`,
    );
  }
  const encoder = new TextEncoder();
  const literals = collectTextLiterals(module).map((value) => ({
    value,
    contents: encoder.encode(value),
  }));
  let staticEnd = 1_024;
  const literalLocations = new Map<
    string,
    { pointer: number; length: number }
  >();
  for (const literal of literals) {
    const pointer = literal.contents.byteLength === 0 ? 0 : staticEnd;
    literalLocations.set(literal.value, {
      pointer,
      length: literal.contents.byteLength,
    });
    staticEnd += literal.contents.byteLength;
  }
  const heapStart = alignTo(staticEnd, 8);
  const builder = new WasmModuleBuilder();
  const importedFunctions = new Map<string, number>();
  for (const imported of manifest.imports) {
    const parameters = imported.function.parameters.flatMap(flattenedAbiType);
    const results = flattenedAbiType(imported.function.result);
    if (results.length > 1) parameters.push("i32");
    const type = builder.addFunctionType(
      parameters.map(flatWasmType),
      results.length <= 1 ? results.map(flatWasmType) : [],
    );
    importedFunctions.set(
      importKey(imported.capability, imported.operation),
      builder.addFunctionImport(imported.module, imported.name, type),
    );
  }
  const shell = addBlotAbiModuleShell(
    builder,
    manifestBytes,
    heapStart,
    Math.max(1, Math.ceil(heapStart / 65_536)),
  );
  for (const literal of literals) {
    const location = literalLocations.get(literal.value)!;
    if (location.length > 0) {
      builder.addActiveData(0, location.pointer, literal.contents);
    }
  }
  const requireContinuation = addUtf8Continuation(builder);
  const validateText = addUtf8Validator(builder, requireContinuation);
  const compareText = addTextComparison(builder);
  const activeExport = builder.addI32Global(wasmType.i32, 0, true);

  const functionIndices = new Map<number, number>();
  const runtimeExports = module.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  const exportedFunctions = new Set(
    runtimeExports.map((exported) => exported.function),
  );
  for (const function_ of module.functions) {
    if (!exportedFunctions.has(function_.id)) {
      throw new TypeError(
        `${module.source}: canonical text calculus does not admit non-exported runtime function ${function_.name}`,
      );
    }
    const signature = module.signatures[function_.signature];
    if (
      signature.parameters.length !== 0 ||
      module.types[signature.result].kind !== "unit"
    ) {
      throw new TypeError(
        `${module.source}: canonical text export ${function_.name} must have type Unit -> Unit`,
      );
    }
    const layout = planValueLocals(module, function_);
    const checkpointLocal = layout.locals.length;
    const resultHeaderLocal = checkpointLocal + 1;
    const dispatchLocal = resultHeaderLocal + 1;
    const locals = [
      ...layout.locals,
      wasmType.i32,
      wasmType.i32,
      wasmType.i32,
    ];
    const type = builder.addFunctionType([], []);
    const instructions = emitFunction(
      module,
      function_,
      layout.values,
      checkpointLocal,
      resultHeaderLocal,
      dispatchLocal,
      shell,
      activeExport,
      function_.id + 1,
      importedFunctions,
      literalLocations,
      validateText,
      compareText,
    );
    functionIndices.set(
      function_.id,
      builder.addFunction(type, locals, instructions),
    );
  }
  for (const exported of runtimeExports) {
    const functionIndex = functionIndices.get(exported.function);
    if (functionIndex === undefined) {
      throw new Error(
        `${module.source}: canonical text emitter omitted function ${exported.function}`,
      );
    }
    builder.exportFunction(exported.wasmName, functionIndex);
  }
  const wasmPlan = builder.finishPlan();
  const wasm = emitWasmPlanOnCpu(wasmPlan);
  new WebAssembly.Module(wasm as BufferSource);
  return { wasmPlan, wasm };
}

function emitFunction(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  values: ValueLocals,
  checkpointLocal: number,
  resultHeaderLocal: number,
  dispatchLocal: number,
  shell: { readonly realloc: number; readonly heap: number },
  activeExport: number,
  callId: number,
  importedFunctions: ReadonlyMap<string, number>,
  literals: ReadonlyMap<
    string,
    { readonly pointer: number; readonly length: number }
  >,
  validateText: number,
  compareText: number,
): readonly WasmInstruction[] {
  const instructions: WasmInstruction[] = [
    ...wasmInstruction.globalGet(activeExport),
    ...wasmInstruction.i32EqualZero,
    ...wasmInstruction.i32EqualZero,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.unreachable,
    ...wasmInstruction.end,
    ...wasmInstruction.globalGet(shell.heap),
    ...wasmInstruction.localSet(checkpointLocal),
    ...wasmInstruction.i32Constant(callId),
    ...wasmInstruction.globalSet(activeExport),
    ...wasmInstruction.i32Constant(function_.entryBlock),
    ...wasmInstruction.localSet(dispatchLocal),
    ...wasmInstruction.loopVoid,
  ];
  for (const block of function_.blocks) {
    instructions.push(
      ...wasmInstruction.localGet(dispatchLocal),
      ...wasmInstruction.i32Constant(block.id),
      ...wasmInstruction.i32Equal,
      ...wasmInstruction.ifVoid,
    );
    for (const operation of block.operations) {
      instructions.push(...emitOperation(
        module,
        function_,
        operation,
        values,
        resultHeaderLocal,
        shell.realloc,
        importedFunctions,
        literals,
        validateText,
        compareText,
      ));
    }
    instructions.push(...emitTerminator(
      module,
      function_,
      block.terminator,
      values,
      dispatchLocal,
      checkpointLocal,
      shell.heap,
      activeExport,
    ));
    instructions.push(...wasmInstruction.end);
  }
  instructions.push(
    ...wasmInstruction.unreachable,
    ...wasmInstruction.end,
    ...wasmInstruction.unreachable,
  );
  return instructions;
}

function emitOperation(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  operation: BlotRuntimeOperation,
  values: ValueLocals,
  resultHeaderLocal: number,
  realloc: number,
  importedFunctions: ReadonlyMap<string, number>,
  literals: ReadonlyMap<
    string,
    { readonly pointer: number; readonly length: number }
  >,
  validateText: number,
  compareText: number,
): readonly WasmInstruction[] {
  const result = requiredLocals(values, function_, operation.result);
  if (operation.kind === "constant") {
    if (typeof operation.value === "string") {
      const literal = literals.get(operation.value);
      if (literal === undefined || result.length !== 2) {
        throw new Error(
          `${module.source}: canonical text constant has no layout`,
        );
      }
      return [
        ...wasmInstruction.i32Constant(literal.pointer),
        ...wasmInstruction.localSet(result[0]),
        ...wasmInstruction.i32Constant(literal.length),
        ...wasmInstruction.localSet(result[1]),
      ];
    }
    const encoded = operation.value === null
      ? 0
      : typeof operation.value === "boolean"
      ? operation.value ? 1 : 0
      : typeof operation.value === "bigint"
      ? Number(operation.value)
      : operation.value;
    if (!Number.isSafeInteger(encoded) || result.length !== 1) {
      throw new TypeError(
        `${module.source}: invalid canonical scalar constant`,
      );
    }
    return [
      ...wasmInstruction.i32Constant(encoded),
      ...wasmInstruction.localSet(result[0]),
    ];
  }
  if (operation.kind === "scalar") {
    const left = requiredScalarLocal(values, function_, operation.operands[0]);
    const right = requiredScalarLocal(values, function_, operation.operands[1]);
    const instruction = scalarInstruction(operation.operator);
    return [
      ...wasmInstruction.localGet(left),
      ...wasmInstruction.localGet(right),
      ...instruction,
      ...wasmInstruction.localSet(result[0]),
    ];
  }
  if (operation.kind === "text.compare") {
    const left = requiredTextLocals(values, function_, operation.operands[0]);
    const right = requiredTextLocals(values, function_, operation.operands[1]);
    return [
      ...wasmInstruction.localGet(left[0]),
      ...wasmInstruction.localGet(left[1]),
      ...wasmInstruction.localGet(right[0]),
      ...wasmInstruction.localGet(right[1]),
      ...wasmInstruction.call(compareText),
      ...wasmInstruction.localSet(result[0]),
    ];
  }
  if (operation.kind === "text.append") {
    const left = requiredTextLocals(values, function_, operation.operands[0]);
    const right = requiredTextLocals(values, function_, operation.operands[1]);
    return [
      ...wasmInstruction.localGet(left[1]),
      ...wasmInstruction.localGet(right[1]),
      ...wasmInstruction.i32Add,
      ...wasmInstruction.localTee(result[1]),
      ...wasmInstruction.localGet(left[1]),
      ...wasmInstruction.i32LessThanUnsigned,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.unreachable,
      ...wasmInstruction.end,
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.i32Constant(1),
      ...wasmInstruction.localGet(result[1]),
      ...wasmInstruction.call(realloc),
      ...wasmInstruction.localSet(result[0]),
      ...wasmInstruction.localGet(result[0]),
      ...wasmInstruction.localGet(left[0]),
      ...wasmInstruction.localGet(left[1]),
      ...wasmInstruction.memoryCopy,
      ...wasmInstruction.localGet(result[0]),
      ...wasmInstruction.localGet(left[1]),
      ...wasmInstruction.i32Add,
      ...wasmInstruction.localGet(right[0]),
      ...wasmInstruction.localGet(right[1]),
      ...wasmInstruction.memoryCopy,
    ];
  }
  if (operation.kind === "host.call") {
    const imported = importedFunctions.get(
      importKey(operation.capability, operation.operation),
    );
    if (imported === undefined) {
      throw new Error(
        `${module.source}: manifest omitted ${operation.capability}.${operation.operation}`,
      );
    }
    const argument = operation.operands[0];
    const argumentType = module.types[valueType(module, function_, argument)];
    const argumentInstructions = argumentType.kind === "unit"
      ? []
      : requiredTextLocals(values, function_, argument).flatMap((local) =>
        wasmInstruction.localGet(local)
      );
    const resultType = module.types[operation.type];
    if (resultType.kind === "unit") {
      return [
        ...argumentInstructions,
        ...wasmInstruction.call(imported),
        ...wasmInstruction.i32Constant(0),
        ...wasmInstruction.localSet(result[0]),
      ];
    }
    if (resultType.kind !== "text") {
      throw new TypeError(
        `${module.source}: unsupported canonical host result`,
      );
    }
    return [
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.i32Constant(4),
      ...wasmInstruction.i32Constant(8),
      ...wasmInstruction.call(realloc),
      ...wasmInstruction.localTee(resultHeaderLocal),
      ...wasmInstruction.call(imported),
      ...wasmInstruction.localGet(resultHeaderLocal),
      ...wasmInstruction.i32Load(),
      ...wasmInstruction.localSet(result[0]),
      ...wasmInstruction.localGet(resultHeaderLocal),
      ...wasmInstruction.i32Load(2, 4),
      ...wasmInstruction.localSet(result[1]),
      ...wasmInstruction.localGet(result[0]),
      ...wasmInstruction.localGet(result[1]),
      ...wasmInstruction.call(validateText),
    ];
  }
  if (
    operation.kind === "sum.make" || operation.kind === "sum.tag" ||
    operation.kind === "sum.payload"
  ) {
    const instructions = operation.kind === "sum.tag"
      ? wasmInstruction.localGet(
        requiredScalarLocal(values, function_, operation.operands[0]),
      )
      : wasmInstruction.i32Constant(
        operation.kind === "sum.make" ? operation.case : 0,
      );
    return [
      ...instructions,
      ...wasmInstruction.localSet(result[0]),
    ];
  }
  throw new TypeError(
    `${module.source}:${operation.span.start}: ${operation.kind} escaped canonical text admission`,
  );
}

function emitTerminator(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  terminator: BlotRuntimeFunction["blocks"][number]["terminator"],
  values: ValueLocals,
  dispatchLocal: number,
  checkpointLocal: number,
  heap: number,
  activeExport: number,
): readonly WasmInstruction[] {
  const finish = [
    ...wasmInstruction.localGet(checkpointLocal),
    ...wasmInstruction.globalSet(heap),
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.globalSet(activeExport),
    ...wasmInstruction.return,
  ];
  if (terminator.kind === "return") return finish;
  if (terminator.kind === "trap") return wasmInstruction.unreachable;
  const branch = (
    target: number,
    arguments_: readonly number[],
    depth: number,
  ): readonly WasmInstruction[] => {
    const parameters = function_.blocks[target].parameters;
    const sourceLocals = arguments_.flatMap((argument) =>
      requiredLocals(values, function_, argument)
    );
    const targetLocals = parameters.flatMap((parameter) =>
      requiredLocals(values, function_, parameter.value)
    );
    if (sourceLocals.length !== targetLocals.length) {
      throw new Error(
        `${module.source}: branch ${function_.name} -> block ${target} changes flattened arity`,
      );
    }
    return [
      ...sourceLocals.flatMap((local) => wasmInstruction.localGet(local)),
      ...[...targetLocals].reverse().flatMap((local) =>
        wasmInstruction.localSet(local)
      ),
      ...wasmInstruction.i32Constant(target),
      ...wasmInstruction.localSet(dispatchLocal),
      ...wasmInstruction.branch(depth),
    ];
  };
  if (terminator.kind === "branch") {
    return branch(terminator.target, terminator.arguments, 1);
  }
  return [
    ...wasmInstruction.localGet(
      requiredScalarLocal(values, function_, terminator.condition),
    ),
    ...wasmInstruction.ifVoid,
    ...branch(terminator.consequent, terminator.consequentArguments, 2),
    ...wasmInstruction.else,
    ...branch(terminator.alternate, terminator.alternateArguments, 2),
    ...wasmInstruction.end,
  ];
}

function planValueLocals(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
): { readonly values: ValueLocals; readonly locals: readonly number[] } {
  const values = new Map<number, readonly number[]>();
  const locals: number[] = [];
  const assign = (value: number, type: number): void => {
    if (values.has(value)) return;
    const width = module.types[type].kind === "text" ? 2 : 1;
    const assigned: number[] = [];
    for (let index = 0; index < width; index += 1) {
      assigned.push(locals.length);
      locals.push(wasmType.i32);
    }
    values.set(value, assigned);
  };
  for (const block of function_.blocks) {
    for (const parameter of block.parameters) {
      assign(parameter.value, parameter.type);
    }
    for (const operation of block.operations) {
      assign(operation.result, operation.type);
    }
  }
  return { values, locals };
}

function addUtf8Continuation(builder: WasmModuleBuilder): number {
  const type = builder.addFunctionType(
    [wasmType.i32, wasmType.i32, wasmType.i32, wasmType.i32],
    [wasmType.i32],
  );
  const byteLocal = 4;
  return builder.addFunction(type, [wasmType.i32], [
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.i32GreaterThanOrEqualUnsigned,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.i32Load8Unsigned(),
    ...wasmInstruction.localTee(byteLocal),
    ...wasmInstruction.localGet(2),
    ...wasmInstruction.i32LessThanUnsigned,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.localGet(3),
    ...wasmInstruction.i32GreaterThanUnsigned,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Add,
  ]);
}

function addUtf8Validator(
  builder: WasmModuleBuilder,
  continuation: number,
): number {
  const type = builder.addFunctionType([wasmType.i32, wasmType.i32], []);
  const endLocal = 2;
  const indexLocal = 3;
  const byteLocal = 4;
  const advance = (
    minimum: number,
    maximum: number,
  ): readonly WasmInstruction[] => [
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.localGet(endLocal),
    ...wasmInstruction.i32Constant(minimum),
    ...wasmInstruction.i32Constant(maximum),
    ...wasmInstruction.call(continuation),
    ...wasmInstruction.localSet(indexLocal),
  ];
  return builder.addFunction(type, [wasmType.i32, wasmType.i32, wasmType.i32], [
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.i32EqualZero,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.return,
    ...wasmInstruction.end,
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.i32EqualZero,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localTee(endLocal),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.i32LessThanUnsigned,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(endLocal),
    ...wasmInstruction.memorySize,
    ...wasmInstruction.i32Constant(16),
    ...wasmInstruction.i32ShiftLeft,
    ...wasmInstruction.i32GreaterThanUnsigned,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.localSet(indexLocal),
    ...wasmInstruction.blockVoid,
    ...wasmInstruction.loopVoid,
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.localGet(endLocal),
    ...wasmInstruction.i32GreaterThanOrEqualUnsigned,
    ...wasmInstruction.branchIf(1),
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.i32Load8Unsigned(),
    ...wasmInstruction.localTee(byteLocal),
    ...wasmInstruction.i32Constant(128),
    ...wasmInstruction.i32LessThanUnsigned,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localSet(indexLocal),
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(194),
    ...wasmInstruction.i32LessThanUnsigned,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localSet(indexLocal),
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(224),
    ...wasmInstruction.i32LessThanUnsigned,
    ...wasmInstruction.ifVoid,
    ...advance(128, 191),
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(240),
    ...wasmInstruction.i32LessThanUnsigned,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(224),
    ...wasmInstruction.i32Equal,
    ...wasmInstruction.ifVoid,
    ...advance(160, 191),
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(237),
    ...wasmInstruction.i32Equal,
    ...wasmInstruction.ifVoid,
    ...advance(128, 159),
    ...wasmInstruction.else,
    ...advance(128, 191),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
    ...advance(128, 191),
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(244),
    ...wasmInstruction.i32GreaterThanUnsigned,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(240),
    ...wasmInstruction.i32Equal,
    ...wasmInstruction.ifVoid,
    ...advance(144, 191),
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(byteLocal),
    ...wasmInstruction.i32Constant(244),
    ...wasmInstruction.i32Equal,
    ...wasmInstruction.ifVoid,
    ...advance(128, 143),
    ...wasmInstruction.else,
    ...advance(128, 191),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
    ...advance(128, 191),
    ...advance(128, 191),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
    ...wasmInstruction.end,
    ...wasmInstruction.branch(0),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
  ]);
}

function addTextComparison(builder: WasmModuleBuilder): number {
  const type = builder.addFunctionType(
    [wasmType.i32, wasmType.i32, wasmType.i32, wasmType.i32],
    [wasmType.i32],
  );
  const indexLocal = 4;
  const limitLocal = 5;
  const leftByteLocal = 6;
  const rightByteLocal = 7;
  return builder.addFunction(type, [
    wasmType.i32,
    wasmType.i32,
    wasmType.i32,
    wasmType.i32,
  ], [
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.localGet(3),
    ...wasmInstruction.i32LessThanUnsigned,
    ...wasmInstruction.ifI32,
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(3),
    ...wasmInstruction.end,
    ...wasmInstruction.localSet(limitLocal),
    ...wasmInstruction.blockVoid,
    ...wasmInstruction.loopVoid,
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.localGet(limitLocal),
    ...wasmInstruction.i32GreaterThanOrEqualUnsigned,
    ...wasmInstruction.branchIf(1),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.i32Load8Unsigned(),
    ...wasmInstruction.localSet(leftByteLocal),
    ...wasmInstruction.localGet(2),
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.i32Load8Unsigned(),
    ...wasmInstruction.localSet(rightByteLocal),
    ...wasmInstruction.localGet(leftByteLocal),
    ...wasmInstruction.localGet(rightByteLocal),
    ...wasmInstruction.i32LessThanUnsigned,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.i32Constant(-1),
    ...wasmInstruction.return,
    ...wasmInstruction.end,
    ...wasmInstruction.localGet(leftByteLocal),
    ...wasmInstruction.localGet(rightByteLocal),
    ...wasmInstruction.i32GreaterThanUnsigned,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.return,
    ...wasmInstruction.end,
    ...wasmInstruction.localGet(indexLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localSet(indexLocal),
    ...wasmInstruction.branch(0),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.localGet(3),
    ...wasmInstruction.i32LessThanUnsigned,
    ...wasmInstruction.ifI32,
    ...wasmInstruction.i32Constant(-1),
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(1),
    ...wasmInstruction.localGet(3),
    ...wasmInstruction.i32GreaterThanUnsigned,
    ...wasmInstruction.ifI32,
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.else,
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
  ]);
}

function admittedOperation(operation: BlotRuntimeOperation): boolean {
  return operation.kind === "constant" || operation.kind === "scalar" ||
    operation.kind === "text.append" || operation.kind === "text.compare" ||
    operation.kind === "host.call" || operation.kind === "sum.make" ||
    operation.kind === "sum.tag" || operation.kind === "sum.payload";
}

function admittedAbiType(type: BlotAbiType): boolean {
  return type.kind === "unit" || type.kind === "text";
}

function collectTextLiterals(module: BlotRuntimeModule): readonly string[] {
  const literals = new Set<string>();
  for (const function_ of module.functions) {
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (
          operation.kind === "constant" && typeof operation.value === "string"
        ) {
          literals.add(operation.value);
        }
      }
    }
  }
  return [...literals].sort();
}

function valueType(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  value: number,
): number {
  for (const block of function_.blocks) {
    const parameter = block.parameters.find((candidate) =>
      candidate.value === value
    );
    if (parameter !== undefined) return parameter.type;
    const operation = block.operations.find((candidate) =>
      candidate.result === value
    );
    if (operation !== undefined) return operation.type;
  }
  throw new Error(
    `${module.source}: function ${function_.name} has no value ${value}`,
  );
}

function requiredLocals(
  values: ValueLocals,
  function_: BlotRuntimeFunction,
  value: number,
): readonly number[] {
  const locals = values.get(value);
  if (locals === undefined) {
    throw new Error(`${function_.name} has no local layout for value ${value}`);
  }
  return locals;
}

function requiredScalarLocal(
  values: ValueLocals,
  function_: BlotRuntimeFunction,
  value: number,
): number {
  const locals = requiredLocals(values, function_, value);
  if (locals.length !== 1) {
    throw new Error(`${function_.name} value ${value} is not scalar`);
  }
  return locals[0];
}

function requiredTextLocals(
  values: ValueLocals,
  function_: BlotRuntimeFunction,
  value: number,
): readonly [number, number] {
  const locals = requiredLocals(values, function_, value);
  if (locals.length !== 2) {
    throw new Error(`${function_.name} value ${value} is not text`);
  }
  return [locals[0], locals[1]];
}

function scalarInstruction(
  operator: Extract<BlotRuntimeOperation, { kind: "scalar" }>["operator"],
): readonly WasmInstruction[] {
  const instructions = {
    add: wasmInstruction.i32Add,
    subtract: wasmInstruction.i32Subtract,
    multiply: wasmInstruction.i32Multiply,
    divide: wasmInstruction.i32DivideSigned,
    remainder: wasmInstruction.i32RemainderSigned,
    equal: wasmInstruction.i32Equal,
    "not-equal": wasmInstruction.i32NotEqual,
    "less-than": wasmInstruction.i32LessThanSigned,
    "less-than-or-equal": wasmInstruction.i32LessThanOrEqualSigned,
    "greater-than": wasmInstruction.i32GreaterThanSigned,
    "greater-than-or-equal": wasmInstruction.i32GreaterThanOrEqualSigned,
  } as const;
  return instructions[operator];
}

function trapIfTrue(): readonly WasmInstruction[] {
  return [
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.unreachable,
    ...wasmInstruction.end,
  ];
}

function importKey(capability: string, operation: string): string {
  return `${capability}.${operation}`;
}

function flatWasmType(type: "i32" | "i64" | "f32" | "f64"): number {
  return {
    i32: wasmType.i32,
    i64: wasmType.i64,
    f32: wasmType.f32,
    f64: wasmType.f64,
  }[type];
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

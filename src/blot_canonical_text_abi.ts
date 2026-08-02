import type {
  BlotAbiFunction,
  BlotAbiManifest,
  BlotAbiType,
} from "./blot_runtime_abi.ts";
import { flattenedAbiType } from "./blot_runtime_abi.ts";
import type {
  BlotRuntimeFunction,
  BlotRuntimeModule,
  BlotRuntimeOperation,
  BlotRuntimeType,
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
  const admittedTypes = new Set([
    "unit",
    "boolean",
    "integer-32",
    "signed-integer-64",
    "text",
    "product",
  ]);
  if (
    module.types.some((type) =>
      !admittedTypes.has(type.kind) &&
      (type.kind !== "sum" ||
        type.cases.some((case_) =>
          module.types[case_.payloadType].kind !== "unit"
        ))
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
  const importedFunctions = new Map<
    string,
    { readonly index: number; readonly function: BlotAbiFunction }
  >();
  for (const imported of manifest.imports) {
    let parameters = imported.function.parameters.flatMap(flattenedAbiType);
    if (parameters.length > manifest.abi.maximumFlatParameters) {
      parameters = ["i32"];
    }
    const results = flattenedAbiType(imported.function.result);
    if (results.length > 1) parameters.push("i32");
    const type = builder.addFunctionType(
      parameters.map(flatWasmType),
      results.length <= 1 ? results.map(flatWasmType) : [],
    );
    importedFunctions.set(importKey(imported.capability, imported.operation), {
      index: builder.addFunctionImport(imported.module, imported.name, type),
      function: imported.function,
    });
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
  const formatI64 = addI64TextFormatter(builder, shell.realloc);
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
        `${module.source}: canonical first-order calculus does not admit non-exported runtime function ${function_.name}`,
      );
    }
    const signature = module.signatures[function_.signature];
    if (
      signature.parameters.length !== 0 ||
      module.types[signature.result].kind !== "unit"
    ) {
      throw new TypeError(
        `${module.source}: canonical first-order export ${function_.name} must have type Unit -> Unit`,
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
      formatI64,
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
  importedFunctions: ReadonlyMap<
    string,
    { readonly index: number; readonly function: BlotAbiFunction }
  >,
  literals: ReadonlyMap<
    string,
    { readonly pointer: number; readonly length: number }
  >,
  validateText: number,
  compareText: number,
  formatI64: number,
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
        formatI64,
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
  importedFunctions: ReadonlyMap<
    string,
    { readonly index: number; readonly function: BlotAbiFunction }
  >,
  literals: ReadonlyMap<
    string,
    { readonly pointer: number; readonly length: number }
  >,
  validateText: number,
  compareText: number,
  formatI64: number,
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
    if (typeof operation.value === "bigint") {
      if (result.length !== 1) {
        throw new TypeError(
          `${module.source}: invalid canonical i64 constant layout`,
        );
      }
      return [
        ...wasmInstruction.i64Constant(operation.value),
        ...wasmInstruction.localSet(result[0]),
      ];
    }
    let encoded: number;
    if (operation.value === null) encoded = 0;
    else if (typeof operation.value === "boolean") {
      encoded = operation.value ? 1 : 0;
    } else encoded = operation.value;
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
    const operandType = module.types[
      valueType(module, function_, operation.operands[0])
    ];
    if (
      operandType.kind === "signed-integer-64" &&
      (operation.operator === "add" || operation.operator === "subtract" ||
        operation.operator === "multiply")
    ) {
      return checkedI64ScalarInstructions(
        operation.operator,
        left,
        right,
        result[0],
      );
    }
    const instruction = scalarInstruction(operation.operator, operandType.kind);
    return [
      ...wasmInstruction.localGet(left),
      ...wasmInstruction.localGet(right),
      ...instruction,
      ...wasmInstruction.localSet(result[0]),
    ];
  }
  if (operation.kind === "product.make") {
    const type = module.types[operation.type];
    if (type.kind !== "product") {
      throw new TypeError(
        `${module.source}: product.make has non-product type`,
      );
    }
    const instructions: WasmInstruction[] = [];
    let resultOffset = 0;
    for (const field of [...type.fields].sort(byName)) {
      const sourceIndex = type.fields.findIndex((candidate) =>
        candidate.name === field.name
      );
      const operand = operation.operands[sourceIndex];
      const source = requiredLocals(values, function_, operand);
      for (const local of source) {
        instructions.push(
          ...wasmInstruction.localGet(local),
          ...wasmInstruction.localSet(result[resultOffset]),
        );
        resultOffset += 1;
      }
    }
    return instructions;
  }
  if (operation.kind === "product.project") {
    const operand = operation.operands[0];
    const sourceType = module.types[valueType(module, function_, operand)];
    if (sourceType.kind !== "product") {
      throw new TypeError(
        `${module.source}: product.project has non-product operand`,
      );
    }
    const field = sourceType.fields[operation.field];
    if (field === undefined) {
      throw new TypeError(
        `${module.source}: product.project field ${operation.field} is absent`,
      );
    }
    const source = productFieldLocals(
      module,
      sourceType,
      requiredLocals(values, function_, operand),
      field.name,
    );
    return source.flatMap((local, index) => [
      ...wasmInstruction.localGet(local),
      ...wasmInstruction.localSet(result[index]),
    ]);
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
  if (operation.kind === "text.from-i64") {
    const value = requiredScalarLocal(
      values,
      function_,
      operation.operands[0],
    );
    return [
      ...wasmInstruction.localGet(value),
      ...wasmInstruction.call(formatI64),
      ...wasmInstruction.localSet(result[1]),
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
    const argumentType = imported.function.parameters[0];
    if (argumentType === undefined) {
      throw new Error(
        `${module.source}: ${operation.capability}.${operation.operation} omitted its argument type`,
      );
    }
    const argumentLocals = requiredLocals(values, function_, argument);
    const flatArgument = flattenedAbiType(argumentType);
    let argumentInstructions: readonly WasmInstruction[];
    if (flatArgument.length === 0) argumentInstructions = [];
    else if (flatArgument.length <= 16) {
      argumentInstructions = argumentLocals.flatMap((local) =>
        wasmInstruction.localGet(local)
      );
    } else {
      argumentInstructions = [
        ...allocateCanonicalValue(
          argumentType,
          argumentLocals,
          resultHeaderLocal,
          realloc,
        ),
        ...wasmInstruction.localGet(resultHeaderLocal),
      ];
    }
    const resultType = module.types[operation.type];
    if (resultType.kind === "unit") {
      return [
        ...argumentInstructions,
        ...wasmInstruction.call(imported.index),
        ...wasmInstruction.i32Constant(0),
        ...wasmInstruction.localSet(result[0]),
      ];
    }
    const flatResult = flattenedAbiType(imported.function.result);
    if (flatResult.length === 1) {
      const instructions: WasmInstruction[] = [
        ...argumentInstructions,
        ...wasmInstruction.call(imported.index),
      ];
      if (imported.function.result.kind === "boolean") {
        instructions.push(
          ...wasmInstruction.localTee(result[0]),
          ...wasmInstruction.i32Constant(1),
          ...wasmInstruction.i32GreaterThanUnsigned,
          ...trapIfTrue(),
        );
      } else instructions.push(...wasmInstruction.localSet(result[0]));
      return instructions;
    }
    const resultLayout = memoryLayout(imported.function.result);
    return [
      ...argumentInstructions,
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.i32Constant(resultLayout.alignment),
      ...wasmInstruction.i32Constant(resultLayout.size),
      ...wasmInstruction.call(realloc),
      ...wasmInstruction.localTee(resultHeaderLocal),
      ...wasmInstruction.call(imported.index),
      ...loadCanonicalValue(
        imported.function.result,
        result,
        resultHeaderLocal,
        validateText,
      ),
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
    const assigned: number[] = [];
    for (const localType of runtimeLocalTypes(module, type)) {
      assigned.push(locals.length);
      locals.push(flatWasmType(localType));
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

function runtimeLocalTypes(
  module: BlotRuntimeModule,
  typeId: number,
): readonly ("i32" | "i64")[] {
  const type = module.types[typeId];
  if (
    type.kind === "unit" || type.kind === "boolean" ||
    type.kind === "integer-32" || type.kind === "sum"
  ) return ["i32"];
  if (type.kind === "signed-integer-64") return ["i64"];
  if (type.kind === "text") return ["i32", "i32"];
  if (type.kind === "product") {
    return [...type.fields].sort(byName).flatMap((field) =>
      runtimeLocalTypes(module, field.type)
    );
  }
  throw new TypeError(
    `${module.source}: ${type.kind} has no canonical first-order local layout`,
  );
}

function productFieldLocals(
  module: BlotRuntimeModule,
  type: Extract<BlotRuntimeType, { readonly kind: "product" }>,
  locals: readonly number[],
  name: string,
): readonly number[] {
  let offset = 0;
  for (const field of [...type.fields].sort(byName)) {
    const width = runtimeLocalTypes(module, field.type).length;
    if (field.name === name) return locals.slice(offset, offset + width);
    offset += width;
  }
  throw new Error(
    `${module.source}: product ${type.name} has no field ${name}`,
  );
}

function allocateCanonicalValue(
  type: BlotAbiType,
  locals: readonly number[],
  pointerLocal: number,
  realloc: number,
): readonly WasmInstruction[] {
  const layout = memoryLayout(type);
  return [
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.i32Constant(layout.alignment),
    ...wasmInstruction.i32Constant(layout.size),
    ...wasmInstruction.call(realloc),
    ...wasmInstruction.localSet(pointerLocal),
    ...storeCanonicalValue(type, locals, pointerLocal, 0).instructions,
  ];
}

function storeCanonicalValue(
  type: BlotAbiType,
  locals: readonly number[],
  pointerLocal: number,
  offset: number,
): {
  readonly instructions: readonly WasmInstruction[];
  readonly used: number;
} {
  if (type.kind === "unit") return { instructions: [], used: 0 };
  if (type.kind === "boolean") {
    return {
      instructions: [
        ...wasmInstruction.localGet(pointerLocal),
        ...wasmInstruction.localGet(locals[0]),
        ...wasmInstruction.i32Store8(offset),
      ],
      used: 1,
    };
  }
  if (type.kind === "signed-integer-64") {
    return {
      instructions: [
        ...wasmInstruction.localGet(pointerLocal),
        ...wasmInstruction.localGet(locals[0]),
        ...wasmInstruction.i64Store(3, offset),
      ],
      used: 1,
    };
  }
  if (type.kind === "text") {
    return {
      instructions: [
        ...wasmInstruction.localGet(pointerLocal),
        ...wasmInstruction.localGet(locals[0]),
        ...wasmInstruction.i32Store(2, offset),
        ...wasmInstruction.localGet(pointerLocal),
        ...wasmInstruction.localGet(locals[1]),
        ...wasmInstruction.i32Store(2, offset + 4),
      ],
      used: 2,
    };
  }
  if (type.kind === "record") {
    const instructions: WasmInstruction[] = [];
    let used = 0;
    for (const field of recordLayout(type)) {
      const stored = storeCanonicalValue(
        field.type,
        locals.slice(used),
        pointerLocal,
        offset + field.offset,
      );
      instructions.push(...stored.instructions);
      used += stored.used;
    }
    return { instructions, used };
  }
  throw new TypeError(`canonical ${type.kind} argument is not admitted`);
}

function loadCanonicalValue(
  type: BlotAbiType,
  locals: readonly number[],
  pointerLocal: number,
  validateText: number,
  offset = 0,
): readonly WasmInstruction[] {
  if (type.kind === "unit") return [];
  if (type.kind === "boolean") {
    return [
      ...wasmInstruction.localGet(pointerLocal),
      ...wasmInstruction.i32Load8Unsigned(offset),
      ...wasmInstruction.localTee(locals[0]),
      ...wasmInstruction.i32Constant(1),
      ...wasmInstruction.i32GreaterThanUnsigned,
      ...trapIfTrue(),
    ];
  }
  if (type.kind === "signed-integer-64") {
    return [
      ...wasmInstruction.localGet(pointerLocal),
      ...wasmInstruction.i64Load(3, offset),
      ...wasmInstruction.localSet(locals[0]),
    ];
  }
  if (type.kind === "text") {
    return [
      ...wasmInstruction.localGet(pointerLocal),
      ...wasmInstruction.i32Load(2, offset),
      ...wasmInstruction.localSet(locals[0]),
      ...wasmInstruction.localGet(pointerLocal),
      ...wasmInstruction.i32Load(2, offset + 4),
      ...wasmInstruction.localSet(locals[1]),
      ...wasmInstruction.localGet(locals[0]),
      ...wasmInstruction.localGet(locals[1]),
      ...wasmInstruction.call(validateText),
    ];
  }
  if (type.kind === "record") {
    const instructions: WasmInstruction[] = [];
    let used = 0;
    for (const field of recordLayout(type)) {
      const width = flattenedAbiType(field.type).length;
      instructions.push(...loadCanonicalValue(
        field.type,
        locals.slice(used, used + width),
        pointerLocal,
        validateText,
        offset + field.offset,
      ));
      used += width;
    }
    return instructions;
  }
  throw new TypeError(`canonical ${type.kind} result is not admitted`);
}

function memoryLayout(type: BlotAbiType): { alignment: number; size: number } {
  if (type.kind === "unit") return { alignment: 1, size: 0 };
  if (type.kind === "boolean") return { alignment: 1, size: 1 };
  if (type.kind === "signed-integer-64") return { alignment: 8, size: 8 };
  if (type.kind === "text") return { alignment: 4, size: 8 };
  if (type.kind === "record") {
    const fields = recordLayout(type);
    const alignment = fields.reduce(
      (maximum, field) => Math.max(maximum, memoryLayout(field.type).alignment),
      1,
    );
    const end = fields.reduce(
      (maximum, field) =>
        Math.max(maximum, field.offset + memoryLayout(field.type).size),
      0,
    );
    return { alignment, size: alignTo(end, alignment) };
  }
  throw new TypeError(`canonical ${type.kind} memory layout is not admitted`);
}

function recordLayout(type: Extract<BlotAbiType, { kind: "record" }>) {
  let offset = 0;
  return [...type.fields].sort(byName).map((field) => {
    const layout = memoryLayout(field.type);
    offset = alignTo(offset, layout.alignment);
    const result = { ...field, offset };
    offset += layout.size;
    return result;
  });
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

function addI64TextFormatter(
  builder: WasmModuleBuilder,
  realloc: number,
): number {
  const type = builder.addFunctionType([wasmType.i64], [
    wasmType.i32,
    wasmType.i32,
  ]);
  const bufferLocal = 1;
  const cursorLocal = 2;
  const remainderLocal = 3;
  const negativeLocal = 4;
  return builder.addFunction(type, [
    wasmType.i32,
    wasmType.i32,
    wasmType.i64,
    wasmType.i32,
  ], [
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.i64Constant(0n),
    ...wasmInstruction.i64LessThanSigned,
    ...wasmInstruction.localSet(negativeLocal),
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Constant(20),
    ...wasmInstruction.call(realloc),
    ...wasmInstruction.localSet(bufferLocal),
    ...wasmInstruction.i32Constant(20),
    ...wasmInstruction.localSet(cursorLocal),
    ...wasmInstruction.loopVoid,
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.i64Constant(10n),
    ...wasmInstruction.i64RemainderSigned,
    ...wasmInstruction.localSet(remainderLocal),
    ...wasmInstruction.localGet(cursorLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Subtract,
    ...wasmInstruction.localTee(cursorLocal),
    ...wasmInstruction.localGet(bufferLocal),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localGet(remainderLocal),
    ...wasmInstruction.i64Constant(0n),
    ...wasmInstruction.i64LessThanSigned,
    ...wasmInstruction.ifI64,
    ...wasmInstruction.i64Constant(0n),
    ...wasmInstruction.localGet(remainderLocal),
    ...wasmInstruction.i64Subtract,
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(remainderLocal),
    ...wasmInstruction.end,
    ...wasmInstruction.i32WrapI64,
    ...wasmInstruction.i32Constant(48),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.i32Store8(),
    ...wasmInstruction.localGet(0),
    ...wasmInstruction.i64Constant(10n),
    ...wasmInstruction.i64DivideSigned,
    ...wasmInstruction.localTee(0),
    ...wasmInstruction.i64Constant(0n),
    ...wasmInstruction.i64NotEqual,
    ...wasmInstruction.branchIf(0),
    ...wasmInstruction.end,
    ...wasmInstruction.localGet(negativeLocal),
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.localGet(cursorLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Subtract,
    ...wasmInstruction.localTee(cursorLocal),
    ...wasmInstruction.localGet(bufferLocal),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.i32Constant(45),
    ...wasmInstruction.i32Store8(),
    ...wasmInstruction.end,
    ...wasmInstruction.localGet(bufferLocal),
    ...wasmInstruction.localGet(cursorLocal),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.i32Constant(20),
    ...wasmInstruction.localGet(cursorLocal),
    ...wasmInstruction.i32Subtract,
  ]);
}

function admittedOperation(operation: BlotRuntimeOperation): boolean {
  return operation.kind === "constant" || operation.kind === "scalar" ||
    operation.kind === "text.append" || operation.kind === "text.compare" ||
    operation.kind === "host.call" || operation.kind === "sum.make" ||
    operation.kind === "sum.tag" || operation.kind === "sum.payload" ||
    operation.kind === "product.make" || operation.kind === "product.project" ||
    operation.kind === "text.from-i64";
}

function admittedAbiType(type: BlotAbiType): boolean {
  if (
    type.kind === "unit" || type.kind === "boolean" ||
    type.kind === "signed-integer-64" || type.kind === "text"
  ) return true;
  if (type.kind === "record") {
    return type.fields.every((field) => admittedAbiType(field.type));
  }
  return false;
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

function checkedI64ScalarInstructions(
  operator: "add" | "subtract" | "multiply",
  left: number,
  right: number,
  result: number,
): readonly WasmInstruction[] {
  const arithmetic = operator === "add"
    ? wasmInstruction.i64Add
    : operator === "subtract"
    ? wasmInstruction.i64Subtract
    : wasmInstruction.i64Multiply;
  const instructions: WasmInstruction[] = [
    ...wasmInstruction.localGet(left),
    ...wasmInstruction.localGet(right),
    ...arithmetic,
    ...wasmInstruction.localSet(result),
  ];
  if (operator === "add" || operator === "subtract") {
    if (operator === "add") {
      instructions.push(
        ...wasmInstruction.localGet(left),
        ...wasmInstruction.localGet(result),
      );
    } else {
      instructions.push(
        ...wasmInstruction.localGet(left),
        ...wasmInstruction.localGet(right),
      );
    }
    instructions.push(...wasmInstruction.i64Xor);
    if (operator === "add") {
      instructions.push(
        ...wasmInstruction.localGet(right),
        ...wasmInstruction.localGet(result),
      );
    } else {
      instructions.push(
        ...wasmInstruction.localGet(left),
        ...wasmInstruction.localGet(result),
      );
    }
    instructions.push(
      ...wasmInstruction.i64Xor,
      ...wasmInstruction.i64And,
      ...wasmInstruction.i64Constant(0n),
      ...wasmInstruction.i64LessThanSigned,
      ...trapIfTrue(),
    );
    return instructions;
  }

  instructions.push(
    ...wasmInstruction.localGet(right),
    ...wasmInstruction.i64Constant(0n),
    ...wasmInstruction.i64Equal,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.else,
    ...wasmInstruction.localGet(left),
    ...wasmInstruction.i64Constant(-(1n << 63n)),
    ...wasmInstruction.i64Equal,
    ...wasmInstruction.localGet(right),
    ...wasmInstruction.i64Constant(-1n),
    ...wasmInstruction.i64Equal,
    ...wasmInstruction.i32And,
    ...wasmInstruction.localGet(left),
    ...wasmInstruction.i64Constant(-1n),
    ...wasmInstruction.i64Equal,
    ...wasmInstruction.localGet(right),
    ...wasmInstruction.i64Constant(-(1n << 63n)),
    ...wasmInstruction.i64Equal,
    ...wasmInstruction.i32And,
    ...wasmInstruction.i32Or,
    ...trapIfTrue(),
    ...wasmInstruction.localGet(result),
    ...wasmInstruction.localGet(right),
    ...wasmInstruction.i64DivideSigned,
    ...wasmInstruction.localGet(left),
    ...wasmInstruction.i64NotEqual,
    ...trapIfTrue(),
    ...wasmInstruction.end,
  );
  return instructions;
}

function scalarInstruction(
  operator: Extract<BlotRuntimeOperation, { kind: "scalar" }>["operator"],
  type: BlotRuntimeType["kind"],
): readonly WasmInstruction[] {
  const i32Instructions = {
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
  if (type === "integer-32") return i32Instructions[operator];
  if (type !== "signed-integer-64") {
    throw new TypeError(`canonical scalar operation has ${type} operands`);
  }
  const i64Instructions = {
    add: wasmInstruction.i64Add,
    subtract: wasmInstruction.i64Subtract,
    multiply: wasmInstruction.i64Multiply,
    divide: wasmInstruction.i64DivideSigned,
    remainder: wasmInstruction.i64RemainderSigned,
    equal: wasmInstruction.i64Equal,
    "not-equal": wasmInstruction.i64NotEqual,
    "less-than": wasmInstruction.i64LessThanSigned,
    "less-than-or-equal": wasmInstruction.i64LessThanOrEqualSigned,
    "greater-than": wasmInstruction.i64GreaterThanSigned,
    "greater-than-or-equal": wasmInstruction.i64GreaterThanOrEqualSigned,
  } as const;
  return i64Instructions[operator];
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

function byName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

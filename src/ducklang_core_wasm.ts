import type {
  CoreFunctionId,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
  DucklangCoreFunction,
  DucklangCoreModule,
  DucklangCoreOperation,
  DucklangCoreTerminator,
} from "./ducklang_core.ts";
import { validateDucklangCore } from "./ducklang_core.ts";
import {
  managedProductIndexImportName,
  managedProductIndexUpdateImportName,
  managedProductMakeImportName,
  managedProductProjectImportName,
  managedProductUpdateImportName,
  managedSumMakeImportName,
  managedSumPayloadImportName,
  managedSumTagImportName,
} from "./ducklang_managed_layout.ts";
import {
  ducklangRuntimeImportModule,
  primitiveDescriptor,
  PrimitiveId,
  type PrimitiveId as PrimitiveIdType,
  primitiveRuntimeImportName,
} from "./ducklang_primitives.ts";
import type { FcgFunction, FcgModule, FcgOperation } from "./fcg.ts";
import type { FlatFcgPackage } from "./flat_fcg.ts";
import { flattenFcgModule } from "./flat_fcg.ts";
import {
  emitWasmPlanOnCpu,
  type WasmBinaryPlan,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./wasm.ts";

export type DucklangCoreWasmArtifact = {
  readonly fcg: FcgModule;
  readonly flatFcg: FlatFcgPackage;
  readonly wasmPlan: WasmBinaryPlan;
  readonly wasm: Uint8Array;
  readonly textLiterals: readonly string[];
};

export const ducklangTextLiteralsSectionName = "ducklang.text_literals";

type ImportRequirement = {
  readonly moduleName: string;
  readonly fieldName: string;
  readonly parameters: readonly number[];
  readonly result: number;
};

type FunctionValueLayout = {
  readonly localByValue: ReadonlyMap<CoreValueId, number>;
  readonly typeByValue: ReadonlyMap<CoreValueId, CoreTypeId>;
  readonly operationByResult: ReadonlyMap<
    CoreValueId,
    DucklangCoreOperation
  >;
  readonly locals: readonly number[];
  readonly dispatchLocal: number | undefined;
  readonly byteIndexLocal: number | undefined;
};

type ClosureTarget = {
  readonly functionId: CoreFunctionId;
  readonly signature: CoreSignatureId;
  readonly tableIndex: number;
};

export function lowerDucklangCoreToFcgAndWasm(
  core: DucklangCoreModule,
): DucklangCoreWasmArtifact {
  validateDucklangCore(core);
  const textLiterals = collectTextLiterals(core);
  const textHandles = new Map(
    textLiterals.map((literal, index) => [literal, index + 1]),
  );
  const closureTargets = collectClosureTargets(core);
  const requirements = collectImportRequirements(core, closureTargets);
  const builder = new WasmModuleBuilder();
  const importedFunctions = new Map<string, number>();
  for (const requirement of requirements.values()) {
    const typeIndex = builder.addFunctionType(
      requirement.parameters,
      [requirement.result],
    );
    importedFunctions.set(
      importRequirementKey(requirement),
      builder.addFunctionImport(
        requirement.moduleName,
        requirement.fieldName,
        typeIndex,
      ),
    );
  }

  const functionTypeIndices = core.functions.map((function_) => {
    const signature = core.signatures[function_.signature];
    return builder.addFunctionType(
      signature.parameters.map((type) => wasmValueType(core, type)),
      [wasmValueType(core, signature.result)],
    );
  });
  const closureTypeIndices = new Map<CoreSignatureId, number>();
  for (const target of closureTargets) {
    if (closureTypeIndices.has(target.signature)) continue;
    const signature = core.signatures[target.signature];
    closureTypeIndices.set(
      target.signature,
      builder.addFunctionType(
        [
          ...signature.parameters.map((type) => wasmValueType(core, type)),
          wasmType.i32,
        ],
        [wasmValueType(core, signature.result)],
      ),
    );
  }
  for (const function_ of core.functions) {
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (
          operation.kind !== "call.indirect" ||
          closureTypeIndices.has(operation.signature)
        ) {
          continue;
        }
        const signature = core.signatures[operation.signature];
        closureTypeIndices.set(
          operation.signature,
          builder.addFunctionType(
            [
              ...signature.parameters.map((type) => wasmValueType(core, type)),
              wasmType.i32,
            ],
            [wasmValueType(core, signature.result)],
          ),
        );
      }
    }
  }

  const functionIndices = core.functions.map((function_) =>
    requirements.size + function_.id
  );
  const fcgFunctions: FcgFunction[] = [];
  for (const function_ of core.functions) {
    const layout = planFunctionValues(core, function_);
    const instructions = emitFunction(
      core,
      function_,
      layout,
      importedFunctions,
      functionIndices,
      closureTargets,
      closureTypeIndices,
      textHandles,
    );
    const functionIndex = builder.addFunction(
      functionTypeIndices[function_.id],
      layout.locals,
      instructions,
    );
    const expectedIndex = functionIndices[function_.id];
    if (functionIndex !== expectedIndex) {
      throw new Error(
        `Core function ${function_.name} expected Wasm index ${expectedIndex}; received ${functionIndex}`,
      );
    }
    fcgFunctions.push(publicFunction(core, function_, layout));
  }

  const wrapperIndices: number[] = [];
  for (const target of closureTargets) {
    const wrapperIndex = builder.addFunction(
      requiredClosureTypeIndex(closureTypeIndices, target.signature),
      [],
      emitClosureWrapper(
        core,
        target,
        importedFunctions,
        functionIndices,
      ),
    );
    wrapperIndices.push(wrapperIndex);
  }
  if (wrapperIndices.length > 0) builder.addFunctionTable(wrapperIndices);

  builder.exportFunction("main", functionIndices[core.entryFunction]);
  if (textLiterals.length > 0) {
    builder.addCustomSection(
      ducklangTextLiteralsSectionName,
      new TextEncoder().encode(JSON.stringify(textLiterals)),
    );
  }
  const wasmPlan = builder.finishPlan();
  const wasm = emitWasmPlanOnCpu(wasmPlan);
  try {
    new WebAssembly.Module(
      new Uint8Array(wasm).buffer as ArrayBuffer,
    );
  } catch (cause) {
    throw new Error(
      `internal error: Core backend emitted invalid WebAssembly: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  const fcg = {
    functions: fcgFunctions,
    constructorTags: new Map<string, number>(),
  };
  return {
    fcg,
    flatFcg: flattenFcgModule(fcg),
    wasmPlan,
    wasm,
    textLiterals,
  };
}

function collectTextLiterals(core: DucklangCoreModule): readonly string[] {
  const literals = new Set<string>();
  for (const function_ of core.functions) {
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

function collectClosureTargets(
  core: DucklangCoreModule,
): readonly ClosureTarget[] {
  const signatures = new Map<CoreFunctionId, CoreSignatureId>();
  for (const function_ of core.functions) {
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (operation.kind !== "closure.make") continue;
        const closureType = core.types[operation.type];
        if (closureType.kind !== "function") {
          throw new TypeError(
            `${operation.span.file}:${operation.span.start}: closure.make result type ${operation.type} is not a function`,
          );
        }
        const existing = signatures.get(operation.functionId);
        if (
          existing !== undefined &&
          existing !== closureType.signature
        ) {
          throw new TypeError(
            `${operation.span.file}:${operation.span.start}: closure target ${operation.functionId} is used with signatures ${existing} and ${closureType.signature}`,
          );
        }
        signatures.set(operation.functionId, closureType.signature);
      }
    }
  }
  return [...signatures]
    .sort(([left], [right]) => left - right)
    .map(([functionId, signature], tableIndex) => ({
      functionId,
      signature,
      tableIndex,
    }));
}

function collectImportRequirements(
  core: DucklangCoreModule,
  closureTargets: readonly ClosureTarget[],
): ReadonlyMap<string, ImportRequirement> {
  const requirements = new Map<string, ImportRequirement>();
  const requireImport = (requirement: ImportRequirement): void => {
    const key = importRequirementKey(requirement);
    if (!requirements.has(key)) requirements.set(key, requirement);
  };
  const requireManaged = (
    fieldName: string,
    parameters: readonly number[],
    result: number,
  ): void =>
    requireImport({
      moduleName: ducklangRuntimeImportModule,
      fieldName,
      parameters,
      result,
    });
  for (const target of closureTargets) {
    const codeSignature = core.signatures[
      core.functions[target.functionId].signature
    ];
    const closureSignature = core.signatures[target.signature];
    const captures = codeSignature.parameters.slice(
      closureSignature.parameters.length,
    );
    requireManaged(
      managedProductMakeImportName(2),
      [wasmType.i32, wasmType.i32],
      wasmType.i32,
    );
    requireManaged(
      managedProductMakeImportName(captures.length),
      captures.map((type) => wasmValueType(core, type)),
      wasmType.i32,
    );
    captures.forEach((type, index) =>
      requireManaged(
        managedProductProjectImportName(index),
        [wasmType.i32],
        wasmValueType(core, type),
      )
    );
  }
  const needsIndirectCall = closureTargets.length > 0 ||
    core.functions.some((function_) =>
      function_.blocks.some((block) =>
        block.operations.some((operation) =>
          operation.kind === "call.indirect" ||
          operation.kind === "primitive" &&
            operation.primitiveId === PrimitiveId.bytesGenerate
        )
      )
    );
  if (needsIndirectCall) {
    requireManaged(
      managedProductProjectImportName(0),
      [wasmType.i32],
      wasmType.i32,
    );
    requireManaged(
      managedProductProjectImportName(1),
      [wasmType.i32],
      wasmType.i32,
    );
  }

  for (const function_ of core.functions) {
    const types = valueTypes(function_);
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        const operandTypes = operation.operands.map((operand) =>
          wasmValueType(core, requiredValueType(types, function_, operand))
        );
        const result = wasmValueType(core, operation.type);
        if (
          operation.kind === "scalar.binary" &&
          core.types[requiredValueType(types, function_, operation.operands[0])]
              .kind === "buffer"
        ) {
          requireManaged(
            primitiveRuntimeImportName(PrimitiveId.bufferEqual),
            operandTypes,
            wasmType.i32,
          );
          continue;
        }
        if (operation.kind === "primitive") {
          if (operation.primitiveId === PrimitiveId.bytesGenerate) {
            requireManaged(
              primitiveRuntimeImportName(PrimitiveId.bytesFill),
              [wasmType.i32, wasmType.i32],
              wasmType.i32,
            );
            requireManaged(
              primitiveRuntimeImportName(PrimitiveId.bufferSet),
              [wasmType.i32, wasmType.i32, wasmType.i32],
              wasmType.i32,
            );
          } else if (!isDirectPrimitive(operation.primitiveId)) {
            requireManaged(
              primitiveRuntimeImportName(operation.primitiveId),
              operandTypes,
              result,
            );
          }
          continue;
        }
        if (operation.kind === "product.make") {
          requireManaged(
            managedProductMakeImportName(operation.operands.length),
            operandTypes,
            wasmType.i32,
          );
          continue;
        }
        if (operation.kind === "product.project") {
          requireManaged(
            managedProductProjectImportName(operation.index),
            [wasmType.i32],
            result,
          );
          continue;
        }
        if (operation.kind === "product.update") {
          requireManaged(
            managedProductUpdateImportName(operation.indices),
            operandTypes,
            wasmType.i32,
          );
          continue;
        }
        if (operation.kind === "product.index") {
          requireManaged(
            managedProductIndexImportName,
            operandTypes,
            result,
          );
          continue;
        }
        if (operation.kind === "product.index_update") {
          requireManaged(
            managedProductIndexUpdateImportName,
            operandTypes,
            wasmType.i32,
          );
          continue;
        }
        if (operation.kind === "sum.make") {
          requireManaged(
            managedSumMakeImportName(operation.caseIndex),
            operandTypes,
            wasmType.i32,
          );
          continue;
        }
        if (operation.kind === "sum.tag") {
          requireManaged(
            managedSumTagImportName,
            [wasmType.i32],
            wasmType.i32,
          );
          continue;
        }
        if (operation.kind === "sum.payload") {
          requireManaged(
            managedSumPayloadImportName(wasmScalarName(result)),
            [wasmType.i32],
            result,
          );
          continue;
        }
        if (operation.kind === "host.call") {
          requireImport({
            moduleName: lowerInitial(operation.effectName),
            fieldName: operation.operationName,
            parameters: operandTypes,
            result,
          });
        }
      }
    }
  }
  return requirements;
}

function planFunctionValues(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
): FunctionValueLayout {
  const localByValue = new Map<CoreValueId, number>();
  const typeByValue = valueTypes(function_);
  const operationByResult = new Map<CoreValueId, DucklangCoreOperation>();
  const useCounts = new Map<CoreValueId, number>();
  const returnedValues = new Set<CoreValueId>();
  const countUse = (value: CoreValueId): void => {
    useCounts.set(value, (useCounts.get(value) ?? 0) + 1);
  };
  for (const block of function_.blocks) {
    for (const operation of block.operations) {
      operationByResult.set(operation.result, operation);
      operation.operands.forEach(countUse);
    }
    coreTerminatorValues(block.terminator).forEach(countUse);
    if (block.terminator.kind === "return") {
      block.terminator.values.forEach((value) => returnedValues.add(value));
    }
  }
  const signature = core.signatures[function_.signature];
  const entry = function_.blocks[function_.entryBlock];
  entry.parameters.forEach((parameter, index) => {
    localByValue.set(parameter.value, index);
  });
  const locals: number[] = [];
  let nextLocal = signature.parameters.length;
  for (const block of function_.blocks) {
    for (const parameter of block.parameters) {
      if (localByValue.has(parameter.value)) continue;
      localByValue.set(parameter.value, nextLocal);
      nextLocal += 1;
      locals.push(wasmValueType(core, parameter.type));
    }
    for (const operation of block.operations) {
      if (
        function_.blocks.length === 1 &&
        !operationNeedsLocal(
          operation,
          useCounts.get(operation.result) ?? 0,
          returnedValues.has(operation.result),
        )
      ) {
        continue;
      }
      localByValue.set(operation.result, nextLocal);
      nextLocal += 1;
      locals.push(wasmValueType(core, operation.type));
    }
  }
  let dispatchLocal: number | undefined;
  if (function_.blocks.length > 1) {
    dispatchLocal = nextLocal;
    nextLocal += 1;
    locals.push(wasmType.i32);
  }
  const hasByteGeneration = function_.blocks.some((block) =>
    block.operations.some((operation) =>
      operation.kind === "primitive" &&
      operation.primitiveId === PrimitiveId.bytesGenerate
    )
  );
  let byteIndexLocal: number | undefined;
  if (hasByteGeneration) {
    byteIndexLocal = nextLocal;
    locals.push(wasmType.i32);
  }
  return {
    localByValue,
    typeByValue,
    operationByResult,
    locals,
    dispatchLocal,
    byteIndexLocal,
  };
}

function emitFunction(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  layout: FunctionValueLayout,
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
): readonly WasmInstruction[] {
  const emitValue = (value: CoreValueId): readonly WasmInstruction[] =>
    emitStackValue(
      core,
      function_,
      value,
      layout,
      importedFunctions,
      functionIndices,
      closureTargets,
      closureTypeIndices,
      textHandles,
    );
  const emitBlockOperations = (
    blockIndex: number,
  ): readonly WasmInstruction[] =>
    function_.blocks[blockIndex].operations.flatMap((operation) => {
      if (!layout.localByValue.has(operation.result)) return [];
      return emitOperation(
        core,
        function_,
        operation,
        layout,
        importedFunctions,
        functionIndices,
        closureTargets,
        closureTypeIndices,
        textHandles,
        emitValue,
      );
    });
  if (function_.blocks.length === 1) {
    const block = function_.blocks[0];
    return [
      ...emitBlockOperations(0),
      ...emitTerminator(
        block.terminator,
        function_,
        layout,
        0,
        emitValue,
      ),
    ];
  }
  const diamond = simpleDiamond(function_);
  if (diamond !== undefined) {
    const joinParameter = diamond.join.parameters[0];
    const trueValue = diamond.trueBlock.terminator.kind === "branch"
      ? diamond.trueBlock.terminator.arguments[0]
      : undefined;
    const falseValue = diamond.falseBlock.terminator.kind === "branch"
      ? diamond.falseBlock.terminator.arguments[0]
      : undefined;
    if (
      joinParameter === undefined || trueValue === undefined ||
      falseValue === undefined
    ) {
      throw new Error(
        `Core function ${function_.name} has an incomplete structured diamond`,
      );
    }
    return [
      ...emitBlockOperations(diamond.entry.id),
      ...wasmInstruction.localGet(
        requiredLocal(
          layout,
          function_,
          diamond.entry.terminator.kind === "conditional_branch"
            ? diamond.entry.terminator.condition
            : 0 as CoreValueId,
        ),
      ),
      ...ifInstruction(wasmValueType(core, joinParameter.type)),
      ...emitBlockOperations(diamond.trueBlock.id),
      ...wasmInstruction.localGet(
        requiredLocal(layout, function_, trueValue),
      ),
      ...wasmInstruction.else,
      ...emitBlockOperations(diamond.falseBlock.id),
      ...wasmInstruction.localGet(
        requiredLocal(layout, function_, falseValue),
      ),
      ...wasmInstruction.end,
      ...wasmInstruction.localSet(
        requiredLocal(layout, function_, joinParameter.value),
      ),
      ...emitBlockOperations(diamond.join.id),
      ...emitTerminator(diamond.join.terminator, function_, layout, 0),
    ];
  }
  if (layout.dispatchLocal === undefined) {
    throw new Error(
      `Core function ${function_.name} has ${function_.blocks.length} blocks but no dispatch local`,
    );
  }
  const instructions: WasmInstruction[] = [
    ...wasmInstruction.i32Constant(function_.entryBlock),
    ...wasmInstruction.localSet(layout.dispatchLocal),
    ...wasmInstruction.loopVoid,
  ];
  for (const block of function_.blocks) {
    instructions.push(
      ...wasmInstruction.localGet(layout.dispatchLocal),
      ...wasmInstruction.i32Constant(block.id),
      ...wasmInstruction.i32Equal,
      ...wasmInstruction.ifVoid,
      ...emitBlockOperations(block.id),
      ...emitTerminator(block.terminator, function_, layout, 1),
      ...wasmInstruction.end,
    );
  }
  instructions.push(
    ...wasmInstruction.unreachable,
    ...wasmInstruction.end,
    ...wasmInstruction.unreachable,
  );
  return instructions;
}

function simpleDiamond(
  function_: DucklangCoreFunction,
): {
  readonly entry: DucklangCoreFunction["blocks"][number];
  readonly trueBlock: DucklangCoreFunction["blocks"][number];
  readonly falseBlock: DucklangCoreFunction["blocks"][number];
  readonly join: DucklangCoreFunction["blocks"][number];
} | undefined {
  if (function_.blocks.length !== 4) return undefined;
  const entry = function_.blocks[function_.entryBlock];
  if (
    entry.terminator.kind !== "conditional_branch" ||
    entry.terminator.trueArguments.length !== 0 ||
    entry.terminator.falseArguments.length !== 0
  ) {
    return undefined;
  }
  const trueBlock = function_.blocks[entry.terminator.trueTarget];
  const falseBlock = function_.blocks[entry.terminator.falseTarget];
  if (
    trueBlock.terminator.kind !== "branch" ||
    falseBlock.terminator.kind !== "branch" ||
    trueBlock.terminator.target !== falseBlock.terminator.target
  ) {
    return undefined;
  }
  const join = function_.blocks[trueBlock.terminator.target];
  if (
    join.parameters.length !== 1 ||
    trueBlock.terminator.arguments.length !== 1 ||
    falseBlock.terminator.arguments.length !== 1 ||
    (join.terminator.kind !== "return" && join.terminator.kind !== "trap")
  ) {
    return undefined;
  }
  return { entry, trueBlock, falseBlock, join };
}

function emitStackValue(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  value: CoreValueId,
  layout: FunctionValueLayout,
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
): readonly WasmInstruction[] {
  const local = layout.localByValue.get(value);
  if (local !== undefined) return wasmInstruction.localGet(local);
  const operation = layout.operationByResult.get(value);
  if (operation === undefined) {
    throw new Error(
      `Core function ${function_.name} has no stack definition for value ${value}`,
    );
  }
  if (!isStackifiableOperation(operation)) {
    throw new Error(
      `${operation.span.file}:${operation.span.start}: Core ${operation.kind} cannot be stackified without a local`,
    );
  }
  return emitOperation(
    core,
    function_,
    operation,
    layout,
    importedFunctions,
    functionIndices,
    closureTargets,
    closureTypeIndices,
    textHandles,
    (operand) =>
      emitStackValue(
        core,
        function_,
        operand,
        layout,
        importedFunctions,
        functionIndices,
        closureTargets,
        closureTypeIndices,
        textHandles,
      ),
  );
}

function emitOperation(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  operation: DucklangCoreOperation,
  layout: FunctionValueLayout,
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
  getValue: (
    value: CoreValueId,
  ) => readonly WasmInstruction[] = (value) =>
    wasmInstruction.localGet(requiredLocal(layout, function_, value)),
): readonly WasmInstruction[] {
  const resultLocal = layout.localByValue.get(operation.result);
  const getOperands = (): readonly WasmInstruction[] =>
    operation.operands.flatMap(getValue);
  const finish = (
    instructions: readonly WasmInstruction[],
  ): readonly WasmInstruction[] =>
    resultLocal === undefined
      ? instructions
      : [...instructions, ...wasmInstruction.localSet(resultLocal)];
  if (operation.kind === "constant") {
    return finish(
      emitConstant(core, operation.type, operation.value, textHandles),
    );
  }
  if (operation.kind === "scalar.binary") {
    const operandType = requiredValueType(
      layout.typeByValue,
      function_,
      operation.operands[0],
    );
    if (core.types[operandType].kind === "buffer") {
      const call = requireImportedFunction(
        importedFunctions,
        {
          moduleName: ducklangRuntimeImportModule,
          fieldName: primitiveRuntimeImportName(PrimitiveId.bufferEqual),
          parameters: [wasmType.i32, wasmType.i32],
          result: wasmType.i32,
        },
        operation,
      );
      return finish([
        ...getOperands(),
        ...wasmInstruction.call(call),
        ...(operation.operator === "!=" ? wasmInstruction.i32EqualZero : []),
      ]);
    }
    return finish([
      ...getOperands(),
      ...emitBinaryOperation(
        wasmValueType(core, operandType),
        operation.operator,
        operation,
      ),
    ]);
  }
  if (operation.kind === "primitive") {
    if (operation.primitiveId === PrimitiveId.bytesGenerate) {
      return emitBytesGenerate(
        core,
        function_,
        operation,
        layout,
        importedFunctions,
        closureTypeIndices,
        getValue,
      );
    }
    if (operation.primitiveId === PrimitiveId.f32x4Make) {
      return finish([
        ...getValue(operation.operands[0]),
        ...wasmInstruction.f32x4Splat,
        ...getValue(operation.operands[1]),
        ...wasmInstruction.f32x4ReplaceLane(1),
        ...getValue(operation.operands[2]),
        ...wasmInstruction.f32x4ReplaceLane(2),
        ...getValue(operation.operands[3]),
        ...wasmInstruction.f32x4ReplaceLane(3),
      ]);
    }
    const direct = emitDirectPrimitive(
      operation.primitiveId,
      operation.operands.map((operand) =>
        wasmValueType(
          core,
          requiredValueType(layout.typeByValue, function_, operand),
        )
      ),
      operation,
    );
    if (direct !== undefined) {
      if (operation.primitiveId === PrimitiveId.negate) {
        return finish(
          emitNegation(core, function_, operation, layout, getValue),
        );
      }
      return finish([...getOperands(), ...direct]);
    }
    const parameters = operation.operands.map((operand) =>
      wasmValueType(
        core,
        requiredValueType(layout.typeByValue, function_, operand),
      )
    );
    const result = wasmValueType(core, operation.type);
    const call = requireImportedFunction(
      importedFunctions,
      {
        moduleName: ducklangRuntimeImportModule,
        fieldName: primitiveRuntimeImportName(operation.primitiveId),
        parameters,
        result,
      },
      operation,
    );
    return finish([...getOperands(), ...wasmInstruction.call(call)]);
  }
  if (
    operation.kind === "product.make" ||
    operation.kind === "product.project" ||
    operation.kind === "product.update" ||
    operation.kind === "product.index" ||
    operation.kind === "product.index_update" ||
    operation.kind === "sum.make" ||
    operation.kind === "sum.tag" ||
    operation.kind === "sum.payload" ||
    operation.kind === "host.call"
  ) {
    const parameters = operation.operands.map((operand) =>
      wasmValueType(
        core,
        requiredValueType(layout.typeByValue, function_, operand),
      )
    );
    const result = wasmValueType(core, operation.type);
    const importName = aggregateImportName(operation, result);
    const call = requireImportedFunction(
      importedFunctions,
      {
        moduleName: operation.kind === "host.call"
          ? lowerInitial(operation.effectName)
          : ducklangRuntimeImportModule,
        fieldName: operation.kind === "host.call"
          ? operation.operationName
          : importName,
        parameters,
        result,
      },
      operation,
    );
    return finish([...getOperands(), ...wasmInstruction.call(call)]);
  }
  if (operation.kind === "product.select") {
    const index = operation.operands.at(-1);
    if (index === undefined || operation.operands.length < 2) {
      throw new TypeError(
        `${operation.span.file}:${operation.span.start}: product.select needs values and an index`,
      );
    }
    return finish(
      emitProductSelection(
        operation.operands.slice(0, -1),
        index,
        wasmValueType(core, operation.type),
        getValue,
      ),
    );
  }
  if (operation.kind === "call.direct") {
    return finish([
      ...getOperands(),
      ...wasmInstruction.call(functionIndices[operation.functionId]),
    ]);
  }
  if (operation.kind === "closure.make") {
    if (resultLocal === undefined) {
      throw new Error(
        `${operation.span.file}:${operation.span.start}: closure.make requires a result local`,
      );
    }
    const target = closureTargets.find((candidate) =>
      candidate.functionId === operation.functionId
    );
    if (target === undefined) {
      throw new Error(
        `${operation.span.file}:${operation.span.start}: closure target ${operation.functionId} has no table slot`,
      );
    }
    const captureTypes = operation.operands.map((operand) =>
      wasmValueType(
        core,
        requiredValueType(layout.typeByValue, function_, operand),
      )
    );
    const makeEnvironment = requireImportedFunction(
      importedFunctions,
      {
        moduleName: ducklangRuntimeImportModule,
        fieldName: managedProductMakeImportName(operation.operands.length),
        parameters: captureTypes,
        result: wasmType.i32,
      },
      operation,
    );
    const makeClosure = requireImportedFunction(
      importedFunctions,
      {
        moduleName: ducklangRuntimeImportModule,
        fieldName: managedProductMakeImportName(2),
        parameters: [wasmType.i32, wasmType.i32],
        result: wasmType.i32,
      },
      operation,
    );
    return [
      ...getOperands(),
      ...wasmInstruction.call(makeEnvironment),
      ...wasmInstruction.localSet(resultLocal),
      ...wasmInstruction.i32Constant(target.tableIndex),
      ...wasmInstruction.localGet(resultLocal),
      ...wasmInstruction.call(makeClosure),
      ...wasmInstruction.localSet(resultLocal),
    ];
  }
  if (operation.kind === "call.indirect") {
    const [closure, ...arguments_] = operation.operands;
    if (closure === undefined) {
      throw new TypeError(
        `${operation.span.file}:${operation.span.start}: call.indirect has no closure operand`,
      );
    }
    return finish([
      ...arguments_.flatMap((argument) => getValue(argument)),
      ...emitClosureProjection(
        closure,
        1,
        function_,
        layout,
        importedFunctions,
        operation,
      ),
      ...emitClosureProjection(
        closure,
        0,
        function_,
        layout,
        importedFunctions,
        operation,
      ),
      ...wasmInstruction.callIndirect(
        requiredClosureTypeIndex(closureTypeIndices, operation.signature),
      ),
    ]);
  }
  if (
    operation.kind === "resource.borrow" ||
    operation.kind === "resource.freeze"
  ) {
    return finish(getOperands());
  }
  if (
    operation.kind === "region.enter" ||
    operation.kind === "region.exit"
  ) {
    return finish(wasmInstruction.i32Constant(0));
  }
  throw new Error(
    `${operation.span.file}:${operation.span.start}: unhandled Core operation ${operation.kind}`,
  );
}

function emitBytesGenerate(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  operation: Extract<
    DucklangCoreOperation,
    { readonly kind: "primitive" }
  >,
  layout: FunctionValueLayout,
  importedFunctions: ReadonlyMap<string, number>,
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  getValue: (
    value: CoreValueId,
  ) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const [length, generator] = operation.operands;
  if (
    length === undefined || generator === undefined ||
    layout.byteIndexLocal === undefined
  ) {
    throw new TypeError(
      `${operation.span.file}:${operation.span.start}: bytes.generate requires length, generator, and an index local`,
    );
  }
  const generatorType = core.types[
    requiredValueType(layout.typeByValue, function_, generator)
  ];
  if (generatorType.kind !== "function") {
    throw new TypeError(
      `${operation.span.file}:${operation.span.start}: bytes.generate generator has non-function Core type`,
    );
  }
  const fill = requireImportedFunction(
    importedFunctions,
    {
      moduleName: ducklangRuntimeImportModule,
      fieldName: primitiveRuntimeImportName(PrimitiveId.bytesFill),
      parameters: [wasmType.i32, wasmType.i32],
      result: wasmType.i32,
    },
    operation,
  );
  const set = requireImportedFunction(
    importedFunctions,
    {
      moduleName: ducklangRuntimeImportModule,
      fieldName: primitiveRuntimeImportName(PrimitiveId.bufferSet),
      parameters: [wasmType.i32, wasmType.i32, wasmType.i32],
      result: wasmType.i32,
    },
    operation,
  );
  const resultLocal = requiredLocal(layout, function_, operation.result);
  return [
    ...getValue(length),
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.call(fill),
    ...wasmInstruction.localSet(resultLocal),
    ...wasmInstruction.i32Constant(0),
    ...wasmInstruction.localSet(layout.byteIndexLocal),
    ...wasmInstruction.blockVoid,
    ...wasmInstruction.loopVoid,
    ...wasmInstruction.localGet(layout.byteIndexLocal),
    ...getValue(length),
    ...wasmInstruction.i32GreaterThanOrEqualSigned,
    ...wasmInstruction.branchIf(1),
    ...wasmInstruction.localGet(resultLocal),
    ...wasmInstruction.localGet(layout.byteIndexLocal),
    ...wasmInstruction.localGet(layout.byteIndexLocal),
    ...emitClosureProjection(
      generator,
      1,
      function_,
      layout,
      importedFunctions,
      operation,
    ),
    ...emitClosureProjection(
      generator,
      0,
      function_,
      layout,
      importedFunctions,
      operation,
    ),
    ...wasmInstruction.callIndirect(
      requiredClosureTypeIndex(
        closureTypeIndices,
        generatorType.signature,
      ),
    ),
    ...wasmInstruction.call(set),
    ...wasmInstruction.localSet(resultLocal),
    ...wasmInstruction.localGet(layout.byteIndexLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localSet(layout.byteIndexLocal),
    ...wasmInstruction.branch(0),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
  ];
}

function emitClosureProjection(
  closure: CoreValueId,
  index: 0 | 1,
  function_: DucklangCoreFunction,
  layout: FunctionValueLayout,
  importedFunctions: ReadonlyMap<string, number>,
  operation: DucklangCoreOperation,
): readonly WasmInstruction[] {
  const project = requireImportedFunction(
    importedFunctions,
    {
      moduleName: ducklangRuntimeImportModule,
      fieldName: managedProductProjectImportName(index),
      parameters: [wasmType.i32],
      result: wasmType.i32,
    },
    operation,
  );
  return [
    ...wasmInstruction.localGet(requiredLocal(layout, function_, closure)),
    ...wasmInstruction.call(project),
  ];
}

function emitClosureWrapper(
  core: DucklangCoreModule,
  target: ClosureTarget,
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
): readonly WasmInstruction[] {
  const codeFunction = core.functions[target.functionId];
  const codeSignature = core.signatures[codeFunction.signature];
  const closureSignature = core.signatures[target.signature];
  const environmentLocal = closureSignature.parameters.length;
  const instructions: WasmInstruction[] = [];
  for (let index = 0; index < closureSignature.parameters.length; index += 1) {
    instructions.push(...wasmInstruction.localGet(index));
  }
  const captures = codeSignature.parameters.slice(
    closureSignature.parameters.length,
  );
  for (const [index, captureType] of captures.entries()) {
    const requirement = {
      moduleName: ducklangRuntimeImportModule,
      fieldName: managedProductProjectImportName(index),
      parameters: [wasmType.i32],
      result: wasmValueType(core, captureType),
    };
    const project = importedFunctions.get(importRequirementKey(requirement));
    if (project === undefined) {
      throw new Error(
        `closure wrapper for ${codeFunction.name} is missing capture projection ${index}`,
      );
    }
    instructions.push(
      ...wasmInstruction.localGet(environmentLocal),
      ...wasmInstruction.call(project),
    );
  }
  instructions.push(
    ...wasmInstruction.call(functionIndices[target.functionId]),
    ...wasmInstruction.return,
  );
  return instructions;
}

function emitTerminator(
  terminator: DucklangCoreTerminator,
  function_: DucklangCoreFunction,
  layout: FunctionValueLayout,
  dispatchDepth: number,
  getValue: (
    value: CoreValueId,
  ) => readonly WasmInstruction[] = (value) =>
    wasmInstruction.localGet(requiredLocal(layout, function_, value)),
): readonly WasmInstruction[] {
  if (terminator.kind === "return") {
    const value = terminator.values[0];
    if (value === undefined) {
      throw new TypeError(
        `${terminator.span.file}:${terminator.span.start}: Core backend requires one return value`,
      );
    }
    return [
      ...getValue(value),
      ...wasmInstruction.return,
    ];
  }
  if (terminator.kind === "trap") return wasmInstruction.unreachable;
  if (layout.dispatchLocal === undefined) {
    throw new Error(
      `${terminator.span.file}:${terminator.span.start}: branch terminator in single-block function ${function_.name}`,
    );
  }
  const branch = (
    target: number,
    arguments_: readonly CoreValueId[],
    depth: number,
  ): readonly WasmInstruction[] => {
    const parameters = function_.blocks[target].parameters;
    const instructions: WasmInstruction[] = [];
    for (const argument of arguments_) {
      instructions.push(
        ...wasmInstruction.localGet(requiredLocal(layout, function_, argument)),
      );
    }
    for (let index = parameters.length - 1; index >= 0; index -= 1) {
      instructions.push(
        ...wasmInstruction.localSet(
          requiredLocal(layout, function_, parameters[index].value),
        ),
      );
    }
    instructions.push(
      ...wasmInstruction.i32Constant(target),
      ...wasmInstruction.localSet(layout.dispatchLocal!),
      ...wasmInstruction.branch(depth),
    );
    return instructions;
  };
  if (terminator.kind === "branch") {
    return branch(
      terminator.target,
      terminator.arguments,
      dispatchDepth,
    );
  }
  return [
    ...wasmInstruction.localGet(
      requiredLocal(layout, function_, terminator.condition),
    ),
    ...wasmInstruction.ifVoid,
    ...branch(
      terminator.trueTarget,
      terminator.trueArguments,
      dispatchDepth + 1,
    ),
    ...wasmInstruction.else,
    ...branch(
      terminator.falseTarget,
      terminator.falseArguments,
      dispatchDepth + 1,
    ),
    ...wasmInstruction.end,
  ];
}

function emitProductSelection(
  values: readonly CoreValueId[],
  index: CoreValueId,
  resultType: number,
  getValue: (
    value: CoreValueId,
  ) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const emitAt = (valueIndex: number): readonly WasmInstruction[] => {
    if (valueIndex === values.length - 1) {
      return [
        ...getValue(index),
        ...wasmInstruction.i32Constant(valueIndex),
        ...wasmInstruction.i32Equal,
        ...ifInstruction(resultType),
        ...getValue(values[valueIndex]),
        ...wasmInstruction.else,
        ...wasmInstruction.unreachable,
        ...wasmInstruction.end,
      ];
    }
    return [
      ...getValue(index),
      ...wasmInstruction.i32Constant(valueIndex),
      ...wasmInstruction.i32Equal,
      ...ifInstruction(resultType),
      ...getValue(values[valueIndex]),
      ...wasmInstruction.else,
      ...emitAt(valueIndex + 1),
      ...wasmInstruction.end,
    ];
  };
  return emitAt(0);
}

function emitConstant(
  core: DucklangCoreModule,
  type: CoreTypeId,
  value: number | bigint | boolean | string | undefined,
  textHandles: ReadonlyMap<string, number>,
): readonly WasmInstruction[] {
  const wasm = wasmValueType(core, type);
  if (typeof value === "string") {
    const handle = textHandles.get(value);
    if (handle === undefined) {
      throw new Error(`missing Core text handle for ${JSON.stringify(value)}`);
    }
    return wasmInstruction.i32Constant(handle);
  }
  if (wasm === wasmType.i64) {
    return wasmInstruction.i64Constant(value as bigint);
  }
  if (wasm === wasmType.f32) {
    return wasmInstruction.f32Constant(value as number);
  }
  if (wasm === wasmType.f64) {
    return wasmInstruction.f64Constant(value as number);
  }
  if (wasm === wasmType.v128) {
    throw new TypeError("Core backend does not admit scalar v128 constants");
  }
  if (typeof value === "bigint") {
    throw new TypeError(`i32 Core constant cannot contain bigint ${value}`);
  }
  return wasmInstruction.i32Constant(
    value === undefined
      ? 0
      : typeof value === "boolean"
      ? Number(value)
      : value,
  );
}

function emitBinaryOperation(
  type: number,
  operator: string,
  operation: DucklangCoreOperation,
): readonly WasmInstruction[] {
  const tables = type === wasmType.i64
    ? {
      "+": wasmInstruction.i64Add,
      "-": wasmInstruction.i64Subtract,
      "*": wasmInstruction.i64Multiply,
      "/": wasmInstruction.i64DivideSigned,
      "%": wasmInstruction.i64RemainderSigned,
      "==": wasmInstruction.i64Equal,
      "!=": wasmInstruction.i64NotEqual,
      "<": wasmInstruction.i64LessThanSigned,
      "<=": wasmInstruction.i64LessThanOrEqualSigned,
      ">": wasmInstruction.i64GreaterThanSigned,
      ">=": wasmInstruction.i64GreaterThanOrEqualSigned,
    }
    : type === wasmType.f32
    ? {
      "+": wasmInstruction.f32Add,
      "-": wasmInstruction.f32Subtract,
      "*": wasmInstruction.f32Multiply,
      "/": wasmInstruction.f32Divide,
      "==": wasmInstruction.f32Equal,
      "!=": wasmInstruction.f32NotEqual,
      "<": wasmInstruction.f32LessThan,
      "<=": wasmInstruction.f32LessThanOrEqual,
      ">": wasmInstruction.f32GreaterThan,
      ">=": wasmInstruction.f32GreaterThanOrEqual,
    }
    : type === wasmType.f64
    ? {
      "+": wasmInstruction.f64Add,
      "-": wasmInstruction.f64Subtract,
      "*": wasmInstruction.f64Multiply,
      "/": wasmInstruction.f64Divide,
      "==": wasmInstruction.f64Equal,
      "!=": wasmInstruction.f64NotEqual,
      "<": wasmInstruction.f64LessThan,
      "<=": wasmInstruction.f64LessThanOrEqual,
      ">": wasmInstruction.f64GreaterThan,
      ">=": wasmInstruction.f64GreaterThanOrEqual,
    }
    : {
      "+": wasmInstruction.i32Add,
      "-": wasmInstruction.i32Subtract,
      "*": wasmInstruction.i32Multiply,
      "/": wasmInstruction.i32DivideSigned,
      "%": wasmInstruction.i32RemainderSigned,
      "==": wasmInstruction.i32Equal,
      "!=": wasmInstruction.i32NotEqual,
      "<": wasmInstruction.i32LessThanSigned,
      "<=": wasmInstruction.i32LessThanOrEqualSigned,
      ">": wasmInstruction.i32GreaterThanSigned,
      ">=": wasmInstruction.i32GreaterThanOrEqualSigned,
      "&&": wasmInstruction.i32And,
      "||": wasmInstruction.i32Or,
    };
  const instruction = (
    tables as Readonly<Record<string, readonly WasmInstruction[]>>
  )[operator];
  if (instruction !== undefined) return instruction;
  throw new TypeError(
    `${operation.span.file}:${operation.span.start}: Core operator ${operator} has no Wasm lowering for type 0x${
      type.toString(16)
    }`,
  );
}

function emitDirectPrimitive(
  primitiveId: PrimitiveIdType,
  operandTypes: readonly number[],
  operation: DucklangCoreOperation,
): readonly WasmInstruction[] | undefined {
  const type = operandTypes[0] ?? wasmType.i32;
  if (
    primitiveId >= PrimitiveId.add &&
    primitiveId <= PrimitiveId.greaterThanOrEqual
  ) {
    const operators = [
      "+",
      "-",
      "*",
      "/",
      "%",
      "negate",
      "==",
      "!=",
      "<",
      "<=",
      ">",
      ">=",
    ];
    if (primitiveId === PrimitiveId.negate) return [];
    return emitBinaryOperation(type, operators[primitiveId], operation);
  }
  const instruction = new Map<PrimitiveIdType, readonly WasmInstruction[]>([
    [PrimitiveId.booleanNot, wasmInstruction.i32EqualZero],
    [PrimitiveId.booleanAnd, wasmInstruction.i32And],
    [PrimitiveId.booleanOr, wasmInstruction.i32Or],
    [
      PrimitiveId.bitAnd,
      type === wasmType.i64 ? wasmInstruction.i64And : wasmInstruction.i32And,
    ],
    [
      PrimitiveId.bitOr,
      type === wasmType.i64 ? wasmInstruction.i64Or : wasmInstruction.i32Or,
    ],
    [
      PrimitiveId.bitXor,
      type === wasmType.i64 ? wasmInstruction.i64Xor : wasmInstruction.i32Xor,
    ],
    [
      PrimitiveId.shiftLeft,
      type === wasmType.i64
        ? wasmInstruction.i64ShiftLeft
        : wasmInstruction.i32ShiftLeft,
    ],
    [
      PrimitiveId.shiftRightUnsigned,
      type === wasmType.i64
        ? wasmInstruction.i64ShiftRightUnsigned
        : wasmInstruction.i32ShiftRightUnsigned,
    ],
    [PrimitiveId.f32SquareRoot, wasmInstruction.f32SquareRoot],
    [PrimitiveId.f32FromI32, wasmInstruction.f32ConvertI32Signed],
    [PrimitiveId.i32FromF32, wasmInstruction.i32TruncateF32Signed],
    [PrimitiveId.f64FromI32, wasmInstruction.f64ConvertI32Signed],
    [PrimitiveId.i32FromF64, wasmInstruction.i32TruncateF64Signed],
    [PrimitiveId.i32WrapI64, wasmInstruction.i32WrapI64],
    [PrimitiveId.i64ExtendI32Signed, wasmInstruction.i64ExtendI32Signed],
    [PrimitiveId.i64ExtendI32Unsigned, wasmInstruction.i64ExtendI32Unsigned],
    [PrimitiveId.i32ReinterpretF32, wasmInstruction.i32ReinterpretF32],
    [PrimitiveId.f32ReinterpretI32, wasmInstruction.f32ReinterpretI32],
    [PrimitiveId.f32x4Splat, wasmInstruction.f32x4Splat],
    [PrimitiveId.f32x4Add, wasmInstruction.f32x4Add],
    [PrimitiveId.f32x4Subtract, wasmInstruction.f32x4Subtract],
    [PrimitiveId.f32x4Multiply, wasmInstruction.f32x4Multiply],
    [PrimitiveId.f32x4Divide, wasmInstruction.f32x4Divide],
  ]).get(primitiveId);
  return instruction;
}

function emitNegation(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  operation: DucklangCoreOperation,
  layout: FunctionValueLayout,
  getValue: (
    value: CoreValueId,
  ) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const operand = operation.operands[0];
  const type = wasmValueType(
    core,
    requiredValueType(layout.typeByValue, function_, operand),
  );
  if (type === wasmType.f32) {
    return [
      ...getValue(operand),
      ...wasmInstruction.f32Negate,
    ];
  }
  if (type === wasmType.f64) {
    return [
      ...getValue(operand),
      ...wasmInstruction.f64Negate,
    ];
  }
  return type === wasmType.i64
    ? [
      ...wasmInstruction.i64Constant(0n),
      ...getValue(operand),
      ...wasmInstruction.i64Subtract,
    ]
    : [
      ...wasmInstruction.i32Constant(0),
      ...getValue(operand),
      ...wasmInstruction.i32Subtract,
    ];
}

function isDirectPrimitive(primitiveId: PrimitiveIdType): boolean {
  return primitiveId <= PrimitiveId.f32x4Divide;
}

function aggregateImportName(
  operation: DucklangCoreOperation,
  result: number,
): string {
  if (operation.kind === "product.make") {
    return managedProductMakeImportName(operation.operands.length);
  }
  if (operation.kind === "product.project") {
    return managedProductProjectImportName(operation.index);
  }
  if (operation.kind === "product.update") {
    return managedProductUpdateImportName(operation.indices);
  }
  if (operation.kind === "product.index") return managedProductIndexImportName;
  if (operation.kind === "product.index_update") {
    return managedProductIndexUpdateImportName;
  }
  if (operation.kind === "sum.make") {
    return managedSumMakeImportName(operation.caseIndex);
  }
  if (operation.kind === "sum.tag") return managedSumTagImportName;
  if (operation.kind === "sum.payload") {
    return managedSumPayloadImportName(wasmScalarName(result));
  }
  if (operation.kind === "host.call") return operation.operationName;
  throw new Error(`Core operation ${operation.kind} has no aggregate import`);
}

function valueTypes(
  function_: DucklangCoreFunction,
): ReadonlyMap<CoreValueId, CoreTypeId> {
  const types = new Map<CoreValueId, CoreTypeId>();
  for (const block of function_.blocks) {
    for (const parameter of block.parameters) {
      types.set(parameter.value, parameter.type);
    }
    for (const operation of block.operations) {
      types.set(operation.result, operation.type);
    }
  }
  return types;
}

function operationNeedsLocal(
  operation: DucklangCoreOperation,
  useCount: number,
  returnedDirectly: boolean,
): boolean {
  if (useCount > 1) return true;
  if (operation.kind === "constant") return false;
  if (returnedDirectly && isStackifiableOperation(operation)) return false;
  return true;
}

function isStackifiableOperation(
  operation: DucklangCoreOperation,
): boolean {
  if (
    operation.kind === "constant" ||
    operation.kind === "scalar.binary" ||
    operation.kind === "product.select" ||
    operation.kind === "resource.borrow" ||
    operation.kind === "resource.freeze"
  ) {
    return true;
  }
  return operation.kind === "primitive" &&
    isDirectPrimitive(operation.primitiveId) &&
    operation.primitiveId !== PrimitiveId.f32x4Make;
}

function coreTerminatorValues(
  terminator: DucklangCoreTerminator,
): readonly CoreValueId[] {
  if (terminator.kind === "return") return terminator.values;
  if (terminator.kind === "branch") return terminator.arguments;
  if (terminator.kind === "conditional_branch") {
    return [
      terminator.condition,
      ...terminator.trueArguments,
      ...terminator.falseArguments,
    ];
  }
  return [];
}

function requiredValueType(
  types: ReadonlyMap<CoreValueId, CoreTypeId>,
  function_: DucklangCoreFunction,
  value: CoreValueId,
): CoreTypeId {
  const type = types.get(value);
  if (type !== undefined) return type;
  throw new Error(
    `Core function ${function_.name} has no type for value ${value}`,
  );
}

function requiredLocal(
  layout: FunctionValueLayout,
  function_: DucklangCoreFunction,
  value: CoreValueId,
): number {
  const local = layout.localByValue.get(value);
  if (local !== undefined) return local;
  throw new Error(
    `Core function ${function_.name} has no local for value ${value}`,
  );
}

function wasmValueType(
  core: DucklangCoreModule,
  typeId: CoreTypeId,
): number {
  const type = core.types[typeId];
  if (type.kind !== "scalar") return wasmType.i32;
  if (type.scalar === "i64") return wasmType.i64;
  if (type.scalar === "f32") return wasmType.f32;
  if (type.scalar === "f64") return wasmType.f64;
  if (type.scalar === "f32x4") return wasmType.v128;
  return wasmType.i32;
}

function wasmScalarName(
  type: number,
): "i32" | "i64" | "f32" | "f64" {
  if (type === wasmType.i64) return "i64";
  if (type === wasmType.f32) return "f32";
  if (type === wasmType.f64) return "f64";
  if (type === wasmType.i32) return "i32";
  throw new TypeError(
    `managed aggregate ABI cannot carry Wasm type 0x${type.toString(16)}`,
  );
}

function ifInstruction(type: number): readonly WasmInstruction[] {
  if (type === wasmType.i64) return wasmInstruction.ifI64;
  if (type === wasmType.f32) return wasmInstruction.ifF32;
  if (type === wasmType.f64) return wasmInstruction.ifF64;
  if (type === wasmType.i32) return wasmInstruction.ifI32;
  throw new TypeError(
    `product selection cannot return Wasm type 0x${type.toString(16)}`,
  );
}

function importRequirementKey(requirement: ImportRequirement): string {
  return `${requirement.moduleName}\0${requirement.fieldName}\0${
    requirement.parameters.join(",")
  }\0${requirement.result}`;
}

function requireImportedFunction(
  imports: ReadonlyMap<string, number>,
  requirement: ImportRequirement,
  operation: DucklangCoreOperation,
): number {
  const index = imports.get(importRequirementKey(requirement));
  if (index !== undefined) return index;
  throw new Error(
    `${operation.span.file}:${operation.span.start}: Core ${operation.kind} is missing import ${requirement.moduleName}.${requirement.fieldName}(${
      requirement.parameters.join(",")
    }) -> ${requirement.result}`,
  );
}

function requiredClosureTypeIndex(
  indices: ReadonlyMap<CoreSignatureId, number>,
  signature: CoreSignatureId,
): number {
  const index = indices.get(signature);
  if (index !== undefined) return index;
  throw new Error(`Core closure signature ${signature} has no Wasm type`);
}

function lowerInitial(value: string): string {
  return value.length === 0 ? value : value[0].toLowerCase() + value.slice(1);
}

function publicFunction(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  layout: FunctionValueLayout,
): FcgFunction {
  const signature = core.signatures[function_.signature];
  if (function_.blocks.length === 1) {
    return {
      name: publicFunctionName(function_),
      parameters: signature.parameters.map((_, index) => `p${index}`),
      localCount: layout.locals.length,
      operations: publicStackOperations(
        core,
        function_,
        function_.blocks[0],
        layout,
      ),
    };
  }
  const operations: FcgOperation[] = [];
  for (const block of function_.blocks) {
    for (const operation of block.operations) {
      operations.push({
        opcode: publicOpcode(core, function_, operation, layout),
        operands: operation.operands,
        sourceStart: operation.span.start,
        regionId: block.id,
      });
    }
    operations.push({
      opcode: block.terminator.kind === "conditional_branch"
        ? "if"
        : block.terminator.kind,
      operands: terminatorOperands(block.terminator),
      sourceStart: block.terminator.span.start,
      regionId: block.id,
    });
  }
  return {
    name: publicFunctionName(function_),
    parameters: signature.parameters.map((_, index) => `p${index}`),
    localCount: layout.locals.length,
    operations,
  };
}

function publicStackOperations(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  block: DucklangCoreFunction["blocks"][number],
  layout: FunctionValueLayout,
): readonly FcgOperation[] {
  const emitOperation = (
    operation: DucklangCoreOperation,
  ): readonly FcgOperation[] => {
    const emitted: FcgOperation[] = [];
    for (const operand of operation.operands) {
      emitted.push(...emitValue(operand));
    }
    emitted.push({
      opcode: publicOpcode(core, function_, operation, layout),
      operands: operation.kind === "constant"
        ? [
          typeof operation.value === "bigint"
            ? operation.value.toString()
            : typeof operation.value === "number" &&
                (wasmValueType(core, operation.type) === wasmType.f32 ||
                  wasmValueType(core, operation.type) === wasmType.f64)
            ? operation.value.toString()
            : operation.value === undefined
            ? 0
            : typeof operation.value === "boolean"
            ? Number(operation.value)
            : operation.value,
        ]
        : operation.kind === "call.direct"
        ? [publicFunctionName(core.functions[operation.functionId])]
        : [],
      sourceStart: operation.span.start,
      regionId: block.id,
    });
    return emitted;
  };
  const emitValue = (value: CoreValueId): readonly FcgOperation[] => {
    const local = layout.localByValue.get(value);
    if (local !== undefined) {
      return [{
        opcode: "local.get",
        operands: [local],
        sourceStart: function_.span.start,
        regionId: block.id,
      }];
    }
    const operation = layout.operationByResult.get(value);
    if (operation === undefined) {
      throw new Error(
        `Core function ${function_.name} has no public stack definition for value ${value}`,
      );
    }
    return emitOperation(operation);
  };
  const operations: FcgOperation[] = [];
  for (const operation of block.operations) {
    const local = layout.localByValue.get(operation.result);
    if (local === undefined) continue;
    operations.push(...emitOperation(operation), {
      opcode: "local.set",
      operands: [local],
      sourceStart: operation.span.start,
      regionId: block.id,
    });
  }
  if (block.terminator.kind === "return") {
    const value = block.terminator.values[0];
    if (value !== undefined) operations.push(...emitValue(value));
  } else if (block.terminator.kind === "trap") {
    operations.push({
      opcode: "trap",
      operands: [],
      sourceStart: block.terminator.span.start,
      regionId: block.id,
    });
  }
  return operations;
}

function publicFunctionName(function_: DucklangCoreFunction): string {
  return function_.sourceSymbolId === undefined
    ? function_.name
    : `${function_.name}__duck${function_.sourceSymbolId}`;
}

function publicOpcode(
  core: DucklangCoreModule,
  function_: DucklangCoreFunction,
  operation: DucklangCoreOperation,
  layout: FunctionValueLayout,
): string {
  if (operation.kind === "constant") {
    const type = wasmValueType(core, operation.type);
    return type === wasmType.i32 ? "const" : `${wasmScalarName(type)}.const`;
  }
  if (operation.kind === "scalar.binary") {
    const operandType = requiredValueType(
      layout.typeByValue,
      function_,
      operation.operands[0],
    );
    return `${
      wasmScalarName(wasmValueType(core, operandType))
    }.${operation.operator}`;
  }
  if (operation.kind === "primitive") {
    return primitiveDescriptor(operation.primitiveId).lowering;
  }
  if (operation.kind === "call.direct") return "call";
  if (operation.kind === "call.indirect") return "call_indirect";
  return operation.kind;
}

function terminatorOperands(
  terminator: DucklangCoreTerminator,
): readonly number[] {
  if (terminator.kind === "return") return terminator.values;
  if (terminator.kind === "branch") {
    return [terminator.target, ...terminator.arguments];
  }
  if (terminator.kind === "conditional_branch") {
    return [
      terminator.condition,
      terminator.trueTarget,
      ...terminator.trueArguments,
      terminator.falseTarget,
      ...terminator.falseArguments,
    ];
  }
  return [];
}

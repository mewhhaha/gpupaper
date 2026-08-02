import { primitiveDescriptor, PrimitiveId } from "./core_primitives.ts";
export {
  coreRuntimeImportModule,
  type PrimitiveDescriptor,
  primitiveDescriptor,
  PrimitiveId,
  primitiveRuntimeImportName,
} from "./core_primitives.ts";

export type CoreTypeId = number & { readonly __coreTypeId: true };
export type CoreSignatureId = number & { readonly __coreSignatureId: true };
export type CoreFunctionId = number & { readonly __coreFunctionId: true };
export type CoreBlockId = number & { readonly __coreBlockId: true };
export type CoreValueId = number & { readonly __coreValueId: true };

export type CoreSourceSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

export type CoreBinaryOperator =
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
  | ">="
  | "&&"
  | "||";

export type CoreScalar = "i32" | "i64" | "f32" | "f64" | "unit";
export type CoreVectorElement = "i32" | "i64" | "f32" | "f64";

export type CoreType =
  | {
    readonly kind: "scalar";
    readonly scalar: CoreScalar;
  }
  | {
    readonly kind: "vector";
    readonly lanes: 2 | 4;
    readonly element: CoreVectorElement;
  }
  | {
    readonly kind: "mask";
    readonly lanes: 2 | 4;
    readonly element: CoreVectorElement;
  }
  | {
    readonly kind: "buffer";
    readonly buffer: "text" | "bytes";
  }
  | {
    readonly kind: "store";
    readonly element: CoreTypeId;
  }
  | {
    readonly kind: "product";
    readonly fields: readonly CoreTypeId[];
  }
  | {
    readonly kind: "sum";
    readonly cases: readonly CoreTypeId[];
  }
  | {
    readonly kind: "function";
    readonly signature: CoreSignatureId;
  };

export type CoreSignature = {
  readonly parameters: readonly CoreTypeId[];
  readonly result: CoreTypeId;
};

export type CoreOperationBase = {
  readonly result: CoreValueId;
  readonly type: CoreTypeId;
  readonly operands: readonly CoreValueId[];
  readonly span: CoreSourceSpan;
};

export type CoreOperation =
  | (CoreOperationBase & {
    readonly kind: "constant";
    readonly value: number | bigint | boolean | string | undefined;
  })
  | (CoreOperationBase & {
    readonly kind: "scalar.binary";
    readonly operator: CoreBinaryOperator;
  })
  | (CoreOperationBase & {
    readonly kind: "primitive";
    readonly primitiveId: PrimitiveId;
  })
  | (CoreOperationBase & {
    readonly kind: "vector.shuffle";
    readonly lanes: readonly number[];
  })
  | (CoreOperationBase & {
    readonly kind: "product.make";
  })
  | (CoreOperationBase & {
    readonly kind: "product.project";
    readonly index: number;
  })
  | (CoreOperationBase & {
    readonly kind: "product.update";
    readonly indices: readonly number[];
  })
  | (CoreOperationBase & {
    readonly kind: "product.index";
  })
  | (CoreOperationBase & {
    readonly kind: "product.index_update";
  })
  | (CoreOperationBase & {
    readonly kind: "product.select";
  })
  | (CoreOperationBase & {
    readonly kind: "sum.make";
    readonly caseIndex: number;
  })
  | (CoreOperationBase & {
    readonly kind: "sum.tag";
  })
  | (CoreOperationBase & {
    readonly kind: "sum.payload";
    readonly caseIndex: number;
  })
  | (CoreOperationBase & {
    readonly kind:
      | "store.empty"
      | "store.new"
      | "store.length"
      | "store.read";
  })
  | (CoreOperationBase & {
    readonly kind: "store.write" | "store.grow";
    readonly update: "persistent" | "owned-reuse";
  })
  | (CoreOperationBase & {
    readonly kind: "call.direct";
    readonly functionId: CoreFunctionId;
  })
  | (CoreOperationBase & {
    readonly kind: "closure.make";
    readonly functionId: CoreFunctionId;
  })
  | (CoreOperationBase & {
    readonly kind: "call.indirect";
    readonly signature: CoreSignatureId;
  })
  | (CoreOperationBase & {
    readonly kind: "host.call";
    readonly effectName: string;
    readonly operationName: string;
  })
  | (CoreOperationBase & {
    readonly kind:
      | "seal.wrap"
      | "seal.unwrap"
      | "resource.move"
      | "resource.borrow"
      | "resource.freeze"
      | "resource.drop"
      | "region.enter"
      | "region.allocate"
      | "region.exit";
  });

export type CoreTerminator =
  | {
    readonly kind: "branch";
    readonly target: CoreBlockId;
    readonly arguments: readonly CoreValueId[];
    readonly span: CoreSourceSpan;
  }
  | {
    readonly kind: "conditional_branch";
    readonly condition: CoreValueId;
    readonly trueTarget: CoreBlockId;
    readonly trueArguments: readonly CoreValueId[];
    readonly falseTarget: CoreBlockId;
    readonly falseArguments: readonly CoreValueId[];
    readonly span: CoreSourceSpan;
  }
  | {
    readonly kind: "return";
    readonly values: readonly CoreValueId[];
    readonly span: CoreSourceSpan;
  }
  | {
    readonly kind: "trap";
    readonly span: CoreSourceSpan;
  };

export type CoreBlock = {
  readonly id: CoreBlockId;
  readonly parameters: readonly {
    readonly value: CoreValueId;
    readonly type: CoreTypeId;
    readonly span: CoreSourceSpan;
  }[];
  readonly operations: readonly CoreOperation[];
  readonly terminator: CoreTerminator;
};

export type CoreFunction = {
  readonly id: CoreFunctionId;
  readonly name: string;
  readonly sourceIdentity: number | undefined;
  readonly signature: CoreSignatureId;
  readonly entryBlock: CoreBlockId;
  readonly blocks: readonly CoreBlock[];
  readonly span: CoreSourceSpan;
};

export type CoreModule = {
  readonly schemaVersion: 1;
  readonly file: string;
  readonly types: readonly CoreType[];
  readonly signatures: readonly CoreSignature[];
  readonly functions: readonly CoreFunction[];
  readonly entryFunction: CoreFunctionId;
};

export function validateCore(module: CoreModule): void {
  for (const [typeId, type] of module.types.entries()) {
    if (type.kind === "store") {
      requireIndex(type.element, module.types.length, "store element type");
      if (
        module.types[type.element].kind === "vector" ||
        module.types[type.element].kind === "mask"
      ) {
        throw new TypeError(
          `Core store type ${typeId} has JavaScript-inexpressible vector element ${type.element}`,
        );
      }
      continue;
    }
    if (type.kind !== "vector" && type.kind !== "mask") continue;
    const elementBits = type.element === "i64" || type.element === "f64"
      ? 64
      : 32;
    if (type.lanes * elementBits !== 128) {
      throw new TypeError(
        `Core ${type.kind} type ${typeId} has ${type.lanes} ${type.element} lanes; expected 128 bits`,
      );
    }
  }
  requireIndex(module.entryFunction, module.functions.length, "entry function");
  for (const [functionIndex, function_] of module.functions.entries()) {
    if (function_.id !== functionIndex) {
      throw new TypeError(
        `Core function table index ${functionIndex} contains ID ${function_.id}`,
      );
    }
    requireIndex(function_.signature, module.signatures.length, "signature");
    requireIndex(function_.entryBlock, function_.blocks.length, "entry block");
    const signature = module.signatures[function_.signature];
    const entryParameters = function_.blocks[function_.entryBlock].parameters;
    requireCoreTypes(
      `function ${function_.name} entry`,
      entryParameters.map((parameter) => parameter.type),
      signature.parameters,
    );
    const definitions = new Map<
      CoreValueId,
      { readonly block: CoreBlockId; readonly operation: number }
    >();
    const valueTypes = new Map<CoreValueId, CoreTypeId>();
    for (const [blockIndex, block] of function_.blocks.entries()) {
      if (block.id !== blockIndex) {
        throw new TypeError(
          `Core function ${function_.name} block table index ${blockIndex} contains ID ${block.id}`,
        );
      }
      for (const parameter of block.parameters) {
        requireIndex(
          parameter.type,
          module.types.length,
          "block parameter type",
        );
        defineCoreValue(definitions, parameter.value, block.id, -1, function_);
        valueTypes.set(parameter.value, parameter.type);
      }
      for (const [operationIndex, operation] of block.operations.entries()) {
        requireIndex(operation.type, module.types.length, "operation type");
        defineCoreValue(
          definitions,
          operation.result,
          block.id,
          operationIndex,
          function_,
        );
        valueTypes.set(operation.result, operation.type);
        if (
          operation.kind === "call.direct" ||
          operation.kind === "closure.make"
        ) {
          requireIndex(
            operation.functionId,
            module.functions.length,
            operation.kind === "call.direct"
              ? "direct callee"
              : "closure function",
          );
        }
        if (operation.kind === "call.indirect") {
          requireIndex(
            operation.signature,
            module.signatures.length,
            "indirect signature",
          );
        }
      }
    }
    const predecessors = function_.blocks.map(() => new Set<CoreBlockId>());
    for (const block of function_.blocks) {
      validateTerminatorEdges(
        function_,
        block,
        definitions,
        valueTypes,
        predecessors,
      );
    }
    const dominators = calculateDominators(function_, predecessors);
    for (const block of function_.blocks) {
      for (const [operationIndex, operation] of block.operations.entries()) {
        for (const operand of operation.operands) {
          requireDominatingValue(
            function_,
            definitions,
            dominators,
            operand,
            block.id,
            operationIndex,
          );
        }
        validateCoreCallOperation(module, function_, operation, valueTypes);
      }
      for (const operand of terminatorValues(block.terminator)) {
        requireDominatingValue(
          function_,
          definitions,
          dominators,
          operand,
          block.id,
          block.operations.length,
        );
      }
      validateCoreTerminator(module, function_, block, valueTypes);
    }
  }
}

function validateCoreCallOperation(
  module: CoreModule,
  function_: CoreFunction,
  operation: CoreOperation,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
): void {
  if (
    operation.kind === "store.empty" || operation.kind === "store.new" ||
    operation.kind === "store.length" || operation.kind === "store.read" ||
    operation.kind === "store.write" || operation.kind === "store.grow"
  ) {
    validateCoreStoreOperation(module, function_, operation, valueTypes);
    return;
  }
  if (operation.kind === "vector.shuffle") {
    requireCoreOperationOperands(function_, operation, 2);
    const resultType = module.types[operation.type];
    if (resultType.kind !== "vector") {
      throw new TypeError(
        `Core vector.shuffle ${function_.name}:${operation.result} has non-vector result type ${operation.type}`,
      );
    }
    for (const operand of operation.operands) {
      if (
        requiredCoreValueType(valueTypes, function_, operand) !==
          operation.type
      ) {
        throw new TypeError(
          `Core vector.shuffle ${function_.name}:${operation.result} changes operand type`,
        );
      }
    }
    if (
      operation.lanes.length !== resultType.lanes ||
      operation.lanes.some((lane) =>
        !Number.isSafeInteger(lane) || lane < 0 || lane >= 2 * resultType.lanes
      )
    ) {
      throw new RangeError(
        `Core vector.shuffle ${function_.name}:${operation.result} has lanes [${
          operation.lanes.join(", ")
        }]; expected ${resultType.lanes} indices in 0..${
          2 * resultType.lanes - 1
        }`,
      );
    }
    return;
  }
  if (
    operation.kind === "primitive" && validateCoreSimdPrimitive(
      module,
      function_,
      operation,
      valueTypes,
    )
  ) return;
  if (operation.kind === "seal.wrap" || operation.kind === "seal.unwrap") {
    requireCoreOperationOperands(function_, operation, 1);
    const operandType = requiredCoreValueType(
      valueTypes,
      function_,
      operation.operands[0],
    );
    if (!sameCoreRuntimeRepresentation(module, operandType, operation.type)) {
      throw new TypeError(
        `Core ${operation.kind} ${function_.name}:${operation.result} changes representation from type ${operandType} to ${operation.type}`,
      );
    }
    return;
  }
  if (
    operation.kind === "resource.move" ||
    operation.kind === "resource.borrow" ||
    operation.kind === "resource.freeze"
  ) {
    requireCoreOperationOperands(function_, operation, 1);
    const operandType = requiredCoreValueType(
      valueTypes,
      function_,
      operation.operands[0],
    );
    if (operandType !== operation.type) {
      throw new TypeError(
        `Core ${operation.kind} ${function_.name}:${operation.result} changes type ${operandType} to ${operation.type}`,
      );
    }
    return;
  }
  if (
    operation.kind === "resource.drop" ||
    operation.kind === "region.exit"
  ) {
    requireCoreOperationOperands(function_, operation, 1);
    requireCoreUnitType(module, operation.type, operation.kind);
    requireCoreUnitType(
      module,
      requiredCoreValueType(valueTypes, function_, operation.operands[0]),
      `${operation.kind} operand`,
    );
    return;
  }
  if (operation.kind === "region.enter") {
    requireCoreOperationOperands(function_, operation, 0);
    requireCoreUnitType(module, operation.type, operation.kind);
    return;
  }
  if (operation.kind === "region.allocate") {
    requireCoreOperationOperands(function_, operation, 2);
    requireCoreUnitType(
      module,
      requiredCoreValueType(valueTypes, function_, operation.operands[0]),
      "region.allocate token",
    );
    const allocatedType = requiredCoreValueType(
      valueTypes,
      function_,
      operation.operands[1],
    );
    if (allocatedType !== operation.type) {
      throw new TypeError(
        `Core region.allocate ${function_.name}:${operation.result} changes allocation type ${allocatedType} to ${operation.type}`,
      );
    }
    return;
  }
  if (operation.kind === "call.direct") {
    const callee = module.functions[operation.functionId];
    const signature = module.signatures[callee.signature];
    requireCoreTypes(
      `direct call ${function_.name} -> ${callee.name}`,
      operation.operands.map((operand) =>
        requiredCoreValueType(valueTypes, function_, operand)
      ),
      signature.parameters,
    );
    if (operation.type !== signature.result) {
      throw new TypeError(
        `Core direct call ${function_.name} -> ${callee.name} has result type ${operation.type}; signature returns ${signature.result}`,
      );
    }
    return;
  }
  if (operation.kind === "closure.make") {
    const target = module.functions[operation.functionId];
    const codeSignature = module.signatures[target.signature];
    const closureType = module.types[operation.type];
    if (closureType.kind !== "function") {
      throw new TypeError(
        `Core closure ${function_.name}:${operation.result} for ${target.name} has non-function type ${operation.type} (${closureType.kind})`,
      );
    }
    const closureSignature = module.signatures[closureType.signature];
    if (
      codeSignature.parameters.length <
        closureSignature.parameters.length
    ) {
      throw new TypeError(
        `Core closure ${target.name} exposes ${closureSignature.parameters.length} parameters but its code accepts ${codeSignature.parameters.length}`,
      );
    }
    requireCoreTypes(
      `closure ${target.name} parameters`,
      codeSignature.parameters.slice(0, closureSignature.parameters.length),
      closureSignature.parameters,
    );
    requireCoreTypes(
      `closure ${target.name} captures`,
      operation.operands.map((operand) =>
        requiredCoreValueType(valueTypes, function_, operand)
      ),
      codeSignature.parameters.slice(closureSignature.parameters.length),
    );
    if (codeSignature.result !== closureSignature.result) {
      throw new TypeError(
        `Core closure ${target.name} returns ${codeSignature.result}; closure signature returns ${closureSignature.result}`,
      );
    }
    return;
  }
  if (operation.kind !== "call.indirect") return;
  if (operation.operands.length === 0) {
    throw new TypeError(
      `Core indirect call ${function_.name}:${operation.result} has no closure operand`,
    );
  }
  const closureType = module.types[
    requiredCoreValueType(valueTypes, function_, operation.operands[0])
  ];
  if (
    closureType.kind !== "function" ||
    closureType.signature !== operation.signature
  ) {
    throw new TypeError(
      `Core indirect call ${function_.name}:${operation.result} signature ${operation.signature} disagrees with its closure type`,
    );
  }
  const signature = module.signatures[operation.signature];
  requireCoreTypes(
    `indirect call ${function_.name}:${operation.result}`,
    operation.operands.slice(1).map((operand) =>
      requiredCoreValueType(valueTypes, function_, operand)
    ),
    signature.parameters,
  );
  if (operation.type !== signature.result) {
    throw new TypeError(
      `Core indirect call ${function_.name}:${operation.result} has result type ${operation.type}; signature returns ${signature.result}`,
    );
  }
}

function sameCoreRuntimeRepresentation(
  module: CoreModule,
  left: CoreTypeId,
  right: CoreTypeId,
): boolean {
  return JSON.stringify(module.types[left]) ===
    JSON.stringify(module.types[right]);
}

function validateCoreStoreOperation(
  module: CoreModule,
  function_: CoreFunction,
  operation: Extract<
    CoreOperation,
    { readonly kind: `store.${string}` }
  >,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
): void {
  const resultType = module.types[operation.type];
  if (operation.kind === "store.empty" || operation.kind === "store.new") {
    if (resultType.kind !== "store") {
      throw new TypeError(
        `Core ${operation.kind} ${function_.name}:${operation.result} has non-store result ${operation.type}`,
      );
    }
    const expectedOperands = operation.kind === "store.empty" ? 0 : 2;
    requireCoreOperationOperands(function_, operation, expectedOperands);
    if (operation.kind === "store.empty") return;
    requireCoreI64Type(
      module,
      requiredCoreValueType(valueTypes, function_, operation.operands[0]),
      `${operation.kind} length`,
    );
    const initial = requiredCoreValueType(
      valueTypes,
      function_,
      operation.operands[1],
    );
    if (initial !== resultType.element) {
      throw new TypeError(
        `Core ${operation.kind} ${function_.name}:${operation.result} initial type ${initial} differs from element ${resultType.element}`,
      );
    }
    return;
  }
  requireCoreOperationOperands(
    function_,
    operation,
    operation.kind === "store.length"
      ? 1
      : operation.kind === "store.read"
      ? 2
      : 3,
  );
  const storeTypeId = requiredCoreValueType(
    valueTypes,
    function_,
    operation.operands[0],
  );
  const storeType = module.types[storeTypeId];
  if (storeType.kind !== "store") {
    throw new TypeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} has non-store operand ${storeTypeId}`,
    );
  }
  if (operation.kind === "store.length") {
    requireCoreI64Type(module, operation.type, operation.kind);
    return;
  }
  requireCoreI64Type(
    module,
    requiredCoreValueType(valueTypes, function_, operation.operands[1]),
    `${operation.kind} index or length`,
  );
  if (operation.kind === "store.read") {
    if (operation.type !== storeType.element) {
      throw new TypeError(
        `Core store.read ${function_.name}:${operation.result} result ${operation.type} differs from element ${storeType.element}`,
      );
    }
    return;
  }
  if (operation.type !== storeTypeId) {
    throw new TypeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} changes store type ${storeTypeId} to ${operation.type}`,
    );
  }
  const valueType = requiredCoreValueType(
    valueTypes,
    function_,
    operation.operands[2],
  );
  if (valueType !== storeType.element) {
    throw new TypeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} value type ${valueType} differs from element ${storeType.element}`,
    );
  }
}

function requireCoreI64Type(
  module: CoreModule,
  type: CoreTypeId,
  role: string,
): void {
  const coreType = module.types[type];
  if (coreType.kind === "scalar" && coreType.scalar === "i64") return;
  throw new TypeError(`Core ${role} has non-i64 type ${type}`);
}

function validateCoreSimdPrimitive(
  module: CoreModule,
  function_: CoreFunction,
  operation: Extract<CoreOperation, { readonly kind: "primitive" }>,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
): boolean {
  const extractIds = [
    PrimitiveId.f32x4ExtractLane0,
    PrimitiveId.f32x4ExtractLane1,
    PrimitiveId.f32x4ExtractLane2,
    PrimitiveId.f32x4ExtractLane3,
  ] as const;
  const replaceIds = [
    PrimitiveId.f32x4ReplaceLane0,
    PrimitiveId.f32x4ReplaceLane1,
    PrimitiveId.f32x4ReplaceLane2,
    PrimitiveId.f32x4ReplaceLane3,
  ] as const;
  const arithmeticIds = [
    PrimitiveId.f32x4Add,
    PrimitiveId.f32x4Subtract,
    PrimitiveId.f32x4Multiply,
    PrimitiveId.f32x4Divide,
  ] as const;
  const comparisonIds = [
    PrimitiveId.f32x4Equal,
    PrimitiveId.f32x4NotEqual,
    PrimitiveId.f32x4LessThan,
    PrimitiveId.f32x4LessThanOrEqual,
    PrimitiveId.f32x4GreaterThan,
    PrimitiveId.f32x4GreaterThanOrEqual,
  ] as const;
  const simdIds: readonly PrimitiveId[] = [
    PrimitiveId.f32x4Make,
    PrimitiveId.f32x4Splat,
    ...arithmeticIds,
    ...extractIds,
    ...replaceIds,
    ...comparisonIds,
    PrimitiveId.f32x4Select,
  ];
  if (!simdIds.includes(operation.primitiveId)) return false;

  const operandTypes = operation.operands.map((operand) =>
    module.types[requiredCoreValueType(valueTypes, function_, operand)]
  );
  const resultType = module.types[operation.type];
  const isF32 = (type: CoreType): boolean =>
    type.kind === "scalar" && type.scalar === "f32";
  const isF32x4 = (type: CoreType): boolean =>
    type.kind === "vector" && type.lanes === 4 && type.element === "f32";
  const isF32x4Mask = (type: CoreType): boolean =>
    type.kind === "mask" && type.lanes === 4 && type.element === "f32";

  const valid = operation.primitiveId === PrimitiveId.f32x4Make
    ? operandTypes.length === 4 && operandTypes.every(isF32) &&
      isF32x4(resultType)
    : operation.primitiveId === PrimitiveId.f32x4Splat
    ? operandTypes.length === 1 && isF32(operandTypes[0]) && isF32x4(resultType)
    : arithmeticIds.includes(operation.primitiveId as never)
    ? operandTypes.length === 2 && operandTypes.every(isF32x4) &&
      isF32x4(resultType)
    : extractIds.includes(operation.primitiveId as never)
    ? operandTypes.length === 1 && isF32x4(operandTypes[0]) && isF32(resultType)
    : replaceIds.includes(operation.primitiveId as never)
    ? operandTypes.length === 2 && isF32x4(operandTypes[0]) &&
      isF32(operandTypes[1]) && isF32x4(resultType)
    : comparisonIds.includes(operation.primitiveId as never)
    ? operandTypes.length === 2 && operandTypes.every(isF32x4) &&
      isF32x4Mask(resultType)
    : operandTypes.length === 3 && isF32x4Mask(operandTypes[0]) &&
      isF32x4(operandTypes[1]) && isF32x4(operandTypes[2]) &&
      isF32x4(resultType);
  if (!valid) {
    throw new TypeError(
      `Core SIMD primitive ${
        primitiveDescriptor(operation.primitiveId).name
      } ${function_.name}:${operation.result} has an invalid signature`,
    );
  }
  return true;
}

function requireCoreOperationOperands(
  function_: CoreFunction,
  operation: CoreOperation,
  expected: number,
): void {
  if (operation.operands.length === expected) return;
  throw new TypeError(
    `Core ${operation.kind} ${function_.name}:${operation.result} has ${operation.operands.length} operands; expected ${expected}`,
  );
}

function requireCoreUnitType(
  module: CoreModule,
  type: CoreTypeId,
  role: string,
): void {
  const coreType = module.types[type];
  if (coreType?.kind === "scalar" && coreType.scalar === "unit") return;
  throw new TypeError(`Core ${role} has non-unit type ${type}`);
}

function validateCoreTerminator(
  module: CoreModule,
  function_: CoreFunction,
  block: CoreBlock,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
): void {
  if (block.terminator.kind === "conditional_branch") {
    const conditionType = module.types[
      requiredCoreValueType(
        valueTypes,
        function_,
        block.terminator.condition,
      )
    ];
    if (conditionType.kind !== "scalar" || conditionType.scalar !== "i32") {
      throw new TypeError(
        `Core conditional ${function_.name}:${block.id} has non-i32 condition`,
      );
    }
    return;
  }
  if (block.terminator.kind !== "return") return;
  const signature = module.signatures[function_.signature];
  requireCoreTypes(
    `return ${function_.name}:${block.id}`,
    block.terminator.values.map((value) =>
      requiredCoreValueType(valueTypes, function_, value)
    ),
    [signature.result],
  );
}

function requireCoreTypes(
  subject: string,
  actual: readonly CoreTypeId[],
  expected: readonly CoreTypeId[],
): void {
  if (actual.length !== expected.length) {
    throw new TypeError(
      `Core ${subject} supplies ${actual.length} values for ${expected.length} types`,
    );
  }
  for (const [index, type] of actual.entries()) {
    if (type === expected[index]) continue;
    throw new TypeError(
      `Core ${subject} value ${index} has type ${type}; expected ${
        expected[index]
      }`,
    );
  }
}

function validateTerminatorEdges(
  function_: CoreFunction,
  block: CoreBlock,
  definitions: ReadonlyMap<CoreValueId, unknown>,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
  predecessors: Set<CoreBlockId>[],
): void {
  const edge = (
    target: CoreBlockId,
    arguments_: readonly CoreValueId[],
  ): void => {
    requireIndex(target, function_.blocks.length, "branch target");
    const parameters = function_.blocks[target].parameters;
    if (arguments_.length !== parameters.length) {
      throw new TypeError(
        `Core edge ${function_.name}:${block.id} -> ${target} supplies ${arguments_.length} arguments for ${parameters.length} parameters`,
      );
    }
    for (const [index, argument] of arguments_.entries()) {
      const definition = definitions.get(argument) as
        | { readonly block: CoreBlockId; readonly operation: number }
        | undefined;
      if (definition === undefined) {
        throw new TypeError(
          `Core edge ${function_.name}:${block.id} uses undefined value ${argument}`,
        );
      }
      const argumentType = requiredCoreValueType(
        valueTypes,
        function_,
        argument,
      );
      if (argumentType !== parameters[index].type) {
        throw new TypeError(
          `Core edge ${function_.name}:${block.id} argument ${index} has type ${argumentType}; target ${target} expects ${
            parameters[index].type
          }`,
        );
      }
    }
    predecessors[target].add(block.id);
  };
  if (block.terminator.kind === "branch") {
    edge(block.terminator.target, block.terminator.arguments);
  } else if (block.terminator.kind === "conditional_branch") {
    edge(
      block.terminator.trueTarget,
      block.terminator.trueArguments,
    );
    edge(
      block.terminator.falseTarget,
      block.terminator.falseArguments,
    );
  }
}

function calculateDominators(
  function_: CoreFunction,
  predecessors: readonly ReadonlySet<CoreBlockId>[],
): readonly ReadonlySet<CoreBlockId>[] {
  const all = new Set(function_.blocks.map((block) => block.id));
  const dominators = function_.blocks.map((block) =>
    block.id === function_.entryBlock ? new Set([block.id]) : new Set(all)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of function_.blocks) {
      if (block.id === function_.entryBlock) continue;
      const incoming = [...predecessors[block.id]];
      const next = incoming.length === 0 ? new Set([block.id]) : new Set(
        [...dominators[incoming[0]]].filter((candidate) =>
          incoming.slice(1).every((predecessor) =>
            dominators[predecessor].has(candidate)
          )
        ),
      );
      next.add(block.id);
      if (
        next.size !== dominators[block.id].size ||
        [...next].some((candidate) => !dominators[block.id].has(candidate))
      ) {
        dominators[block.id] = next;
        changed = true;
      }
    }
  }
  return dominators;
}

function requireDominatingValue(
  function_: CoreFunction,
  definitions: ReadonlyMap<
    CoreValueId,
    { readonly block: CoreBlockId; readonly operation: number }
  >,
  dominators: readonly ReadonlySet<CoreBlockId>[],
  value: CoreValueId,
  useBlock: CoreBlockId,
  useOperation: number,
): void {
  const definition = definitions.get(value);
  if (definition === undefined) {
    throw new TypeError(
      `Core function ${function_.name} uses undefined value ${value}`,
    );
  }
  if (definition.block === useBlock) {
    if (definition.operation >= useOperation) {
      throw new TypeError(
        `Core function ${function_.name} value ${value} is used before its definition in block ${useBlock}`,
      );
    }
    return;
  }
  if (!dominators[useBlock].has(definition.block)) {
    throw new TypeError(
      `Core function ${function_.name} value ${value} from block ${definition.block} does not dominate block ${useBlock}`,
    );
  }
}

function defineCoreValue(
  definitions: Map<
    CoreValueId,
    { readonly block: CoreBlockId; readonly operation: number }
  >,
  value: CoreValueId,
  block: CoreBlockId,
  operation: number,
  function_: CoreFunction,
): void {
  const previous = definitions.get(value);
  if (previous !== undefined) {
    throw new TypeError(
      `Core function ${function_.name} defines value ${value} in blocks ${previous.block} and ${block}`,
    );
  }
  definitions.set(value, { block, operation });
}

function requiredCoreValueType(
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
  function_: CoreFunction,
  value: CoreValueId,
): CoreTypeId {
  const type = valueTypes.get(value);
  if (type !== undefined) return type;
  throw new TypeError(
    `Core function ${function_.name} has no type for value ${value}`,
  );
}

function terminatorValues(
  terminator: CoreTerminator,
): readonly CoreValueId[] {
  if (terminator.kind === "branch") return terminator.arguments;
  if (terminator.kind === "conditional_branch") {
    return [
      terminator.condition,
      ...terminator.trueArguments,
      ...terminator.falseArguments,
    ];
  }
  return terminator.kind === "return" ? terminator.values : [];
}

function requireIndex(index: number, length: number, subject: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new RangeError(
      `Core ${subject} ${index} is outside table length ${length}`,
    );
  }
}

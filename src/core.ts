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
export type CoreVectorElement = "i8" | "i16" | "i32" | "i64" | "f32" | "f64";

export type CoreType =
  | {
    readonly kind: "scalar";
    readonly scalar: CoreScalar;
  }
  | {
    readonly kind: "vector";
    readonly lanes: 2 | 4 | 8 | 16;
    readonly element: CoreVectorElement;
  }
  | {
    readonly kind: "mask";
    readonly lanes: 2 | 4 | 8 | 16;
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

export type CoreVectorLoadMode =
  | "128"
  | "8x8_s"
  | "8x8_u"
  | "16x4_s"
  | "16x4_u"
  | "32x2_s"
  | "32x2_u"
  | "8_splat"
  | "16_splat"
  | "32_splat"
  | "64_splat"
  | "32_zero"
  | "64_zero"
  | "8_lane"
  | "16_lane"
  | "32_lane"
  | "64_lane";

export type CoreVectorStoreMode =
  | "128"
  | "8_lane"
  | "16_lane"
  | "32_lane"
  | "64_lane";

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
    readonly kind: "vector.load";
    readonly mode: CoreVectorLoadMode;
    readonly alignmentExponent: number;
    readonly offset: number;
    readonly lane?: number;
  })
  | (CoreOperationBase & {
    readonly kind: "vector.store";
    readonly mode: CoreVectorStoreMode;
    readonly alignmentExponent: number;
    readonly offset: number;
    readonly lane?: number;
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
  readonly memory?: {
    readonly minimumPages: number;
    readonly maximumPages?: number;
    readonly exportName?: string;
  };
};

export function validateCore(module: CoreModule): void {
  if (module.memory !== undefined) {
    const { minimumPages, maximumPages, exportName } = module.memory;
    if (
      !Number.isSafeInteger(minimumPages) || minimumPages < 0 ||
      minimumPages > 65_536
    ) {
      throw new RangeError(
        `Core memory minimum must be in 0..65536 pages; received ${minimumPages}`,
      );
    }
    if (
      maximumPages !== undefined &&
      (!Number.isSafeInteger(maximumPages) || maximumPages < minimumPages ||
        maximumPages > 65_536)
    ) {
      throw new RangeError(
        `Core memory maximum must be in ${minimumPages}..65536 pages; received ${maximumPages}`,
      );
    }
    if (exportName !== undefined && exportName.length === 0) {
      throw new TypeError("Core memory export name cannot be empty");
    }
  }
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
    const elementBits = type.element === "i8"
      ? 8
      : type.element === "i16"
      ? 16
      : type.element === "i64" || type.element === "f64"
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
  if (operation.kind === "vector.load" || operation.kind === "vector.store") {
    validateCoreVectorMemoryOperation(module, function_, operation, valueTypes);
    return;
  }
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

function validateCoreVectorMemoryOperation(
  module: CoreModule,
  function_: CoreFunction,
  operation: Extract<
    CoreOperation,
    { readonly kind: "vector.load" | "vector.store" }
  >,
  valueTypes: ReadonlyMap<CoreValueId, CoreTypeId>,
): void {
  if (module.memory === undefined) {
    throw new TypeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} requires a declared linear memory`,
    );
  }
  if (
    !Number.isSafeInteger(operation.offset) || operation.offset < 0 ||
    operation.offset > 0xffff_ffff
  ) {
    throw new RangeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} has invalid offset ${operation.offset}`,
    );
  }
  const laneBits = operation.mode.endsWith("_lane")
    ? Number(operation.mode.slice(0, operation.mode.indexOf("_")))
    : undefined;
  const naturalAlignmentExponent = operation.mode === "128"
    ? 4
    : operation.mode.startsWith("8x8") ||
        operation.mode.startsWith("16x4") ||
        operation.mode.startsWith("32x2")
    ? 3
    : operation.mode.startsWith("8")
    ? 0
    : operation.mode.startsWith("16")
    ? 1
    : operation.mode.startsWith("32")
    ? 2
    : 3;
  if (
    !Number.isSafeInteger(operation.alignmentExponent) ||
    operation.alignmentExponent < 0 ||
    operation.alignmentExponent > naturalAlignmentExponent
  ) {
    throw new RangeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} alignment ${operation.alignmentExponent} exceeds natural exponent ${naturalAlignmentExponent}`,
    );
  }
  const expectedOperands = laneBits === undefined
    ? operation.kind === "vector.load" ? 1 : 2
    : 2;
  requireCoreOperationOperands(function_, operation, expectedOperands);
  const addressType = module.types[
    requiredCoreValueType(valueTypes, function_, operation.operands[0])
  ];
  if (addressType.kind !== "scalar" || addressType.scalar !== "i32") {
    throw new TypeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} has a non-i32 address`,
    );
  }
  const vectorTypeId = operation.kind === "vector.load"
    ? operation.type
    : requiredCoreValueType(valueTypes, function_, operation.operands[1]);
  const vectorType = module.types[vectorTypeId];
  if (vectorType.kind !== "vector") {
    throw new TypeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} has non-vector type ${vectorTypeId}`,
    );
  }
  if (operation.kind === "vector.store") {
    requireCoreUnitType(module, operation.type, operation.kind);
  } else if (laneBits !== undefined) {
    const sourceType = requiredCoreValueType(
      valueTypes,
      function_,
      operation.operands[1],
    );
    if (sourceType !== operation.type) {
      throw new TypeError(
        `Core vector.load ${function_.name}:${operation.result} changes lane source type ${sourceType} to ${operation.type}`,
      );
    }
  }
  if (laneBits !== undefined) {
    const elementBits = vectorType.element === "i8"
      ? 8
      : vectorType.element === "i16"
      ? 16
      : vectorType.element === "i32" || vectorType.element === "f32"
      ? 32
      : 64;
    if (elementBits !== laneBits) {
      throw new TypeError(
        `Core ${operation.kind} ${function_.name}:${operation.result} ${operation.mode} cannot address ${vectorType.element} lanes`,
      );
    }
    if (
      operation.lane === undefined || !Number.isSafeInteger(operation.lane) ||
      operation.lane < 0 || operation.lane >= vectorType.lanes
    ) {
      throw new RangeError(
        `Core ${operation.kind} ${function_.name}:${operation.result} has invalid ${vectorType.element} lane ${operation.lane}`,
      );
    }
    return;
  }
  if (operation.lane !== undefined) {
    throw new TypeError(
      `Core ${operation.kind} ${function_.name}:${operation.result} ${operation.mode} cannot carry lane ${operation.lane}`,
    );
  }
  const expectedShapes = operation.mode.startsWith("8_splat")
    ? ["i8x16"]
    : operation.mode.startsWith("16_splat") || operation.mode.startsWith("8x8")
    ? ["i16x8"]
    : operation.mode.startsWith("16x4")
    ? ["i32x4"]
    : operation.mode.startsWith("32x2")
    ? ["i64x2"]
    : operation.mode.startsWith("32_splat") || operation.mode === "32_zero"
    ? ["i32x4", "f32x4"]
    : operation.mode.startsWith("64_splat") || operation.mode === "64_zero"
    ? ["i64x2", "f64x2"]
    : undefined;
  const actualShape = `${vectorType.element}x${vectorType.lanes}`;
  if (expectedShapes === undefined || expectedShapes.includes(actualShape)) {
    return;
  }
  throw new TypeError(
    `Core ${operation.kind} ${function_.name}:${operation.result} ${operation.mode} returns ${
      expectedShapes.join(" or ")
    }, not ${actualShape}`,
  );
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
  if (operation.primitiveId >= PrimitiveId.i8x16Make) {
    type SimdTypeName =
      | "i32"
      | "i64"
      | "f32"
      | "f64"
      | "i8x16"
      | "i8x16-mask"
      | "i16x8"
      | "i16x8-mask"
      | "i32x4"
      | "i32x4-mask"
      | "i64x2"
      | "i64x2-mask"
      | "f32x4"
      | "f32x4-mask"
      | "f64x2"
      | "f64x2-mask";
    const simdTypeName = (typeId: CoreTypeId): SimdTypeName | undefined => {
      const type = module.types[typeId];
      if (type.kind === "scalar") {
        return type.scalar === "unit" ? undefined : type.scalar;
      }
      if (type.kind !== "vector" && type.kind !== "mask") return undefined;
      const shape = `${type.element}x${type.lanes}`;
      if (
        shape !== "i8x16" && shape !== "i16x8" && shape !== "i32x4" &&
        shape !== "i64x2" && shape !== "f32x4" && shape !== "f64x2"
      ) return undefined;
      return (type.kind === "mask" ? `${shape}-mask` : shape) as SimdTypeName;
    };
    const actualOperands = operation.operands.map((operand) =>
      simdTypeName(requiredCoreValueType(valueTypes, function_, operand))
    );
    const actualResult = simdTypeName(operation.type);
    const id = operation.primitiveId;
    let expectedOperands: readonly SimdTypeName[] | undefined;
    let expectedResult: SimdTypeName | undefined;
    const signature = (
      operands: readonly SimdTypeName[],
      result: SimdTypeName,
    ): void => {
      expectedOperands = operands;
      expectedResult = result;
    };

    if (id === PrimitiveId.i8x16Make) signature(Array(16).fill("i32"), "i8x16");
    else if (id <= PrimitiveId.i8x16ExtractLaneUnsigned15) {
      signature(["i8x16"], "i32");
    } else if (id <= PrimitiveId.i8x16ReplaceLane15) {
      signature(["i8x16", "i32"], "i8x16");
    } else if (id <= PrimitiveId.i8x16AndNot) {
      signature(["i8x16", "i8x16"], "i8x16");
    } else if (id <= PrimitiveId.i8x16GreaterThanOrEqualUnsigned) {
      signature(["i8x16", "i8x16"], "i8x16-mask");
    } else if (id <= PrimitiveId.i8x16PopulationCount) {
      signature(["i8x16"], "i8x16");
    } else if (id <= PrimitiveId.i8x16NarrowI16x8Unsigned) {
      signature(["i16x8", "i16x8"], "i8x16");
    } else if (id <= PrimitiveId.i8x16AverageUnsigned) {
      signature(["i8x16", "i8x16"], "i8x16");
    } else if (id === PrimitiveId.i16x8Make) {
      signature(Array(8).fill("i32"), "i16x8");
    } else if (id <= PrimitiveId.i16x8ExtractLaneUnsigned7) {
      signature(["i16x8"], "i32");
    } else if (id <= PrimitiveId.i16x8ReplaceLane7) {
      signature(["i16x8", "i32"], "i16x8");
    } else if (id === PrimitiveId.i16x8AndNot) {
      signature(["i16x8", "i16x8"], "i16x8");
    } else if (id <= PrimitiveId.i16x8GreaterThanOrEqualUnsigned) {
      signature(["i16x8", "i16x8"], "i16x8-mask");
    } else if (id <= PrimitiveId.i16x8Q15MultiplyRoundSaturateSigned) {
      signature(
        id <= PrimitiveId.i16x8Negate ? ["i16x8"] : ["i16x8", "i16x8"],
        "i16x8",
      );
    } else if (id <= PrimitiveId.i16x8NarrowI32x4Unsigned) {
      signature(["i32x4", "i32x4"], "i16x8");
    } else if (id <= PrimitiveId.i16x8ExtendHighI8x16Unsigned) {
      signature(["i8x16"], "i16x8");
    } else if (id <= PrimitiveId.i16x8AverageUnsigned) {
      signature(["i16x8", "i16x8"], "i16x8");
    } else if (id <= PrimitiveId.i16x8ExtendedMultiplyHighI8x16Unsigned) {
      signature(["i8x16", "i8x16"], "i16x8");
    } else if (id <= PrimitiveId.i16x8ExtendedAddPairwiseI8x16Unsigned) {
      signature(["i8x16"], "i16x8");
    } else if (id === PrimitiveId.i32x4AndNot) {
      signature(["i32x4", "i32x4"], "i32x4");
    } else if (id <= PrimitiveId.i32x4Negate) signature(["i32x4"], "i32x4");
    else if (id <= PrimitiveId.i32x4ExtendHighI16x8Unsigned) {
      signature(["i16x8"], "i32x4");
    } else if (id <= PrimitiveId.i32x4ExtendedMultiplyHighI16x8Unsigned) {
      signature(["i16x8", "i16x8"], "i32x4");
    } else if (id <= PrimitiveId.i32x4ExtendedAddPairwiseI16x8Unsigned) {
      signature(["i16x8"], "i32x4");
    } else if (id === PrimitiveId.i64x2Make) signature(["i64", "i64"], "i64x2");
    else if (id === PrimitiveId.i64x2Splat) signature(["i64"], "i64x2");
    else if (id <= PrimitiveId.i64x2ExtractLane1) signature(["i64x2"], "i64");
    else if (id <= PrimitiveId.i64x2ReplaceLane1) {
      signature(["i64x2", "i64"], "i64x2");
    } else if (id <= PrimitiveId.i64x2Xor) {
      signature(["i64x2", "i64x2"], "i64x2");
    } else if (id === PrimitiveId.i64x2Not) signature(["i64x2"], "i64x2");
    else if (id === PrimitiveId.i64x2AndNot) {
      signature(["i64x2", "i64x2"], "i64x2");
    } else if (id <= PrimitiveId.i64x2ShiftRightUnsigned) {
      signature(["i64x2", "i32"], "i64x2");
    } else if (id <= PrimitiveId.i64x2GreaterThanOrEqualSigned) {
      signature(["i64x2", "i64x2"], "i64x2-mask");
    } else if (id === PrimitiveId.i64x2Select) {
      signature(["i64x2-mask", "i64x2", "i64x2"], "i64x2");
    } else if (id <= PrimitiveId.i64x2MaskAnyTrue) {
      signature(["i64x2-mask"], "i32");
    } else if (id <= PrimitiveId.i64x2Negate) signature(["i64x2"], "i64x2");
    else if (id <= PrimitiveId.i64x2ExtendHighI32x4Unsigned) {
      signature(["i32x4"], "i64x2");
    } else if (id <= PrimitiveId.i64x2ExtendedMultiplyHighI32x4Unsigned) {
      signature(["i32x4", "i32x4"], "i64x2");
    } else if (id === PrimitiveId.f64x2Make) signature(["f64", "f64"], "f64x2");
    else if (id === PrimitiveId.f64x2Splat) signature(["f64"], "f64x2");
    else if (id <= PrimitiveId.f64x2ExtractLane1) signature(["f64x2"], "f64");
    else if (id <= PrimitiveId.f64x2ReplaceLane1) {
      signature(["f64x2", "f64"], "f64x2");
    } else if (id <= PrimitiveId.f64x2Divide) {
      signature(["f64x2", "f64x2"], "f64x2");
    } else if (id <= PrimitiveId.f64x2GreaterThanOrEqual) {
      signature(["f64x2", "f64x2"], "f64x2-mask");
    } else if (id === PrimitiveId.f64x2Select) {
      signature(["f64x2-mask", "f64x2", "f64x2"], "f64x2");
    } else if (id <= PrimitiveId.f64x2MaskAnyTrue) {
      signature(["f64x2-mask"], "i32");
    } else if (id <= PrimitiveId.f64x2Nearest) signature(["f64x2"], "f64x2");
    else if (id <= PrimitiveId.f64x2PseudoMaximum) {
      signature(["f64x2", "f64x2"], "f64x2");
    } else if (id === PrimitiveId.f64x2PromoteLowF32x4) {
      signature(["f32x4"], "f64x2");
    } else if (id === PrimitiveId.f32x4DemoteF64x2Zero) {
      signature(["f64x2"], "f32x4");
    } else if (id <= PrimitiveId.i32x4TruncateSaturateF64x2UnsignedZero) {
      signature(["f64x2"], "i32x4");
    } else if (id <= PrimitiveId.f64x2ConvertLowI32x4Unsigned) {
      signature(["i32x4"], "f64x2");
    } else if (id === PrimitiveId.i8x16RelaxedSwizzle) {
      signature(["i8x16", "i8x16"], "i8x16");
    } else if (id <= PrimitiveId.i32x4RelaxedTruncateF32x4Unsigned) {
      signature(["f32x4"], "i32x4");
    } else if (id <= PrimitiveId.i32x4RelaxedTruncateF64x2UnsignedZero) {
      signature(["f64x2"], "i32x4");
    } else if (id <= PrimitiveId.f32x4RelaxedNegativeMultiplyAdd) {
      signature(["f32x4", "f32x4", "f32x4"], "f32x4");
    } else if (id <= PrimitiveId.f64x2RelaxedNegativeMultiplyAdd) {
      signature(["f64x2", "f64x2", "f64x2"], "f64x2");
    } else if (id === PrimitiveId.i8x16RelaxedLaneSelect) {
      signature(["i8x16-mask", "i8x16", "i8x16"], "i8x16");
    } else if (id === PrimitiveId.i16x8RelaxedLaneSelect) {
      signature(["i16x8-mask", "i16x8", "i16x8"], "i16x8");
    } else if (id === PrimitiveId.i32x4RelaxedLaneSelect) {
      signature(["i32x4-mask", "i32x4", "i32x4"], "i32x4");
    } else if (id === PrimitiveId.i64x2RelaxedLaneSelect) {
      signature(["i64x2-mask", "i64x2", "i64x2"], "i64x2");
    } else if (id <= PrimitiveId.f32x4RelaxedMaximum) {
      signature(["f32x4", "f32x4"], "f32x4");
    } else if (id <= PrimitiveId.f64x2RelaxedMaximum) {
      signature(["f64x2", "f64x2"], "f64x2");
    } else if (id === PrimitiveId.i16x8RelaxedQ15MultiplyRoundSigned) {
      signature(["i16x8", "i16x8"], "i16x8");
    } else if (id === PrimitiveId.i16x8RelaxedDotI8x16I7x16Signed) {
      signature(["i8x16", "i8x16"], "i16x8");
    } else if (id === PrimitiveId.i32x4RelaxedDotI8x16I7x16AddSigned) {
      signature(["i8x16", "i8x16", "i32x4"], "i32x4");
    }

    const valid = expectedOperands !== undefined &&
      actualResult === expectedResult &&
      actualOperands.length === expectedOperands.length &&
      actualOperands.every((type, index) => type === expectedOperands?.[index]);
    if (!valid) {
      throw new TypeError(
        `Core SIMD primitive ${
          primitiveDescriptor(id).name
        } ${function_.name}:${operation.result} has an invalid signature`,
      );
    }
    return true;
  }
  const f32ExtractIds = [
    PrimitiveId.f32x4ExtractLane0,
    PrimitiveId.f32x4ExtractLane1,
    PrimitiveId.f32x4ExtractLane2,
    PrimitiveId.f32x4ExtractLane3,
  ] as const;
  const f32ReplaceIds = [
    PrimitiveId.f32x4ReplaceLane0,
    PrimitiveId.f32x4ReplaceLane1,
    PrimitiveId.f32x4ReplaceLane2,
    PrimitiveId.f32x4ReplaceLane3,
  ] as const;
  const i32ExtractIds = [
    PrimitiveId.i32x4ExtractLane0,
    PrimitiveId.i32x4ExtractLane1,
    PrimitiveId.i32x4ExtractLane2,
    PrimitiveId.i32x4ExtractLane3,
  ] as const;
  const i32ReplaceIds = [
    PrimitiveId.i32x4ReplaceLane0,
    PrimitiveId.i32x4ReplaceLane1,
    PrimitiveId.i32x4ReplaceLane2,
    PrimitiveId.i32x4ReplaceLane3,
  ] as const;
  const i32BinaryIds = [
    PrimitiveId.i32x4Add,
    PrimitiveId.i32x4Subtract,
    PrimitiveId.i32x4Multiply,
    PrimitiveId.i32x4And,
    PrimitiveId.i32x4Or,
    PrimitiveId.i32x4Xor,
    PrimitiveId.i32x4MinimumSigned,
    PrimitiveId.i32x4MinimumUnsigned,
    PrimitiveId.i32x4MaximumSigned,
    PrimitiveId.i32x4MaximumUnsigned,
  ] as const;
  const i32ShiftIds = [
    PrimitiveId.i32x4ShiftLeft,
    PrimitiveId.i32x4ShiftRightSigned,
    PrimitiveId.i32x4ShiftRightUnsigned,
  ] as const;
  const i32ComparisonIds = [
    PrimitiveId.i32x4Equal,
    PrimitiveId.i32x4NotEqual,
    PrimitiveId.i32x4LessThanSigned,
    PrimitiveId.i32x4LessThanUnsigned,
    PrimitiveId.i32x4GreaterThanSigned,
    PrimitiveId.i32x4GreaterThanUnsigned,
    PrimitiveId.i32x4LessThanOrEqualSigned,
    PrimitiveId.i32x4LessThanOrEqualUnsigned,
    PrimitiveId.i32x4GreaterThanOrEqualSigned,
    PrimitiveId.i32x4GreaterThanOrEqualUnsigned,
  ] as const;
  const f32BinaryIds = [
    PrimitiveId.f32x4Add,
    PrimitiveId.f32x4Subtract,
    PrimitiveId.f32x4Multiply,
    PrimitiveId.f32x4Divide,
    PrimitiveId.f32x4Minimum,
    PrimitiveId.f32x4Maximum,
    PrimitiveId.f32x4PseudoMinimum,
    PrimitiveId.f32x4PseudoMaximum,
  ] as const;
  const f32UnaryIds = [
    PrimitiveId.f32x4Absolute,
    PrimitiveId.f32x4Negate,
    PrimitiveId.f32x4SquareRoot,
    PrimitiveId.f32x4Ceiling,
    PrimitiveId.f32x4Floor,
    PrimitiveId.f32x4Truncate,
    PrimitiveId.f32x4Nearest,
  ] as const;
  const f32ComparisonIds = [
    PrimitiveId.f32x4Equal,
    PrimitiveId.f32x4NotEqual,
    PrimitiveId.f32x4LessThan,
    PrimitiveId.f32x4LessThanOrEqual,
    PrimitiveId.f32x4GreaterThan,
    PrimitiveId.f32x4GreaterThanOrEqual,
  ] as const;
  const i8BinaryIds = [
    PrimitiveId.i8x16Add,
    PrimitiveId.i8x16Subtract,
    PrimitiveId.i8x16And,
    PrimitiveId.i8x16Or,
    PrimitiveId.i8x16Xor,
    PrimitiveId.i8x16MinimumSigned,
    PrimitiveId.i8x16MinimumUnsigned,
    PrimitiveId.i8x16MaximumSigned,
    PrimitiveId.i8x16MaximumUnsigned,
  ] as const;
  const i8ShiftIds = [
    PrimitiveId.i8x16ShiftLeft,
    PrimitiveId.i8x16ShiftRightSigned,
    PrimitiveId.i8x16ShiftRightUnsigned,
  ] as const;
  const i8ComparisonIds = [
    PrimitiveId.i8x16Equal,
    PrimitiveId.i8x16LessThanSigned,
    PrimitiveId.i8x16LessThanUnsigned,
  ] as const;
  const i16BinaryIds = [
    PrimitiveId.i16x8Add,
    PrimitiveId.i16x8Subtract,
    PrimitiveId.i16x8Multiply,
    PrimitiveId.i16x8And,
    PrimitiveId.i16x8Or,
    PrimitiveId.i16x8Xor,
    PrimitiveId.i16x8MinimumSigned,
    PrimitiveId.i16x8MinimumUnsigned,
    PrimitiveId.i16x8MaximumSigned,
    PrimitiveId.i16x8MaximumUnsigned,
  ] as const;
  const i16ShiftIds = [
    PrimitiveId.i16x8ShiftLeft,
    PrimitiveId.i16x8ShiftRightSigned,
    PrimitiveId.i16x8ShiftRightUnsigned,
  ] as const;
  const i16ComparisonIds = [
    PrimitiveId.i16x8Equal,
    PrimitiveId.i16x8LessThanSigned,
    PrimitiveId.i16x8LessThanUnsigned,
  ] as const;
  const simdIds: readonly PrimitiveId[] = [
    PrimitiveId.f32x4Make,
    PrimitiveId.f32x4Splat,
    ...f32BinaryIds,
    ...f32UnaryIds,
    ...f32ExtractIds,
    ...f32ReplaceIds,
    ...f32ComparisonIds,
    PrimitiveId.f32x4Select,
    PrimitiveId.f32x4ConvertI32x4Signed,
    PrimitiveId.f32x4ConvertI32x4Unsigned,
    PrimitiveId.f32x4MaskBitmask,
    PrimitiveId.f32x4MaskAllTrue,
    PrimitiveId.f32x4MaskAnyTrue,
    PrimitiveId.i32x4Make,
    PrimitiveId.i32x4Splat,
    ...i32BinaryIds,
    ...i32ShiftIds,
    ...i32ComparisonIds,
    PrimitiveId.i32x4Not,
    PrimitiveId.i32x4Select,
    ...i32ExtractIds,
    ...i32ReplaceIds,
    PrimitiveId.i32x4MaskBitmask,
    PrimitiveId.i32x4MaskAllTrue,
    PrimitiveId.i32x4MaskAnyTrue,
    PrimitiveId.i32x4TruncateSaturateF32x4Signed,
    PrimitiveId.i32x4TruncateSaturateF32x4Unsigned,
    PrimitiveId.i8x16Splat,
    ...i8BinaryIds,
    ...i8ShiftIds,
    ...i8ComparisonIds,
    PrimitiveId.i8x16Not,
    PrimitiveId.i8x16Select,
    PrimitiveId.i8x16MaskBitmask,
    PrimitiveId.i8x16MaskAllTrue,
    PrimitiveId.i8x16MaskAnyTrue,
    PrimitiveId.i16x8Splat,
    ...i16BinaryIds,
    ...i16ShiftIds,
    ...i16ComparisonIds,
    PrimitiveId.i16x8Not,
    PrimitiveId.i16x8Select,
    PrimitiveId.i16x8MaskBitmask,
    PrimitiveId.i16x8MaskAllTrue,
    PrimitiveId.i16x8MaskAnyTrue,
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
  const isI32 = (type: CoreType): boolean =>
    type.kind === "scalar" && type.scalar === "i32";
  const isI32x4 = (type: CoreType): boolean =>
    type.kind === "vector" && type.lanes === 4 && type.element === "i32";
  const isI32x4Mask = (type: CoreType): boolean =>
    type.kind === "mask" && type.lanes === 4 && type.element === "i32";
  const isI8x16 = (type: CoreType): boolean =>
    type.kind === "vector" && type.lanes === 16 && type.element === "i8";
  const isI8x16Mask = (type: CoreType): boolean =>
    type.kind === "mask" && type.lanes === 16 && type.element === "i8";
  const isI16x8 = (type: CoreType): boolean =>
    type.kind === "vector" && type.lanes === 8 && type.element === "i16";
  const isI16x8Mask = (type: CoreType): boolean =>
    type.kind === "mask" && type.lanes === 8 && type.element === "i16";
  const unary = (
    operand: (type: CoreType) => boolean,
    result: (type: CoreType) => boolean,
  ) =>
    operandTypes.length === 1 && operand(operandTypes[0]) && result(resultType);
  const binary = (
    operand: (type: CoreType) => boolean,
    result: (type: CoreType) => boolean,
  ) =>
    operandTypes.length === 2 && operandTypes.every(operand) &&
    result(resultType);
  const shift = (vector: (type: CoreType) => boolean) =>
    operandTypes.length === 2 && vector(operandTypes[0]) &&
    isI32(operandTypes[1]) && vector(resultType);
  const select = (
    vector: (type: CoreType) => boolean,
    mask: (type: CoreType) => boolean,
  ) =>
    operandTypes.length === 3 && mask(operandTypes[0]) &&
    vector(operandTypes[1]) && vector(operandTypes[2]) && vector(resultType);

  const valid = operation.primitiveId === PrimitiveId.f32x4Make
    ? operandTypes.length === 4 && operandTypes.every(isF32) &&
      isF32x4(resultType)
    : operation.primitiveId === PrimitiveId.f32x4Splat
    ? operandTypes.length === 1 && isF32(operandTypes[0]) && isF32x4(resultType)
    : f32BinaryIds.includes(operation.primitiveId as never)
    ? binary(isF32x4, isF32x4)
    : f32UnaryIds.includes(operation.primitiveId as never)
    ? unary(isF32x4, isF32x4)
    : f32ExtractIds.includes(operation.primitiveId as never)
    ? unary(isF32x4, isF32)
    : f32ReplaceIds.includes(operation.primitiveId as never)
    ? operandTypes.length === 2 && isF32x4(operandTypes[0]) &&
      isF32(operandTypes[1]) && isF32x4(resultType)
    : f32ComparisonIds.includes(operation.primitiveId as never)
    ? binary(isF32x4, isF32x4Mask)
    : operation.primitiveId === PrimitiveId.f32x4Select
    ? select(isF32x4, isF32x4Mask)
    : operation.primitiveId === PrimitiveId.f32x4ConvertI32x4Signed ||
        operation.primitiveId === PrimitiveId.f32x4ConvertI32x4Unsigned
    ? unary(isI32x4, isF32x4)
    : operation.primitiveId === PrimitiveId.f32x4MaskBitmask ||
        operation.primitiveId === PrimitiveId.f32x4MaskAllTrue ||
        operation.primitiveId === PrimitiveId.f32x4MaskAnyTrue
    ? unary(isF32x4Mask, isI32)
    : operation.primitiveId === PrimitiveId.i32x4Make
    ? operandTypes.length === 4 && operandTypes.every(isI32) &&
      isI32x4(resultType)
    : operation.primitiveId === PrimitiveId.i32x4Splat
    ? unary(isI32, isI32x4)
    : i32BinaryIds.includes(operation.primitiveId as never)
    ? binary(isI32x4, isI32x4)
    : operation.primitiveId === PrimitiveId.i32x4Not
    ? unary(isI32x4, isI32x4)
    : i32ShiftIds.includes(operation.primitiveId as never)
    ? shift(isI32x4)
    : i32ComparisonIds.includes(operation.primitiveId as never)
    ? binary(isI32x4, isI32x4Mask)
    : operation.primitiveId === PrimitiveId.i32x4Select
    ? select(isI32x4, isI32x4Mask)
    : i32ExtractIds.includes(operation.primitiveId as never)
    ? unary(isI32x4, isI32)
    : i32ReplaceIds.includes(operation.primitiveId as never)
    ? operandTypes.length === 2 && isI32x4(operandTypes[0]) &&
      isI32(operandTypes[1]) && isI32x4(resultType)
    : operation.primitiveId === PrimitiveId.i32x4MaskBitmask ||
        operation.primitiveId === PrimitiveId.i32x4MaskAllTrue ||
        operation.primitiveId === PrimitiveId.i32x4MaskAnyTrue
    ? unary(isI32x4Mask, isI32)
    : operation.primitiveId === PrimitiveId.i32x4TruncateSaturateF32x4Signed ||
        operation.primitiveId === PrimitiveId.i32x4TruncateSaturateF32x4Unsigned
    ? unary(isF32x4, isI32x4)
    : operation.primitiveId === PrimitiveId.i8x16Splat
    ? unary(isI32, isI8x16)
    : i8BinaryIds.includes(operation.primitiveId as never)
    ? binary(isI8x16, isI8x16)
    : operation.primitiveId === PrimitiveId.i8x16Not
    ? unary(isI8x16, isI8x16)
    : i8ShiftIds.includes(operation.primitiveId as never)
    ? shift(isI8x16)
    : i8ComparisonIds.includes(operation.primitiveId as never)
    ? binary(isI8x16, isI8x16Mask)
    : operation.primitiveId === PrimitiveId.i8x16Select
    ? select(isI8x16, isI8x16Mask)
    : operation.primitiveId === PrimitiveId.i8x16MaskBitmask ||
        operation.primitiveId === PrimitiveId.i8x16MaskAllTrue ||
        operation.primitiveId === PrimitiveId.i8x16MaskAnyTrue
    ? unary(isI8x16Mask, isI32)
    : operation.primitiveId === PrimitiveId.i16x8Splat
    ? unary(isI32, isI16x8)
    : i16BinaryIds.includes(operation.primitiveId as never)
    ? binary(isI16x8, isI16x8)
    : operation.primitiveId === PrimitiveId.i16x8Not
    ? unary(isI16x8, isI16x8)
    : i16ShiftIds.includes(operation.primitiveId as never)
    ? shift(isI16x8)
    : i16ComparisonIds.includes(operation.primitiveId as never)
    ? binary(isI16x8, isI16x8Mask)
    : operation.primitiveId === PrimitiveId.i16x8Select
    ? select(isI16x8, isI16x8Mask)
    : unary(isI16x8Mask, isI32);
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

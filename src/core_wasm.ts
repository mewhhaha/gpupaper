import type {
  CoreBlockId,
  CoreFunction,
  CoreFunctionId,
  CoreModule,
  CoreOperation,
  CoreSignatureId,
  CoreTerminator,
  CoreTypeId,
  CoreValueId,
} from "./core.ts";
import { contentIdentity } from "./content_identity.ts";
import { validateCore } from "./core.ts";
import {
  managedProductIndexImportName,
  managedProductIndexUpdateImportName,
  managedProductMakeImportName,
  managedProductProjectImportName,
  managedProductUpdateImportName,
  managedSumMakeImportName,
  managedSumPayloadImportName,
  managedSumTagImportName,
} from "./runtime_layout.ts";
import {
  coreRuntimeImportModule,
  primitiveDescriptor,
  PrimitiveId,
  type PrimitiveId as PrimitiveIdType,
  primitiveRuntimeImportName,
} from "./core_primitives.ts";
import type { FcgFunction, FcgModule, FcgOperation } from "./fcg.ts";
import type { FlatFcgPackage } from "./flat_fcg.ts";
export type { FcgFunction, FcgModule, FcgOperation } from "./fcg.ts";
export type { FlatFcgPackage } from "./flat_fcg.ts";
export { flatFcgSchemaVersion } from "./flat_fcg.ts";
import { storeRuntimeImport } from "./store_runtime.ts";
import { flattenFcgModule } from "./flat_fcg.ts";
import {
  emitWasmPlanOnCpu,
  type WasmBinaryPlan,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./wasm.ts";

export type CoreWasmArtifact = {
  readonly fcg: FcgModule;
  readonly flatFcg: FlatFcgPackage;
  readonly wasmPlan: WasmBinaryPlan;
  readonly wasm: Uint8Array | undefined;
  readonly textLiterals: readonly string[];
};

export type CoreWasmOptions = {
  readonly emission: "cpu" | "planOnly";
  readonly functions?: BackendFunctionCache;
  readonly target?: WasmTarget;
  readonly exports?: readonly {
    readonly name: string;
    readonly functionId: CoreFunctionId;
  }[];
  readonly customSections?: readonly {
    readonly name: string;
    readonly contents: Uint8Array;
  }[];
  readonly moduleShell?: (builder: WasmModuleBuilder) => void;
};

export type WasmTarget = "wasm-scalar" | "wasm-simd128";

export type BackendFunctionCache = {
  instantiate<Artifact>(
    environmentIdentity: string,
    functionIdentity: string,
    compile: () => Artifact,
  ): Artifact;
  readonly analyses: number;
  readonly reuses: number;
};

export function createBackendFunctionCache(): BackendFunctionCache {
  const environments = new Map<string, Map<string, unknown>>();
  let analyses = 0;
  let reuses = 0;
  return {
    instantiate<Artifact>(
      environmentIdentity: string,
      functionIdentity: string,
      compile: () => Artifact,
    ): Artifact {
      const functions = environments.get(environmentIdentity) ??
        new Map<string, unknown>();
      if (functions.has(functionIdentity)) {
        reuses += 1;
        return functions.get(functionIdentity) as Artifact;
      }
      analyses += 1;
      const artifact = compile();
      functions.set(functionIdentity, artifact);
      environments.set(environmentIdentity, functions);
      return artifact;
    },
    get analyses() {
      return analyses;
    },
    get reuses() {
      return reuses;
    },
  };
}

export const coreTextLiteralsSectionName = "core.text_literals";

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
    CoreOperation
  >;
  readonly locals: readonly number[];
  readonly dispatchLocal: number | undefined;
  readonly byteIndexLocal: number | undefined;
  readonly affineMultiplierLocal: number | undefined;
  readonly affineOffsetLocal: number | undefined;
  readonly inlineDiamondByCallResult: ReadonlyMap<
    CoreValueId,
    InlineDiamondLayout
  >;
  readonly inlineLoopByCallResult: ReadonlyMap<
    CoreValueId,
    InlineLoopLayout
  >;
  readonly inlineScalarTreeByCallResult: ReadonlyMap<
    CoreValueId,
    InlineScalarTreeLayout
  >;
};

type InlineDiamondLayout = {
  readonly function: CoreFunction;
  readonly localByValue: ReadonlyMap<CoreValueId, number>;
  readonly typeByValue: ReadonlyMap<CoreValueId, CoreTypeId>;
  readonly operationByResult: ReadonlyMap<
    CoreValueId,
    CoreOperation
  >;
};

type InlineLoopLayout =
  & InlineDiamondLayout
  & (
    | {
      readonly structure: "diamondBody";
      readonly loop: DiamondBodyNaturalLoop;
      readonly scalarTreesByCallResult: ReadonlyMap<
        CoreValueId,
        InlineScalarTreeLayout
      >;
    }
    | {
      readonly structure: "simple";
      readonly loop: SimpleNaturalLoop;
      readonly scalarTreesByCallResult: ReadonlyMap<
        CoreValueId,
        InlineScalarTreeLayout
      >;
    }
  );

type InlineScalarTreeShape = {
  readonly function: CoreFunction;
  readonly structure: "single" | "diamond";
  readonly callsByResult: ReadonlyMap<CoreValueId, InlineScalarTreeShape>;
  readonly operationCount: number;
  readonly total: boolean;
};

type InlineScalarTreeLayout = Omit<InlineScalarTreeShape, "callsByResult"> & {
  readonly localByValue: ReadonlyMap<CoreValueId, number>;
  readonly stackParameter: CoreValueId | undefined;
  readonly quadraticResult: QuadraticMap | undefined;
  readonly affineSuffix:
    | {
      readonly callResult: CoreValueId;
      readonly map: AffineMap;
    }
    | undefined;
  readonly callsByResult: ReadonlyMap<CoreValueId, InlineScalarTreeLayout>;
};

type StructuredAcyclicFunction = {
  readonly immediatePostdominatorByBlock: readonly (
    | CoreBlockId
    | undefined
  )[];
};

type DiamondBodyNaturalLoop = {
  readonly entry: CoreFunction["blocks"][number];
  readonly header: CoreFunction["blocks"][number];
  readonly bodyCondition: CoreFunction["blocks"][number];
  readonly trueBlock: CoreFunction["blocks"][number];
  readonly falseBlock: CoreFunction["blocks"][number];
  readonly latch: CoreFunction["blocks"][number];
  readonly exit: CoreFunction["blocks"][number];
  readonly continuesOnTrue: boolean;
};

type SimpleNaturalLoop = NonNullable<ReturnType<typeof simpleNaturalLoop>>;

type AffineNaturalLoop = {
  readonly loop: SimpleNaturalLoop;
  readonly counter: CoreValueId;
  readonly state: CoreValueId;
  readonly multiplier: number;
  readonly offset: number;
  readonly exactIterations: number | undefined;
  readonly maximumIterations: number | undefined;
  readonly summarizedCallResult: CoreValueId | undefined;
};

type AffineMap = {
  readonly multiplier: number;
  readonly offset: number;
};

type QuadraticMap = {
  readonly quadraticCoefficient: number;
  readonly linearCoefficient: number;
  readonly constantCoefficient: number;
};

const maximumInlineDiamondOperations = 16;
const maximumInlineLoopOperations = 24;
const maximumInlineScalarTreeOperations = 64;
const maximumLinearAffineIterations = 7;

type ClosureTarget = {
  readonly functionId: CoreFunctionId;
  readonly signature: CoreSignatureId;
  readonly tableIndex: number;
};

export function lowerCoreToWasm(
  core: CoreModule,
  options: CoreWasmOptions = { emission: "cpu" },
): CoreWasmArtifact {
  validateCore(core);
  validateCoreWasmTarget(core, options.target ?? "wasm-simd128");
  validateJavaScriptBoundary(core);
  const exports = options.exports ?? [{
    name: "main",
    functionId: core.entryFunction,
  }];
  validateCoreExports(core, exports);
  const reachableFunctionIds = findReachableFunctions(core, exports);
  const reachableFunctions = core.functions.filter((function_) =>
    reachableFunctionIds.has(function_.id)
  );
  const textLiterals = collectTextLiterals(reachableFunctions);
  const textHandles = new Map(
    textLiterals.map((literal, index) => [literal, index + 1]),
  );
  const closureTargets = collectClosureTargets(core, reachableFunctions);
  const requirements = collectImportRequirements(
    core,
    reachableFunctions,
    closureTargets,
  );
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

  const functionTypeIndices = core.functions.map(() => -1);
  for (const function_ of reachableFunctions) {
    const signature = core.signatures[function_.signature];
    functionTypeIndices[function_.id] = builder.addFunctionType(
      signature.parameters.map((type) => wasmValueType(core, type)),
      [wasmValueType(core, signature.result)],
    );
  }
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
  for (const function_ of reachableFunctions) {
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

  const functionIndices = core.functions.map(() => -1);
  let nextFunctionIndex = requirements.size;
  for (const function_ of reachableFunctions) {
    functionIndices[function_.id] = nextFunctionIndex;
    nextFunctionIndex += 1;
  }
  const backendEnvironmentIdentity = options.functions === undefined
    ? undefined
    : contentIdentity({
      schema: 1,
      types: core.types,
      signatures: core.signatures,
      requirements: [...requirements.values()],
      functionIndices,
      closureTargets,
      closureTypeIndices,
      textLiterals,
      inlineDiamondFunctions: core.functions.filter((function_) =>
        inlineableScalarDiamond(core, function_) !== undefined
      ),
    });
  const fcgFunctions: FcgFunction[] = [];
  for (const function_ of reachableFunctions) {
    let loweredFunction: {
      readonly layout: FunctionValueLayout;
      readonly instructions: readonly WasmInstruction[];
      readonly fcg: FcgFunction;
    };
    if (
      options.functions === undefined ||
      backendEnvironmentIdentity === undefined
    ) {
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
      loweredFunction = {
        layout,
        instructions,
        fcg: publicFunction(core, function_, layout),
      };
    } else {
      const affine = acceleratedAffineNaturalLoop(core, function_);
      const directDependencies = new Set<CoreFunctionId>();
      const pendingDependencies = [function_.id];
      while (pendingDependencies.length > 0) {
        const dependencyId = pendingDependencies.pop()!;
        if (directDependencies.has(dependencyId)) continue;
        directDependencies.add(dependencyId);
        const dependency = core.functions[dependencyId];
        for (const block of dependency.blocks) {
          for (const operation of block.operations) {
            if (operation.kind === "call.direct") {
              pendingDependencies.push(operation.functionId);
            }
          }
        }
      }
      const functionIdentity = contentIdentity({
        function: function_,
        directDependencies: [...directDependencies]
          .filter((functionId) => functionId !== function_.id)
          .sort((left, right) => left - right)
          .map((functionId) => core.functions[functionId]),
        affine: affine === undefined ? undefined : {
          multiplier: affine.multiplier,
          offset: affine.offset,
        },
      });
      loweredFunction = options.functions.instantiate(
        backendEnvironmentIdentity,
        functionIdentity,
        () => {
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
          return {
            layout,
            instructions,
            fcg: publicFunction(core, function_, layout),
          };
        },
      );
    }
    const functionIndex = builder.addFunction(
      functionTypeIndices[function_.id],
      loweredFunction.layout.locals,
      loweredFunction.instructions,
    );
    const expectedIndex = functionIndices[function_.id];
    if (functionIndex !== expectedIndex) {
      throw new Error(
        `Core function ${function_.name} expected Wasm index ${expectedIndex}; received ${functionIndex}`,
      );
    }
    fcgFunctions.push(loweredFunction.fcg);
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

  if (options.moduleShell !== undefined) options.moduleShell(builder);

  for (const exported of exports) {
    const functionIndex = functionIndices[exported.functionId];
    builder.exportFunction(exported.name, functionIndex);
  }
  for (const section of options.customSections ?? []) {
    builder.addCustomSection(section.name, section.contents);
  }
  if (textLiterals.length > 0) {
    builder.addCustomSection(
      coreTextLiteralsSectionName,
      new TextEncoder().encode(JSON.stringify(textLiterals)),
    );
  }
  const wasmPlan = builder.finishPlan();
  const wasm = options.emission === "cpu"
    ? emitWasmPlanOnCpu(wasmPlan)
    : undefined;
  if (wasm !== undefined) {
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

function validateCoreExports(
  core: CoreModule,
  exports: readonly {
    readonly name: string;
    readonly functionId: CoreFunctionId;
  }[],
): void {
  const names = new Set<string>();
  for (const exported of exports) {
    if (names.has(exported.name)) {
      throw new TypeError(`Core Wasm options repeat export ${exported.name}`);
    }
    names.add(exported.name);
    if (core.functions[exported.functionId] === undefined) {
      throw new RangeError(
        `Core Wasm export ${exported.name} uses function ${exported.functionId}; ${core.functions.length} functions are defined`,
      );
    }
  }
}

function findReachableFunctions(
  core: CoreModule,
  exports: readonly { readonly functionId: CoreFunctionId }[],
): ReadonlySet<CoreFunctionId> {
  const reachable = new Set(exports.map((exported) => exported.functionId));
  const pending = [...reachable];
  while (pending.length > 0) {
    const functionId = pending.pop()!;
    const function_ = core.functions[functionId];
    const affine = acceleratedAffineNaturalLoop(core, function_);
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        const target = operation.kind === "closure.make"
          ? operation.functionId
          : operation.kind === "call.direct" &&
              operation.result !== affine?.summarizedCallResult &&
              !isInlineableLoopCall(core, function_, block, operation)
          ? operation.functionId
          : undefined;
        if (target === undefined || reachable.has(target)) continue;
        reachable.add(target);
        pending.push(target);
      }
    }
  }
  return reachable;
}

function collectTextLiterals(
  functions: readonly CoreFunction[],
): readonly string[] {
  const literals = new Set<string>();
  for (const function_ of functions) {
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
  core: CoreModule,
  functions: readonly CoreFunction[],
): readonly ClosureTarget[] {
  const signatures = new Map<CoreFunctionId, CoreSignatureId>();
  for (const function_ of functions) {
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
  core: CoreModule,
  functions: readonly CoreFunction[],
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
      moduleName: coreRuntimeImportModule,
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
    functions.some((function_) =>
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

  for (const function_ of functions) {
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
        if (operation.kind.startsWith("store.")) {
          requireManaged(
            aggregateImportName(operation, result),
            operandTypes,
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
  core: CoreModule,
  function_: CoreFunction,
): FunctionValueLayout {
  const localByValue = new Map<CoreValueId, number>();
  const typeByValue = valueTypes(function_);
  const operationByResult = new Map<CoreValueId, CoreOperation>();
  const { useCounts, useBlocks, returnedValues } = analyzeFunctionValueUses(
    function_,
  );
  for (const block of function_.blocks) {
    for (const operation of block.operations) {
      operationByResult.set(operation.result, operation);
    }
  }
  const signature = core.signatures[function_.signature];
  const entry = function_.blocks[function_.entryBlock];
  entry.parameters.forEach((parameter, index) => {
    localByValue.set(parameter.value, index);
  });
  const locals: number[] = [];
  let nextLocal = signature.parameters.length;
  const naturalLoop = simpleNaturalLoop(function_);
  const diamondBodyLoop = diamondBodyNaturalLoop(function_);
  const structuredAcyclic = simpleDiamond(function_) === undefined
    ? structuredAcyclicFunction(function_)
    : undefined;
  for (const block of function_.blocks) {
    for (const parameter of block.parameters) {
      if (localByValue.has(parameter.value)) continue;
      localByValue.set(parameter.value, nextLocal);
      nextLocal += 1;
      locals.push(wasmValueType(core, parameter.type));
    }
    for (const operation of block.operations) {
      const stackifiesSingleBlock = function_.blocks.length === 1 &&
        (!operationNeedsLocal(
          operation,
          useCounts.get(operation.result) ?? 0,
          returnedValues.has(operation.result),
        ) ||
          canSinkTotalScalarOperation(
            core,
            function_,
            block,
            operation,
            typeByValue,
            useCounts,
            useBlocks,
          ));
      const sinksInStructuredControl =
        (naturalLoop !== undefined || diamondBodyLoop !== undefined ||
          structuredAcyclic !== undefined) &&
        canSinkTotalScalarOperation(
          core,
          function_,
          block,
          operation,
          typeByValue,
          useCounts,
          useBlocks,
        );
      if (stackifiesSingleBlock || sinksInStructuredControl) {
        continue;
      }
      localByValue.set(operation.result, nextLocal);
      nextLocal += 1;
      locals.push(wasmValueType(core, operation.type));
    }
  }
  const inlineDiamondByCallResult = new Map<
    CoreValueId,
    InlineDiamondLayout
  >();
  const inlineLoopByCallResult = new Map<CoreValueId, InlineLoopLayout>();
  const inlineScalarTreeByCallResult = new Map<
    CoreValueId,
    InlineScalarTreeLayout
  >();
  const allocateScalarTree = (
    shape: InlineScalarTreeShape,
    rereadableArgument = false,
  ): InlineScalarTreeLayout => {
    const inlineLocalByValue = new Map<CoreValueId, number>();
    const inlineTypeByValue = valueTypes(shape.function);
    const inlineUses = analyzeFunctionValueUses(shape.function);
    const inlineOperationByResult = new Map(
      shape.function.blocks.flatMap((block) =>
        block.operations.map((operation) =>
          [operation.result, operation] as const
        )
      ),
    );
    const entry = shape.function.blocks[shape.function.entryBlock];
    const quadraticResult = quadraticScalarTreeResult(core, shape);
    const stackParameter = shape.total && shape.structure === "single" &&
        entry.parameters.length === 1 &&
        (quadraticResult === undefined
          ? inlineUses.useCounts.get(entry.parameters[0].value) === 1
          : rereadableArgument)
      ? entry.parameters[0].value
      : undefined;
    for (const block of shape.function.blocks) {
      for (const parameter of block.parameters) {
        if (parameter.value === stackParameter) continue;
        inlineLocalByValue.set(parameter.value, nextLocal);
        nextLocal += 1;
        locals.push(wasmValueType(core, parameter.type));
      }
      for (const operation of block.operations) {
        if (quadraticResult !== undefined) continue;
        const operationUseBlocks = inlineUses.useBlocks.get(operation.result);
        const sinksInlineCall = shape.total && shape.structure === "single" &&
          operation.kind === "call.direct" &&
          shape.callsByResult.has(operation.result) &&
          inlineUses.useCounts.get(operation.result) === 1 &&
          operationUseBlocks?.size === 1 &&
          operationUseBlocks.has(block.id);
        if (
          sinksInlineCall ||
          canSinkTotalScalarOperation(
            core,
            shape.function,
            block,
            operation,
            inlineTypeByValue,
            inlineUses.useCounts,
            inlineUses.useBlocks,
          )
        ) {
          continue;
        }
        inlineLocalByValue.set(operation.result, nextLocal);
        nextLocal += 1;
        locals.push(wasmValueType(core, operation.type));
      }
    }
    return {
      ...shape,
      localByValue: inlineLocalByValue,
      stackParameter,
      quadraticResult,
      affineSuffix: affineScalarTreeSuffix(core, shape),
      callsByResult: new Map(
        [...shape.callsByResult].map(([result, child]) => {
          const childCall = inlineOperationByResult.get(result);
          const childOperand = childCall?.kind === "call.direct"
            ? childCall.operands[0]
            : undefined;
          const childArgumentIsRereadable = childOperand !== undefined &&
            (inlineLocalByValue.has(childOperand) ||
              (childOperand === stackParameter && rereadableArgument));
          return [
            result,
            allocateScalarTree(child, childArgumentIsRereadable),
          ] as const;
        }),
      ),
    };
  };
  if (naturalLoop !== undefined) {
    for (const operation of naturalLoop.body.operations) {
      if (operation.kind !== "call.direct") continue;
      const inlineDiamond = inlineableLoopCall(
        core,
        function_,
        naturalLoop.body,
        operation,
      );
      const inlineDiamondBodyLoop = inlineDiamond === undefined
        ? inlineableDiamondBodyLoopCall(
          core,
          function_,
          naturalLoop.body,
          operation,
        )
        : undefined;
      const inlineSimpleBodyLoop = inlineDiamond === undefined &&
          inlineDiamondBodyLoop === undefined
        ? inlineableSimpleBodyLoopCall(
          core,
          function_,
          naturalLoop.body,
          operation,
        )
        : undefined;
      const inlineScalarTree = inlineDiamond === undefined &&
          inlineDiamondBodyLoop === undefined &&
          inlineSimpleBodyLoop === undefined
        ? inlineableScalarTreeCall(
          core,
          function_,
          naturalLoop.body,
          operation,
        )
        : undefined;
      if (inlineScalarTree !== undefined) {
        inlineScalarTreeByCallResult.set(
          operation.result,
          allocateScalarTree(
            inlineScalarTree,
            localByValue.has(operation.operands[0]),
          ),
        );
        continue;
      }
      const inlineFunction = inlineDiamond ?? inlineDiamondBodyLoop?.function ??
        inlineSimpleBodyLoop?.function;
      if (inlineFunction === undefined) continue;
      const inlineLocalByValue = new Map<CoreValueId, number>();
      const inlineTypeByValue = valueTypes(inlineFunction);
      const inlineUses = analyzeFunctionValueUses(inlineFunction);
      for (const block of inlineFunction.blocks) {
        for (const parameter of block.parameters) {
          inlineLocalByValue.set(parameter.value, nextLocal);
          nextLocal += 1;
          locals.push(wasmValueType(core, parameter.type));
        }
        for (const inlineOperation of block.operations) {
          if (
            canSinkTotalScalarOperation(
              core,
              inlineFunction,
              block,
              inlineOperation,
              inlineTypeByValue,
              inlineUses.useCounts,
              inlineUses.useBlocks,
            )
          ) {
            continue;
          }
          inlineLocalByValue.set(inlineOperation.result, nextLocal);
          nextLocal += 1;
          locals.push(wasmValueType(core, inlineOperation.type));
        }
      }
      const inlineLayout = {
        function: inlineFunction,
        localByValue: inlineLocalByValue,
        typeByValue: inlineTypeByValue,
        operationByResult: new Map(
          inlineFunction.blocks.flatMap((block) =>
            block.operations.map((operation) =>
              [
                operation.result,
                operation,
              ] as const
            )
          ),
        ),
      };
      if (
        inlineDiamondBodyLoop === undefined &&
        inlineSimpleBodyLoop === undefined
      ) {
        inlineDiamondByCallResult.set(operation.result, inlineLayout);
      } else if (inlineDiamondBodyLoop !== undefined) {
        inlineLoopByCallResult.set(operation.result, {
          ...inlineLayout,
          structure: "diamondBody",
          loop: inlineDiamondBodyLoop.loop,
          scalarTreesByCallResult: new Map(),
        });
      } else if (inlineSimpleBodyLoop !== undefined) {
        const scalarTreesByCallResult = new Map<
          CoreValueId,
          InlineScalarTreeLayout
        >();
        if (inlineSimpleBodyLoop !== undefined) {
          for (const candidate of inlineSimpleBodyLoop.loop.body.operations) {
            if (candidate.kind !== "call.direct") continue;
            const shape = inlineableScalarTreeCall(
              core,
              inlineFunction,
              inlineSimpleBodyLoop.loop.body,
              candidate,
            );
            if (shape === undefined) {
              throw new Error(
                `Core inline target ${inlineFunction.name} lost nested call ${candidate.result}`,
              );
            }
            scalarTreesByCallResult.set(
              candidate.result,
              allocateScalarTree(
                shape,
                inlineLocalByValue.has(candidate.operands[0]),
              ),
            );
          }
        }
        inlineLoopByCallResult.set(operation.result, {
          ...inlineLayout,
          structure: "simple",
          loop: inlineSimpleBodyLoop.loop,
          scalarTreesByCallResult,
        });
      } else {
        throw new Error(
          `Core inline target ${inlineFunction.name} lost its selected shape`,
        );
      }
    }
  }
  let dispatchLocal: number | undefined;
  if (
    function_.blocks.length > 1 && simpleDiamond(function_) === undefined &&
    simpleNaturalLoop(function_) === undefined &&
    diamondBodyNaturalLoop(function_) === undefined &&
    structuredAcyclic === undefined
  ) {
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
    nextLocal += 1;
    locals.push(wasmType.i32);
  }
  const affineLoop = acceleratedAffineNaturalLoop(core, function_);
  let affineMultiplierLocal: number | undefined;
  let affineOffsetLocal: number | undefined;
  if (affineLoop !== undefined) {
    affineMultiplierLocal = nextLocal;
    affineOffsetLocal = nextLocal + 1;
    locals.push(wasmType.i32, wasmType.i32);
  }
  return {
    localByValue,
    typeByValue,
    operationByResult,
    locals,
    dispatchLocal,
    byteIndexLocal,
    affineMultiplierLocal,
    affineOffsetLocal,
    inlineDiamondByCallResult,
    inlineLoopByCallResult,
    inlineScalarTreeByCallResult,
  };
}

function emitFunction(
  core: CoreModule,
  function_: CoreFunction,
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
  const naturalLoop = simpleNaturalLoop(function_);
  if (naturalLoop !== undefined) {
    const affineLoop = acceleratedAffineNaturalLoop(core, function_);
    if (affineLoop !== undefined) {
      return emitAffineNaturalLoop(
        function_,
        layout,
        affineLoop,
        emitBlockOperations,
        emitValue,
      );
    }
    return [
      ...emitSimpleNaturalLoopRegion(
        function_,
        layout,
        naturalLoop,
        emitBlockOperations,
        emitValue,
      ),
      ...emitBlockOperations(naturalLoop.exit.id),
      ...emitTerminator(
        naturalLoop.exit.terminator,
        function_,
        layout,
        0,
        emitValue,
      ),
    ];
  }
  const diamondBodyLoop = diamondBodyNaturalLoop(function_);
  if (diamondBodyLoop !== undefined) {
    return [
      ...emitDiamondBodyNaturalLoopRegion(
        function_,
        layout,
        diamondBodyLoop,
        diamondBodySelection(core, function_, diamondBodyLoop),
        emitBlockOperations,
        emitValue,
      ),
      ...emitBlockOperations(diamondBodyLoop.exit.id),
      ...emitTerminator(
        diamondBodyLoop.exit.terminator,
        function_,
        layout,
        0,
        emitValue,
      ),
    ];
  }
  const structuredAcyclic = structuredAcyclicFunction(function_);
  if (structuredAcyclic !== undefined) {
    return emitStructuredAcyclicFunction(
      function_,
      layout,
      structuredAcyclic,
      emitBlockOperations,
      emitValue,
    );
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
  function_: CoreFunction,
): {
  readonly entry: CoreFunction["blocks"][number];
  readonly trueBlock: CoreFunction["blocks"][number];
  readonly falseBlock: CoreFunction["blocks"][number];
  readonly join: CoreFunction["blocks"][number];
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

function structuredAcyclicFunction(
  function_: CoreFunction,
): StructuredAcyclicFunction | undefined {
  if (function_.blocks.length <= 1 || !hasAcyclicControlFlow(function_)) {
    return undefined;
  }
  const allBlocks = new Set(function_.blocks.map((block) => block.id));
  const postdominators = function_.blocks.map((block) =>
    block.terminator.kind === "return" || block.terminator.kind === "trap"
      ? new Set([block.id])
      : new Set(allBlocks)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of function_.blocks.toReversed()) {
      const successors = coreTerminatorSuccessors(block.terminator);
      if (successors.length === 0) continue;
      const intersection = new Set(postdominators[successors[0]]);
      for (const successor of successors.slice(1)) {
        for (const candidate of intersection) {
          if (!postdominators[successor].has(candidate)) {
            intersection.delete(candidate);
          }
        }
      }
      intersection.add(block.id);
      if (!equalSets(intersection, postdominators[block.id])) {
        postdominators[block.id] = intersection;
        changed = true;
      }
    }
  }

  const immediatePostdominatorByBlock = function_.blocks.map((block) => {
    const strict = [...postdominators[block.id]].filter((candidate) =>
      candidate !== block.id
    );
    return strict.find((candidate) =>
      strict.every((other) =>
        other === candidate || postdominators[candidate].has(other)
      )
    );
  });
  const certificate = { immediatePostdominatorByBlock };
  const visited = new Set<CoreBlockId>();
  if (
    !verifyStructuredAcyclicRegion(
      function_,
      certificate,
      function_.entryBlock,
      undefined,
      visited,
    ) || visited.size !== function_.blocks.length
  ) {
    return undefined;
  }
  return certificate;
}

function hasAcyclicControlFlow(function_: CoreFunction): boolean {
  const incomingEdges = function_.blocks.map(() => 0);
  for (const block of function_.blocks) {
    for (const successor of coreTerminatorSuccessors(block.terminator)) {
      incomingEdges[successor] += 1;
    }
  }
  const ready = function_.blocks.filter((block) =>
    incomingEdges[block.id] === 0
  )
    .map((block) => block.id);
  let visited = 0;
  while (ready.length > 0) {
    const block = ready.pop()!;
    visited += 1;
    for (
      const successor of coreTerminatorSuccessors(
        function_.blocks[block].terminator,
      )
    ) {
      incomingEdges[successor] -= 1;
      if (incomingEdges[successor] === 0) ready.push(successor);
    }
  }
  return visited === function_.blocks.length;
}

function verifyStructuredAcyclicRegion(
  function_: CoreFunction,
  certificate: StructuredAcyclicFunction,
  start: CoreBlockId,
  stop: CoreBlockId | undefined,
  visited: Set<CoreBlockId>,
): boolean {
  if (start === stop) return true;
  if (visited.has(start)) return false;
  visited.add(start);
  const terminator = function_.blocks[start].terminator;
  if (terminator.kind === "return" || terminator.kind === "trap") {
    return stop === undefined;
  }
  if (terminator.kind === "branch") {
    return verifyStructuredAcyclicRegion(
      function_,
      certificate,
      terminator.target,
      stop,
      visited,
    );
  }
  const join = certificate.immediatePostdominatorByBlock[start];
  if (join === undefined) return false;
  return verifyStructuredAcyclicRegion(
    function_,
    certificate,
    terminator.trueTarget,
    join,
    visited,
  ) &&
    verifyStructuredAcyclicRegion(
      function_,
      certificate,
      terminator.falseTarget,
      join,
      visited,
    ) &&
    verifyStructuredAcyclicRegion(
      function_,
      certificate,
      join,
      stop,
      visited,
    );
}

function emitStructuredAcyclicFunction(
  function_: CoreFunction,
  layout: FunctionValueLayout,
  certificate: StructuredAcyclicFunction,
  emitBlockOperations: (block: number) => readonly WasmInstruction[],
  emitValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const emitRegion = (
    start: CoreBlockId,
    stop: CoreBlockId | undefined,
  ): readonly WasmInstruction[] => {
    if (start === stop) return [];
    const block = function_.blocks[start];
    const instructions = [...emitBlockOperations(start)];
    const terminator = block.terminator;
    if (terminator.kind === "return" || terminator.kind === "trap") {
      instructions.push(
        ...emitTerminator(terminator, function_, layout, 0, emitValue),
      );
      return instructions;
    }
    if (terminator.kind === "branch") {
      instructions.push(
        ...emitEdgeAssignment(
          terminator.arguments,
          function_.blocks[terminator.target],
          function_,
          layout,
          emitValue,
        ),
        ...emitRegion(terminator.target, stop),
      );
      return instructions;
    }
    const join = certificate.immediatePostdominatorByBlock[start];
    if (join === undefined) {
      throw new Error(
        `Core function ${function_.name} lost the postdominator for block ${start}`,
      );
    }
    instructions.push(
      ...emitValue(terminator.condition),
      ...wasmInstruction.ifVoid,
      ...emitEdgeAssignment(
        terminator.trueArguments,
        function_.blocks[terminator.trueTarget],
        function_,
        layout,
        emitValue,
      ),
      ...emitRegion(terminator.trueTarget, join),
      ...wasmInstruction.else,
      ...emitEdgeAssignment(
        terminator.falseArguments,
        function_.blocks[terminator.falseTarget],
        function_,
        layout,
        emitValue,
      ),
      ...emitRegion(terminator.falseTarget, join),
      ...wasmInstruction.end,
      ...emitRegion(join, stop),
    );
    return instructions;
  };
  return emitRegion(function_.entryBlock, undefined);
}

function coreTerminatorSuccessors(
  terminator: CoreTerminator,
): readonly CoreBlockId[] {
  if (terminator.kind === "return" || terminator.kind === "trap") return [];
  if (terminator.kind === "branch") return [terminator.target];
  return terminator.trueTarget === terminator.falseTarget
    ? [terminator.trueTarget]
    : [terminator.trueTarget, terminator.falseTarget];
}

function equalSets<Value>(
  left: ReadonlySet<Value>,
  right: ReadonlySet<Value>,
): boolean {
  return left.size === right.size &&
    [...left].every((value) => right.has(value));
}

function inlineableScalarDiamond(
  core: CoreModule,
  function_: CoreFunction,
): ReturnType<typeof simpleDiamond> {
  const diamond = simpleDiamond(function_);
  if (
    diamond === undefined || diamond.join.operations.length !== 0 ||
    diamond.join.terminator.kind !== "return" ||
    diamond.join.terminator.values.length !== 1 ||
    diamond.join.terminator.values[0] !== diamond.join.parameters[0]?.value
  ) {
    return undefined;
  }
  const operations = function_.blocks.flatMap((block) => block.operations);
  const definitionTypes = function_.blocks.flatMap((block) => [
    ...block.parameters.map((parameter) => parameter.type),
    ...block.operations.map((operation) => operation.type),
  ]);
  if (
    operations.length > maximumInlineDiamondOperations ||
    definitionTypes.some((type) => core.types[type]?.kind !== "scalar") ||
    operations.some((operation) =>
      operation.kind !== "constant" && operation.kind !== "scalar.binary"
    )
  ) {
    return undefined;
  }
  return diamond;
}

function selectableScalarDiamond(
  core: CoreModule,
  function_: CoreFunction,
): ReturnType<typeof simpleDiamond> {
  const diamond = inlineableScalarDiamond(core, function_);
  if (diamond === undefined) return undefined;
  const types = valueTypes(function_);
  return function_.blocks.every((block) =>
      block.operations.every((operation) =>
        isTotalPureScalarOperation(core, function_, operation, types)
      )
    )
    ? diamond
    : undefined;
}

function diamondBodySelection(
  core: CoreModule,
  function_: CoreFunction,
  loop: DiamondBodyNaturalLoop,
): "select" | "branch" {
  if (
    loop.bodyCondition.terminator.kind !== "conditional_branch" ||
    loop.trueBlock.terminator.kind !== "branch" ||
    loop.falseBlock.terminator.kind !== "branch" ||
    loop.bodyCondition.terminator.trueArguments.length !== 0 ||
    loop.bodyCondition.terminator.falseArguments.length !== 0 ||
    loop.latch.parameters.length !== 1 ||
    loop.trueBlock.terminator.arguments.length !== 1 ||
    loop.falseBlock.terminator.arguments.length !== 1
  ) {
    return "branch";
  }
  const types = valueTypes(function_);
  const eagerBlocks = [
    loop.bodyCondition,
    loop.trueBlock,
    loop.falseBlock,
  ];
  return eagerBlocks.every((block) =>
      block.operations.every((operation) =>
        isTotalPureScalarOperation(core, function_, operation, types)
      )
    )
    ? "select"
    : "branch";
}

function inlineableLoopCall(
  core: CoreModule,
  caller: CoreFunction,
  block: CoreFunction["blocks"][number],
  operation: Extract<CoreOperation, { readonly kind: "call.direct" }>,
): CoreFunction | undefined {
  const naturalLoop = simpleNaturalLoop(caller);
  if (naturalLoop?.body.id !== block.id) return undefined;
  const target = core.functions[operation.functionId];
  return target !== undefined &&
      inlineableScalarDiamond(core, target) !== undefined
    ? target
    : undefined;
}

function inlineableDiamondBodyLoopCall(
  core: CoreModule,
  caller: CoreFunction,
  block: CoreFunction["blocks"][number],
  operation: Extract<CoreOperation, { readonly kind: "call.direct" }>,
):
  | { readonly function: CoreFunction; readonly loop: DiamondBodyNaturalLoop }
  | undefined {
  const callerLoop = simpleNaturalLoop(caller);
  if (callerLoop?.body.id !== block.id) return undefined;
  const target = core.functions[operation.functionId];
  const loop = target === undefined
    ? undefined
    : diamondBodyNaturalLoop(target);
  if (target === undefined || loop === undefined) return undefined;
  const operations = target.blocks.flatMap((candidate) => candidate.operations);
  if (
    operations.some((candidate) =>
      candidate.kind !== "constant" && candidate.kind !== "scalar.binary"
    ) ||
    target.blocks.some((candidate) =>
      candidate.parameters.some((parameter) =>
        core.types[parameter.type]?.kind !== "scalar"
      )
    ) || countFunctionReferences(core, target.id) !== 1 ||
    loop.exit.terminator.kind !== "return" ||
    loop.exit.terminator.values.length !== 1
  ) {
    return undefined;
  }
  return { function: target, loop };
}

function inlineableSimpleBodyLoopCall(
  core: CoreModule,
  caller: CoreFunction,
  block: CoreFunction["blocks"][number],
  operation: Extract<CoreOperation, { readonly kind: "call.direct" }>,
):
  | { readonly function: CoreFunction; readonly loop: SimpleNaturalLoop }
  | undefined {
  const callerLoop = simpleNaturalLoop(caller);
  if (callerLoop?.body.id !== block.id) return undefined;
  const target = core.functions[operation.functionId];
  const loop = target === undefined ? undefined : simpleNaturalLoop(target);
  if (
    target === undefined || loop === undefined ||
    acceleratedAffineNaturalLoop(core, target) !== undefined ||
    countFunctionReferences(core, target.id) !== 1 ||
    loop.exit.terminator.kind !== "return" ||
    loop.exit.terminator.values.length !== 1
  ) {
    return undefined;
  }
  const operations = target.blocks.flatMap((candidate) => candidate.operations);
  if (
    operations.length > maximumInlineLoopOperations ||
    operations.some((candidate) =>
      candidate.kind !== "constant" && candidate.kind !== "scalar.binary" &&
      candidate.kind !== "call.direct"
    ) ||
    target.blocks.some((candidate) =>
      candidate.parameters.some((parameter) =>
        core.types[parameter.type]?.kind !== "scalar"
      ) || candidate.operations.some((candidateOperation) =>
        core.types[candidateOperation.type]?.kind !== "scalar"
      )
    ) ||
    target.blocks.some((candidate) =>
      candidate.id !== loop.body.id &&
      candidate.operations.some((candidateOperation) =>
        candidateOperation.kind === "call.direct"
      )
    )
  ) {
    return undefined;
  }
  let expandedOperationCount = operations.length;
  for (const candidate of loop.body.operations) {
    if (candidate.kind !== "call.direct") continue;
    const shape = inlineableScalarTreeCall(
      core,
      target,
      loop.body,
      candidate,
    );
    if (shape === undefined) return undefined;
    expandedOperationCount += shape.operationCount;
  }
  if (expandedOperationCount > maximumInlineLoopOperations) return undefined;
  return { function: target, loop };
}

function isInlineableLoopCall(
  core: CoreModule,
  caller: CoreFunction,
  block: CoreFunction["blocks"][number],
  operation: Extract<CoreOperation, { readonly kind: "call.direct" }>,
): boolean {
  return inlineableLoopCall(core, caller, block, operation) !== undefined ||
    inlineableDiamondBodyLoopCall(core, caller, block, operation) !==
      undefined ||
    inlineableSimpleBodyLoopCall(core, caller, block, operation) !==
      undefined ||
    inlineableScalarTreeCall(core, caller, block, operation) !== undefined;
}

function inlineableScalarTreeCall(
  core: CoreModule,
  caller: CoreFunction,
  block: CoreFunction["blocks"][number],
  operation: Extract<CoreOperation, { readonly kind: "call.direct" }>,
): InlineScalarTreeShape | undefined {
  if (simpleNaturalLoop(caller)?.body.id !== block.id) return undefined;
  function isSymbolicallyCompressed(
    candidate: InlineScalarTreeShape,
  ): boolean {
    if (quadraticScalarTreeResult(core, candidate) !== undefined) return true;
    const suffix = affineScalarTreeSuffix(core, candidate);
    if (suffix === undefined) return false;
    const child = candidate.callsByResult.get(suffix.callResult);
    return child !== undefined && isSymbolicallyCompressed(child);
  }
  const build = (
    functionId: CoreFunctionId,
    ancestors: ReadonlySet<CoreFunctionId>,
  ): InlineScalarTreeShape | undefined => {
    if (ancestors.has(functionId)) return undefined;
    const function_ = core.functions[functionId];
    const diamond = simpleDiamond(function_);
    const single = function_.blocks.length === 1 &&
      function_.blocks[0].terminator.kind === "return" &&
      function_.blocks[0].terminator.values.length === 1;
    if (
      !single &&
      (diamond === undefined || diamond.join.operations.length !== 0 ||
        diamond.join.terminator.kind !== "return" ||
        diamond.join.terminator.values[0] !== diamond.join.parameters[0]?.value)
    ) {
      return undefined;
    }
    const operations = function_.blocks.flatMap((candidate) =>
      candidate.operations
    );
    const references = countFunctionReferences(core, functionId);
    const sharedCopyOperations = (references - 1) * operations.length;
    const types = valueTypes(function_);
    const permitsSharedLeaf = references > 1 && references <= 4 && single &&
      operations.length <= 4 && sharedCopyOperations <= 8 &&
      operations.every((candidate) =>
        candidate.kind !== "call.direct" &&
        isTotalPureScalarOperation(
          core,
          function_,
          candidate,
          types,
        )
      );
    if (
      (references !== 1 && !permitsSharedLeaf) ||
      operations.some((candidate) =>
        candidate.kind !== "constant" && candidate.kind !== "scalar.binary" &&
        candidate.kind !== "call.direct"
      ) ||
      function_.blocks.some((candidate) =>
        candidate.parameters.some((parameter) =>
          core.types[parameter.type]?.kind !== "scalar"
        ) || candidate.operations.some((operation) =>
          core.types[operation.type]?.kind !== "scalar"
        )
      )
    ) {
      return undefined;
    }
    const descendants = new Set(ancestors);
    descendants.add(functionId);
    const callsByResult = new Map<CoreValueId, InlineScalarTreeShape>();
    let operationCount = operations.length;
    let total = true;
    for (const candidate of operations) {
      if (candidate.kind === "call.direct") {
        const child = build(candidate.functionId, descendants);
        if (child === undefined) return undefined;
        callsByResult.set(candidate.result, child);
        operationCount += child.operationCount;
        total &&= child.total;
        continue;
      }
      if (
        candidate.kind === "scalar.binary" &&
        (candidate.operator === "/" || candidate.operator === "%")
      ) {
        total = false;
      }
    }
    const candidate: InlineScalarTreeShape = {
      function: function_,
      structure: single ? "single" : "diamond",
      callsByResult,
      operationCount,
      total,
    };
    return operationCount <= maximumInlineScalarTreeOperations ||
        isSymbolicallyCompressed(candidate)
      ? candidate
      : undefined;
  };
  return build(operation.functionId, new Set());
}

function affineScalarTreeSuffix(
  core: CoreModule,
  shape: InlineScalarTreeShape,
):
  | {
    readonly callResult: CoreValueId;
    readonly map: AffineMap;
  }
  | undefined {
  if (
    !shape.total || shape.structure !== "single" ||
    shape.callsByResult.size !== 1
  ) {
    return undefined;
  }
  const block = shape.function.blocks[shape.function.entryBlock];
  if (
    block.terminator.kind !== "return" ||
    block.terminator.values.length !== 1
  ) {
    return undefined;
  }
  const callResult = shape.callsByResult.keys().next().value;
  if (callResult === undefined) return undefined;
  const map = summarizeAffineBlock(
    core,
    block,
    new Map([[callResult, { multiplier: 1, offset: 0 }]]),
    block.terminator.values[0],
    () => undefined,
  );
  return map === undefined ? undefined : { callResult, map };
}

function quadraticScalarTreeResult(
  core: CoreModule,
  shape: InlineScalarTreeShape,
): QuadraticMap | undefined {
  const result = polynomialScalarTreeResult(core, shape, new Map());
  return result?.quadraticCoefficient === 0 ? undefined : result;
}

function polynomialScalarTreeResult(
  core: CoreModule,
  shape: InlineScalarTreeShape,
  summaries: Map<CoreFunctionId, QuadraticMap>,
): QuadraticMap | undefined {
  const cached = summaries.get(shape.function.id);
  if (cached !== undefined) return cached;
  if (!shape.total || shape.structure !== "single") {
    return undefined;
  }
  const block = shape.function.blocks[shape.function.entryBlock];
  const parameterType = block.parameters.length === 1
    ? core.types[block.parameters[0].type]
    : undefined;
  if (
    block.parameters.length !== 1 || block.terminator.kind !== "return" ||
    block.terminator.values.length !== 1 ||
    parameterType?.kind !== "scalar" || parameterType.scalar !== "i32"
  ) {
    return undefined;
  }
  const values = new Map<CoreValueId, QuadraticMap>([[
    block.parameters[0].value,
    {
      quadraticCoefficient: 0,
      linearCoefficient: 1,
      constantCoefficient: 0,
    },
  ]]);
  for (const operation of block.operations) {
    const operationType = core.types[operation.type];
    if (operationType?.kind !== "scalar" || operationType.scalar !== "i32") {
      return undefined;
    }
    let result: QuadraticMap | undefined;
    if (
      operation.kind === "constant" && typeof operation.value === "number"
    ) {
      result = {
        quadraticCoefficient: 0,
        linearCoefficient: 0,
        constantCoefficient: operation.value | 0,
      };
    } else if (
      operation.kind === "scalar.binary" &&
      (operation.operator === "+" || operation.operator === "-" ||
        operation.operator === "*")
    ) {
      const left = values.get(operation.operands[0]);
      const right = values.get(operation.operands[1]);
      if (left === undefined || right === undefined) return undefined;
      if (operation.operator === "+" || operation.operator === "-") {
        const direction = operation.operator === "+" ? 1 : -1;
        result = {
          quadraticCoefficient: (
            left.quadraticCoefficient +
            direction * right.quadraticCoefficient
          ) | 0,
          linearCoefficient: (
            left.linearCoefficient + direction * right.linearCoefficient
          ) | 0,
          constantCoefficient: (
            left.constantCoefficient + direction * right.constantCoefficient
          ) | 0,
        };
      } else {
        result = multiplyQuadraticMaps(left, right);
      }
    } else if (
      operation.kind === "call.direct" && operation.operands.length === 1 &&
      shape.callsByResult.has(operation.result)
    ) {
      const argument = values.get(operation.operands[0]);
      const child = shape.callsByResult.get(operation.result);
      const callee = child === undefined
        ? undefined
        : polynomialScalarTreeResult(core, child, summaries);
      if (argument === undefined || callee === undefined) return undefined;
      const squaredArgument = callee.quadraticCoefficient === 0
        ? undefined
        : multiplyQuadraticMaps(argument, argument);
      if (
        callee.quadraticCoefficient !== 0 && squaredArgument === undefined
      ) {
        return undefined;
      }
      result = {
        quadraticCoefficient: (
          Math.imul(
            callee.quadraticCoefficient,
            squaredArgument?.quadraticCoefficient ?? 0,
          ) +
          Math.imul(
            callee.linearCoefficient,
            argument.quadraticCoefficient,
          )
        ) | 0,
        linearCoefficient: (
          Math.imul(
            callee.quadraticCoefficient,
            squaredArgument?.linearCoefficient ?? 0,
          ) +
          Math.imul(
            callee.linearCoefficient,
            argument.linearCoefficient,
          )
        ) | 0,
        constantCoefficient: (
          Math.imul(
            callee.quadraticCoefficient,
            squaredArgument?.constantCoefficient ?? 0,
          ) +
          Math.imul(
            callee.linearCoefficient,
            argument.constantCoefficient,
          ) + callee.constantCoefficient
        ) | 0,
      };
    }
    if (result === undefined) return undefined;
    values.set(operation.result, result);
  }
  const result = values.get(block.terminator.values[0]);
  if (result !== undefined) summaries.set(shape.function.id, result);
  return result;
}

function multiplyQuadraticMaps(
  left: QuadraticMap,
  right: QuadraticMap,
): QuadraticMap | undefined {
  const cubicCoefficient = (
    Math.imul(left.linearCoefficient, right.quadraticCoefficient) +
    Math.imul(left.quadraticCoefficient, right.linearCoefficient)
  ) | 0;
  const quarticCoefficient = Math.imul(
    left.quadraticCoefficient,
    right.quadraticCoefficient,
  );
  if (cubicCoefficient !== 0 || quarticCoefficient !== 0) return undefined;
  return {
    quadraticCoefficient: (
      Math.imul(left.constantCoefficient, right.quadraticCoefficient) +
      Math.imul(left.linearCoefficient, right.linearCoefficient) +
      Math.imul(left.quadraticCoefficient, right.constantCoefficient)
    ) | 0,
    linearCoefficient: (
      Math.imul(left.constantCoefficient, right.linearCoefficient) +
      Math.imul(left.linearCoefficient, right.constantCoefficient)
    ) | 0,
    constantCoefficient: Math.imul(
      left.constantCoefficient,
      right.constantCoefficient,
    ),
  };
}

function countFunctionReferences(
  core: CoreModule,
  functionId: CoreFunctionId,
): number {
  let references = 0;
  for (const function_ of core.functions) {
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (
          (operation.kind === "call.direct" ||
            operation.kind === "closure.make") &&
          operation.functionId === functionId
        ) {
          references += 1;
        }
      }
    }
  }
  return references;
}

function simpleNaturalLoop(
  function_: CoreFunction,
): {
  readonly entry: CoreFunction["blocks"][number];
  readonly header: CoreFunction["blocks"][number];
  readonly body: CoreFunction["blocks"][number];
  readonly exit: CoreFunction["blocks"][number];
} | undefined {
  if (function_.blocks.length !== 4) return undefined;
  const entry = function_.blocks[function_.entryBlock];
  if (entry.terminator.kind !== "branch") return undefined;
  const header = function_.blocks[entry.terminator.target];
  if (header.terminator.kind !== "conditional_branch") return undefined;
  const trueBlock = function_.blocks[header.terminator.trueTarget];
  const falseBlock = function_.blocks[header.terminator.falseTarget];
  const body = trueBlock.terminator.kind === "branch" &&
      trueBlock.terminator.target === header.id
    ? trueBlock
    : falseBlock.terminator.kind === "branch" &&
        falseBlock.terminator.target === header.id
    ? falseBlock
    : undefined;
  if (body === undefined) return undefined;
  const exit = body.id === trueBlock.id ? falseBlock : trueBlock;
  if (exit.terminator.kind !== "return" && exit.terminator.kind !== "trap") {
    return undefined;
  }
  if (
    new Set([entry.id, header.id, body.id, exit.id]).size !== 4 ||
    body.terminator.kind !== "branch"
  ) {
    return undefined;
  }
  return { entry, header, body, exit };
}

function affineNaturalLoop(
  core: CoreModule,
  function_: CoreFunction,
  summarizeUnary: (functionId: CoreFunctionId) => AffineMap | undefined = (
    functionId,
  ) => affineUnaryFunction(core, functionId),
): AffineNaturalLoop | undefined {
  const loop = simpleNaturalLoop(function_);
  if (
    loop === undefined || loop.entry.terminator.kind !== "branch" ||
    loop.header.terminator.kind !== "conditional_branch" ||
    loop.header.terminator.trueTarget !== loop.body.id ||
    loop.body.terminator.kind !== "branch" ||
    loop.header.parameters.length !== 2 ||
    loop.body.terminator.arguments.length !== 2 ||
    loop.header.terminator.falseArguments.length !== 1
  ) {
    return undefined;
  }
  const operations = new Map(
    function_.blocks.flatMap((block) =>
      block.operations.map((operation) =>
        [operation.result, operation] as const
      )
    ),
  );
  const condition = operations.get(loop.header.terminator.condition);
  if (
    condition?.kind !== "scalar.binary" || condition.operator !== ">" ||
    condition.operands.length !== 2
  ) {
    return undefined;
  }
  const counter = condition.operands[0];
  const zero = operations.get(condition.operands[1]);
  if (zero?.kind !== "constant" || zero.value !== 0) return undefined;
  const counterIndex = loop.header.parameters.findIndex((parameter) =>
    parameter.value === counter
  );
  if (counterIndex < 0) return undefined;
  const stateIndex = counterIndex === 0 ? 1 : 0;
  const state = loop.header.parameters[stateIndex].value;
  if (loop.header.terminator.falseArguments[0] !== state) return undefined;

  const nextCounter = operations.get(
    loop.body.terminator.arguments[counterIndex],
  );
  const nextState = operations.get(loop.body.terminator.arguments[stateIndex]);
  if (
    nextCounter?.kind !== "scalar.binary" || nextCounter.operator !== "-" ||
    nextCounter.operands[0] !== counter || nextState === undefined
  ) {
    return undefined;
  }
  const one = operations.get(nextCounter.operands[1]);
  if (one?.kind !== "constant" || one.value !== 1) return undefined;

  const initialCounter = loop.entry.terminator.arguments[counterIndex];
  const initialCounterOperation = operations.get(initialCounter);
  let exactIterations: number | undefined;
  let maximumIterations: number | undefined;
  if (
    initialCounterOperation?.kind === "constant" &&
    typeof initialCounterOperation.value === "number"
  ) {
    exactIterations = Math.max(0, initialCounterOperation.value | 0);
    maximumIterations = exactIterations;
  } else if (
    initialCounterOperation?.kind === "scalar.binary" &&
    initialCounterOperation.operator === "%"
  ) {
    const divisor = operations.get(initialCounterOperation.operands[1]);
    if (
      divisor?.kind === "constant" && typeof divisor.value === "number" &&
      divisor.value > 0
    ) {
      maximumIterations = (divisor.value | 0) - 1;
    }
  }
  if (nextState.kind === "call.direct") {
    if (nextState.operands.length !== 1 || nextState.operands[0] !== state) {
      return undefined;
    }
    const affine = summarizeUnary(nextState.functionId);
    const requiredBodyResults = new Set([
      nextCounter.result,
      nextState.result,
      one.result,
    ]);
    if (
      affine === undefined ||
      loop.body.operations.length !== requiredBodyResults.size ||
      loop.body.operations.some((operation) =>
        !requiredBodyResults.has(operation.result)
      )
    ) {
      return undefined;
    }
    return {
      loop,
      counter,
      state,
      multiplier: affine.multiplier,
      offset: affine.offset,
      exactIterations,
      maximumIterations,
      summarizedCallResult: nextState.result,
    };
  }
  if (nextState.kind !== "scalar.binary" || nextState.operator !== "+") {
    return undefined;
  }
  const multiply = nextState.operands.map((operand) => operations.get(operand))
    .find((operation) =>
      operation?.kind === "scalar.binary" && operation.operator === "*"
    );
  const offset = nextState.operands.map((operand) => operations.get(operand))
    .find((operation) => operation?.kind === "constant");
  if (
    multiply?.kind !== "scalar.binary" || offset?.kind !== "constant" ||
    typeof offset.value !== "number"
  ) {
    return undefined;
  }
  const multiplier = multiply.operands.map((operand) => operations.get(operand))
    .find((operation) => operation?.kind === "constant");
  if (
    multiplier?.kind !== "constant" || typeof multiplier.value !== "number" ||
    !multiply.operands.includes(state)
  ) {
    return undefined;
  }
  const requiredResults = new Set([
    nextCounter.result,
    nextState.result,
    one.result,
    multiply.result,
    multiplier.result,
    offset.result,
  ]);
  if (
    loop.body.operations.length !== requiredResults.size ||
    loop.body.operations.some((operation) =>
      !requiredResults.has(operation.result)
    )
  ) {
    return undefined;
  }
  return {
    loop,
    counter,
    state,
    multiplier: multiplier.value | 0,
    offset: offset.value | 0,
    exactIterations,
    maximumIterations,
    summarizedCallResult: undefined,
  };
}

function acceleratedAffineNaturalLoop(
  core: CoreModule,
  function_: CoreFunction,
): AffineNaturalLoop | undefined {
  const affine = affineNaturalLoop(core, function_);
  return affine?.maximumIterations !== undefined &&
      affine.maximumIterations <= maximumLinearAffineIterations
    ? undefined
    : affine;
}

function affineUnaryFunction(
  core: CoreModule,
  rootFunctionId: CoreFunctionId,
): AffineMap | undefined {
  const summaries = new Map<CoreFunctionId, AffineMap | undefined>();
  const summarize = (
    functionId: CoreFunctionId,
    ancestors: ReadonlySet<CoreFunctionId>,
  ): AffineMap | undefined => {
    if (ancestors.has(functionId)) return undefined;
    if (summaries.has(functionId)) return summaries.get(functionId);

    const function_ = core.functions[functionId];
    const signature = function_ === undefined
      ? undefined
      : core.signatures[function_.signature];
    const parameterType = signature === undefined
      ? undefined
      : core.types[signature.parameters[0]];
    const resultType = signature === undefined
      ? undefined
      : core.types[signature.result];
    if (
      function_ === undefined || signature === undefined ||
      signature.parameters.length !== 1 ||
      parameterType?.kind !== "scalar" || parameterType.scalar !== "i32" ||
      resultType?.kind !== "scalar" || resultType.scalar !== "i32"
    ) {
      summaries.set(functionId, undefined);
      return undefined;
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(functionId);
    const summarizeNested = (calleeId: CoreFunctionId): AffineMap | undefined =>
      summarize(calleeId, nextAncestors);
    if (function_.blocks.length !== 1) {
      const affineLoop = affineNaturalLoop(
        core,
        function_,
        summarizeNested,
      );
      if (affineLoop?.exactIterations === undefined) {
        summaries.set(functionId, undefined);
        return undefined;
      }
      const loop = affineLoop.loop;
      if (
        loop.entry.terminator.kind !== "branch" ||
        loop.header.terminator.kind !== "conditional_branch" ||
        loop.exit.terminator.kind !== "return"
      ) {
        summaries.set(functionId, undefined);
        return undefined;
      }
      const stateIndex = loop.header.parameters.findIndex((parameter) =>
        parameter.value === affineLoop.state
      );
      const counterIndex = stateIndex === 0 ? 1 : 0;
      const initialCounter = loop.entry.terminator.arguments[counterIndex];
      const initialState = loop.entry.terminator.arguments[stateIndex];
      const initialCounterOperation = loop.entry.operations.find((operation) =>
        operation.result === initialCounter
      );
      const conditionValue = loop.header.terminator.condition;
      const condition = loop.header.operations.find((operation) =>
        operation.result === conditionValue
      );
      const headerResults = condition?.kind === "scalar.binary"
        ? new Set([condition.result, condition.operands[1]])
        : undefined;
      if (
        stateIndex < 0 || loop.entry.parameters.length !== 1 ||
        initialCounterOperation?.kind !== "constant" ||
        headerResults === undefined || loop.header.operations.length !== 2 ||
        loop.header.operations.some((operation) =>
          !headerResults.has(operation.result)
        ) ||
        loop.exit.parameters.length !== 1 ||
        loop.exit.terminator.values.length !== 1
      ) {
        summaries.set(functionId, undefined);
        return undefined;
      }
      const prepared = summarizeAffineBlock(
        core,
        loop.entry,
        new Map([[
          loop.entry.parameters[0].value,
          { multiplier: 1, offset: 0 },
        ]]),
        initialState,
        summarizeNested,
      );
      const finished = summarizeAffineBlock(
        core,
        loop.exit,
        new Map([[
          loop.exit.parameters[0].value,
          { multiplier: 1, offset: 0 },
        ]]),
        loop.exit.terminator.values[0],
        summarizeNested,
      );
      if (prepared === undefined || finished === undefined) {
        summaries.set(functionId, undefined);
        return undefined;
      }
      let result = { multiplier: 1, offset: 0 };
      let power = {
        multiplier: affineLoop.multiplier,
        offset: affineLoop.offset,
      };
      let remaining = affineLoop.exactIterations;
      while (remaining > 0) {
        if ((remaining & 1) !== 0) {
          result = composeAffineMaps(power, result);
        }
        power = composeAffineMaps(power, power);
        remaining >>>= 1;
      }
      result = composeAffineMaps(
        finished,
        composeAffineMaps(result, prepared),
      );
      summaries.set(functionId, result);
      return result;
    }

    const block = function_.blocks[function_.entryBlock];
    if (
      block === undefined || block.parameters.length !== 1 ||
      block.terminator.kind !== "return" ||
      block.terminator.values.length !== 1
    ) {
      summaries.set(functionId, undefined);
      return undefined;
    }
    const result = summarizeAffineBlock(
      core,
      block,
      new Map([[
        block.parameters[0].value,
        { multiplier: 1, offset: 0 },
      ]]),
      block.terminator.values[0],
      summarizeNested,
    );
    summaries.set(functionId, result);
    return result;
  };
  return summarize(rootFunctionId, new Set());
}

function summarizeAffineBlock(
  core: CoreModule,
  block: CoreFunction["blocks"][number],
  parameterMaps: ReadonlyMap<CoreValueId, AffineMap>,
  resultValue: CoreValueId,
  summarizeUnary: (functionId: CoreFunctionId) => AffineMap | undefined,
): AffineMap | undefined {
  const values = new Map(parameterMaps);
  for (const operation of block.operations) {
    const operationType = core.types[operation.type];
    if (operationType?.kind !== "scalar" || operationType.scalar !== "i32") {
      return undefined;
    }
    if (values.has(operation.result)) continue;

    let summary: AffineMap | undefined;
    if (
      operation.kind === "constant" && typeof operation.value === "number"
    ) {
      summary = { multiplier: 0, offset: operation.value | 0 };
    } else if (
      operation.kind === "scalar.binary" &&
      (operation.operator === "+" || operation.operator === "-" ||
        operation.operator === "*")
    ) {
      const left = values.get(operation.operands[0]);
      const right = values.get(operation.operands[1]);
      if (left === undefined || right === undefined) return undefined;
      if (operation.operator === "+") {
        summary = {
          multiplier: (left.multiplier + right.multiplier) | 0,
          offset: (left.offset + right.offset) | 0,
        };
      } else if (operation.operator === "-") {
        summary = {
          multiplier: (left.multiplier - right.multiplier) | 0,
          offset: (left.offset - right.offset) | 0,
        };
      } else if (left.multiplier === 0 || right.multiplier === 0) {
        summary = {
          multiplier: (
            Math.imul(left.multiplier, right.offset) +
            Math.imul(right.multiplier, left.offset)
          ) | 0,
          offset: Math.imul(left.offset, right.offset),
        };
      }
    } else if (
      operation.kind === "call.direct" && operation.operands.length === 1
    ) {
      const argument = values.get(operation.operands[0]);
      const callee = summarizeUnary(operation.functionId);
      if (argument !== undefined && callee !== undefined) {
        summary = composeAffineMaps(callee, argument);
      }
    }
    if (summary === undefined) return undefined;
    values.set(operation.result, summary);
  }
  return values.get(resultValue);
}

function composeAffineMaps(outer: AffineMap, inner: AffineMap): AffineMap {
  return {
    multiplier: Math.imul(outer.multiplier, inner.multiplier),
    offset: (
      Math.imul(outer.multiplier, inner.offset) + outer.offset
    ) | 0,
  };
}

function emitAffineNaturalLoop(
  function_: CoreFunction,
  layout: FunctionValueLayout,
  affine: AffineNaturalLoop,
  emitBlockOperations: (block: number) => readonly WasmInstruction[],
  emitValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const { loop } = affine;
  if (
    loop.entry.terminator.kind !== "branch" ||
    loop.header.terminator.kind !== "conditional_branch" ||
    layout.affineMultiplierLocal === undefined ||
    layout.affineOffsetLocal === undefined
  ) {
    throw new Error(
      `Core function ${function_.name} lost its affine-loop certificate`,
    );
  }
  const counterLocal = requiredLocal(layout, function_, affine.counter);
  const stateLocal = requiredLocal(layout, function_, affine.state);
  return [
    ...emitBlockOperations(loop.entry.id),
    ...emitEdgeAssignment(
      loop.entry.terminator.arguments,
      loop.header,
      function_,
      layout,
      emitValue,
    ),
    ...wasmInstruction.i32Constant(affine.multiplier),
    ...wasmInstruction.localSet(layout.affineMultiplierLocal),
    ...wasmInstruction.i32Constant(affine.offset),
    ...wasmInstruction.localSet(layout.affineOffsetLocal),
    ...wasmInstruction.blockVoid,
    ...wasmInstruction.loopVoid,
    ...emitEdgeAssignment(
      loop.header.terminator.falseArguments,
      loop.exit,
      function_,
      layout,
      emitValue,
    ),
    ...emitValue(loop.header.terminator.condition),
    ...wasmInstruction.i32EqualZero,
    ...wasmInstruction.branchIf(1),
    ...wasmInstruction.localGet(counterLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32And,
    ...wasmInstruction.ifVoid,
    ...wasmInstruction.localGet(stateLocal),
    ...wasmInstruction.localGet(layout.affineMultiplierLocal),
    ...wasmInstruction.i32Multiply,
    ...wasmInstruction.localGet(layout.affineOffsetLocal),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localSet(stateLocal),
    ...wasmInstruction.end,
    ...wasmInstruction.localGet(layout.affineMultiplierLocal),
    ...wasmInstruction.localGet(layout.affineOffsetLocal),
    ...wasmInstruction.i32Multiply,
    ...wasmInstruction.localGet(layout.affineOffsetLocal),
    ...wasmInstruction.i32Add,
    ...wasmInstruction.localSet(layout.affineOffsetLocal),
    ...wasmInstruction.localGet(layout.affineMultiplierLocal),
    ...wasmInstruction.localGet(layout.affineMultiplierLocal),
    ...wasmInstruction.i32Multiply,
    ...wasmInstruction.localSet(layout.affineMultiplierLocal),
    ...wasmInstruction.localGet(counterLocal),
    ...wasmInstruction.i32Constant(1),
    ...wasmInstruction.i32ShiftRightUnsigned,
    ...wasmInstruction.localSet(counterLocal),
    ...wasmInstruction.branch(0),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
    ...emitBlockOperations(loop.exit.id),
    ...emitTerminator(loop.exit.terminator, function_, layout, 0, emitValue),
  ];
}

function emitSimpleNaturalLoopRegion(
  function_: CoreFunction,
  layout: FunctionValueLayout,
  loop: SimpleNaturalLoop,
  emitBlockOperations: (block: number) => readonly WasmInstruction[],
  emitValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const continuesOnTrue = loop.header.terminator.kind ===
      "conditional_branch" &&
    loop.header.terminator.trueTarget === loop.body.id;
  const bodyArguments = loop.header.terminator.kind === "conditional_branch"
    ? continuesOnTrue
      ? loop.header.terminator.trueArguments
      : loop.header.terminator.falseArguments
    : [];
  const exitArguments = loop.header.terminator.kind === "conditional_branch"
    ? continuesOnTrue
      ? loop.header.terminator.falseArguments
      : loop.header.terminator.trueArguments
    : [];
  const condition = loop.header.terminator.kind === "conditional_branch"
    ? loop.header.terminator.condition
    : undefined;
  if (
    loop.entry.terminator.kind !== "branch" ||
    loop.body.terminator.kind !== "branch" || condition === undefined
  ) {
    throw new Error(
      `Core function ${function_.name} has an incomplete natural-loop certificate`,
    );
  }
  return [
    ...emitBlockOperations(loop.entry.id),
    ...emitEdgeAssignment(
      loop.entry.terminator.arguments,
      loop.header,
      function_,
      layout,
      emitValue,
    ),
    ...wasmInstruction.blockVoid,
    ...wasmInstruction.loopVoid,
    ...emitBlockOperations(loop.header.id),
    ...emitEdgeAssignment(
      exitArguments,
      loop.exit,
      function_,
      layout,
      emitValue,
    ),
    ...emitValue(condition),
    ...(continuesOnTrue ? wasmInstruction.i32EqualZero : []),
    ...wasmInstruction.branchIf(1),
    ...emitEdgeAssignment(
      bodyArguments,
      loop.body,
      function_,
      layout,
      emitValue,
    ),
    ...emitBlockOperations(loop.body.id),
    ...emitEdgeAssignment(
      loop.body.terminator.arguments,
      loop.header,
      function_,
      layout,
      emitValue,
    ),
    ...wasmInstruction.branch(0),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
  ];
}

function diamondBodyNaturalLoop(
  function_: CoreFunction,
): DiamondBodyNaturalLoop | undefined {
  if (function_.blocks.length !== 7) return undefined;
  const entry = function_.blocks[function_.entryBlock];
  if (entry.terminator.kind !== "branch") return undefined;
  const header = function_.blocks[entry.terminator.target];
  if (header.terminator.kind !== "conditional_branch") return undefined;
  const trueSuccessor = function_.blocks[header.terminator.trueTarget];
  const falseSuccessor = function_.blocks[header.terminator.falseTarget];
  const continuesOnTrue = trueSuccessor.terminator.kind ===
    "conditional_branch";
  const bodyCondition = continuesOnTrue ? trueSuccessor : falseSuccessor;
  const exit = continuesOnTrue ? falseSuccessor : trueSuccessor;
  if (
    bodyCondition.terminator.kind !== "conditional_branch" ||
    (exit.terminator.kind !== "return" && exit.terminator.kind !== "trap")
  ) {
    return undefined;
  }
  const trueBlock = function_.blocks[bodyCondition.terminator.trueTarget];
  const falseBlock = function_.blocks[bodyCondition.terminator.falseTarget];
  if (
    trueBlock.terminator.kind !== "branch" ||
    falseBlock.terminator.kind !== "branch" ||
    trueBlock.terminator.target !== falseBlock.terminator.target
  ) {
    return undefined;
  }
  const latch = function_.blocks[trueBlock.terminator.target];
  if (
    latch.terminator.kind !== "branch" ||
    latch.terminator.target !== header.id ||
    new Set([
        entry.id,
        header.id,
        bodyCondition.id,
        trueBlock.id,
        falseBlock.id,
        latch.id,
        exit.id,
      ]).size !== 7
  ) {
    return undefined;
  }
  return {
    entry,
    header,
    bodyCondition,
    trueBlock,
    falseBlock,
    latch,
    exit,
    continuesOnTrue,
  };
}

function emitDiamondBodyNaturalLoopRegion(
  function_: CoreFunction,
  layout: FunctionValueLayout,
  loop: DiamondBodyNaturalLoop,
  selection: "select" | "branch",
  emitBlockOperations: (block: number) => readonly WasmInstruction[],
  emitValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  if (
    loop.entry.terminator.kind !== "branch" ||
    loop.header.terminator.kind !== "conditional_branch" ||
    loop.bodyCondition.terminator.kind !== "conditional_branch" ||
    loop.trueBlock.terminator.kind !== "branch" ||
    loop.falseBlock.terminator.kind !== "branch" ||
    loop.latch.terminator.kind !== "branch"
  ) {
    throw new Error(
      `Core function ${function_.name} lost its diamond-body loop certificate`,
    );
  }
  const bodyArguments = loop.continuesOnTrue
    ? loop.header.terminator.trueArguments
    : loop.header.terminator.falseArguments;
  const exitArguments = loop.continuesOnTrue
    ? loop.header.terminator.falseArguments
    : loop.header.terminator.trueArguments;
  return [
    ...emitBlockOperations(loop.entry.id),
    ...emitEdgeAssignment(
      loop.entry.terminator.arguments,
      loop.header,
      function_,
      layout,
      emitValue,
    ),
    ...wasmInstruction.blockVoid,
    ...wasmInstruction.loopVoid,
    ...emitBlockOperations(loop.header.id),
    ...emitEdgeAssignment(
      exitArguments,
      loop.exit,
      function_,
      layout,
      emitValue,
    ),
    ...emitValue(loop.header.terminator.condition),
    ...(loop.continuesOnTrue ? wasmInstruction.i32EqualZero : []),
    ...wasmInstruction.branchIf(1),
    ...emitDiamondBodyIteration(
      function_,
      layout,
      loop,
      bodyArguments,
      selection,
      emitBlockOperations,
      emitValue,
    ),
    ...wasmInstruction.branch(0),
    ...wasmInstruction.end,
    ...wasmInstruction.end,
  ];
}

function emitDiamondBodyIteration(
  function_: CoreFunction,
  layout: FunctionValueLayout,
  loop: DiamondBodyNaturalLoop,
  bodyArguments: readonly CoreValueId[],
  selection: "select" | "branch",
  emitBlockOperations: (block: number) => readonly WasmInstruction[],
  emitValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  if (
    loop.bodyCondition.terminator.kind !== "conditional_branch" ||
    loop.trueBlock.terminator.kind !== "branch" ||
    loop.falseBlock.terminator.kind !== "branch" ||
    loop.latch.terminator.kind !== "branch"
  ) {
    throw new Error(
      `Core function ${function_.name} lost its diamond-body iteration certificate`,
    );
  }
  const prelude = [
    ...emitEdgeAssignment(
      bodyArguments,
      loop.bodyCondition,
      function_,
      layout,
      emitValue,
    ),
    ...emitBlockOperations(loop.bodyCondition.id),
  ];
  const suffix = [
    ...emitBlockOperations(loop.latch.id),
    ...emitEdgeAssignment(
      loop.latch.terminator.arguments,
      loop.header,
      function_,
      layout,
      emitValue,
    ),
  ];
  if (selection === "select") {
    const latchParameter = loop.latch.parameters[0];
    const trueValue = loop.trueBlock.terminator.arguments[0];
    const falseValue = loop.falseBlock.terminator.arguments[0];
    if (
      latchParameter === undefined || trueValue === undefined ||
      falseValue === undefined
    ) {
      throw new Error(
        `Core function ${function_.name} lost its selectable loop diamond`,
      );
    }
    return [
      ...prelude,
      ...emitBlockOperations(loop.trueBlock.id),
      ...emitValue(trueValue),
      ...emitBlockOperations(loop.falseBlock.id),
      ...emitValue(falseValue),
      ...emitValue(loop.bodyCondition.terminator.condition),
      ...wasmInstruction.select,
      ...wasmInstruction.localSet(
        requiredLocal(layout, function_, latchParameter.value),
      ),
      ...suffix,
    ];
  }
  return [
    ...prelude,
    ...emitValue(loop.bodyCondition.terminator.condition),
    ...wasmInstruction.ifVoid,
    ...emitEdgeAssignment(
      loop.bodyCondition.terminator.trueArguments,
      loop.trueBlock,
      function_,
      layout,
      emitValue,
    ),
    ...emitBlockOperations(loop.trueBlock.id),
    ...emitEdgeAssignment(
      loop.trueBlock.terminator.arguments,
      loop.latch,
      function_,
      layout,
      emitValue,
    ),
    ...wasmInstruction.else,
    ...emitEdgeAssignment(
      loop.bodyCondition.terminator.falseArguments,
      loop.falseBlock,
      function_,
      layout,
      emitValue,
    ),
    ...emitBlockOperations(loop.falseBlock.id),
    ...emitEdgeAssignment(
      loop.falseBlock.terminator.arguments,
      loop.latch,
      function_,
      layout,
      emitValue,
    ),
    ...wasmInstruction.end,
    ...suffix,
  ];
}

function emitStackValue(
  core: CoreModule,
  function_: CoreFunction,
  value: CoreValueId,
  layout: FunctionValueLayout,
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
  resolveStackParameter?: (
    value: CoreValueId,
  ) => readonly WasmInstruction[] | undefined,
): readonly WasmInstruction[] {
  const local = layout.localByValue.get(value);
  if (local !== undefined) return wasmInstruction.localGet(local);
  const stackParameter = resolveStackParameter?.(value);
  if (stackParameter !== undefined) return stackParameter;
  const operation = layout.operationByResult.get(value);
  if (operation === undefined) {
    throw new Error(
      `Core function ${function_.name} has no stack definition for value ${value}`,
    );
  }
  if (
    !isStackifiableOperation(operation) &&
    !layout.inlineScalarTreeByCallResult.has(operation.result)
  ) {
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
        resolveStackParameter,
      ),
  );
}

function emitOperation(
  core: CoreModule,
  function_: CoreFunction,
  operation: CoreOperation,
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
          moduleName: coreRuntimeImportModule,
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
  if (operation.kind === "vector.shuffle") {
    const type = core.types[operation.type];
    if (
      type.kind !== "vector" || type.lanes !== 4 || type.element !== "f32"
    ) {
      throw new TypeError(
        `${operation.span.file}:${operation.span.start}: Wasm backend supports shuffle only for f32x4`,
      );
    }
    return finish([
      ...getOperands(),
      ...wasmInstruction.i8x16Shuffle(
        operation.lanes.flatMap((lane) =>
          [0, 1, 2, 3].map((byteOffset) => lane * 4 + byteOffset)
        ),
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
    if (
      operation.primitiveId >= PrimitiveId.f32x4ExtractLane0 &&
      operation.primitiveId <= PrimitiveId.f32x4ExtractLane3
    ) {
      return finish([
        ...getOperands(),
        ...wasmInstruction.f32x4ExtractLane(
          operation.primitiveId - PrimitiveId.f32x4ExtractLane0,
        ),
      ]);
    }
    if (
      operation.primitiveId >= PrimitiveId.f32x4ReplaceLane0 &&
      operation.primitiveId <= PrimitiveId.f32x4ReplaceLane3
    ) {
      return finish([
        ...getOperands(),
        ...wasmInstruction.f32x4ReplaceLane(
          operation.primitiveId - PrimitiveId.f32x4ReplaceLane0,
        ),
      ]);
    }
    if (operation.primitiveId === PrimitiveId.f32x4Select) {
      return finish([
        ...getValue(operation.operands[1]),
        ...getValue(operation.operands[2]),
        ...getValue(operation.operands[0]),
        ...wasmInstruction.v128BitSelect,
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
        moduleName: coreRuntimeImportModule,
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
    operation.kind.startsWith("store.") ||
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
          : coreRuntimeImportModule,
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
    const inlineScalarTree = layout.inlineScalarTreeByCallResult.get(
      operation.result,
    );
    if (inlineScalarTree !== undefined) {
      return finish(
        emitInlineScalarTree(
          core,
          operation,
          inlineScalarTree,
          importedFunctions,
          functionIndices,
          closureTargets,
          closureTypeIndices,
          textHandles,
          getValue,
        ),
      );
    }
    const inlineLoop = layout.inlineLoopByCallResult.get(operation.result);
    if (inlineLoop !== undefined) {
      return finish(
        inlineLoop.structure === "simple"
          ? emitInlineSimpleBodyLoop(
            core,
            operation,
            inlineLoop,
            importedFunctions,
            functionIndices,
            closureTargets,
            closureTypeIndices,
            textHandles,
            getValue,
          )
          : emitInlineDiamondBodyLoop(
            core,
            operation,
            inlineLoop,
            importedFunctions,
            functionIndices,
            closureTargets,
            closureTypeIndices,
            textHandles,
            getValue,
          ),
      );
    }
    const inlineLayout = layout.inlineDiamondByCallResult.get(
      operation.result,
    );
    if (inlineLayout !== undefined) {
      return finish(
        emitInlineDiamond(
          core,
          operation,
          inlineLayout,
          importedFunctions,
          functionIndices,
          closureTargets,
          closureTypeIndices,
          textHandles,
          getValue,
        ),
      );
    }
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
        moduleName: coreRuntimeImportModule,
        fieldName: managedProductMakeImportName(operation.operands.length),
        parameters: captureTypes,
        result: wasmType.i32,
      },
      operation,
    );
    const makeClosure = requireImportedFunction(
      importedFunctions,
      {
        moduleName: coreRuntimeImportModule,
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
    operation.kind === "seal.wrap" ||
    operation.kind === "seal.unwrap" ||
    operation.kind === "resource.move" ||
    operation.kind === "resource.borrow" ||
    operation.kind === "resource.freeze" ||
    operation.kind === "region.allocate"
  ) {
    return finish(getValue(operation.operands.at(-1)!));
  }
  if (operation.kind === "resource.drop") {
    return finish(wasmInstruction.i32Constant(0));
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

function emitInlineScalarTree(
  core: CoreModule,
  call: Extract<CoreOperation, { readonly kind: "call.direct" }>,
  tree: InlineScalarTreeLayout,
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
  getCallerValue: (value: CoreValueId) => readonly WasmInstruction[],
  resultSuffix: AffineMap = { multiplier: 1, offset: 0 },
): readonly WasmInstruction[] {
  const entry = tree.function.blocks[tree.function.entryBlock];
  if (entry.parameters.length !== call.operands.length) {
    throw new Error(
      `Core inline tree ${tree.function.name} expects ${entry.parameters.length} operands; received ${call.operands.length}`,
    );
  }
  const stackArgument = tree.stackParameter === undefined
    ? undefined
    : getCallerValue(call.operands[0]);
  const layout: FunctionValueLayout = {
    localByValue: tree.localByValue,
    typeByValue: valueTypes(tree.function),
    operationByResult: new Map(
      tree.function.blocks.flatMap((block) =>
        block.operations.map((operation) =>
          [operation.result, operation] as const
        )
      ),
    ),
    locals: [],
    dispatchLocal: undefined,
    byteIndexLocal: undefined,
    affineMultiplierLocal: undefined,
    affineOffsetLocal: undefined,
    inlineDiamondByCallResult: new Map(),
    inlineLoopByCallResult: new Map(),
    inlineScalarTreeByCallResult: tree.callsByResult,
  };
  const resolveStackParameter = (
    value: CoreValueId,
  ): readonly WasmInstruction[] | undefined => {
    if (value === tree.stackParameter) {
      if (stackArgument === undefined) {
        throw new Error(
          `Core inline tree ${tree.function.name} lost its stack argument`,
        );
      }
      return stackArgument;
    }
    return undefined;
  };
  const getValue = (value: CoreValueId): readonly WasmInstruction[] =>
    emitStackValue(
      core,
      tree.function,
      value,
      layout,
      importedFunctions,
      functionIndices,
      closureTargets,
      closureTypeIndices,
      textHandles,
      resolveStackParameter,
    );
  const emitOperations = (
    block: CoreFunction["blocks"][number],
  ): readonly WasmInstruction[] =>
    block.operations.flatMap((operation) => {
      if (!layout.localByValue.has(operation.result)) return [];
      if (operation.kind === "call.direct") {
        const child = tree.callsByResult.get(operation.result);
        if (child === undefined) {
          throw new Error(
            `Core inline tree ${tree.function.name} lost call result ${operation.result}`,
          );
        }
        return [
          ...emitInlineScalarTree(
            core,
            operation,
            child,
            importedFunctions,
            functionIndices,
            closureTargets,
            closureTypeIndices,
            textHandles,
            getValue,
          ),
          ...wasmInstruction.localSet(
            requiredLocal(layout, tree.function, operation.result),
          ),
        ];
      }
      return emitOperation(
        core,
        tree.function,
        operation,
        layout,
        importedFunctions,
        functionIndices,
        closureTargets,
        closureTypeIndices,
        textHandles,
        getValue,
      );
    });
  const binding = tree.stackParameter === undefined
    ? [
      ...call.operands.flatMap(getCallerValue),
      ...[...entry.parameters].reverse().flatMap((parameter) =>
        wasmInstruction.localSet(
          requiredLocal(layout, tree.function, parameter.value),
        )
      ),
    ]
    : [];
  if (tree.affineSuffix !== undefined) {
    const childCall = layout.operationByResult.get(
      tree.affineSuffix.callResult,
    );
    const child = tree.callsByResult.get(tree.affineSuffix.callResult);
    if (childCall?.kind !== "call.direct" || child === undefined) {
      throw new Error(
        `Core inline tree ${tree.function.name} lost its affine child ${tree.affineSuffix.callResult}`,
      );
    }
    return [
      ...binding,
      ...emitInlineScalarTree(
        core,
        childCall,
        child,
        importedFunctions,
        functionIndices,
        closureTargets,
        closureTypeIndices,
        textHandles,
        getValue,
        composeAffineMaps(resultSuffix, tree.affineSuffix.map),
      ),
    ];
  }
  if (tree.quadraticResult !== undefined) {
    const parameter = entry.parameters[0];
    if (parameter === undefined) {
      throw new Error(
        `Core inline tree ${tree.function.name} lost its quadratic parameter`,
      );
    }
    const quadraticCoefficient = Math.imul(
      resultSuffix.multiplier,
      tree.quadraticResult.quadraticCoefficient,
    );
    const linearCoefficient = Math.imul(
      resultSuffix.multiplier,
      tree.quadraticResult.linearCoefficient,
    );
    const constantCoefficient = (
      Math.imul(
        resultSuffix.multiplier,
        tree.quadraticResult.constantCoefficient,
      ) + resultSuffix.offset
    ) | 0;
    const parameterValue = (): readonly WasmInstruction[] =>
      getValue(parameter.value);
    const instructions: WasmInstruction[] = [];
    if (quadraticCoefficient !== 0) {
      instructions.push(
        ...(quadraticCoefficient === 1 ? parameterValue() : [
          ...wasmInstruction.i32Constant(quadraticCoefficient),
          ...parameterValue(),
          ...wasmInstruction.i32Multiply,
        ]),
        ...(linearCoefficient === 0 ? [] : [
          ...wasmInstruction.i32Constant(linearCoefficient),
          ...wasmInstruction.i32Add,
        ]),
        ...parameterValue(),
        ...wasmInstruction.i32Multiply,
      );
    } else if (linearCoefficient !== 0) {
      instructions.push(
        ...(linearCoefficient === 1 ? parameterValue() : [
          ...wasmInstruction.i32Constant(linearCoefficient),
          ...parameterValue(),
          ...wasmInstruction.i32Multiply,
        ]),
      );
    }
    if (constantCoefficient !== 0 || instructions.length === 0) {
      instructions.push(
        ...wasmInstruction.i32Constant(constantCoefficient),
        ...(instructions.length === 0 ? [] : wasmInstruction.i32Add),
      );
    }
    return [...binding, ...instructions];
  }
  const suffixInstructions = [
    ...(resultSuffix.multiplier === 1 ? [] : [
      ...wasmInstruction.i32Constant(resultSuffix.multiplier),
      ...wasmInstruction.i32Multiply,
    ]),
    ...(resultSuffix.offset === 0 ? [] : [
      ...wasmInstruction.i32Constant(resultSuffix.offset),
      ...wasmInstruction.i32Add,
    ]),
  ];
  if (tree.structure === "single") {
    const returned = entry.terminator.kind === "return"
      ? entry.terminator.values[0]
      : undefined;
    if (returned === undefined) {
      throw new Error(`Core inline tree ${tree.function.name} lost its return`);
    }
    return [
      ...binding,
      ...emitOperations(entry),
      ...getValue(returned),
      ...suffixInstructions,
    ];
  }
  const diamond = simpleDiamond(tree.function);
  if (
    diamond === undefined || diamond.entry.terminator.kind !==
      "conditional_branch" ||
    diamond.trueBlock.terminator.kind !== "branch" ||
    diamond.falseBlock.terminator.kind !== "branch"
  ) {
    throw new Error(
      `Core inline tree ${tree.function.name} lost its diamond certificate`,
    );
  }
  const trueValue = diamond.trueBlock.terminator.arguments[0];
  const falseValue = diamond.falseBlock.terminator.arguments[0];
  const selection = tree.total
    ? [
      ...emitOperations(diamond.trueBlock),
      ...getValue(trueValue),
      ...emitOperations(diamond.falseBlock),
      ...getValue(falseValue),
      ...getValue(diamond.entry.terminator.condition),
      ...wasmInstruction.select,
    ]
    : [
      ...getValue(diamond.entry.terminator.condition),
      ...ifInstruction(wasmValueType(core, diamond.join.parameters[0].type)),
      ...emitOperations(diamond.trueBlock),
      ...getValue(trueValue),
      ...wasmInstruction.else,
      ...emitOperations(diamond.falseBlock),
      ...getValue(falseValue),
      ...wasmInstruction.end,
    ];
  return [
    ...binding,
    ...emitOperations(diamond.entry),
    ...selection,
    ...suffixInstructions,
  ];
}

function emitInlineDiamond(
  core: CoreModule,
  call: Extract<CoreOperation, { readonly kind: "call.direct" }>,
  inline: InlineDiamondLayout,
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
  getCallerValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const diamond = inlineableScalarDiamond(core, inline.function);
  if (diamond === undefined) {
    throw new Error(
      `Core inline target ${inline.function.name} lost its diamond certificate`,
    );
  }
  const inlineValueLayout: FunctionValueLayout = {
    localByValue: inline.localByValue,
    typeByValue: inline.typeByValue,
    operationByResult: inline.operationByResult,
    locals: [],
    dispatchLocal: undefined,
    byteIndexLocal: undefined,
    affineMultiplierLocal: undefined,
    affineOffsetLocal: undefined,
    inlineDiamondByCallResult: new Map(),
    inlineLoopByCallResult: new Map(),
    inlineScalarTreeByCallResult: new Map(),
  };
  const getInlineValue = (value: CoreValueId): readonly WasmInstruction[] =>
    emitStackValue(
      core,
      inline.function,
      value,
      inlineValueLayout,
      importedFunctions,
      functionIndices,
      closureTargets,
      closureTypeIndices,
      textHandles,
    );
  const emitBlockOperations = (
    block: CoreFunction["blocks"][number],
  ): readonly WasmInstruction[] =>
    block.operations.flatMap((operation) => {
      if (!inline.localByValue.has(operation.result)) return [];
      return emitOperation(
        core,
        inline.function,
        operation,
        inlineValueLayout,
        importedFunctions,
        functionIndices,
        closureTargets,
        closureTypeIndices,
        textHandles,
        getInlineValue,
      );
    });
  if (diamond.entry.terminator.kind !== "conditional_branch") {
    throw new Error(
      `Core inline target ${inline.function.name} has no diamond condition`,
    );
  }
  const trueValue = diamond.trueBlock.terminator.kind === "branch"
    ? diamond.trueBlock.terminator.arguments[0]
    : undefined;
  const falseValue = diamond.falseBlock.terminator.kind === "branch"
    ? diamond.falseBlock.terminator.arguments[0]
    : undefined;
  if (trueValue === undefined || falseValue === undefined) {
    throw new Error(
      `Core inline target ${inline.function.name} has no diamond result`,
    );
  }
  const usesSelect = selectableScalarDiamond(core, inline.function) !==
    undefined;
  const selection = usesSelect
    ? [
      ...emitBlockOperations(diamond.trueBlock),
      ...getInlineValue(trueValue),
      ...emitBlockOperations(diamond.falseBlock),
      ...getInlineValue(falseValue),
      ...getInlineValue(diamond.entry.terminator.condition),
      ...wasmInstruction.select,
    ]
    : [
      ...getInlineValue(diamond.entry.terminator.condition),
      ...ifInstruction(
        wasmValueType(core, diamond.join.parameters[0]!.type),
      ),
      ...emitBlockOperations(diamond.trueBlock),
      ...getInlineValue(trueValue),
      ...wasmInstruction.else,
      ...emitBlockOperations(diamond.falseBlock),
      ...getInlineValue(falseValue),
      ...wasmInstruction.end,
    ];
  return [
    ...call.operands.flatMap(getCallerValue),
    ...[...diamond.entry.parameters].reverse().flatMap((parameter) =>
      wasmInstruction.localSet(
        requiredLocal(inlineValueLayout, inline.function, parameter.value),
      )
    ),
    ...emitBlockOperations(diamond.entry),
    ...selection,
  ];
}

function emitInlineDiamondBodyLoop(
  core: CoreModule,
  call: Extract<CoreOperation, { readonly kind: "call.direct" }>,
  inline: InlineLoopLayout & { readonly structure: "diamondBody" },
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
  getCallerValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const inlineValueLayout: FunctionValueLayout = {
    localByValue: inline.localByValue,
    typeByValue: inline.typeByValue,
    operationByResult: inline.operationByResult,
    locals: [],
    dispatchLocal: undefined,
    byteIndexLocal: undefined,
    affineMultiplierLocal: undefined,
    affineOffsetLocal: undefined,
    inlineDiamondByCallResult: new Map(),
    inlineLoopByCallResult: new Map(),
    inlineScalarTreeByCallResult: inline.scalarTreesByCallResult,
  };
  const getInlineValue = (value: CoreValueId): readonly WasmInstruction[] =>
    emitStackValue(
      core,
      inline.function,
      value,
      inlineValueLayout,
      importedFunctions,
      functionIndices,
      closureTargets,
      closureTypeIndices,
      textHandles,
    );
  const emitBlockOperations = (
    block: CoreFunction["blocks"][number],
  ): readonly WasmInstruction[] =>
    block.operations.flatMap((operation) => {
      if (!inline.localByValue.has(operation.result)) return [];
      return emitOperation(
        core,
        inline.function,
        operation,
        inlineValueLayout,
        importedFunctions,
        functionIndices,
        closureTargets,
        closureTypeIndices,
        textHandles,
        getInlineValue,
      );
    });
  const returned = inline.loop.exit.terminator.kind === "return"
    ? inline.loop.exit.terminator.values[0]
    : undefined;
  if (returned === undefined) {
    throw new Error(
      `Core inline target ${inline.function.name} lost its return value`,
    );
  }
  const entry = inline.function.blocks[inline.function.entryBlock];
  if (entry.parameters.length !== call.operands.length) {
    throw new Error(
      `Core inline target ${inline.function.name} expects ${entry.parameters.length} operands; received ${call.operands.length}`,
    );
  }
  const emitOperationsById = (block: number): readonly WasmInstruction[] =>
    emitBlockOperations(inline.function.blocks[block]);
  const body = emitDiamondBodyNaturalLoopRegion(
    inline.function,
    inlineValueLayout,
    inline.loop,
    diamondBodySelection(core, inline.function, inline.loop),
    emitOperationsById,
    getInlineValue,
  );
  return [
    ...call.operands.flatMap(getCallerValue),
    ...[...entry.parameters].reverse().flatMap((parameter) =>
      wasmInstruction.localSet(
        requiredLocal(inlineValueLayout, inline.function, parameter.value),
      )
    ),
    ...body,
    ...emitBlockOperations(inline.loop.exit),
    ...getInlineValue(returned),
  ];
}

function emitInlineSimpleBodyLoop(
  core: CoreModule,
  call: Extract<CoreOperation, { readonly kind: "call.direct" }>,
  inline: InlineLoopLayout & { readonly structure: "simple" },
  importedFunctions: ReadonlyMap<string, number>,
  functionIndices: readonly number[],
  closureTargets: readonly ClosureTarget[],
  closureTypeIndices: ReadonlyMap<CoreSignatureId, number>,
  textHandles: ReadonlyMap<string, number>,
  getCallerValue: (value: CoreValueId) => readonly WasmInstruction[],
): readonly WasmInstruction[] {
  const inlineValueLayout: FunctionValueLayout = {
    localByValue: inline.localByValue,
    typeByValue: inline.typeByValue,
    operationByResult: inline.operationByResult,
    locals: [],
    dispatchLocal: undefined,
    byteIndexLocal: undefined,
    affineMultiplierLocal: undefined,
    affineOffsetLocal: undefined,
    inlineDiamondByCallResult: new Map(),
    inlineLoopByCallResult: new Map(),
    inlineScalarTreeByCallResult: inline.scalarTreesByCallResult,
  };
  const getInlineValue = (value: CoreValueId): readonly WasmInstruction[] =>
    emitStackValue(
      core,
      inline.function,
      value,
      inlineValueLayout,
      importedFunctions,
      functionIndices,
      closureTargets,
      closureTypeIndices,
      textHandles,
    );
  const emitBlockOperations = (
    block: CoreFunction["blocks"][number],
  ): readonly WasmInstruction[] =>
    block.operations.flatMap((operation) => {
      if (!inline.localByValue.has(operation.result)) return [];
      return emitOperation(
        core,
        inline.function,
        operation,
        inlineValueLayout,
        importedFunctions,
        functionIndices,
        closureTargets,
        closureTypeIndices,
        textHandles,
        getInlineValue,
      );
    });
  const returned = inline.loop.exit.terminator.kind === "return"
    ? inline.loop.exit.terminator.values[0]
    : undefined;
  if (returned === undefined) {
    throw new Error(
      `Core inline target ${inline.function.name} lost its return value`,
    );
  }
  const entry = inline.function.blocks[inline.function.entryBlock];
  if (entry.parameters.length !== call.operands.length) {
    throw new Error(
      `Core inline target ${inline.function.name} expects ${entry.parameters.length} operands; received ${call.operands.length}`,
    );
  }
  return [
    ...call.operands.flatMap(getCallerValue),
    ...[...entry.parameters].reverse().flatMap((parameter) =>
      wasmInstruction.localSet(
        requiredLocal(inlineValueLayout, inline.function, parameter.value),
      )
    ),
    ...emitSimpleNaturalLoopRegion(
      inline.function,
      inlineValueLayout,
      inline.loop,
      (block) => emitBlockOperations(inline.function.blocks[block]),
      getInlineValue,
    ),
    ...emitBlockOperations(inline.loop.exit),
    ...getInlineValue(returned),
  ];
}

function emitBytesGenerate(
  core: CoreModule,
  function_: CoreFunction,
  operation: Extract<
    CoreOperation,
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
      moduleName: coreRuntimeImportModule,
      fieldName: primitiveRuntimeImportName(PrimitiveId.bytesFill),
      parameters: [wasmType.i32, wasmType.i32],
      result: wasmType.i32,
    },
    operation,
  );
  const set = requireImportedFunction(
    importedFunctions,
    {
      moduleName: coreRuntimeImportModule,
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
  function_: CoreFunction,
  layout: FunctionValueLayout,
  importedFunctions: ReadonlyMap<string, number>,
  operation: CoreOperation,
): readonly WasmInstruction[] {
  const project = requireImportedFunction(
    importedFunctions,
    {
      moduleName: coreRuntimeImportModule,
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
  core: CoreModule,
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
      moduleName: coreRuntimeImportModule,
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
  terminator: CoreTerminator,
  function_: CoreFunction,
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
    return [
      ...emitEdgeAssignment(
        arguments_,
        function_.blocks[target],
        function_,
        layout,
      ),
      ...wasmInstruction.i32Constant(target),
      ...wasmInstruction.localSet(layout.dispatchLocal!),
      ...wasmInstruction.branch(depth),
    ];
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

function emitEdgeAssignment(
  arguments_: readonly CoreValueId[],
  target: CoreFunction["blocks"][number],
  function_: CoreFunction,
  layout: FunctionValueLayout,
  getValue: (value: CoreValueId) => readonly WasmInstruction[] = (value) =>
    wasmInstruction.localGet(requiredLocal(layout, function_, value)),
): readonly WasmInstruction[] {
  if (arguments_.length !== target.parameters.length) {
    throw new Error(
      `Core edge to block ${target.id} supplies ${arguments_.length} values for ${target.parameters.length} parameters`,
    );
  }
  const instructions = arguments_.flatMap(getValue);
  for (let index = target.parameters.length - 1; index >= 0; index -= 1) {
    instructions.push(
      ...wasmInstruction.localSet(
        requiredLocal(layout, function_, target.parameters[index].value),
      ),
    );
  }
  return instructions;
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
        ...wasmInstruction.branchHint("likely"),
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
  core: CoreModule,
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
  operation: CoreOperation,
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
  operation: CoreOperation,
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
    [PrimitiveId.f32x4Equal, wasmInstruction.f32x4Equal],
    [PrimitiveId.f32x4NotEqual, wasmInstruction.f32x4NotEqual],
    [PrimitiveId.f32x4LessThan, wasmInstruction.f32x4LessThan],
    [
      PrimitiveId.f32x4LessThanOrEqual,
      wasmInstruction.f32x4LessThanOrEqual,
    ],
    [PrimitiveId.f32x4GreaterThan, wasmInstruction.f32x4GreaterThan],
    [
      PrimitiveId.f32x4GreaterThanOrEqual,
      wasmInstruction.f32x4GreaterThanOrEqual,
    ],
    [PrimitiveId.f32x4Select, wasmInstruction.v128BitSelect],
  ]).get(primitiveId);
  return instruction;
}

function emitNegation(
  core: CoreModule,
  function_: CoreFunction,
  operation: CoreOperation,
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
  return primitiveId <= PrimitiveId.f32x4Divide ||
    (primitiveId >= PrimitiveId.f32x4ExtractLane0 &&
      primitiveId <= PrimitiveId.f32x4Select);
}

function aggregateImportName(
  operation: CoreOperation,
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
  if (operation.kind === "store.empty") {
    return storeRuntimeImport.empty;
  }
  if (operation.kind === "store.new") return storeRuntimeImport.new;
  if (operation.kind === "store.length") {
    return storeRuntimeImport.length;
  }
  if (operation.kind === "store.read") return storeRuntimeImport.read;
  if (operation.kind === "store.write") {
    return operation.update === "owned-reuse"
      ? storeRuntimeImport.writeOwned
      : storeRuntimeImport.writePersistent;
  }
  if (operation.kind === "store.grow") {
    return operation.update === "owned-reuse"
      ? storeRuntimeImport.growOwned
      : storeRuntimeImport.growPersistent;
  }
  if (operation.kind === "host.call") return operation.operationName;
  throw new Error(`Core operation ${operation.kind} has no aggregate import`);
}

function valueTypes(
  function_: CoreFunction,
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

function analyzeFunctionValueUses(function_: CoreFunction): {
  readonly useCounts: ReadonlyMap<CoreValueId, number>;
  readonly useBlocks: ReadonlyMap<CoreValueId, ReadonlySet<CoreBlockId>>;
  readonly returnedValues: ReadonlySet<CoreValueId>;
} {
  const useCounts = new Map<CoreValueId, number>();
  const useBlocks = new Map<CoreValueId, Set<CoreBlockId>>();
  const returnedValues = new Set<CoreValueId>();
  const countUse = (value: CoreValueId, block: CoreBlockId): void => {
    useCounts.set(value, (useCounts.get(value) ?? 0) + 1);
    const blocks = useBlocks.get(value) ?? new Set<CoreBlockId>();
    blocks.add(block);
    useBlocks.set(value, blocks);
  };
  for (const block of function_.blocks) {
    for (const operation of block.operations) {
      operation.operands.forEach((value) => countUse(value, block.id));
    }
    coreTerminatorValues(block.terminator).forEach((value) =>
      countUse(value, block.id)
    );
    if (block.terminator.kind === "return") {
      block.terminator.values.forEach((value) => returnedValues.add(value));
    }
  }
  return { useCounts, useBlocks, returnedValues };
}

function operationNeedsLocal(
  operation: CoreOperation,
  useCount: number,
  returnedDirectly: boolean,
): boolean {
  if (useCount > 1) return true;
  if (operation.kind === "constant") return false;
  if (returnedDirectly && isStackifiableOperation(operation)) return false;
  return true;
}

function canSinkTotalScalarOperation(
  core: CoreModule,
  function_: CoreFunction,
  block: CoreFunction["blocks"][number],
  operation: CoreOperation,
  typeByValue: ReadonlyMap<CoreValueId, CoreTypeId>,
  useCounts: ReadonlyMap<CoreValueId, number>,
  useBlocks: ReadonlyMap<CoreValueId, ReadonlySet<CoreBlockId>>,
): boolean {
  if (useCounts.get(operation.result) !== 1) return false;
  const blocks = useBlocks.get(operation.result);
  if (blocks?.size !== 1 || !blocks.has(block.id)) return false;
  return isTotalPureScalarOperation(
    core,
    function_,
    operation,
    typeByValue,
  );
}

function isTotalPureScalarOperation(
  core: CoreModule,
  function_: CoreFunction,
  operation: CoreOperation,
  typeByValue: ReadonlyMap<CoreValueId, CoreTypeId>,
): boolean {
  if (operation.kind === "constant") {
    return core.types[operation.type]?.kind === "scalar";
  }
  if (
    operation.kind !== "scalar.binary" || operation.operator === "/" ||
    operation.operator === "%"
  ) {
    return false;
  }
  const operand = operation.operands[0];
  if (operand === undefined) return false;
  const operandType = typeByValue.get(operand);
  if (operandType === undefined) {
    throw new Error(
      `Core function ${function_.name} has no type for value ${operand}`,
    );
  }
  return core.types[operandType]?.kind === "scalar";
}

function isStackifiableOperation(
  operation: CoreOperation,
): boolean {
  if (
    operation.kind === "constant" ||
    operation.kind === "scalar.binary" ||
    operation.kind === "product.select" ||
    operation.kind === "seal.wrap" ||
    operation.kind === "seal.unwrap" ||
    operation.kind === "resource.move" ||
    operation.kind === "resource.borrow" ||
    operation.kind === "resource.freeze" ||
    operation.kind === "region.allocate"
  ) {
    return true;
  }
  return operation.kind === "primitive" &&
    isDirectPrimitive(operation.primitiveId) &&
    operation.primitiveId !== PrimitiveId.f32x4Make;
}

function coreTerminatorValues(
  terminator: CoreTerminator,
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
  function_: CoreFunction,
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
  function_: CoreFunction,
  value: CoreValueId,
): number {
  const local = layout.localByValue.get(value);
  if (local !== undefined) return local;
  throw new Error(
    `Core function ${function_.name} has no local for value ${value}`,
  );
}

function wasmValueType(
  core: CoreModule,
  typeId: CoreTypeId,
): number {
  const type = core.types[typeId];
  if (type.kind === "vector" || type.kind === "mask") return wasmType.v128;
  if (type.kind !== "scalar") return wasmType.i32;
  if (type.scalar === "i64") return wasmType.i64;
  if (type.scalar === "f32") return wasmType.f32;
  if (type.scalar === "f64") return wasmType.f64;
  return wasmType.i32;
}

export function validateCoreWasmTarget(
  core: CoreModule,
  target: WasmTarget,
): void {
  if (target === "wasm-simd128") return;
  const vectorType = core.types.findIndex((type) =>
    type.kind === "vector" || type.kind === "mask"
  );
  if (vectorType !== -1) {
    throw new TypeError(
      `${core.file}: target ${target} cannot represent Core ${
        core.types[vectorType].kind
      } type ${vectorType}; select wasm-simd128`,
    );
  }
}

function validateJavaScriptBoundary(core: CoreModule): void {
  const entry = core.functions[core.entryFunction];
  const resultTypeId = core.signatures[entry.signature].result;
  const resultType = core.types[resultTypeId];
  if (resultType.kind === "vector" || resultType.kind === "mask") {
    throw new TypeError(
      `${entry.span.file}:${entry.span.start}: managed JavaScript ABI cannot return Core ${resultType.kind} type ${resultTypeId} from ${entry.name}`,
    );
  }
  for (const function_ of core.functions) {
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (operation.kind !== "host.call") continue;
        const boundaryTypes = [
          operation.type,
          ...operation.operands.map((operand) =>
            coreValueTypeAtBoundary(function_, operand)
          ),
        ];
        const vectorType = boundaryTypes.find((typeId) => {
          const type = core.types[typeId];
          return type.kind === "vector" || type.kind === "mask";
        });
        if (vectorType === undefined) continue;
        throw new TypeError(
          `${operation.span.file}:${operation.span.start}: managed JavaScript ABI cannot carry Core vector type ${vectorType} through ${operation.effectName}.${operation.operationName}`,
        );
      }
    }
  }
}

function coreValueTypeAtBoundary(
  function_: CoreFunction,
  value: CoreValueId,
): CoreTypeId {
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
    `Core function ${function_.name} has no type for boundary value ${value}`,
  );
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
  operation: CoreOperation,
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
  core: CoreModule,
  function_: CoreFunction,
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
  core: CoreModule,
  function_: CoreFunction,
  block: CoreFunction["blocks"][number],
  layout: FunctionValueLayout,
): readonly FcgOperation[] {
  const emitOperation = (
    operation: CoreOperation,
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

function publicFunctionName(function_: CoreFunction): string {
  return function_.sourceIdentity === undefined
    ? function_.name
    : `${function_.name}__core${function_.sourceIdentity}`;
}

function publicOpcode(
  core: CoreModule,
  function_: CoreFunction,
  operation: CoreOperation,
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
  terminator: CoreTerminator,
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

import {
  blotAbiCustomSectionName,
  type BlotAbiManifest,
  buildBlotAbiManifest,
  requireDirectBlotAbiBoundary,
  serializeBlotAbiManifest,
} from "./blot_runtime_abi.ts";
import { compileBlotConstantAbi } from "./blot_constant_abi.ts";
import {
  compileBlotCanonicalTextAbi,
  supportsBlotCanonicalTextAbi,
} from "./blot_canonical_text_abi.ts";
import {
  type CoreBlockId,
  type CoreFunctionId,
  type CoreSignatureId,
  type CoreTypeId,
  type CoreValueId,
  type DucklangCoreFunction,
  type DucklangCoreModule,
  type DucklangCoreOperation,
  type DucklangCoreType,
} from "./ducklang_core.ts";
import {
  type DucklangCoreWasmArtifact,
  type DucklangWasmTarget,
  lowerDucklangCoreToFcgAndWasm,
} from "./ducklang_core_wasm.ts";
import { PrimitiveId } from "./ducklang_primitives.ts";
import type { DucklangBinaryOperator } from "./ducklang_types.ts";
import type { CompilerGpuLimits } from "./gpu_device.ts";
import {
  emitWasmPlansOnGpu,
  type GpuWasmBatchEmissionTimings,
  type GpuWasmEmissionResult,
  type GpuWasmPhysicalPlan,
} from "./gpu_wasm.ts";
import { emitWasmPlanOnRustWasm } from "./rust_wasm_emitter.ts";
import {
  type BlotRuntimeFunction,
  type BlotRuntimeModule,
  type BlotRuntimeOperation,
  type BlotRuntimeType,
  type ValidatedBlotRuntimeModule,
} from "./blot_runtime_hir.ts";

export type BlotRuntimeTargetArtifact = DucklangCoreWasmArtifact & {
  readonly core: DucklangCoreModule;
  readonly manifest: BlotAbiManifest;
  readonly manifestBytes: Uint8Array;
};

export type GpuBlotRuntimeTargetArtifact = BlotRuntimeTargetArtifact & {
  readonly wasm: Uint8Array;
  readonly gpuEmission: Extract<
    GpuWasmEmissionResult,
    { readonly status: "completed" }
  >;
};

export type GpuBlotRuntimeBatchArtifact = BlotRuntimeTargetArtifact & {
  readonly wasm: Uint8Array;
};

export type RustWasmBlotRuntimeBatchArtifact = BlotRuntimeTargetArtifact & {
  readonly wasm: Uint8Array;
};

export type RustWasmBlotRuntimeBatch = {
  readonly artifacts: readonly RustWasmBlotRuntimeBatchArtifact[];
};

export type GpuBlotRuntimeBatch = {
  readonly artifacts: readonly GpuBlotRuntimeBatchArtifact[];
  readonly gpuEmissions: readonly Extract<
    GpuWasmEmissionResult,
    { readonly status: "completed" }
  >[];
  readonly gpuBatch:
    | {
      readonly physicalPlans: readonly GpuWasmPhysicalPlan[];
      readonly adapterLimits: CompilerGpuLimits;
      readonly timings: GpuWasmBatchEmissionTimings;
    }
    | undefined;
  readonly timings: GpuBlotRuntimeBatchTimings;
};

export type GpuBlotRuntimeModuleTimings = {
  readonly planWasmMilliseconds: number;
  readonly wasmValidationMilliseconds: number;
  readonly manifestValidationMilliseconds: number;
};

export type GpuBlotRuntimeBatchTimings = {
  readonly totalMilliseconds: number;
  readonly planWasmMilliseconds: number;
  readonly emitWasmOnGpuMilliseconds: number;
  readonly wasmValidationMilliseconds: number;
  readonly manifestValidationMilliseconds: number;
  readonly unaccountedMilliseconds: number;
  readonly modules: readonly GpuBlotRuntimeModuleTimings[];
};

export function compileBlotRuntimeModule(
  module: ValidatedBlotRuntimeModule,
  options: {
    readonly emission?: "cpu" | "planOnly";
    readonly target?: DucklangWasmTarget;
  } = {},
): BlotRuntimeTargetArtifact {
  const core = lowerBlotRuntimeModuleToCore(module);
  const manifest = buildBlotAbiManifest(module);
  const manifestBytes = serializeBlotAbiManifest(manifest);
  const runtimeExports = module.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  let lowered: DucklangCoreWasmArtifact;
  let directBoundaryError: unknown;
  try {
    requireDirectBlotAbiBoundary(manifest);
  } catch (error) {
    directBoundaryError = error;
  }
  if (directBoundaryError === undefined) {
    lowered = lowerDucklangCoreToFcgAndWasm(core, {
      emission: options.emission ?? "cpu",
      target: options.target ?? "wasm-simd128",
      exports: runtimeExports.map((exported) => ({
        name: exported.wasmName,
        functionId: exported.function as CoreFunctionId,
      })),
      blotAbiManifest: manifestBytes,
    });
  } else {
    const canonical = supportsBlotCanonicalTextAbi(module, manifest)
      ? compileBlotCanonicalTextAbi(module, manifest, manifestBytes)
      : compileBlotConstantAbi(module, manifest, manifestBytes);
    const support = lowerDucklangCoreToFcgAndWasm(core, {
      emission: "planOnly",
      target: options.target ?? "wasm-simd128",
      exports: [],
    });
    lowered = {
      ...support,
      wasmPlan: canonical.wasmPlan,
      wasm: options.emission === "planOnly" ? undefined : canonical.wasm,
    };
  }
  const embeddedManifest = lowered.wasm === undefined
    ? []
    : WebAssembly.Module.customSections(
      new WebAssembly.Module(lowered.wasm as BufferSource),
      blotAbiCustomSectionName,
    );
  if (
    embeddedManifest.length === 1 &&
    !byteArraysEqual(new Uint8Array(embeddedManifest[0]), manifestBytes)
  ) {
    throw new Error(
      `${module.source}: emitted blot:abi custom section differs from its manifest bytes`,
    );
  }
  return { ...lowered, core, manifest, manifestBytes };
}

export async function compileBlotRuntimeModulesOnRustWasm(
  modules: readonly ValidatedBlotRuntimeModule[],
  options: {
    readonly target?: DucklangWasmTarget;
  } = {},
): Promise<RustWasmBlotRuntimeBatch> {
  const planned = modules.map((module) =>
    compileBlotRuntimeModule(module, {
      emission: "planOnly",
      target: options.target,
    })
  );
  const artifacts: RustWasmBlotRuntimeBatchArtifact[] = [];
  for (const [index, artifact] of planned.entries()) {
    const module = modules[index]!;
    const wasm = (await emitWasmPlanOnRustWasm(artifact.wasmPlan)).bytes;
    requireBlotWasm(module, wasm, artifact.manifestBytes, "Rust/WebAssembly");
    artifacts.push({ ...artifact, wasm });
  }
  return { artifacts };
}

export async function compileBlotRuntimeModuleOnGpu(
  module: ValidatedBlotRuntimeModule,
  options: {
    readonly scheduling?: "latency" | "throughput";
    readonly target?: DucklangWasmTarget;
  } = {},
): Promise<GpuBlotRuntimeTargetArtifact> {
  const batch = await compileBlotRuntimeModulesOnGpu([module], {
    scheduling: options.scheduling ?? "latency",
    target: options.target,
  });
  const artifact = batch.artifacts[0];
  const gpuEmission = batch.gpuEmissions[0];
  if (artifact === undefined || gpuEmission === undefined) {
    throw new Error(
      `${module.source}: singleton GPU batch omitted its artifact`,
    );
  }
  return { ...artifact, gpuEmission };
}

export async function compileBlotRuntimeModulesOnGpu(
  modules: readonly ValidatedBlotRuntimeModule[],
  options: {
    readonly scheduling?: "latency" | "throughput";
    readonly target?: DucklangWasmTarget;
    readonly maximumPhysicalPayloadCount?: number;
  } = {},
): Promise<GpuBlotRuntimeBatch> {
  if (modules.length === 0) {
    return {
      artifacts: [],
      gpuEmissions: [],
      gpuBatch: undefined,
      timings: {
        totalMilliseconds: 0,
        planWasmMilliseconds: 0,
        emitWasmOnGpuMilliseconds: 0,
        wasmValidationMilliseconds: 0,
        manifestValidationMilliseconds: 0,
        unaccountedMilliseconds: 0,
        modules: [],
      },
    };
  }
  const totalStart = performance.now();
  const modulePlanningMilliseconds: number[] = [];
  const planned = modules.map((module) => {
    const started = performance.now();
    const artifact = compileBlotRuntimeModule(module, {
      emission: "planOnly",
      target: options.target,
    });
    modulePlanningMilliseconds.push(performance.now() - started);
    return artifact;
  });
  const planWasmMilliseconds = modulePlanningMilliseconds.reduce(
    (sum, milliseconds) => sum + milliseconds,
    0,
  );
  const scheduling = options.scheduling ??
    (modules.length === 1 ? "latency" : "throughput");
  const emissionStart = performance.now();
  const emitted = await emitWasmPlansOnGpu(
    planned.map((artifact) => artifact.wasmPlan),
    {
      scheduling,
      maximumPhysicalPayloadCount: options.maximumPhysicalPayloadCount,
    },
  );
  const emitWasmOnGpuMilliseconds = performance.now() - emissionStart;
  if (emitted.status === "unavailable") {
    throw new Error(
      `${
        modules.map((module) => module.source).join(", ")
      }: gpupaper GPU Wasm batch emission is unavailable: ${emitted.reason}`,
    );
  }
  const moduleValidationTimings: {
    readonly wasmValidationMilliseconds: number;
    readonly manifestValidationMilliseconds: number;
  }[] = [];
  const artifacts = planned.map((artifact, index) => {
    const wasm = emitted.bytes[index];
    if (wasm === undefined) {
      throw new Error(
        `gpupaper GPU batch omitted artifact ${index} for ${
          modules[index]!.source
        }`,
      );
    }
    moduleValidationTimings.push(
      requireBlotWasm(modules[index]!, wasm, artifact.manifestBytes, "GPU"),
    );
    return { ...artifact, wasm };
  });
  const wasmValidationMilliseconds = moduleValidationTimings.reduce(
    (sum, timing) => sum + timing.wasmValidationMilliseconds,
    0,
  );
  const manifestValidationMilliseconds = moduleValidationTimings.reduce(
    (sum, timing) => sum + timing.manifestValidationMilliseconds,
    0,
  );
  const totalMilliseconds = performance.now() - totalStart;
  const accountedMilliseconds = planWasmMilliseconds +
    emitWasmOnGpuMilliseconds + wasmValidationMilliseconds +
    manifestValidationMilliseconds;
  return {
    artifacts,
    gpuEmissions: emitted.physicalEmissions,
    gpuBatch: {
      physicalPlans: emitted.physicalPlans,
      adapterLimits: emitted.adapterLimits,
      timings: emitted.timings,
    },
    timings: {
      totalMilliseconds,
      planWasmMilliseconds,
      emitWasmOnGpuMilliseconds,
      wasmValidationMilliseconds,
      manifestValidationMilliseconds,
      unaccountedMilliseconds: Math.max(
        0,
        totalMilliseconds - accountedMilliseconds,
      ),
      modules: modules.map((_, index) => ({
        planWasmMilliseconds: modulePlanningMilliseconds[index]!,
        wasmValidationMilliseconds:
          moduleValidationTimings[index]!.wasmValidationMilliseconds,
        manifestValidationMilliseconds:
          moduleValidationTimings[index]!.manifestValidationMilliseconds,
      })),
    },
  };
}

function requireBlotWasm(
  module: ValidatedBlotRuntimeModule,
  wasm: Uint8Array,
  manifestBytes: Uint8Array,
  emitterName: "GPU" | "Rust/WebAssembly",
): {
  readonly wasmValidationMilliseconds: number;
  readonly manifestValidationMilliseconds: number;
} {
  const wasmValidationStart = performance.now();
  if (!WebAssembly.validate(Uint8Array.from(wasm))) {
    throw new Error(
      `${module.source}: ${emitterName} emitted invalid WebAssembly`,
    );
  }
  const wasmValidationMilliseconds = performance.now() -
    wasmValidationStart;
  const manifestValidationStart = performance.now();
  const embeddedManifest = WebAssembly.Module.customSections(
    new WebAssembly.Module(wasm as BufferSource),
    blotAbiCustomSectionName,
  );
  if (
    embeddedManifest.length !== 1 ||
    !byteArraysEqual(new Uint8Array(embeddedManifest[0]!), manifestBytes)
  ) {
    throw new Error(
      `${module.source}: ${emitterName} emitted a blot:abi custom section that differs from its manifest bytes`,
    );
  }
  return {
    wasmValidationMilliseconds,
    manifestValidationMilliseconds: performance.now() -
      manifestValidationStart,
  };
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

export function lowerBlotRuntimeModuleToCore(
  module: ValidatedBlotRuntimeModule,
): DucklangCoreModule {
  const runtimeExports = module.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  if (runtimeExports.length === 0) {
    throw new TypeError(
      `${module.source}: Blot Runtime HIR has no runtime export to select as the Core entry`,
    );
  }
  const types = lowerTypes(module);
  const signatures = module.signatures.map((signature) => ({
    parameters: signature.parameters.map((type) => type as CoreTypeId),
    result: signature.result as CoreTypeId,
  }));
  const checkedIntegerOperations = requiredCheckedIntegerOperations(module);
  const checkedIntegerHelpers = new Map<
    "add" | "subtract" | "multiply",
    CoreFunctionId
  >();
  let checkedIntegerSignature: CoreSignatureId | undefined;
  if (checkedIntegerOperations.length > 0) {
    const signedIntegerType = requiredRuntimeType(
      module,
      "signed-integer-64",
    );
    checkedIntegerSignature = signatures.length as CoreSignatureId;
    signatures.push({
      parameters: [signedIntegerType, signedIntegerType],
      result: signedIntegerType,
    });
    checkedIntegerOperations.forEach((operator, index) =>
      checkedIntegerHelpers.set(
        operator,
        (module.functions.length + index) as CoreFunctionId,
      )
    );
  }
  const functions: DucklangCoreFunction[] = module.functions.map((
    function_,
  ) => {
    const valueTypes = runtimeValueTypes(function_);
    return {
      id: function_.id as CoreFunctionId,
      name: function_.name,
      sourceSymbolId: undefined,
      signature: function_.signature as CoreSignatureId,
      entryBlock: function_.entryBlock as CoreBlockId,
      blocks: function_.blocks.map((block) => ({
        id: block.id as CoreBlockId,
        parameters: block.parameters.map((parameter) => ({
          value: parameter.value as CoreValueId,
          type: parameter.type as CoreTypeId,
          span: parameter.span,
        })),
        operations: block.operations.map((operation) =>
          lowerOperation(
            module,
            operation,
            valueTypes,
            checkedIntegerHelpers,
          )
        ),
        terminator: block.terminator.kind === "branch"
          ? {
            kind: "branch" as const,
            target: block.terminator.target as CoreBlockId,
            arguments: block.terminator.arguments.map((value) =>
              value as CoreValueId
            ),
            span: block.terminator.span,
          }
          : block.terminator.kind === "conditional"
          ? {
            kind: "conditional_branch" as const,
            condition: block.terminator.condition as CoreValueId,
            trueTarget: block.terminator.consequent as CoreBlockId,
            trueArguments: block.terminator.consequentArguments.map((value) =>
              value as CoreValueId
            ),
            falseTarget: block.terminator.alternate as CoreBlockId,
            falseArguments: block.terminator.alternateArguments.map((value) =>
              value as CoreValueId
            ),
            span: block.terminator.span,
          }
          : block.terminator.kind === "return"
          ? {
            kind: "return" as const,
            values: [block.terminator.value as CoreValueId],
            span: block.terminator.span,
          }
          : {
            kind: "trap" as const,
            span: block.terminator.span,
          },
      })),
      span: function_.span,
    };
  });
  if (checkedIntegerSignature !== undefined) {
    const signedIntegerType = requiredRuntimeType(
      module,
      "signed-integer-64",
    );
    const booleanType = requiredRuntimeType(module, "boolean");
    for (const operator of checkedIntegerOperations) {
      functions.push(
        checkedIntegerHelper(
          module,
          operator,
          checkedIntegerHelpers.get(operator)!,
          checkedIntegerSignature,
          signedIntegerType,
          booleanType,
        ),
      );
    }
  }
  return {
    schemaVersion: 1,
    file: module.source,
    types,
    signatures,
    functions,
    entryFunction: runtimeExports[0].function as CoreFunctionId,
  };
}

function lowerTypes(module: BlotRuntimeModule): readonly DucklangCoreType[] {
  const types: DucklangCoreType[] = [];
  const resolvingSeals = new Set<number>();
  const lowerType = (
    type: BlotRuntimeType,
    typeId: number,
  ): DucklangCoreType => {
    if (type.kind === "unit") return { kind: "scalar", scalar: "unit" };
    if (type.kind === "integer-32" || type.kind === "boolean") {
      return { kind: "scalar", scalar: "i32" };
    }
    if (type.kind === "signed-integer-64") {
      return { kind: "scalar", scalar: "i64" };
    }
    if (type.kind === "float-32") return { kind: "scalar", scalar: "f32" };
    if (type.kind === "float-64") return { kind: "scalar", scalar: "f64" };
    if (type.kind === "text") return { kind: "buffer", buffer: "text" };
    if (type.kind === "vector" || type.kind === "mask") {
      return { kind: type.kind, lanes: 4, element: "f32" };
    }
    if (type.kind === "product") {
      return {
        kind: "product",
        fields: type.fields.map((field) => field.type as CoreTypeId),
      };
    }
    if (type.kind === "sum") {
      return {
        kind: "sum",
        cases: type.cases.map((case_) => case_.payloadType as CoreTypeId),
      };
    }
    if (type.kind === "function") {
      return {
        kind: "function",
        signature: type.signature as CoreSignatureId,
      };
    }
    if (type.kind === "store") {
      return { kind: "store", element: type.elementType as CoreTypeId };
    }
    if (type.kind === "sealed") {
      if (resolvingSeals.has(typeId)) {
        throw new TypeError(
          `${module.source}: sealed type ${type.name} has a cyclic representation`,
        );
      }
      resolvingSeals.add(typeId);
      const representation = module.types[type.representationType];
      const lowered = lowerType(representation, type.representationType);
      resolvingSeals.delete(typeId);
      return lowered;
    }
    throw new TypeError(
      `${module.source}: Blot Runtime HIR type ${typeId} has unsupported kind ${
        (type as BlotRuntimeType).kind
      }`,
    );
  };
  module.types.forEach((type, typeId) => types.push(lowerType(type, typeId)));
  return types;
}

function lowerOperation(
  module: BlotRuntimeModule,
  operation: BlotRuntimeOperation,
  valueTypes: ReadonlyMap<number, number>,
  checkedIntegerHelpers: ReadonlyMap<
    "add" | "subtract" | "multiply",
    CoreFunctionId
  >,
): DucklangCoreOperation {
  const base = {
    result: operation.result as CoreValueId,
    type: operation.type as CoreTypeId,
    operands: operation.operands.map((operand) => operand as CoreValueId),
    span: operation.span,
  };
  if (operation.kind === "constant") {
    return {
      ...base,
      kind: "constant",
      value: operation.value === null ? undefined : operation.value,
    };
  }
  if (operation.kind === "scalar") {
    const checkedHelper = checkedIntegerHelperForOperation(
      module,
      operation,
      valueTypes,
      checkedIntegerHelpers,
    );
    if (checkedHelper !== undefined) {
      return {
        ...base,
        kind: "call.direct",
        functionId: checkedHelper,
      };
    }
    return {
      ...base,
      kind: "scalar.binary",
      operator: binaryOperator(operation.operator),
    };
  }
  if (operation.kind === "convert") {
    return {
      ...base,
      kind: "primitive",
      primitiveId: conversionPrimitive(module, operation),
    };
  }
  if (operation.kind === "text.append") {
    return {
      ...base,
      kind: "primitive",
      primitiveId: PrimitiveId.bufferAppend,
    };
  }
  if (
    operation.kind === "text.length" || operation.kind === "text.from-i64" ||
    operation.kind === "text.compare" || operation.kind === "text.contains"
  ) {
    return {
      ...base,
      kind: "primitive",
      primitiveId: {
        "text.length": PrimitiveId.textCodePointLength,
        "text.from-i64": PrimitiveId.textFromI64,
        "text.compare": PrimitiveId.textCompare,
        "text.contains": PrimitiveId.textContains,
      }[operation.kind],
    };
  }
  if (operation.kind === "vector") {
    return {
      ...base,
      kind: "primitive",
      primitiveId: vectorPrimitive(module, operation),
    };
  }
  if (operation.kind === "product.make") {
    return { ...base, kind: operation.kind };
  }
  if (operation.kind === "product.project") {
    return { ...base, kind: operation.kind, index: operation.field };
  }
  if (operation.kind === "sum.make") {
    return { ...base, kind: operation.kind, caseIndex: operation.case };
  }
  if (operation.kind === "sum.tag") return { ...base, kind: operation.kind };
  if (operation.kind === "sum.payload") {
    return { ...base, kind: operation.kind, caseIndex: operation.case };
  }
  if (
    operation.kind === "store.empty" || operation.kind === "store.new" ||
    operation.kind === "store.length" || operation.kind === "store.read"
  ) {
    return { ...base, kind: operation.kind };
  }
  if (operation.kind === "store.write" || operation.kind === "store.grow") {
    return { ...base, kind: operation.kind, update: operation.update };
  }
  if (operation.kind === "call.direct") {
    return {
      ...base,
      kind: operation.kind,
      functionId: operation.function as CoreFunctionId,
    };
  }
  if (operation.kind === "closure.make") {
    return {
      ...base,
      kind: operation.kind,
      functionId: operation.function as CoreFunctionId,
    };
  }
  if (operation.kind === "call.indirect") {
    return {
      ...base,
      kind: operation.kind,
      signature: operation.signature as CoreSignatureId,
    };
  }
  if (operation.kind === "host.call") {
    return {
      ...base,
      kind: operation.kind,
      effectName: `blot:host/${operation.capability}`,
      operationName: operation.operation,
    };
  }
  if (
    operation.kind === "seal.wrap" ||
    operation.kind === "seal.unwrap" ||
    operation.kind === "resource.move" ||
    operation.kind === "resource.borrow" ||
    operation.kind === "resource.freeze" ||
    operation.kind === "resource.drop"
  ) {
    return { ...base, kind: operation.kind };
  }
  throw new TypeError(
    `${module.source}:${operation.span.start}: gpupaper target does not yet lower ${operation.kind}`,
  );
}

function checkedIntegerHelperForOperation(
  module: BlotRuntimeModule,
  operation: Extract<BlotRuntimeOperation, { readonly kind: "scalar" }>,
  valueTypes: ReadonlyMap<number, number>,
  helpers: ReadonlyMap<
    "add" | "subtract" | "multiply",
    CoreFunctionId
  >,
): CoreFunctionId | undefined {
  const operandType = valueTypes.get(operation.operands[0]);
  if (module.types[operandType ?? -1]?.kind !== "signed-integer-64") {
    return undefined;
  }
  if (
    operation.operator !== "add" && operation.operator !== "subtract" &&
    operation.operator !== "multiply"
  ) return undefined;
  const helper = helpers.get(operation.operator);
  if (helper !== undefined) return helper;
  throw new Error(
    `${module.source}:${operation.span.start}: checked ${operation.operator} helper was not constructed`,
  );
}

function runtimeValueTypes(
  function_: BlotRuntimeFunction,
): ReadonlyMap<number, number> {
  const types = new Map<number, number>();
  for (const block of function_.blocks) {
    block.parameters.forEach((parameter) =>
      types.set(parameter.value, parameter.type)
    );
    block.operations.forEach((operation) =>
      types.set(operation.result, operation.type)
    );
  }
  return types;
}

function requiredCheckedIntegerOperations(
  module: BlotRuntimeModule,
): readonly ("add" | "subtract" | "multiply")[] {
  const required = new Set<"add" | "subtract" | "multiply">();
  for (const function_ of module.functions) {
    const valueTypes = runtimeValueTypes(function_);
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (operation.kind !== "scalar") continue;
        if (
          operation.operator !== "add" &&
          operation.operator !== "subtract" &&
          operation.operator !== "multiply"
        ) continue;
        const operandType = valueTypes.get(operation.operands[0]);
        if (module.types[operandType ?? -1]?.kind === "signed-integer-64") {
          required.add(operation.operator);
        }
      }
    }
  }
  return (["add", "subtract", "multiply"] as const).filter((operator) =>
    required.has(operator)
  );
}

function requiredRuntimeType(
  module: BlotRuntimeModule,
  kind: "signed-integer-64" | "boolean",
): CoreTypeId {
  const type = module.types.findIndex((candidate) => candidate.kind === kind);
  if (type !== -1) return type as CoreTypeId;
  throw new TypeError(
    `${module.source}: checked I64 arithmetic requires a Runtime HIR ${kind} type`,
  );
}

function checkedIntegerHelper(
  module: BlotRuntimeModule,
  operator: "add" | "subtract" | "multiply",
  functionId: CoreFunctionId,
  signature: CoreSignatureId,
  signedIntegerType: CoreTypeId,
  booleanType: CoreTypeId,
): DucklangCoreFunction {
  return operator === "multiply"
    ? checkedMultiplyHelper(
      module,
      functionId,
      signature,
      signedIntegerType,
      booleanType,
    )
    : checkedAdditiveHelper(
      module,
      operator,
      functionId,
      signature,
      signedIntegerType,
      booleanType,
    );
}

function checkedAdditiveHelper(
  module: BlotRuntimeModule,
  operator: "add" | "subtract",
  functionId: CoreFunctionId,
  signature: CoreSignatureId,
  signedIntegerType: CoreTypeId,
  booleanType: CoreTypeId,
): DucklangCoreFunction {
  const span = { file: module.source, start: 0, end: 0 };
  const leftXorOperands = operator === "add" ? [0, 2] : [0, 1];
  const rightXorOperands = operator === "add" ? [1, 2] : [0, 2];
  return {
    id: functionId,
    name: `blot$checked$i64$${operator}`,
    sourceSymbolId: undefined,
    signature,
    entryBlock: 0 as CoreBlockId,
    blocks: [
      {
        id: 0 as CoreBlockId,
        parameters: [
          { value: 0 as CoreValueId, type: signedIntegerType, span },
          { value: 1 as CoreValueId, type: signedIntegerType, span },
        ],
        operations: [
          scalarOperation(
            2,
            signedIntegerType,
            operator === "add" ? "+" : "-",
            [0, 1],
            span,
          ),
          primitiveOperation(
            3,
            signedIntegerType,
            PrimitiveId.bitXor,
            leftXorOperands,
            span,
          ),
          primitiveOperation(
            4,
            signedIntegerType,
            PrimitiveId.bitXor,
            rightXorOperands,
            span,
          ),
          primitiveOperation(
            5,
            signedIntegerType,
            PrimitiveId.bitAnd,
            [3, 4],
            span,
          ),
          constantOperation(6, signedIntegerType, 0n, span),
          scalarOperation(7, booleanType, "<", [5, 6], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 7 as CoreValueId,
          trueTarget: 1 as CoreBlockId,
          trueArguments: [],
          falseTarget: 2 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
      {
        id: 1 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: { kind: "trap", span },
      },
      {
        id: 2 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: {
          kind: "return",
          values: [2 as CoreValueId],
          span,
        },
      },
    ],
    span,
  };
}

function checkedMultiplyHelper(
  module: BlotRuntimeModule,
  functionId: CoreFunctionId,
  signature: CoreSignatureId,
  signedIntegerType: CoreTypeId,
  booleanType: CoreTypeId,
): DucklangCoreFunction {
  const span = { file: module.source, start: 0, end: 0 };
  return {
    id: functionId,
    name: "blot$checked$i64$multiply",
    sourceSymbolId: undefined,
    signature,
    entryBlock: 0 as CoreBlockId,
    blocks: [
      {
        id: 0 as CoreBlockId,
        parameters: [
          { value: 0 as CoreValueId, type: signedIntegerType, span },
          { value: 1 as CoreValueId, type: signedIntegerType, span },
        ],
        operations: [
          scalarOperation(2, signedIntegerType, "*", [0, 1], span),
          constantOperation(3, signedIntegerType, 0n, span),
          scalarOperation(4, booleanType, "==", [1, 3], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 4 as CoreValueId,
          trueTarget: 1 as CoreBlockId,
          trueArguments: [],
          falseTarget: 2 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
      {
        id: 1 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: {
          kind: "return",
          values: [2 as CoreValueId],
          span,
        },
      },
      {
        id: 2 as CoreBlockId,
        parameters: [],
        operations: [
          constantOperation(
            5,
            signedIntegerType,
            -(1n << 63n),
            span,
          ),
          constantOperation(6, signedIntegerType, -1n, span),
          scalarOperation(7, booleanType, "==", [0, 5], span),
          scalarOperation(8, booleanType, "==", [1, 6], span),
          scalarOperation(9, booleanType, "&&", [7, 8], span),
          scalarOperation(10, booleanType, "==", [0, 6], span),
          scalarOperation(11, booleanType, "==", [1, 5], span),
          scalarOperation(12, booleanType, "&&", [10, 11], span),
          scalarOperation(13, booleanType, "||", [9, 12], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 13 as CoreValueId,
          trueTarget: 3 as CoreBlockId,
          trueArguments: [],
          falseTarget: 4 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
      {
        id: 3 as CoreBlockId,
        parameters: [],
        operations: [],
        terminator: { kind: "trap", span },
      },
      {
        id: 4 as CoreBlockId,
        parameters: [],
        operations: [
          scalarOperation(14, signedIntegerType, "/", [2, 1], span),
          scalarOperation(15, booleanType, "==", [14, 0], span),
        ],
        terminator: {
          kind: "conditional_branch",
          condition: 15 as CoreValueId,
          trueTarget: 1 as CoreBlockId,
          trueArguments: [],
          falseTarget: 3 as CoreBlockId,
          falseArguments: [],
          span,
        },
      },
    ],
    span,
  };
}

function scalarOperation(
  result: number,
  type: CoreTypeId,
  operator: DucklangBinaryOperator,
  operands: readonly number[],
  span: { readonly file: string; readonly start: number; readonly end: number },
): DucklangCoreOperation {
  return {
    kind: "scalar.binary",
    result: result as CoreValueId,
    type,
    operands: operands.map((operand) => operand as CoreValueId),
    operator,
    span,
  };
}

function primitiveOperation(
  result: number,
  type: CoreTypeId,
  primitiveId: typeof PrimitiveId[keyof typeof PrimitiveId],
  operands: readonly number[],
  span: { readonly file: string; readonly start: number; readonly end: number },
): DucklangCoreOperation {
  return {
    kind: "primitive",
    result: result as CoreValueId,
    type,
    operands: operands.map((operand) => operand as CoreValueId),
    primitiveId,
    span,
  };
}

function constantOperation(
  result: number,
  type: CoreTypeId,
  value: bigint,
  span: { readonly file: string; readonly start: number; readonly end: number },
): DucklangCoreOperation {
  return {
    kind: "constant",
    result: result as CoreValueId,
    type,
    operands: [],
    value,
    span,
  };
}

function binaryOperator(
  operator: Extract<
    BlotRuntimeOperation,
    { readonly kind: "scalar" }
  >["operator"],
): DucklangBinaryOperator {
  return {
    add: "+",
    subtract: "-",
    multiply: "*",
    divide: "/",
    remainder: "%",
    equal: "==",
    "not-equal": "!=",
    "less-than": "<",
    "less-than-or-equal": "<=",
    "greater-than": ">",
    "greater-than-or-equal": ">=",
  }[operator] as DucklangBinaryOperator;
}

function conversionPrimitive(
  module: BlotRuntimeModule,
  operation: Extract<BlotRuntimeOperation, { readonly kind: "convert" }>,
): typeof PrimitiveId[keyof typeof PrimitiveId] {
  const primitive = {
    "signed-integer-32-to-signed-integer-64": PrimitiveId.i64ExtendI32Signed,
    "signed-integer-32-to-float-32": PrimitiveId.f32FromI32,
    "signed-integer-32-to-float-64": PrimitiveId.f64FromI32,
    "float-32-to-signed-integer-32": PrimitiveId.i32FromF32,
    "float-64-to-signed-integer-32": PrimitiveId.i32FromF64,
    "reinterpret-float-32-as-signed-integer-32": PrimitiveId.i32ReinterpretF32,
    "reinterpret-signed-integer-32-as-float-32": PrimitiveId.f32ReinterpretI32,
  }[operation.conversion];
  if (primitive !== undefined) return primitive;
  throw new TypeError(
    `${module.source}:${operation.span.start}: gpupaper target does not yet implement Blot conversion ${operation.conversion}`,
  );
}

function vectorPrimitive(
  module: BlotRuntimeModule,
  operation: Extract<BlotRuntimeOperation, { readonly kind: "vector" }>,
): typeof PrimitiveId[keyof typeof PrimitiveId] {
  if (operation.operator === "extract" || operation.operator === "replace") {
    if (operation.lane === undefined) {
      throw new TypeError(
        `${module.source}:${operation.span.start}: vector ${operation.operator} requires a lane`,
      );
    }
    return operation.operator === "extract"
      ? [
        PrimitiveId.f32x4ExtractLane0,
        PrimitiveId.f32x4ExtractLane1,
        PrimitiveId.f32x4ExtractLane2,
        PrimitiveId.f32x4ExtractLane3,
      ][operation.lane]
      : [
        PrimitiveId.f32x4ReplaceLane0,
        PrimitiveId.f32x4ReplaceLane1,
        PrimitiveId.f32x4ReplaceLane2,
        PrimitiveId.f32x4ReplaceLane3,
      ][operation.lane];
  }
  const primitive = {
    make: PrimitiveId.f32x4Make,
    splat: PrimitiveId.f32x4Splat,
    add: PrimitiveId.f32x4Add,
    subtract: PrimitiveId.f32x4Subtract,
    multiply: PrimitiveId.f32x4Multiply,
    divide: PrimitiveId.f32x4Divide,
    equal: PrimitiveId.f32x4Equal,
    "not-equal": PrimitiveId.f32x4NotEqual,
    "less-than": PrimitiveId.f32x4LessThan,
    "less-than-or-equal": PrimitiveId.f32x4LessThanOrEqual,
    "greater-than": PrimitiveId.f32x4GreaterThan,
    "greater-than-or-equal": PrimitiveId.f32x4GreaterThanOrEqual,
    select: PrimitiveId.f32x4Select,
  }[operation.operator];
  if (primitive !== undefined) return primitive;
  throw new TypeError(
    `${module.source}:${operation.span.start}: unsupported vector operation ${operation.operator}`,
  );
}

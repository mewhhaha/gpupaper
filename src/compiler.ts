import { contentIdentity } from "./content_identity.ts";
import {
  type ComptimeBatchResult,
  type ComptimeValue,
  evaluateModuleComptime,
} from "./comptime.ts";
import {
  parseDucklangTextLiterals,
  validateDucklangManagedArtifact,
  validateSelectedWasm,
} from "./artifact_validation.ts";
import { evaluateDucklangComptime } from "./ducklang_comptime.ts";
import {
  type DucklangConstValue,
  evaluateDucklangConstModule,
} from "./ducklang_const.ts";
import {
  createDucklangManagedAbi,
  type DucklangManagedAbi,
} from "./ducklang_abi.ts";
import type { DucklangModule } from "./ducklang_ast.ts";
import {
  lowerDucklangControlFlow,
  requireConsistentDucklangLoopExits,
} from "./ducklang_control_flow.ts";
import { elaborateDucklangDerivations } from "./ducklang_derivations.ts";
import { elaborateDucklangExtensions } from "./ducklang_extensions.ts";
import { lowerDucklangEffectsStructurally } from "./ducklang_effect_cps.ts";
import { closeDucklangEffectBoundary } from "./ducklang_effect_boundary.ts";
import { validateDucklangEffectOwnership } from "./ducklang_effect_validation.ts";
import { validateDucklangOwnership } from "./ducklang_ownership.ts";
import { specializeStaticDucklangClosures } from "./ducklang_closures.ts";
import {
  type DucklangCoreModule,
  lowerDucklangToCore,
} from "./ducklang_core.ts";
import { rewriteFlatDucklangCore } from "./ducklang_core_rewrite.ts";
import {
  type FlatDucklangCore,
  flattenDucklangCore,
  inflateFlatDucklangCore,
} from "./flat_ducklang_core.ts";
import {
  createDucklangBackendFunctionCache,
  type DucklangBackendFunctionCache,
  ducklangTextLiteralsSectionName,
  lowerDucklangCoreToFcgAndWasm,
} from "./ducklang_core_wasm.ts";
import {
  applyDucklangHostInterface,
  lowerDucklangModuleExports,
  resolveDucklangLocalImports,
} from "./ducklang_modules.ts";
import {
  createDucklangFilesystemSourceProvider,
  createDucklangModuleInstanceCache,
  createDucklangModuleSyntaxCache,
  type DucklangModuleGraph,
  type DucklangModuleInstances,
  type DucklangModuleSyntaxCache,
  ducklangSourceHash,
  expandDucklangIncludes,
} from "./ducklang_module_graph.ts";
import { parseDucklangModuleWithTimings } from "./ducklang_parser.ts";
import { qualifyDucklangTypeCollisions } from "./ducklang_type_identity.ts";
import { reflectDucklangTypes } from "./ducklang_reflection.ts";
import { resolveDucklangModule } from "./ducklang_resolution.ts";
import { elaborateDucklangSourceTests } from "./ducklang_tests.ts";
import { expandStaticDucklangLoops } from "./ducklang_static_loops.ts";
import {
  createDucklangRuntimeHeap,
  createDucklangRuntimeImports,
} from "./ducklang_runtime.ts";
import { ducklangRuntimeImportModule } from "./ducklang_primitives.ts";
import {
  formatDucklangType,
  inferDucklangEffectModule,
  type TypedDucklangEffectModule,
  type TypedDucklangModule,
} from "./ducklang_types.ts";
import { type FcgModule, lowerToFcgAndWasm } from "./fcg.ts";
import type { FlatFcgPackage } from "./flat_fcg.ts";
import { type GpuSolveResult, solveTypeEqualitiesOnGpu } from "./gpu_solver.ts";
import {
  type GpuDucklangCoreResult,
  runDucklangCoreGpuPass,
} from "./gpu_ducklang_core.ts";
import { emitWasmPlanOnGpu, type GpuWasmEmissionResult } from "./gpu_wasm.ts";
import type { CompilerGpuSchedulingPolicy } from "./gpu_device.ts";
import {
  evaluateModuleInteractionComptime,
  type InteractionResult,
} from "./interaction.ts";
import { expandMacros, type MacroExpansionReport } from "./macros.ts";
import { parseModule } from "./parser.ts";
import { formatScheme, inferModule, type InferredModule } from "./types.ts";
import { emitWasmPlanOnCpu, type WasmBinaryPlan } from "./wasm.ts";

export type GpuMode = "auto" | "off" | "required";
export type GpuWasmVerification = "differential" | "none";
export type GpuSchedulingPolicy = CompilerGpuSchedulingPolicy;

export type CompilationOptions = {
  readonly gpuMode?: GpuMode;
  readonly gpuWasmVerification?: GpuWasmVerification;
  readonly gpuScheduling?: GpuSchedulingPolicy;
  readonly hostInterface?: string;
  readonly session?: DucklangCompilationSession;
};

export type CompilationBackends = {
  readonly typeCheck: "cpu" | "cpu+gpu";
  readonly comptime: "cpu" | "cpu+gpu";
  readonly coreRewrite: "cpu" | "gpu" | "notApplicable";
  readonly wasmEmission: "cpu" | "gpu";
  readonly wasmVerification: "none" | "cpuDifferential";
};

export type CompilationTimings = {
  readonly parseMilliseconds: number;
  readonly includeMilliseconds: number;
  readonly parserInitializationMilliseconds: number;
  readonly syntaxMilliseconds: number;
  readonly astLoweringMilliseconds: number;
  readonly elaborationMilliseconds: number;
  readonly resolutionMilliseconds: number;
  readonly macroMilliseconds: number;
  readonly initialTypeMilliseconds: number;
  readonly gpuTypeMilliseconds: number;
  readonly comptimeMilliseconds: number;
  readonly finalTypeMilliseconds: number;
  readonly coreMilliseconds: number;
  readonly flatCoreMilliseconds: number;
  readonly cpuCoreRewriteMilliseconds: number;
  readonly gpuCoreInitializationMilliseconds: number;
  readonly gpuCoreMilliseconds: number;
  readonly gpuCoreTransferMilliseconds: number;
  readonly gpuCoreCommitMilliseconds: number;
  readonly wasmMilliseconds: number;
  readonly gpuWasmMilliseconds: number;
};

export type DucklangCompilationStageTimings = {
  readonly sourceExpansionMilliseconds: number;
  readonly semanticContextMilliseconds: number;
  readonly parsingMilliseconds: number;
  readonly semanticFingerprintMilliseconds: number;
  readonly semanticReuseValidationMilliseconds: number;
  readonly elaborationMilliseconds: number;
  readonly resolutionMilliseconds: number;
  readonly typeAnalysisMilliseconds: number;
  readonly gpuTypeSolveMilliseconds: number;
  readonly preComptimeSpecializationMilliseconds: number;
  readonly comptimeMilliseconds: number;
  readonly postComptimeSpecializationMilliseconds: number;
  readonly coreLoweringMilliseconds: number;
  readonly coreFlatteningMilliseconds: number;
  readonly gpuCorePassMilliseconds: number;
  readonly cpuCoreRewriteMilliseconds: number;
  readonly coreInflationMilliseconds: number;
  readonly wasmPlanningAndCpuEmissionMilliseconds: number;
  readonly gpuWasmEmissionMilliseconds: number;
  readonly wasmSelectionMilliseconds: number;
  readonly abiConstructionMilliseconds: number;
  readonly wasmValidationMilliseconds: number;
  readonly artifactValidationMilliseconds: number;
};

export type DucklangCompilationTimingDetails = {
  readonly parserInitializationMilliseconds: number;
  readonly contextualClassificationMilliseconds: number;
  readonly parserExecutionMilliseconds: number;
  readonly syntaxMilliseconds: number;
  readonly astLoweringMilliseconds: number;
  readonly hostInterfaceMilliseconds: number;
  readonly sourceTestElaborationMilliseconds: number;
  readonly localImportResolutionMilliseconds: number;
  readonly typeQualificationMilliseconds: number;
  readonly loopExitValidationMilliseconds: number;
  readonly moduleExportLoweringMilliseconds: number;
  readonly ownershipValidationMilliseconds: number;
  readonly handlerElaborationMilliseconds: number;
  readonly derivationElaborationMilliseconds: number;
  readonly extensionElaborationMilliseconds: number;
  readonly staticLoopExpansionMilliseconds: number;
  readonly controlFlowLoweringMilliseconds: number;
  readonly typeInferenceMilliseconds: number;
  readonly typeReflectionMilliseconds: number;
  readonly preSpecializationDemandMilliseconds: number;
  readonly preSpecializationFrontierMilliseconds: number;
  readonly preSpecializationRewriteMilliseconds: number;
  readonly preSpecializationLiftingMilliseconds: number;
  readonly preSpecializationReachabilityMilliseconds: number;
  readonly preSpecializationAccountingMilliseconds: number;
  readonly postSpecializationDemandMilliseconds: number;
  readonly postSpecializationFrontierMilliseconds: number;
  readonly postSpecializationRewriteMilliseconds: number;
  readonly postSpecializationLiftingMilliseconds: number;
  readonly postSpecializationReachabilityMilliseconds: number;
  readonly postSpecializationAccountingMilliseconds: number;
  readonly gpuCoreInitializationMilliseconds: number;
  readonly gpuTypeQueueWaitMilliseconds: number;
  readonly gpuCoreQueueWaitMilliseconds: number;
  readonly gpuWasmQueueWaitMilliseconds: number;
  readonly gpuCoreExecutionMilliseconds: number;
  readonly gpuCoreTransferMilliseconds: number;
  readonly gpuCoreCommitMilliseconds: number;
};

export type DucklangCompilationWork = {
  readonly sourceBytes: number;
  readonly expandedSourceBytes: number;
  readonly parsedStatementCount: number;
  readonly linkedStatementCount: number;
  readonly moduleAnalysisCount: number;
  readonly moduleReuseCount: number;
  readonly moduleSyntaxAnalysisCount: number;
  readonly moduleSyntaxReuseCount: number;
  readonly semanticArtifactReuseCount: number;
  readonly exactSourceRevisionReuseCount: number;
  readonly trailingTriviaRevisionReuseCount: number;
  readonly syntaxAnalysisCount: number;
  readonly semanticFingerprintReuseCount: number;
  readonly typedBindingCount: number;
  readonly typeEqualityCount: number;
  readonly effectRowMembershipCount: number;
  readonly capabilityOperandCount: number;
  readonly rootCapabilityCount: number;
  readonly directStatePassingRegionCount: number;
  readonly directStatePassingFunctionCount: number;
  readonly cpsTransformedRegionCount: number;
  readonly cpsTransformedFunctionCount: number;
  readonly handledPerformanceCount: number;
  readonly continuationCaptureCount: number;
  readonly comptimeExpressionCount: number;
  readonly functionComptimeExpressionCount: number;
  readonly scalarComptimeJobCount: number;
  readonly deferredComptimeExpressionCount: number;
  readonly comptimeChangedBindingCount: number;
  readonly specializationInputBindingCount: number;
  readonly specializationDemandedBindingCount: number;
  readonly specializationDiscardedBindingCount: number;
  readonly specializationInputNodeCount: number;
  readonly specializationDemandedInputNodeCount: number;
  readonly specializationResidualNodeCount: number;
  readonly specializationDistinctKeyCount: number;
  readonly specializationCacheHitCount: number;
  readonly specializationDistinctFunctionAnalysisCount: number;
  readonly specializationRepeatedFunctionAnalysisCount: number;
  readonly postSpecializationFrontierBindingCount: number;
  readonly postSpecializationFrontierNodeCount: number;
  readonly downstreamParallelFunctionCount: number;
  readonly coreFunctionCount: number;
  readonly coreBlockCount: number;
  readonly coreOperationCount: number;
  readonly flatCoreValueCount: number;
  readonly gpuRewriteCandidateCount: number;
  readonly gpuRewriteCandidateDescriptorBytes: number;
  readonly gpuCoreLogicalDeviceBufferBytes: number;
  readonly gpuRewriteDispatchedInvocationCount: number;
  readonly gpuRewriteProposalCount: number;
  readonly wasmAtomCount: number;
  readonly gpuWasmLengthAtomCount: number;
  readonly gpuWasmResolvedOffsetBytes: number;
  readonly gpuWasmAtomInputBytes: number;
  readonly gpuWasmDispatchedInvocationCount: number;
  readonly wasmOutputBufferBytes: number;
  readonly wasmBytes: number;
  readonly backendFunctionAnalysisCount: number;
  readonly backendFunctionReuseCount: number;
  readonly gpuTypeSubmissionBatchSize: number;
  readonly gpuTypePayloadBatchSize: number;
  readonly gpuCoreSubmissionBatchSize: number;
  readonly gpuCorePayloadBatchSize: number;
  readonly gpuWasmSubmissionBatchSize: number;
  readonly gpuWasmPayloadBatchSize: number;
};

export type DucklangCompilationProfile = {
  readonly totalMilliseconds: number;
  readonly accountedMilliseconds: number;
  readonly unattributedMilliseconds: number;
  readonly stages: DucklangCompilationStageTimings;
  readonly details: DucklangCompilationTimingDetails;
  readonly work: DucklangCompilationWork;
};

type SharedCompilationArtifact = {
  readonly wasm: Uint8Array;
  readonly fcg: FcgModule;
  readonly flatFcg: FlatFcgPackage;
  readonly initialTypes: readonly string[];
  readonly finalTypes: readonly string[];
  readonly gpuTypeResult: GpuSolveResult | undefined;
  readonly gpuWasmResult: GpuWasmEmissionResult | undefined;
  readonly comptimeCpuValues: readonly ComptimeValue[];
  readonly comptimeGpuResult: ComptimeBatchResult | undefined;
  readonly interactionResults: readonly InteractionResult[];
  readonly macros: Omit<MacroExpansionReport, "module">;
  readonly backends: CompilationBackends;
  readonly timings: CompilationTimings;
};

export type HaskellCompilationArtifact = SharedCompilationArtifact & {
  readonly language: "haskell";
  readonly inferred: InferredModule;
};

export type DucklangCompilationArtifact = SharedCompilationArtifact & {
  readonly language: "ducklang";
  readonly inferred: TypedDucklangModule;
  readonly effectHir: TypedDucklangEffectModule;
  readonly core: DucklangCoreModule;
  readonly flatCore: FlatDucklangCore;
  readonly optimizedFlatCore: FlatDucklangCore;
  readonly optimizedCore: DucklangCoreModule;
  readonly gpuCoreResult: GpuDucklangCoreResult | undefined;
  readonly abi: DucklangManagedAbi;
  readonly profile: DucklangCompilationProfile;
};

export type CompilationArtifact =
  | HaskellCompilationArtifact
  | DucklangCompilationArtifact;

type DucklangDependencyIdentity = {
  readonly importer: string;
  readonly path: string;
  readonly canonicalSource: string;
  readonly sourceHash: string;
};

type CachedDucklangCompilation = {
  readonly artifact: DucklangCompilationArtifact;
  readonly dependencies: readonly DucklangDependencyIdentity[];
};

type CachedDucklangSourceRevision = {
  expandedSource: string;
  readonly parsedResult: Awaited<
    ReturnType<typeof parseDucklangModuleWithTimings>
  >;
  readonly syntaxDependencyEnd: number;
  readonly syntaxIdentity: unknown;
  readonly semanticIdentities: Map<string, string>;
};

export type DucklangCompilationSession = {
  readonly moduleInstances: DucklangModuleInstances<DucklangModule>;
  readonly moduleSyntax: DucklangModuleSyntaxCache;
  readonly backendFunctions: DucklangBackendFunctionCache;
  readonly compilations: Map<string, CachedDucklangCompilation>;
  readonly sourceRevisions: Map<string, CachedDucklangSourceRevision>;
};

export function createDucklangCompilationSession(): DucklangCompilationSession {
  return {
    moduleInstances: createDucklangModuleInstanceCache<DucklangModule>(),
    moduleSyntax: createDucklangModuleSyntaxCache(),
    backendFunctions: createDucklangBackendFunctionCache(),
    compilations: new Map(),
    sourceRevisions: new Map(),
  };
}

export type DucklangModuleNormalizationArtifact = {
  readonly language: "ducklang";
  readonly stage: "compileTimeModule";
  readonly module: TypedDucklangModule;
  readonly value: Extract<DucklangConstValue, { readonly kind: "module" }>;
};

export function compileModuleSource(
  file: `${string}.hs`,
  source: string,
  options?: CompilationOptions,
): Promise<HaskellCompilationArtifact>;
export function compileModuleSource(
  file: `${string}.duck`,
  source: string,
  options?: CompilationOptions,
): Promise<DucklangCompilationArtifact>;
export function compileModuleSource(
  file: string,
  source: string,
  options?: CompilationOptions,
): Promise<CompilationArtifact>;
export async function compileModuleSource(
  file: string,
  source: string,
  options: CompilationOptions = {},
): Promise<CompilationArtifact> {
  if (file.endsWith(".duck")) {
    return await compileDucklangModuleSource(file, source, options);
  }
  if (options.hostInterface !== undefined) {
    throw new TypeError(
      `hostInterface is available only for Ducklang compilation; received ${file}`,
    );
  }
  if (options.session !== undefined) {
    throw new TypeError(
      `session is available only for Ducklang compilation; received ${file}`,
    );
  }
  return await compileHaskellModuleSource(file, source, options);
}

async function compileHaskellModuleSource(
  file: string,
  source: string,
  options: CompilationOptions,
): Promise<HaskellCompilationArtifact> {
  const gpuMode = options.gpuMode ?? "auto";
  const gpuWasmVerification = options.gpuWasmVerification ?? "differential";
  const parseStart = performance.now();
  const parsed = parseModule(file, source);
  const parseMilliseconds = performance.now() - parseStart;

  const macroStart = performance.now();
  const macroExpansion = await expandMacros(parsed);
  const macroMilliseconds = performance.now() - macroStart;

  const initialTypeStart = performance.now();
  const initialInference = inferModule(macroExpansion.module);
  const initialTypeMilliseconds = performance.now() - initialTypeStart;

  const gpuTypeStart = performance.now();
  const gpuTypeResult = gpuMode === "off"
    ? undefined
    : await solveTypeEqualitiesOnGpu(initialInference.equalities, {
      scheduling: options.gpuScheduling,
    });
  const gpuTypeMilliseconds = performance.now() - gpuTypeStart;
  if (gpuTypeResult?.status === "constructorClash") {
    throw new TypeError(
      `${file}:${gpuTypeResult.sourceStart}: GPU solver found constructor clash ${gpuTypeResult.left} versus ${gpuTypeResult.right}`,
    );
  }
  if (gpuTypeResult?.status === "infiniteType") {
    throw new TypeError(
      `${file}: GPU solver found infinite type class ${gpuTypeResult.representative}`,
    );
  }
  if (gpuTypeResult?.status === "unavailable" && gpuMode === "required") {
    throw new Error(gpuTypeResult.reason);
  }

  const comptimeStart = performance.now();
  const interaction = evaluateModuleInteractionComptime(macroExpansion.module);
  const comptime = await evaluateModuleComptime(
    interaction.module,
    gpuMode !== "off",
  );
  if (comptime.gpu?.status === "unavailable" && gpuMode === "required") {
    throw new Error(comptime.gpu.reason);
  }
  const comptimeMilliseconds = performance.now() - comptimeStart;

  const finalTypeStart = performance.now();
  const finalInference = inferModule(comptime.module);
  const finalTypeMilliseconds = performance.now() - finalTypeStart;

  const wasmStart = performance.now();
  const lowered = lowerToFcgAndWasm(finalInference, {
    emission: gpuMode === "off" || gpuWasmVerification === "differential"
      ? "cpu"
      : "planOnly",
  });
  const wasmMilliseconds = performance.now() - wasmStart;
  const gpuWasmStart = performance.now();
  const gpuWasmResult = gpuMode === "off"
    ? undefined
    : await emitWasmPlanOnGpu(lowered.wasmPlan, {
      scheduling: options.gpuScheduling,
    });
  const gpuWasmMilliseconds = performance.now() - gpuWasmStart;
  const wasm = selectWasmOutput(
    file,
    lowered.wasm,
    lowered.wasmPlan,
    gpuWasmResult,
    gpuMode,
    gpuWasmVerification,
  );
  validateSelectedWasm(file, wasm);
  return {
    language: "haskell",
    wasm,
    fcg: lowered.fcg,
    flatFcg: lowered.flatFcg,
    inferred: finalInference,
    initialTypes: initialInference.declarations.map((typed) =>
      `${typed.declaration.name.text} :: ${formatScheme(typed.scheme)}`
    ),
    finalTypes: finalInference.declarations.map((typed) =>
      `${typed.declaration.name.text} :: ${formatScheme(typed.scheme)}`
    ),
    gpuTypeResult,
    gpuWasmResult,
    comptimeCpuValues: comptime.cpuValues,
    comptimeGpuResult: comptime.gpu,
    interactionResults: interaction.results,
    macros: {
      invocationCount: macroExpansion.invocationCount,
      generatedCount: macroExpansion.generatedCount,
      wasmByteCount: macroExpansion.wasmByteCount,
    },
    backends: {
      typeCheck: gpuTypeResult?.status === "solved" ? "cpu+gpu" : "cpu",
      comptime: comptime.gpu?.status === "completed" ? "cpu+gpu" : "cpu",
      coreRewrite: "notApplicable",
      wasmEmission: gpuWasmResult?.status === "completed" ? "gpu" : "cpu",
      wasmVerification: gpuWasmResult?.status === "completed" &&
          gpuWasmVerification === "differential"
        ? "cpuDifferential"
        : "none",
    },
    timings: {
      parseMilliseconds,
      includeMilliseconds: 0,
      parserInitializationMilliseconds: 0,
      syntaxMilliseconds: parseMilliseconds,
      astLoweringMilliseconds: 0,
      elaborationMilliseconds: 0,
      resolutionMilliseconds: 0,
      macroMilliseconds,
      initialTypeMilliseconds,
      gpuTypeMilliseconds,
      comptimeMilliseconds,
      finalTypeMilliseconds,
      coreMilliseconds: 0,
      flatCoreMilliseconds: 0,
      cpuCoreRewriteMilliseconds: 0,
      gpuCoreInitializationMilliseconds: 0,
      gpuCoreMilliseconds: 0,
      gpuCoreTransferMilliseconds: 0,
      gpuCoreCommitMilliseconds: 0,
      wasmMilliseconds,
      gpuWasmMilliseconds,
    },
  };
}

export async function normalizeDucklangModuleSource(
  file: string,
  source: string,
  options: CompilationOptions = {},
): Promise<DucklangModuleNormalizationArtifact> {
  const prepared = await prepareDucklangModuleSource(file, source, options);
  const frontend = await elaborateDucklangModuleSource(prepared, options);
  return {
    language: "ducklang",
    stage: "compileTimeModule",
    module: frontend.module,
    value: evaluateDucklangConstModule(frontend.module, {
      fuel: 1_000_000,
    }),
  };
}

type PreparedDucklangSource = {
  readonly file: string;
  readonly source: string;
  readonly expandedSource: string;
  readonly parsedResult: Awaited<
    ReturnType<typeof parseDucklangModuleWithTimings>
  >;
  readonly semanticIdentity: string;
  readonly semanticFingerprintReused: boolean;
  readonly revisionReuse: "none" | "exact" | "trailingTrivia";
  readonly sourceExpansionMilliseconds: number;
  readonly semanticContextMilliseconds: number;
  readonly parsingMilliseconds: number;
  readonly semanticFingerprintMilliseconds: number;
  readonly parseMilliseconds: number;
};

type DucklangFrontendResult = {
  readonly module: TypedDucklangModule;
  readonly effectHir: TypedDucklangEffectModule;
  readonly initialTypes: readonly string[];
  readonly gpuTypeResult: GpuSolveResult | undefined;
  readonly comptime: {
    readonly cpuValues: readonly ComptimeValue[];
    readonly gpu: ComptimeBatchResult | undefined;
    readonly metrics: {
      readonly expressionCount: number;
      readonly functionExpressionCount: number;
      readonly scalarJobCount: number;
      readonly deferredExpressionCount: number;
    };
  };
  readonly profile: {
    readonly stages: DucklangCompilationStageTimings;
    readonly details: DucklangCompilationTimingDetails;
    readonly work: DucklangCompilationWork;
  };
  readonly dependencies: readonly DucklangDependencyIdentity[];
  readonly timings: {
    readonly parseMilliseconds: number;
    readonly includeMilliseconds: number;
    readonly parserInitializationMilliseconds: number;
    readonly syntaxMilliseconds: number;
    readonly astLoweringMilliseconds: number;
    readonly elaborationMilliseconds: number;
    readonly resolutionMilliseconds: number;
    readonly initialTypeMilliseconds: number;
    readonly gpuTypeMilliseconds: number;
    readonly comptimeMilliseconds: number;
  };
};

async function prepareDucklangModuleSource(
  file: string,
  source: string,
  options: CompilationOptions,
): Promise<PreparedDucklangSource> {
  const parseStart = performance.now();
  const includeStart = performance.now();
  const expandedSource = await expandDucklangIncludes(file, source);
  const sourceExpansionMilliseconds = performance.now() - includeStart;

  const semanticContextStart = performance.now();
  let hostInterfaceIdentity: unknown;
  if (options.hostInterface !== undefined) {
    try {
      const canonicalHost = await Deno.realPath(options.hostInterface);
      const hostSource = await expandDucklangIncludes(
        canonicalHost,
        await Deno.readTextFile(canonicalHost),
      );
      hostInterfaceIdentity = {
        canonicalHost,
        sourceHash: await ducklangSourceHash(hostSource),
      };
    } catch (cause) {
      throw new TypeError(
        `${file}: cannot resolve Ducklang host interface ${
          JSON.stringify(options.hostInterface)
        }`,
        { cause },
      );
    }
  }
  const semanticContextIdentity = contentIdentity({
    schema: 1,
    file,
    hostInterface: hostInterfaceIdentity,
    gpuMode: options.gpuMode ?? "auto",
    gpuWasmVerification: options.gpuWasmVerification ?? "differential",
  });
  const semanticContextMilliseconds = performance.now() -
    semanticContextStart;

  const parsingStart = performance.now();
  const previousRevision = options.session?.sourceRevisions.get(file);
  const revisionReuse = previousRevision === undefined
    ? "none"
    : ducklangRevisionReuse(previousRevision, expandedSource);
  const parsedResult = revisionReuse === "none"
    ? await parseDucklangModuleWithTimings(file, expandedSource)
    : {
      module: previousRevision!.parsedResult.module,
      timings: {
        parserInitializationMilliseconds: 0,
        contextualClassificationMilliseconds: 0,
        parserExecutionMilliseconds: 0,
        syntaxMilliseconds: 0,
        astLoweringMilliseconds: 0,
      },
    };
  const parsingMilliseconds = revisionReuse === "none"
    ? performance.now() - parsingStart
    : 0;

  const semanticFingerprintStart = performance.now();
  const syntaxFingerprint = revisionReuse === "none"
    ? ducklangSyntaxFingerprint(parsedResult.module, expandedSource)
    : {
      identity: previousRevision!.syntaxIdentity,
      dependencyEnd: previousRevision!.syntaxDependencyEnd,
    };
  const semanticIdentities = revisionReuse === "none"
    ? new Map<string, string>()
    : previousRevision!.semanticIdentities;
  let semanticIdentity = semanticIdentities.get(semanticContextIdentity);
  const semanticFingerprintReused = semanticIdentity !== undefined;
  if (semanticIdentity === undefined) {
    semanticIdentity = contentIdentity({
      schema: 1,
      file,
      module: syntaxFingerprint.identity,
      hostInterface: hostInterfaceIdentity,
      gpuMode: options.gpuMode ?? "auto",
      gpuWasmVerification: options.gpuWasmVerification ?? "differential",
    });
    semanticIdentities.set(semanticContextIdentity, semanticIdentity);
  }
  const semanticFingerprintMilliseconds = performance.now() -
    semanticFingerprintStart;
  if (options.session !== undefined) {
    options.session.sourceRevisions.set(file, {
      expandedSource,
      parsedResult,
      syntaxDependencyEnd: syntaxFingerprint.dependencyEnd,
      syntaxIdentity: syntaxFingerprint.identity,
      semanticIdentities,
    });
  }

  return {
    file,
    source,
    expandedSource,
    parsedResult,
    semanticIdentity,
    semanticFingerprintReused,
    revisionReuse,
    sourceExpansionMilliseconds,
    semanticContextMilliseconds,
    parsingMilliseconds,
    semanticFingerprintMilliseconds: semanticFingerprintReused
      ? 0
      : semanticFingerprintMilliseconds,
    parseMilliseconds: performance.now() - parseStart,
  };
}

function ducklangRevisionReuse(
  revision: CachedDucklangSourceRevision,
  expandedSource: string,
): "none" | "exact" | "trailingTrivia" {
  if (revision.expandedSource === expandedSource) return "exact";
  const dependencyEnd = revision.syntaxDependencyEnd;
  if (
    dependencyEnd > revision.expandedSource.length ||
    dependencyEnd > expandedSource.length ||
    revision.expandedSource.slice(0, dependencyEnd) !==
      expandedSource.slice(0, dependencyEnd) ||
    !isDucklangTrivia(revision.expandedSource.slice(dependencyEnd)) ||
    !isDucklangTrivia(expandedSource.slice(dependencyEnd))
  ) {
    return "none";
  }
  revision.expandedSource = expandedSource;
  return "trailingTrivia";
}

function isDucklangTrivia(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/.test(source[index])) continue;
    if (source[index] !== "/" || source[index + 1] !== "/") return false;
    index += 2;
    while (
      index < source.length &&
      source[index] !== "\n" &&
      source[index] !== "\r"
    ) {
      index += 1;
    }
  }
  return true;
}

function ducklangSyntaxFingerprint(
  module: DucklangModule,
  source: string,
): {
  readonly identity: unknown;
  readonly dependencyEnd: number;
} {
  const normalized = normalizeDucklangSyntaxNode(module);
  return {
    identity: normalized.value,
    dependencyEnd: ducklangSyntaxDependencyEnd(source),
  };
}

function ducklangSyntaxDependencyEnd(source: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let lineComment = false;
  let dependencyEnd = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (quote !== undefined) {
      dependencyEnd = index + 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      dependencyEnd = index + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!/\s/.test(character)) dependencyEnd = index + 1;
  }
  return dependencyEnd;
}

function normalizeDucklangSyntaxNode(value: unknown): {
  readonly value: unknown;
  readonly lastSourceEnd: number | undefined;
} {
  if (value === null || typeof value !== "object") {
    return { value, lastSourceEnd: undefined };
  }
  if (Array.isArray(value)) {
    const elements = value.map(normalizeDucklangSyntaxNode);
    return {
      value: elements.map((element) => element.value),
      lastSourceEnd: maximumSourceEnd(
        elements.map((element) => element.lastSourceEnd),
      ),
    };
  }

  const record = value as Readonly<Record<string, unknown>>;
  const span = isSourceSpan(record.span) ? record.span : undefined;
  const entries = Object.entries(record)
    .filter(([key]) => key !== "span")
    .map(([key, entryValue]) =>
      [
        key,
        normalizeDucklangSyntaxNode(entryValue),
      ] as const
    );
  const descendantEnd = maximumSourceEnd(
    entries.map(([, entry]) => entry.lastSourceEnd),
  );
  const normalized = Object.fromEntries(
    entries.map(([key, entry]) => [key, entry.value]),
  );
  if (span !== undefined) {
    normalized.span = {
      file: span.file,
      start: span.start,
      end: descendantEnd ?? span.end,
    };
  }
  return {
    value: normalized,
    lastSourceEnd: descendantEnd ?? span?.end,
  };
}

function maximumSourceEnd(
  candidates: readonly (number | undefined)[],
): number | undefined {
  const ends = candidates.filter((candidate): candidate is number =>
    candidate !== undefined
  );
  return ends.length === 0 ? undefined : Math.max(...ends);
}

function isSourceSpan(value: unknown): value is {
  readonly file: string;
  readonly start: number;
  readonly end: number;
} {
  return typeof value === "object" && value !== null &&
    "file" in value && typeof value.file === "string" &&
    "start" in value && typeof value.start === "number" &&
    "end" in value && typeof value.end === "number";
}

async function elaborateDucklangModuleSource(
  prepared: PreparedDucklangSource,
  options: CompilationOptions,
): Promise<DucklangFrontendResult> {
  const {
    expandedSource,
    file,
    parsedResult,
    source,
    sourceExpansionMilliseconds,
    semanticContextMilliseconds,
    parsingMilliseconds,
    semanticFingerprintMilliseconds,
    semanticFingerprintReused,
    revisionReuse,
  } = prepared;
  const gpuMode = options.gpuMode ?? "auto";
  const parsedSource = parsedResult.module;

  const elaborationStart = performance.now();
  let parsedWithHost = parsedSource;
  let hostInterfaceMilliseconds = 0;
  if (options.hostInterface !== undefined) {
    const hostInterfaceStart = performance.now();
    parsedWithHost = await applyDucklangHostInterface(
      parsedSource,
      options.hostInterface,
    );
    hostInterfaceMilliseconds = performance.now() - hostInterfaceStart;
  }

  const sourceTestElaborationStart = performance.now();
  const withSourceTests = elaborateDucklangSourceTests(parsedWithHost);
  const sourceTestElaborationMilliseconds = performance.now() -
    sourceTestElaborationStart;

  const localImportResolutionStart = performance.now();
  const moduleInstances = options.session?.moduleInstances ??
    createDucklangModuleInstanceCache<DucklangModule>();
  const moduleSyntax = options.session?.moduleSyntax ??
    createDucklangModuleSyntaxCache();
  const moduleAnalysesBefore = moduleInstances.analyses;
  const moduleReusesBefore = moduleInstances.reuses;
  const moduleSyntaxAnalysesBefore = moduleSyntax.analyses;
  const moduleSyntaxReusesBefore = moduleSyntax.reuses;
  let moduleGraph: DucklangModuleGraph | undefined;
  const linked = await resolveDucklangLocalImports(
    withSourceTests,
    expandedSource,
    {
      instances: moduleInstances,
      syntaxCache: moduleSyntax,
      onModuleGraph: (graph) => {
        moduleGraph = graph;
      },
    },
  );
  const localImportResolutionMilliseconds = performance.now() -
    localImportResolutionStart;

  // Nominal type identity must be unambiguous before any pass looks a type up by
  // name, so this runs on the fully linked program and ahead of elaboration.
  const typeQualificationStart = performance.now();
  const qualified = qualifyDucklangTypeCollisions(linked);
  const typeQualificationMilliseconds = performance.now() -
    typeQualificationStart;

  // Ahead of static loop expansion, which would otherwise fold a
  // constant-conditioned loop away before its exits can be checked.
  const loopExitValidationStart = performance.now();
  requireConsistentDucklangLoopExits(qualified.module.statements);
  const loopExitValidationMilliseconds = performance.now() -
    loopExitValidationStart;

  const moduleExportLoweringStart = performance.now();
  const withLoweredExports = lowerDucklangModuleExports(qualified.module);
  const moduleExportLoweringMilliseconds = performance.now() -
    moduleExportLoweringStart;

  const ownershipValidationStart = performance.now();
  const withValidatedOwnership = validateDucklangOwnership(withLoweredExports);
  const ownershipValidationMilliseconds = performance.now() -
    ownershipValidationStart;

  const derivationElaborationStart = performance.now();
  const withElaboratedDerivations = elaborateDucklangDerivations(
    withValidatedOwnership,
  );
  const derivationElaborationMilliseconds = performance.now() -
    derivationElaborationStart;

  const extensionElaborationStart = performance.now();
  const withElaboratedExtensions = elaborateDucklangExtensions(
    withElaboratedDerivations,
  );
  const extensionElaborationMilliseconds = performance.now() -
    extensionElaborationStart;

  const staticLoopExpansionStart = performance.now();
  const withExpandedStaticLoops = expandStaticDucklangLoops(
    withElaboratedExtensions,
  );
  const staticLoopExpansionMilliseconds = performance.now() -
    staticLoopExpansionStart;

  const controlFlowLoweringStart = performance.now();
  const parsed = lowerDucklangControlFlow(withExpandedStaticLoops);
  const controlFlowLoweringMilliseconds = performance.now() -
    controlFlowLoweringStart;

  const elaborationMilliseconds = performance.now() - elaborationStart;

  const resolutionStart = performance.now();
  const resolved = resolveDucklangModule(parsed);
  const resolutionMilliseconds = performance.now() - resolutionStart;

  const initialTypeStart = performance.now();
  const typeInferenceStart = performance.now();
  const effectHir = validateDucklangEffectOwnership(
    inferDucklangEffectModule(resolved),
  );
  const typeInferenceMilliseconds = performance.now() - typeInferenceStart;

  const handlerElaborationStart = performance.now();
  const effectLowering = lowerDucklangEffectsStructurally(effectHir);
  const handlerElaborationMilliseconds = performance.now() -
    handlerElaborationStart;
  const typeReflectionStart = performance.now();
  const initialInference = reflectDucklangTypes(effectLowering.module);
  const typeReflectionMilliseconds = performance.now() - typeReflectionStart;
  const initialTypeMilliseconds = performance.now() - initialTypeStart;
  const initialTypes = initialInference.bindings.map((binding) =>
    `${binding.symbol.text}#${binding.symbol.id} :: ${
      formatDucklangType(binding.type)
    }`
  );

  const gpuTypeStart = performance.now();
  const gpuTypeResult = gpuMode === "off"
    ? undefined
    : await solveTypeEqualitiesOnGpu(initialInference.equalities);
  const gpuTypeMilliseconds = performance.now() - gpuTypeStart;
  if (gpuTypeResult?.status === "constructorClash") {
    throw new TypeError(
      `${file}:${gpuTypeResult.sourceStart}: GPU solver found constructor clash ${gpuTypeResult.left} versus ${gpuTypeResult.right}`,
    );
  }
  if (gpuTypeResult?.status === "infiniteType") {
    throw new TypeError(
      `${file}: GPU solver found infinite type class ${gpuTypeResult.representative}`,
    );
  }
  if (gpuTypeResult?.status === "unavailable" && gpuMode === "required") {
    throw new Error(gpuTypeResult.reason);
  }

  const preComptimeSpecializationStart = performance.now();
  const preComptimeSpecialization = specializeStaticDucklangClosures(
    initialInference,
  );
  const staticallySpecialized = preComptimeSpecialization.module;
  const preComptimeSpecializationMilliseconds = performance.now() -
    preComptimeSpecializationStart;

  const comptimeStart = performance.now();
  const comptime = await evaluateDucklangComptime(
    staticallySpecialized,
    gpuMode !== "off",
  );
  if (comptime.gpu?.status === "unavailable" && gpuMode === "required") {
    throw new Error(comptime.gpu.reason);
  }
  const comptimeMilliseconds = performance.now() - comptimeStart;

  const comptimeChanged = comptime.changedBindingSymbols.size > 0 ||
    comptime.resultChanged;
  const postComptimeSpecializationStart = comptimeChanged
    ? performance.now()
    : 0;
  const postComptimeSpecialization = comptimeChanged
    ? specializeStaticDucklangClosures(
      comptime.module,
      {
        changedBindingSymbols: comptime.changedBindingSymbols,
        resultChanged: comptime.resultChanged,
      },
    )
    : undefined;
  const postComptimeSpecializationMilliseconds =
    postComptimeSpecialization === undefined
      ? 0
      : performance.now() - postComptimeSpecializationStart;
  const specialized = postComptimeSpecialization?.module ?? comptime.module;

  return {
    module: specialized,
    effectHir,
    initialTypes,
    gpuTypeResult,
    comptime,
    profile: {
      stages: {
        sourceExpansionMilliseconds,
        semanticContextMilliseconds,
        parsingMilliseconds,
        semanticFingerprintMilliseconds,
        semanticReuseValidationMilliseconds: 0,
        elaborationMilliseconds,
        resolutionMilliseconds,
        typeAnalysisMilliseconds: initialTypeMilliseconds,
        gpuTypeSolveMilliseconds: gpuMode === "off" ? 0 : gpuTypeMilliseconds,
        preComptimeSpecializationMilliseconds,
        comptimeMilliseconds,
        postComptimeSpecializationMilliseconds,
        coreLoweringMilliseconds: 0,
        coreFlatteningMilliseconds: 0,
        gpuCorePassMilliseconds: 0,
        cpuCoreRewriteMilliseconds: 0,
        coreInflationMilliseconds: 0,
        wasmPlanningAndCpuEmissionMilliseconds: 0,
        gpuWasmEmissionMilliseconds: 0,
        wasmSelectionMilliseconds: 0,
        abiConstructionMilliseconds: 0,
        wasmValidationMilliseconds: 0,
        artifactValidationMilliseconds: 0,
      },
      details: {
        parserInitializationMilliseconds:
          parsedResult.timings.parserInitializationMilliseconds,
        contextualClassificationMilliseconds:
          parsedResult.timings.contextualClassificationMilliseconds,
        parserExecutionMilliseconds:
          parsedResult.timings.parserExecutionMilliseconds,
        syntaxMilliseconds: parsedResult.timings.syntaxMilliseconds,
        astLoweringMilliseconds: parsedResult.timings.astLoweringMilliseconds,
        hostInterfaceMilliseconds,
        sourceTestElaborationMilliseconds,
        localImportResolutionMilliseconds,
        typeQualificationMilliseconds,
        loopExitValidationMilliseconds,
        moduleExportLoweringMilliseconds,
        ownershipValidationMilliseconds,
        handlerElaborationMilliseconds,
        derivationElaborationMilliseconds,
        extensionElaborationMilliseconds,
        staticLoopExpansionMilliseconds,
        controlFlowLoweringMilliseconds,
        typeInferenceMilliseconds,
        typeReflectionMilliseconds,
        preSpecializationDemandMilliseconds:
          preComptimeSpecialization.timings.demandMilliseconds,
        preSpecializationFrontierMilliseconds:
          preComptimeSpecialization.timings.frontierMilliseconds,
        preSpecializationRewriteMilliseconds:
          preComptimeSpecialization.timings.rewriteMilliseconds,
        preSpecializationLiftingMilliseconds:
          preComptimeSpecialization.timings.liftingMilliseconds,
        preSpecializationReachabilityMilliseconds:
          preComptimeSpecialization.timings.reachabilityMilliseconds,
        preSpecializationAccountingMilliseconds:
          preComptimeSpecialization.timings.accountingMilliseconds,
        postSpecializationDemandMilliseconds:
          postComptimeSpecialization?.timings.demandMilliseconds ?? 0,
        postSpecializationFrontierMilliseconds:
          postComptimeSpecialization?.timings.frontierMilliseconds ?? 0,
        postSpecializationRewriteMilliseconds:
          postComptimeSpecialization?.timings.rewriteMilliseconds ?? 0,
        postSpecializationLiftingMilliseconds:
          postComptimeSpecialization?.timings.liftingMilliseconds ?? 0,
        postSpecializationReachabilityMilliseconds:
          postComptimeSpecialization?.timings.reachabilityMilliseconds ?? 0,
        postSpecializationAccountingMilliseconds:
          postComptimeSpecialization?.timings.accountingMilliseconds ?? 0,
        gpuCoreInitializationMilliseconds: 0,
        gpuTypeQueueWaitMilliseconds: gpuTypeResult?.status === "solved"
          ? gpuTypeResult.queueWaitMilliseconds ?? 0
          : 0,
        gpuCoreQueueWaitMilliseconds: 0,
        gpuWasmQueueWaitMilliseconds: 0,
        gpuCoreExecutionMilliseconds: 0,
        gpuCoreTransferMilliseconds: 0,
        gpuCoreCommitMilliseconds: 0,
      },
      work: {
        sourceBytes: new TextEncoder().encode(source).byteLength,
        expandedSourceBytes:
          new TextEncoder().encode(expandedSource).byteLength,
        parsedStatementCount: parsedSource.statements.length,
        linkedStatementCount: linked.statements.length,
        moduleAnalysisCount: moduleInstances.analyses - moduleAnalysesBefore,
        moduleReuseCount: moduleInstances.reuses - moduleReusesBefore,
        moduleSyntaxAnalysisCount: moduleSyntax.analyses -
          moduleSyntaxAnalysesBefore,
        moduleSyntaxReuseCount: moduleSyntax.reuses -
          moduleSyntaxReusesBefore,
        semanticArtifactReuseCount: 0,
        exactSourceRevisionReuseCount: revisionReuse === "exact" ? 1 : 0,
        trailingTriviaRevisionReuseCount: revisionReuse === "trailingTrivia"
          ? 1
          : 0,
        syntaxAnalysisCount: revisionReuse === "none" ? 1 : 0,
        semanticFingerprintReuseCount: semanticFingerprintReused ? 1 : 0,
        typedBindingCount: initialInference.bindings.length,
        typeEqualityCount: initialInference.equalities.length,
        effectRowMembershipCount: initialInference.bindings.reduce(
          (total, binding) =>
            total + binding.latentEffectRow.operations.length +
            binding.latentEffectRow.parameterEffects.length,
          0,
        ),
        capabilityOperandCount: effectLowering.metrics.capabilityOperandCount,
        rootCapabilityCount: new Set(
          initialInference.requiredEffects.map((effect) => effect.effectName),
        ).size,
        directStatePassingRegionCount:
          effectLowering.metrics.directStatePassingRegionCount,
        directStatePassingFunctionCount:
          effectLowering.metrics.directStatePassingFunctionCount,
        cpsTransformedRegionCount:
          effectLowering.metrics.cpsTransformedRegionCount,
        cpsTransformedFunctionCount:
          effectLowering.metrics.cpsTransformedFunctionCount,
        handledPerformanceCount: effectLowering.metrics.handledPerformanceCount,
        continuationCaptureCount:
          effectLowering.metrics.continuationCaptureCount,
        comptimeExpressionCount: comptime.metrics.expressionCount,
        functionComptimeExpressionCount:
          comptime.metrics.functionExpressionCount,
        scalarComptimeJobCount: comptime.metrics.scalarJobCount,
        deferredComptimeExpressionCount:
          comptime.metrics.deferredExpressionCount,
        comptimeChangedBindingCount: comptime.metrics.changedBindingCount,
        specializationInputBindingCount:
          preComptimeSpecialization.metrics.inputBindingCount,
        specializationDemandedBindingCount:
          preComptimeSpecialization.metrics.demandedBindingCount,
        specializationDiscardedBindingCount:
          preComptimeSpecialization.metrics.inputBindingCount -
          preComptimeSpecialization.metrics.demandedBindingCount,
        specializationInputNodeCount:
          preComptimeSpecialization.metrics.inputNodeCount,
        specializationDemandedInputNodeCount:
          preComptimeSpecialization.metrics.demandedInputNodeCount,
        specializationResidualNodeCount:
          postComptimeSpecialization?.metrics.residualNodeCount ??
            preComptimeSpecialization.metrics.residualNodeCount,
        specializationDistinctKeyCount:
          preComptimeSpecialization.metrics.distinctSpecializationKeyCount +
          (postComptimeSpecialization?.metrics
            .distinctSpecializationKeyCount ?? 0),
        specializationCacheHitCount:
          preComptimeSpecialization.metrics.specializationCacheHitCount +
          (postComptimeSpecialization?.metrics.specializationCacheHitCount ??
            0),
        specializationDistinctFunctionAnalysisCount:
          preComptimeSpecialization.metrics.distinctFunctionAnalysisCount +
          (postComptimeSpecialization?.metrics.distinctFunctionAnalysisCount ??
            0),
        specializationRepeatedFunctionAnalysisCount:
          preComptimeSpecialization.metrics.repeatedFunctionAnalysisCount +
          (postComptimeSpecialization?.metrics.repeatedFunctionAnalysisCount ??
            0),
        postSpecializationFrontierBindingCount:
          postComptimeSpecialization?.metrics.rewrittenBindingCount ?? 0,
        postSpecializationFrontierNodeCount:
          postComptimeSpecialization?.metrics.rewrittenInputNodeCount ?? 0,
        downstreamParallelFunctionCount: 0,
        coreFunctionCount: 0,
        coreBlockCount: 0,
        coreOperationCount: 0,
        flatCoreValueCount: 0,
        gpuRewriteCandidateCount: 0,
        gpuRewriteCandidateDescriptorBytes: 0,
        gpuCoreLogicalDeviceBufferBytes: 0,
        gpuRewriteDispatchedInvocationCount: 0,
        gpuRewriteProposalCount: 0,
        wasmAtomCount: 0,
        gpuWasmLengthAtomCount: 0,
        gpuWasmResolvedOffsetBytes: 0,
        gpuWasmAtomInputBytes: 0,
        gpuWasmDispatchedInvocationCount: 0,
        wasmOutputBufferBytes: 0,
        wasmBytes: 0,
        backendFunctionAnalysisCount: 0,
        backendFunctionReuseCount: 0,
        gpuTypeSubmissionBatchSize: gpuTypeResult?.status === "solved"
          ? gpuTypeResult.submissionBatchSize ?? 0
          : 0,
        gpuTypePayloadBatchSize: gpuTypeResult?.status === "solved"
          ? gpuTypeResult.payloadBatchSize ?? 0
          : 0,
        gpuCoreSubmissionBatchSize: 0,
        gpuCorePayloadBatchSize: 0,
        gpuWasmSubmissionBatchSize: 0,
        gpuWasmPayloadBatchSize: 0,
      },
    },
    dependencies: moduleGraph === undefined
      ? []
      : ducklangDependencyIdentities(moduleGraph),
    timings: {
      parseMilliseconds: prepared.parseMilliseconds,
      includeMilliseconds: sourceExpansionMilliseconds,
      parserInitializationMilliseconds:
        parsedResult.timings.parserInitializationMilliseconds,
      syntaxMilliseconds: parsedResult.timings.syntaxMilliseconds,
      astLoweringMilliseconds: parsedResult.timings.astLoweringMilliseconds,
      elaborationMilliseconds,
      resolutionMilliseconds,
      initialTypeMilliseconds,
      gpuTypeMilliseconds,
      comptimeMilliseconds,
    },
  };
}

async function compileDucklangModuleSource(
  file: string,
  source: string,
  options: CompilationOptions,
): Promise<DucklangCompilationArtifact> {
  const compilationStart = performance.now();
  const gpuMode = options.gpuMode ?? "auto";
  const gpuWasmVerification = options.gpuWasmVerification ?? "differential";
  const prepared = await prepareDucklangModuleSource(file, source, options);
  let semanticReuseValidationMilliseconds = 0;
  const cachedCompilation = options.session?.compilations.get(
    prepared.semanticIdentity,
  );
  if (cachedCompilation !== undefined) {
    const semanticReuseValidationStart = performance.now();
    const sourceProvider = createDucklangFilesystemSourceProvider();
    const dependencyMatches = await Promise.all(
      cachedCompilation.dependencies.map(async (dependency) => {
        try {
          const resolved = await sourceProvider.resolve(
            {
              canonicalSource: dependency.importer,
              file: dependency.importer,
              source: "",
            },
            dependency.path,
            {
              file: dependency.importer,
              start: 0,
              end: 0,
            },
          );
          return resolved.canonicalSource === dependency.canonicalSource &&
            await ducklangSourceHash(resolved.source) === dependency.sourceHash;
        } catch {
          return false;
        }
      }),
    );
    const dependenciesMatch = dependencyMatches.every(Boolean);
    semanticReuseValidationMilliseconds = performance.now() -
      semanticReuseValidationStart;
    if (dependenciesMatch) {
      const stages: DucklangCompilationStageTimings = {
        sourceExpansionMilliseconds: prepared.sourceExpansionMilliseconds,
        semanticContextMilliseconds: prepared.semanticContextMilliseconds,
        parsingMilliseconds: prepared.parsingMilliseconds,
        semanticFingerprintMilliseconds:
          prepared.semanticFingerprintMilliseconds,
        semanticReuseValidationMilliseconds,
        elaborationMilliseconds: 0,
        resolutionMilliseconds: 0,
        typeAnalysisMilliseconds: 0,
        gpuTypeSolveMilliseconds: 0,
        preComptimeSpecializationMilliseconds: 0,
        comptimeMilliseconds: 0,
        postComptimeSpecializationMilliseconds: 0,
        coreLoweringMilliseconds: 0,
        coreFlatteningMilliseconds: 0,
        gpuCorePassMilliseconds: 0,
        cpuCoreRewriteMilliseconds: 0,
        coreInflationMilliseconds: 0,
        wasmPlanningAndCpuEmissionMilliseconds: 0,
        gpuWasmEmissionMilliseconds: 0,
        wasmSelectionMilliseconds: 0,
        abiConstructionMilliseconds: 0,
        wasmValidationMilliseconds: 0,
        artifactValidationMilliseconds: 0,
      };
      const accountedMilliseconds = Object.values(stages).reduce(
        (total, milliseconds) => total + milliseconds,
        0,
      );
      const totalMilliseconds = performance.now() - compilationStart;
      const previous = cachedCompilation.artifact;
      return {
        ...previous,
        profile: {
          totalMilliseconds,
          accountedMilliseconds,
          unattributedMilliseconds: totalMilliseconds -
            accountedMilliseconds,
          stages,
          details: {
            parserInitializationMilliseconds:
              prepared.parsedResult.timings.parserInitializationMilliseconds,
            contextualClassificationMilliseconds: prepared.parsedResult.timings
              .contextualClassificationMilliseconds,
            parserExecutionMilliseconds:
              prepared.parsedResult.timings.parserExecutionMilliseconds,
            syntaxMilliseconds:
              prepared.parsedResult.timings.syntaxMilliseconds,
            astLoweringMilliseconds:
              prepared.parsedResult.timings.astLoweringMilliseconds,
            hostInterfaceMilliseconds: 0,
            sourceTestElaborationMilliseconds: 0,
            localImportResolutionMilliseconds: 0,
            typeQualificationMilliseconds: 0,
            loopExitValidationMilliseconds: 0,
            moduleExportLoweringMilliseconds: 0,
            ownershipValidationMilliseconds: 0,
            handlerElaborationMilliseconds: 0,
            derivationElaborationMilliseconds: 0,
            extensionElaborationMilliseconds: 0,
            staticLoopExpansionMilliseconds: 0,
            controlFlowLoweringMilliseconds: 0,
            typeInferenceMilliseconds: 0,
            typeReflectionMilliseconds: 0,
            preSpecializationDemandMilliseconds: 0,
            preSpecializationFrontierMilliseconds: 0,
            preSpecializationRewriteMilliseconds: 0,
            preSpecializationLiftingMilliseconds: 0,
            preSpecializationReachabilityMilliseconds: 0,
            preSpecializationAccountingMilliseconds: 0,
            postSpecializationDemandMilliseconds: 0,
            postSpecializationFrontierMilliseconds: 0,
            postSpecializationRewriteMilliseconds: 0,
            postSpecializationLiftingMilliseconds: 0,
            postSpecializationReachabilityMilliseconds: 0,
            postSpecializationAccountingMilliseconds: 0,
            gpuCoreInitializationMilliseconds: 0,
            gpuTypeQueueWaitMilliseconds: 0,
            gpuCoreQueueWaitMilliseconds: 0,
            gpuWasmQueueWaitMilliseconds: 0,
            gpuCoreExecutionMilliseconds: 0,
            gpuCoreTransferMilliseconds: 0,
            gpuCoreCommitMilliseconds: 0,
          },
          work: {
            ...previous.profile.work,
            sourceBytes: new TextEncoder().encode(source).byteLength,
            expandedSourceBytes: new TextEncoder().encode(
              prepared.expandedSource,
            ).byteLength,
            moduleAnalysisCount: 0,
            moduleReuseCount: 0,
            moduleSyntaxAnalysisCount: 0,
            moduleSyntaxReuseCount: 0,
            semanticArtifactReuseCount: 1,
            exactSourceRevisionReuseCount: prepared.revisionReuse === "exact"
              ? 1
              : 0,
            trailingTriviaRevisionReuseCount:
              prepared.revisionReuse === "trailingTrivia" ? 1 : 0,
            syntaxAnalysisCount: prepared.revisionReuse === "none" ? 1 : 0,
            semanticFingerprintReuseCount: prepared.semanticFingerprintReused
              ? 1
              : 0,
            backendFunctionAnalysisCount: 0,
            backendFunctionReuseCount: 0,
            gpuTypeSubmissionBatchSize: 0,
            gpuTypePayloadBatchSize: 0,
            gpuCoreSubmissionBatchSize: 0,
            gpuCorePayloadBatchSize: 0,
            gpuWasmSubmissionBatchSize: 0,
            gpuWasmPayloadBatchSize: 0,
          },
        },
        timings: {
          ...previous.timings,
          parseMilliseconds: prepared.parseMilliseconds,
          includeMilliseconds: prepared.sourceExpansionMilliseconds,
          parserInitializationMilliseconds:
            prepared.parsedResult.timings.parserInitializationMilliseconds,
          syntaxMilliseconds: prepared.parsedResult.timings.syntaxMilliseconds,
          astLoweringMilliseconds:
            prepared.parsedResult.timings.astLoweringMilliseconds,
          elaborationMilliseconds: 0,
          resolutionMilliseconds: 0,
          initialTypeMilliseconds: 0,
          gpuTypeMilliseconds: 0,
          comptimeMilliseconds: 0,
          coreMilliseconds: 0,
          flatCoreMilliseconds: 0,
          cpuCoreRewriteMilliseconds: 0,
          gpuCoreInitializationMilliseconds: 0,
          gpuCoreMilliseconds: 0,
          gpuCoreTransferMilliseconds: 0,
          gpuCoreCommitMilliseconds: 0,
          wasmMilliseconds: 0,
          gpuWasmMilliseconds: 0,
        },
      };
    }
  }

  const frontend = await elaborateDucklangModuleSource(prepared, options);
  const specialized = frontend.module;
  const coreStart = performance.now();
  const core = lowerDucklangToCore(specialized);
  const effectClosed = closeDucklangEffectBoundary(specialized, core);
  const coreMilliseconds = performance.now() - coreStart;
  const flatCoreStart = performance.now();
  const flatCore = flattenDucklangCore(core);
  const flatCoreMilliseconds = performance.now() - flatCoreStart;

  const gpuCorePassStart = performance.now();
  const gpuCoreResult = gpuMode === "off"
    ? undefined
    : await runDucklangCoreGpuPass(flatCore, {
      scheduling: options.gpuScheduling,
    });
  const gpuCorePassMilliseconds = gpuMode === "off"
    ? 0
    : performance.now() - gpuCorePassStart;
  if (gpuCoreResult?.status === "unavailable" && gpuMode === "required") {
    throw new Error(gpuCoreResult.reason);
  }
  if (gpuCoreResult?.status === "invalid") {
    throw new Error(
      `${file}: GPU rejected CPU-validated flat Core: ${gpuCoreResult.reason}`,
    );
  }
  let optimizedFlatCore: FlatDucklangCore;
  let cpuCoreRewriteMilliseconds = 0;
  if (gpuCoreResult?.status === "completed") {
    optimizedFlatCore = gpuCoreResult.package;
  } else {
    const coreRewriteStart = performance.now();
    optimizedFlatCore = rewriteFlatDucklangCore(flatCore).package;
    cpuCoreRewriteMilliseconds = performance.now() - coreRewriteStart;
  }

  const coreInflationStart = performance.now();
  const optimizedCore = inflateFlatDucklangCore(optimizedFlatCore);
  const coreInflationMilliseconds = performance.now() - coreInflationStart;

  const wasmStart = performance.now();
  const backendFunctions = options.session?.backendFunctions;
  const backendFunctionAnalysesBefore = backendFunctions?.analyses ?? 0;
  const backendFunctionReusesBefore = backendFunctions?.reuses ?? 0;
  const lowered = lowerDucklangCoreToFcgAndWasm(optimizedCore, {
    emission: gpuMode === "off" || gpuWasmVerification === "differential"
      ? "cpu"
      : "planOnly",
    functions: backendFunctions,
  });
  const wasmMilliseconds = performance.now() - wasmStart;
  const gpuWasmStart = performance.now();
  const gpuWasmResult = gpuMode === "off"
    ? undefined
    : await emitWasmPlanOnGpu(lowered.wasmPlan, {
      scheduling: options.gpuScheduling,
    });
  const gpuWasmMilliseconds = performance.now() - gpuWasmStart;

  const wasmSelectionStart = performance.now();
  const wasm = selectWasmOutput(
    file,
    lowered.wasm,
    lowered.wasmPlan,
    gpuWasmResult,
    gpuMode,
    gpuWasmVerification,
  );
  const wasmSelectionMilliseconds = performance.now() - wasmSelectionStart;

  const abiConstructionStart = performance.now();
  const abi = createDucklangManagedAbi(effectClosed, lowered.textLiterals);
  const abiConstructionMilliseconds = performance.now() -
    abiConstructionStart;

  const wasmValidationStart = performance.now();
  const wasmModule = validateSelectedWasm(file, wasm);
  const wasmValidationMilliseconds = performance.now() - wasmValidationStart;

  const artifactValidationStart = performance.now();
  validateDucklangManagedArtifact(file, wasmModule, abi);
  const artifactValidationMilliseconds = performance.now() -
    artifactValidationStart;

  const stages: DucklangCompilationStageTimings = {
    ...frontend.profile.stages,
    semanticReuseValidationMilliseconds,
    coreLoweringMilliseconds: coreMilliseconds,
    coreFlatteningMilliseconds: flatCoreMilliseconds,
    gpuCorePassMilliseconds,
    cpuCoreRewriteMilliseconds,
    coreInflationMilliseconds,
    wasmPlanningAndCpuEmissionMilliseconds: wasmMilliseconds,
    gpuWasmEmissionMilliseconds: gpuMode === "off" ? 0 : gpuWasmMilliseconds,
    wasmSelectionMilliseconds,
    abiConstructionMilliseconds,
    wasmValidationMilliseconds,
    artifactValidationMilliseconds,
  };
  const accountedMilliseconds = Object.values(stages).reduce(
    (total, milliseconds) => total + milliseconds,
    0,
  );
  const totalMilliseconds = performance.now() - compilationStart;
  const profile: DucklangCompilationProfile = {
    totalMilliseconds,
    accountedMilliseconds,
    unattributedMilliseconds: totalMilliseconds - accountedMilliseconds,
    stages,
    details: {
      ...frontend.profile.details,
      gpuCoreInitializationMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.initializationMilliseconds
        : 0,
      gpuCoreQueueWaitMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.queueWaitMilliseconds
        : 0,
      gpuWasmQueueWaitMilliseconds: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.queueWaitMilliseconds
        : 0,
      gpuCoreExecutionMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.gpuMilliseconds
        : 0,
      gpuCoreTransferMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.transferMilliseconds
        : 0,
      gpuCoreCommitMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.commitMilliseconds
        : 0,
    },
    work: {
      ...frontend.profile.work,
      rootCapabilityCount: new Set(
        effectClosed.requiredEffects.map((effect) => effect.effectName),
      ).size,
      coreFunctionCount: core.functions.length,
      coreBlockCount: core.functions.reduce(
        (total, function_) => total + function_.blocks.length,
        0,
      ),
      coreOperationCount: core.functions.reduce(
        (functionTotal, function_) =>
          functionTotal +
          function_.blocks.reduce(
            (blockTotal, block) => blockTotal + block.operations.length,
            0,
          ),
        0,
      ),
      downstreamParallelFunctionCount: gpuCoreResult?.status === "completed"
        ? core.functions.length
        : 0,
      flatCoreValueCount: flatCore.valueFunctionIds.length,
      gpuRewriteCandidateCount: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.rewriteCandidateCount
        : 0,
      gpuRewriteCandidateDescriptorBytes: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.candidateDescriptorBytes
        : 0,
      gpuCoreLogicalDeviceBufferBytes: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.logicalDeviceBufferBytes
        : 0,
      gpuRewriteDispatchedInvocationCount: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.rewriteDispatchedInvocationCount
        : 0,
      gpuRewriteProposalCount: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.proposals.length
        : 0,
      wasmAtomCount: lowered.wasmPlan.atoms.length,
      gpuWasmLengthAtomCount: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.lengthAtomCount
        : 0,
      gpuWasmResolvedOffsetBytes: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.resolvedOffsetBytes
        : 0,
      gpuWasmAtomInputBytes: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.atomInputBytes
        : 0,
      gpuWasmDispatchedInvocationCount: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.dispatchedInvocationCount
        : 0,
      wasmOutputBufferBytes: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.outputBufferBytes
        : 0,
      wasmBytes: wasm.byteLength,
      backendFunctionAnalysisCount: (backendFunctions?.analyses ?? 0) -
        backendFunctionAnalysesBefore,
      backendFunctionReuseCount: (backendFunctions?.reuses ?? 0) -
        backendFunctionReusesBefore,
      gpuCoreSubmissionBatchSize: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.submissionBatchSize
        : 0,
      gpuCorePayloadBatchSize: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.payloadBatchSize
        : 0,
      gpuWasmSubmissionBatchSize: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.submissionBatchSize
        : 0,
      gpuWasmPayloadBatchSize: gpuWasmResult?.status === "completed"
        ? gpuWasmResult.payloadBatchSize
        : 0,
    },
  };
  const artifact: DucklangCompilationArtifact = {
    language: "ducklang",
    wasm,
    fcg: lowered.fcg,
    flatFcg: lowered.flatFcg,
    inferred: effectClosed,
    effectHir: frontend.effectHir,
    core,
    flatCore,
    optimizedFlatCore,
    optimizedCore,
    gpuCoreResult,
    abi,
    profile,
    initialTypes: frontend.initialTypes,
    finalTypes: frontend.initialTypes,
    gpuTypeResult: frontend.gpuTypeResult,
    gpuWasmResult,
    comptimeCpuValues: frontend.comptime.cpuValues,
    comptimeGpuResult: frontend.comptime.gpu,
    interactionResults: [],
    macros: {
      invocationCount: 0,
      generatedCount: 0,
      wasmByteCount: 0,
    },
    backends: {
      typeCheck: frontend.gpuTypeResult?.status === "solved"
        ? "cpu+gpu"
        : "cpu",
      comptime: frontend.comptime.gpu?.status === "completed"
        ? "cpu+gpu"
        : "cpu",
      coreRewrite: gpuCoreResult?.status === "completed" ? "gpu" : "cpu",
      wasmEmission: gpuWasmResult?.status === "completed" ? "gpu" : "cpu",
      wasmVerification: gpuWasmResult?.status === "completed" &&
          gpuWasmVerification === "differential"
        ? "cpuDifferential"
        : "none",
    },
    timings: {
      ...frontend.timings,
      macroMilliseconds: 0,
      finalTypeMilliseconds: 0,
      coreMilliseconds,
      flatCoreMilliseconds,
      cpuCoreRewriteMilliseconds,
      gpuCoreInitializationMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.initializationMilliseconds
        : 0,
      gpuCoreMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.gpuMilliseconds
        : 0,
      gpuCoreTransferMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.transferMilliseconds
        : 0,
      gpuCoreCommitMilliseconds: gpuCoreResult?.status === "completed"
        ? gpuCoreResult.commitMilliseconds
        : 0,
      wasmMilliseconds,
      gpuWasmMilliseconds,
    },
  };
  options.session?.compilations.set(prepared.semanticIdentity, {
    artifact,
    dependencies: frontend.dependencies,
  });
  return artifact;
}

function ducklangDependencyIdentities(
  graph: DucklangModuleGraph,
): readonly DucklangDependencyIdentity[] {
  const dependencies = new Map<string, DucklangDependencyIdentity>();
  for (const importer of graph.modules.values()) {
    for (const import_ of importer.imports) {
      const imported = graph.modules.get(import_.moduleId);
      if (imported === undefined) {
        throw new Error(
          `${importer.canonicalSource}:${import_.span.start}: module graph import ${import_.path} has no source identity`,
        );
      }
      const dependency = {
        importer: importer.canonicalSource,
        path: import_.path,
        canonicalSource: imported.canonicalSource,
        sourceHash: imported.sourceHash,
      };
      dependencies.set(contentIdentity(dependency), dependency);
    }
  }
  return [...dependencies.values()];
}

function selectWasmOutput(
  file: string,
  cpuWasm: Uint8Array | undefined,
  wasmPlan: WasmBinaryPlan,
  gpuResult: GpuWasmEmissionResult | undefined,
  gpuMode: GpuMode,
  verification: GpuWasmVerification,
): Uint8Array {
  if (gpuResult?.status === "unavailable") {
    if (gpuMode === "required") throw new Error(gpuResult.reason);
    return cpuWasm ?? emitWasmPlanOnCpu(wasmPlan);
  }
  if (gpuResult === undefined) {
    return cpuWasm ?? emitWasmPlanOnCpu(wasmPlan);
  }
  if (verification === "none") {
    return gpuResult.bytes;
  }
  if (cpuWasm === undefined) {
    throw new Error(
      `${file}: differential GPU Wasm verification has no CPU emission`,
    );
  }
  if (gpuResult.bytes.length !== cpuWasm.length) {
    throw new Error(
      `${file}: CPU/GPU Wasm length mismatch: CPU emitted ${cpuWasm.length} bytes; GPU emitted ${gpuResult.bytes.length}`,
    );
  }
  for (let index = 0; index < cpuWasm.length; index += 1) {
    if (cpuWasm[index] === gpuResult.bytes[index]) continue;
    throw new Error(
      `${file}: CPU/GPU Wasm mismatch at byte ${index}: CPU emitted ${
        cpuWasm[index]
      }; GPU emitted ${gpuResult.bytes[index]}`,
    );
  }
  return gpuResult.bytes;
}

export async function runMain(
  wasm: Uint8Array,
  hostInputs?: unknown,
): Promise<number | bigint> {
  const module = await WebAssembly.compile(
    new Uint8Array(wasm).buffer as ArrayBuffer,
  );
  const textSections = WebAssembly.Module.customSections(
    module,
    ducklangTextLiteralsSectionName,
  );
  if (textSections.length > 1) {
    throw new TypeError(
      `main runner received ${textSections.length} Ducklang text literal sections`,
    );
  }
  const textLiterals = textSections.length === 0
    ? []
    : parseDucklangTextLiterals("main runner", textSections[0]);
  const imports: WebAssembly.Imports = {};
  imports[ducklangRuntimeImportModule] = createDucklangRuntimeImports(
    createDucklangRuntimeHeap(textLiterals),
  );
  for (const descriptor of WebAssembly.Module.imports(module)) {
    if (descriptor.kind !== "function") {
      throw new TypeError(
        `main runner cannot provide ${descriptor.kind} import ${descriptor.module}.${descriptor.name}`,
      );
    }
    if (descriptor.module === ducklangRuntimeImportModule) continue;
    const value = readHostInput(hostInputs, descriptor.module, descriptor.name);
    const namespace = imports[descriptor.module] ?? {};
    namespace[descriptor.name] = () => value;
    imports[descriptor.module] = namespace;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const main = instance.exports.main;
  if (!(main instanceof Function)) {
    throw new Error("emitted module has no main export");
  }
  const result = main();
  if (typeof result !== "number" && typeof result !== "bigint") {
    throw new Error(`main returned ${typeof result}; expected i32 or i64`);
  }
  return result;
}

function readHostInput(
  inputs: unknown,
  effectName: string,
  operationName: string,
): number | bigint {
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new TypeError(
      `host input ${effectName}.${operationName} requires an input object`,
    );
  }
  const effect = (inputs as Record<string, unknown>)[effectName];
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) {
    throw new TypeError(
      `host input ${effectName}.${operationName} requires object property ${effectName}`,
    );
  }
  const value = (effect as Record<string, unknown>)[operationName];
  if (
    typeof value !== "bigint" &&
    (typeof value !== "number" || !Number.isSafeInteger(value))
  ) {
    throw new TypeError(
      `host input ${effectName}.${operationName} must be a safe integer or bigint; received ${
        String(value)
      }`,
    );
  }
  return value;
}

import {
  type ComptimeBatchResult,
  type ComptimeValue,
  evaluateModuleComptime,
} from "./comptime.ts";
import { evaluateDucklangComptime } from "./ducklang_comptime.ts";
import {
  createDucklangManagedAbi,
  type DucklangManagedAbi,
} from "./ducklang_abi.ts";
import {
  lowerDucklangControlFlow,
  requireConsistentDucklangLoopExits,
} from "./ducklang_control_flow.ts";
import { elaborateDucklangDerivations } from "./ducklang_derivations.ts";
import { elaborateDucklangExtensions } from "./ducklang_extensions.ts";
import { elaborateDucklangHandlers } from "./ducklang_handlers.ts";
import { validateDucklangOwnership } from "./ducklang_ownership.ts";
import { specializeStaticDucklangClosures } from "./ducklang_closures.ts";
import {
  ducklangTextLiteralsSectionName,
  lowerDucklangToFcgAndWasm,
} from "./ducklang_fcg.ts";
import {
  applyDucklangHostInterface,
  lowerDucklangModuleExports,
  resolveDucklangLocalImports,
} from "./ducklang_modules.ts";
import { expandDucklangIncludes } from "./ducklang_module_graph.ts";
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
  inferDucklangModule,
  type TypedDucklangModule,
} from "./ducklang_types.ts";
import { type FcgModule, lowerToFcgAndWasm } from "./fcg.ts";
import type { FlatFcgPackage } from "./flat_fcg.ts";
import { type GpuSolveResult, solveTypeEqualitiesOnGpu } from "./gpu_solver.ts";
import { emitWasmPlanOnGpu, type GpuWasmEmissionResult } from "./gpu_wasm.ts";
import {
  evaluateModuleInteractionComptime,
  type InteractionResult,
} from "./interaction.ts";
import { expandMacros, type MacroExpansionReport } from "./macros.ts";
import { parseModule } from "./parser.ts";
import { formatScheme, inferModule, type InferredModule } from "./types.ts";

export type GpuMode = "auto" | "off" | "required";

export type CompilationOptions = {
  readonly gpuMode?: GpuMode;
  readonly hostInterface?: string;
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
  readonly wasmMilliseconds: number;
  readonly gpuWasmMilliseconds: number;
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
  readonly timings: CompilationTimings;
};

export type HaskellCompilationArtifact = SharedCompilationArtifact & {
  readonly language: "haskell";
  readonly inferred: InferredModule;
};

export type DucklangCompilationArtifact = SharedCompilationArtifact & {
  readonly language: "ducklang";
  readonly inferred: TypedDucklangModule;
  readonly abi: DucklangManagedAbi;
};

export type CompilationArtifact =
  | HaskellCompilationArtifact
  | DucklangCompilationArtifact;

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
  return await compileHaskellModuleSource(file, source, options);
}

async function compileHaskellModuleSource(
  file: string,
  source: string,
  options: CompilationOptions,
): Promise<HaskellCompilationArtifact> {
  const gpuMode = options.gpuMode ?? "auto";
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
  const lowered = lowerToFcgAndWasm(finalInference);
  const wasmMilliseconds = performance.now() - wasmStart;
  const gpuWasmStart = performance.now();
  const gpuWasmResult = gpuMode === "off"
    ? undefined
    : await emitWasmPlanOnGpu(lowered.wasmPlan);
  const gpuWasmMilliseconds = performance.now() - gpuWasmStart;
  requireMatchingGpuWasm(file, lowered.wasm, gpuWasmResult, gpuMode);
  return {
    language: "haskell",
    wasm: gpuWasmResult?.status === "completed"
      ? gpuWasmResult.bytes
      : lowered.wasm,
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
      wasmMilliseconds,
      gpuWasmMilliseconds,
    },
  };
}

async function compileDucklangModuleSource(
  file: string,
  source: string,
  options: CompilationOptions,
): Promise<DucklangCompilationArtifact> {
  const gpuMode = options.gpuMode ?? "auto";
  const parseStart = performance.now();
  const includeStart = performance.now();
  const expandedSource = await expandDucklangIncludes(file, source);
  const includeMilliseconds = performance.now() - includeStart;
  const parsedResult = await parseDucklangModuleWithTimings(
    file,
    expandedSource,
  );
  const parsedSource = parsedResult.module;
  const elaborationStart = performance.now();
  const parsedWithHost = options.hostInterface === undefined
    ? parsedSource
    : await applyDucklangHostInterface(parsedSource, options.hostInterface);
  const linked = await resolveDucklangLocalImports(
    elaborateDucklangSourceTests(parsedWithHost),
    expandedSource,
  );
  // Nominal type identity must be unambiguous before any pass looks a type up by
  // name, so this runs on the fully linked program and ahead of elaboration.
  const qualified = qualifyDucklangTypeCollisions(linked);
  // Ahead of static loop expansion, which would otherwise fold a
  // constant-conditioned loop away before its exits can be checked.
  requireConsistentDucklangLoopExits(qualified.module.statements);
  const parsed = lowerDucklangControlFlow(
    expandStaticDucklangLoops(
      elaborateDucklangExtensions(
        elaborateDucklangDerivations(
          elaborateDucklangHandlers(
            validateDucklangOwnership(
              lowerDucklangModuleExports(qualified.module),
            ),
          ),
        ),
      ),
    ),
  );
  const elaborationMilliseconds = performance.now() - elaborationStart;
  const parseMilliseconds = performance.now() - parseStart;

  const resolutionStart = performance.now();
  const resolved = resolveDucklangModule(parsed);
  const resolutionMilliseconds = performance.now() - resolutionStart;
  const initialTypeStart = performance.now();
  const initialInference = reflectDucklangTypes(
    inferDucklangModule(resolved),
  );
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

  const comptimeStart = performance.now();
  const staticallySpecialized = specializeStaticDucklangClosures(
    initialInference,
  );
  const comptime = await evaluateDucklangComptime(
    staticallySpecialized,
    gpuMode !== "off",
  );
  if (comptime.gpu?.status === "unavailable" && gpuMode === "required") {
    throw new Error(comptime.gpu.reason);
  }
  const comptimeMilliseconds = performance.now() - comptimeStart;

  const wasmStart = performance.now();
  const specialized = specializeStaticDucklangClosures(comptime.module);
  const lowered = lowerDucklangToFcgAndWasm(specialized);
  const wasmMilliseconds = performance.now() - wasmStart;
  const gpuWasmStart = performance.now();
  const gpuWasmResult = gpuMode === "off"
    ? undefined
    : await emitWasmPlanOnGpu(lowered.wasmPlan);
  const gpuWasmMilliseconds = performance.now() - gpuWasmStart;
  requireMatchingGpuWasm(file, lowered.wasm, gpuWasmResult, gpuMode);
  return {
    language: "ducklang",
    wasm: gpuWasmResult?.status === "completed"
      ? gpuWasmResult.bytes
      : lowered.wasm,
    fcg: lowered.fcg,
    flatFcg: lowered.flatFcg,
    inferred: specialized,
    abi: createDucklangManagedAbi(specialized, lowered.textLiterals),
    initialTypes,
    finalTypes: initialTypes,
    gpuTypeResult,
    gpuWasmResult,
    comptimeCpuValues: comptime.cpuValues,
    comptimeGpuResult: comptime.gpu,
    interactionResults: [],
    macros: {
      invocationCount: 0,
      generatedCount: 0,
      wasmByteCount: 0,
    },
    timings: {
      parseMilliseconds,
      includeMilliseconds,
      parserInitializationMilliseconds:
        parsedResult.timings.parserInitializationMilliseconds,
      syntaxMilliseconds: parsedResult.timings.syntaxMilliseconds,
      astLoweringMilliseconds: parsedResult.timings.astLoweringMilliseconds,
      elaborationMilliseconds,
      resolutionMilliseconds,
      macroMilliseconds: 0,
      initialTypeMilliseconds,
      gpuTypeMilliseconds,
      comptimeMilliseconds,
      finalTypeMilliseconds: 0,
      wasmMilliseconds,
      gpuWasmMilliseconds,
    },
  };
}

function requireMatchingGpuWasm(
  file: string,
  cpuWasm: Uint8Array,
  gpuResult: GpuWasmEmissionResult | undefined,
  gpuMode: GpuMode,
): void {
  if (gpuResult?.status === "unavailable") {
    if (gpuMode === "required") throw new Error(gpuResult.reason);
    return;
  }
  if (gpuResult === undefined) return;
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
    : parseDucklangTextLiterals(textSections[0]);
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

function parseDucklangTextLiterals(section: ArrayBuffer): readonly string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(section));
  } catch (cause) {
    throw new TypeError(
      "main runner received malformed Ducklang text literals",
      {
        cause,
      },
    );
  }
  if (
    !Array.isArray(decoded) ||
    !decoded.every((value) => typeof value === "string")
  ) {
    throw new TypeError(
      "main runner expected the Ducklang text literal section to contain a string array",
    );
  }
  return decoded;
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

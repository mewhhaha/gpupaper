import {
  type ComptimeBatchResult,
  type ComptimeValue,
  evaluateModuleComptime,
} from "./comptime.ts";
import { evaluateDucklangComptime } from "./ducklang_comptime.ts";
import { lowerDucklangControlFlow } from "./ducklang_control_flow.ts";
import { specializeStaticDucklangClosures } from "./ducklang_closures.ts";
import { lowerDucklangToFcgAndWasm } from "./ducklang_fcg.ts";
import { parseDucklangModule } from "./ducklang_parser.ts";
import { resolveDucklangModule } from "./ducklang_resolution.ts";
import { expandStaticDucklangLoops } from "./ducklang_static_loops.ts";
import {
  formatDucklangType,
  inferDucklangModule,
  type TypedDucklangModule,
} from "./ducklang_types.ts";
import { type FcgModule, lowerToFcgAndWasm } from "./fcg.ts";
import { type GpuSolveResult, solveTypeEqualitiesOnGpu } from "./gpu_solver.ts";
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
};

export type CompilationTimings = {
  readonly parseMilliseconds: number;
  readonly macroMilliseconds: number;
  readonly initialTypeMilliseconds: number;
  readonly gpuTypeMilliseconds: number;
  readonly comptimeMilliseconds: number;
  readonly finalTypeMilliseconds: number;
  readonly wasmMilliseconds: number;
};

type SharedCompilationArtifact = {
  readonly wasm: Uint8Array;
  readonly fcg: FcgModule;
  readonly initialTypes: readonly string[];
  readonly finalTypes: readonly string[];
  readonly gpuTypeResult: GpuSolveResult | undefined;
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
  return {
    language: "haskell",
    wasm: lowered.wasm,
    fcg: lowered.fcg,
    inferred: finalInference,
    initialTypes: initialInference.declarations.map((typed) =>
      `${typed.declaration.name.text} :: ${formatScheme(typed.scheme)}`
    ),
    finalTypes: finalInference.declarations.map((typed) =>
      `${typed.declaration.name.text} :: ${formatScheme(typed.scheme)}`
    ),
    gpuTypeResult,
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
      macroMilliseconds,
      initialTypeMilliseconds,
      gpuTypeMilliseconds,
      comptimeMilliseconds,
      finalTypeMilliseconds,
      wasmMilliseconds,
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
  const parsed = lowerDucklangControlFlow(
    expandStaticDucklangLoops(await parseDucklangModule(file, source)),
  );
  const parseMilliseconds = performance.now() - parseStart;

  const initialTypeStart = performance.now();
  const resolved = resolveDucklangModule(parsed);
  const initialInference = inferDucklangModule(resolved);
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
  return {
    language: "ducklang",
    wasm: lowered.wasm,
    fcg: lowered.fcg,
    inferred: specialized,
    initialTypes,
    finalTypes: initialTypes,
    gpuTypeResult,
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
      macroMilliseconds: 0,
      initialTypeMilliseconds,
      gpuTypeMilliseconds,
      comptimeMilliseconds,
      finalTypeMilliseconds: 0,
      wasmMilliseconds,
    },
  };
}

export async function runMain(
  wasm: Uint8Array,
  hostInputs?: unknown,
): Promise<number | bigint> {
  const module = await WebAssembly.compile(
    new Uint8Array(wasm).buffer as ArrayBuffer,
  );
  const imports: WebAssembly.Imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    if (descriptor.kind !== "function") {
      throw new TypeError(
        `main runner cannot provide ${descriptor.kind} import ${descriptor.module}.${descriptor.name}`,
      );
    }
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

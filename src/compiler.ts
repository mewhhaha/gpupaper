import {
  type ComptimeBatchResult,
  type ComptimeValue,
  evaluateModuleComptime,
} from "./comptime.ts";
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

export type CompilationArtifact = {
  readonly wasm: Uint8Array;
  readonly fcg: FcgModule;
  readonly inferred: InferredModule;
  readonly initialTypes: readonly string[];
  readonly finalTypes: readonly string[];
  readonly gpuTypeResult: GpuSolveResult | undefined;
  readonly comptimeCpuValues: readonly ComptimeValue[];
  readonly comptimeGpuResult: ComptimeBatchResult | undefined;
  readonly interactionResults: readonly InteractionResult[];
  readonly macros: Omit<MacroExpansionReport, "module">;
  readonly timings: CompilationTimings;
};

export async function compileModuleSource(
  file: string,
  source: string,
  options: CompilationOptions = {},
): Promise<CompilationArtifact> {
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

export async function runMain(wasm: Uint8Array): Promise<number> {
  const module = await WebAssembly.compile(
    new Uint8Array(wasm).buffer as ArrayBuffer,
  );
  const instance = await WebAssembly.instantiate(module);
  const main = instance.exports.main;
  if (!(main instanceof Function)) {
    throw new Error("emitted module has no main export");
  }
  const result = main();
  if (typeof result !== "number") {
    throw new Error(`main returned ${typeof result}; expected i32`);
  }
  return result;
}

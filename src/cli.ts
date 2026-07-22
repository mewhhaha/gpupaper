import {
  type CompilationArtifact,
  compileModuleSource,
  type GpuMode,
  runMain,
} from "./compiler.ts";

if (import.meta.main) await main(Deno.args);

async function main(arguments_: readonly string[]): Promise<void> {
  const [command, file, ...rest] = arguments_;
  if (
    command === undefined || file === undefined ||
    !["compile", "run", "experiments"].includes(command)
  ) {
    throw new Error(
      "usage: cli.ts <compile|run|experiments> <file.hs> [output.wasm] [--cpu|--require-gpu]",
    );
  }
  const gpuMode: GpuMode = rest.includes("--cpu")
    ? "off"
    : rest.includes("--require-gpu")
    ? "required"
    : "auto";
  const source = await Deno.readTextFile(file);
  const artifact = await compileModuleSource(file, source, { gpuMode });

  if (command === "compile") {
    const outputArgument = rest.find((argument) => !argument.startsWith("--"));
    const output = outputArgument ?? file.replace(/\.hs$/, "") + ".wasm";
    await Deno.writeFile(output, artifact.wasm);
    console.log(`wrote ${artifact.wasm.length} bytes to ${output}`);
    printTypes(artifact);
    return;
  }
  if (command === "run") {
    const result = await runMain(artifact.wasm);
    printTypes(artifact);
    console.log(`main = ${result}`);
    return;
  }

  const result = await runMain(artifact.wasm);
  console.log(JSON.stringify(experimentReport(artifact, result), null, 2));
}

function printTypes(artifact: CompilationArtifact): void {
  for (const type of artifact.finalTypes) console.log(type);
  if (artifact.gpuTypeResult?.status === "unavailable") {
    console.log(
      `WebGPU type solver unavailable: ${artifact.gpuTypeResult.reason}`,
    );
  }
  if (artifact.comptimeGpuResult?.status === "unavailable") {
    console.log(
      `WebGPU comptime unavailable: ${artifact.comptimeGpuResult.reason}`,
    );
  }
}

function experimentReport(
  artifact: CompilationArtifact,
  mainResult: number,
): Record<string, unknown> {
  return {
    experimentA_cpuOracle: {
      types: artifact.finalTypes,
      equalityConstraints: artifact.inferred.equalities.length,
      dependencyStrata: artifact.inferred.resolution.strata.map((stratum) =>
        stratum.map((declaration) => declaration.name.text)
      ),
    },
    experimentB_webGpuEquality: artifact.gpuTypeResult ??
      { status: "disabled" },
    experimentC_comptime: {
      cpu: artifact.comptimeCpuValues,
      gpu: artifact.comptimeGpuResult ?? { status: "disabled" },
    },
    experimentD_wasmMacros: artifact.macros,
    experimentE_interactionCalculus: artifact.interactionResults.map((
      result,
    ) => ({
      value: result.value,
      interactions: result.interactions,
      rules: Object.fromEntries(result.rules),
    })),
    experimentF_haskellToWasm: {
      functions: artifact.fcg.functions.map((function_) => ({
        name: function_.name,
        operations: function_.operations.length,
      })),
      constructorTags: Object.fromEntries(artifact.fcg.constructorTags),
      wasmBytes: artifact.wasm.length,
      mainResult,
    },
    timingsMilliseconds: artifact.timings,
  };
}

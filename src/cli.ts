import {
  type CompilationArtifact,
  type CompilationBackends,
  compileModuleSource,
  type CpuWasmEmitter,
  type GpuMode,
  type GpuWasmVerification,
  runMain,
} from "./compiler.ts";
import { solveTypeEqualitiesOnGpu } from "./gpu_solver.ts";

if (import.meta.main) await main(Deno.args);

export type CliInvocation = {
  readonly command: "compile" | "run" | "experiments";
  readonly file: string;
  readonly output: string | undefined;
  readonly gpuMode: GpuMode;
  readonly gpuWasmVerification: GpuWasmVerification;
  readonly cpuWasmEmitter: CpuWasmEmitter;
  readonly hostInterfaceFile: string | undefined;
};

export function parseCommandLine(arguments_: readonly string[]): CliInvocation {
  const [command, file, ...rest] = arguments_;
  if (
    command === undefined || file === undefined ||
    !["compile", "run", "experiments"].includes(command)
  ) {
    throw new Error(
      "usage: cli.ts <compile|run|experiments> <file.hs|file.duck> [output.wasm] [--cpu|--try-gpu|--require-gpu] [--rust-wasm-emitter] [--no-gpu-verification] [--host-interface host.duck]",
    );
  }
  const positional: string[] = [];
  let hostInterfaceFile: string | undefined;
  let index = 0;
  while (index < rest.length) {
    const argument = rest[index];
    if (
      argument === "--cpu" || argument === "--try-gpu" ||
      argument === "--require-gpu" ||
      argument === "--rust-wasm-emitter" ||
      argument === "--no-gpu-verification"
    ) {
      index += 1;
      continue;
    }
    if (argument === "--host-interface") {
      if (hostInterfaceFile !== undefined) {
        throw new Error("--host-interface may be provided only once");
      }
      const path = rest[index + 1];
      if (path === undefined || path.startsWith("--")) {
        throw new Error("--host-interface requires a file path");
      }
      hostInterfaceFile = path;
      index += 2;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}`);
    }
    positional.push(argument);
    index += 1;
  }
  if (rest.includes("--cpu") && rest.includes("--require-gpu")) {
    throw new Error("--cpu and --require-gpu cannot be used together");
  }
  if (
    rest.includes("--try-gpu") &&
    (rest.includes("--cpu") || rest.includes("--require-gpu"))
  ) {
    throw new Error(
      "--try-gpu cannot be combined with --cpu or --require-gpu",
    );
  }
  const maximumPositionals = command === "compile" ? 1 : 0;
  if (positional.length > maximumPositionals) {
    throw new Error(
      `${command} received unexpected argument ${
        positional[maximumPositionals]
      }`,
    );
  }
  if (command === "compile" && positional[0] === file) {
    throw new Error(`compile output must differ from input ${file}`);
  }
  return {
    command: command as CliInvocation["command"],
    file,
    output: positional[0],
    gpuMode: rest.includes("--require-gpu")
      ? "required"
      : rest.includes("--try-gpu")
      ? "optional"
      : "off",
    gpuWasmVerification: rest.includes("--no-gpu-verification")
      ? "none"
      : "differential",
    cpuWasmEmitter: rest.includes("--rust-wasm-emitter")
      ? "rust-wasm"
      : "typescript",
    hostInterfaceFile,
  };
}

async function main(arguments_: readonly string[]): Promise<void> {
  const {
    command,
    file,
    output: outputArgument,
    gpuMode,
    gpuWasmVerification,
    cpuWasmEmitter,
    hostInterfaceFile,
  } = parseCommandLine(arguments_);
  const artifact = await compileCliInput({
    command,
    file,
    output: outputArgument,
    gpuMode,
    gpuWasmVerification,
    cpuWasmEmitter,
    hostInterfaceFile,
  });

  if (command === "compile") {
    const output = outputArgument ?? file.replace(/\.(?:hs|duck)$/, "") +
        ".wasm";
    const inputPath = await Deno.realPath(file);
    const inputFile = await Deno.stat(inputPath);
    let existingOutputPath: string | undefined;
    let existingOutputFile: Deno.FileInfo | undefined;
    try {
      existingOutputPath = await Deno.realPath(output);
      existingOutputFile = await Deno.stat(existingOutputPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const aliasesInput = existingOutputFile !== undefined &&
      inputFile.dev !== null && inputFile.ino !== null &&
      inputFile.dev === existingOutputFile.dev &&
      inputFile.ino === existingOutputFile.ino;
    if (existingOutputPath === inputPath || aliasesInput) {
      throw new Error(`compile output must differ from input ${file}`);
    }
    const lastSeparator = Math.max(
      output.lastIndexOf("/"),
      output.lastIndexOf("\\"),
    );
    const outputDirectory = lastSeparator === -1
      ? "."
      : output.slice(0, lastSeparator) || "/";
    const temporaryOutput = await Deno.makeTempFile({
      dir: outputDirectory,
      prefix: ".gpu-compiler-",
      suffix: ".wasm",
    });
    try {
      await Deno.writeFile(temporaryOutput, artifact.wasm);
      await Deno.rename(temporaryOutput, output);
    } catch (writeError) {
      try {
        await Deno.remove(temporaryOutput);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Deno.errors.NotFound)) {
          throw new AggregateError(
            [writeError, cleanupError],
            `failed to write ${output} and remove temporary output ${temporaryOutput}`,
          );
        }
      }
      throw writeError;
    }
    console.log(`wrote ${artifact.wasm.length} bytes to ${output}`);
    console.log(formatCompilationBackends(artifact.backends));
    printTypes(artifact);
    return;
  }
  if (command === "run") {
    const result = await runMain(artifact.wasm);
    console.log(formatCompilationBackends(artifact.backends));
    printTypes(artifact);
    console.log(`main = ${result}`);
    return;
  }

  const result = await runMain(artifact.wasm);
  console.log(
    JSON.stringify(
      await experimentReport(artifact, result, gpuMode !== "off"),
      null,
      2,
    ),
  );
}

export async function compileCliInput(
  invocation: CliInvocation,
): Promise<CompilationArtifact> {
  const {
    file,
    gpuMode,
    gpuWasmVerification,
    cpuWasmEmitter,
    hostInterfaceFile,
  } = invocation;
  const source = await Deno.readTextFile(file);
  return await compileModuleSource(file, source, {
    gpuMode,
    gpuWasmVerification,
    cpuWasmEmitter,
    hostInterface: hostInterfaceFile,
  });
}

export function formatCompilationBackends(
  backends: CompilationBackends,
): string {
  return `backends: type=${backends.typeCheck} comptime=${backends.comptime} core=${backends.coreRewrite} wasm=${backends.wasmEmission} verification=${backends.wasmVerification}`;
}

function printTypes(artifact: CompilationArtifact): void {
  for (const type of artifact.finalTypes) console.log(type);
}

async function experimentReport(
  artifact: CompilationArtifact,
  mainResult: number | bigint,
  runGpuTypeExperiment: boolean,
): Promise<Record<string, unknown>> {
  const gpuTypeResult = runGpuTypeExperiment
    ? await solveTypeEqualitiesOnGpu(artifact.inferred.equalities)
    : undefined;
  return {
    experimentA_cpuOracle: {
      types: artifact.finalTypes,
      equalityConstraints: artifact.inferred.equalities.length,
      dependencyStrata: artifact.language === "haskell"
        ? artifact.inferred.resolution.strata.map((stratum) =>
          stratum.map((declaration) => declaration.name.text)
        )
        : artifact.inferred.bindings.map((binding) => [
          `${binding.symbol.text}#${binding.symbol.id}`,
        ]),
    },
    experimentB_webGpuEquality: gpuTypeResult ??
      { status: "disabled" },
    experimentC_comptime: {
      cpu: artifact.comptimeCpuValues,
      gpu: { status: "disabled" },
    },
    experimentD_wasmMacros: artifact.macros,
    experimentE_interactionCalculus: artifact.interactionResults.map((
      result,
    ) => ({
      value: result.value,
      interactions: result.interactions,
      rules: Object.fromEntries(result.rules),
    })),
    experimentF_languageToWasm: {
      language: artifact.language,
      functions: artifact.fcg.functions.map((function_) => ({
        name: function_.name,
        operations: function_.operations.length,
      })),
      constructorTags: Object.fromEntries(artifact.fcg.constructorTags),
      wasmBytes: artifact.wasm.length,
      mainResult: typeof mainResult === "bigint"
        ? mainResult.toString()
        : mainResult,
    },
    ...(artifact.language === "ducklang"
      ? { ducklangProfile: artifact.profile }
      : { timingsMilliseconds: artifact.timings }),
  };
}

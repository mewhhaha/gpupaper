import {
  type CompilationTimings,
  compileModuleSource,
} from "../src/compiler.ts";
import {
  clearDucklangParserCache,
  type DucklangParseTimings,
  DucklangSyntaxError,
  parseDucklangModuleWithTimings,
} from "../src/ducklang_parser.ts";

const defaultTargets = [
  {
    source: new URL(
      "../examples/binned/live/case-studies/editor/editor.duck",
      import.meta.url,
    ).pathname,
    hostInterface: new URL(
      "../examples/binned/live/case-studies/editor/host.duck",
      import.meta.url,
    ).pathname,
  },
  {
    source: new URL(
      "../examples/binned/live/case-studies/codex/codex.duck",
      import.meta.url,
    ).pathname,
    hostInterface: new URL(
      "../examples/binned/live/case-studies/codex/host.duck",
      import.meta.url,
    ).pathname,
  },
  {
    source: new URL(
      "../examples/binned/live/case-studies/grep/grep.duck",
      import.meta.url,
    ).pathname,
    hostInterface: new URL(
      "../examples/binned/live/case-studies/grep/host.duck",
      import.meta.url,
    ).pathname,
  },
  {
    source: new URL(
      "../examples/binned/live/case-studies/tar/tar.duck",
      import.meta.url,
    ).pathname,
    hostInterface: new URL(
      "../examples/binned/live/case-studies/tar/host.duck",
      import.meta.url,
    ).pathname,
  },
  {
    source: new URL(
      "../examples/binned/live/case-studies/wav/wav.duck",
      import.meta.url,
    ).pathname,
    hostInterface: undefined,
  },
  {
    source: new URL(
      "../examples/binned/live/case-studies/raytracer/raytracer.duck",
      import.meta.url,
    ).pathname,
    hostInterface: undefined,
  },
] as const;
const warmIterationCount = 5;

const targets = Deno.args.length === 0
  ? defaultTargets
  : Deno.args.map((source) => ({ source, hostInterface: undefined }));

try {
  for (const target of targets) {
    const file = await Deno.realPath(target.source);
    const source = await Deno.readTextFile(file);
    await clearDucklangParserCache();
    const cold = await measureParser(file, source);
    const warmMeasurements: ParserMeasurement[] = [];
    for (let iteration = 0; iteration < warmIterationCount; iteration += 1) {
      warmMeasurements.push(await measureParser(file, source));
    }
    const warmTimings = warmMeasurements.map((measurement) =>
      measurement.timings
    );

    await clearDucklangParserCache();
    const hostInterface = target.hostInterface === undefined
      ? undefined
      : await Deno.realPath(target.hostInterface);
    const cpuCompilation = await measureCompilationMode(
      file,
      source,
      hostInterface,
      "off",
    );
    const gpuCompilation = await measureCompilationMode(
      file,
      source,
      hostInterface,
      "required",
    );

    console.log(JSON.stringify({
      file,
      sourceBytes: new TextEncoder().encode(source).length,
      parser: {
        coldStatus: cold.status,
        ...(cold.status === "error" ? { coldError: cold.error } : {}),
        coldTotalMilliseconds: cold.totalMilliseconds,
        coldTimingsMilliseconds: cold.timings,
        warmIterationCount,
        warmMedianTotalMilliseconds: median(
          warmMeasurements.map((measurement) => measurement.totalMilliseconds),
        ),
        warmMedianTimingsMilliseconds: {
          parserInitializationMilliseconds: median(
            warmTimings.map((timings) =>
              timings.parserInitializationMilliseconds
            ),
          ),
          syntaxMilliseconds: median(
            warmTimings.map((timings) => timings.syntaxMilliseconds),
          ),
          astLoweringMilliseconds: median(
            warmTimings.map((timings) => timings.astLoweringMilliseconds),
          ),
        },
      },
      compilation: {
        cpu: cpuCompilation,
        gpu: gpuCompilation,
      },
    }));
  }
} finally {
  await clearDucklangParserCache();
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("cannot calculate the median of an empty sample");
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

type ParserMeasurement = {
  readonly status: "completed" | "error";
  readonly totalMilliseconds: number;
  readonly timings: DucklangParseTimings;
  readonly error?: string;
};

type CompletedCompilationMeasurement = {
  readonly status: "completed";
  readonly totalMilliseconds: number;
  readonly timingsMilliseconds: CompilationTimings;
  readonly wasmBytes: number;
};

type CompilationMeasurement =
  | CompletedCompilationMeasurement
  | {
    readonly status: "error";
    readonly totalMilliseconds: number;
    readonly error: string;
  };

async function measureParser(
  file: string,
  source: string,
): Promise<ParserMeasurement> {
  const start = performance.now();
  try {
    const parsed = await parseDucklangModuleWithTimings(file, source);
    return {
      status: "completed",
      totalMilliseconds: performance.now() - start,
      timings: parsed.timings,
    };
  } catch (error) {
    if (!(error instanceof DucklangSyntaxError)) throw error;
    return {
      status: "error",
      totalMilliseconds: performance.now() - start,
      timings: error.timings,
      error: error.message,
    };
  }
}

async function measureCompilation(
  file: string,
  source: string,
  hostInterface: string | undefined,
  gpuMode: "off" | "required",
): Promise<CompilationMeasurement> {
  const start = performance.now();
  try {
    const artifact = await compileModuleSource(file, source, {
      gpuMode,
      ...(hostInterface === undefined ? {} : { hostInterface }),
    });
    return {
      status: "completed",
      totalMilliseconds: performance.now() - start,
      timingsMilliseconds: artifact.timings,
      wasmBytes: artifact.wasm.length,
    };
  } catch (error) {
    return {
      status: "error",
      totalMilliseconds: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function measureCompilationMode(
  file: string,
  source: string,
  hostInterface: string | undefined,
  gpuMode: "off" | "required",
): Promise<{
  readonly first: CompilationMeasurement;
  readonly warmIterationCount: number;
  readonly warmMedianTotalMilliseconds: number;
  readonly warmMedianTimingsMilliseconds?: CompilationTimings;
  readonly warmErrors?: readonly string[];
}> {
  await clearDucklangParserCache();
  const first = await measureCompilation(file, source, hostInterface, gpuMode);
  const warm: CompilationMeasurement[] = [];
  for (let iteration = 0; iteration < warmIterationCount; iteration += 1) {
    warm.push(
      await measureCompilation(file, source, hostInterface, gpuMode),
    );
  }
  const completed = warm.filter(
    (
      measurement,
    ): measurement is CompletedCompilationMeasurement =>
      measurement.status === "completed",
  );
  return {
    first,
    warmIterationCount,
    warmMedianTotalMilliseconds: median(
      warm.map((measurement) => measurement.totalMilliseconds),
    ),
    ...(completed.length === warm.length
      ? {
        warmMedianTimingsMilliseconds: medianCompilationTimings(
          completed.map((measurement) => measurement.timingsMilliseconds),
        ),
      }
      : {
        warmErrors: warm.flatMap((measurement) =>
          measurement.status === "error" ? [measurement.error] : []
        ),
      }),
  };
}

function medianCompilationTimings(
  samples: readonly CompilationTimings[],
): CompilationTimings {
  const keys = Object.keys(samples[0]) as (keyof CompilationTimings)[];
  return Object.fromEntries(
    keys.map((key) => [key, median(samples.map((sample) => sample[key]))]),
  ) as CompilationTimings;
}

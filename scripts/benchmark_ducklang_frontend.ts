import {
  compileModuleSource,
  type DucklangCompilationProfile,
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
const warmIterationCount = 6;

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
    const warmMedianTotalMilliseconds = median(
      warmMeasurements.map((measurement) => measurement.totalMilliseconds),
    );
    const warmRepresentative = [...warmMeasurements].sort((left, right) => {
      const leftDistance = Math.abs(
        left.totalMilliseconds - warmMedianTotalMilliseconds,
      );
      const rightDistance = Math.abs(
        right.totalMilliseconds - warmMedianTotalMilliseconds,
      );
      return leftDistance - rightDistance ||
        left.totalMilliseconds - right.totalMilliseconds;
    })[0];

    await clearDucklangParserCache();
    const hostInterface = target.hostInterface === undefined
      ? undefined
      : await Deno.realPath(target.hostInterface);
    const compilations = await measureCompilationModes(
      file,
      source,
      hostInterface,
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
        warmMedianTotalMilliseconds,
        warmRepresentativeTotalMilliseconds:
          warmRepresentative.totalMilliseconds,
        warmRepresentativeTimingsMilliseconds: warmRepresentative.timings,
      },
      compilation: {
        pairOrder: "alternatingCpuFirst",
        pairCount: warmIterationCount / 2,
        ...(compilations.pairedGpuMinusCpu === undefined
          ? {}
          : { pairedGpuMinusCpu: compilations.pairedGpuMinusCpu }),
        cpu: compilations.cpu,
        gpu: compilations.gpu,
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
  readonly profile: DucklangCompilationProfile;
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
    if (artifact.language !== "ducklang") {
      throw new Error(`Ducklang benchmark compiled ${artifact.language}`);
    }
    return {
      status: "completed",
      totalMilliseconds: performance.now() - start,
      profile: artifact.profile,
    };
  } catch (error) {
    return {
      status: "error",
      totalMilliseconds: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type CompilationModeReport = {
  readonly first: CompilationMeasurement;
  readonly warmIterationCount: number;
  readonly warmTotalMilliseconds: readonly number[];
  readonly warmMedianTotalMilliseconds: number;
  readonly warmRepresentativeProfile?: DucklangCompilationProfile;
  readonly warmHotStages?: readonly {
    readonly stage: keyof DucklangCompilationProfile["stages"];
    readonly milliseconds: number;
    readonly percentageOfTotal: number;
  }[];
  readonly warmErrors?: readonly string[];
};

async function measureCompilationModes(
  file: string,
  source: string,
  hostInterface: string | undefined,
): Promise<{
  readonly cpu: CompilationModeReport;
  readonly gpu: CompilationModeReport;
  readonly pairedGpuMinusCpu?: {
    readonly milliseconds: readonly number[];
    readonly medianMilliseconds: number;
    readonly medianAbsoluteDeviationMilliseconds: number;
  };
}> {
  await clearDucklangParserCache();
  const cpuFirst = await measureCompilation(file, source, hostInterface, "off");
  await clearDucklangParserCache();
  const gpuFirst = await measureCompilation(
    file,
    source,
    hostInterface,
    "required",
  );
  const cpuWarm: CompilationMeasurement[] = [];
  const gpuWarm: CompilationMeasurement[] = [];
  for (let iteration = 0; iteration < warmIterationCount; iteration += 1) {
    if (iteration % 2 === 0) {
      cpuWarm.push(
        await measureCompilation(file, source, hostInterface, "off"),
      );
      gpuWarm.push(
        await measureCompilation(file, source, hostInterface, "required"),
      );
    } else {
      gpuWarm.push(
        await measureCompilation(file, source, hostInterface, "required"),
      );
      cpuWarm.push(
        await measureCompilation(file, source, hostInterface, "off"),
      );
    }
  }
  const completedPairs = cpuWarm.flatMap((cpu, index) => {
    const gpu = gpuWarm[index];
    return cpu.status === "completed" && gpu?.status === "completed"
      ? [gpu.totalMilliseconds - cpu.totalMilliseconds]
      : [];
  });
  const pairedMedian = completedPairs.length === warmIterationCount
    ? median(completedPairs)
    : undefined;
  return {
    cpu: summarizeCompilationMode(cpuFirst, cpuWarm),
    gpu: summarizeCompilationMode(gpuFirst, gpuWarm),
    ...(pairedMedian === undefined ? {} : {
      pairedGpuMinusCpu: {
        milliseconds: completedPairs,
        medianMilliseconds: pairedMedian,
        medianAbsoluteDeviationMilliseconds: median(
          completedPairs.map((difference) =>
            Math.abs(difference - pairedMedian)
          ),
        ),
      },
    }),
  };
}

function summarizeCompilationMode(
  first: CompilationMeasurement,
  warm: readonly CompilationMeasurement[],
): CompilationModeReport {
  const completed = warm.filter(
    (
      measurement,
    ): measurement is CompletedCompilationMeasurement =>
      measurement.status === "completed",
  );
  return {
    first,
    warmIterationCount,
    warmTotalMilliseconds: warm.map((measurement) =>
      measurement.totalMilliseconds
    ),
    warmMedianTotalMilliseconds: median(
      warm.map((measurement) => measurement.totalMilliseconds),
    ),
    ...(completed.length === warm.length
      ? {
        warmRepresentativeProfile: representativeCompilationProfile(
          completed.map((measurement) => measurement.profile),
        ),
        warmHotStages: hotStages(
          completed.map((measurement) => measurement.profile),
        ),
      }
      : {
        warmErrors: warm.flatMap((measurement) =>
          measurement.status === "error" ? [measurement.error] : []
        ),
      }),
  };
}

function representativeCompilationProfile(
  samples: readonly DucklangCompilationProfile[],
): DucklangCompilationProfile {
  const medianTotal = median(samples.map((sample) => sample.totalMilliseconds));
  return [...samples].sort((left, right) => {
    const leftDistance = Math.abs(left.totalMilliseconds - medianTotal);
    const rightDistance = Math.abs(right.totalMilliseconds - medianTotal);
    return leftDistance - rightDistance ||
      left.totalMilliseconds - right.totalMilliseconds;
  })[0];
}

function hotStages(
  samples: readonly DucklangCompilationProfile[],
): readonly {
  readonly stage: keyof DucklangCompilationProfile["stages"];
  readonly milliseconds: number;
  readonly percentageOfTotal: number;
}[] {
  const profile = representativeCompilationProfile(samples);
  return Object.entries(profile.stages)
    .map(([stage, milliseconds]) => ({
      stage: stage as keyof DucklangCompilationProfile["stages"],
      milliseconds,
      percentageOfTotal: profile.totalMilliseconds === 0
        ? 0
        : milliseconds / profile.totalMilliseconds * 100,
    }))
    .sort((left, right) => right.milliseconds - left.milliseconds)
    .slice(0, 8);
}

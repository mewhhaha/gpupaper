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
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
  runtimeIdentity,
  sha256,
} from "./benchmark_environment.ts";
import {
  median,
  representativeSample,
  summarizePairedSamples,
  summarizeSamples,
} from "./benchmark_statistics.ts";

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

const requestedTargets = Deno.args.filter((argument) =>
  !argument.startsWith("--")
);
const targets = requestedTargets.length === 0
  ? defaultTargets
  : requestedTargets.map((source) => ({ source, hostInterface: undefined }));
const allowContended = Deno.args.includes("--allow-contended");
const environmentAtStart = await inspectBenchmarkEnvironment();
if (environmentAtStart.status !== "clear" && !allowContended) {
  console.log(JSON.stringify({
    status: "refused",
    reason: "competing compiler or GPU work is active or inspection failed",
    environment: environmentAtStart,
  }));
  Deno.exit(2);
}
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) throw new Error("frontend benchmark has no GPU adapter");
const results = [];

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

    results.push({
      file,
      sourceBytes: new TextEncoder().encode(source).length,
      sourceSha256: await sha256(new TextEncoder().encode(source)),
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
        gpuWasmVerification: "none",
        ...(compilations.pairedGpuMinusCpu === undefined
          ? {}
          : { pairedGpuMinusCpu: compilations.pairedGpuMinusCpu }),
        cpu: compilations.cpu,
        gpu: compilations.gpu,
      },
    });
  }
} finally {
  await clearDucklangParserCache();
}
const environmentAtEnd = await inspectBenchmarkEnvironment();
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";
console.log(JSON.stringify({
  status: environmentClear || allowContended ? "completed" : "refused",
  validity: environmentClear ? { status: "admissible" } : allowContended
    ? {
      status: "diagnostic",
      reason: "competing compiler or GPU work was present during measurement",
    }
    : {
      status: "refused",
      reason: "competing compiler or GPU work appeared during measurement",
    },
  schemaVersion: 2,
  runtime: runtimeIdentity(),
  repositories: {
    gpupaper: await repositoryIdentity(
      new URL("../", import.meta.url).pathname,
    ),
  },
  adapter: {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  },
  environmentAtStart,
  environmentAtEnd,
  results,
}));
if (!environmentClear && !allowContended) Deno.exit(2);

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
  readonly wasmSha256: string;
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
      gpuWasmVerification: "none",
      ...(hostInterface === undefined ? {} : { hostInterface }),
    });
    if (artifact.language !== "ducklang") {
      throw new Error(`Ducklang benchmark compiled ${artifact.language}`);
    }
    return {
      status: "completed",
      totalMilliseconds: performance.now() - start,
      profile: artifact.profile,
      wasmSha256: await sha256(artifact.wasm),
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
  readonly warmTiming: ReturnType<typeof summarizeSamples>;
  readonly warmProfiles?: readonly DucklangCompilationProfile[];
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
    readonly differences: readonly number[];
    readonly logRatios: readonly number[];
    readonly difference: ReturnType<typeof summarizeSamples>;
    readonly logRatio: ReturnType<typeof summarizeSamples>;
    readonly medianRatio: number;
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
  const completedCpu: number[] = [];
  const completedGpu: number[] = [];
  cpuWarm.forEach((cpu, index) => {
    const gpu = gpuWarm[index];
    if (cpu.status !== "completed" || gpu?.status !== "completed") return;
    if (cpu.wasmSha256 !== gpu.wasmSha256) {
      throw new Error(
        `${file} CPU/GPU pair ${index} emitted ${cpu.wasmSha256} and ${gpu.wasmSha256}`,
      );
    }
    completedCpu.push(cpu.totalMilliseconds);
    completedGpu.push(gpu.totalMilliseconds);
  });
  const paired = completedCpu.length === warmIterationCount
    ? summarizePairedSamples(completedGpu, completedCpu)
    : undefined;
  return {
    cpu: summarizeCompilationMode(cpuFirst, cpuWarm),
    gpu: summarizeCompilationMode(gpuFirst, gpuWarm),
    ...(paired === undefined ? {} : { pairedGpuMinusCpu: paired }),
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
    warmTiming: summarizeSamples(
      warm.map((measurement) => measurement.totalMilliseconds),
    ),
    ...(completed.length === warm.length
      ? {
        warmProfiles: completed.map((measurement) => measurement.profile),
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
  return representativeSample(samples, (sample) => sample.totalMilliseconds);
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

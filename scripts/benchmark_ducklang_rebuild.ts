import {
  compileModuleSource,
  createDucklangCompilationSession,
  type DucklangCompilationProfile,
  type DucklangCompilationSession,
} from "../src/compiler.ts";
import { clearDucklangParserCache } from "../src/ducklang_parser.ts";
import {
  representativeSample,
  type SampleSummary,
  summarizeSamples,
} from "./benchmark_statistics.ts";
import {
  inspectBenchmarkEnvironment,
  repositoryIdentity,
  runtimeIdentity,
  sha256,
} from "./benchmark_environment.ts";

const caseStudyDirectory = new URL(
  "../examples/binned/live/case-studies/",
  import.meta.url,
);
const targets = [
  target("editor", "editor/host.duck"),
  target("codex", "codex/host.duck"),
  target("grep", "grep/host.duck"),
] as const;
const sampleCount = requestedSampleCount(Deno.args);
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
if (adapter === null) {
  throw new Error("rebuild benchmark has no WebGPU adapter");
}
console.log(JSON.stringify({
  recordType: "benchmarkStart",
  schemaVersion: 1,
  benchmark: "ducklang-rebuild",
  sampleCount,
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
}));

for (const target_ of targets) {
  const source = await Deno.readTextFile(target_.source);
  const commentOnlySource = `${source}\n// benchmark comment-only edit\n`;
  const firstLineEnd = source.indexOf("\n");
  const internalCommentSource = firstLineEnd < 0
    ? `// benchmark internal comment\n${source}`
    : `${source.slice(0, firstLineEnd + 1)}// benchmark internal comment\n${
      source.slice(firstLineEnd + 1)
    }`;
  for (const backend of ["cpu", "gpu"] as const) {
    const session = createDucklangCompilationSession();
    await clearDucklangParserCache();
    const cold = await compile(target_, source, backend, session);
    const identical = await compileSamples(target_, source, backend, session);
    const commentOnly = await compileEditSamples(
      target_,
      source,
      commentOnlySource,
      backend,
      session,
    );
    const internalComment = await compileEditSamples(
      target_,
      source,
      internalCommentSource,
      backend,
      session,
    );
    console.log(JSON.stringify({
      target: target_.name,
      backend,
      sampleCount,
      inputSha256: await sha256(new TextEncoder().encode(source)),
      outputSha256: await sha256(identical.wasm),
      cold: report(cold),
      identicalRebuild: report(identical),
      trailingCommentRebuild: report(commentOnly),
      internalCommentRebuild: report(internalComment),
      commentOnlyStageDeltas: largestStageDeltas(
        identical.profile,
        commentOnly.profile,
      ),
      identicalWasm: equalBytes(identical.wasm, commentOnly.wasm),
      internalCommentWasm: equalBytes(identical.wasm, internalComment.wasm),
    }));
  }
}

await benchmarkSemanticEdit();
await benchmarkDependencyEdit();
await clearDucklangParserCache();
const environmentAtEnd = await inspectBenchmarkEnvironment();
const environmentClear = environmentAtStart.status === "clear" &&
  environmentAtEnd.status === "clear";
console.log(JSON.stringify({
  recordType: "benchmarkEnd",
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
  environmentAtEnd,
}));
if (!environmentClear && !allowContended) Deno.exit(2);

function target(name: string, hostInterface: string) {
  return {
    name,
    source: new URL(`${name}/${name}.duck`, caseStudyDirectory).pathname,
    hostInterface: new URL(hostInterface, caseStudyDirectory).pathname,
  };
}

type Target = ReturnType<typeof target>;
type Measurement = {
  readonly profile: DucklangCompilationProfile;
  readonly total: SampleSummary;
  readonly rawProfiles: readonly DucklangCompilationProfile[];
  readonly wasm: Uint8Array;
};

function report(measurement: Measurement): {
  readonly profile: DucklangCompilationProfile;
  readonly total: SampleSummary;
  readonly rawProfiles: readonly DucklangCompilationProfile[];
  readonly wasmBytes: number;
} {
  return {
    profile: measurement.profile,
    total: measurement.total,
    rawProfiles: measurement.rawProfiles,
    wasmBytes: measurement.wasm.byteLength,
  };
}

async function compileSamples(
  target_: Target,
  source: string,
  backend: "cpu" | "gpu",
  session: DucklangCompilationSession,
): Promise<Measurement> {
  const profiles: DucklangCompilationProfile[] = [];
  let wasm: Uint8Array | undefined;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const measurement = await compile(target_, source, backend, session);
    profiles.push(measurement.profile);
    if (wasm === undefined) {
      wasm = measurement.wasm;
      continue;
    }
    if (!equalBytes(wasm, measurement.wasm)) {
      throw new Error(
        `${target_.name} ${backend} rebuild emitted unstable Wasm`,
      );
    }
  }
  if (wasm === undefined) {
    throw new Error(
      `${target_.name} ${backend} rebuild has no samples`,
    );
  }
  return {
    profile: representativeSample(
      profiles,
      (profile) => profile.totalMilliseconds,
    ),
    total: summarizeSamples(
      profiles.map((profile) => profile.totalMilliseconds),
    ),
    rawProfiles: profiles,
    wasm,
  };
}

async function compileEditSamples(
  target_: Target,
  baselineSource: string,
  editedSource: string,
  backend: "cpu" | "gpu",
  session: DucklangCompilationSession,
): Promise<Measurement> {
  const profiles: DucklangCompilationProfile[] = [];
  let wasm: Uint8Array | undefined;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    await compile(target_, baselineSource, backend, session);
    const measurement = await compile(
      target_,
      editedSource,
      backend,
      session,
    );
    profiles.push(measurement.profile);
    if (wasm === undefined) {
      wasm = measurement.wasm;
      continue;
    }
    if (!equalBytes(wasm, measurement.wasm)) {
      throw new Error(
        `${target_.name} ${backend} edited rebuild emitted unstable Wasm`,
      );
    }
  }
  if (wasm === undefined) {
    throw new Error(`${target_.name} ${backend} edited rebuild has no samples`);
  }
  return {
    profile: representativeSample(
      profiles,
      (profile) => profile.totalMilliseconds,
    ),
    total: summarizeSamples(
      profiles.map((profile) => profile.totalMilliseconds),
    ),
    rawProfiles: profiles,
    wasm,
  };
}

async function compile(
  target_: Target,
  source: string,
  backend: "cpu" | "gpu",
  session: DucklangCompilationSession,
): Promise<Measurement> {
  const artifact = await compileModuleSource(target_.source, source, {
    gpuMode: backend === "cpu" ? "off" : "required",
    gpuWasmVerification: backend === "cpu" ? "differential" : "none",
    hostInterface: target_.hostInterface,
    session,
  });
  if (artifact.language !== "ducklang") {
    throw new Error(`${target_.name} compiled as ${artifact.language}`);
  }
  return {
    profile: artifact.profile,
    total: summarizeSamples([artifact.profile.totalMilliseconds]),
    rawProfiles: [artifact.profile],
    wasm: artifact.wasm,
  };
}

async function benchmarkSemanticEdit(): Promise<void> {
  const file = "benchmark_semantic_edit.duck";
  const baseline = `let first = () => 40
let second = () => 2
first() + second()
`;
  const edited = baseline.replace("40", "41");
  const profiles: DucklangCompilationProfile[] = [];
  let changedWasm = false;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const session = createDucklangCompilationSession();
    const before = await compileWithoutHost(file, baseline, session);
    const after = await compileWithoutHost(file, edited, session);
    profiles.push(after.profile);
    changedWasm ||= !equalBytes(before.wasm, after.wasm);
  }
  console.log(JSON.stringify({
    target: "synthetic-function-edit",
    backend: "cpu",
    sampleCount,
    rebuild: sampledProfileReport(profiles),
    changedWasm,
  }));
}

async function benchmarkDependencyEdit(): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "gpupaper-rebuild-" });
  const root = `${directory}/root.duck`;
  const dependency = `${directory}/dependency.duck`;
  const rootSource = `const dependency = import "./dependency.duck"
const { value } = dependency()
value
`;
  const baselineDependency = `module () where
let value = 41
return { value }
`;
  const editedDependency = baselineDependency.replace("41", "42");
  const session = createDucklangCompilationSession();
  const profiles: DucklangCompilationProfile[] = [];
  try {
    await Deno.writeTextFile(root, rootSource);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      await Deno.writeTextFile(dependency, baselineDependency);
      await compileWithoutHost(root, rootSource, session);
      await Deno.writeTextFile(dependency, editedDependency);
      profiles.push(
        (await compileWithoutHost(root, rootSource, session)).profile,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
  console.log(JSON.stringify({
    target: "synthetic-dependency-edit",
    backend: "cpu",
    sampleCount,
    rebuild: sampledProfileReport(profiles),
  }));
}

async function compileWithoutHost(
  file: string,
  source: string,
  session: DucklangCompilationSession,
): Promise<Measurement> {
  const artifact = await compileModuleSource(file, source, {
    gpuMode: "off",
    session,
  });
  if (artifact.language !== "ducklang") {
    throw new Error(`${file} compiled as ${artifact.language}`);
  }
  return {
    profile: artifact.profile,
    total: summarizeSamples([artifact.profile.totalMilliseconds]),
    rawProfiles: [artifact.profile],
    wasm: artifact.wasm,
  };
}

function sampledProfileReport(
  profiles: readonly DucklangCompilationProfile[],
): {
  readonly representative: DucklangCompilationProfile;
  readonly total: SampleSummary;
  readonly rawProfiles: readonly DucklangCompilationProfile[];
} {
  return {
    representative: representativeSample(
      profiles,
      (profile) => profile.totalMilliseconds,
    ),
    total: summarizeSamples(
      profiles.map((profile) => profile.totalMilliseconds),
    ),
    rawProfiles: profiles,
  };
}

function largestStageDeltas(
  baseline: DucklangCompilationProfile,
  edited: DucklangCompilationProfile,
): readonly {
  readonly stage: keyof DucklangCompilationProfile["stages"];
  readonly baselineMilliseconds: number;
  readonly editedMilliseconds: number;
  readonly deltaMilliseconds: number;
}[] {
  return Object.keys(baseline.stages)
    .map((stage_) => {
      const stage = stage_ as keyof DucklangCompilationProfile["stages"];
      const baselineMilliseconds = baseline.stages[stage];
      const editedMilliseconds = edited.stages[stage];
      return {
        stage,
        baselineMilliseconds,
        editedMilliseconds,
        deltaMilliseconds: editedMilliseconds - baselineMilliseconds,
      };
    })
    .sort((left, right) =>
      Math.abs(right.deltaMilliseconds) - Math.abs(left.deltaMilliseconds)
    )
    .slice(0, 8);
}

function requestedSampleCount(arguments_: readonly string[]): number {
  const sampleArgument = arguments_.find((argument) =>
    argument.startsWith("--samples=")
  );
  if (sampleArgument === undefined) return 15;
  const count = Number.parseInt(sampleArgument.slice("--samples=".length), 10);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new TypeError(
      `--samples must be a positive integer; received ${sampleArgument}`,
    );
  }
  return count;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

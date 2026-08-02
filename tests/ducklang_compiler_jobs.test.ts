import { compileModuleSource } from "../src/compiler.ts";
import {
  constructDucklangCompilerJobs,
  validateDucklangCompilerJobs,
} from "../src/ducklang_compiler_jobs.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("compiler jobs preserve source ordinals and shadowed symbol relocations", async () => {
  const jobs = constructDucklangCompilerJobs(
    inferDucklangModule(
      resolveDucklangModule(
        await parseDucklangModule(
          "shadowing.duck",
          "let value = 1\nlet value = value + 1\nvalue\n",
        ),
      ),
    ),
  );

  assertEquals([...jobs.package.jobSourceOrdinals], [0, 1, 2]);
  assertEquals([...jobs.package.relocationStarts], [0, 0, 1]);
  assertEquals([...jobs.package.relocationCounts], [0, 1, 1]);
  assertEquals([...jobs.package.relocationTargetJobIds], [0, 1]);
  assertEquals(jobs.metrics.semanticDependencyCount, 0);
});

Deno.test("mutual recursion is a relocation cycle but not a semantic scheduling cycle", async () => {
  const artifact = await compileModuleSource(
    "mutual.duck",
    `let rec even = value => {
  if value == 0 { 1 } else { odd(value - 1) }
}
and odd = value => {
  if value == 0 { 0 } else { even(value - 1) }
}
even(4) + 41
`,
    { gpuMode: "off" },
  );

  assertEquals([...artifact.compilerJobs.relocationTargetJobIds], [1, 0, 0]);
  assertEquals([...artifact.compilerJobs.relocationComponentIds], [0, 0, 1]);
  assertEquals(artifact.profile.work.compilerJobRelocationCyclicJobCount, 2);
  assertEquals(artifact.profile.work.compilerJobSemanticDependencyCount, 0);
  assertEquals(
    artifact.profile.work.compilerJobSemanticMaximumFrontierJobCount,
    3,
  );
  if (artifact.profile.stages.compilerJobAnalysisMilliseconds < 0) {
    throw new Error(
      `compiler-job analysis reported ${artifact.profile.stages.compilerJobAnalysisMilliseconds}ms`,
    );
  }
});

Deno.test("compiler job construction is deterministic across every column", async () => {
  const module = inferDucklangModule(
    resolveDucklangModule(
      await parseDucklangModule(
        "deterministic.duck",
        "let add = (left, right) => left + right\nadd(20, 22)\n",
      ),
    ),
  );

  assertEquals(
    columns(constructDucklangCompilerJobs(module).package),
    columns(constructDucklangCompilerJobs(module).package),
  );
});

Deno.test("compiler job validation rejects completion-ordered source ordinals", async () => {
  const jobs = constructDucklangCompilerJobs(
    inferDucklangModule(
      resolveDucklangModule(
        await parseDucklangModule(
          "invalid_order.duck",
          "let first = 20\nlet second = 22\nfirst + second\n",
        ),
      ),
    ),
  ).package;
  const sourceOrdinals = jobs.jobSourceOrdinals.slice();
  sourceOrdinals[0] = 1;
  sourceOrdinals[1] = 0;

  assertThrows(
    () =>
      validateDucklangCompilerJobs({
        ...jobs,
        jobSourceOrdinals: sourceOrdinals,
      }),
    /job 0 has source ordinal 1; expected 0/,
  );
});

Deno.test("compiler job validation rejects falsified relocation SCCs", async () => {
  const artifact = await compileModuleSource(
    "recursive.duck",
    `let countdown = rec value => {
  if value == 0 { 42 } else { countdown(value - 1) }
}
countdown(3)
`,
    { gpuMode: "off" },
  );
  const componentIds = artifact.compilerJobs.relocationComponentIds.slice();
  componentIds[0] += 1;

  assertThrows(
    () =>
      validateDucklangCompilerJobs({
        ...artifact.compilerJobs,
        relocationComponentIds: componentIds,
      }),
    /component IDs disagree with relocation graph/,
  );
});

Deno.test("post-specialization compiler jobs reject unresolved semantic dependencies", async () => {
  const jobs = constructDucklangCompilerJobs(
    inferDucklangModule(
      resolveDucklangModule(
        await parseDucklangModule(
          "unfrozen.duck",
          "let first = 20\nlet second = 22\nfirst + second\n",
        ),
      ),
    ),
  ).package;
  const dependencyStarts = new Uint32Array(jobs.jobSourceOrdinals.length);
  dependencyStarts.fill(1, 1);
  const dependencyCounts = new Uint32Array(jobs.jobSourceOrdinals.length);
  dependencyCounts[0] = 1;

  assertThrows(
    () =>
      validateDucklangCompilerJobs({
        ...jobs,
        semanticDependencyStarts: dependencyStarts,
        semanticDependencyCounts: dependencyCounts,
        semanticDependencyJobIds: Uint32Array.of(1),
      }),
    /frozen interfaces but received 1 semantic dependencies/,
  );
});

function columns(package_: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(package_)
      .filter((entry): entry is [string, Uint32Array] =>
        entry[1] instanceof Uint32Array
      )
      .map(([name, values]) => [name, [...values]])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  throw new Error(
    `expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`,
  );
}

function assertThrows(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected action to throw ${pattern}`);
}

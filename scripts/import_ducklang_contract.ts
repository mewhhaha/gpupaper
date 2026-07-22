type SourceRun = {
  readonly name?: string;
  readonly expected: number | bigint;
  readonly init?: () => unknown;
};

type SourceSuccess = {
  readonly path: string;
  readonly route: "ic" | "core" | "managed";
  readonly runs: readonly SourceRun[];
};

type SourceCompileFailure = {
  readonly path: string;
  readonly route: "ic" | "core" | "managed";
  readonly message: string;
};

type SourceTrap = {
  readonly path: string;
  readonly route: "core" | "managed";
  readonly init?: () => unknown;
};

type SourceManifest = {
  readonly success_examples: readonly SourceSuccess[];
  readonly compile_failure_examples: readonly SourceCompileFailure[];
  readonly trap_examples: readonly SourceTrap[];
  readonly test_example_paths: readonly string[];
  readonly dependency_paths: readonly string[];
};

const [sourcePath, destinationPath] = Deno.args;
if (sourcePath === undefined || destinationPath === undefined) {
  throw new Error(
    "usage: deno run --allow-read --allow-write scripts/import_ducklang_contract.ts SOURCE_MANIFEST DESTINATION",
  );
}

const sourceUrl = new URL(sourcePath, `file://${Deno.cwd()}/`);
const manifest = await import(sourceUrl.href) as SourceManifest;
const contract = {
  version: 1,
  success: manifest.success_examples.map((example) => ({
    path: example.path,
    route: example.route,
    runs: example.runs.map((run) => ({
      ...(run.name === undefined ? {} : { name: run.name }),
      expected: expectedValue(run.expected),
      ...(run.init === undefined ? {} : { inputs: snapshotValue(run.init()) }),
    })),
  })),
  compileFailures: manifest.compile_failure_examples,
  traps: manifest.trap_examples.map((example) => ({
    path: example.path,
    route: example.route,
    ...(example.init === undefined
      ? {}
      : { inputs: snapshotValue(example.init()) }),
  })),
  sourceTests: manifest.test_example_paths,
  dependencies: manifest.dependency_paths,
};

await Deno.writeTextFile(
  destinationPath,
  JSON.stringify(contract, null, 2) + "\n",
);

function expectedValue(value: number | bigint): {
  readonly type: "i32" | "i64";
  readonly value: number | string;
} {
  return typeof value === "bigint"
    ? { type: "i64", value: value.toString() }
    : { type: "i32", value };
}

function snapshotValue(value: unknown): unknown {
  if (typeof value === "function") return snapshotValue(value());
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map((
      [name, member],
    ) => [name, snapshotValue(member)]),
  );
}

import { assert_equals, assert_includes } from "../src/assert.ts";
import {
  DuckHost,
  DuckRunner,
  type DuckValue,
  run_duck_tests,
  Source,
} from "../src/frontend.ts";
import {
  compile_failure_examples,
  dependency_paths,
  success_examples,
  type SuccessExample,
  test_example_paths,
  trap_examples,
} from "./manifest.ts";
import { corpus_feature_examples } from "./corpus_coverage.ts";

const decoder = new TextDecoder();

for (const example of success_examples) {
  Deno.test("example runs: " + example.path, async () => {
    if (example.route === "managed") {
      await run_managed_example(example);
      return;
    }

    const wat = compile_example(example);

    for (const example_run of example.runs) {
      const imports = example_run.imports;
      let import_object: WebAssembly.Imports = {};

      if (imports !== undefined) {
        import_object = imports();
      }

      const actual = await run_wat(wat, import_object);
      assert_equals(actual, example_run.expected);
    }
  });
}

for (const example of compile_failure_examples) {
  Deno.test("example rejects: " + example.path, () => {
    let message = "";

    try {
      if (example.route === "ic") {
        Source.ic_wat(Source.load_fragment_file(example.path));
      } else {
        Source.wat(Source.load_fragment_file(example.path));
      }
    } catch (error) {
      message = error_message(error);
    }

    if (message.length === 0) {
      throw new Error("Expected compilation to fail: " + example.path);
    }

    assert_includes(message, example.message);
  });
}

for (const example of trap_examples) {
  Deno.test("example traps: " + example.path, async () => {
    let trapped = false;

    try {
      if (example.route === "managed") {
        await run_managed_trap(example);
      } else {
        const wat = Source.wat(Source.load_fragment_file(example.path));
        let imports: WebAssembly.Imports = {};

        if (example.imports !== undefined) {
          imports = example.imports();
        }

        await run_wat(wat, imports);
      }
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        trapped = true;
      } else {
        throw error;
      }
    }

    assert_equals(trapped, true);
  });
}

for (const path of test_example_paths) {
  Deno.test("source tests pass: " + path, async () => {
    const artifact = Source.artifact_file(path, {
      import_meta: { mode: { atom: "test" } },
    });
    const wasm = await wasm_from_wat(artifact.wat);
    const results = await run_duck_tests(wasm, artifact.abi);

    assert_equals(results, [
      { name: "addition_returns_the_sum", status: "passed" },
      { name: "unequal_values_are_detected", status: "passed" },
    ]);
  });
}

Deno.test("example manifest accounts for every .duck file", () => {
  const expected = new Set<string>();

  for (const example of success_examples) {
    expected.add(example.path);
  }

  for (const example of compile_failure_examples) {
    expected.add(example.path);
  }

  for (const example of trap_examples) {
    expected.add(example.path);
  }

  for (const path of dependency_paths) {
    expected.add(path);
  }

  for (const path of test_example_paths) {
    expected.add(path);
  }

  const actual = new Set(collect_duck_files("examples"));
  assert_equals([...actual].sort(), [...expected].sort());
  assert_equals(success_examples.length, 94);
  assert_equals(compile_failure_examples.length, 13);
  assert_equals(trap_examples.length, 4);
  assert_equals(test_example_paths.length, 1);
});

Deno.test("every tree-sitter corpus feature names runnable examples", () => {
  const corpus_features = collect_corpus_features(
    "tree-sitter-duck/test/corpus",
  );
  assert_equals(
    Object.keys(corpus_feature_examples).sort(),
    corpus_features.sort(),
  );

  const runnable_paths = new Set<string>();

  for (const example of success_examples) {
    runnable_paths.add(example.path);
  }

  for (const path of test_example_paths) {
    runnable_paths.add(path);
  }

  for (const [feature, paths] of Object.entries(corpus_feature_examples)) {
    if (paths.length === 0) {
      throw new Error("Corpus feature has no example: " + feature);
    }

    for (const path of paths) {
      if (!runnable_paths.has(path)) {
        throw new Error(
          "Corpus feature example is not runnable: " + feature + " -> " +
            path,
        );
      }
    }
  }
});

Deno.test("tree-sitter corpus covers every named syntax node", () => {
  const definitions = JSON.parse(
    Deno.readTextFileSync("tree-sitter-duck/src/node-types.json"),
  ) as { type: string; named: boolean }[];
  const covered = collect_corpus_node_types("tree-sitter-duck/test/corpus");
  const missing = definitions
    .filter((definition) => definition.named && !covered.has(definition.type))
    .map((definition) => definition.type)
    .sort();

  assert_equals(missing, []);
});

function compile_example(example: SuccessExample): string {
  if (example.route === "ic") {
    return Source.ic_wat(Source.load_fragment_file(example.path));
  }

  if (example.route === "core") {
    return Source.wat(Source.load_fragment_file(example.path));
  }

  if (example.route === "managed") {
    throw new Error("Managed examples compile through Source.artifact_file");
  }

  example.route satisfies never;
  throw new Error("Unknown example route");
}

async function run_managed_example(example: SuccessExample): Promise<void> {
  const artifact = Source.artifact_file(example.path);
  const wasm = await wasm_from_wat(artifact.wat);
  const program = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    for (const example_run of example.runs) {
      const init = example_run.init;

      if (!init) {
        throw new Error("Managed example is missing Init: " + example.path);
      }

      const value = DuckRunner(init()).run(program);
      assert_equals(managed_result(value, example.path), example_run.expected);
    }
  } finally {
    program.dispose();
  }
}

async function run_managed_trap(
  example: (typeof trap_examples)[number],
): Promise<void> {
  const init = example.init;

  if (!init) {
    throw new Error("Managed trap example is missing Init: " + example.path);
  }

  const artifact = Source.artifact_file(example.path);
  const wasm = await wasm_from_wat(artifact.wat);
  const program = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    DuckRunner(init()).run(program);
  } finally {
    program.dispose();
  }
}

function managed_result(value: DuckValue, path: string): number | bigint {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Managed example must return [result]: " + path);
  }

  const result = value[0];

  if (typeof result !== "number" && typeof result !== "bigint") {
    throw new Error("Managed example result must be numeric: " + path);
  }

  return result;
}

async function run_wat(
  wat: string,
  imports: WebAssembly.Imports,
): Promise<number | bigint> {
  const bytes = await wasm_from_wat(wat);
  const module = await WebAssembly.compile(bytes);
  const instantiated = await WebAssembly.instantiate(module, imports);
  const main = instantiated.exports.main;

  if (typeof main !== "function") {
    throw new Error("Example module does not export main");
  }

  const result = main();

  if (typeof result !== "number" && typeof result !== "bigint") {
    throw new Error("Example main returned a non-numeric result");
  }

  return result;
}

async function wasm_from_wat(wat: string): Promise<Uint8Array<ArrayBuffer>> {
  const directory = await Deno.makeTempDir({ prefix: "ducklang-example-" });
  const wat_path = directory + "/example.wat";
  const wasm_path = directory + "/example.wasm";

  try {
    await Deno.writeTextFile(wat_path, wat);
    const command = new Deno.Command("wat2wasm", {
      args: [wat_path, "-o", wasm_path],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    if (!output.success) {
      throw new Error(
        "wat2wasm failed:\n" + decoder.decode(output.stderr) + "\n" + wat,
      );
    }

    const bytes = await Deno.readFile(wasm_path);
    const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    copy.set(bytes);
    return copy;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function collect_duck_files(path: string): string[] {
  const files: string[] = [];

  for (const entry of Deno.readDirSync(path)) {
    const child = path + "/" + entry.name;

    if (entry.isDirectory) {
      files.push(...collect_duck_files(child));
      continue;
    }

    if (entry.isFile && entry.name.endsWith(".duck")) {
      files.push(child);
    }
  }

  return files;
}

function collect_corpus_features(path: string): string[] {
  const features: string[] = [];
  const heading = /^={3,}\r?\n([^\r\n]+)\r?\n={3,}$/gm;

  for (const entry of Deno.readDirSync(path)) {
    if (!entry.isFile || !entry.name.endsWith(".txt")) {
      continue;
    }

    const corpus = Deno.readTextFileSync(path + "/" + entry.name);

    for (const match of corpus.matchAll(heading)) {
      const feature = match[1];

      if (feature === undefined) {
        throw new Error("Corpus heading is missing a name: " + entry.name);
      }

      features.push(entry.name + " / " + feature);
    }
  }

  return features;
}

function collect_corpus_node_types(path: string): Set<string> {
  const node_types = new Set<string>();
  const expected_tree = /^---\r?\n([\s\S]*?)(?=^={3,}\r?$|(?![\s\S]))/gm;
  const node = /\(([A-Za-z_][A-Za-z0-9_]*)/g;

  for (const entry of Deno.readDirSync(path)) {
    if (!entry.isFile || !entry.name.endsWith(".txt")) {
      continue;
    }

    const corpus = Deno.readTextFileSync(path + "/" + entry.name);

    for (const tree_match of corpus.matchAll(expected_tree)) {
      const tree = tree_match[1];

      if (tree === undefined) {
        throw new Error(
          "Corpus case is missing an expected tree: " + entry.name,
        );
      }

      for (const node_match of tree.matchAll(node)) {
        const node_type = node_match[1];

        if (node_type === undefined) {
          throw new Error(
            "Corpus tree contains an unnamed node: " + entry.name,
          );
        }

        node_types.add(node_type);
      }
    }
  }

  return node_types;
}

function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

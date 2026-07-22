import { compileModuleSource, runMain } from "../src/compiler.ts";
import {
  type DucklangSuccessContract,
  parseDucklangCorpusContract,
} from "../src/ducklang_corpus_contract.ts";

const corpusDirectory = new URL("../examples/binned/", import.meta.url);
const contractUrl = new URL("contract.json", corpusDirectory);
const supportedSuccessPaths = new Set([
  "examples/basics/01_arithmetic_and_shadowing.duck",
  "examples/basics/02_type_changing_shadowing.duck",
  "examples/basics/03_numeric_primitives.duck",
  "examples/basics/04_comparisons_and_logic.duck",
  "examples/basics/05_i64_pipeline.duck",
  "examples/basics/06_functions_and_blocks.duck",
  "examples/basics/07_early_return.duck",
  "examples/basics/10_else_if.duck",
  "examples/basics/13_contextual_keyword_names.duck",
  "examples/compile_time/01_comptime_adder.duck",
  "examples/compile_time/02_higher_order_compose.duck",
  "examples/compile_time/03_const_parameter_twice.duck",
  "examples/compile_time/04_const_capture_snapshot.duck",
  "examples/compile_time/05_static_recursion_factorial.duck",
  "examples/compile_time/06_generic_type_constructor.duck",
  "examples/compile_time/08_union_fact_checker.duck",
  "examples/data/07_generic_option.duck",
  "examples/data/08_dynamic_union_result.duck",
  "examples/data/11_text_slices_and_equality.duck",
  "examples/data/10_text_append_and_bytes.duck",
  "examples/functions/01_closure_capture.duck",
  "examples/functions/02_returned_closure.duck",
  "examples/functions/03_closure_local_shadow.duck",
  "examples/functions/04_recursive_fibonacci.duck",
  "examples/functions/05_tail_recursive_gcd.duck",
  "examples/ownership_modules/04_freeze_and_share.duck",
  "examples/ownership_modules/03_scratch_cleanup.duck",
  "examples/ownership_modules/02_borrowed_text_read.duck",
]);

Deno.test("the vendored Ducklang contract accounts for the complete corpus", async () => {
  const contract = parseDucklangCorpusContract(
    await Deno.readTextFile(contractUrl),
  );
  assertEquals(contract.success.length, 92, "success contract count");
  assertEquals(
    contract.compileFailures.length,
    12,
    "compile-failure contract count",
  );
  assertEquals(contract.traps.length, 4, "trap contract count");
  assertEquals(contract.sourceTests.length, 1, "source-test contract count");
  assertEquals(contract.dependencies.length, 9, "dependency count");

  const contractedPaths = new Set([
    ...contract.success.map((example) => example.path),
    ...contract.compileFailures.map((example) => example.path),
    ...contract.traps.map((example) => example.path),
    ...contract.sourceTests,
    ...contract.dependencies,
  ]);
  assertEquals(contractedPaths.size, 118, "distinct contracted source count");
});

Deno.test("the implemented Ducklang corpus baseline produces its declared results", async () => {
  const contract = parseDucklangCorpusContract(
    await Deno.readTextFile(contractUrl),
  );
  const supported = contract.success.filter((example) =>
    supportedSuccessPaths.has(example.path)
  );
  assertEquals(
    supported.length,
    supportedSuccessPaths.size,
    "supported success fixture count",
  );

  for (const example of supported) {
    await assertSuccessContract(example);
  }
});

async function assertSuccessContract(
  example: DucklangSuccessContract,
): Promise<void> {
  const sourceUrl = contractSourceUrl(example.path);
  const source = await Deno.readTextFile(sourceUrl);
  const artifact = await compileModuleSource(sourceUrl.pathname, source, {
    gpuMode: "off",
  });
  for (const run of example.runs) {
    if (run.inputs !== undefined) {
      throw new Error(
        `${example.path} entered the executable baseline before runtime inputs were implemented`,
      );
    }
    const actual = await runMain(artifact.wasm);
    const expected = run.expected.type === "i32"
      ? run.expected.value
      : BigInt(run.expected.value);
    if (actual !== expected) {
      throw new Error(
        `${example.path}${
          run.name === undefined ? "" : ` run ${run.name}`
        } expected ${expected}, received ${actual}`,
      );
    }
  }
}

function contractSourceUrl(path: string): URL {
  const prefix = "examples/";
  if (!path.startsWith(prefix)) {
    throw new Error(
      `Ducklang contract path must start with ${prefix}: ${path}`,
    );
  }
  return new URL(path.slice(prefix.length), corpusDirectory);
}

function assertEquals(
  actual: number,
  expected: number,
  subject: string,
): void {
  if (actual !== expected) {
    throw new Error(`${subject}: expected ${expected}, received ${actual}`);
  }
}

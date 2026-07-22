import { compileModuleSource, runMain } from "../src/compiler.ts";
import {
  type DucklangCompileFailureContract,
  type DucklangSuccessContract,
  type DucklangTrapContract,
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
  "examples/basics/08_dynamic_condition.duck",
  "examples/basics/09_literals.duck",
  "examples/basics/10_else_if.duck",
  "examples/basics/11_no_demand_bindings.duck",
  "examples/basics/12_value_packs_and_tuples.duck",
  "examples/basics/13_contextual_keyword_names.duck",
  "examples/compile_time/01_comptime_adder.duck",
  "examples/compile_time/02_higher_order_compose.duck",
  "examples/compile_time/03_const_parameter_twice.duck",
  "examples/compile_time/04_const_capture_snapshot.duck",
  "examples/compile_time/05_static_recursion_factorial.duck",
  "examples/compile_time/06_generic_type_constructor.duck",
  "examples/compile_time/07_struct_fact_checker.duck",
  "examples/compile_time/08_union_fact_checker.duck",
  "examples/compile_time/09_type_pattern_check.duck",
  "examples/compile_time/11_indexed_calculator.duck",
  "examples/compile_time/14_rank_n_identity.duck",
  "examples/compile_time/15_open_imports.duck",
  "examples/compile_time/20_variadic_value_packs.duck",
  "examples/compile_time/21_type_patterns.duck",
  "examples/data/01_struct_fields.duck",
  "examples/data/02_projected_struct_update.duck",
  "examples/data/03_nested_structs.duck",
  "examples/data/04_dynamic_struct_branch.duck",
  "examples/data/05_struct_runtime_index.duck",
  "examples/data/06_struct_index_assignment.duck",
  "examples/data/07_generic_option.duck",
  "examples/data/08_dynamic_union_result.duck",
  "examples/data/09_union_struct_payload.duck",
  "examples/data/10_text_append_and_bytes.duck",
  "examples/data/11_text_slices_and_equality.duck",
  "examples/data/12_dynamic_text_branch.duck",
  "examples/data/15_packed_integers.duck",
  "examples/data/16_struct_constructor_and_shape.duck",
  "examples/data/17_match_patterns.duck",
  "examples/functions/01_closure_capture.duck",
  "examples/functions/02_returned_closure.duck",
  "examples/functions/03_closure_local_shadow.duck",
  "examples/functions/04_recursive_fibonacci.duck",
  "examples/functions/05_tail_recursive_gcd.duck",
  "examples/functions/06_runtime_selected_closure.duck",
  "examples/functions/07_selected_i64_closure.duck",
  "examples/functions/08_no_else_fallthrough.duck",
  "examples/functions/09_nested_control_flow.duck",
  "examples/functions/10_union_selected_closure.duck",
  "examples/functions/11_mutual_recursion.duck",
  "examples/functions/12_let_else_return.duck",
  "examples/handlers/02_inferred_option_do.duck",
  "examples/loops/01_range_sum.duck",
  "examples/loops/02_stepped_range.duck",
  "examples/loops/03_dynamic_range_bound.duck",
  "examples/loops/04_break.duck",
  "examples/loops/05_continue.duck",
  "examples/loops/06_nested_ranges.duck",
  "examples/loops/07_struct_collection.duck",
  "examples/loops/08_text_byte_collection.duck",
  "examples/loops/09_loop_expression_syntax.duck",
  "examples/loops/10_fold_function.duck",
  "examples/loops/11_refutable_collection_pattern.duck",
  "examples/loops/12_let_else_continue.duck",
  "examples/ownership_modules/01_linear_scalar.duck",
  "examples/ownership_modules/02_borrowed_text_read.duck",
  "examples/ownership_modules/03_scratch_cleanup.duck",
  "examples/ownership_modules/04_freeze_and_share.duck",
  "examples/ownership_modules/05_host_ownership_contracts.duck",
  "examples/ownership_modules/06_multi_file_capability_app.duck",
  "examples/showcases/01_numeric_toolkit.duck",
  "examples/showcases/02_text_analyzer.duck",
  "examples/showcases/03_geometry_transform.duck",
  "examples/showcases/04_result_pipeline.duck",
  "examples/showcases/05_linear_host_session.duck",
  "examples/showcases/06_modular_score_application.duck",
  "examples/showcases/07_domain_abstractions.duck",
]);
const supportedTrapPaths = new Set([
  "examples/failures/traps/01_explicit_panic.duck",
  "examples/failures/traps/02_text_out_of_bounds.duck",
  "examples/failures/traps/03_struct_index_out_of_bounds.duck",
]);
const supportedCompileFailurePaths = new Set([
  "examples/failures/compile/01_reused_linear_value.duck",
  "examples/failures/compile/02_unused_linear_value.duck",
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

Deno.test("the implemented Ducklang trap baseline rejects its declared runs", async () => {
  const contract = parseDucklangCorpusContract(
    await Deno.readTextFile(contractUrl),
  );
  const supported = contract.traps.filter((example) =>
    supportedTrapPaths.has(example.path)
  );
  assertEquals(
    supported.length,
    supportedTrapPaths.size,
    "supported trap fixture count",
  );
  for (const example of supported) await assertTrapContract(example);
});

Deno.test("the implemented Ducklang compile-failure baseline reports its declared errors", async () => {
  const contract = parseDucklangCorpusContract(
    await Deno.readTextFile(contractUrl),
  );
  const supported = contract.compileFailures.filter((example) =>
    supportedCompileFailurePaths.has(example.path)
  );
  assertEquals(
    supported.length,
    supportedCompileFailurePaths.size,
    "supported compile-failure fixture count",
  );
  for (const example of supported) await assertCompileFailureContract(example);
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
    const actual = await runMain(artifact.wasm, run.inputs);
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

async function assertTrapContract(
  example: DucklangTrapContract,
): Promise<void> {
  const sourceUrl = contractSourceUrl(example.path);
  const artifact = await compileModuleSource(
    sourceUrl.pathname,
    await Deno.readTextFile(sourceUrl),
    { gpuMode: "off" },
  );
  try {
    await runMain(artifact.wasm, example.inputs);
  } catch {
    return;
  }
  throw new Error(`${example.path} returned instead of trapping`);
}

async function assertCompileFailureContract(
  example: DucklangCompileFailureContract,
): Promise<void> {
  const sourceUrl = contractSourceUrl(example.path);
  try {
    await compileModuleSource(
      sourceUrl.pathname,
      await Deno.readTextFile(sourceUrl),
      { gpuMode: "off" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(example.message)) return;
    throw new Error(
      `${example.path} expected ${JSON.stringify(example.message)}, received ${
        JSON.stringify(message)
      }`,
    );
  }
  throw new Error(`${example.path} compiled instead of failing`);
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

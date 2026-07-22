import type { DuckInitValue } from "../src/frontend.ts";

export type ExampleRoute = "ic" | "core" | "managed";

export type ExampleRun = {
  name?: string;
  expected: number | bigint;
  imports?: () => WebAssembly.Imports;
  init?: () => DuckInitValue;
};

export type SuccessExample = {
  path: string;
  route: ExampleRoute;
  runs: ExampleRun[];
};

export type CompileFailureExample = {
  path: string;
  route: ExampleRoute;
  message: string;
};

export type TrapExample = {
  path: string;
  route: "core" | "managed";
  imports?: () => WebAssembly.Imports;
  init?: () => DuckInitValue;
};

function run(expected: number | bigint): ExampleRun[] {
  return [{ expected }];
}

function flag_runs(
  when_true: number | bigint,
  when_false: number | bigint,
): ExampleRun[] {
  return [
    {
      name: "flag_true",
      expected: when_true,
      init: () => ({ input: { flag: () => 1 } }),
    },
    {
      name: "flag_false",
      expected: when_false,
      init: () => ({ input: { flag: () => 0 } }),
    },
  ];
}

export const success_examples: SuccessExample[] = [
  {
    path: "examples/basics/01_arithmetic_and_shadowing.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/02_type_changing_shadowing.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/03_numeric_primitives.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/04_comparisons_and_logic.duck",
    route: "ic",
    runs: run(42),
  },
  { path: "examples/basics/05_i64_pipeline.duck", route: "ic", runs: run(42n) },
  {
    path: "examples/basics/06_functions_and_blocks.duck",
    route: "ic",
    runs: run(42),
  },
  { path: "examples/basics/07_early_return.duck", route: "ic", runs: run(42) },
  {
    path: "examples/basics/08_dynamic_condition.duck",
    route: "managed",
    runs: flag_runs(21, 41),
  },
  {
    path: "examples/basics/09_literals.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/basics/10_else_if.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/basics/11_no_demand_bindings.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/basics/12_value_packs_and_tuples.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/basics/13_contextual_keyword_names.duck",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/compile_time/01_comptime_adder.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/02_higher_order_compose.duck",
    route: "ic",
    runs: run(41),
  },
  {
    path: "examples/compile_time/03_const_parameter_twice.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/04_const_capture_snapshot.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/05_static_recursion_factorial.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/06_generic_type_constructor.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/07_struct_fact_checker.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/08_union_fact_checker.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/09_type_pattern_check.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/10_extensions_and_protocols.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/11_indexed_calculator.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/12_type_specialization.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/13_derived_nested_equality.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/14_rank_n_identity.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/15_open_imports.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/compile_time/16_attributes_and_import_meta.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/17_newtypes_and_literal_types.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/18_ducks_and_operators.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/19_include_and_type_of.duck",
    route: "core",
    runs: run(18),
  },
  {
    path: "examples/compile_time/20_variadic_value_packs.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/21_type_patterns.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/compile_time/22_generic_extension.duck",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/functions/01_closure_capture.duck",
    route: "ic",
    runs: run(43),
  },
  {
    path: "examples/functions/02_returned_closure.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/functions/03_closure_local_shadow.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/functions/04_recursive_fibonacci.duck",
    route: "core",
    runs: run(8),
  },
  {
    path: "examples/functions/05_tail_recursive_gcd.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/functions/06_runtime_selected_closure.duck",
    route: "managed",
    runs: flag_runs(22, 42),
  },
  {
    path: "examples/functions/07_selected_i64_closure.duck",
    route: "managed",
    runs: flag_runs(22n, 42n),
  },
  {
    path: "examples/functions/08_no_else_fallthrough.duck",
    route: "managed",
    runs: flag_runs(42, 1),
  },
  {
    path: "examples/functions/09_nested_control_flow.duck",
    route: "managed",
    runs: flag_runs(42, 21),
  },
  {
    path: "examples/functions/10_union_selected_closure.duck",
    route: "managed",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/functions/11_mutual_recursion.duck",
    route: "core",
    runs: run(2),
  },
  {
    path: "examples/functions/12_let_else_return.duck",
    route: "core",
    runs: run(49),
  },

  { path: "examples/data/01_struct_fields.duck", route: "core", runs: run(39) },
  {
    path: "examples/data/02_projected_struct_update.duck",
    route: "core",
    runs: run(42),
  },
  { path: "examples/data/03_nested_structs.duck", route: "ic", runs: run(42) },
  {
    path: "examples/data/04_dynamic_struct_branch.duck",
    route: "managed",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/data/05_struct_runtime_index.duck",
    route: "managed",
    runs: [
      {
        name: "first",
        expected: 20,
        init: () => ({ input: { index: () => 0 } }),
      },
      {
        name: "second",
        expected: 22,
        init: () => ({ input: { index: () => 1 } }),
      },
    ],
  },
  {
    path: "examples/data/06_struct_index_assignment.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/07_generic_option.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/08_dynamic_union_result.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/09_union_struct_payload.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/10_text_append_and_bytes.duck",
    route: "core",
    runs: run(112),
  },
  {
    path: "examples/data/11_text_slices_and_equality.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/12_dynamic_text_branch.duck",
    route: "managed",
    runs: flag_runs(5, 3),
  },
  { path: "examples/data/13_type_rows.duck", route: "core", runs: run(42) },
  { path: "examples/data/14_type_sets.duck", route: "core", runs: run(42) },
  {
    path: "examples/data/15_packed_integers.duck",
    route: "core",
    runs: run(2),
  },
  {
    path: "examples/data/16_struct_constructor_and_shape.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/data/17_match_patterns.duck",
    route: "core",
    runs: run(42),
  },

  { path: "examples/loops/01_range_sum.duck", route: "core", runs: run(10) },
  {
    path: "examples/loops/02_stepped_range.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/loops/03_dynamic_range_bound.duck",
    route: "managed",
    runs: [
      {
        name: "bound_four",
        expected: 6,
        init: () => ({ input: { bound: () => 4 } }),
      },
      {
        name: "bound_seven",
        expected: 21,
        init: () => ({ input: { bound: () => 7 } }),
      },
    ],
  },
  { path: "examples/loops/04_break.duck", route: "core", runs: run(42) },
  { path: "examples/loops/05_continue.duck", route: "core", runs: run(42) },
  {
    path: "examples/loops/06_nested_ranges.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/loops/07_struct_collection.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/loops/08_text_byte_collection.duck",
    route: "core",
    runs: run(198),
  },
  {
    path: "examples/loops/09_loop_expression_syntax.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/loops/10_fold_function.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/loops/11_refutable_collection_pattern.duck",
    route: "core",
    runs: run(6),
  },
  {
    path: "examples/loops/12_let_else_continue.duck",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/ownership_modules/01_linear_scalar.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/02_borrowed_text_read.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/03_scratch_cleanup.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/04_freeze_and_share.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/ownership_modules/05_host_ownership_contracts.duck",
    route: "managed",
    runs: [{
      expected: 42,
      init: () => ({ host: { read: () => 20, take: () => 22 } }),
    }],
  },
  {
    path: "examples/ownership_modules/06_multi_file_capability_app.duck",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/handlers/01_local_counter.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/handlers/02_inferred_option_do.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/handlers/03_composed_default_handlers.duck",
    route: "core",
    runs: run(42),
  },

  {
    path: "examples/showcases/01_numeric_toolkit.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/showcases/02_text_analyzer.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/showcases/03_geometry_transform.duck",
    route: "core",
    runs: run(42),
  },
  {
    path: "examples/showcases/04_result_pipeline.duck",
    route: "managed",
    runs: flag_runs(42, 42),
  },
  {
    path: "examples/showcases/05_linear_host_session.duck",
    route: "managed",
    runs: [{
      expected: 42,
      init: () => ({ host: { print: () => 42 } }),
    }],
  },
  {
    path: "examples/showcases/06_modular_score_application.duck",
    route: "ic",
    runs: run(42),
  },
  {
    path: "examples/showcases/07_domain_abstractions.duck",
    route: "core",
    runs: run(42),
  },
];

export const compile_failure_examples: CompileFailureExample[] = [
  {
    path: "examples/failures/compile/01_reused_linear_value.duck",
    route: "core",
    message: "was already consumed",
  },
  {
    path: "examples/failures/compile/02_unused_linear_value.duck",
    route: "core",
    message: "was not consumed",
  },
  {
    path: "examples/failures/compile/03_illegal_type_change.duck",
    route: "ic",
    message: "Assignment changes type for value",
  },
  {
    path: "examples/failures/compile/04_mixed_integer_widths.duck",
    route: "core",
    message: "Mixed i32 and i64",
  },
  {
    path: "examples/failures/compile/05_invalid_condition_type.duck",
    route: "ic",
    message: "If condition expects Bool, got Text",
  },
  {
    path: "examples/failures/compile/06_missing_struct_field.duck",
    route: "ic",
    message: "Missing struct field: age",
  },
  {
    path: "examples/failures/compile/07_invalid_union_payload.duck",
    route: "core",
    message: "expects Int, got Text",
  },
  {
    path: "examples/failures/compile/08_escaping_borrow.duck",
    route: "core",
    message: "borrow",
  },
  {
    path: "examples/failures/compile/09_freeze_while_borrowed.duck",
    route: "core",
    message: "Cannot freeze borrowed owner",
  },
  {
    path: "examples/failures/compile/10_scratch_heap_escape.duck",
    route: "core",
    message: "cannot leave scratch",
  },
  {
    path: "examples/failures/compile/11_frozen_mutation.duck",
    route: "core",
    message: "frozen",
  },
  {
    path: "examples/failures/compile/12_missing_imported_export.duck",
    route: "core",
    message: "does not export missing",
  },
];

export const trap_examples: TrapExample[] = [
  { path: "examples/failures/traps/01_explicit_panic.duck", route: "core" },
  {
    path: "examples/failures/traps/02_text_out_of_bounds.duck",
    route: "managed",
    init: () => ({ input: { index: () => 2 } }),
  },
  {
    path: "examples/failures/traps/03_struct_index_out_of_bounds.duck",
    route: "managed",
    init: () => ({ input: { index: () => 3 } }),
  },
  {
    path: "examples/failures/traps/04_zero_range_step.duck",
    route: "managed",
    init: () => ({ input: { step: () => 0 } }),
  },
];

export const test_example_paths = [
  "examples/testing/01_inline_tests.duck",
];

export const dependency_paths = [
  "examples/compile_time/open_module.duck",
  "examples/ownership_modules/multi_file/score_module.duck",
  "examples/failures/compile/missing_import_dependency.duck",
  "examples/effects/01_inferred_io.duck",
  "examples/effects/02_annotated_effect_row.duck",
  "examples/effects/03_cli_stdin_stdout.duck",
  "examples/effects/multi_file/host.duck",
  "examples/effects/multi_file/logger.duck",
  "examples/effects/multi_file/main.duck",
];

# Source Examples

Ducklang source examples use the `.duck` extension. The extension is a
repository convention, not a restriction: `Source.load`, `Source.compile_file`,
and `Source.wat_file` continue to accept any exact file path.

Run every example, expected compiler failure, and expected runtime trap with:

```sh
just examples
```

To compile one Core example from TypeScript:

```ts
import { Source } from "../src/frontend.ts";

const wat = Source.wat_file("examples/data/01_struct_fields.duck");
```

Small pure examples marked `IC` use `Source.ic_wat`; structured examples marked
`Core` use `Source.wat_file`. Examples marked `Managed` use
`Source.artifact_file` and receive explicit effect objects through `DuckRunner`.
The executable expectations and deterministic runners live in `manifest.ts`.
`corpus_coverage.ts` maps every tree-sitter corpus feature to one or more
runnable examples. The example test fails when a corpus section is added without
updating that inventory.

The source-level testing example lives at `testing/01_inline_tests.duck`. Run
its `@[test]` functions with:

```sh
just duck test examples/testing/01_inline_tests.duck
```

## Basics

| Example                            | Focus                                   | Route   | Result      |
| ---------------------------------- | --------------------------------------- | ------- | ----------- |
| `01_arithmetic_and_shadowing.duck` | arithmetic and same-type shadowing      | IC      | `42`        |
| `02_type_changing_shadowing.duck`  | `:=` type-changing shadowing            | IC      | `42`        |
| `03_numeric_primitives.duck`       | division, remainder, and multiplication | IC      | `42`        |
| `04_comparisons_and_logic.duck`    | comparisons and short-circuit logic     | IC      | `42`        |
| `05_i64_pipeline.duck`             | explicit `I64` arithmetic               | IC      | `42i64`     |
| `06_functions_and_blocks.duck`     | multi-argument block function           | IC      | `42`        |
| `07_early_return.duck`             | early function return                   | IC      | `42`        |
| `08_dynamic_condition.duck`        | host-driven runtime branch              | Managed | `21` / `41` |
| `09_literals.duck`                 | text, character, and boolean literals   | IC      | `42`        |
| `10_else_if.duck`                  | expression-valued `else if` chains      | IC      | `42`        |
| `11_no_demand_bindings.duck`       | `_` in ignored binding positions        | Core    | `42`        |
| `12_value_packs_and_tuples.duck`   | transient packs and stored tuples       | Core    | `42`        |
| `13_contextual_keyword_names.duck` | contextual keywords used as local names | Core    | `42`        |

## Compile Time

| Example                              | Focus                                          | Route | Result |
| ------------------------------------ | ---------------------------------------------- | ----- | ------ |
| `01_comptime_adder.duck`             | compile-time closure construction              | IC    | `42`   |
| `02_higher_order_compose.duck`       | higher-order composition                       | IC    | `41`   |
| `03_const_parameter_twice.duck`      | const call-site specialization                 | IC    | `42`   |
| `04_const_capture_snapshot.duck`     | binding-time const capture                     | IC    | `42`   |
| `05_static_recursion_factorial.duck` | statically reducible recursion                 | IC    | `42`   |
| `06_generic_type_constructor.duck`   | generic sum type declaration                   | Core  | `42`   |
| `07_struct_fact_checker.duck`        | named product declaration and projection       | Core  | `42`   |
| `08_union_fact_checker.duck`         | named sum declaration and case selection       | Core  | `42`   |
| `09_type_pattern_check.duck`         | product alias and annotated construction       | Core  | `42`   |
| `10_extensions_and_protocols.duck`   | lexical extension and protocol specialization  | IC    | `42`   |
| `11_indexed_calculator.duck`         | closed calculator sum                          | Core  | `42`   |
| `12_type_specialization.duck`        | deriving a function from a struct type         | Core  | `42`   |
| `13_derived_nested_equality.duck`    | recursive structural type derivation           | Core  | `42`   |
| `14_rank_n_identity.duck`            | rank-N function parameter                      | Core  | `42`   |
| `15_open_imports.duck`               | open import exclusion and renaming             | IC    | `42`   |
| `16_attributes_and_import_meta.duck` | stacked source attributes and host metadata    | Core  | `42`   |
| `17_newtypes_and_literal_types.duck` | newtypes, exact literal types, and widening    | Core  | `42`   |
| `18_ducks_and_operators.duck`        | source ducks, extensions, and custom operators | Core  | `42`   |
| `19_include_and_type_of.duck`        | included text and exact compile-time type      | Core  | `18`   |
| `20_variadic_value_packs.duck`       | variadic pack iteration and rest matching      | Core  | `42`   |
| `21_type_patterns.duck`              | structural compile-time type matching          | Core  | `42`   |
| `22_generic_extension.duck`          | generic extension parameter declaration        | Core  | `42`   |

## Functions And Control Flow

| Example                            | Focus                                 | Route   | Result            |
| ---------------------------------- | ------------------------------------- | ------- | ----------------- |
| `01_closure_capture.duck`          | runtime capture before shadowing      | IC      | `43`              |
| `02_returned_closure.duck`         | closure returned from a function      | IC      | `42`              |
| `03_closure_local_shadow.duck`     | closure-local assignment              | IC      | `42`              |
| `04_recursive_fibonacci.duck`      | non-tail recursive function           | Core    | `8`               |
| `05_tail_recursive_gcd.duck`       | tail recursion and remainder          | Core    | `42`              |
| `06_runtime_selected_closure.duck` | runtime-selected `Int` closure        | Managed | `22` / `42`       |
| `07_selected_i64_closure.duck`     | runtime-selected `I64` closure        | Managed | `22i64` / `42i64` |
| `08_no_else_fallthrough.duck`      | dynamic no-else fallthrough           | Managed | `42` / `1`        |
| `09_nested_control_flow.duck`      | nested dynamic statements             | Managed | `42` / `21`       |
| `10_union_selected_closure.duck`   | runtime union selecting a closure     | Managed | `42`              |
| `11_mutual_recursion.duck`         | one mutually recursive function group | Core    | `2`               |
| `12_let_else_return.duck`          | let-else binding with early return    | Core    | `49`              |

## Data And Text

| Example                                | Focus                                      | Route   | Result      |
| -------------------------------------- | ------------------------------------------ | ------- | ----------- |
| `01_struct_fields.duck`                | typed struct construction and fields       | Core    | `39`        |
| `02_projected_struct_update.duck`      | pure struct update                         | Core    | `42`        |
| `03_nested_structs.duck`               | nested typed structures                    | IC      | `42`        |
| `04_dynamic_struct_branch.duck`        | host-selected struct value                 | Managed | `42`        |
| `05_struct_runtime_index.duck`         | checked runtime struct index               | Managed | `20` / `22` |
| `06_struct_index_assignment.duck`      | aggregate rebuild by index                 | Core    | `42`        |
| `07_generic_option.duck`               | generic union and `if let`                 | Core    | `42`        |
| `08_dynamic_union_result.duck`         | materialized runtime union                 | Core    | `42`        |
| `09_union_struct_payload.duck`         | struct payload extraction                  | Core    | `42`        |
| `10_text_append_and_bytes.duck`        | append, length, and UTF-8 indexing         | Core    | `112`       |
| `11_text_slices_and_equality.duck`     | slicing, rebuilding, and equality          | Core    | `42`        |
| `12_dynamic_text_branch.duck`          | host-selected visible text                 | Managed | `5` / `3`   |
| `13_type_rows.duck`                    | extensible product and union rows          | Core    | `42`        |
| `14_type_sets.duck`                    | type union, intersection, and difference   | Core    | `42`        |
| `15_packed_integers.duck`              | packed fixed-width integer fields          | Core    | `2`         |
| `16_struct_constructor_and_shape.duck` | source-defined `.new` and `.shape` members | Core    | `42`        |
| `17_match_patterns.duck`               | alternatives and text capture patterns     | Core    | `42`        |

## Loops And Collections

| Example                                | Focus                                 | Route   | Result     |
| -------------------------------------- | ------------------------------------- | ------- | ---------- |
| `01_range_sum.duck`                    | range loop with carried state         | Core    | `10`       |
| `02_stepped_range.duck`                | explicit positive step                | Core    | `42`       |
| `03_dynamic_range_bound.duck`          | host-provided loop bound              | Managed | `6` / `21` |
| `04_break.duck`                        | loop break                            | Core    | `42`       |
| `05_continue.duck`                     | loop continue                         | Core    | `42`       |
| `06_nested_ranges.duck`                | nested loop scopes                    | Core    | `42`       |
| `07_struct_collection.duck`            | aggregate collection iteration        | Core    | `42`       |
| `08_text_byte_collection.duck`         | UTF-8 byte iteration                  | Core    | `198`      |
| `09_loop_expression_syntax.duck`       | value-producing loop and break        | Core    | `42`       |
| `10_fold_function.duck`                | fold built from the loop primitive    | Core    | `42`       |
| `11_refutable_collection_pattern.duck` | skipped nonmatching union elements    | Core    | `6`        |
| `12_let_else_continue.duck`            | let-else continuing a collection loop | Core    | `42`       |

## Ownership And Modules

| Example                             | Focus                                                   | Route   | Result |
| ----------------------------------- | ------------------------------------------------------- | ------- | ------ |
| `01_linear_scalar.duck`             | exactly-once scalar consumption                         | Core    | `42`   |
| `02_borrowed_text_read.duck`        | bounded text borrow                                     | Core    | `42`   |
| `03_scratch_cleanup.duck`           | scratch lifetime returning a scalar                     | Core    | `42`   |
| `04_freeze_and_share.duck`          | immutable sharing                                       | Core    | `42`   |
| `05_host_ownership_contracts.duck`  | bounded borrow and ownership transfer effect ABI        | Managed | `42`   |
| `06_multi_file_capability_app.duck` | explicit dependency import and module capability object | Core    | `42`   |

## Effects

| Example                                      | Focus                                      | Route | Result |
| -------------------------------------------- | ------------------------------------------ | ----- | ------ |
| `handlers/01_local_counter.duck`             | deep stateful Duck-defined effect handler  | Core  | `42`   |
| `handlers/02_inferred_option_do.duck`        | inferred source Option handler             | Core  | `42`   |
| `handlers/03_composed_default_handlers.duck` | ordered composition of two source defaults | Core  | `42`   |

`effects/01_inferred_io.duck` and `effects/02_annotated_effect_row.duck`
contrast inferred rows with `-> <row>` function types.
`effects/03_cli_stdin_stdout.duck` is a managed-ABI command-line example rather
than a numeric manifest run. Its Deno adapter supplies live `Stdin`/`Stdout`
effects or deterministic mocks when `--dry-run` is present; see
`effects/README.md` for the commands.

## Showcases

| Example                             | Focus                                                       | Route   | Result |
| ----------------------------------- | ----------------------------------------------------------- | ------- | ------ |
| `01_numeric_toolkit.duck`           | composition, comptime, and recursion                        | IC      | `42`   |
| `02_text_analyzer.duck`             | slicing, append, equality, and byte loop                    | Core    | `42`   |
| `03_geometry_transform.duck`        | typed points and pure updates                               | Core    | `42`   |
| `04_result_pipeline.duck`           | generic union with struct payload and host-selected branch  | Managed | `42`   |
| `05_linear_host_session.duck`       | scratch promotion, freeze, effect resource, and host borrow | Managed | `42`   |
| `06_modular_score_application.duck` | import, module application, and compile-time closure        | IC      | `42`   |
| `07_domain_abstractions.duck`       | predicates, patches, and bounded source spans               | Core    | `42`   |

## Expected Failures

`failures/compile/` contains 12 programs that demonstrate rejected linear use,
type errors, aggregate errors, ownership violations, frozen mutation, and import
validation. `failures/traps/` contains four valid programs that trap at runtime:
explicit panic, text and struct bounds failures, and a dynamically zero loop
step. These are executable specifications and are checked by `examples.test.ts`.

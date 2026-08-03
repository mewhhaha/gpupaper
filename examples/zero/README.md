# Zero

Zero is gpupaper's controlled end-to-end example language. It is intentionally
small: scalar values are wrapping WebAssembly `i32`, exact 128-bit SIMD subsets
support internal packed work, functions are first-order, and postfix instruction
streams provide lexical bindings, direct calls, arithmetic, comparisons,
selection, shuffles, conversions, and a bounded fold.

```zero
private: step value = @value 1664525 * 1013904223 + ;

export: run seed rounds = @rounds @seed repeat:step ;
```

`@name` pushes a reference, binary operators consume two stack expressions,
`call:name:arity` consumes its arguments, `select!` consumes a condition and two
lazy expression trees, and `repeat:name` consumes a count and initial value and
calls the named unary step. Every function body must leave exactly one value.
Scalar parameters and results remain implicit. Parameter suffixes select
`[i8x16]`, `[i16x8]`, `[i32x4]`, or `[f32x4]`. Results use `=>i8x16`, `=>i16x8`,
`=>i32x4`, or `=>f32x4`; bare `=>` remains shorthand for `=>i32x4`, while `=`
declares `i32`. SIMD instructions are named after their WebAssembly operations.
Comparisons produce internal mask values consumed by typed `select` or
`mask_bitmask`, `mask_all_true`, and `mask_any_true`. `shape.shuffle:l...` takes
two vectors and an exact lane-index immediate. This regular concrete syntax is
deliberate: Baba 8 can prove that each semicolon-terminated function is a strict
terminal-only island, while the Zero adapter checks the typed stack and scope
invariants before producing Core.

The maintained pipeline is:

```text
Zero source
  -> Baba 8 generated CPU-Wasm lexer
  -> Baba 8 strict SIMD Wasm validator and cursor parser
  -> Zero cursor-to-Core adapter
  -> validated gpupaper Core and Wasm plan
  -> gpupaper's Rust-compiled WebAssembly emitter
  -> payload .wasm
```

Regenerate the Baba parser after changing the grammar:

```sh
deno task zero:grammar
```

Run the language conformance tests and the Rust comparison benchmark:

```sh
deno test --allow-read tests/zero.test.ts
deno task benchmark:zero
```

The [`workloads`](workloads) directory contains paired Zero and Rust programs
that form a structural complexity ladder: arithmetic, control flow, call graphs,
nested loops, shared callees, wide live-value frontiers, guarded partial
operations, unreachable functions, equivalent nonlinear programs with different
call-graph shapes, a value-dependent nested fold, and fixed affine folds around
the linear/exponentiation boundary, including affine preparation and finishing
regions. The final application workloads evolve complete 5x5 toroidal Conway's
Game of Life boards packed into `i32` lanes, followed by four independent
xorshift32 streams. The benchmark compiles every pair through its respective
pipeline and checks both against an independent recurrence before measuring
compilation boundaries, module construction, instantiation, and hot execution.
It also records reachability, call multiplicity, call depth, recursion, partial
operations, and SSA liveness so each workload's claimed challenge is
independently checkable.

Workloads 23--26 intentionally sit just beyond backend resource budgets. They
are counterexamples for future profitability work, not demonstrations that every
call or loop should be inlined. Workloads 27--30 then sweep the scalar call-tree
budget on both sides of its exact boundary. Workload 31 evolves one packed board
through scalar operations. Workload 32 uses the exact `i32x4` subset to evolve
four independent packed boards in parallel, then extracts the lanes into a
scalar checksum that can cross the JavaScript Wasm boundary. Workload 33 uses
the completed lane-wise integer operations for a six-instruction vector
xorshift32 step, with an independent four-stream scalar Rust implementation.

Run one rung while developing with `--workload`:

```sh
deno task benchmark:zero --workload=05-nested-loop --samples=30
```

Runtime comparisons are meaningful within one paired workload. Compiler timings
are deliberately not expressed as a ratio: an initialized in-process frontend
and a fresh `rustc` process are different boundaries.

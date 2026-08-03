# Zero

Zero is gpupaper's controlled end-to-end example language. It is intentionally
small: every value is a wrapping WebAssembly `i32`, functions are first-order,
and postfix instruction streams provide lexical bindings, direct calls,
arithmetic, comparisons, lazy selection, and a bounded fold.

```zero
private: step value = @value 1664525 * 1013904223 + ;

export: run seed rounds = @rounds @seed repeat:step ;
```

`@name` pushes a reference, binary operators consume two stack expressions,
`call:name:arity` consumes its arguments, `select!` consumes a condition and two
lazy expression trees, and `repeat:name` consumes a count and initial value and
calls the named unary step. Every function body must leave exactly one value.
This regular concrete syntax is deliberate: Baba 8 can prove that each
semicolon-terminated function is a strict terminal-only island, while the Zero
adapter checks the typed stack and scope invariants before producing Core.

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
regions. The benchmark compiles every pair through its respective pipeline and
checks both against an independent recurrence before measuring compilation
boundaries, module construction, instantiation, and hot execution. It also
records reachability, call multiplicity, call depth, recursion, partial
operations, and SSA liveness so each workload's claimed challenge is
independently checkable.

The final four workloads intentionally sit just beyond backend resource budgets.
They are counterexamples for future profitability work, not demonstrations that
every call or loop should be inlined.

Run one rung while developing with `--workload`:

```sh
deno task benchmark:zero --workload=05-nested-loop --samples=30
```

Runtime comparisons are meaningful within one paired workload. Compiler timings
are deliberately not expressed as a ratio: an initialized in-process frontend
and a fresh `rustc` process are different boundaries.

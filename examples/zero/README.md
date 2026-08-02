# Zero

Zero is gpupaper's controlled end-to-end example language. It is intentionally
small: every value is a wrapping WebAssembly `i32`, functions are first-order,
and expressions provide lexical `let`, direct calls, arithmetic, comparisons,
conditionals, and a bounded `repeat` fold.

```zero
fn step(value) = value * 1664525 + 1013904223;

fn run(seed, rounds) =
  repeat rounds from seed as value { step(value) };
```

The maintained pipeline is:

```text
Zero source
  -> Baba-generated Wasm parser
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
that form a structural complexity ladder: arithmetic, a control-flow diamond, a
call graph, nested predicates, nested loops, and a broad module. The benchmark
compiles every pair through its respective pipeline and checks both against an
independent recurrence before measuring compilation boundaries, module
construction, instantiation, and hot execution.

Run one rung while developing with `--workload`:

```sh
deno task benchmark:zero --workload=05-nested-loop --samples=30
```

Runtime comparisons are meaningful within one paired workload. Compiler timings
are deliberately not expressed as a ratio: an initialized in-process frontend
and a fresh `rustc` process are different boundaries.

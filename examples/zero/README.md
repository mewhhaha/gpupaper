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

The benchmark compiles [`kernel.zero`](kernel.zero) through the pipeline above
and [`kernel.rs`](kernel.rs) directly with
`rustc --target
wasm32-unknown-unknown -C opt-level=3`. It differentially
verifies both payloads before measuring compilation boundaries, module
construction, instantiation, and hot execution. Compiler timings are
deliberately not expressed as a ratio: an in-process frontend and a fresh
`rustc` process are different boundaries.

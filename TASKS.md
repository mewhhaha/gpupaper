# Backend tasks

## Completed boundary

- [x] Define Core independently of a source AST or source type system.
- [x] Keep parsing, inference, effects, ownership proofs, and ABI adaptation in
      consumer repositories.
- [x] Validate table closure, SSA dominance, edge signatures, calls, returns,
      Store operations, SIMD shapes, and selected target features.
- [x] Lower explicit exports through call-graph reachability.
- [x] Preserve deterministic functional-graph and binary-plan ordering.
- [x] Provide TypeScript, Rust/WebAssembly, and WebGPU Wasm emitters.
- [x] Keep Zero as the controlled end-to-end producer and runtime benchmark.

## Open research

- [ ] Replace direct dominator iteration only if profiles justify a more complex
      algorithm.
- [ ] Expand certified rewrite rules with independent semantic oracles.
- [ ] Measure flat-Core and Wasm-plan crossover on generated size sweeps under
      an uncontended GPU protocol.
- [ ] Add a standardized component-model adapter as a consumer-owned package,
      without embedding a language ABI in Core.

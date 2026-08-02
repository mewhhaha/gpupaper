# Performance protocol

Performance claims are admitted only when the benchmark records the complete
measured boundary and verifies the emitted result. Kernel time alone is not a
compiler benchmark.

## Required fields

Every record identifies the repository revision, runtime, hardware, input hash,
sample order, raw observations, and contention inspection. Stage measurements
must distinguish parsing owned by a producer, Core construction, validation,
Wasm planning, emitter initialization, byte emission, readback, module
construction, instantiation, and payload execution where applicable.

GPU records are diagnostic when competing compiler or GPU work is detected.
`--allow-contended` permits diagnosis but does not make the result admissible.
Medians retain all raw samples; a p95 requires at least 20 observations.

## Controlled benchmarks

`deno task benchmark:zero` compares six increasingly difficult controlled
producer workloads with equivalent Rust-to-Wasm programs. It differentially
checks results before timing hot execution and reports Core structure,
compilation stages, output sizes, hashes, and raw paired samples independently.

`deno task benchmark:branch-hints` compares semantically identical Wasm modules
with and without standardized branch-likelihood metadata.

Fresh multi-process records can be collected with:

```sh
deno task benchmark:record \
  --task=benchmark:zero \
  --processes=6 \
  --output=measurements/zero-YYYY-MM-DD.json
```

The cost model and break-even inequality are normative in `PAPER.md`. Empirical
measurements estimate its constants; they do not change the model silently.

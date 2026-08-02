# Measurement ledger

Files in this directory are immutable raw benchmark records. A record is
admissible only when every contained process reports `validity.status` as
`admissible`; diagnostic records may be retained for investigation but cannot
support a speedup claim.

Create a fresh-process record with:

```sh
deno task benchmark:record \
  --task=benchmark:branch-hints \
  --processes=6 \
  --output=measurements/branch-hints-YYYY-MM-DD.json
```

Each process result contains its exact repository state, runtime, start/end load
inspection, input/output identity, raw observations, and paired statistics. Do
not hand-edit generated JSON. Tables in `PAPER.md` or `PERFORMANCE.md` must name
the record from which they were derived and must preserve process-level
variation rather than flattening all iterations into one sample.

## Current records

The `*-diagnostic-2026-08-02.json` records exercise the repaired schemas and
correctness checks under explicitly recorded compiler/GPU contention. They are
not admissible speedup evidence:

- `frontend-diagnostic-2026-08-02.json`
- `wasm-diagnostic-2026-08-02.json`
- `wasm-rust-diagnostic-2026-08-02.json`
- `wasm-rust-simd-diagnostic-2026-08-02.json`
- `break-even-diagnostic-2026-08-02.json`
- `peers-diagnostic-2026-08-02.json`
- `blot-targets-diagnostic-2026-08-02.json`
- `blot-batch-diagnostic-2026-08-02.json`
- `blot-batch-hir-cache-diagnostic-2026-08-02.json`
- `blot-batch-artifact-cache-diagnostic-2026-08-02.json`
- `simd-diagnostic-2026-08-02.json`
- `branch-hints-diagnostic-2026-08-02.json`
- `blot-crossover-diagnostic-2026-08-02.json`
- `blot-crossover-resident-diagnostic-2026-08-02.json`
- `zero-runtime-diagnostic-2026-08-02.json`
- `zero-natural-loop-diagnostic-2026-08-02.json`
- `zero-explicit-export-diagnostic-2026-08-02.json`

The peer record deliberately contains three incomparable boundaries. It must not
be converted into a cross-compiler speedup ratio.

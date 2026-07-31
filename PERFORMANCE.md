# Ducklang compiler performance

These measurements were recorded on 2026-07-30 and 2026-07-31 with:

- NVIDIA GeForce RTX 4080 SUPER, vendor `4318`, device `9986`;
- `WGPU_BACKENDS=vulkan` and `WGPU_POWER_PREF=high`;
- Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3;
- Linux 7.1.5-1-cachyos on x86-64;
- frozen Binned contract digest
  `8031077802b03700258d527d9a9d20addffe786b90111b5694cc5ff3a16a70d4`;
- gpupaper working tree based on `50423f5`.

Timings are advisory. The 2026-07-30 baseline reports p50 and p95 values from 15
samples in one process; the 2026-07-31 optimization audit reports warm medians
from five samples per target and mode. Exact work counts and emitted bytes are
deterministic contracts. GPU mode is authoritative for Core rewriting and Wasm
emission; CPU mode does not initialize WebGPU.

## Measurement model

Every Ducklang artifact carries a `profile` with:

- 23 non-overlapping top-level stages;
- parser, elaboration, type-analysis, specialization, and GPU-Core sub-stage
  details;
- total, accounted, and unattributed wall time;
- work volume, cache reuse, GPU queue wait, and submission and payload batch
  sizes;
- effect-row memberships, added capability operands, root capabilities,
  direct-state and CPS transformed regions and functions, handled performances,
  continuation captures, specialization retention, memo reuse, dirty-frontier
  work, and residual functions exposed to GPU operation parallelism.

Detail timings are children of their top-level stage and must not be added to
the top-level total again. The measured unattributed remainder stayed below 0.13
ms, so the profile covers effectively the complete compilation.

```sh
deno task benchmark:frontend
deno task benchmark:rebuild
deno task benchmark:break-even
deno task benchmark:peers
```

`benchmark:rebuild` distinguishes a cold compilation, an identical-source
rebuild, trailing and internal comment edits, a one-function edit, and a
dependency edit. It checks that semantic no-ops emit byte-identical Wasm.

## From-scratch warm compilation

The 2026-07-30 15-sample baseline predates the sharing-preserving specializer:

These runs intentionally omit a compilation session, so every semantic and
backend stage executes.

| Target    |       CPU |       GPU | Wasm bytes |
| --------- | --------: | --------: | ---------: |
| Editor    | 211.14 ms | 297.30 ms |     24,460 |
| Codex     |   1.086 s |   1.407 s |    283,648 |
| grep      |  72.85 ms | 311.20 ms |      3,911 |
| tar       | 159.18 ms | 256.93 ms |     26,106 |
| wav       |  65.85 ms | 152.88 ms |      2,520 |
| raytracer |  68.45 ms | 161.15 ms |      3,864 |

The current 2026-07-31 five-sample warm medians are:

| Target    |       CPU |       GPU | Wasm bytes |
| --------- | --------: | --------: | ---------: |
| Editor    | 158.00 ms | 257.49 ms |     24,460 |
| Codex     | 755.73 ms | 952.45 ms |    226,134 |
| grep      |  73.59 ms | 156.61 ms |      3,911 |
| tar       | 129.43 ms | 250.68 ms |     26,106 |
| wav       |  61.37 ms | 150.86 ms |      2,520 |
| raytracer |  65.07 ms | 163.76 ms |      3,864 |

The largest current CPU stages remain semantic:

- Editor: elaboration 41.08 ms, parsing 36.32 ms, and semantic fingerprinting
  13.33 ms;
- Codex: elaboration 252.85 ms, pre-comptime specialization 127.79 ms, and Wasm
  planning/emission 87.13 ms;
- grep: elaboration 57.42 ms.

The effect measurements expose the structural-lowering boundary. Editor has 10
row memberships, one root capability, one direct-state handler region, nine
direct-state functions, one handled performance, 138 added capability operands,
and no retained continuation captures. Codex has 11 row memberships and five
root capabilities, but no local handler region. Across all six applications
there are 23 row memberships, 10 root capabilities, 138 added capability
operands, one direct region, nine direct functions, no CPS regions or functions,
one handled performance, and no continuation captures. The emitted modules total
286,995 bytes.

A contemporaneous CPS-control run is the appropriate effect-lowering comparison
because unrelated targets showed substantial run-order noise despite identical
work counts. For Editor, direct state passing changed Core functions 175→101,
blocks 649→545, operations 1,611→1,341, and Wasm 33,602→24,460 bytes. CPU time
was statistically unresolved at 209.74→211.14 ms; GPU time was similarly close
at 299.96→297.30 ms. The deterministic work and code-size reductions are the
supported performance claim.

Single dirty compilations remain faster on CPU. On Editor the warm GPU path is
1.63× the CPU time; on Codex it is 1.26×. The GPU stages are useful validation
and batching boundaries, but these measurements do not justify moving effect
inference or handler lowering past the semantic CPU boundary.

Zero comptime jobs are not a proof that specialization is finished. The corpus
contains a zero-job program whose second pass exposes and eliminates the
compiler-only `:+` operator. Dirty compilations therefore retain both passes;
unchanged compilations avoid both through the stronger semantic artifact
identity.

### Demand-specialization audit

The 2026-07-31 five-sample audit added deterministic retention and frontier
counts. Timings remain advisory; the work counts below are stable across CPU and
GPU modes.

| Target    | Bindings input/demanded | Nodes input/demanded/residual | Keys/hits | Second frontier |
| --------- | ----------------------: | ----------------------------: | --------: | --------------: |
| Editor    |                   87/82 |             4,207/4,150/2,845 |      47/2 |           5/719 |
| Codex     |                  101/47 |          18,109/16,119/23,594 |     703/4 |             0/0 |
| grep      |                    27/7 |                   962/707/419 |       1/0 |             0/0 |
| tar       |                   47/23 |             4,897/4,411/3,220 |       0/0 |             0/0 |
| wav       |                   13/12 |                   270/269/215 |       0/0 |             0/0 |
| raytracer |                    13/9 |                   462/458/433 |       0/0 |             0/0 |

The second-frontier cell is bindings/nodes. Codex discards 54 bindings but
expands its residual program to 23,594 nodes, so specialization remains its
largest actionable frontend cost after elaboration.

### Specializer allocation audit

The before and after runs below used the same 2026-07-31 machine and five warm
samples. They isolate a theory-derived change: observation no longer constructs
HIR, unchanged rewrites retain immutable sharing, function summaries are
memoized by object identity, substitution is fused with rewriting, statically
unselected branches are skipped, and a clean comptime result omits the second
specialization call.

| Measurement                  |    Before |     After |   Change |
| ---------------------------- | --------: | --------: | -------: |
| Editor CPU total             | 176.60 ms | 158.00 ms |  -10.53% |
| Editor pre-specialization    |  23.86 ms |  12.08 ms |  -49.37% |
| Codex CPU total              | 985.18 ms | 755.73 ms |  -23.29% |
| Codex pre-specialization     | 240.45 ms | 127.79 ms |  -46.85% |
| Codex specialization rewrite | 176.46 ms |  91.08 ms |  -48.39% |
| Codex function lifting       |  43.83 ms |  24.99 ms |  -42.97% |
| Codex post-specialization    |  15.27 ms |      0 ms | -100.00% |

Codex's deterministic residual structure changed from 493 to 301 Core functions,
5,168 to 3,824 blocks, 16,412 to 12,956 operations, and 283,648 to 226,134 Wasm
bytes. These are reductions of 38.95%, 26.01%, 21.06%, and 20.28%. Residual
typed-HIR nodes fell only 7.08%, from 25,392 to 23,594. The mismatch locates the
removed waste: allocation-history duplicates were amplified during closure
lifting and backend lowering.

The final Codex specialization median decomposes into 0.80 ms demand discovery,
0.00 ms frontier construction at displayed precision, 91.08 ms rewriting, 24.99
ms lifting, 1.97 ms reachability, and 7.09 ms exact accounting. Rewriting now
accounts for 71.27% of the stage and remains the next optimization target. The
retention ledger itself costs 5.55% of the stage; disabling it would make
measurements less informative and is not yet justified.

The required-GPU release gate then compiled every target twice with GPU type
validation, authoritative Core rewriting, authoritative Wasm emission, CPU
differential comparison, engine validation, and byte determinism:

| Target    | GPU sample 1 | GPU sample 2 | Wasm bytes |
| --------- | -----------: | -----------: | ---------: |
| Editor    |    384.42 ms |    284.92 ms |     24,460 |
| Codex     |      1.042 s |    964.69 ms |    226,134 |
| grep      |    167.07 ms |    160.24 ms |      3,911 |
| tar       |    249.03 ms |    241.85 ms |     26,106 |
| wav       |    165.56 ms |    147.97 ms |      2,520 |
| raytracer |    149.43 ms |    149.78 ms |      3,864 |

These two release samples are a correctness gate, not a latency distribution.
All device-capacity preflights and the malformed-input rejection gate passed.

## Incremental rebuild

Each target and backend receives one explicit compilation session. The session
owns immutable content-addressed syntax, transitive module analysis, semantic
artifacts, and per-function backend artifacts.

| Target | CPU identical | CPU trailing comment | GPU identical | GPU trailing comment |
| ------ | ------------: | -------------------: | ------------: | -------------------: |
| Editor |       0.32 ms |              0.38 ms |       0.35 ms |              0.27 ms |
| Codex  |       1.05 ms |              1.03 ms |       1.04 ms |              1.00 ms |
| grep   |       0.26 ms |              0.25 ms |       0.33 ms |              0.32 ms |

The source revision cache retains the lowered AST, its final syntactically
significant byte, and semantic identities by host/backend context. Exact input
and edits confined to whitespace or `//` comments after that byte perform zero
classification, parser, AST-lowering, and semantic-fingerprint work. The Editor
CPU p95 was 2.93 ms for identical source and 0.52 ms for the trailing comment;
all outputs remained byte-identical.

An internal comment remains conservative and reparses: Editor took 46.17 ms CPU
and 44.37 ms GPU at p50, Codex about 5.5 ms, and grep 4.43–6.11 ms. This is the
remaining whole-source Baba boundary. A synthetic one-function edit took 0.83
ms, rebuilt one backend function, and reused two. A changed imported module took
0.71 ms while reusing the unchanged root syntax and one backend function.

When the root syntax does change, imported syntax and analyses remain reusable.
A module analysis key includes the frontend version, canonical path, source
hash, compile-time arguments, and the complete transitive import identity.
Changing a leaf invalidates its ancestors without invalidating unrelated
modules. Backend lowering uses a separate per-function identity, so an edit
rebuilds the changed function while retaining unchanged functions whose index
and layout environment are stable.

## Authoritative-GPU concurrency

`benchmark:break-even` compiles dirty grep roots concurrently without a
compilation session. Type unions, Core, and Wasm now queue before allocation.
Core and Wasm suballocate one shared buffer set per payload batch; type unions
use shared parent, equality, and readback buffers. Capacity overflow splits a
batch in stable order.

| Jobs | CPU / job | Latency GPU / job | Throughput GPU / job | Throughput GPU / CPU | Type/Core/Wasm pack |
| ---: | --------: | ----------------: | -------------------: | -------------------: | ------------------: |
|    1 |  70.42 ms |         155.55 ms |            161.46 ms |                 2.36 |               1/1/1 |
|    2 |  69.83 ms |         119.23 ms |            114.77 ms |                 1.70 |               2/2/2 |
|    4 |  69.08 ms |          94.35 ms |             94.79 ms |                 1.26 |               4/4/4 |
|    8 |  68.96 ms |          83.87 ms |             82.70 ms |                 1.22 |               7/7/7 |
|   16 |  67.29 ms |          78.00 ms |             78.24 ms |                 1.16 |            16/16/16 |

Latency mode flushes on the next scheduler turn. Throughput mode waits for at
most 2 ms, 16 jobs, or a capacity boundary. Compared with the previous eight-job
96.58 ms GPU result, throughput mode reaches 82.70 ms per job, a 14.4%
reduction. Single-job latency did not regress. No GPU break-even was observed
through 16 dirty grep compilations.

## Peer boundaries

`benchmark:peers` isolates unlike compiler boundaries instead of presenting one
leaderboard:

| Compiler | Boundary                            | Workload         |  Source |       p50 |       p95 |    Wasm |
| -------- | ----------------------------------- | ---------------- | ------: | --------: | --------: | ------: |
| gpupaper | Ducklang source to Wasm             | Binned grep      | 2,856 B | 157.86 ms | 191.92 ms | 3,911 B |
| blot     | Blot source to Wasm through gpufuck | tour             | 4,275 B |     error |     error |       — |
| gpufuck  | prepared Surface module to Wasm     | integer addition |    13 B |  11.98 ms |  12.54 ms |    37 B |

The gpufuck number excludes parsing, source semantics, and lowering and uses a
much smaller program. The source-to-Wasm rows include those stages and compile
different languages, so their absolute times describe their workloads rather
than equivalent compiler throughput.

The current Blot tour reaches gpufuck's Wasm backend and fails because
`WasmCoreIndex.weakHeadNormalForms` is absent when `expressionIsWhnf` reads it.
The peer harness records this external boundary as an error without discarding
the independent gpupaper and prepared-gpufuck samples. Its previous successful
Blot timing is no longer presented as current.

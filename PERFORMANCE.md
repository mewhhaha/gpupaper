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

Frontend summaries report the scalar median total separately. Stage attribution
comes from the observed profile nearest that median total, not independent
per-field medians; the selected stages, accounted time, and remainder therefore
belong to one real compilation and retain their accounting identity. Parser
sub-stage attribution uses the same observed-run rule. The break-even benchmark
alternates CPU-first and GPU-first pairs within every batch size and policy,
requires an even sample count, and uses the midpoint of the two central
observations as the even-sample median. This counterbalances first-order
run-order drift but does not remove autocorrelation or turn six or sixteen
samples into a population-level performance claim. The frontend comparison uses
six warm observations as three complete CPU-first/GPU-first pairs.

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

### Wasm emission work audit before hierarchical scan

The initial 2026-07-31 required-GPU audit exposed the Hillis–Steele scan cost.
`length` is the number of full-array length-dependency rounds, `scan` is the
number of full-array prefix rounds, and invocations include workgroup padding
across size, length, scan, and emission passes:

| Target    |   Atoms | Length | Scan | Invocations | Uniform output bound | Wasm bytes |
| --------- | ------: | -----: | ---: | ----------: | -------------------: | ---------: |
| Editor    |  23,923 |      2 |   15 |     454,784 |              239,232 |     24,460 |
| Codex     | 204,099 |      2 |   18 |   4,491,520 |            2,040,992 |    226,134 |
| grep      |   3,897 |      2 |   12 |      62,464 |               38,972 |      3,911 |
| tar       |  22,201 |      2 |   15 |     421,952 |              222,012 |     26,106 |
| wav       |   2,477 |      2 |   12 |      39,936 |               24,772 |      2,520 |
| raytracer |   3,851 |      2 |   12 |      62,464 |               38,512 |      3,864 |

The output buffer reserves ten bytes per atom even though actual modules use
only 10.03–11.76% of that capacity. Codex schedules 22 full-width passes and
reserves 9.03× its final byte count. These are deterministic work and capacity
counts. They identify two independent optimization candidates: a work-efficient
hierarchical scan reduces scheduled arithmetic, while kind-sensitive atom bounds
reduce memory without changing dispatch count.

The selected kind-sensitive bound sums 1 byte for byte atoms, 5 bytes for 32-bit
and length atoms, and 10 bytes for 64-bit atoms:

| Target    | Uniform bound | Kind bound | Reduction | Kind bound / Wasm |
| --------- | ------------: | ---------: | --------: | ----------------: |
| Editor    |       239,232 |     64,036 |    73.23% |             2.62× |
| Codex     |     2,040,992 |    557,308 |    72.69% |             2.46× |
| grep      |        38,972 |     10,096 |    74.09% |             2.58× |
| tar       |       222,012 |     61,112 |    72.47% |             2.34× |
| wav       |        24,772 |      6,416 |    74.10% |             2.55× |
| raytracer |        38,512 |      9,608 |    75.05% |             2.49× |

Codex saves 1,483,684 bytes in each of the output and readback buffers, or
2,967,368 bytes across both, without changing dispatches or emitted bytes.

The atom DAG is already available on the host, so a width-only level evaluation
can compute exact capacity without emitting bytes or synchronizing with the
device:

| Target    | Kind bound | Exact rounded | Further reduction | Padding |
| --------- | ---------: | ------------: | ----------------: | ------: |
| Editor    |     64,036 |        24,460 |            61.80% |       0 |
| Codex     |    557,308 |       226,136 |            59.42% |       2 |
| grep      |     10,096 |         3,912 |            61.25% |       1 |
| tar       |     61,112 |        26,108 |            57.28% |       2 |
| wav       |      6,416 |         2,520 |            60.72% |       0 |
| raytracer |      9,608 |         3,864 |            59.78% |       0 |

The GPU independently computes its final prefix and must match the exact host
measure. The six-target required-GPU gate passed byte differential and engine
validation. This changes capacity and host width work, not scan dispatches.

### Hierarchical Wasm scan

The subsequent hierarchical scan recursively scans 64-element blocks and
propagates block prefixes downward. The counts below are observed profile values
from one required-GPU differential compilation per frozen target:

| Target    | Old scan dispatches | New scan dispatches | Old invocations | New invocations | Reduction |
| --------- | ------------------: | ------------------: | --------------: | --------------: | --------: |
| Editor    |                  15 |                   5 |         454,784 |         144,448 |    68.24% |
| Codex     |                  18 |                   5 |       4,491,520 |       1,231,424 |    72.58% |
| grep      |                  12 |                   3 |          62,464 |          23,488 |    62.40% |
| tar       |                  15 |                   5 |         421,952 |         134,080 |    68.22% |
| wav       |                  12 |                   3 |          39,936 |          15,040 |    62.34% |
| raytracer |                  12 |                   3 |          62,464 |          23,488 |    62.40% |

The invocation metric counts scheduled GPU lanes. Section 7.4 of `PAPER.md` also
accounts for the six shared-memory addition steps within each upward lane; the
total scan work remains linear because the hierarchy is geometric.

The old scan used two full atom-width prefix buffers. The new scan uses one
full-width result and two alternating sum/prefix hierarchy pairs:

| Target    | Old scan bytes | New scan bytes | Reduction |
| --------- | -------------: | -------------: | --------: |
| Editor    |        191,384 |         98,748 |    48.40% |
| Codex     |      1,632,792 |        842,332 |    48.41% |
| grep      |         31,176 |         16,092 |    48.38% |
| tar       |        177,608 |         91,644 |    48.40% |
| wav       |         19,816 |         10,236 |    48.34% |
| raytracer |         30,808 |         15,908 |    48.36% |

These are deterministic execution and allocation counts, not a latency claim.
All six outputs remain byte-identical to CPU emission and validate in the Wasm
engine.

### Compacted Wasm length frontiers

Length atoms are sparse in every frozen plan. Grouping their indices by
dependency level removes full-array level filtering:

| Target    | Length atoms | Old length lanes | New length lanes | Length reduction | New total lanes |
| --------- | -----------: | ---------------: | ---------------: | ---------------: | --------------: |
| Editor    |          135 |           47,872 |              256 |           99.47% |          96,832 |
| Codex     |          348 |          408,320 |              448 |           99.89% |         823,552 |
| grep      |           17 |            7,808 |              128 |           98.36% |          15,808 |
| tar       |           20 |           44,416 |              128 |           99.71% |          89,792 |
| wav       |           14 |            4,992 |              128 |           97.44% |          10,176 |
| raytracer |           23 |            7,808 |              128 |           98.36% |          15,808 |

The previous dependency-level column transferred four bytes per atom. The
frontier transfers four bytes per length atom:

| Target    | Old metadata bytes | Frontier bytes | Reduction |
| --------- | -----------------: | -------------: | --------: |
| Editor    |             95,692 |            540 |    99.44% |
| Codex     |            816,396 |          1,392 |    99.83% |
| grep      |             15,588 |             68 |    99.56% |
| tar       |             88,804 |             80 |    99.91% |
| wav       |              9,908 |             56 |    99.43% |
| raytracer |             15,404 |             92 |    99.40% |

Each target has two nonempty levels. The profile counts above come from one
required-GPU differential compilation per target. They are deterministic work
and payload measurements, not latency samples.

The initial frontier still used two four-byte-per-atom range columns. Packing
range start and count beside each frontier atom ID changes total length metadata
from `8A + 4K` to `12K`:

| Target    | Index plus dense ranges | Complete frontier | Reduction |
| --------- | ----------------------: | ----------------: | --------: |
| Editor    |                 191,924 |             1,620 |    99.16% |
| Codex     |               1,634,184 |             4,176 |    99.74% |
| grep      |                  31,244 |               204 |    99.35% |
| tar       |                 177,688 |               240 |    99.86% |
| wav       |                  19,872 |               168 |    99.15% |
| raytracer |                  30,900 |               276 |    99.11% |

This removes transfer and storage only; dispatch and arithmetic counts are
unchanged.

### Compacted Core rewrite frontier

The current rewrite rules can match only `scalarBinary` operations. Dispatching
that stable opcode frontier gives:

| Target    | Operations | Candidates | Old lanes | New lanes | Lane reduction | Old output bytes | New output bytes |
| --------- | ---------: | ---------: | --------: | --------: | -------------: | ---------------: | ---------------: |
| Editor    |      1,341 |        169 |     1,344 |       192 |         85.71% |           10,728 |            1,352 |
| Codex     |     12,956 |      2,890 |    12,992 |     2,944 |         77.34% |          103,648 |           23,120 |
| grep      |        166 |         34 |       192 |        64 |         66.67% |            1,328 |              272 |
| tar       |      1,576 |        549 |     1,600 |       576 |         64.00% |           12,608 |            4,392 |
| wav       |        130 |         43 |       192 |        64 |         66.67% |            1,040 |              344 |
| raytracer |        229 |        103 |       256 |       128 |         50.00% |            1,832 |              824 |

The output columns are also the readback payload. Candidate IDs initially occupy
the rule column and are overwritten in place, so compaction adds no ninth
storage binding. The dense Core snapshot inputs remain unchanged. These are
deterministic profile counts, not latency samples.

Before removal, the GPU structural-validation pass was much larger than the
rewrite frontier:

| Target    | Validation records | Validation lanes | Validation bytes | Rewrite lanes |
| --------- | -----------------: | ---------------: | ---------------: | ------------: |
| Editor    |             33,157 |           33,216 |          530,512 |           192 |
| Codex     |            257,934 |          257,984 |        4,126,944 |         2,944 |
| grep      |              4,874 |            4,928 |           77,984 |            64 |
| tar       |             28,832 |           28,864 |          461,312 |           576 |
| wav       |              3,390 |            3,392 |           54,240 |            64 |
| raytracer |              5,495 |            5,504 |           87,920 |           128 |

The pass duplicated the stronger trusted CPU validator and was not part of
rewrite-certificate checking. It has now been deleted. An invalid flat-Core job
stops without requesting a device on its behalf; valid Core reaches only
proposal generation, whose results still undergo exact CPU semantic-certificate
checking and complete rebuild validation.

The table therefore gives the exact scheduled lanes and four-word record payload
removed per Core pass. The implementation also removes one error buffer, one
uniform parameter buffer, one compute pipeline and dispatch, and an eight-byte
readback prefix for a nonempty frontier. CPU validation is unchanged. These
deterministic savings do not by themselves establish a latency change.

The post-removal required-GPU correctness gate passed 493 tests and compiled
each frozen target twice:

| Target    | GPU sample 1 | GPU sample 2 | Wasm bytes |
| --------- | -----------: | -----------: | ---------: |
| Editor    |    377.55 ms |    270.31 ms |     24,460 |
| Codex     |      1.016 s |    847.40 ms |    226,134 |
| grep      |    158.37 ms |    159.59 ms |      3,911 |
| tar       |    241.54 ms |    218.52 ms |     26,106 |
| wav       |    141.88 ms |    134.10 ms |      2,520 |
| raytracer |    153.63 ms |    150.14 ms |      3,864 |

All bytes remained identical to CPU emission and passed engine validation. The
samples are integration evidence, not a controlled before/after experiment: they
do not isolate this pass from temperature, scheduling, or process-order effects.

### Scalar comptime stack capacity

The bytecode validator derives stack depth at every instruction. GPU scalar
comptime now allocates `4 × job_count × maximum_depth` bytes rather than the
fixed `256 × job_count` bound and reports both the selected depth and byte
count. `examples/all.hs` has one scalar job at depth 2: its stack arena is 8
bytes rather than 256 bytes, a 96.875% reduction. Both evaluators return 42.
This exact capacity result does not imply a latency improvement at one job.

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

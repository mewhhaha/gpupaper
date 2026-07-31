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

- 22 non-overlapping top-level stages;
- parser, elaboration, type-analysis, specialization, and GPU-Core sub-stage
  details;
- total, accounted, and unattributed wall time;
- work volume, cache reuse, GPU queue wait, and submission and payload batch
  sizes;
- effect-row memberships, added capability operands, root capabilities,
  direct-state and CPS transformed regions and functions, handled performances,
  continuation captures, specialization retention, memo reuse, dirty-frontier
work, and residual functions exposed to GPU operation parallelism.

The standalone GPU type conformance result separately reports flattening,
closure, union/readback, and cycle timings plus its exact term and equality work.
Production compilation no longer invokes that experiment.

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

### Resolved Wasm offsets

The exact-capacity host analysis already resolves every atom width and nested
length. Recording its partial sums as `A + 1` byte boundaries makes the GPU
size, length, and hierarchical-scan passes redundant. The GPU now runs only the
parallel emission frontier:

| Target    |   Atoms | Previous lanes | Emission lanes | Lane reduction | Offset bytes |
| --------- | ------: | -------------: | -------------: | -------------: | -----------: |
| Editor    |  23,923 |         96,832 |         23,936 |         75.28% |       95,696 |
| Codex     | 204,099 |        823,552 |        204,160 |         75.21% |      816,400 |
| grep      |   3,897 |         15,808 |          3,904 |         75.30% |       15,592 |
| tar       |  22,201 |         89,792 |         22,208 |         75.27% |       88,808 |
| wav       |   2,477 |         10,176 |          2,496 |         75.47% |        9,912 |
| raytracer |   3,851 |         15,808 |          3,904 |         75.30% |       15,408 |

The preceding hierarchical-scan and compacted-length sections are retained as
the measured path by which the redundant work was identified; this section
supersedes their implementation status. Three shader modules and four pipelines
are deleted. Five storage bindings remain: atom kind, low word, high word,
resolved offsets, and output.

Let `K` be the length-atom count, `H` the total non-root hierarchy words, `J`
the nonempty length levels, and `h` the hierarchy depth. Relative to the
immediately preceding implementation, logical device capacity falls by:

```text
4A + 12K + 8(H + 2) + 16(|J| + 2h - 1)
```

This is 10,484–846,612 bytes across the frozen targets. Packed-region alignment
is additional physical capacity. The byte differential, shared-word packed
regression, sparse-level regression, and engine validator test correctness.
Counts are deterministic; latency still requires counterbalanced samples.

### Packed Wasm atom tags

Five atom variants need three information bits. Eight four-bit tags now share
one `u32`, preserving one-word random access with shifts and masks. The kind
column falls from `4A` to `4 ceil(A / 8)` bytes:

| Target    |   Atoms | Old atom input | Packed atom input | Bytes removed | Reduction |
| --------- | ------: | -------------: | ----------------: | ------------: | --------: |
| Editor    |  23,923 |        382,772 |           299,044 |        83,728 |    21.87% |
| Codex     | 204,099 |      3,265,588 |         2,551,244 |       714,344 |    21.87% |
| grep      |   3,897 |         62,356 |            48,720 |        13,636 |    21.87% |
| tar       |  22,201 |        355,220 |           277,520 |        77,700 |    21.87% |
| wav       |   2,477 |         39,636 |            30,968 |         8,668 |    21.87% |
| raytracer |   3,851 |         61,620 |            48,144 |        13,476 |    21.87% |

Atom input includes packed kinds, two `u32` value columns, and the `A + 1`
resolved offsets. It excludes output/readback and packed-job alignment. The
intermediate formula was `8A + 4(A + 1) + 4 ceil(A / 8)`; the adaptive high-word
section below supersedes it. Dispatch count and scheduled lanes were unchanged.

### Adaptive signed64 high words

Kind-distribution measurement found no signed-64 atom in any frozen target:

| Target    |    Byte | Unsigned | Signed32 | Signed64 | Length |
| --------- | ------: | -------: | -------: | -------: | -----: |
| Editor    |  13,895 |    8,490 |    1,403 |        0 |    135 |
| Codex     | 115,797 |   74,128 |   13,826 |        0 |    348 |
| grep      |   2,348 |    1,254 |      278 |        0 |     17 |
| tar       |  12,474 |    8,414 |    1,293 |        0 |     20 |
| wav       |   1,493 |      784 |      186 |        0 |     14 |
| raytracer |   2,412 |    1,217 |      199 |        0 |     23 |

The emitter now chooses dense `4A` high words when `2S >= A`; otherwise it
stores sorted `(atom_id, high_word)` pairs in `8S` bytes. Thus high-word
capacity is `min(4A, 8S)` and never exceeds the prior representation. Sparse
lookup is a binary search executed only by the `S` signed-64 lanes.

| Target    | Previous atom input | Adaptive atom input | Bytes removed | Reduction |
| --------- | ------------------: | ------------------: | ------------: | --------: |
| Editor    |             299,044 |             203,352 |        95,692 |    32.00% |
| Codex     |           2,551,244 |           1,734,848 |       816,396 |    32.00% |
| grep      |              48,720 |              33,132 |        15,588 |    32.00% |
| tar       |             277,520 |             188,716 |        88,804 |    32.00% |
| wav       |              30,968 |              21,060 |         9,908 |    32.00% |
| raytracer |              48,144 |              32,740 |        15,404 |    32.00% |

The logical atom-input formula is now
`4A + 4(A + 1) + 4 ceil(A / 8) + min(4A, 8S)`. A physical empty frontier still
reserves the four-byte WebGPU binding minimum. Sparse and dense signed-64
regressions compare extrema byte-for-byte with CPU emission. No dispatch is
added.

### Deferred ranked low words

Packing byte values while retaining random access requires a packed byte stream,
a non-byte stream, and one exclusive byte rank per eight atom tags. Its exact
logical size is `4 ceil(B / 4) + 4(A - B) + 4 ceil(A / 8)`, versus the current
`4A` low-word column.

| Target    | Byte atoms | Dense low bytes | Ranked low bytes | Bytes saved | Total-input reduction |
| --------- | ---------: | --------------: | ---------------: | ----------: | --------------------: |
| Editor    |     13,895 |          95,692 |           65,972 |      29,720 |                14.62% |
| Codex     |    115,797 |         816,396 |          571,060 |     245,336 |                14.14% |
| grep      |      2,348 |          15,588 |           10,496 |       5,092 |                15.37% |
| tar       |     12,474 |          88,804 |           62,488 |      26,316 |                13.94% |
| wav       |      1,493 |           9,908 |            6,672 |       3,236 |                15.37% |
| raytracer |      2,412 |          15,404 |           10,096 |       5,308 |                16.21% |

The capacity condition is satisfied, but lookup adds two storage bindings and up
to seven within-word tag comparisons in every emission lane. This alternative is
not implemented. A counterbalanced kernel benchmark must show that the
13.94–16.21% total-input reduction pays for the certain extra work before it can
replace the dense column.

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
storage binding. At this intermediate measurement, dense Core snapshot inputs
remained unchanged; the candidate-local descriptor section below supersedes that
representation. These are deterministic profile counts, not latency samples.

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

### Empty Core rewrite frontier

When the stable `scalarBinary` frontier is empty, the exact matcher domain is
empty. The pass now returns the validated input before GPU context acquisition.
It avoids five derived host tables totaling
`32 × operations + 20 × attributes + 16 × values + 8 × types` typed-array bytes,
including the temporary zero attribute column, plus ten device buffers, one
empty command submission, and one eight-byte map.

The constant-only single-job regression reports zero initialization, transfer,
GPU, commit, submission, candidates, and proposals. A two-job throughput
regression reports one logical payload batch but zero physical submissions for
both results. These are executable zero-work invariants, not timing samples.
Every frozen target has a nonempty frontier, so the six-target release table is
unaffected.

### Candidate-local Core descriptors

The current matcher reads a fixed projection of each candidate and at most two
constant definitions. A 20-word descriptor now carries exactly those fields.
The CPU frontier admits only the structural heads of the implemented integer
add-zero and multiply-one rules; the GPU still decides exact constant identity,
orientation, and replacement. The CPU checks every resulting certificate
against the complete immutable snapshot.

For operations `O`, operands `E`, attributes `A`, values `V`, types `T`, and
candidates `C`, logical device capacity changes from
`32O + 4E + 16A + 16V + 8T + 16C + 24` to `96C + 4`. Derived host typed-array
allocation changes from `32O + 20A + 16V + 8T + 4C` to `84C`.

| Target    | Old host bytes | Descriptor host bytes | Host reduction | Old device bytes | Descriptor device bytes | Device reduction |
| --------- | -------------: | --------------------: | -------------: | ---------------: | ----------------------: | ---------------: |
| Editor    |         95,316 |                14,196 |         85.11% |           99,000 |                  16,228 |           83.61% |
| Codex     |        908,316 |               242,760 |         73.27% |          956,080 |                 277,444 |           70.98% |
| grep      |         12,624 |                 2,856 |         77.38% |           13,112 |                   3,268 |           75.08% |
| tar       |        111,756 |                46,116 |         58.74% |          120,620 |                  52,708 |           56.30% |
| wav       |          9,436 |                 3,612 |         61.72% |            9,968 |                   4,132 |           58.55% |
| raytracer |         16,824 |                 8,652 |         48.57% |           18,208 |                   9,892 |           45.67% |

Storage bindings fall from eight to three. Profile invariants require exactly
`80C` descriptor bytes and `96C + 4` logical device bytes for every nonempty
frontier. Packed alignment is additional physical capacity. These are
deterministic capacity measurements; latency still requires a counterbalanced
benchmark.

### Rule-head Core frontier

The former `scalarBinary` frontier was wider than the actual rule domain.
Filtering by the shared structural rule head—binary arity, add/multiply
operator, integer result, and the existence of a constant operand—is complete
because every successful rule match has those properties. It does not inspect
the constant payload, emit a rule, or select a replacement.

| Target    | Candidates before → after | Descriptor bytes before → after | Lanes before → after |
| --------- | ------------------------: | ------------------------------: | -------------------: |
| Editor    |                  169 → 15 |                   13,520 → 1,200 |             192 → 64 |
| Codex     |               2,890 → 963 |                 231,200 → 77,040 |         2,944 → 1,024 |
| grep      |                    34 → 3 |                      2,720 → 240 |              64 → 64 |
| tar       |                 549 → 257 |                  43,920 → 20,560 |            576 → 320 |
| wav       |                    43 → 4 |                      3,440 → 320 |              64 → 64 |
| raytracer |                   103 → 0 |                        8,240 → 0 |              128 → 0 |

Tar retains its 24 proposals; the other five targets retain zero. The reduction
therefore discards only failed matches and preserves optimized Core. Candidate
order remains source order, and direct rewrite tests retain two positive matches
plus a structurally admitted non-identity constant that the GPU rejects.
Raytracer now reports `core=identity`, zero Core submissions, and zero Core GPU
time instead of claiming a GPU backend for the host-proved empty frontier.

### Scalar comptime stack capacity

The standalone GPU bytecode conformance evaluator derives stack depth at every
instruction and allocates `4 × job_count × maximum_depth` bytes rather than the
fixed `256 × job_count` bound. `examples/all.hs` has one scalar job at depth 2:
its stack arena is 8 bytes rather than 256 bytes, a 96.875% reduction. Both
evaluators return 42. Production compilation no longer invokes this differential
evaluator, so this remains a conformance-capacity result rather than a release
latency claim.

### Production scalar comptime boundary

Only Editor among the six frozen applications presented scalar bytecode to the
GPU validation path: four jobs. Codex, grep, tar, wav, and raytracer presented
zero and returned through the evaluator's identity case before device
acquisition. The GPU values were reported but never consumed by specialization,
Core lowering, or emission. Production compilation now retains the CPU scalar
bytecode comparison against the general constant evaluator and discards the GPU
replay. Editor therefore removes one submission and one mapped readback; the
other five targets remove no physical GPU work.

A five-sample post-change run observed comptime-stage medians of 2.85, 10.81,
0.27, 0.56, 0.04, and 0.08 ms for Editor, Codex, grep, tar, wav, and raytracer.
This enclosing stage includes general constant evaluation and replacement, and
the samples are unpaired and noisy; they are not evidence for a causal latency
delta. The exact evidence is the removed dependency and physical operations.

### Empty type equality set

An empty equality list contains no reachable term, so its least congruence and
representative vector are uniquely empty. The solver now returns before adapter
acquisition with zero terms, equations, union rounds, decompositions, and
physical submissions. The logical batch queue remains observable.

The regression does not skip when WebGPU is unavailable. The former path had
already stopped before pipeline construction or buffer allocation, so the exact
removed work is one device request/cache selection rather than a kernel or byte
count. Frozen application type graphs are nonempty; no release timing change is
claimed.

### Certified type-closure boundary

The type solver now uses one algorithm at every nonempty graph size. The CPU
derives the least constructor congruence and diagnostic provenance; one GPU
union/compression submission validates the complete closed equality set; the CPU
requires exact representatives and checks the sparse quotient graph for cycles.
The former at-most-64-term branch allocated a quadratic constructor-pair
frontier and used cubic scheduled work for dense reachability.

Frozen required-GPU profiles before the removal showed that no application
entered that branch:

| Target    | Source equalities | Flat terms | Closed equalities | Child-equation work | GPU union rounds |
| --------- | ----------------: | ---------: | ----------------: | ------------------: | ---------------: |
| Editor    |             3,556 |      1,706 |             3,838 |               8,035 |                1 |
| Codex     |            25,358 |     11,593 |            28,138 |              83,484 |                1 |
| grep      |             1,164 |        773 |             1,292 |               2,528 |                1 |
| tar       |             7,888 |      3,838 |             9,174 |              24,102 |                1 |
| wav       |               241 |         99 |               264 |                 180 |                1 |
| raytracer |               292 |         86 |               292 |                  72 |                1 |

The first six-warm-sample run with the decomposed type profile selected these
real observations nearest each target's median GPU total:

| Target    | Flatten | CPU closure | GPU union | Cycle check | Constructor comparisons |
| --------- | ------: | ----------: | --------: | ----------: | ----------------------: |
| Editor    | 3.85 ms |     7.57 ms |  28.84 ms |     0.39 ms |                   4,176 |
| Codex     | 24.78 ms |  131.60 ms |  31.74 ms |     2.04 ms |                  41,971 |
| grep      | 1.29 ms |     1.67 ms |  28.22 ms |     0.18 ms |                   1,264 |
| tar       | 12.59 ms |   24.85 ms |  30.30 ms |     0.48 ms |                  12,051 |
| wav       | 0.21 ms |     0.15 ms |  29.30 ms |     0.02 ms |                      90 |
| raytracer | 0.20 ms |     0.09 ms |  28.77 ms |     0.02 ms |                      36 |

These are observed-run diagnostics, not independent field medians or a
before/after experiment. They distinguish a roughly 29–32 ms submission/readback
floor from corpus-dependent CPU closure. In particular, Codex closure is now a
measured optimization target; changing GPU dispatch cannot remove its 131.60 ms
sample.

An eager union-find constructor-witness worklist then replaced repeated global
frontiers:

| Target    | Comparisons before → after | Proposal reduction | Certificate reduction | CPU closure before → after |
| --------- | -------------------------: | -----------------: | --------------------: | ------------------------: |
| Editor    |                4,176 → 711 |             82.99% |                 3.07% |            7.57 → 1.39 ms |
| Codex     |             41,971 → 5,276 |             87.43% |                 2.38% |         131.60 → 27.41 ms |
| grep      |                1,264 → 266 |             78.96% |                 4.41% |            1.67 → 1.07 ms |
| tar       |             12,051 → 1,738 |             85.58% |                 1.17% |           24.85 → 4.05 ms |
| wav       |                    90 → 45 |             50.00% |                 0.00% |            0.15 → 0.09 ms |
| raytracer |                    36 → 36 |              0.00% |                 0.00% |            0.09 → 0.11 ms |

The two columns of timings come from separate six-warm-sample runs, so they are
advisory rather than paired confidence intervals. Exact counts do not have that
qualification. Raytracer performed identical work and moved by 0.019 ms, below a
useful timing resolution. Codex's enclosing GPU type stage fell from 193.46 to
80.53 ms in the selected observations; the approximately 28–32 ms GPU
submission/readback floor remains.

Production compilation then removed the conformance call entirely because none
of its output reached types, Core, or Wasm:

| Target    | Removed logical bytes | Removed scheduled lanes | Previously observed stage |
| --------- | --------------------: | ----------------------: | ------------------------: |
| Editor    |                43,408 |                   5,504 |                  33.08 ms |
| Codex     |               312,480 |                  39,168 |                  80.53 ms |
| grep      |                16,064 |                   2,112 |                  34.02 ms |
| tar       |               103,240 |                  12,928 |                  41.19 ms |
| wav       |                 2,904 |                     448 |                  30.22 ms |
| raytracer |                 3,024 |                     448 |                  30.91 ms |

Each row also removes one command submission, one mapped readback, CPU
flatten/closure/cycle work, and exact representative comparison. The byte and
lane counts follow \(8(T+M)\) and
\(64\lceil M/64\rceil+64\lceil T/64\rceil\) from Section 7.5. The timing column
is the real pre-removal observation selected by the six-sample harness; it
measures removed sequential work but is not a paired end-to-end speedup.

The post-removal 499-test release gate compiled every target twice:

| Target    | Required GPU sample 1 | Required GPU sample 2 |
| --------- | --------------------: | --------------------: |
| Editor    |             377.01 ms |             263.53 ms |
| Codex     |               1.101 s |             919.52 ms |
| grep      |             138.70 ms |             135.17 ms |
| tar       |             203.80 ms |             208.31 ms |
| wav       |             123.57 ms |             120.82 ms |
| raytracer |             129.01 ms |             129.71 ms |

Every pair emitted byte-identical Wasm and passed engine validation. Two release
samples establish correctness and budget compliance, not a latency
distribution.

The earlier dense-branch removal left frozen production work unchanged because
all targets already used certified CPU closure, one GPU union/compression
submission, and sparse CPU cycle detection. Its deterministic reduction was
implementation surface—four shader pipelines and 955 source lines—and removal
of an unused \(T^2/T^3\) resource hazard. Compatible, clashing, cyclic, deep,
concurrent, and generated differential cases preserved their results through
both changes. The post-worklist required-GPU gate passed 499 tests and compiled
all six targets twice with byte-identical emission and engine validation.

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
compilation session. Core and Wasm queue before allocation and suballocate one
shared buffer set per payload batch. Capacity overflow splits a batch in stable
order.

| Jobs | Latency CPU / job | Latency GPU / job | Throughput CPU / job | Throughput GPU / job | Throughput GPU / CPU | Throughput Core/Wasm pack |
| ---: | ----------------: | ----------------: | -------------------: | -------------------: | -------------------: | ------------------------: |
|    1 |         121.17 ms |         171.97 ms |            124.52 ms |            189.30 ms |                 1.520 |                       1/1 |
|    2 |         110.12 ms |         138.64 ms |            111.50 ms |            138.43 ms |                 1.242 |                       2/2 |
|    4 |         122.88 ms |         129.19 ms |            109.72 ms |            123.96 ms |                 1.130 |                       3/3 |
|    8 |         103.28 ms |         119.32 ms |            108.68 ms |            111.67 ms |                 1.027 |                       5/5 |
|   16 |         105.36 ms |         115.40 ms |            111.31 ms |            112.98 ms |                 1.015 |                       8/8 |

Latency mode flushes on the next scheduler turn. Throughput mode waits for at
most 2 ms, 16 jobs, or a capacity boundary. After removing production type
validation, throughput GPU/CPU falls from 1.520 at one job to 1.015 at sixteen;
no break-even was observed. Absolute times are materially higher than the prior
sweep for both CPU and GPU, so the ratio and exact pack sizes are more useful
than cross-sweep latency subtraction.

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

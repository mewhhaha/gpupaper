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
deno task benchmark:wasm
deno task benchmark:peers
```

`benchmark:rebuild` distinguishes a cold compilation, an identical-source
rebuild, trailing and internal comment edits, a one-function edit, and a
dependency edit. It checks that semantic no-ops emit byte-identical Wasm.
`benchmark:wasm` constructs each frozen target's final plan once, performs one
unrecorded warm emission per low-word layout, and measures 21 dense/ranked pairs
while alternating both layout order and forward/reverse target order. Its
boundary starts before host plan analysis and ends after mapped GPU readback and
the final byte copy. Every observation must equal the independently emitted CPU
artifact.

The first isolated run, before paired layout selection was added, established
the dense-low-word baseline used to size the rank/select experiment:

| Target    | Median |   p95 | Minimum | Maximum |
| --------- | -----: | ----: | ------: | ------: |
| Editor    |  27.99 | 28.74 |   26.78 |   28.90 |
| Codex     |  37.09 | 38.36 |   34.34 |   43.73 |
| grep      |  27.01 | 27.18 |   26.02 |   27.35 |
| tar       |  27.76 | 28.02 |   27.55 |   28.02 |
| wav       |  26.96 | 27.19 |   26.41 |   27.19 |
| raytracer |  27.02 | 27.16 |   26.86 |   27.20 |

Times are milliseconds. The near-constant 27 ms small-plan floor includes host
packing, one submission, mapping, readback, and the copied result; it is not
evidence that kernel work itself takes 27 ms.

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

The current 2026-07-31 six-sample warm medians are:

| Target    |       CPU |       GPU | Wasm bytes |
| --------- | --------: | --------: | ---------: |
| Editor    |  96.94 ms | 146.89 ms |     24,460 |
| Codex     | 533.56 ms | 604.18 ms |    226,134 |
| grep      |  14.24 ms |  69.82 ms |      3,911 |
| tar       |  70.87 ms | 128.32 ms |     26,106 |
| wav       |   9.10 ms |  63.07 ms |      2,520 |
| raytracer |  12.45 ms |  43.44 ms |      3,864 |

The largest remaining CPU costs are target-specific. Editor retains its root
parser and semantic passes. Codex retains two ordinary local-module parses,
specialization of 703 distinct keys, and a 23,594-node residual program. The
former near-constant 50 ms small-target elaboration floor was bundled-prelude
parsing and is removed below.

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
1.52× the CPU time; on Codex it is 1.13×. The GPU stages are useful validation
and batching boundaries, but these measurements do not justify moving effect
inference or handler lowering past the semantic CPU boundary.

Zero comptime jobs are not a proof that specialization is finished. The corpus
contains a zero-job program whose second pass exposes and eliminates the
compiler-only `:+` operator. Dirty compilations therefore retain both passes;
unchanged compilations avoid both through the stronger semantic artifact
identity.

### Bounded bundled-prelude syntax reuse

Independent compilations formerly created independent syntax caches for every
imported module. The compiler now process-shares only its fixed bundled
preludes. The key is canonical path plus source hash; one changed source
replaces that path's old entry. User modules and custom prelude directories
remain compilation/session-scoped, bounding shared retention to 23 ASTs.

| Target    | Bundled analyses before → after | Import resolution before → after | CPU median before → after | Reduction |
| --------- | --------------------------------: | -------------------------------: | ------------------------: | --------: |
| Editor    |                            4 → 0 |                  25.79 → 1.41 ms |        140.56 → 114.37 ms |    18.64% |
| Codex     |                            9 → 0 |                160.90 → 24.53 ms |        648.89 → 514.93 ms |    20.64% |
| grep      |                            3 → 0 |                   50.60 → 0.81 ms |          64.60 → 14.63 ms |    77.36% |
| tar       |                            3 → 0 |                   51.00 → 0.74 ms |         116.08 → 68.12 ms |    41.32% |
| wav       |                            2 → 0 |                   51.80 → 0.81 ms |           60.69 → 7.73 ms |    87.26% |
| raytracer |                            2 → 0 |                   50.73 → 0.44 ms |          63.03 → 11.60 ms |    81.60% |

Codex still performs two analyses for ordinary local modules; the table counts
only the nine avoided bundled analyses. Across the batch, all 23 bundled
analyses disappear. The six-sample benchmark alternates CPU/GPU order and
selects a real profile nearest each median. The consecutive before/after runs
are consistent with the exact analysis counts but are not a counterbalanced
causal experiment. A no-session regression requires zero second-compilation
analysis, positive reuse, and byte-identical Wasm. The 505-test required-GPU
gate passed and compiled every frozen target twice.

### Contextual-classifier substring audit

The old contextual scan requested a suffix and a trimmed prefix at every source
position. Their combined logical extent is exactly \(n^2\) characters even if a
particular JavaScript engine represents some substrings as views. The current
scan dispatches anchored sticky patterns by their necessary first character,
and computes dotted and record context only at `.` and `{`.

Thirty-one warm Editor-root observations after one unrecorded warmup produced:

| Syntax component          | Before |  After | Change |
| ------------------------- | -----: | -----: | -----: |
| Contextual classification | 18.476 |  4.670 | -74.73% |
| Generated parser          |  6.901 |  6.917 |  +0.23% |
| AST lowering              | 10.077 | 10.775 |  +6.93% |
| Complete syntax stage     | 25.349 | 11.845 | -53.27% |

Times are milliseconds. The AST movement is not attributed to the classifier;
the runs were consecutive separate-worktree measurements rather than
counterbalanced pairs. The executable contract is length and span preservation
plus identical acceptance and output over every vendored and frozen source.
The focused syntax, frozen-target, and corpus-contract suites passed 94 tests.

The subsequent six-sample alternating frontend benchmark changed CPU medians
from 114.37 to 103.66 ms for Editor, 514.93 to 506.72 ms for Codex, 14.63 to
13.26 ms for grep, 68.12 to 66.40 ms for Tar, 7.73 to 7.55 ms for wav, and
11.60 to 11.37 ms for raytracer. The observed reductions range from 1.59% to
9.36%; they are consistent with the isolated classifier result but are not a
causal estimate. The required-GPU release gate passed 505 tests and compiled
all six targets twice with byte-identical Wasm and engine validation.

The next audit commuted arrow recognition's pure lexical and context predicates.
For the Editor root, letter-headed positions \(H=14,945\), bare-context
candidates \(B=858\), lexical arrow spellings \(M=147\), and accepted
intersections \(K=11\). Complete-prefix logical extent therefore falls from
10,153,696 to 178,601 characters, or 98.24%.

| Syntax component          | Lexical last | Lexical first | Change |
| ------------------------- | -----------: | ------------: | -----: |
| Contextual classification |        4.670 |         1.455 | -68.84% |
| Generated parser          |        6.917 |         7.033 |  +1.68% |
| AST lowering              |       10.775 |        12.202 | +13.24% |
| Complete syntax stage     |       11.845 |         8.613 | -27.29% |

These are 31 warm observations after one unrecorded warmup. Parser and AST
movements are not attributed to the classifier. The subsequent full frontend
run measured 98.09/153.37 ms CPU/GPU for Editor, 513.01/587.65 for Codex,
13.72/70.24 for grep, 66.26/122.54 for Tar, 7.43/64.31 for wav, and
11.72/42.18 for raytracer. Mixed changes outside Editor are run noise; the
isolated classifier and exact discarded work support the optimization.

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

### Scoped specialization environments

Block rewriting formerly constructed `new Map(parentValues)` for every lexical
block. Globally unique resolved symbol IDs permit a stack-disciplined
insert/rewrite/restore environment with identical lookup results. Restoring
prior entries also preserves nested re-entry of one source body. The profile
now exposes the exact counterfactual constructor work:

| Target    | Rewritten blocks | Avoided entry copies |
| --------- | ---------------: | -------------------: |
| Editor    |              827 |               57,311 |
| Codex     |            6,828 |              412,890 |
| grep      |               93 |                1,267 |
| tar       |              480 |               22,293 |
| wav       |               27 |                  210 |
| raytracer |               47 |                  492 |

The batch avoids 494,463 transient entry copies. An 11-sample Codex CPU
comparison after one warmup used the current tree and a detached `d7357e7`
worktree concurrently:

| Measurement              | Map clone | Scoped map | Change |
| ------------------------ | --------: | ---------: | -----: |
| Pre-specialization       |   119.946 |    108.074 |  -9.90% |
| Specialization rewrite   |    86.252 |     74.484 | -13.64% |
| Function lifting         |    24.195 |     25.665 |  +6.08% |
| Ledger accounting        |     6.621 |      7.409 | +11.91% |
| Complete CPU compilation |   553.295 |    549.178 |  -0.74% |

Times are milliseconds. Exact outputs and residual work were unchanged.
Opposite movements in lifting and accounting limit the attribution to the
rewrite and stage-local reductions. The following six-sample frontend run
reported 6,828 blocks and 412,890 avoided copies in its representative Codex
profile; its 533.56 ms CPU median illustrates the larger run-to-run variance.
The 506-test required-GPU gate passed and compiled all six targets twice with
byte-identical Wasm and engine validation.

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
are deleted. The later ranked-low-word section supersedes this section's
five-binding count.

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

### Adaptive Wasm offset width

Every resolved boundary is at most the final Wasm byte length. Modules no larger
than 65,535 bytes therefore pack two lossless u16 boundaries per storage word;
larger modules retain direct u32 indexing.

| Target    | Width | Offset bytes before → after | Atom input before → after |
| --------- | ----: | --------------------------: | ------------------------: |
| Editor    |    16 |             95,696 → 47,848 |         203,352 → 155,504 |
| Codex     |    32 |           816,400 → 816,400 |     1,734,848 → 1,734,848 |
| grep      |    16 |              15,592 → 7,796 |           33,132 → 25,336 |
| tar       |    16 |             88,808 → 44,404 |         188,716 → 144,312 |
| wav       |    16 |               9,912 → 4,956 |           21,060 → 16,104 |
| raytracer |    16 |              15,408 → 7,704 |           32,740 → 25,036 |

Across the frozen applications, resolved-offset input falls 1,041,816→929,108
bytes (10.82%) and total atom input falls 2,213,848→2,101,140 bytes (5.09%).
The narrow path adds lane-local shifts and masks but no pass, dispatch, binding,
or synchronization. Boundary tests pin u16 selection at exactly 65,535 output
bytes and u32 selection at 65,536. The post-change required-GPU release gate
passed 500 tests and compiled all six frozen targets twice; its samples are
recorded in the corresponding continuous-paper entry. They are correctness
observations rather than a counterbalanced latency experiment.

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

Kind construction originally performed one typed-array read/modify/write per
atom despite producing only one word per eight atoms. Accumulating disjoint
nibbles locally changes host kind-column stores as follows:

| Target    | Per-atom stores | Group stores | Reduction |
| --------- | --------------: | -----------: | --------: |
| Editor    |          23,923 |        2,991 |    87.50% |
| Codex     |         204,099 |       25,513 |    87.50% |
| grep      |           3,897 |          488 |    87.48% |
| tar       |          22,201 |        2,776 |    87.50% |
| wav       |           2,477 |          310 |    87.48% |
| raytracer |           3,851 |          482 |    87.48% |

This changes no allocation, transfer, dispatch, or shader work. Successive
isolated emitter runs moved by less than 2.3%; they were not interleaved
implementation pairs, so no latency improvement is claimed. The exact grouped
writer passed the 501-test required-GPU gate and compiled every frozen target
twice.

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

### Adaptive ranked low words

Packing byte values while retaining random access uses a packed byte stream, a
non-byte stream, and one exclusive byte rank per eight atom tags. Its exact
logical size is `4 ceil(B / 4) + 4(A - B) + 4 ceil(A / 8)`, versus the dense
`4A` low-word column.

| Target    | Dense input | Ranked input | Bytes saved | Reduction |
| --------- | ----------: | -----------: | ----------: | --------: |
| Editor    |     155,504 |      125,784 |      29,720 |    19.11% |
| Codex     |   1,734,848 |    1,489,512 |     245,336 |    14.14% |
| grep      |      25,336 |       20,244 |       5,092 |    20.10% |
| tar       |     144,312 |      117,996 |      26,316 |    18.24% |
| wav       |      16,104 |       12,868 |       3,236 |    20.09% |
| raytracer |      25,036 |       19,728 |       5,308 |    21.20% |

Adaptive selection uses ranked only when this logical input is strictly smaller;
dense wins ties. Lookup adds two storage bindings. The first implementation
counted the preceding zero tags with a divergent zero-to-seven-iteration loop. A
later bit-parallel decoder ORs four shifted copies of the kind word, masks one
zero-test bit per nibble, and applies `countOneBits` to the preceding prefix.
The table below is the 21-pair loop-decoder experiment:

| Target    | Dense median/p95 | Ranked median/p95 | Ranked/dense median |
| --------- | ---------------: | ----------------: | ------------------: |
| Editor    |      27.73/28.81 |       27.84/28.48 |              1.0040 |
| Codex     |      34.82/36.72 |       34.50/35.18 |              0.9907 |
| grep      |      27.15/27.62 |       27.08/27.71 |              0.9975 |
| tar       |      27.76/28.33 |       27.67/28.63 |              0.9968 |
| wav       |      27.03/27.59 |       27.05/27.46 |              1.0007 |
| raytracer |      27.10/27.68 |       27.08/27.69 |              0.9992 |

Times are milliseconds. The ratios lie within ±0.40%; this run detects no
material latency change. Adaptive ranked storage is accepted for its strict
capacity reduction, not a claimed speedup. Forced-layout byte differentials and
mixed-layout packed batches retain dense as an executable fallback. The
post-change required-GPU gate passed 500 tests and compiled all frozen targets
twice; exact samples are recorded in the continuous paper.

Replacing the within-word comparison loop with nibble-parallel zero detection
and `countOneBits` produced these second-run ranked medians:

| Target    | Loop decoder | Bit-parallel decoder | Change |
| --------- | -----------: | -------------------: | -----: |
| Editor    |        27.84 |                27.69 | -0.51% |
| Codex     |        34.50 |                33.85 | -1.88% |
| grep      |        27.08 |                27.05 | -0.11% |
| tar       |        27.67 |                27.64 | -0.13% |
| wav       |        27.05 |                26.95 | -0.35% |
| raytracer |        27.08 |                27.03 | -0.20% |

These are successive experiments rather than interleaved implementation pairs,
so the changes are advisory. The proved result is removal of a divergent
zero-to-seven-iteration loop; no latency speedup is claimed. The exact
bit-parallel implementation passed the 500-test required-GPU release gate and
compiled all frozen targets twice. After adding the exhaustive 256-mask
regression, the exact gate passed 501 tests.

### Adaptive byte-rank width

The byte-rank frontier is monotone. Its maximum stored value, rather than total
byte count, determines whether every group boundary fits u16. Two ranks then
share one word; otherwise they remain u32.

| Target    | Maximum rank | Width | Rank bytes before → after | Atom input before → after |
| --------- | -----------: | ----: | ------------------------: | ------------------------: |
| Editor    |       13,892 |    16 |            11,964 → 5,984 |         125,784 → 119,804 |
| Codex     |      115,794 |    32 |          102,052 → 102,052 |     1,489,512 → 1,489,512 |
| grep      |        2,347 |    16 |               1,952 → 976 |           20,244 → 19,268 |
| tar       |       12,473 |    16 |             11,104 → 5,552 |         117,996 → 112,444 |
| wav       |        1,490 |    16 |               1,240 → 620 |           12,868 → 12,248 |
| raytracer |        2,410 |    16 |               1,928 → 964 |           19,728 → 18,764 |

The post-change 21-pair ranked/dense median ratios were 0.9982, 0.9771, 0.9977,
1.0015, 1.0005, and 0.9995 in target order. The narrow-rank decode adds a shift
and mask, and this experiment detects no material latency change. Direct tests
pin maximum ranks 65,535 and 65,536 to 16 and 32 bits respectively. The exact
representation passed the 501-test required-GPU gate and compiled every frozen
target twice.

The packed byte stream initially performed one read/modify/write per byte atom.
Accumulating four disjoint byte masks locally changes its host stores:

| Target    | Byte atoms | Packed-word stores | Stores removed |
| --------- | ---------: | -----------------: | -------------: |
| Editor    |     13,895 |              3,474 |         10,421 |
| Codex     |    115,797 |             28,950 |         86,847 |
| grep      |      2,348 |                587 |          1,761 |
| tar       |     12,474 |              3,119 |          9,355 |
| wav       |      1,493 |                374 |          1,119 |
| raytracer |      2,412 |                603 |          1,809 |

Logical capacity, transfer, and GPU work are unchanged. Post-change
ranked/dense emitter ratios were 0.9731–1.0071; no latency improvement is
claimed. The exact grouped-byte writer passed the 501-test required-GPU gate
and compiled every frozen target twice.

### Byte lanes omit their known end boundary

Byte atoms have encoded width one, but the first one-pass shader loaded
`offset[i + 1]` and subtracted `offset[i]` before dispatching on kind. Moving
that operation below the byte return changes boundary reads from `2A` to
`2A - Q` and removes one subtraction per byte lane:

| Target    | Byte lanes | Boundary reads before → after | Reduction |
| --------- | ---------: | ----------------------------: | --------: |
| Editor    |     13,895 |               47,846 → 33,951 |    29.04% |
| Codex     |    115,797 |             408,198 → 292,401 |    28.37% |
| grep      |      2,348 |                 7,794 → 5,446 |    30.12% |
| tar       |     12,474 |               44,402 → 31,928 |    28.09% |
| wav       |      1,493 |                 4,954 → 3,461 |    30.14% |
| raytracer |      2,412 |                 7,702 → 5,290 |    31.32% |

Capacity, transfer, scheduled lanes, and output are unchanged.
The post-change dense/ranked medians were 27.87/28.01 ms for Editor and
35.18/35.29 ms for Codex. No latency improvement is resolved at this boundary.
The exact early-return shader passed the 501-test required-GPU gate and compiled
every frozen target twice.

### Wasm statistics fuse into size analysis

GPU preparation counted byte atoms, signed-64 atoms, and maximum byte rank in a
separate pass immediately after the mandatory atom-size pass. These are
independent prefix accumulators over the same immutable sequence, so their
product fold now runs with size calculation. One full host traversal disappears:

| Target    | Atom visits removed |
| --------- | ------------------: |
| Editor    |              23,923 |
| Codex     |             204,099 |
| grep      |               3,897 |
| tar       |              22,201 |
| wav       |               2,477 |
| raytracer |               3,851 |

The frozen batch removes 260,448 atom visits. Predicate evaluations, allocation,
transfer, GPU work, and output are unchanged; only loop and iterator overhead is
discarded. Post-change dense/ranked medians were 28.07/28.22 ms for Editor and
35.65/36.19 ms for Codex; no latency improvement is resolved. The 501-test
required-GPU gate passed and compiled every frozen target twice.

### Wasm validation and sizing fuse into one inspection

The GPU boundary formerly made one complete validation traversal and one
complete scalar-size traversal. Validation and sizing are independent folds over
the same immutable atom stream; a single inspection now computes their product.
This removes one additional atom visit per plan atom:

| Target    | Atom visits removed |
| --------- | ------------------: |
| Editor    |              23,923 |
| Codex     |             204,099 |
| grep      |               3,897 |
| tar       |              22,201 |
| wav       |               2,477 |
| raytracer |               3,851 |

The frozen batch removes 260,448 visits and a second atom-kind dispatch. A
validation-only CPU call still allocates no size column; it gains one
sink-presence branch per scalar atom. Post-change dense/ranked medians were
27.66/27.65 ms for Editor and 33.87/33.58 ms for Codex; no isolated latency
claim is made. The 502-test required-GPU gate passed and compiled every frozen
target twice.

### Adaptive sparse Wasm length sizing

Length validation must inspect every dependency to prove the level invariant,
but sizing need not reread the same ranges. The adaptive selector compares
direct range work \(D\) with a conservative sparse estimate
\(A+5K\lceil\log_2(K+1)\rceil\). The sparse path uses one scalar prefix and a
Fenwick tree over validated stable length ranks:

| Target    | Atoms \(A\) | Lengths \(K\) | Direct \(D\) | Selected work | Reduction |
| --------- | ----------: | ------------: | -----------: | ------------: | --------: |
| Editor    |      23,923 |           135 |       45,418 |        29,323 |    35.44% |
| Codex     |     204,099 |           348 |      403,062 |       219,759 |    45.48% |
| grep      |       3,897 |            17 |        7,286 |         4,322 |    40.68% |
| tar       |      22,201 |            20 |       43,479 |        22,701 |    47.79% |
| wav       |       2,477 |            14 |        4,609 |         2,757 |    40.18% |
| raytracer |       3,851 |            23 |        7,282 |         4,426 |    39.22% |

Every frozen plan selects sparse sizing. The batch model falls from 511,136 to
283,288 operations, a 44.58% reduction. Direct ties and small-range plans keep
the old loop. The scalar prefix reuses the final offset vector; sparse-only
logical storage is an \(8(K+1)\)-byte exact-integer tree. Stable length ranks
remove the former \(K\)-entry position map.
Post-change dense/ranked medians were 27.92/27.88 ms for Editor and
36.61/36.65 ms for Codex; no isolated latency improvement is resolved. The
503-test required-GPU gate passed and compiled every frozen target twice.

### CPU Wasm validation emits scalar encodings

The independent CPU differential formerly visited every atom once for
validation, once for scalar encoding, once for encoded-length reduction, and
once for final byte copy, in addition to two independent \(D\)-range
traversals. Encoding scalars during validated inspection and accumulating
encoded length in the scalar and topological folds changes exact visits from
\(4A+2D\) to \(2A+2D\).

The frozen batch removes 520,896 atom visits. Direct range sizing remains
independent of the adaptive GPU-boundary algorithm. The Wasm benchmark now
reports this CPU oracle with 101 samples, ten warmups, alternating target order,
and byte equality on every observation. Post-change medians in milliseconds
were Editor 1.139, Codex 15.155, grep 0.170, Tar 1.059, wav 0.100, and
raytracer 0.161. No latency change is claimed without a counterbalanced
pre/post experiment. The 503-test required-GPU gate passed and compiled every
frozen target twice.

### Validated scalars use validated-domain LEB encoders

CPU inspection already proves scalar ranges. Calling the public checked encoder
from that trusted interior repeated the same predicate:

| Target    | Duplicate checks removed |
| --------- | -----------------------: |
| Editor    |                    9,893 |
| Codex     |                   87,954 |
| grep      |                    1,532 |
| tar       |                    9,707 |
| wav       |                      970 |
| raytracer |                    1,416 |

The batch removes 111,472 checks. Public encoders and length-derived values
remain checked; only inspected scalar atoms use the validated-domain body.
Post-change CPU medians were 1.147 ms Editor, 14.801 Codex, 0.171 grep,
1.016 Tar, 0.100 wav, and 0.158 raytracer. The identical preceding protocol
shows no material latency change. The 503-test required-GPU gate passed and
compiled every frozen target twice.

### Validated length levels imply resolved encodings

Strict dependency-level descent proves that every length dependency is encoded
before the CPU topological fold reads it. Removing the redundant interior
presence branch eliminates:

| Target    | Presence checks removed |
| --------- | ----------------------: |
| Editor    |                  45,418 |
| Codex     |                 403,062 |
| grep      |                   7,286 |
| tar       |                  43,479 |
| wav       |                   4,609 |
| raytracer |                   7,282 |

The batch removes 511,136 checks. A boundary regression rejects a same-level
dependency before emission. Post-change CPU medians were 1.251 ms Editor,
17.413 Codex, 0.198 grep, 1.120 Tar, 0.102 wav, and 0.163 raytracer; no latency
change is resolved. The 504-test required-GPU gate passed and compiled every
frozen target twice.

### Canonical singleton byte encodings

CPU emission allocated one singleton array per byte atom. A private table of the
256 immutable byte encodings removes those per-emission allocations:

| Target    | Arrays removed per emission |
| --------- | --------------------------: |
| Editor    |                      13,895 |
| Codex     |                     115,797 |
| grep      |                       2,348 |
| tar       |                      12,474 |
| wav       |                       1,493 |
| raytracer |                       2,412 |

The batch removes 148,419 dynamic allocations and adds 256 persistent arrays
once, for 148,163 fewer allocations on the first batch. Post-change CPU medians
were 1.077 ms Editor, 14.294 Codex, 0.169 grep, 0.969 Tar, 0.103 wav, and
0.199 raytracer. The timing changes are mixed, so no latency claim is made. The
504-test required-GPU gate passed and compiled every frozen target twice.

### Canonical one-byte LEB encodings

Validated internal unsigned values 0–127 and signed values −64–63 reuse the
same private byte table. Exported mutable-array encoders remain fresh. Additional
per-emission allocations removed are:

| Target    | Arrays removed |
| --------- | -------------: |
| Editor    |          9,399 |
| Codex     |         66,201 |
| grep      |          1,530 |
| tar       |          5,835 |
| wav       |            950 |
| raytracer |          1,413 |

The batch removes 85,328 arrays without new persistent storage. Consecutive
identical-protocol CPU medians changed from 1.077 to 0.850 ms for Editor and
14.294 to 8.936 ms for Codex; the other four improved by 11.68–30.55%. These
measurements are consistent with the allocation model but are not a
counterbalanced causal estimate. The 504-test required-GPU gate passed and
compiled every frozen target twice.

### Rejected multi-byte LEB memoization

Three emission-local maps for unsigned, signed-32, and signed-64 values would
have reduced 26,701 multi-byte encodings to 3,003 distinct encodings. Derived
lengths shared the unsigned map; signed domains remained separate.

| Target    | Encodings before | Encodings with maps | Avoided | CPU before | CPU with maps |
| --------- | ---------------: | ------------------: | ------: | ---------: | ------------: |
| Editor    |              629 |                 193 |     436 |   0.850 ms |      1.523 ms |
| Codex     |           22,101 |               1,255 |  20,846 |   8.936 ms |     13.856 ms |
| grep      |               19 |                   9 |      10 |   0.142 ms |      0.259 ms |
| tar       |            3,892 |               1,515 |   2,377 |   0.856 ms |      1.658 ms |
| wav       |               34 |                  19 |      15 |   0.088 ms |      0.161 ms |
| raytracer |               26 |                  12 |      14 |   0.138 ms |      0.234 ms |

The benchmark used the permanent 101-sample, ten-warmup, alternating-target
CPU-oracle protocol and required byte equality on every observation. All six
medians regressed by 55.05–93.82%, despite an 88.75% aggregate cache hit rate.
Map lookup and insertion cost therefore exceeds the avoided encoding and
short-array allocation cost on this runtime. The memoization was removed.

### CPU Wasm emission writes directly

The retained array emitter stored one reference for every atom and allocated
one array for every remaining multi-byte scalar or derived length. The direct
emitter instead validates widths into a `Uint8Array`, stores only the \(K\)
derived payload widths, allocates the exact output, and writes each encoding at
a rolling offset.

| Target    | Reference entries removed | Encoding arrays removed | Typed temporary bytes | CPU array emitter | CPU direct emitter |
| --------- | ------------------------: | ----------------------: | --------------------: | ----------------: | -----------------: |
| Editor    |                    23,923 |                     629 |                25,003 |          0.850 ms |           0.616 ms |
| Codex     |                   204,099 |                  22,101 |               206,883 |          8.936 ms |           5.697 ms |
| grep      |                     3,897 |                      19 |                 4,033 |          0.142 ms |           0.115 ms |
| tar       |                    22,201 |                   3,892 |                22,361 |          0.856 ms |           0.585 ms |
| wav       |                     2,477 |                      34 |                 2,589 |          0.088 ms |           0.070 ms |
| raytracer |                     3,851 |                      26 |                 4,035 |          0.138 ms |           0.095 ms |

The frozen batch removes 260,448 reference entries, 26,701 dynamic encoding
arrays, and the 256-entry persistent canonical table. Its replacement uses
264,904 logical typed-array bytes plus the required output. Structural
atom/range visits remain \(2A+2D\); the emitter writes each of the \(B\) output
bytes once instead of constructing and then copying encoding arrays. Relative
to the last retained array-emitter run under the same protocol, all medians
fell by 19.22–36.24%. This comparison is consistent with the exact allocation
model but is not a counterbalanced causal estimate. Every benchmark observation
was byte-identical to the direct CPU oracle. The 504-test required-GPU gate
passed and compiled every frozen target twice.

The first packer still read/modified/wrote each physical u16 word once per
logical value. Building each disjoint low/high pair locally reduces derived host
stores without changing capacity:

| Target    | Offset stores before → after | Rank stores before → after | Stores removed |
| --------- | ---------------------------: | -------------------------: | -------------: |
| Editor    |              23,924 → 11,962 |             2,991 → 1,496 |         13,457 |
| Codex     |                 zero-copy u32 |                direct u32 |              0 |
| grep      |                3,898 → 1,949 |                 488 → 244 |          2,193 |
| tar       |              22,202 → 11,101 |             2,776 → 1,388 |         12,489 |
| wav       |                2,478 → 1,239 |                 310 → 155 |          1,394 |
| raytracer |                3,852 → 1,926 |                 482 → 241 |          2,167 |

These are exact construction-work counts. Transfer, GPU work, and output are
unchanged. Post-change ranked/dense median ratios were 0.9974–1.0026 across the
six targets, again detecting no material emitter-latency change. The exact
pair-store implementation passed the 501-test required-GPU gate and compiled
every frozen target twice.

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

### Rejected Core rule expansion

The Wasm integer laws also justify `x * 0 → 0`, `x - 0 → x`, and
`x / 1 → x` for i32/i64; division by positive one neither divides by zero nor
triggers signed overflow. An exact scan of the six frozen pre-rewrite snapshots
found zero matches for all three rules in both CPU and required-GPU
compilations. The only existing matches are Tar's 24 add-zero operations.

Adding those rules now would widen the CPU rule head and WGSL branch set without
removing one operation in the measured contract. They remain rejected until a
profile reports nonzero matches or a different workload supplies a measured
break-even case.

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

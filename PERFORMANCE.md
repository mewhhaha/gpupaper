# Ducklang compiler performance

These measurements were recorded on 2026-07-30 and 2026-07-31 with:

- NVIDIA GeForce RTX 4080 SUPER, vendor `4318`, device `9986`;
- `WGPU_BACKENDS=vulkan` and `WGPU_POWER_PREF=high`;
- Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3;
- Linux 7.1.5-1-cachyos on x86-64;
- frozen Binned contract digest
  `8031077802b03700258d527d9a9d20addffe786b90111b5694cc5ff3a16a70d4`;
- gpupaper working tree through the Core identity audit at `ebc641a`.

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
six warm observations as three complete CPU-first/GPU-first order pairs. It
retains every warm total and reports the paired differences
`d_i = GPU_i - CPU_i`, their median, and their median absolute deviation
`median(|d_i - median(d)|)`. The paired statistic removes additive noise shared
by adjacent CPU/GPU observations; the raw samples expose stalls that a marginal
median would hide. It does not estimate confidence or remove backend-specific
noise.
The break-even report retains the same raw and paired evidence for every batch
size. A crossover is observed only when the paired median is non-positive.
Failure to observe one reports the maximum measured size, not a lower bound on
an unknown crossover: no monotonicity property has been proved.

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
| Editor    |  75.33 ms | 103.29 ms |     24,460 |
| Codex     | 395.15 ms | 439.60 ms |    226,134 |
| grep      |  10.21 ms |  37.68 ms |      3,911 |
| tar       |  62.07 ms | 112.88 ms |     26,106 |
| wav       |   5.54 ms |  33.16 ms |      2,520 |
| raytracer |   9.57 ms |  36.73 ms |      3,864 |

The corresponding paired GPU-minus-CPU measurements are:

| Target    | Median difference | MAD | Dominant required-GPU stage |
| --------- | ----------------: | --: | --------------------------- |
| Editor    |          26.83 ms | 4.29 ms | Wasm emission, 29.76 ms |
| Codex     |          49.08 ms | 7.78 ms | specialization, 96.25 ms |
| grep      |          27.05 ms | 0.60 ms | Wasm emission, 27.21 ms |
| tar       |          52.92 ms | 4.80 ms | Core pass, 34.49 ms |
| wav       |          27.96 ms | 0.21 ms | Wasm emission, 28.31 ms |
| raytracer |          27.33 ms | 1.50 ms | Wasm emission, 28.15 ms |

These are one six-observation run, not confidence intervals. Five targets have
an exact Core identity frontier, so their required-GPU latency premium is close
to the isolated 27 ms Wasm boundary. Tar alone has 24 physical Core rewrites
and pays both a 34.49 ms Core pass and a 28.21 ms Wasm pass. Codex's marginal
median difference is 44.45 ms, while its median paired difference is 49.08 ms;
this 4.62 ms discrepancy is a concrete counterexample to treating a difference
of marginal medians as the paired effect.

An immediately preceding run reported a 352.97 ms Editor GPU median and a
209.25 ms representative Wasm stage. The old output discarded the six
observations, so that excursion cannot be classified as a queue stall, thermal
event, or repeated backend cost. It is retained as an inconclusive failed
measurement and is the reason raw observations are now part of the benchmark
contract.

### Session identities stop at the session boundary

From-scratch compilation previously normalized every parsed AST, encoded that
normalized tree into a content identity, scanned the source's trailing semantic
dependency, and hashed host-interface contents. Those values are read only by a
`DucklangCompilationSession` cache. Independent compilation now performs
exactly zero semantic-context and semantic-fingerprint work; session-backed
exact, trailing-trivia, dependency, and backend-function reuse are unchanged.

For \(N\) syntax nodes, \(S\) source bytes, normalized identity length \(L\),
and host bytes \(H\), the removed independent-compilation work is
\(O(N+S+L+H)\), with \(O(N+L)\) transient allocation. It removes no semantic
analysis and changes no emitted byte.

Consecutive six-sample runs against detached parent `eede66b` measured:

| Target | CPU before→after | CPU change | GPU before→after | GPU change | Removed CPU context/fingerprint |
| ------ | ---------------: | ---------: | ---------------: | ---------: | ------------------------------: |
| Editor | 88.39→83.31 ms | -5.75% | 125.25→105.12 ms | -16.07% | 0.13/11.35 ms |
| Codex | 456.54→433.90 ms | -4.96% | 489.60→477.77 ms | -2.42% | 0.17/1.68 ms |
| grep | 14.49→11.65 ms | -19.59% | 42.22→40.27 ms | -4.61% | 0.13/0.90 ms |
| tar | 69.62→65.89 ms | -5.36% | 124.37→122.68 ms | -1.36% | 0.16/2.20 ms |
| wav | 7.62→5.58 ms | -26.80% | 34.25→32.91 ms | -3.92% | 0.00/0.83 ms |
| raytracer | 11.74→9.21 ms | -21.55% | 39.06→37.91 ms | -2.96% | 0.00/1.32 ms |

The removed stage is exact; the end-to-end deltas are empirical and include
run-order noise. In particular, they are not wholly attributed to the smaller
measured stage.

### Control-flow fixed-point decomposition

Source loops are currently erased by repeated whole-module reconstruction,
followed after every pass by a whole-module search for the first remaining
source-control node. The implementation cap is 32 passes; this is a stated
restriction, not a derived termination bound.

Profiles now expose physical pass count plus first and subsequent transformation
time. The enclosing control-flow interval also contains the post-pass searches
and timing overhead:

| Target | Passes | Enclosing stage | First transform | Later transforms | Search/orchestration residual |
| ------ | -----: | --------------: | --------------: | ---------------: | ----------------------------: |
| Editor | 1 | 2.673 ms | 1.294 ms | 0 | 1.379 ms |
| Codex | 2 | 73.905 ms | 17.055 ms | 41.762 ms | 15.088 ms |
| grep | 1 | 0.619 ms | 0.200 ms | 0 | 0.419 ms |
| tar | 1 | 2.066 ms | 0.212 ms | 0 | 1.854 ms |
| wav | 1 | 0.209 ms | 0.114 ms | 0 | 0.095 ms |
| raytracer | 1 | 0.434 ms | 0.225 ms | 0 | 0.208 ms |

These are representative CPU observations from the six-sample frontend
protocol. Codex's second transformation is useful—it removes source control
left beneath an outer loop—but rebuilding the expanded program makes it
2.45 times the first transformation. For the other five, the terminal search
proves that the single transformed output is source-control free and frequently
costs more than transformation. The next candidate is a lowering result that
carries an exact remaining-control measure, eliminating separate terminal
searches and replacing the numeric cap with a decreasing measure. That
algorithm is not yet implemented or proved.

The first scan optimization replaces reflective traversal of every JavaScript
object field with an exhaustive typed walk over Ducklang statements and
expression children. Metadata such as spans, names, and type annotations cannot
contain source-control constructors and is no longer visited. The transformation
and fixed-point predicate are unchanged.

Consecutive representative measurements before→after the typed search were:

| Target | Control-flow stage | Reduction | CPU total | GPU total |
| ------ | -----------------: | --------: | --------: | --------: |
| Editor | 2.673→1.276 ms | 52.27% | 86.57→79.42 ms | 108.01→107.41 ms |
| Codex | 73.905→57.031 ms | 22.83% | 446.66→396.69 ms | 466.61→434.39 ms |
| grep | 0.619→0.200 ms | 67.68% | 12.26→10.60 ms | 39.30→38.33 ms |
| tar | 2.066→0.292 ms | 85.86% | 59.85→57.46 ms | 117.90→112.82 ms |
| wav | 0.209→0.130 ms | 37.75% | 5.71→5.14 ms | 33.51→32.93 ms |
| raytracer | 0.434→0.260 ms | 40.00% | 9.00→8.50 ms | 37.23→37.02 ms |

Pass counts remain exactly `[1, 2, 1, 1, 1, 1]`, so the faster search does not
change fixed-point scheduling. All total medians moved downward, but only the
stage mechanism and unchanged pass counts are directly attributed.

The termination audit then replaced the arbitrary 32-pass cap with a counted
residual measure. Counting must finish the typed search instead of returning at
the first residual constructor. The measured first-pass residual counts are
zero for five targets and two for Codex; pass counts remain
`[1, 2, 1, 1, 1, 1]`. Codex therefore satisfies the derived bound
\(2\leq2+1\).

The consecutive control-flow medians changed by +0.711 ms Editor, -1.011 Codex,
-0.010 grep, +0.009 Tar, +0.051 wav, and +0.157 raytracer. This is a mixed
performance result. The change is retained because it removes a non-semantic
numeric rejection, proves termination by natural-number descent for supported
programs, and diagnoses stagnation on the second non-decreasing observation.
No speedup is claimed.

The residual measure is further decomposed into ordinary, range, and
collection-loop counts. The six frozen first-pass vectors are `(0,0,0)`,
`(2,0,0)`, `(0,0,0)`, `(0,0,0)`, `(0,0,0)`, and `(0,0,0)` in target order.
The components are gathered inside the existing complete residual traversal,
must sum to the total, and add no syntax-sized allocation. Codex's second pass
therefore lowers two exposed ordinary loops; neither `for` constructor is on
the residual frontier. Contemporary CPU control-flow representatives were
1.609, 57.521, 0.203, 0.382, 0.131, and 0.260 ms.

Residual occurrences are also quotiented by `(kind, file, start, end)`. Codex's
two occurrences have one distinct provenance; temporary diagnostic
inspection identifies the same `prelude_runtime.duck:1424..1632` loop twice.
The other targets remain 0/0 occurrence/distinct. The expected set cost is
\(O(r_1)\) work and \(O(d_1)\) storage—two insertions and one key for Codex.
This initially suggested repeated linked-module work; the object-identity
measurement below rejects that interpretation.

An object-identity quotient rejects the repeated-instance interpretation:
Codex's residual vector is `(occurrences, vertices, sources) = (2,1,1)`. Two
syntax paths reach one shared immutable AST object. The additional identity set
costs expected \(O(r_1)\) work and \(O(u_1)\) storage. It supplies the boundary
for a possible memoized homomorphism; object-only memoization is not yet valid
for context-sensitive control lowering.

Review 54 initially measured complete first-pass search sharing as follows:

| Target | Occurrences | Vertices | Redundant visits | Sharing factor |
| ------ | ----------: | -------: | ---------------: | -------------: |
| Editor | 3,528 | 3,188 | 340 | 1.11× |
| Codex | 22,103 | 12,231 | 9,872 | 1.81× |
| grep | 1,193 | 934 | 259 | 1.28× |
| Tar | 6,083 | 1,375 | 4,708 | 4.42× |
| wav | 317 | 317 | 0 | 1.00× |
| raytracer | 578 | 578 | 0 | 1.00× |

The current search performs one switch per occurrence. A vertex-memoized DAG
summary could bound structural work by \(O(V+E)\), but lookup and multiplicity
aggregation remain. Instrumented control-flow representatives were 1.312,
56.944, 0.237, 0.414, 0.191, and 0.373 ms. These are the next baseline, not a
speedup claim.

Review 55 found that the search stopped below residual source-control nodes.
That table is therefore frontier-pruned, not complete. Full descent leaves five
targets unchanged and corrects Codex to 22,177 occurrences, 12,248 vertices,
9,929 redundant visits, and a 1.81× sharing factor. The additional 74
occurrences and 17 vertices are the shared residual loop's body. Corrected
control-flow representatives were 1.180, 60.108, 0.247, 0.369, 0.125, and
0.597 ms. A nested-refutable-loop regression observes both residual
constructors and rejects stagnation as `2→2`.

An exact DAG aggregation was then tested and rejected. It reduced constructor
switches from occurrences to vertices but added edge materialization,
object-keyed maps, indegrees, and topological multiplicity propagation:

| Target | Simple walk | DAG aggregation | Change |
| ------ | ----------: | --------------: | -----: |
| Editor | 1.180 ms | 2.095 ms | +77.5% |
| Codex | 60.108 ms | 64.663 ms | +7.6% |
| grep | 0.247 ms | 0.478 ms | +93.4% |
| Tar | 0.369 ms | 0.717 ms | +94.4% |
| wav | 0.125 ms | 0.224 ms | +79.0% |
| raytracer | 0.597 ms | 0.430 ms | -27.9% |

The isolated stage rejects the algorithm despite noisy whole-compiler totals
moving down on four targets. The simple typed walk remains. DAG aggregation may
be revisited after syntax uses compact integer IDs and dense adjacency arrays,
which remove the dominant object-map constants.

Weak identity sets plus scalar cardinalities were also tested and rejected.
The A/B/A control-flow samples were:

| Target | Weak A | Set B | Weak A |
| ------ | -----: | ----: | -----: |
| Editor | 1.794 ms | 2.087 ms | 2.571 ms |
| Codex | 57.566 ms | 60.450 ms | 58.531 ms |
| grep | 0.271 ms | 0.228 ms | 0.261 ms |
| Tar | 0.404 ms | 0.372 ms | 0.420 ms |
| wav | 0.130 ms | 0.123 ms | 0.127 ms |
| raytracer | 0.241 ms | 0.289 ms | 0.245 ms |

The mechanism is target-dependent and reduces no live-memory bound because the
module owns all nodes throughout the synchronous scan. Ordinary sets remain for
simpler single-operation insertion and direct cardinality.

### Current CPU frontier after review 57

The retained ordinary-set baseline has representative CPU totals summing to
548.552 ms. Codex is 393.665 ms (71.76%), so it dominates an equal-target
aggregate objective. Aggregate top-level stage milliseconds are elaboration
114.595, pre-comptime specialization 110.790, type analysis 68.714, CPU Wasm
planning/emission 68.634, Core flattening 42.988, Core lowering 42.372, and
parsing 34.668.

Codex's largest isolated details are specialization rewrite 68.594 ms,
control-flow lowering 60.450, type inference 40.457, specialization lifting
22.751, and local-import resolution 18.349; CPU Wasm planning/emission is a
52.286 ms top-level stage. Specialization rewrite is the next review frontier.
Its current work vector includes 703 distinct result keys, four result-cache
hits, 884 distinct function analyses plus 630 analysis-cache hits, 6,828
rewritten blocks, and
412,890 already-avoided environment-entry copies.

The former “repeated function analysis” name was incorrect: its increment site
is the WeakMap cache-hit branch, which skips analysis. Codex therefore has 884
scans and 630 avoided scans, a 41.61% hit share over 1,514 requests. The metric
is now named `specializationFunctionAnalysisCacheHitCount`; a focused two-call
higher-order program requires positive analysis reuse.

The specialization-result key includes function identity, call-site span,
static arguments, and captured environment. Temporary instrumentation counted
the same key without call-site provenance:

| Target | Provenance keys | Semantic keys | Merge ceiling |
| ------ | --------------: | ------------: | ------------: |
| Editor | 47 | 46 | 2.13% |
| Codex | 703 | 698 | 0.71% |
| grep | 1 | 1 | 0% |
| Tar/wav/raytracer | 0 | 0 | 0% |

Span elision is rejected: it offers negligible reuse and would substitute the
first call site's source provenance without a separate relabeling proof. The
temporary semantic-key instrumentation was removed. A retained pending-cycle
counter gives exact Codex result-cache requests `(distinct, complete hit,
pending) = (703,4,0)`, a 0.566% complete-hit rate; Editor is `(47,2,0)`, or
4.082%.

Final serialized expression identities were then memoized by immutable object
identity. The cache observed 20 Editor hits and 223 Codex hits, but stage-direct
Codex sampling rejected it:

| Variant | Samples | Rewrite median | MAD | Range |
| ------- | ------: | -------------: | --: | ----: |
| WeakMap cache | 15 | 65.263 ms | 2.175 ms | 61.937–71.135 ms |
| Baseline | 15 | 65.000 ms | 1.825 ms | 60.030–69.279 ms |

The +0.41% change is unresolved and the cache was removed. This review also
changes measurement policy: a profile selected by proximity to total median is
descriptive of a whole compilation, not an estimator of every contained stage.
Optimization decisions for a substage now use that substage's own sample median
and MAD.

Temporary rewrite-entry instrumentation measured specialization amplification:

| Target | Rewrite entries | Demanded nodes | Entries/node | Residual nodes |
| ------ | --------------: | -------------: | -----------: | -------------: |
| Editor | 6,718 | 4,150 | 1.62× | 2,845 |
| Codex | 130,143 | 16,119 | 8.07× | 23,594 |
| grep | 670 | 707 | 0.95× | 419 |
| Tar | 3,499 | 4,411 | 0.79× | 3,220 |
| wav | 269 | 269 | 1.00× | 215 |
| raytracer | 458 | 458 | 1.00× | 433 |

Codex's 1.46× residual-size expansion is far smaller than its 8.07× rewrite
amplification, so generated output size is not the whole cost. The hot-path
counter was removed after measurement; its latency is not treated as a
baseline.

Temporary substitution-depth instrumentation localizes that amplification:

| Target | Total entries | Under substitution | Share | Max depth |
| ------ | ------------: | -----------------: | ----: | --------: |
| Editor | 6,718 | 1,881 | 28.00% | 2 |
| Codex | 130,143 | 114,281 | 87.81% | 2 |
| grep | 670 | 2 | 0.30% | 1 |
| Tar | 3,499 | 0 | 0% | 0 |
| wav | 269 | 0 | 0% | 0 |
| raytracer | 458 | 0 | 0% | 0 |

Codex has only 15,862 ordinary entries, close to 16,119 demanded input nodes.
Its excess is broad body specialization—162.56 substitution entries per
distinct result key—not deep recursion. The hot counters were removed after
measurement.

Substitution lookup work is shallow despite broad specialization:

| Target | Reference queries | Map probes | Hits | Extra depth probes |
| ------ | ----------------: | ---------: | ---: | -----------------: |
| Editor | 823 | 883 | 125 | 60 |
| Codex | 31,660 | 31,669 | 2,705 | 9 |
| grep | 1 | 1 | 1 | 0 |
| Tar/wav/raytracer | 0 | 0 | 0 | 0 |

Flattening the environment stack could save only nine Codex reads while adding
overlay updates and rollback for 703 requests. It is rejected. The 28,955
Codex misses motivate measuring symbol scope before attempting a semantic
non-parameter fast path.

Resolver-proved scope partitions active-substitution queries:

| Target | Module | Parameter | Local | Guaranteed misses |
| ------ | -----: | --------: | ----: | ----------------: |
| Editor | 107 | 417 | 299 | 406 (49.33%) |
| Codex | 56 | 15,000 | 16,604 | 16,660 (52.62%) |
| grep | 0 | 1 | 0 | 0 |
| Tar/wav/raytracer | 0 | 0 | 0 | 0 |

Substitution maps contain only resolver parameter symbols. Module and local
queries can therefore bypass map search by proof, not heuristic. Temporary
scope counters were removed before implementing the guard.

The resolver-scope guard is now implemented. Direct Codex rewrite sampling was:

| Sequence | Variant | Samples | Median | MAD |
| -------: | ------- | ------: | -----: | --: |
| A | guarded | 15 | 72.626 ms | 4.050 ms |
| B | unguarded | 15 | 79.616 ms | 8.113 ms |
| A | guarded | 15 | 68.083 ms | 2.717 ms |

Both guarded medians beat the intervening baseline, while their spread makes a
precise percentage inappropriate. The exact work reduction is 16,660 Codex and
406 Editor map queries. A mixed module/local/parameter capture test returns 42,
and the ten-test specialization suite passes.

`staticValue` now allocates its cycle-detection set only after reaching a second
distinct reference. Non-references, unresolved references, one-edge aliases to
values, and self-cycles terminate without that allocation. Direct Codex rewrite
sampling was:

| Sequence | Variant | Samples | Median | MAD |
| -------: | ------- | ------: | -----: | --: |
| A | lazy set | 15 | 66.819 ms | 1.244 ms |
| B | eager set | 15 | 72.842 ms | 4.014 ms |
| A | lazy set | 15 | 67.403 ms | 2.324 ms |

Both lazy medians beat the intervening baseline. The eleven-test
specialization suite, including direct aliases and multi-scope captures, passes.

### Specialization checkpoint after reviews 66–67

Against the Review 57 baseline, the retained scope and lazy-alias fast paths
move every specialization rewrite representative downward:

| Target | Before | After | Change |
| ------ | -----: | ----: | -----: |
| Editor | 4.368 ms | 3.987 ms | -8.74% |
| Codex | 68.594 ms | 64.079 ms | -6.58% |
| grep | 0.305 ms | 0.262 ms | -13.92% |
| Tar | 3.465 ms | 2.825 ms | -18.47% |
| wav | 0.081 ms | 0.069 ms | -15.18% |
| raytracer | 0.199 ms | 0.172 ms | -13.67% |

Current CPU/GPU medians are Editor 74.531/102.646 ms, Codex
386.544/440.070, grep 11.045/39.530, Tar 57.620/113.605, wav
5.262/33.287, and raytracer 8.507/36.811. Every paired GPU premium remains
positive. Wasm sizes are unchanged at 24,460, 226,134, 3,911, 26,106, 2,520,
and 3,864 bytes.

The subsequent 519-test required-GPU release gate passed. Cold/repeated release
samples were Editor 240.61/128.83 ms, Codex 673.86/477.54, grep 41.51/40.53,
Tar 137.24/125.43, wav 34.41/33.48, and raytracer 38.88/39.13. Every CPU/GPU
pair was byte-identical and engine-valid at the unchanged recorded Wasm sizes.

Codex's next ranking is specialization rewrite 64.079 ms, control-flow lowering
54.832, CPU Wasm planning/emission 55.112, and type inference 38.802. Hoisting
the sorted captured-symbol candidate list into memoized function analysis was
tested and rejected:

| Sequence | Variant | Samples | Median | MAD |
| -------: | ------- | ------: | -----: | --: |
| A | hoisted | 15 | 66.411 ms | 1.931 ms |
| B | per request | 15 | 66.161 ms | 2.506 ms |
| A | hoisted | 15 | 66.631 ms | 2.280 ms |

The valid hoist does not improve latency and was removed. Sorting the small
candidate sets is not the current specialization frontier.

Temporary environment-key instrumentation found only 26 retained captured
entries for Editor and 26 for Codex. Maximum arity was seven and two
respectively; grep, Tar, wav, and raytracer retained none. Codex therefore has
at least 677/703 keys with an empty captured environment. The counters were
removed, and captured-environment sorting/serialization is closed as a
negligible frontier for this corpus.

Static-argument identity is likewise bounded. Editor has 83 arguments across 47
keys, maximum arity three, and 155 recursive identity calls. Codex has 1,357
arguments across 703 keys, maximum seven, and 1,416 identity calls. Grep has two
and the other targets none. Codex key identity calls are only 1.09% of its
130,143 rewrite entries. Temporary counters were removed; key construction is
closed as the dominant rewrite frontier.

Exclusive per-request rewrite instrumentation shows a heavy tail. Editor has
1,881 substitution entries total and a 958-entry maximum (50.93%). Codex has
114,281 total and a 32,184-entry maximum (28.16%). That Codex request is
197.98× the naive 162.56-entry mean across 703 keys. Grep's sole request has two
entries. Temporary counters were removed; uniform request optimization is not
the right model.

Thresholding that tail shows that Codex has seven requests of at least 1,024
entries containing 90,688 entries (79.36% of exclusive request work). Four
requests of at least 8,192 entries contain 82,234 (71.96%). Every other frozen
target remains below 1,024; Editor's maximum is 958. The counters were removed.
Any tail optimization must therefore beat its setup cost on at most seven
requests rather than taxing all 703 keys.

Provenance localizes all seven large Codex requests to JSON paths. Six
`prelude_json.duck` factories account for 86,172 entries (75.40% of all request
work); `encode_tool_result` accounts for the other 4,516. Two distinct typed
function objects for the same `encode_json` source span each cost 32,184
entries, together 56.33%. Source-span canonicalization is not justified because
module environments may differ; the temporary provenance was removed.

The two 32,184-entry encoder requests have equal captured environments but
different `Json.Object` payload-reference identities (2,464 versus 2,922).
Canonical factory identity therefore would not merge their complete keys or
eliminate body rewriting. The shared optimization domain is a parametric body
template, subject to measuring argument-dependent reductions; temporary
identity counters were removed.

Temporary entry classification strengthens the template hypothesis. The seven
large requests return 71,647 of 90,688 entry objects unchanged (79.00%) and
perform 940 direct substitutions (1.04%). Each dominant encoder request returns
26,663 of 32,184 entries unchanged and performs six substitutions. This is a
reuse ceiling, not a dependency proof; the counters were removed before the
next subtree-dependency measurement.

Bottom-up free-parameter counts find only 12 dependent occurrences in the
5,298-occurrence encoder body (0.23%) and 9 of 4,514 in the protocol encoder
(0.20%). Parsing bodies are less sparse: 34.89%, 32.21%, and 25.16% dependent.
This justifies an encoder-focused invariant-subtree experiment, not a universal
template policy. Temporary counters were removed.

A safe per-request weak cache keyed by expression object and lexical-environment
epoch was rejected. Fifteen direct Codex baseline/cache/baseline rewrite
samples measured median/MAD 70.379/1.648, 76.230/2.688, and 71.077/3.744 ms.
Dynamic lookup at every entry costs more than same-context identity reuse; no
cache code remains.

The rejected cache produces 4,869 Codex hits against 130,143 baseline rewrite
entries (at most 3.74%) and 65 Editor hits against 6,718 (0.97%); the other four
targets produce none. Codex needs each hit to repay at least 26.73 lookups before
constant costs. It does not, matching the measured regression. Counters and
cache were removed.

Retained block metrics show that Codex's scoped mutable environment avoids
412,890 map-entry copies across 6,828 rewritten blocks (60.47 entries/block).
Editor avoids 57,311 across 827 and Tar 22,293 across 480. These are saved
copies, not remaining work; a persistent map has no measured basis here.

Temporary instrumentation counts 13,992 Codex lexical map mutations (6,996
installs plus restores) across 6,828 blocks, or 2.05 operations/block. Editor
has 1,406 and the remaining targets at most 772. The counter was removed;
restoration work is proportional to introduced bindings and is not the broad
rewrite frontier.

Residual node accounting skips 32,243 Codex descendant occurrences through 99
shared-root cache hits and costs 3.887 ms in the representative profile.
Function lifting costs 22.199 ms, 5.71× more. Accounting's coarse cache has the
right domain and is closed; lifting becomes the next specialization substage.

Temporary lifting counters show 403 Codex lifted bindings from 433 direct
function symbols in 22.926 ms (56.89 microseconds/lift). Editor lifts 55 in
1.630 ms; other targets lift at most 13. The counters were removed and the next
frontier is repeated per-candidate lifting scans.

Direct-use instrumentation rejects the first candidate: Codex performs only 57
scans over 19,541 occurrences, less than one 23,594-node residual traversal.
Generated control functions bypass the scan by construction. Counters were
removed; accepted-function rewriting remains the lifting frontier.

Capture discovery visits 107,069 Codex occurrences, 4.54× the residual program
and 5.48× direct-use validation. Editor visits 2,114 and Tar 4,070. The counters
were removed; compositional free-variable summaries are now the measured lifting
candidate.

Codex capture scans emit only 418 records from 107,069 visits: 1.04 captures per
lift and 0.39% output density. Tar emits eight from 4,070 visits. Estimated
summary metadata is about 11.5 KiB for Codex, making compositional capture
summaries the first lifting change with a positive work/memory case. Counters
were removed.

Maximum pre-lift function nesting is six for Codex and at most four for every
other target except Tar at three. Direct owner-stack propagation therefore has
at most 2,508 Codex capture insertion attempts, versus 107,069 current scan
visits. The depth counter was removed; no tree-query structure is warranted.

Capture-argument insertion visits 206,835 Codex occurrences, 8.77 residual
traversals and 1.93× capture discovery. Tar visits 11,841 for six lifts. This
includes identity traversals for empty capture arrays; counters were removed and
zero-capture frequency is the next decision boundary.

Zero-capture lifts are material: 143 of 403 for Codex (35.48%), 20 of 55 for
Editor, and 6 of 9 for raytracer. Each currently triggers two identity
capture-argument traversals. Counters were removed; the empty-vector identity
fast path is the next measured implementation.

The retained empty-capture identity rule reduces 15-sample Codex lifting
median/MAD from neighboring baselines 23.684/0.718 and 21.961/0.980 ms to
20.788/1.934 ms. All 11 specialization tests pass. The signal is directional,
not a precise effect estimate, but the rule removes proven identity traversal
with one post-analysis branch.

Post-change instrumentation shows why: Codex capture-argument visits fall from
206,835 to 98,211, a 52.52% reduction. Editor falls 41.09%, Tar 32.94%, and
raytracer 53.19%. The temporary counter was removed; the production profile is
unchanged.

Block-step lookup and removal perform only 6,258 Codex comparisons, 6.37% of
the remaining 98,211 capture-argument visits. Other targets perform at most
1,360. The counter was removed; indexed mutable step lists are rejected for the
current corpus.

After zero-capture skipping, Codex changes only 886 call sites in 98,211 visited
occurrences (0.90% output density); Tar changes 68 in 7,941. Counters were
removed. A single batched symbol-to-captures traversal is the derived primitive,
subject to duplicate-symbol renaming first.

Duplicate renaming is common: 274 of 403 Codex lifts (67.99%) and 28 of 55
Editor lifts receive fresh IDs; other targets receive none. The counter was
removed. Batched lifting needs lexical function-occurrence identity, not an
old-symbol-only capture map.

Duplicate-symbol renaming visits 127,326 Codex occurrences, exceeding the
remaining 98,211 capture-argument visits; Editor visits 3,682 and other targets
zero. Together the measured lifting categories perform 358,405 Codex
visits/comparisons. Counters were removed. One occurrence-aware analysis and one
combined rebuild is the next implementation gate.

The post-series required-GPU gate passes all 519 tests and emits unchanged
byte-identical, engine-valid sizes of 24,460, 226,134, 3,911, 26,106, 2,520,
and 3,864 bytes. Release timings are recorded in `PAPER.md` as boundary
observations rather than benchmark distributions.

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
1.53× the CPU time; on Codex it is 1.14×. The GPU stages are useful validation
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

### Identity-memoized ledger counts

The four specialization retention projections formerly traversed an immutable
expression root once per projection. A pass-local weak identity map now computes
the root's DAG node count once and reuses that scalar without merging distinct
roots:

| Target    | Count-cache hits | Avoided node visits |
| --------- | ---------------: | ------------------: |
| Editor    |              330 |              14,038 |
| Codex     |               99 |              32,243 |
| grep      |               18 |               1,416 |
| tar       |               67 |               8,843 |
| wav       |               27 |                 539 |
| raytracer |               21 |                 917 |

All reported retention totals remain identical; the batch avoids 57,996 logical
node visits. Twenty-one warm Codex CPU samples after one warmup compared the
current tree with detached commit `f8a263d` concurrently:

| Measurement              | Recounted | Memoized | Change |
| ------------------------ | --------: | -------: | -----: |
| Ledger accounting        |     6.953 |    4.287 | -38.35% |
| Pre-specialization       |   108.989 |  109.728 |  +0.68% |
| Complete CPU compilation |   555.867 |  548.506 |  -1.32% |

Times are milliseconds. Only the accounting-local reduction is attributed; the
larger stages varied by more than the removed accounting work. The subsequent
six-sample frontend run measured 99.19/152.19 ms CPU/GPU for Editor,
499.64/569.61 for Codex, 14.05/70.53 for grep, 66.21/121.05 for Tar,
7.87/61.59 for wav, and 11.25/40.52 for raytracer. The 506-test required-GPU
gate passed and compiled all six targets twice with byte-identical Wasm and
engine validation.

### Rejected lazy child-list copying

The immutable rewriter currently maps every expression list and then scans for
pointer identity. An experimental copy-on-first-change loop avoided allocating
the mapped list when every child was unchanged. It preserved artifacts and
parent sharing, but its per-element interpreted branch lost to V8's native array
path:

| Measurement              | Native map | Lazy copy | Change |
| ------------------------ | ---------: | --------: | -----: |
| Specialization rewrite   |     72.666 |    75.320 |  +3.65% |
| Function lifting         |     24.226 |    24.158 |  -0.28% |
| Complete CPU compilation |    526.560 |   537.827 |  +2.14% |

Times are 21-sample warm Codex medians after one unrecorded warmup. Current and
detached-`7aed752` processes ran concurrently. The lazy implementation was
removed; no production latency or allocation claim survives this audit.

### Rejected product direct-call classification

The closure lifter asks whether each nested function symbol occurs outside a
direct-callee position. A product traversal can answer for every symbol at once,
changing a block's worst-case classification from \(O(FS)\) to \(O(S+F)\).

The first 21-sample Codex experiment ran that traversal for every block and
regressed lifting from 24.481 to 38.141 ms (+55.80%). Adding the necessary
`F > 0` block-head guard produced:

| Measurement            | Per symbol | Product set | Change |
| ---------------------- | ---------: | ----------: | -----: |
| Function lifting       |     25.083 |      25.125 |  +0.17% |
| Pre-specialization     |    108.547 |     108.660 |  +0.10% |
| Complete compilation   |    551.843 |     566.955 |  +2.74% |

Times are 21-sample warm CPU medians after one warmup, with current and detached
`3ae5dc2` processes run concurrently. The total movement is treated as noise;
the isolated target reached no gain. The product implementation was removed.

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

### Empty accepted Core rewrite batch

A nonempty structural frontier does not imply that a rewrite exists. Editor,
Codex, grep, wav, and raytracer currently accept zero proposals; only Tar
accepts its 24 add-zero proposals. The former CPU and GPU commit paths still
rebuilt and revalidated a complete flat package for those empty accepted sets.
They now return the already-validated snapshot by identity. The profile reports
backend-neutral proposal and acceptance counts so this boundary remains
observable.

An alternating 21-pair Codex CPU experiment after one unrecorded warmup compared
the current tree with detached commit `d3def76`:

| Measurement | Before | After | Change |
| ----------- | -----: | ----: | -----: |
| Core rewrite | 74.181 ms | 34.773 ms | -53.13% |
| Complete compilation | 527.788 ms | 489.262 ms | -7.30% |
| Core inflation | 34.185 ms | 35.473 ms | +3.77% |

The exact current Codex counts are 12,956 operations, 963 structural
candidates, zero proposals, and zero acceptances. The experiment isolates the
CPU rewrite stage; GPU commit uses the same identity law but has not received a
separate latency experiment. The unchanged inflation median is a negative
control. Complete-compilation movement is consistent with the removed
sequential work but remains advisory because paired invocation order does not
remove process drift.

The 507-test required-GPU gate passed and compiled every target twice.
Codex's two correctness samples were 841.02 and 589.22 ms; Editor's were
300.63 and 182.64 ms. These are release observations, not an additional
controlled latency comparison.

### Structured Core round-trip witness

When rewrite returns the exact package produced by flattening structured Core,
the immutable snapshot and round-trip laws prove that inflating it would recover
the structured value already retained by the compiler. The identity path now
reuses that value. Any accepted rewrite constructs a distinct package and
continues to inflate normally.

An alternating 21-pair Codex CPU experiment after one unrecorded warmup compared
the current tree with detached commit `2511932`:

| Measurement | Before | After | Change |
| ----------- | -----: | ----: | -----: |
| Core inflation | 31.863 ms | 0 ms | -100% |
| Complete compilation | 451.776 ms | 424.521 ms | -6.03% |
| Core rewrite | 33.367 ms | 33.261 ms | -0.32% |
| Wasm planning and CPU emission | 50.852 ms | 52.447 ms | +3.14% |

All samples emitted the same 226,134-byte Codex module. The exact result is the
zero inflation stage; end-to-end timing remains advisory. Five frozen targets
accept no Core rewrite and use this path. Tar's 24 accepted rewrites still
require inflation.

The 508-test required-GPU gate passed and compiled every frozen target twice.
Codex's correctness samples were 754.22 and 536.71 ms; Tar's transformed path
was 140.31 and 129.36 ms. Both outputs remained byte-identical to CPU emission
and passed engine validation.

### CPU Core rewrite decomposition

The CPU profile now separates flat input validation, rule matching, conflict
resolution, and nonempty rebuild. The following are seven-sample warm medians
after one unrecorded warmup:

| Target | Rewrite | Input validation | Matching | Resolution | Rebuild | Accepted |
| ------ | ------: | ---------------: | -------: | ---------: | ------: | -------: |
| Editor | 3.857 ms | 3.835 ms | 0.024 ms | 0.002 ms | 0 | 0 |
| Codex | 34.860 ms | 34.708 ms | 0.147 ms | 0.002 ms | 0 | 0 |
| grep | 0.490 ms | 0.486 ms | 0.002 ms | 0.001 ms | 0 | 0 |
| Tar | 10.059 ms | 4.993 ms | 0.028 ms | 0.019 ms | 4.825 ms | 24 |
| wav | 0.332 ms | 0.327 ms | 0.003 ms | 0.001 ms | 0 | 0 |
| raytracer | 0.525 ms | 0.516 ms | 0.007 ms | 0.001 ms | 0 | 0 |

Codex validation is 99.56% of the rewrite median; matching is 0.42%. Tar proves
that rebuild remains necessary when proposals are accepted. The data rejects
matcher parallelization as the next frozen-corpus CPU priority. It does not
justify removing validation: that requires an independently stated trust model
or a cheaper validator preserving the same invariants.

The 508-test required-GPU gate passed with all profile containment checks and
compiled each frozen target twice with byte-identical, engine-valid output.

### Construction-provenance flat Core

Internal CPU compilation now carries an unforgeable construction-provenance
wrapper from validated structured Core into rewrite. Arbitrary flat packages
still require complete validation. An alternating 21-pair Codex CPU experiment
after one unrecorded warmup compared the current tree with detached commit
`79104b6`:

| Measurement | Before | After | Change |
| ----------- | -----: | ----: | -----: |
| Core rewrite | 33.599 ms | 0.110 ms | -99.67% |
| Complete compilation | 422.959 ms | 394.878 ms | -6.64% |
| Flat Core construction | 34.893 ms | 35.300 ms | +1.17% |
| Rule matching | 0.074 ms | 0.095 ms | +29.02% |
| Wasm planning and CPU emission | 54.398 ms | 54.604 ms | +0.38% |

The matching delta is 0.021 ms and is not material. Every sample emitted the
same 226,134-byte module. Seven-sample warm medians after the change report zero
input-validation time for all six CPU targets. Editor, Codex, grep, wav, and
raytracer then spend 0.004–0.159 ms in the complete rewrite stage. Tar accepts
24 proposals and spends 6.505 of its 6.579 ms rewrite median rebuilding and
validating the changed package.

This experiment covers only the internal CPU edge. The public GPU API still
validates its raw package.

The 508-test required-GPU gate passed; raw GPU validation and malformed-package
rejection remained active, and all six targets compiled twice to byte-identical,
engine-valid Wasm.

### Construction provenance through GPU batching

Compiler GPU jobs now retain their construction wrapper through queueing,
identity filtering, mixed batches, and capacity splits. Public raw jobs remain
on validation provenance. An alternating 21-pair Codex required-GPU experiment
after one unrecorded warmup compared the current tree with detached commit
`8076dff`:

| Measurement | Before | After | Change |
| ----------- | -----: | ----: | -----: |
| GPU Core pass | 62.562 ms | 27.871 ms | -55.45% |
| Complete compilation | 508.445 ms | 472.598 ms | -7.05% |
| GPU execution | 25.026 ms | 25.070 ms | +0.18% |
| Core transfer | 0.174 ms | 0.187 ms | +7.53% |
| Core commit | 0.008 ms | 0.006 ms | -26.18% |
| GPU Wasm emission | 36.321 ms | 37.065 ms | +2.05% |

Transfer and commit changes are below 0.02 ms. The Core-pass reduction matches
the removed 34.708-ms validation observed in the preceding decomposition.
Stable GPU execution is a negative control; all observations emitted identical
226,134-byte Wasm. Result provenance makes the trust path executable:
compiler-owned jobs report `construction`, while direct raw GPU tests report
`validation`.

The 508-test gate passed and compiled every target twice with byte-identical,
engine-valid output; malformed raw Core still failed before device work.

### Exact useful-work Core frontier

The host now applies the complete, already-required certificate matcher before
GPU preparation and retains only matching operation IDs. The GPU recomputes
those matches independently; host proposals are discarded. Five frozen targets
have zero matches and avoid the physical Core GPU boundary. Tar retains 24
matches.

An alternating 21-pair Codex required-GPU experiment after one unrecorded
warmup compared the current tree with detached commit `e1a739f`:

| Measurement | Before | After | Change |
| ----------- | -----: | ----: | -----: |
| GPU Core pass | 27.410 ms | 2.285 ms | -91.66% |
| Complete compilation | 466.411 ms | 442.888 ms | -5.04% |
| Core GPU execution | 24.529 ms | 0 ms | -100% |
| GPU Wasm emission | 36.934 ms | 34.604 ms | -6.31% |
| Candidate operations | 963 | 0 | -100% |

Initialization, transfer, and commit also become exactly zero. The Wasm movement
is outside the change and is not attributed. All observations emitted the same
226,134-byte module. Codex's Core backend is now correctly `identity`; required
GPU compilation still requires authoritative GPU Wasm emission. Tar remains the
positive physical Core-GPU release case.

The 508-test release gate passed under that contract. All six targets compiled
twice to byte-identical, engine-valid Wasm; Tar reported `core=gpu`, the other
five `core=identity`, and every target reported GPU Wasm emission.

### Trusted identity before the GPU scheduler

Trusted compiler input now computes its exact frontier before queueing. Empty
jobs return immediately; nonempty jobs carry prepared descriptors through the
queue. An alternating 21-pair Codex required-GPU experiment after one
unrecorded warmup compared the current tree with detached commit `f8bd93a`:

| Measurement | Before | After | Change |
| ----------- | -----: | ----: | -----: |
| GPU Core pass | 2.310 ms | 0.113 ms | -95.12% |
| Complete compilation | 435.368 ms | 428.949 ms | -1.47% |
| GPU Wasm emission | 36.794 ms | 36.745 ms | -0.13% |

All samples emitted identical 226,134-byte Wasm and retained `core=identity`.
Only the 2.198-ms Core-stage reduction is isolated; the larger total movement
contains unrelated variation. Physical concurrency coverage now uses a program
with a real add-zero proposal. The raw empty-frontier API still exercises
logical throughput batching and pre-device validation.

The 508-test release gate passed, including physical Core concurrency on
nonempty prepared jobs and all six byte-identical GPU Wasm pairs.

### Physical Core batch accounting

Core results now report logical queue batch size separately from physically
packed payload size. Identity has a logical job but no packed payload,
submission, dispatched lane, or downstream-parallel function:

| Target | Backend | Functions | Downstream parallel | Logical batch | Physical payload | Submission |
| ------ | ------- | --------: | ------------------: | ------------: | ---------------: | ---------: |
| Editor | identity | 101 | 0 | 1 | 0 | 0 |
| Codex | identity | 301 | 0 | 1 | 0 | 0 |
| grep | identity | 12 | 0 | 1 | 0 | 0 |
| Tar | gpu | 12 | 12 | 1 | 1 | 1 |
| wav | identity | 6 | 0 | 1 | 0 | 0 |
| raytracer | identity | 15 | 0 | 1 | 0 | 0 |

These are exact profile values, not timings. Direct raw throughput identity
still reports logical batch size two and physical size zero. The concurrency
test uses four actual add-zero jobs to require physical Core packing after an
independently observed malformed-job rejection.

The 509-test release gate passed with these accounting invariants and all six
targets compiled twice to byte-identical, engine-valid Wasm.

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
compilation session. Core identity stops before scheduling. Wasm jobs queue
before allocation and suballocate one shared buffer set per physical payload
batch. Capacity overflow splits a batch in stable order.

| Jobs | Latency CPU/GPU total | Paired GPU−CPU median/MAD | Throughput CPU/GPU total | Paired GPU−CPU median/MAD | Latency/throughput Wasm payload |
| ---: | --------------------: | ------------------------: | -----------------------: | ------------------------: | ------------------------------: |
|    1 |       12.48/38.88 ms |           26.97/0.90 ms |        10.09/39.70 ms |           29.81/0.82 ms |                             1/1 |
|    2 |       23.75/49.96 ms |           26.23/0.97 ms |        18.21/44.76 ms |           26.50/0.82 ms |                             2/2 |
|    4 |       41.64/69.94 ms |           28.78/2.72 ms |        37.18/73.65 ms |           36.80/2.25 ms |                             4/3 |
|    8 |      78.81/107.79 ms |           28.19/3.92 ms |       76.37/111.05 ms |           34.67/3.75 ms |                             8/4 |
|   16 |     149.13/181.82 ms |           30.81/5.52 ms |      156.59/188.40 ms |           35.84/6.28 ms |                          16/9.5 |
|   32 |     305.19/329.72 ms |          24.74/12.21 ms |      301.14/328.11 ms |          26.99/11.51 ms |                           16/16 |
|   64 |     611.03/663.77 ms |          41.32/13.78 ms |      603.34/645.70 ms |           30.98/8.84 ms |                           16/16 |

Times are 16-sample medians; paired columns use the retained adjacent
observations. Latency mode flushes on the next scheduler turn. Throughput mode
waits for at most 2 ms, 16 jobs, or a capacity boundary. Neither policy reaches
break-even through the maximum measured size of 64. At 64 jobs, throughput
costs 10.089 ms per GPU compilation versus 9.427 ms per CPU compilation, while
the paired 30.975 ms premium amortizes to 0.484 ms/job. This is a bounded
negative result. It does not imply that 64 is a lower bound on a crossover or
that the latency difference is monotone. Physical Wasm packing saturates at the
configured 16-job boundary, so a larger physical batch remains a separate
policy experiment.

That experiment was run immediately afterward with the shared payload and
submission cap changed from 16 to 64. For \(N\) simultaneously ready jobs, the
idealized physical-batch count falls from \(\lceil N/16\rceil\) to
\(\lceil N/64\rceil\), while atom work and logical payload bytes remain
unchanged. Each removed physical batch can avoid nine buffer allocations, one
map/readback boundary, and one packed command construction. The opposing costs
are larger host columns and device buffers, alignment padding, and a longer
single packing loop.

| Policy | Jobs | Cap 16 paired median/MAD | Cap 64 paired median/MAD | Cap 16→64 physical payload |
| ------ | ---: | -----------------------: | -----------------------: | -------------------------: |
| latency | 32 | 24.74/12.21 ms | 40.80/19.94 ms | 16→32 |
| latency | 64 | 41.32/13.78 ms | 36.43/21.91 ms | 16→64 |
| throughput | 32 | 26.99/11.51 ms | 44.27/8.96 ms | 16→20.5 |
| throughput | 64 | 30.98/8.84 ms | 35.61/15.12 ms | 16→34.5 |

The larger cap reached larger physical batches but did not produce a consistent
latency improvement. At 32 jobs both policies regressed; at 64, throughput
regressed and the latency-policy reduction was smaller than its 21.91 ms MAD.
The cap therefore remains 16. This is a rejected empirical optimization, not a
claim that 16 is universally optimal.

## Backend selection policy

Compilation now defaults to CPU rather than treating device availability as a
latency decision. Optional GPU execution remains available explicitly through
the API or `--try-gpu`, and required execution remains the benchmark and release
policy.

The current isolated emitter medians justify eliminating the default attempt:

| Target | CPU emitter | Adaptive GPU emitter | GPU/CPU |
| ------ | ----------: | -------------------: | ------: |
| Editor | 0.412 ms | 28.008 ms | 67.93× |
| Codex | 3.395 ms | 35.804 ms | 10.55× |
| grep | 0.069 ms | 27.286 ms | 396.75× |
| tar | 0.347 ms | 28.028 ms | 80.75× |
| wav | 0.041 ms | 27.067 ms | 665.53× |
| raytracer | 0.061 ms | 27.175 ms | 442.59× |

These 21-sample emitter measurements use already-constructed plans and do not
predict another adapter. Together with the bounded negative 64-job experiment,
they show that this implementation has no measured basis for automatically
selecting GPU latency. Default CPU removes device initialization, Core queueing,
GPU Wasm packing, dispatch, mapping, and differential comparison. Explicit GPU
modes retain all conformance and production-GPU behavior.

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

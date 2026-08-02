# A Deterministic Parallel Backend for Typed SSA Programs

## Abstract

Gpupaper is a source-language-independent compiler backend. Its input is a
closed, monomorphic, typed SSA/CFG module. Its output is a deterministic
WebAssembly binary plan that can be emitted by TypeScript, Rust compiled to
WebAssembly, or WebGPU. Source parsing, name resolution, type inference, effect
checking, ownership proofs, specialization, and public ABI adaptation belong to
the consuming language.

The design separates payload IR from compiler-execution IR. Payload IR denotes
the program being compiled. Compiler-execution IR denotes count, scan, compact,
rewrite, and write operations performed by a selected backend. A payload program
never becomes a GPU kernel.

Claims in this paper are classified as proved obligations, executable
invariants, empirical measurements, or hypotheses. Tests validate an
implementation; they are not mathematical proofs.

## 1. Scope and trust boundary

Let a frontend produce a module

```text
M = (T, S, F, entry)
```

where `T` is a finite type table, `S` is a finite signature table, and `F` is a
finite function table. Every function is a finite directed graph of blocks.
Every block has typed parameters, a sequence of typed operations, and one
terminator.

The frontend is responsible for propositions that cannot be recovered from
residual code:

- source names and scopes are resolved;
- polymorphism is specialized;
- effects are admitted and closed or represented as explicit host calls;
- ownership annotations are proved according to the source language;
- public ABI values are lowered to Core values;
- source evaluation order has already been made explicit in dependencies and
  control flow.

Gpupaper is responsible for structural propositions visible in Core:

- every table index is in range;
- value definitions are unique;
- operands dominate their uses;
- operation operands and results have the required types;
- edges agree exactly with target block parameters;
- calls agree with signatures;
- returns agree with function results;
- selected target features can represent every reachable operation;
- emitted offsets and lengths describe exactly one deterministic byte string.

This division is necessary. If a backend attempted to infer source ownership or
effect permissions from residual operations, two source programs with the same
residual graph but different static obligations would be indistinguishable. No
backend algorithm can reconstruct information erased by the frontend.

## 2. Core calculus

### 2.1 Types

Core types are table-indexed:

```text
τ ::= i32 | i64 | f32 | f64 | unit
    | vector(n, scalar) | mask(n, scalar)
    | text | bytes | store(τ)
    | product(τ*) | sum(τ*) | function(σ)

σ ::= (τ*) -> τ
```

Vector and mask widths are exactly 128 bits in the implemented target. Product,
sum, buffer, Store, and function values use runtime handles at the managed
boundary. Semantic type identity and physical layout identity are distinct:
different types may share a layout without becoming interchangeable.

### 2.2 SSA and control flow

For a function `f`, each value identifier has one definition:

```text
def_f : ValueId -> (BlockId, Position, TypeId)
```

An operand use in block `b` is valid when its definition is earlier in `b`, or
its defining block dominates `b`. Block parameters represent phi functions
without an implicit parallel-copy convention. An edge

```text
b -> q(v1, ..., vn)
```

is well typed exactly when block `q` has parameters `(x1:τ1, ..., xn:τn)` and
`type(vi) = τi` for every `i`.

The validator computes dominators by the standard finite fixed point:

```text
Dom(entry) = {entry}
Dom(b) = {b} union intersection(Dom(p) for p in pred(b))
```

The lattice is finite, and every update only removes elements, so termination is
guaranteed. The current implementation uses this direct algorithm because
validation occurs once at a trust boundary; a Lengauer-Tarjan implementation is
only justified if measurements show domination dominates large-module cost.

### 2.3 Operations

Core includes constants, scalar operators, certified primitive operations,
vector operations, products, sums, persistent Stores, direct and indirect calls,
explicit host calls, and resource/region evidence. `owned-reuse` is a frontend
certificate: the backend may select a reuse-capable runtime operation, but it
does not attempt to prove uniqueness.

Host operations remain ordered through SSA dependencies and control flow. Core
does not contain an unordered effect set and does not reorder payload effects.

## 3. Lowering semantics

### 3.1 Reachability

Given explicit exports `R`, the emitted function set is the least fixed point

```text
Reach_0 = R
Reach_(k+1) = Reach_k union callees(Reach_k)
Reach = union_k Reach_k
```

over direct calls and closure construction. Because `F` is finite and each
iteration adds functions monotonically, the computation terminates in at most
`|F|` additions. Imports reachable only from discarded functions are omitted.

### 3.2 Structured control

Reducible single-entry natural loops are emitted as Wasm `loop` regions.
Certified scalar diamonds may become typed Wasm `if` expressions. General CFGs
retain a dispatch local. Parallel block-argument assignment is implemented as a
two-phase copy so permutations do not overwrite values before all old values
have been observed.

These transformations preserve a simulation relation between Core states and
Wasm locals/stacks. Each accepted specialized shape has a structural predicate;
failure of the predicate selects the general lowering instead of guessing.

### 3.3 Local assignment and stack sinking

A total, pure, single-use scalar operation may remain on the Wasm operand stack
when its unique use is in the same scheduling region. Trapping, allocating,
reading, host, aggregate, resource, and multiply-used operations receive locals
or explicit runtime calls.

The key counterexample is sinking division across a branch: eager evaluation
could introduce a trap on a path where the source operation was not evaluated.
Therefore totality and region locality are both required.

### 3.4 Determinism

All externally observable order is derived from stable table order. Parallel
passes may propose work in any physical order, but accepted proposals are
ordered by a total key before rebuilding. Binary sections and function bodies
receive offsets by exclusive prefix sums over stable logical order.

For identical Core bytes and options, deterministic emission requires:

```text
emit(M, options) = emit(M, options)
```

byte for byte across every emitter. Differential tests compare the TypeScript,
Rust/WebAssembly, and WebGPU results where the device path is available.

## 4. Flat Core and rewrites

Core graphs flatten into structure-of-arrays columns. Integer IDs replace host
pointers, making snapshots serializable and GPU-addressable. Validation returns
a trusted wrapper; trusted passes avoid repeating the same boundary validation.

A rewrite iteration follows snapshot/propose/resolve/rebuild:

```text
P = propose(snapshot)
A = stable_maximal_nonconflicting_set(P)
next = rebuild(snapshot, A)
```

The implemented algebraic rules are `x + 0 -> x` and `x * 1 -> x` for integer
scalar operations. Their proof uses the identity laws of modular integer
arithmetic. They are not valid for IEEE floating point in general because NaN
payloads, signed zero, and exceptional behavior can distinguish the operands.

Each proposal names its operation, result, replacement, rule, and profit. The
resolver validates proposals against the immutable snapshot, sorts by
`(-profit, function, operation, result, rule)`, and accepts at most one proposal
per claimed operation. Rebuild produces a new snapshot and validates it.

For `N` operations and `C` candidates, matching work is `Theta(C)`, conflict
ordering is `O(C log C)` on the CPU, and rebuilding is `Theta(N)`. A radix or
bucket resolution is justified only when `C` is large enough that sorting is a
measured frontier.

## 5. Binary-plan calculus

A Wasm plan is a finite sequence of atoms. An atom is a literal byte, a signed
or unsigned LEB value, or a derived length. Length atoms form an acyclic
dependency graph by nesting depth.

For resolved atom sizes `s_i`, exclusive scan assigns

```text
offset_0 = 0
offset_i = sum_(j < i) s_j
total = sum_i s_i
```

Each atom writes only the half-open interval `[offset_i, offset_i + s_i)`. These
intervals are disjoint and their union is `[0, total)`, proving race-free
parallel emission and complete coverage. Stable atom order proves deterministic
bytes.

The CPU emitter validates and writes directly. The Rust/WebAssembly emitter uses
the same plan schema and can retain a resident prepared plan. The WebGPU emitter
performs bounded count/scan/write passes and validates adapter limits before
allocation or dispatch.

## 6. Cost model and break-even

Let:

- `A` be plan atoms;
- `B` be output bytes;
- `L` be length-dependency levels;
- `K` be GPU initialization, submission, and readback latency;
- `p` be effective parallel lanes;
- `c_h` and `c_g` be per-unit host and device costs.

The host emitter is approximated by

```text
T_host(A, B) = c_hA * A + c_hB * B.
```

The device emitter is approximated by

```text
T_gpu(A, B, L, p) = K
                   + c_gA * A / p
                   + c_gB * B / p
                   + c_sync * L.
```

GPU emission is justified only when

```text
T_gpu < T_host.
```

For small modules, `K` dominates. Batching reduces the fixed term per module,
but does not remove host planning or output-copy work. Measurements must report
initialization, planning, submission, device work, readback, and final copying
separately; otherwise a faster kernel can be hidden inside a slower boundary.

For rewrites, let `C` be candidate count and `N` total operations. Preparing all
`N` operations when only `C` rule heads can match is work-inefficient. The
selected representation prepares only candidate descriptors, giving transfer
work `Theta(C)` while rebuild remains `Theta(N)` only when a proposal is
accepted. An empty candidate frontier is an identity and submits no GPU work.

## 7. Public API

The package is versioned under semantic versioning. Its stable consumer surface
is the finite export map

```text
E = { ., core, wasm, runtime, rewrite, gpu }.
```

Each entrypoint is split by responsibility:

- `.`: Core schema, validation, Core-to-Wasm planning, CPU emission, and
  Rust/WebAssembly emission;
- `core`: the Core schema and validator without an emitter policy;
- `wasm`: binary-plan construction and TypeScript CPU emission;
- `runtime`: the optional managed-handle runtime used by Core aggregate, buffer,
  and Store imports;
- `rewrite`: layouts, flat snapshots, and deterministic CPU or WebGPU Core
  rewrites; and
- `gpu`: WebGPU Wasm emission, batching, capacity planning, and residency.

The export map is a capability boundary and a versioning boundary. A source file
not reachable through `E` remains an implementation detail even when it is
present in the package archive. Removing or changing a symbol reachable through
`E` requires the corresponding semantic-version change; moving an internal
module without changing `E` does not.

Publication uses a GitHub release boundary and JSR's short-lived OIDC identity.
The release job repeats static checks, Rust/Wasm reproducibility checking, and
the executable suite before upload. Thus the published tuple is

```text
(git commit, release tag, package version, provenance statement).
```

The workflow contains no long-lived registry secret. Creating the JSR package
and linking it to the repository remain explicit owner operations rather than
compiler-side defaults. The published source is licensed under MIT.

The published dependency closure contains TypeScript sources plus the checked
Rust/WebAssembly emitter. Its current uncompressed source-and-emitter payload is
approximately `530 KiB`, including a `46,554`-byte Wasm module. The TypeScript
CPU path performs no I/O. Selecting the Rust/WebAssembly path reads that package
asset and therefore has an explicit Deno read-permission boundary. Selecting the
GPU path requires WebGPU but no source-language capability.

A consumer-specific ABI shell is supplied through `moduleShell(builder)` or
custom sections. It is not part of gpupaper's semantic model.

## 8. Validation and evidence

The implementation must maintain these executable invariants:

1. malformed Core is rejected before lowering;
2. CPU and Rust/WebAssembly plan emission are byte-identical;
3. GPU emission is byte-identical when WebGPU is available;
4. emitted modules pass `WebAssembly.validate`;
5. flatten/inflate round trips preserve validated Core;
6. accepted rewrites preserve validation and leave the input immutable;
7. explicit exports determine the residual call-graph roots;
8. structured-loop, stack-sinking, and eager-selection specializations agree
   with independently executed reference cases.

Zero is the controlled end-to-end producer. Its grammar, parser, Core adapter,
equivalent Rust workloads, and benchmark live under `examples/zero`. It is test
scaffolding, not a privileged source language.

### 8.1 Baba 8 strict-island frontend

Zero's concrete syntax is a regular language chosen to lie inside Baba 8's Wasm
parser class. A module is a nonempty sequence of semicolon-terminated function
records. Each record has the form

\[ v\;n\;p^*\;=\;i^+\;;, \]

where \(v\) is `export:` or `private:`, \(n\) and each \(p\) are identifiers,
and every \(i\) is one lexical instruction. Baba metadata declares the module as
the root and the function as its sole repeated, terminated island under
`throughput: "strict"`. Generation succeeds only when that island is a
terminal-only transducer with at most seven states. Thus acceptance of the
checked parser plan is an executable certificate that the concrete grammar
satisfies Baba's restriction; it is not a proof for an arbitrary future grammar.

The old infix grammar contained recursive `expr` references inside a function
island. Baba 8 rejected it because replacing declared nested islands could not
eliminate that recursion. Keeping it would require a separate recursive CPU
parser and violate the selected frontend boundary. Treating a body as one opaque
token would satisfy the automaton but make Baba's validation vacuous. Zero
instead uses a postfix semantic algebra over a stack \(S\): constants and
references push one expression; a binary instruction replaces \(x,y\) by
\(x\mathbin{op}y\); `call:f:n` replaces the top \(n\) expressions by a direct
call; and `select!` replaces \(p,t,f\) by the lazy expression
`if p then t else f`. `repeat:f` replaces \(n,z\) by the bounded fold
\(\operatorname{repeat}(n,z,f)\). `let:x` requires a singleton stack and binds
that expression across the remaining suffix. A function is accepted by the
adapter exactly when no transition underflows and the final stack has one
expression. Function existence, call arity, lexical scope, and Core typing are
then checked by the existing lowering and Core validators.

For \(L\) UTF-16 source units and \(I\) instructions, Baba's deterministic lexer
and bounded-state island transducer perform \(O(L+I)\) work for the certified
plan. The postfix adapter performs \(O(I)\) work and retains \(O(D+I)\) memory,
where \(D\le I\) is maximum stack depth and the \(O(I)\) term is the immutable
expression tree. Calling `parser.validate()` and then `parser.parse()` would run
the same lexing and island analysis twice. The compiler calls `parse()` once; in
Baba 8 that integrated operation executes the generated Wasm lexer, the shared
653-byte `simd128` validation transducer, and cursor materialization.

With Baba 8.0.0, the checked Zero artifacts are 6,007 bytes of parser Wasm and
16,148 bytes of plan, 22,155 bytes total. Baba 7.10.0 produced 17,983 and 68,015
bytes respectively, 85,998 total, so the checked frontend payload decreases by
63,843 bytes or 74.24%. The v8 plan inspection reports 46 lexer states, two
islands, one strict root-loop island, one parallel long-region island, and 3,488
packed profile bytes. These are empirical artifact facts. Lexer-error and
unexpected-token tests exercise the Wasm lexer and SIMD validator diagnostics;
the existing cursor-to-Core, differential runtime, and emitter-equality tests
exercise successful parsing and semantic preservation.

### 8.2 Structural complexity ladder

Program difficulty is not a scalar. For workload \(w\), the benchmark records

\[ C(w)=(S,F,B,O,A), \]

where \(S\) is source bytes, \(F\) Core functions, \(B\) Core blocks, \(O\) Core
operations, and \(A\) binary-plan atoms. The suite is an ordered ladder of
dominant structural challenges rather than a claim that every component of \(C\)
increases at every step: affine arithmetic, a control-flow diamond, a
multi-function call graph, a branch forest, a nested natural loop, and a broad
call graph. This avoids collapsing incomparable programs into an invented single
complexity score.

Every workload has the same public function `run(seed: i32, rounds: i32) -> i32`
and wrapping-i32 semantics. `repeat` is the bounded fold

\[ \operatorname{repeat}(n,z,f)=f^{\max(n,0)}(z). \]

For each workload, a Zero source, an independently written Rust source, and a
TypeScript recurrence define three executable interpretations. Before timing,
the harness requires

\[ Z_w(s,r)=R_w(s,r)=J_w(s,r) \]

on boundary probes and a deterministic pseudorandom probe set. This is
executable differential evidence, not a proof over every input. CPU plan
emission remains byte-identical to Rust/WebAssembly plan emission in the test
suite.

For fixed workload and seed set, hot execution is modeled as

\[ T_c(w,r)=K_c(w)+r\,t_c(w)+\epsilon, \]

so measurements report nanoseconds per outer round after warmup and alternate
compiler order to reduce drift. A nested workload intentionally performs more
work per outer round; runtime values are comparable between Zero and Rust for
the same workload, not across different workloads. Compilation likewise reports
separate boundaries because an in-process initialized frontend and a fresh
`rustc` process do not measure the same operation. With \(q\) workloads, \(p\)
probes, \(m\) samples, and \(r\) rounds, validation work is \(O(qp)\),
compilation sampling is \(O(qm)\), and runtime work is \(O(qmr)\), multiplied by
each workload's inner recurrence cost. The default six-workload, 30-sample,
eight-seed, 100,000-round run performs 144 million outer rounds per compiler,
plus validation and warmup.

Threats remain explicit: `rustc -O3` may optimize a source-level structural
feature away; JavaScript timer resolution and host scheduling contribute noise;
the finite probe set cannot establish semantic equivalence; and the ladder
samples only first-order scalar programs. The emitted structural vector, raw
paired samples, source hashes, and output hashes make these limitations
auditable.

### 8.3 Zero/Rust counterexample analysis

A 30-sample diagnostic run on 2026-08-02 used 100,000 outer rounds and admitted
host contention. Median Zero/Rust nanoseconds per outer round were 0.84/0.10 for
affine arithmetic, 1.26/1.46 for the diamond, 2.50/1.67 for the call graph,
9.42/4.14 for the branch forest, 29.94/5.87 for the nested loop, and 2.94/4.41
for the broad module. Median initialized Zero compilation ranged from 0.49 to
1.28 milliseconds; fresh `rustc` processes ranged from 28.27 to 29.64
milliseconds. These are empirical diagnostic observations, not admissible
performance claims, because concurrent compiler work was present.

Disassembly separates four causes that must not be conflated:

1. LLVM partially unrolls the affine recurrence by eight and algebraically
   composes eight affine steps into one multiply-add. For
   \(f(x)=ax+b\pmod{2^{32}}\),
   \(f^k(x)=a^kx+b\sum_{i=0}^{k-1}a^i\pmod{2^{32}}\). This explains the
   unusually low Rust time without implying a general eightfold backend gap.
2. Rust inlines the scalar call graphs. gpupaper currently preserves calls
   except for a scalar diamond directly inside a canonical loop.
3. A nested acyclic conditional with \(B\) blocks falls back to a dispatch loop
   whose dynamic dispatch work is \(O(B)\) comparisons per visited transition. A
   structured series-parallel region requires only the source predicates, hence
   \(O(1)\) extra dispatch work.
4. The constant four-trip inner loop is both dispatched and called by gpupaper;
   LLVM structures, inlines, and fully unrolls it. The transformations are
   separable and require different legality arguments.

The first implementation correction is canonical natural-loop emission. Given a
header predicate \(p\), exit edge \(e\), body edge \(b\), and back edge \(k\),
the existing encoding

\[ \texttt{loop}\{\texttt{if}(p)\{b;k;\operatorname{br}(loop)\}
\texttt{else}\{e;\operatorname{br}(exit)\}\} \]

is replaced by

\[ \texttt{block}\{\texttt{loop}\{e;p';\operatorname{br\_if}(exit);b;k;
\operatorname{br}(loop)\}\}, \]

where \(p'=\neg p\) exactly when the source continues on true. Edge assignment
\(e\) may execute before the condition because it writes only compiler-owned
locals and the assigned values dominate the header; no Core effect is moved.
Both encodings choose the same edge and establish the same block-parameter
tuple. The replacement removes one `if`, one `else`, two unconditional branch
depth adjustments, and one `unreachable` per loop without increasing dynamic
work.

The second correction extends expression-tree stack sinking. An operation
\(v=o(v_1,\ldots,v_n)\) may move from its definition to its sole use when it is
pure, total, scalar, both sites are in one block, and `use_count(v)=1`. SSA
dominance gives availability, purity permits reordering, totality preserves trap
behavior, and the single-use condition prevents duplication. The work remains
one operation, local traffic decreases by one set/get pair, and live-local
storage decreases by one Wasm value. Division and remainder remain excluded
because Wasm traps on a zero divisor and signed minimum divided by negative one.

The remaining candidate order is theoretically constrained: structure
series-parallel regions using postdominators before considering inlining; inline
only effect-free, nonrecursive scalar callees under an explicit expanded-size
budget; then fully unroll only statically bounded loops whose cloned body
preserves the Core effect order. Dispatch elimination changes overhead without
duplicating work, whereas inlining and unrolling trade code size for dynamic
work and therefore require workload-independent cost models. LLVM likewise
represents inlining as cost versus threshold and guards loop unrolling with a
profitability model; those mechanisms are comparison points, not proofs that a
particular threshold is correct for gpupaper.

For an acyclic CFG, gpupaper admits direct structured emission only when a
recursive postdominator decomposition succeeds. At conditional block \(h\), its
immediate postdominator \(j\) is the join. The two successor regions must be
vertex-disjoint before \(j\); each is emitted as one Wasm arm, edge arguments
assign \(j\)'s block parameters, and compilation resumes at \(j\). A global
visited set rejects overlapping arms, and cycle detection rejects back edges.
Thus the accepted class is a conservative series-parallel subset: rejection
falls back to the semantics-preserving dispatcher. Iterative postdominator sets
cost \(O(B^2E)\) with the current set representation and \(O(B^2)\) temporary
membership in the worst case. This is acceptable for the present small-function
backend but is explicitly not the asymptotically preferred Lengauer-Tarjan
representation for large CFGs.

The next cyclic certificate is deliberately narrow. A diamond-body natural loop
contains seven distinct blocks: preheader \(e\), header \(h\), body predicate
\(d\), arms \(t,f\), latch \(l\), and exit \(x\). The only back edge is \(l\to
h\); both arms target \(l\); and the header's other successor is \(x\). This
graph maps directly to one Wasm `block`, one `loop`, and one nested `if`. Edge
assignments implement the corresponding SSA parallel copies. The certificate
rejects additional entries, exits, back edges, or overlapping arm blocks. Work
and emitted control operators are \(O(1)\) per source iteration, whereas the
dispatcher performs up to seven state comparisons per transition. This special
case is not claimed to solve general reducible control flow; it is the smallest
extension justified by the nested-loop counterexample.

Full unrolling was derived and tested but rejected. The candidate required an
integer constant \(0\le n\le8\), header condition `remaining > 0`, unique latch
argument `remaining - 1`, and \(nO_b\le64\) cloned body operations. Those
conditions prove exactly \(n\) iterations and preserve body effect order. On the
four-trip example, however, unrolling expanded the payload from 196 to 340 bytes
(73%) while changing the contended median only from approximately 12.55 to 11.80
nanoseconds per outer round (6%). This identifies the outer-loop call as the
dominant remaining cost and falsifies operation count alone as a sufficient
unroll-profit model. The implementation was removed; future unrolling requires a
model that includes eliminated call boundaries or measured target-specific
control cost.

The implemented inlining case therefore couples call elimination with the
structured-loop certificate. A callee is eligible only when it is referenced by
exactly one direct call, has no closure reference, contains only scalar
constants and scalar binary operations, has a diamond-body natural-loop
certificate, and contains at most 24 operations. The unique call must occur in
the body of a canonical caller loop. Argument values are first assigned to fresh
callee-parameter locals, preserving eager evaluation exactly once; the certified
nested region is then emitted in place and its return value becomes the call
result. Since residual reachability removes the uniquely referenced standalone
callee, code is moved rather than duplicated. Analysis scans all Core operations
once per candidate, \(O(O)\), and adds at most 24 operations to one caller
before removing the same callee operations and a call boundary. Recursive,
effectful, aggregate, multiply referenced, and unstructured callees remain
calls.

The first inlining measurement refined the failed-unroll diagnosis. Structured
inlining reduced the payload from 196 to 189 bytes but changed the contended
median only from about 12.55 to 11.88 nanoseconds per outer round. The call was
not independently dominant; call and inner-loop control were jointly dominant.
Accordingly, constant-trip unrolling is reconsidered only inside this unique,
effect-free, structurally hot inlined call. The earlier bounds \(n\le8\) and
\(nO_b\le64\) still apply, but the profitability comparison is now against the
residual module after both the call and standalone callee have been removed.
That combined hypothesis also failed: the payload grew from 189 to 332 bytes
(76%) while the median changed from about 11.88 to 11.53 nanoseconds (3%). The
unroll implementation was again removed. Disassembly instead identifies four
unpredictable conditional diamonds per outer round; Rust if-converts these to
`select`, so loop-body if-conversion is the next independent hypothesis.

Loop-body if-conversion is legal when the predicate region and both arm regions
contain only pure total scalar operations, both arms supply exactly one value to
one latch parameter, and neither arm accepts edge arguments. Eagerly evaluating
both arms cannot add effects or traps under these conditions; `select` chooses
the same value as the conditional. This removed four unpredictable branches per
outer round. The nested workload fell to 184 bytes and approximately 5.09
nanoseconds per outer round, versus Rust at 5.91 in the paired diagnostic run.
This is executable and empirical evidence under contention, not a universal
claim that if-conversion is profitable for predictable branches.

For a unique scalar call tree, beta reduction supplies a more general inlining
model. Every function must be single-block or a certified scalar diamond; every
operation must be a scalar constant, scalar binary operation, or direct call;
every callee must have exactly one module reference; the call graph must be
acyclic; and the expanded tree may contain at most 32 operations. Fresh locals
bind every formal parameter and SSA result, so argument evaluation occurs once
in source order. Conditional arms remain lazy unless the recursively expanded
arm trees are total, in which case the existing selection proof applies. With
unique references, residualization normally removes every standalone callee, so
the transformation changes \(k\) calls into \(k\) local bindings without
duplicating operations; an independently exported callee remains, but the
32-operation bound still limits duplication. The current repeated
reference-count scans cost \(O(FO)\) in the worst case; emitted tree size is
bounded by 32 Core operations.

The call-tree hypothesis succeeded empirically: the call-graph workload changed
from approximately 2.5--2.7 to 1.44 nanoseconds per round, versus Rust at 1.64,
while the payload grew from 239 to 265 bytes because explicit frame locals cost
more bytes than the removed tiny function shells. This validates runtime call
elimination but refutes the stronger size-neutral hypothesis; operation
nonduplication does not imply byte-size nonincrease.

The affine recurrence admits an algebraic optimization rather than heuristic
unrolling. Wrapping i32 affine maps are pairs \((a,b)\) acting as \(x\mapsto
ax+b\pmod{2^{32}}\), with composition

\[ (a,b)\circ(c,d)=(ac,ad+b)\pmod{2^{32}}. \]

This operation is associative and has identity \((1,0)\), so the maps form a
monoid. Binary exponentiation applies selected powers directly to the carried
state and squares the base map each step, computing \(f^n(x)\) in \(O(\log n)\)
wrapping operations and \(O(1)\) locals instead of \(O(n)\). The certificate
requires a canonical two-parameter natural loop, header test `remaining > 0`,
latch `remaining - 1`, and state latch equal to
`state * constant_a + constant_b`. The affine expression may occur directly in
the body or behind one direct unary call whose callee is a single block
containing exactly the two constants, multiply, add, and return. Looking through
that call is beta reduction of a pure total function, not speculative inlining;
the exact operation catalog excludes effects, traps, recursion, and hidden
state. The loop body may contain no operations beyond the certified recurrence
and counter update. Negative and zero counts retain the initial state. The
transformation is exact for all i32 inputs by induction over the bits of \(n\);
it does not depend on division by \(a-1\), which need not be invertible modulo
\(2^{32}\). Recognition constructs result maps for the caller and possible
callee and therefore costs \(O(O_f+O_g)\) work and memory. Non-affine,
effectful, multi-state, or noncanonical loops retain ordinary lowering. A cached
caller's content identity includes the certified multiplier and offset, so
changing a callee cannot reuse machine code specialized for stale affine
coefficients.

Affine acceleration also creates a measurement counterexample: dividing a
near-clock-resolution batch by 800,000 source rounds produced an apparent
0.00074 nanoseconds per round. The normalization is mathematically defined but
the observed numerator is not precise enough. Runtime sampling therefore
calibrates a repetition count for each compiler by doubling until its timed
batch reaches at least 5 milliseconds, capped at 131,072 repetitions. If clock
quantization is \(q\) and elapsed batch time is \(T\), relative quantization
error is bounded approximately by \(q/T\); batching increases \(T\) without
changing the per-round estimator. Separate repetition counts avoid making the
slower compiler inherit the faster compiler's batch count; pairing applies to
normalized per-round estimates and alternating sample order, not equal raw
invocation counts. The cap is a practical runtime bound, and reports expose
whether each compiler reached the target so undersized samples can be rejected
rather than silently trusted.

## 9. Limitations

- The managed runtime uses host-side handles rather than a standardized public
  component ABI.
- Host calls are synchronous.
- General irreducible CFGs use dispatch rather than optimal relooping.
- The GPU rewrite set is intentionally small.
- GPU availability is not evidence of profitability.
- Ownership certificates are trusted frontend evidence; Core checks their
  structural placement but does not reconstruct source uniqueness proofs.

## 10. References

1. Cytron et al., “Efficiently Computing Static Single Assignment Form and the
   Control Dependence Graph,” ACM TOPLAS 13(4), 1991.
2. Lengauer and Tarjan, “A Fast Algorithm for Finding Dominators in a
   Flowgraph,” ACM TOPLAS 1(1), 1979.
3. Blelloch, “Prefix Sums and Their Applications,” Carnegie Mellon University,
   1990.
4. WebAssembly Core Specification, WebAssembly Community Group.
5. WebGPU Specification, W3C GPU for the Web Community Group.
6. MLIR Dialect Conversion documentation, LLVM Project.
7. Brent, “The Parallel Evaluation of General Arithmetic Expressions,” Journal
   of the ACM 21(2), 1974.
8. Ramsey, “Beyond Relooper: Recursive Generation of WebAssembly,” 2026.
9. LLVM Project, `InlineCost.h` and `LoopUnrollPass.cpp`, cost models for
   inlining and loop unrolling.
10. Baba 8.0.0 changelog, generated-Wasm runtime, and WebGPU frontend profile,
    `github.com/mewhhaha/baba` and `jsr:@mewhhaha/baba@8.0.0`.

## 11. Continuous implementation log

### 2026-08-02: Baba 8 CPU-Wasm frontend

The controlled frontend moved from Baba 7.10.0 to 8.0.0 and regenerated both
version-coupled parser artifacts. Baba 8 removes the LR Wasm parser in favor of
its shared strict SIMD island transducer. The former recursive infix Zero
grammar was a concrete counterexample to the new parser class, so Zero now
presents regular function records and a postfix semantic stack as specified in
Section 8.1. No CPU parser fallback remains: one Baba `parse()` call performs
Wasm lexing and SIMD validation before cursor materialization, and the existing
adapter begins only at the cursor boundary.

Generation itself certifies the strict island restriction. Seventeen Zero tests
cover successful cursor lowering, lexical and structural diagnostics, stack and
scope failures, runtime differential cases, affine cache invalidation, lazy
partial arms, emitter byte equality, and payload bounds. The generated parser
plus plan shrank from 85,998 to 22,155 bytes.

A fresh 30-sample, 100,000-round diagnostic run admitted competing compiler
work, and every calibrated batch reached five milliseconds. Median Baba
lex/validate/parse time ranged from 0.127 to 0.232 milliseconds; initialized
Zero compilation ranged from 0.611 to 1.133 milliseconds, versus fresh `rustc`
processes at 31.30 to 33.30 milliseconds. Median Zero/Rust nanoseconds per
semantic outer round and paired median ratios were: affine 0.000162/0.105
(0.00154), diamond 1.287/1.487 (0.857), call graph 1.509/1.724 (0.879), branch
forest 4.617/4.381 (1.071), nested loop 5.195/5.929 (0.862), and broad module
2.518/4.417 (0.562). Zero payloads were 146, 135, 265, 230, 199, and 391 bytes;
Rust payloads remained 226, 371, 326, 236, 280, and 200 bytes. The first Baba 8
run exposed that the regular syntax placed the affine body behind a unary call;
extending the existing affine certificate through that exact pure call restored
the logarithmic monoid lowering. These are empirical diagnostic observations,
not uncontended performance claims.

### 2026-08-02: Rust-workload counterexample cycle

Nine paper/implementation/measurement cycles replaced ad hoc dispatch with
certified structure, canonicalized natural loops, sank single-use total scalar
trees, if-converted total loop diamonds, inlined bounded unique scalar call
trees, and accelerated certified affine recurrences by monoid exponentiation.
General and fused full unrolling were both implemented, measured, rejected, and
removed because 73--76% payload growth bought only 3--6% in the nested case.

The final 30-sample diagnostic run used independently calibrated batches of at
least 5 milliseconds; every compiler/workload pair reached that floor. Median
Zero/Rust nanoseconds per semantic outer round and their ratios were: affine
0.000162/0.105 (0.0015), diamond 1.234/1.461 (0.849), call graph 1.495/1.705
(0.878), branch forest 4.486/4.190 (1.082), nested loop 4.859/5.777 (0.850), and
broad module 2.444/4.319 (0.550). Zero payloads were respectively 134, 135, 265,
230, 184, and 391 bytes; Rust payloads were 226, 371, 326, 236, 280, and 200
bytes. Initialized Zero compilation medians ranged from 0.49 to 1.18
milliseconds, versus 26.53 to 27.61 milliseconds for fresh `rustc` processes;
those boundaries remain incomparable.

This is empirical diagnostic evidence because competing compiler work was
present. The affine per-round value measures semantic throughput after reducing
100,000 source iterations to logarithmic work; it is not an instruction latency.
The branch forest is the sole final runtime loss, about 8%, and is small enough
that an uncontended run is required before motivating another mechanism. The new
differential, large-count, partial-arm laziness, emitter-equality, and
payload-bound tests are executable validations; they do not prove equivalence
outside the certified shapes.

### 2026-08-02: Zero structural complexity ladder

The single affine-diamond workload was replaced by six paired Zero/Rust
workloads covering the structural dimensions defined in Section 8.2. The
benchmark now emits one report per workload with Core and binary-plan counts,
hashes, boundary-separated compilation timings, and paired runtime samples. A
three-sample diagnostic run at 10,000 outer rounds passed all 420 differential
probes (70 per workload). Zero payloads ranged from 101 to 530 bytes and Rust
payloads from 200 to 371 bytes. Observed Zero/Rust median nanoseconds per outer
round were respectively: affine 0.85/0.12, diamond 1.25/1.99, call graph
2.90/1.67, branch forest 10.12/4.57, nested loop 32.85/5.90, and broad module
4.34/4.42. These are empirical diagnostic measurements, not admissible claims:
three samples cannot estimate a p95, the run allowed contention, and the low
affine Rust time suggests optimizer transformation makes source-level operation
counts an unreliable runtime denominator. The result validates the harness and
identifies the nested-loop and branch-forest rungs as useful optimization
probes; an uncontended recorded run is still required for performance claims.

### 2026-08-02: source-language boundary removal

The repository now owns only the general Core backend and the controlled Zero
producer. Source-language parsers, semantic passes, public ABI adapters,
language corpora, and language-specific benchmarks were removed or moved to
their owning repositories. Core types, operators, spans, runtime imports,
layouts, flat snapshots, rewrites, and Wasm lowering now have backend-owned
names. This is an architectural correction: the previous public aliases were
generic while their implementation and proof document still depended on one
frontend.

### 2026-08-02: JSR package boundary

The repository now declares `@mewhhaha/gpupaper` version `0.1.0` with six
explicit entrypoints. JSR's dry-run analyzer found one slow public type: the
large inferred `wasmInstruction` catalog. It now has an explicit structural
type, preserving exact constructor signatures while allowing declaration
generation without re-inferring the object literal. The repository owner
selected MIT explicitly; the project license is separate from dependency
notices. The completed JSR dry run accepts every public type and selects exactly
`29` files totaling approximately `571 KB` uncompressed, of which `46,554` bytes
are the checked Rust/WebAssembly emitter. This is an executable publication
validation, not evidence about network transfer size or runtime performance.

### 2026-08-02: resolver-owned emitter bytes

Version `0.1.0` exposed a counterexample to treating a published package asset
like a checkout file: a JSR module has an `https:` identity, while
`Deno.readFile` accepts the emitter URL only when that identity is `file:`. The
package therefore generated valid declarations but failed when an installed
consumer first requested Rust/WebAssembly emission.

Version `0.1.1` makes the emitter part of the TypeScript module graph. The Rust
build remains authoritative and still produces a repository-checked `.wasm`
artifact; the build script also generates a source module containing exactly
those bytes. Its check mode rejects either representation when it differs from
the release build. Only the generated source representation is published, so the
package does not carry an unreachable duplicate asset. Emitter initialization
reads the module-owned byte array, so installed consumers need neither a
neighboring repository nor runtime filesystem or network access to find the
compiler. Byte equality, permissionless initialization, and the existing
CPU/Rust differential tests are executable validations of this packaging
invariant; they do not prove compatibility with module resolvers outside Deno
and JSR.

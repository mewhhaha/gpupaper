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

The same rule applies inside an inlined scalar call tree. Within each function,
a total scalar definition with exactly one use in its defining block is emitted
recursively at that use. Parameters and direct-call results use explicit locals
unless the cross-frame rule below proves substitution safe. The uniqueness
premise means no operation is duplicated, and totality means moving it later
within the same effect-free region cannot introduce a trap or reorder an
observable effect. Computing use counts and use-block sets costs \(O(O+V)\) work
and space. If a function contains \(V\) SSA values, the local count changes from
\(V\) to at most \(P+M+C+Q\), where \(P\) is parameters, \(M\) multiply-used
definitions, \(C\) cross-region definitions, and \(Q\) partial or otherwise
non-stackifiable definitions.

The key counterexample is sinking division across a branch: eager evaluation
could introduce a trap on a path where the source operation was not evaluated.
Therefore totality and region locality are both required.

The scalar-tree threshold sweep isolates a second beta-reduction boundary.
Materializing every formal parameter and direct-call result costs up to two
locals per unary frame even when the complete inlined tree is pure and total.
For a single-block unary frame whose parameter and child-call result each have
exactly one use, capture-free substitution can instead keep both values on the
operand stack. Call-by-value evaluation is preserved because the one argument is
evaluated exactly once; moving it across only pure total operations cannot add,
remove, or reorder an observable event. Restricting the rule to one parameter
avoids reordering multiple argument evaluations. Restricting it to a fully total
tree excludes the division and branch counterexamples.

For depth \(d\), the present layout may allocate \(2d+O(1)\) frame-boundary
locals and emit corresponding `local.set`/`local.get` traffic. Cross-frame stack
sinking should reduce those boundary locals to zero while leaving locals for
multiply-used definitions such as the polynomial's shared `mixed` value. The
use-count and totality certificates already cost \(O(O+V)\); the representation
needs only a bit per omitted parameter or call result. This is a semantic
specialization, not a higher inlining budget: rejected trees remain rejected.

The resulting stack expression exposes an algebraic suffix. Let \(q(x)\) be an
otherwise opaque, pure, total i32 expression and let a wrapper return

\[ A(q(x))=a q(x)+b\pmod{2^{32}}. \]

If consecutive wrappers denote affine maps \(A_1,\ldots,A_d\), associativity of
the affine monoid gives

\[ A_d(\cdots A_1(q(x))\cdots)=(A_d\circ\cdots\circ A_1)(q(x)). \]

The compiler may therefore emit the opaque base once followed by at most one
multiplication and one addition. A wrapper is admitted only when it is a pure,
total, single-block member of an already certified scalar tree, contains exactly
one inlined child call, and abstract interpretation relative to that call result
proves the returned value affine. Direct dependence on the wrapper parameter
outside the child, a second child, partial arithmetic, control flow, effects, or
non-i32 values rejects the rule. Treating the child result as an opaque variable
is sound only because the surrounding scalar-tree certificate separately proves
that the skipped call exists and is pure and total.

For suffix depth \(d\), recognition takes \(O(O)\) work and one affine pair per
candidate frame. Compile-time composition is \(O(d)\), while dynamic suffix work
falls from \(2d\) scalar operations to at most two; emitted suffix size falls
from \(O(d)\) to \(O(1)\). This does not simplify or duplicate the opaque base
and does not raise the 64-operation tree-admission budget.

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

\[ C(w)=(S,F,R,D,B,O,A,K,\mu,P,L,H,\rho), \]

where \(S\) is source bytes, \(F\) is total Core functions, \(R\) and \(D=F-R\)
are reachable and dead functions, \(B\) is Core blocks, \(O\) is Core
operations, \(A\) is binary-plan atoms, \(K\) is direct call sites, \(\mu\) is
maximum direct-call multiplicity for one callee, \(P\) is partial scalar
division and remainder operations, and \(L\) is maximum block-local SSA
liveness. The direct-call graph contributes maximum path depth \(H\) when it is
acyclic and the flag \(\rho\) when it contains a recursive cycle; \(H=\bot\) for
a cyclic graph because longest simple path is not computed. Reachability is the
least fixed point starting at the benchmark entry and following direct-call and
closure edges. Local liveness is computed backwards from terminator operands,
killing each operation result and generating its operands. A three-color
depth-first traversal computes \((H,\rho)\) in \(O(F+K)\) work and \(O(F)\)
memory. All measurements together require \(O(F+B+O+E)\) work and \(O(F+V)\)
temporary storage for call edges \(E\) and values \(V\).

The suite is an ordered ladder of dominant structural challenges rather than a
claim that every component of \(C\) increases at every step: affine arithmetic,
a control-flow diamond, a unique call graph, a branch forest, a nested natural
loop, a broad call graph, a shared-call DAG, a wide binding frontier, partial
arithmetic under lazy control, and a mostly dead module. The last four of this
initial ten-case ladder isolate three optimization restrictions and one discard
boundary: unique-reference inlining must not duplicate a shared callee;
stackification should respond to actual liveness rather than total operations;
partial arms must remain lazy; and binary emission should depend on \(R\), while
frontend and reachability work still depend on \(F\). Four further cases hold
nonlinear recurrence semantics constant while changing source organization from
monolithic to a deep unique chain and a shared DAG, then vary the inner-fold
trip count at runtime. The first triplet isolates representation sensitivity: if
two modules denote the same recurrence but differ in \(H\) or \(\mu\), any
runtime difference is compiler-generated rather than algorithmic. The dynamic
fold tests whether a certificate derived for a constant inner count accidentally
depends on that constant. Four fixed-affine-fold cases then hold the inner map
and outer driver constant while selecting inner counts \(n\in\{7,8,16,32\}\).
They straddle the current linear/exponentiation boundary and distinguish a local
inner-loop cost from the cost after composition with its outer fold. Four
affine-region cases then hold the eight-step body fixed while varying a pure
affine pre-map \(g\), post-map \(h\), or both. They test whether loop
summarization is compositional across the acyclic regions adjacent to the loop.
A final pathology quartet targets policy discontinuities rather than new
semantics: shared-leaf fanout five, an expanded scalar chain beyond 64
operations, a live frontier of 32 values, and a nested-loop body beyond the
24-operation composition budget. This avoids collapsing incomparable programs
into an invented single complexity score.

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
compiler order to reduce drift. This linear model applies only when residual
work is linear in \(r\). A certified affine fold instead follows
\(T_c(w,r)=K_c(w)+c_c(w)\lceil\log_2(\max(r,0)+1)\rceil+\epsilon\); its reported
quotient is a fixed-input throughput normalization, not a constant marginal cost
per source round. A nested workload intentionally performs more work per outer
round; runtime values are comparable between Zero and Rust for the same workload
and same \(r\), not across different workloads or round counts. Compilation
likewise reports separate boundaries because an in-process initialized frontend
and a fresh `rustc` process do not measure the same operation. With \(q\)
workloads, \(p\) probes, \(m\) samples, and \(r\) rounds, validation work is
\(O(qp)\), compilation sampling is \(O(qm)\), and runtime work is \(O(qmr)\),
multiplied by each workload's inner recurrence cost. The default 30-workload,
30-sample, eight-seed, 100,000-round run performs 720 million outer rounds per
compiler, plus validation and warmup.

Threats remain explicit: `rustc -O3` may optimize a source-level structural
feature away; JavaScript timer resolution and host scheduling contribute noise;
the finite probe set cannot establish semantic equivalence; and the ladder
samples only first-order scalar programs. The emitted structural vector, raw
paired samples, source hashes, and output hashes make these limitations
auditable.

The final four examples are derived from finite resource policies. Let the
shared-leaf multiplicity cap be \(M_s=4\), scalar-tree expansion cap be
\(B_s=64\), loop-composition cap be \(B_l=24\), and block-local live frontier be
\(L\). These constants do not affect denotation, but each induces a compiler
phase boundary: increasing a program measure by one can retain a call graph or
nested loop that the neighboring case removes. Raising every cap is not a
solution. Shared duplication can grow as \((\mu-1)O_g\), expanded trees can add
\(O(B_s)\) bytes per admitted root, and composed loop regions can multiply hot
body size by enclosing contexts. A live frontier requires at least \(4L\) bytes
of i32 local storage per active invocation before engine-specific register
allocation and can cross local-index encoding boundaries.

The examples therefore choose \(\mu=M_s+1=5\), an acyclic nonlinear scalar tree
strictly larger than \(B_s\), \(L\ge32\), and a nonlinear nested-loop candidate
strictly larger than \(B_l\). Their purpose is falsification: measure the
residual costs and preserve them as counterexamples for a future continuous
profitability model. This cycle changes no backend threshold or lowering rule.
Executable structural tests must certify the intended dimension, differential
execution must preserve semantics, and the paper must record when Rust removes
the source pathology so runtime comparisons are not mistaken for equal residual
programs.

The structurally certified 91-operation chain identifies a gap but does not
locate the discontinuity. That certificate includes the call in the enclosing
loop body; the inliner counts the recursively expanded callee tree and therefore
sees 90 operations. A controlled threshold sweep fixes the nonlinear leaf and
gives each successive unary stage exactly one call, multiplication by three,
addition of seven, and their two constants. If the leaf has 10 Core operations,
depth \(d\) has inliner cost

\[ I(d)=10+5d, \]

while the independently measured region including its outer call has
\(E(d)=I(d)+1\). Depths 9, 10, 11, and 12 produce \(I\in\{55,60,65,70\}\) and
\(E\in\{56,61,66,71\}\), placing two points on each side of \(B_s=64\); the
existing depth-16 case supplies \(I=90,E=91\). Function reference multiplicity,
recursion, partiality, and source computation are held constant. Under the
current policy, costs 55 and 60 should inline while 65, 70, and 90 should retain
the chain. A genuine threshold cost should appear as a level change between 60
and 65, whereas a smooth trend would falsify the hypothesis that the hard budget
dominates. The experiment changes no inlining policy before measuring this
baseline.

A cap-only counterfactual can separate rejection overhead from residual
beta-reduction cost. Raising the experimental bound to 128 admits inliner costs
65, 70, and 90 without changing the semantic certificate. In this sweep every
callee is private and uniquely referenced, so reachability removes the original
function shells and no Core operation is duplicated. Analysis and emitted-local
space remain \(O(I)\), now bounded by 128 rather than 64. If retained calls are
the primary cause, admitted runtimes should exhibit a downward level change. If
they merely continue the under-budget trend, the cap is not the primary gap and
the experiment must be reverted rather than turning one counterexample into a
global policy.

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

The next arithmetic candidate is bounded polynomial interpretation over the Wasm
i32 ring (R=\mathbb Z/2^{32}\mathbb Z). For one-parameter, single-block, pure
total scalar code, associate each SSA value with a polynomial in (R[x]).
Constants map to degree zero, the parameter maps to (x), addition and
subtraction act coefficientwise, and multiplication uses convolution. The
certificate rejects a product whose degree exceeds two; it therefore represents
exactly (q(x)=q_2x^2+q_1x+q_0), including all i32 wraparound, rather than an
integer approximation. An affine suffix (a y+b) composes exactly as ((a
q_2)x^2+(a q_1)x+(a q_0+b)).

Emission uses Horner form ((q_2x+q_1)x+q_0). It needs at most two
multiplications and two additions, omitting operations whose coefficients are
the corresponding identities. The existing expanded cost-61 tree computes its
quadratic base and then its affine suffix with four multiplications and three
additions, so the hypothesis predicts two fewer multiplications and one fewer
addition per outer iteration. The source argument must first be bound to a
local: Horner reads it twice, and duplicating an arbitrary caller expression
would violate eager exactly-once evaluation even though the interpreted body is
pure. Analysis is (O(O)) work and (O(V)) coefficient storage for (O) operations
and (V) values; each value stores three i32 coefficients.

The certificate excludes calls in the polynomial base, structured control,
partial operations, effects, multiple parameters, and degree above two. It also
requires a nonzero quadratic coefficient, leaving affine expressions to the
existing affine domain. It may discard dead pure total arithmetic because such
arithmetic is observationally irrelevant. The implementation performs this
interpretation only at the call-tree leaf, composes the already-certified affine
suffix, binds the argument once, and emits Horner form. Differential tests cover
coefficient wraparound, a trapping caller argument, and a cubic counterexample;
the complexity-ladder size guards make application to the intended threshold
cases executable evidence rather than an optimizer-presence assumption.

The affine-suffix result motivates a different, guarded dynamic unroll. For a
canonical countdown loop with state transition \(f\) and remaining count \(n\),
choose \(u=4\). After proving \(n>0\), execute four consecutive transitions when
\(n\ge4\), otherwise one. If \(n=4q+r\), repeated groups and the final singles
compute \(f^{4q+r}\) in source order. The invariant after \(k\) emitted
transitions is `(state, remaining) = (f^k(seed), n-k)`; each branch decreases
remaining by either four or one, so termination and the bounded-fold result
follow by induction.

The certificate requires the existing four-block simple loop, continuation on
`remaining > 0`, a header counter parameter, latch update `remaining - 1`, and
only pure total scalar body operations or fully total inlined scalar trees. The
header must contain only zero and the comparison, because its condition is not
recomputed between the four copied transitions. Partial arithmetic, effects,
other counter updates, body parameters, non-i32 counters, and structured body
control reject the rule. The straight-line requirement is recursive through
every inlined scalar-tree child; a total if-converted diamond is still rejected
because copying both arms has a different size model. Every tree function must
also have one module reference, preventing four-way unrolling from multiplying
the bounded shared-leaf duplication exception. A loop whose existing range
certificate proves at most seven iterations is also rejected: it can execute at
most one four-way group, so selector overhead cannot be amortized against the
established linear-loop break-even. This is narrower than the rejected constant
full unroll and never removes a dynamic bound check entirely.

Let \(B\) be a conservative upper bound on one encoded iteration. Four-way
unrolling adds at most \(3B+C\) bytes for fixed control overhead \(C\). The
initial counterfactual admits only candidates with \(3B+C\le192\). Runtime
header tests fall from \(n+1\) to \(q+r+1\), while \(q+r\) group-selection
comparisons are added. Thus the mechanism is expected to help only when the
residual body is hot enough that saved loop control exceeds the selection cost;
measurements must still reject it if the target engine already optimizes the
original loop.

The counterfactual used \(C=12\), then added range, recursively straight-line,
and unique-reference premises as older workload guards exposed missing costs.
Even that narrowed experiment failed the runtime/size comparison and was
removed. The derivation specifies the rejected design; it is not an
implementation claim.

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

Canonical simple loops compose under the same model. A simple-loop callee may be
moved into the body of another canonical simple loop when it has one module
reference, one returned value, and every direct call in its body has a complete
scalar-tree inline certificate. The loop operations plus recursively expanded
scalar-tree operations may total at most 24. The latter condition is required by
residual reachability: skipping the moved callee is valid only when it has no
residual call target that would disappear from the reachability traversal. Fresh
locals bind the callee parameters and block parameters, the existing loop-region
emitter preserves header tests and parallel edge copies, and nested scalar
bodies retain their totality and lazy control rules. A callee selected for
logarithmic affine lowering is excluded; only a bounded-small affine loop or a
non-affine loop uses this path. With one reference, the transformation moves at
most 24 operations and removes one call and function shell without duplicating
dynamic work. Recursive, shared, effectful, partially residual, and noncanonical
loops remain calls.

Function caching must include code embedded by these transformations. A cached
function identity therefore contains the stable-ID-ordered bodies of every
transitive direct callee, in addition to the caller and any affine summary.
Changing an inlined scalar leaf or nested loop necessarily invalidates the
caller. This is conservative because a changed residual callee body also
invalidates callers whose machine code depends only on its function index, but
unrelated call-graph components still reuse their entries. Computing the closure
per cached function costs \(O(F+K)\), for a module worst case \(O(F(F+K))\); a
shared reverse-dependency index could reduce repeated work if cache analysis
becomes measurable.

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

For a scalar call tree, beta reduction supplies a more general inlining model.
Every function must be single-block or a certified scalar diamond; every
operation must be a scalar constant, scalar binary operation, or direct call;
the call graph must be acyclic; and the expanded tree may contain at most 64
operations. Internal callees normally require exactly one module reference. A
multiply referenced exception is admitted only for a single-block leaf with at
most four total scalar operations, at most four references, no calls, and at
most eight extra copied operations \((m-1)O_g\). Fresh locals bind every formal
parameter and SSA result, so each source call's argument and body evaluation
still occur once in source order. The leaf catalog excludes effects and traps;
copying its code therefore cannot duplicate an observable effect. Conditional
arms remain lazy unless the recursively expanded arm trees are total, in which
case the existing selection proof applies.

With unique references, residualization normally removes every standalone
callee, so the transformation changes \(k\) calls into \(k\) local bindings
without duplicating operations. Bounded shared leaves duplicate code but not
dynamic work relative to the distinct source calls. An independently exported
callee remains, but the 64-operation tree bound and eight-operation shared-copy
budget limit duplication. The current repeated reference-count scans cost
\(O(FO)\) in the worst case; emitted tree size is bounded by 64 Core operations.
These bounds are resource policies, not part of the semantic certificate:
uniqueness proves that unexported internal operations are moved rather than
copied, but the current predicate does not receive the export set and therefore
cannot prove zero duplication for an independently exported callee. The
deep-polynomial control case contains approximately 42 expanded operations and
exposed a discontinuity at the former bound of 32. The smallest power-of-two
bound containing that case is 64, which doubles worst-case analysis and possible
exported duplication while retaining a constant cap. The shared-polynomial case
adds exactly two copied operations under the bounded-leaf rule. These are
empirical policy choices; an export-aware byte-cost comparison would be a more
precise replacement.

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
the body or behind a direct unary call whose result is certified by an affine
abstract interpretation. For each value the abstract domain is \((a,b)\),
denoting \(ax+b\). Constants map to \((0,c)\), the input maps to \((1,0)\),
addition and subtraction act componentwise, and multiplication is admitted only
when at least one operand has zero multiplier. A direct call with callee summary
\((c,d)\) and argument summary \((a,b)\) maps to \((ca,cb+d)\). Thus an acyclic
DAG of shared pure functions is summarized without cloning it. The base
interpreter accepts only unary i32, single-block functions containing constants,
wrapping addition, subtraction, multiplication, and direct calls. One inductive
extension accepts a certified affine natural loop with an exact i32 constant
count and returns the body summary raised to \(\max(n,0)\). It rejects
recursion, nonlinearity such as \(x^2\), division and remainder, other control
flow, effects, variable trip counts, and unused operations outside that total
catalog. These restrictions make the summary a structural induction proof over
SSA definitions and certified fold iterations rather than a speculative
algebraic rewrite.

The loop body may contain no operations beyond the certified recurrence and
counter update. Negative and zero counts retain the initial state. The
transformation is exact for all i32 inputs by induction over the SSA definitions
and then over the bits of \(n\); it does not depend on division by \(a-1\),
which need not be invertible modulo \(2^{32}\). One root summary uses
\(O(O_r+E_r+\sum_i\log(n_i+1))\) work and \(O(O_r+E_r)\) memory for reachable
operations, call edges, and exact nested-loop powers. The current implementation
rebuilds that memo table for each certificate query, so the whole backend has a
conservative \(O(F(O+E+\sum_i\log(n_i+1)))\) worst-case bound; a module-level
immutable summary table would reduce this to \(O(F+O+E)\) if this analysis
becomes measurable. Non-affine, effectful, multi-state, or noncanonical loops
retain ordinary lowering. A cached caller's content identity includes the
certified multiplier and offset, so changing any transitive callee cannot reuse
machine code specialized for a stale summary.

Logarithmic work is not automatically cheaper for a small bounded count. For a
positive count \(n\), let \(k=\lfloor\log_2 n\rfloor+1\) and let \(p\) be its
population count. Direct iteration of one affine step uses \(2n\) multiply/add
operations. The emitted monoid loop uses \(3k+2p\): two multiplications and one
addition to square the affine map per bit, plus one multiplication and one
addition for each selected bit. This excludes bit tests, branches, and local
traffic, so it favors exponentiation. Nevertheless, for \(n=6\) and \(n=7\) the
counts are respectively 12 versus 13 and 14 versus 15 even before that overhead.
A range certificate therefore retains direct iteration when the maximum positive
trip count is at most seven. It recognizes a constant initial counter or signed
remainder by a positive constant \(d\), whose positive result is at most
\(d-1\). Unknown and larger ranges retain monoid exponentiation. This is a
conservative local interval fact; no general range analysis is claimed.

That local comparison is incomplete for a fixed affine loop used as the step of
another affine fold. Let \(A\) denote the affine map and let the inner count
\(n\ge0\) be a compile-time constant. Fold fusion gives

\[ \operatorname{repeat}(r,z, x\mapsto\operatorname{repeat}(n,x,A)) =
(A^n)^r(z)=A^{nr}(z). \]

The first equality follows because the inner function denotes \(A^n\); the
second follows from associativity of affine-map composition. Computing \(A^n\)
in the compiler takes \(O(\log n)\) monoid operations and stores one pair of i32
constants. The outer dynamic fold can then exponentiate that pair in \(O(\log
r)\) runtime work. Without composition, the small-loop path costs \(O(nr)\),
while the large-loop path costs \(O(r\log n)\) and retains a call boundary. The
implemented certificate is deliberately narrower than general loop
summarization: the inner loop must have the existing affine natural-loop
certificate, its initial counter must be an exact i32 constant, and its initial
state must be exactly the unary function parameter. Entry, header, and exit may
contain only the canonical counter constant, comparison, zero constant, and
identity return; otherwise summarization could erase work. Its summary is
exactly the certified body map raised to \(\max(n,0)\). Variable counts,
replacement initial states, extra operations, non-affine bodies, additional
loop-carried state, effects, and recursion remain outside the domain.

Seven is the largest count assigned to direct linear lowering, eight is the
first assigned to runtime monoid lowering, and sixteen and thirty-two increase
the local arithmetic advantage of exponentiation without changing the call
graph. The fixed-count workloads established the strategy discontinuity before
implementation. After implementation, all thirty workload triples agree on
boundary probes, both plan emitters remain byte-identical, and a separate test
keeps an independently exported summarized loop callable. Residual reachability
may omit a private direct callee only when its call result is the exact state
update consumed by an accelerated affine certificate; exported functions remain
roots. Payload bounds below 160 bytes for all four cases are executable
regression evidence that composition and discard occur. Counterexample tests
require a replacement initial state to retain its distinct value and an entry
division by zero to keep trapping. These validations are not a proof of the
algebraic law.

The next controlled extension gives affine loop boundaries an explicit model.
Let the loop entry compute a total affine initial-state map \(g\) from the unary
parameter and let the loop exit compute a total affine result map \(h\) from the
final state. A fixed-count affine region denotes

\[ S = h\circ A^{\max(n,0)}\circ g. \]

This follows by substitution into the bounded-fold definition; associativity of
composition permits the compiler to calculate the three maps separately and
compose them. The abstract interpreter already proves unary acyclic affine
blocks. Reusing it for the entry and exit is sound only if every erased
operation belongs to its pure, total catalog and the counter remains an exact
i32 constant. Header and body restrictions remain unchanged. Division,
remainder, host calls, other loop-carried state, variable counts, and non-affine
operations still reject the summary. One region adds linear work in the entry
and exit operations plus \(O(\log(n+1))\) compile-time composition, and stores
only the resulting pair. The runtime benefit remains the replacement of
\(O(r\log n)\) nested work by \(O(\log r)\) outer exponentiation.

Pre-transform, constant-reset, post-transform, and pre/post sandwich workloads
established the predicted residual call cost before implementation. The block
abstract interpreter is now reused three ways: whole single-block functions,
loop entries relative to the function parameter, and loop exits relative to the
exit parameter. It processes every operation in each erased block, so a partial,
effectful, nonlinear, or otherwise unsupported operation rejects the whole
summary. Executable tests preserve entry and exit traps, reject a nonlinear
entry, keep independently exported functions, and require all four optimized
payloads to remain below 150 bytes. Differential tests and the two
byte-identical emitters validate the admitted cases; they do not prove the
composition law.

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

### 2026-08-02: shared calls, liveness, partiality, and discard boundaries

Four paired workloads extended the ladder and benchmark schema 3 added
reachability, call multiplicity, partial-operation, and block-liveness fields.
Their measured structural vectors contain the first eleven fields of the
then-current Section 8.2 order; call depth and recursion were added later in
schema 4.

| workload                              | \(C(w)\)                            |
| ------------------------------------- | ----------------------------------- |
| shared-call DAG                       | \((276,5,5,0,8,22,230,5,2,0,3)\)    |
| wide binding frontier                 | \((206,2,2,0,5,26,147,1,1,0,5)\)    |
| partial arithmetic under lazy control | \((128,2,2,0,8,12,121,1,1,1,3)\)    |
| mostly dead module                    | \((785,18,2,16,21,73,131,1,1,0,3)\) |

Executable tests require the distinguishing values \(\mu=2\), \(L\ge5\),
\(P=1\), and \((R,D)=(2,16)\), respectively. The existing differential suite
checks every workload against an independent TypeScript recurrence and requires
byte-identical Rust/Wasm and TypeScript plan emission. These are executable
validations of the intended corpus boundaries, not proofs that the metrics are
sufficient statistics for performance.

The first five-sample diagnostic run exposed a counterexample in the shared DAG:
Zero/Rust medians were 1.539/0.0279 nanoseconds per semantic round, a ratio of
56.0. Unique-reference inlining correctly refused to clone the shared `mix`
callee, but the affine recurrence certificate could see through only one exact
callee. The affine abstract interpretation now composes summaries through the
acyclic shared graph. A targeted seven-sample diagnostic run then measured
0.000158/0.0277 nanoseconds, ratio 0.0058. Zero output grew from 201 to 245
bytes because monoid exponentiation replaces the linear loop with logarithmic
control and working locals. The per-round number is semantic throughput for
100,000 source iterations, not sub-clock instruction latency. Transitive cache
invalidation through the shared graph is an executable regression test.

The initial wide-frontier disassembly contained 26 Wasm locals because scalar
call-tree inlining allocated every intermediate even though ordinary structured
lowering already sank total single-use definitions. Applying the Section 3.3
rule inside that tree reduced the plan from 261 to 147 atoms and the payload
from 263 to 147 bytes. Targeted 30-sample diagnostic medians changed from
approximately 2.239/1.943 to 2.163/1.921 nanoseconds for Zero/Rust. The
remaining roughly 12% loss coincides with Rust's algebraic strength reduction
and two-way loop unrolling. That observation is a hypothesis, not a causal
proof. Earlier unrolling counterexamples grew payloads 73--76% for only 3--6%
runtime gains, so another unrolling mechanism is not justified by a contended
12% gap. An uncontended paired experiment and a profitability model
incorporating branch cost, straight-line body size, and residual payload growth
are prerequisites.

The final 30-sample run was diagnostic because compiler contention was present
at both environment checks; every calibrated runtime batch nevertheless reached
five milliseconds. Zero/Rust median nanoseconds per semantic round and paired
median ratios across all ten workloads were: affine 0.000214/0.107 (0.0020),
diamond 1.286/1.497 (0.858), unique call graph 1.590/1.723 (0.915), branch
forest 6.255/5.167 (1.206), nested loop 5.312/6.014 (0.871), broad module
2.612/4.515 (0.569), shared-call DAG 0.000168/0.0275 (0.0060), wide frontier
2.188/1.935 (1.132), partial lazy arithmetic 2.316/2.381 (0.970), and dead
module 0.000168/0.106 (0.0016). Contention visibly perturbed the branch-forest
result relative to earlier runs, reinforcing its diagnostic status.

Initialized Zero compilation medians ranged from 0.694 to 1.259 milliseconds;
fresh `rustc` process medians ranged from 40.36 to 41.83 milliseconds, and those
boundaries remain incomparable. Parser medians ranged from 0.149 to 0.269
milliseconds. The dead module and affine case emitted identical 138-byte
payloads and 131-atom plans. Planning rose from 0.187 to 0.266 milliseconds for
16 dead functions, empirically separating output work, which depends on \(R\),
from reachability analysis, whose input still depends on \(F\). This is one
finite measurement, not an asymptotic validation.

### 2026-08-03: quadratic interpretation and Horner emission

The degree-two ring interpretation reduced both expanded call-tree payloads from
125 to 117 bytes. For cost 56, an admissible clear-environment 30-sample run
measured Zero/Rust medians of 1.657/1.709 nanoseconds per outer round and a
paired median ratio of 0.971. The preceding affine-suffix measurement was 2.240
nanoseconds, so the approximate within-host improvement is 26.0%; Zero is 2.9%
faster than the Rust baseline by the paired statistic. Initialized Zero
compilation had a 1.049-millisecond median, of which planning was 0.375
milliseconds. Every runtime calibration exceeded five milliseconds.

For cost 61, a second admissible clear-environment 30-sample run measured
Zero/Rust medians of 1.654/1.689 nanoseconds and a paired median ratio of 0.975.
The preceding Zero median was 2.215 nanoseconds, an approximate 25.3% reduction.
The two depths emit byte-distinct 117-byte modules because affine suffix
coefficients differ, but have the same atom count and dynamic Horner shape. This
supports the algebraic operation-count prediction across one independent suffix
depth; it does not establish an engine-independent speedup.

### 2026-08-03: guarded dynamic-unroll counterexample

The four-way candidate began with the canonical countdown proof above and an
encoded-iteration growth estimate. Existing workload guards found three missing
premises before the target measurement. The value-dependent inner fold has a
certified maximum of six and grew to 292 bytes, so loops bounded by the existing
seven-iteration linear break-even were excluded. The unique call-graph workload
contains an if-converted diamond and grew to 394 bytes, so the straight-line
requirement was propagated recursively. The shared-polynomial DAG then grew to
320 bytes, so every inlined tree function was required to have one module
reference. These are counterexamples to totality alone as an unroll
profitability certificate; all three retained correct semantics.

With those corrections and a 192-byte estimated-growth cap, the intended cost-55
tree grew from 125 to 328 bytes, nearly identical to Rust's 327-byte payload.
The actual 203-byte growth also falsified the candidate's \(C=12\) surrounding
control estimate by at least 11 bytes. In a contended 30-sample diagnostic run,
median Zero/Rust runtime was 2.134/1.721 nanoseconds with a paired ratio of
1.242. Compared with the preceding 2.240-nanosecond Zero median, the approximate
4.7% improvement costs 162% payload growth. Every calibrated path reached five
milliseconds; initialized Zero compilation measured 1.256 milliseconds.

The implementation is removed. Whole-plan delta prediction could repair the size
estimate but cannot repair the measured trade: even a perfect predictor would
choose between 203 bytes and roughly 0.106 nanoseconds per round. The result
extends the earlier full-unroll rejection to a pure total affine-composed body
and closes outer-loop unrolling as the explanation for the residual gap on this
engine.

### 2026-08-03: scalar-tree threshold sweep

Four paired workloads instantiate the derived inliner costs 55, 60, 65, and 70;
their independently certified regions including the enclosing call contain 56,
61, 66, and 71 operations. Maximum call depths are 11 through 14, every callee
has one reference, and none of the programs is recursive or partial. This fixes
the semantic computation while locating the hard budget between 60 and 65.

A contended 30-sample baseline reached the five-millisecond calibration target
for every path. Median Zero/Rust nanoseconds per outer round and paired ratios
were 5.278/1.717 (3.018), 5.608/1.687 (3.284), 6.176/1.729 (3.563), and
6.357/1.691 (3.753). Zero/Rust payload bytes were 297/327, 315/332, 436/332, and
462/335. Initialized Zero compilation medians were 1.064, 1.188, 1.411, and
1.301 milliseconds; fresh `rustc` process medians were 27.409, 27.287, 27.831,
and 27.824 milliseconds. The payload discontinuity at 60/65 is 121 bytes, but
the Zero runtime increase is only about 10.1%; admitted trees are already about
three times slower than Rust. The hard cap is therefore real but not the primary
runtime gap.

A counterfactual raised the cap from 64 to 128 without changing the semantic
certificate. At costs 65 and 70, Zero payloads fell from 436 to 333 bytes and
from 462 to 351 bytes. Median runtimes changed only from 6.176 to 6.061
nanoseconds and from 6.357 to 6.321 nanoseconds, approximately 1.9% and 0.6%.
The admitted cost-90 case still measured 7.944/1.698 nanoseconds, a paired ratio
of 4.717, with a 423/348-byte payload. These runs were diagnostic and not paired
directly against one compiler binary in one invocation, so the percentages are
hypothesis-strength evidence rather than admissible effect estimates.

The cap-only experiment is reverted. It greatly reduces residual function-shell
bytes for these private unique trees but does not remove the dominant runtime
cost, while globally doubling the bounded analysis and exported-duplication
resource exposure. The persistent loss on both sides of the cap instead supports
the cross-frame stack-sinking experiment derived in Section 3.3.

The implemented layout omits a single-block total unary frame's parameter when
it has one use and omits an inlined child-call result when it has one use in the
same block. Recursive expression emission carries an explicit substitution
environment; it does not infer a missing local. At inliner costs 55 and 60,
payloads fell from 297 to 171 bytes and from 315 to 177 bytes. Median Zero
runtimes changed from 5.278 to 5.052 nanoseconds and from 5.608 to 5.358
nanoseconds, approximately 4.3% and 4.5%. Paired Zero/Rust ratios remained 2.996
and 3.219. Initialized compilation medians were 1.075 and 1.087 milliseconds,
within the variation of the baselines. These 30-sample results reached the
calibration target but remain diagnostic because compiler processes were active.

The result validates the predicted local and byte removal but falsifies the
claim that frame traffic is the dominant runtime gap. Disassembly provides an
independent structural explanation. For cost 60, gpupaper emits the nonlinear
leaf followed by ten literal multiply-add pairs. Rust composes that affine
suffix into multiplication by \(3^{10}=59049\) and one offset addition, and also
partially unrolls the outer loop by four. Affine-suffix composition and
outer-loop unrolling are therefore separate future experiments; the present
cycle keeps the 64-operation cap and changes only the proved stack-sinking rule.
Differential execution over all workloads, byte identity between both plan
emitters, a partial-argument trap test, and sub-200-byte bounds for the admitted
sweep points are executable validations, not a proof of contextual equivalence.

An existing deep-polynomial-chain regression probe measured 1.291/1.056
nanoseconds after the change, paired ratio 1.217, with a 147/283-byte payload.
This 30-sample run was also diagnostic. It agrees with the threshold sweep that
cross-frame stack sinking is size-effective and does not expose a runtime
regression, but it does not supersede the earlier admissible whole-suite result.

The affine-suffix implementation reuses the i32 affine abstract interpreter but
seeds it with the unique child-call result as an opaque identity variable. A
pre-seeded operation result is skipped only after its i32 type is checked; the
scalar-tree certificate independently proves that the skipped operation is the
one pure, total child call. Emission accumulates wrapper maps while descending
to the first non-affine tree and emits the composed map once after that base.

On inliner costs 55 and 60, final payloads are both 125 bytes, down from the
stack-sunk 171 and 177 bytes. Median Zero/Rust nanoseconds per outer round and
paired ratios were 2.240/1.758 (1.269) and 2.215/1.748 (1.265). Relative to the
immediately preceding diagnostic medians, Zero improved by approximately 55.7%
and 58.7%. Initialized Zero compilation medians were 1.390 and 1.246
milliseconds. Every calibrated path reached five milliseconds, but active
compiler processes keep these 30-sample results diagnostic.

This validates the predicted constant suffix size and large arithmetic-work
reduction. It also leaves an approximately 26--27% gap consistent with the
independent outer-loop-unrolling difference seen in Rust's disassembly. A direct
wrapper-parameter counterexample prevents treating \(A(q(x),x)\) as
one-dimensional affine composition, while the existing partial-argument test
preserves the totality boundary. Sub-140-byte regression bounds make suffix
collapse executable evidence rather than a paper-only claim. Post-change
disassembly contains one suffix multiplication by 59049 and one addition of
206668, exactly the composition of ten \(x\mapsto3x+7\) wrappers.

### 2026-08-03: resource-budget pathology cycle

The examples-only cycle added four paired counterexamples without changing a
backend threshold or lowering rule. Their measured structural vectors are

| workload               | \(C(w)\)                                   |
| ---------------------- | ------------------------------------------ |
| shared fanout five     | \((310,3,3,0,6,24,183,6,5,0,6,2,0)\)       |
| over-budget call chain | \((1084,19,19,0,22,96,564,18,1,0,3,18,0)\) |
| frontier thirty-two    | \((1162,2,2,0,5,165,398,1,1,0,33,1,0)\)    |
| oversized nested fold  | \((381,3,3,0,9,32,227,2,1,0,4,2,0)\)       |

Additional executable certificates compute 91 expanded scalar operations for the
unique call chain and 27 operations for the nested-loop composition candidate,
strictly beyond the respective 64- and 24-operation policies. The fanout is
exactly five and the measured live frontier is 33. All 30 workload triples agree
on boundary probes, both plan emitters remain byte-identical, and the finite
checks are validations rather than proofs.

A contended 30-sample diagnostic run reached the five-millisecond calibration
target for every compiler and workload. Median Zero/Rust nanoseconds per outer
round and paired ratios were 1.494/1.339 (1.109) for fanout five, 8.418/1.761
(4.759) for the call chain, 10.965/1.476 (7.388) for the wide frontier, and
31.094/30.703 (1.015) for the nested fold. Payload sizes were respectively
185/277, 566/348, 400/266, and 230/491 bytes. Initialized Zero compilation
medians were 1.365, 2.663, 2.714, and 1.785 milliseconds; fresh `rustc` process
medians were 49.73, 53.84, 53.15, and 60.53 milliseconds. The compilation
boundaries are incomparable, and concurrent Node processes make every runtime
number diagnostic despite sufficient batching and 30 samples.

The observations reject two broad changes. Allowing the fifth shared-leaf copy
would target only an 11% median gap while the residual Zero module is already 92
bytes smaller; this does not justify weakening the duplication bound. Raising
the loop-composition budget admits a candidate already at runtime parity and
would trade a 230-byte Zero payload against Rust's 491 bytes; the present cap is
conservative in the useful direction. The 91-operation call chain is the strong
remaining counterexample: retained calls coincide with a 4.76-times gap and a
larger payload, so a byte-aware continuous inlining model is a justified future
hypothesis. The wide-frontier result does not isolate register pressure because
Rust receives a source loop and algebraically collapses the affine terms before
the final square. It motivates an affine aggregation or common-subexpression
experiment, not a claim that 33 live values alone cause the 7.39-times gap.

These conclusions are empirical at four finite programs. They preserve the
pathologies rather than tuning thresholds to the suite, which is the intended
outcome of this examples-only cycle.

### 2026-08-03: affine-region composition cycle

Four paired workloads fix the inner count at eight and vary only affine entry
and exit maps. Their common structure is three functions, three reachable
functions, nine blocks, two direct calls, maximum call depth two, maximum
liveness three, and no partial operation. Core operation counts are 19 for the
pre-transform, 16 for the constant reset, 19 for the post-transform, and 23 for
the sandwich. These are executable structural certificates that boundary
arithmetic, not graph topology, is the independent variable.

A contended ten-sample baseline was diagnostic. Median Zero/Rust nanoseconds per
outer round and paired ratios were 5.508/0.108 (50.73) for the pre-transform,
5.650/0.000101 (54,796) for the constant reset, 5.671/0.108 (50.25) for the
post-transform, and 5.372/0.109 (48.89) for the sandwich. Zero payloads were
210, 204, 210, and 216 bytes; Rust payloads were 227, 118, 227, and 227 bytes.
Every calibrated batch reached five milliseconds. The reset quotient is a
fixed-input normalization after Rust reduced the recurrence to a constant, not a
literal operation-speed ratio. These measurements support affine-region
composition and reject adjusting the local linear/exponentiation threshold. They
remain non-admissible because unrelated Node processes were active and ten
samples cannot estimate p95.

The implementation replaced the single-block-only interpreter body with one
affine block certificate parameterized by input maps and a requested result. For
a certified fixed loop it computes \(g\) from the entry, \(A^n\) by binary
exponentiation, \(h\) from the exit, and stores \(h\circ A^n\circ g\). The same
interpreter remains the base case for acyclic unary callees. Every entry and
exit operation is visited once, so the added work is \(O(O_e+O_x+\log(n+1))\)
per summarized region and does not change the existing constant-size abstract
state.

A final contended 30-sample diagnostic run reached the calibration target for
every path. Median Zero/Rust nanoseconds per outer round and paired ratios were
0.000214/0.106 (0.00199) for the pre-transform, 0.000236/0.0000947 (2.49) for
the constant reset, 0.000218/0.109 (0.00198) for the post-transform, and
0.000246/0.108 (0.00228) for the sandwich. Zero payloads were 137, 133, 137, and
137 bytes, all with 129 plan atoms; Rust payloads remained 227, 118, 227, and
227 bytes. The reset compares two constant-time residual programs and therefore
does not support a general 2.49-times claim. Initialized Zero compilation
medians ranged from 1.12 to 1.41 milliseconds and fresh `rustc` process medians
from 53.19 to 59.23 milliseconds under unusually heavy contention; these
boundaries are incomparable. The runtime collapse and uniform payloads are
empirical evidence for the derived composition, but the run remains diagnostic.

### 2026-08-03: fixed affine-fold composition cycle

Four paired workloads hold source organization and the affine inner map constant
while selecting fixed inner counts 7, 8, 16, and 32. Each compiles to the same
structural dimensions \((F,R,D,B,O,K,\mu,P,L,H,\rho)=(3,3,0,9,15,2,1,0,3,2,0)\);
only one i32 constant and the source byte count differ. This is executable
structural evidence that the sweep isolates the lowering-policy boundary rather
than increasing graph complexity.

A contended ten-sample baseline was diagnostic, not admissible. Median Zero/Rust
nanoseconds per outer round and paired ratios were 6.082/0.106 (57.01) at 7,
3.769/0.104 (36.39) at 8, 3.424/0.103 (33.34) at 16, and 4.929/0.101 (48.74)
at 32. Zero emitted 168 bytes for the linear 7-step case and 204 bytes for every
runtime-exponentiated case; Rust emitted 227, 227, 227, and 225 bytes. Thus the
7-to-8 local strategy switch reduces work, but both paths retain work per outer
iteration. The result supports the nested-fold composition hypothesis and
rejects merely increasing the linear threshold. It does not establish precise
speedups because unrelated Node processes were active and ten samples cannot
estimate p95.

The implementation then separated two propositions that the previous function
had conflated. `affineNaturalLoop` is now a semantic certificate for both small
and large affine loops and records exact and maximum trip facts.
`acceleratedAffineNaturalLoop` applies the local seven-iteration lowering
policy. The unary affine abstract interpreter may recursively summarize the
first form only when its trip count is exact, using compile-time binary
exponentiation. This lets the outer loop consume the powered pair independently
of how the inner loop would have been emitted in isolation. The analysis adds
\(O(\log n)\) compiler arithmetic and two i32 summary values. It changes runtime
work from \(O(nr)\) or \(O(r\log n)\) to \(O(\log r)\) for the admitted nested
shape. Reachability discards the summarized private call target but continues to
seed every public export.

Self-review rejected a broader intermediate certificate. Summarizing every fixed
affine loop as \(A^n\) is false when the initial state is a constant or another
function of the parameter: the denotation is then \(A^n\circ g\). Likewise,
erasing an otherwise unused entry division can remove a trap. The implementation
therefore requires the initial state to be the input identity and exact
canonical entry/header/exit operation sets. Generalizing to an affine
initial-state summary \(g\) would be sound by composing \(A^n\circ g\), but it
is not implemented because the current examples do not justify the larger
certificate. This is a derived counterexample with executable rejection tests,
not an empirical performance result.

A final contended 30-sample diagnostic run reached the five-millisecond
calibration target for every compiler and workload. Median Zero/Rust nanoseconds
per outer round and paired ratios were 0.000161/0.110 (0.00149) at 7,
0.000157/0.109 (0.00150) at 8, 0.000158/0.102 (0.00153) at 16, and
0.000162/0.103 (0.00155) at 32. Zero payloads were respectively 149, 137, 137,
and 136 bytes, versus Rust at 227, 227, 227, and 225 bytes. The near-constant
Zero measurements and eliminated 7-to-8 discontinuity are empirical evidence for
algebraic composition; the quotient is tied to 100,000 outer rounds because the
accelerated runtime is logarithmic, not linear. Concurrent Node processes still
make the run diagnostic rather than an admissible machine-performance claim. In
a separate 30-sample diagnostic pass, initialized Zero compilation medians
ranged from 0.746 to 0.798 milliseconds, including 0.225--0.256 milliseconds of
Wasm planning; fresh `rustc` process medians ranged from 29.07 to 30.56
milliseconds. These boundaries remain incomparable.

### 2026-08-03: nonlinear representation and dynamic-fold cycle

Benchmark schema 4 added acyclic direct-call depth \(H\) and recursion flag
\(\rho\). Four paired Zero/Rust workloads extended the ladder. The first three
implement the same nonlinear recurrence as a monolithic function, a depth-13
unique chain, and a shared DAG. The fourth uses an inner affine fold whose
signed remainder count varies with the carried value. Their final structural
vectors are

| workload              | \(C(w)\)                                  |
| --------------------- | ----------------------------------------- |
| polynomial            | \((143,2,2,0,5,15,120,1,1,0,3,1,0)\)      |
| deep polynomial chain | \((777,14,14,0,17,49,291,13,1,0,3,13,0)\) |
| shared polynomial DAG | \((321,6,6,0,9,20,177,6,2,0,3,3,0)\)      |
| dynamic nested fold   | \((165,3,3,0,9,16,168,2,1,1,3,2,0)\)      |

Executable tests require depths 1, at least 13, and 2 where those boundaries
matter, require multiplicity 2 for the shared polynomial, and classify a
separate recursive module as \((H,\rho)=(\bot,1)\). All fourteen workload pairs
agree with independent TypeScript recurrences on boundary and pseudorandom
probes, both plan emitters remain byte-identical, and payload bounds protect the
three newly optimized shapes. These are executable validations, not universal
equivalence proofs.

The initial ten-sample admissible baseline measured Zero/Rust nanoseconds per
round and paired ratios of 1.285/1.084 (1.197) for the monolith, 1.739/1.068
(1.630) for the deep chain, 1.435/1.055 (1.347) for the shared DAG, and
1.789/0.780 (2.228) for the dynamic fold. Rust emitted the same 283-byte module
for all three polynomial sources, demonstrating that its optimizer removed their
organizational differences. Initial Zero payloads were 121, 396, 212, and 213
bytes.

Three derived mechanisms addressed distinct counterexamples. Raising the scalar
tree resource cap from 32 to 64 admitted the approximately 42-operation unique
chain, reducing it to 293 bytes. The bounded pure-leaf copy rule admitted the
two-operation `shifted` function at multiplicity two, reducing the shared DAG to
181 bytes. For the dynamic fold, the arithmetic cost comparison \(2n\) versus
\(3k+2p\) rejected monoid exponentiation for its proven maximum count of six;
compositional simple-loop inlining then moved both the inner loop and its scalar
leaf into the outer loop, reducing the payload to 177 bytes. The mechanisms
preserve separate soundness certificates and resource budgets; no rule depends
on a workload name. A differential cache test changes the transitive scalar leaf
behind the nested loop and requires independently cached callers to produce the
two distinct results.

The final 30-sample run was admissible: both environment inspections were clear
and every calibrated batch reached five milliseconds. Zero/Rust median
nanoseconds per semantic round and paired median ratios across all fourteen
workloads were: affine 0.000163/0.105 (0.0016), diamond 1.260/1.513 (0.842),
unique call graph 1.511/1.693 (0.893), branch forest 4.538/4.318 (1.044), nested
loop 5.176/6.066 (0.846), broad module 2.147/4.600 (0.474), shared affine DAG
0.000162/0.0270 (0.0060), wide frontier 2.169/2.000 (1.115), partial lazy
arithmetic 2.400/2.412 (0.966), dead module 0.000161/0.105 (0.0015), polynomial
1.319/1.088 (1.200), deep polynomial 1.443/1.129 (1.242), shared polynomial
1.324/1.096 (1.210), and dynamic nested fold 0.901/0.848 (1.063).

The three equivalent polynomial organizations now lie within 0.042 in paired
ratio, compared with a 0.433 spread initially. Their residual 20--24% loss
coincides with Rust's four-way loop unrolling and algebraic scheduling, but the
earlier 73--76% code-growth counterexamples still reject unconditional
unrolling. This remains an unverified profitability hypothesis rather than a
justification for another mechanism. Initialized Zero compilation medians ranged
from 0.645 to 1.064 milliseconds, parser medians from 0.132 to 0.263
milliseconds, and fresh `rustc` process medians from 32.18 to 34.37
milliseconds; the process boundaries remain incomparable.

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

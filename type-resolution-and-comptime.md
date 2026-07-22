# GPU-Parallel Type Resolution and Compile-Time Execution

_A companion to GPU-hosted compilation to WebAssembly, with Haskell and
interaction calculus as stress tests_

**Status:** research and engineering proposal, not an empirical results paper

**Date:** 22 July 2026

**Main paper:** [GPU-Hosted Compilation to WebAssembly](paper.md)

**Implementation:** [Executable Experiments A–F](README.md)

## Abstract

This paper asks which parts of type resolution and compile-time execution can
run usefully on a GPU through WebGPU. Its conclusion is deliberately asymmetric.
A compiler can expose substantial data parallelism in name lookup, local type
checking, constraint generation, equality propagation, candidate filtering, and
batches of independent compile-time computations. It should not treat an entire
modern type checker or macro system as one GPU kernel. Let-generalisation,
implication constraints, type-class search, macro staging, file access, useful
error explanations, and dynamically generated declarations require explicit
phase boundaries and often a CPU path.

The proposed foundation is a monotone constraint store over a finite-height
join-semilattice. Propagators only add information. Any fair sequential or
parallel schedule therefore converges to the same least fixed point. This gives
GPU execution a deterministic meaning independent of invocation order.
First-order type equality is implemented as a flat equality graph with
deterministic concurrent union, constructor decomposition, and a separate
occurs-check over the quotient graph. Polymorphic bindings are processed by
dependency strata because generalisation is a semantic barrier, not merely a
scheduling inconvenience. Haskell then reveals the limit of the simple model:
type classes, GADTs, type families, local assumptions, and evidence construction
require a stratified solver such as OutsideIn(X), with only selected propagation
and filtering stages moved to the GPU.

Compile-time execution is divided into constant evaluation, staged code
generation, syntax macros, type-directed macros, and compiler capabilities. Pure
bounded computations may run in a batched GPU bytecode evaluator.
Syntax-producing macros must return structured, hygienic syntax rather than
text. Impure macros run in a capability-limited CPU WebAssembly sandbox
controlled by JavaScript; WebGPU kernels have no filesystem, network, process,
or dynamic kernel-launch facilities. A staged dependency graph determines when
generated declarations must be parsed, resolved, and typed again.

Interaction nets and interaction calculus are relevant, but not as a replacement
for the compiler architecture. Their local, confluent graph reductions and
explicit duplication make them an interesting optional evaluator for pure
higher-order compile-time normalization. HVM2 demonstrates that this model can
be engineered for CUDA, while the current HVM repository is a separate,
pre-launch implementation under active development. Neither supplies a portable
WebGPU type solver or Wasm emitter. For the proposed compiler, flat monotone
propagation remains the primary type-analysis model; an interaction-calculus
evaluator is a worthwhile controlled experiment only after the simpler reference
pipeline works.

## 1. The question is not one workload

“Type resolution” commonly collapses several different compiler jobs:

1. **Name resolution:** determine which declaration an identifier denotes.
2. **Kind checking:** determine whether type constructors are applied legally.
3. **Type checking:** verify an expression against a known type.
4. **Constraint generation:** translate typing rules into equalities, class
   predicates, subtype bounds, and implications.
5. **Constraint solving:** derive substitutions or evidence, or find a
   contradiction.
6. **Generalisation and instantiation:** cross the boundary between monotypes
   and polymorphic type schemes.
7. **Normalization:** reduce type functions, associated types, or dependent
   terms.
8. **Elaboration:** produce explicit type applications, coercions, and
   dictionaries.
9. **Diagnosis:** explain a failure in terms of source constructs.

Their GPU suitability differs sharply.

| Work                            | Natural shape                                    | Initial WebGPU assessment     |
| ------------------------------- | ------------------------------------------------ | ----------------------------- |
| lexical name lookup             | tree queries, sort, join                         | strong fit                    |
| checking annotated expressions  | independent local rules plus child facts         | strong fit                    |
| constraint generation           | transform plus variable-length output            | strong fit                    |
| equality propagation            | concurrent graph closure                         | plausible, requires iteration |
| occurs check                    | cycle detection in a quotient graph              | plausible as a separate pass  |
| let-generalisation              | binding dependency strata and free-variable sets | barrier between strata        |
| class/trait candidate filtering | batched matching                                 | strong fit                    |
| class/trait commitment          | coherence, specificity, recursive search         | hybrid or CPU slow path       |
| type-family normalization       | irregular rewriting, possible divergence         | experimental                  |
| higher-order unification        | branching search                                 | poor first target             |
| error explanation               | provenance search and presentation               | CPU slow path                 |

The right claim is therefore not “type inference is parallel.” It is:

> A type system should expose a parallel constraint kernel and make its
> sequential, branching, and diagnostic boundaries explicit.

The same distinction applies to metaprogramming. Folding `3 * 7`, evaluating a
pure function over a million independent constants, transforming a token stream,
inspecting inferred types, and reading a schema from disk are all called
compile-time execution, but they demand different semantics and machinery.

## 2. Evidence: parallel type solving is possible, but conditional

Newton and collaborators parallelized Hindley–Milner inference and Typed Racket
checking with deterministic monotonic data structures called LVars [1]. Their
work is unusually relevant because it describes the core difficulty rather than
hiding it: type variables receive information from distant expressions,
production implementations use mutable references, and opportunities for useful
parallelism in ordinary Hindley–Milner inference can be limited. Their strongest
reported result, up to 8.46× on 14 cores, concerns selected difficult Typed
Racket examples and worst-case Hindley–Milner inputs, not a general speedup for
every source file.

Talbot and collaborators provide a complementary GPU result [2]. Parallel
Concurrent Constraint Programming defines propagators over lattices whose fixed
point is independent of sequential or parallel scheduling. Their TURBO prototype
runs propagation and search on a GPU and competes with a CPU solver on a
scheduling problem. The paper also calls it a first step: modern learning
techniques and many global constraints remain open. This supports the
mathematical execution model proposed here, not the stronger conclusion that an
existing general constraint solver can be dropped into a Haskell compiler.

GPU union-find algorithms show that concurrent equivalence closure and path
shortening are implementable efficiently on GPU hardware [3]. A type unifier
adds constructor compatibility, child equalities, source provenance, and an
occurs check; those additions are precisely where the proof and measurements
must focus.

The available evidence suggests three rules:

- use monotonic updates so scheduling cannot change the answer;
- separate propagation from alternative-producing search; and
- keep a diagnostic algorithm distinct from the fastest accept/reject path.

## 3. A deterministic theory for the GPU

### 3.1 Information as a lattice

Let `L` be a finite-height join-semilattice with order `⊑`, bottom `⊥`, join
`⊔`, and contradiction `⊤`. A compiler store is a product lattice

```text
S = L₀ × L₁ × ... × Lₙ₋₁
```

whose coordinates describe type variables, equality classes, candidate sets,
diagnostics, or other facts. A propagator

```text
p : S -> S
```

must be:

- **inflationary:** `s ⊑ p(s)`;
- **monotone:** `s₁ ⊑ s₂` implies `p(s₁) ⊑ p(s₂)`; and
- **deterministic as a function:** it derives the same facts from the same input
  state.

Compilation repeatedly applies propagators until no coordinate changes:

```text
s₀ = ⊥
sᵢ₊₁ = p₀(sᵢ) ⊔ p₁(sᵢ) ⊔ ... ⊔ pₖ₋₁(sᵢ)
```

Because the store only ascends and has finite height, this iteration terminates.
Under a fair schedule it reaches the least common fixed point. Parallel
invocations may discover facts in different orders, but joins commute and the
semantic result is unchanged. LVars and PCCP instantiate this same broad idea
[1, 2].

This model fits WebGPU’s bulk-synchronous execution. One dispatch reads
generation `i`, derives deltas, and atomically joins them into generation
`i + 1`. A reduction sets a `changed` status word. JavaScript schedules another
dispatch when needed, or encodes a bounded number of supersteps per command
submission. There is no device-wide barrier inside an ordinary WGSL workgroup,
so a fixed point cannot be assumed halfway through one dispatch [4].

### 3.2 What the theorem does not cover

The fixed-point argument does not make arbitrary search deterministic. Consider
two overlapping instances or two possible coercions. “Take the first thread to
succeed” would make language semantics depend on GPU scheduling. Alternatives
must instead be represented as values:

```text
NoCandidate
Unique(candidate_id)
Ambiguous(sorted_candidate_ids)
Contradiction(provenance_id)
```

Candidate discovery can be parallel. Commitment occurs only under a language
rule that proves a unique winner, using stable source IDs as tie-breakers only
where the language says order is irrelevant. Otherwise the compiler reports
ambiguity or invokes a separately specified search procedure.

Nontermination also does not disappear. A type family, recursive instance, or
compile-time program may generate an unbounded chain. The portable system
therefore has explicit limits on propagation rounds, generated constraints, heap
words, macro expansion depth, and evaluator steps. Hitting a limit is a resource
result with the relevant counts, not a claim that the program is ill-typed.

## 4. Flat Type Constraint Graph

The companion architecture extends the earlier Flat Compilation Graph (FCG)
pipeline with a frontend representation called **Flat Type Constraint Graph
(FTCG)**. FTCG exists before typed FCG. Once elaboration succeeds,
source-specific types and evidence are erased or translated into the
runtime-relevant FCG types described in the main paper.

### 4.1 Semantic constraints

The minimal research subset uses:

```text
type      ::= variable(id)
            | constructor(symbol, type*)
            | function(type, type)

scheme    ::= forall(variable*). predicates => type

constraint
          ::= equal(type, type)
           |  has_class(class_id, type*)
           |  implication(givens, wanteds, scope_id)
```

The first proof of concept should implement only equality constraints and rank-1
schemes. Class predicates and implications remain represented in the format so
that the boundary is visible, but they are rejected with a feature diagnostic
rather than half-implemented.

### 4.2 Physical tables

All identities are stable `u32` values. Variable-length children and provenance
live in edge arrays.

| Table       | Required columns                                       |
| ----------- | ------------------------------------------------------ |
| Type term   | kind, symbol ID, child range, source ID                |
| Type child  | child term ID                                          |
| Equality    | left term ID, right term ID, source ID                 |
| Binding     | syntax ID, dependency stratum, scheme range, source ID |
| Predicate   | class ID, argument range, scope ID, source ID          |
| Implication | given range, wanted range, parent scope, source ID     |
| Provenance  | rule ID, parent provenance range, source range         |

The store keeps additional columns for equivalence representatives, constructor
descriptors, class candidates, and status. It uses the same transform, scan,
gather, controlled scatter, sorting, and bounded-convergence algebra as FCG. The
important reuse is algorithmic, not semantic: FCG executes typed programs; FTCG
proves enough facts to produce one.

### 4.3 Name resolution before type resolution

Lexical name lookup is a particularly clean GPU pass when syntax is flat. Each
identifier use has a symbol ID and scope ID; each declaration has a symbol ID
and defining scope. Resolution asks for the declaration with the same symbol in
the nearest ancestor scope.

One implementation is:

1. assign Euler-tour entry and exit intervals to scopes;
2. stably sort declarations and uses by symbol ID;
3. within each symbol segment, match uses to declarations whose scope interval
   contains the use scope;
4. choose the containing scope with greatest depth; and
5. report zero matches as unbound and multiple equal-depth matches as ambiguous.

The exact join algorithm can change without changing name semantics. Generated
identifiers carry syntax-context scope IDs, so this pass also enforces macro
hygiene. It never resolves generated source text by string coincidence.

## 5. First-order unification as bulk graph closure

### 5.1 Generate before solving

Each expression receives a fresh type-term ID. Typing rules produce equality
rows without immediately mutating a global substitution. For example:

```haskell
f x
```

produces fresh result `r` and the equality

```text
type(f) = Function(type(x), r)
```

Independent subtrees generate constraints in parallel. A size pass counts each
subtree’s constraints, an exclusive scan assigns ranges, and a write pass fills
them.

### 5.2 Deterministic equality classes

The equality solver maintains a disjoint-set forest over type-term IDs.
Concurrent union always selects the minimum root ID as the canonical
representative. Atomic compare-and-exchange or `atomicMin`-style linking and
repeated pointer jumping shorten paths. The minimum-ID rule is not needed for
type correctness, but it ensures stable elaborated output and diagnostics across
adapters.

After unions settle for a superstep, each equivalence class is inspected:

- no constructor descriptor means the class is still an unconstrained variable;
- one constructor descriptor constrains the class to that constructor;
- two descriptors with different symbols or arities produce a constructor-clash
  diagnostic; and
- compatible descriptors emit equalities between corresponding children.

The child equalities are appended by count, scan, and scatter, then another
round begins. Duplicate equalities may be sorted and compacted to reduce work.
The process ends when no union or child equality is new.

This is a congruence-closure view of first-order unification. A full proof must
show that the final quotient represents a most-general unifier, not merely some
accepted equality graph. The CPU reference uses a conventional unifier and
compares normalized substitutions.

### 5.3 Occurs check is a separate graph question

Blindly unioning a variable with a term would accept an infinite type such as

```text
a = List a
```

if recursive types are not part of the language. After equality closure, build
the quotient constructor graph: each constrained class has directed edges to the
representatives of its constructor children. An equality class is invalid when
it is reachable from itself through at least one constructor edge. Strongly
connected components or batched reachability detect those cycles.

Separating the occurs check is intentional. It turns pointer-recursive
inspection during every union into one explicit graph invariant. It also makes
the language choice visible: a language with equi-recursive types would
interpret selected cycles rather than reject all of them.

### 5.4 Provenance and error selection

Every original and derived equality carries a provenance ID. A constructor clash
atomically minimizes a global tuple

```text
(source_start, source_end, constraint_id)
```

to select a deterministic primary failure. The GPU fast path reports the
conflicting terms and the first stable source location. The CPU diagnostic path
then replays the relevant binding stratum, follows provenance parents, and
constructs a human explanation.

This split follows the parallel type-checking literature’s observation that good
error reporting is often a distinct slow path [1]. It prevents the hot solver
from growing a complex mutable explanation graph while preserving useful
diagnostics.

## 6. Polymorphism creates real phase barriers

For Hindley–Milner let-polymorphism, solving every module constraint in one
undifferentiated fixed point is wrong. A binding must be solved before the
compiler can generalize variables not free in its environment; later uses
instantiate fresh copies of that scheme.

The binding dependency graph supplies the schedule:

1. resolve names and build binding dependencies;
2. compute strongly connected components;
3. topologically group components into strata;
4. generate and solve constraints for every component in the current stratum;
5. generalize eligible bindings at a device-wide barrier; and
6. instantiate those schemes while generating the next stratum.

Bindings within an independent stratum are parallel. Recursive bindings within
one component share monomorphic placeholders until their component is solved.
Dependencies between strata remain sequential because the later typing
environment genuinely depends on earlier schemes.

This boundary matters for Haskell. Modern GHC is not simply Algorithm W at
scale. OutsideIn(X) stratifies constraint generation and solving for type
classes, GADTs, type families, and local assumptions; those features can lack
principal local types and make unrestricted local generalisation impractical
[5]. A serious Haskell frontend must preserve:

- **given** constraints introduced by signatures and GADT pattern matches;
- **wanted** constraints generated by expressions;
- nested implication scopes;
- skolem variables that cannot escape;
- type-family equations and flattening variables;
- class evidence and coercion construction; and
- solver iteration and termination rules.

The proposed GPU does not replace OutsideIn(X). It accelerates selected
operations inside its strata:

- equality flattening and canonicalization;
- bulk lookup of class instances by head constructor;
- matching many wanted constraints against many candidates;
- monotone propagation of solved equalities;
- free-variable set construction; and
- deterministic compaction of inert and work lists.

Recursive instance selection, overlapping specificity, family reduction that may
expose new constraints, implication discharge, and evidence term assembly remain
hybrid until separately specified and tested. The proof of concept should
therefore begin with a Haskell-like rank-1 subset, not advertise full Haskell
source compatibility.

## 7. Compile-time execution needs a staged semantics

### 7.1 Five mechanisms that should not be conflated

| Mechanism           | Input                             | Output                  | Example                        | GPU role                              |
| ------------------- | --------------------------------- | ----------------------- | ------------------------------ | ------------------------------------- |
| constant evaluation | typed values                      | typed value             | array length, numeric constant | direct for batches                    |
| partial evaluation  | code plus known values            | residual code           | specialization                 | bulk local rewrites                   |
| syntax macro        | syntax object                     | syntax object           | derive declarations            | evaluator optional; hygiene mandatory |
| typed macro         | typed syntax and environment view | typed or untyped syntax | type-directed generation       | staged barrier required               |
| compiler capability | explicit external request         | bytes or metadata       | read schema file               | JavaScript/CPU only                   |

Zig’s `comptime` demonstrates one useful language rule: an expression explicitly
required at compile time either evaluates there or is rejected; runtime side
effects and external calls are not silently performed [6]. D’s compile-time
function execution demonstrates a different trade-off: ordinary functions can be
interpreted in compile-time contexts, but an infinite loop can hang the compiler
and implementation-defined behavior can differ [7]. These systems motivate
explicit effects and resource limits rather than choosing one surface syntax.

Rust procedural macros operate on token streams and run with the compiler
process’s file and standard-I/O access; the Rust Reference explicitly gives them
build-script-like security concerns and notes that an endless macro can hang
compilation [8]. Template Haskell exposes still richer staging: compile-time
splices, runtime code, quotations, cross-stage persistence, and declaration
groups that delimit what definitions and instances a macro can observe [9, 10].
A browser compiler cannot inherit those behaviors accidentally. It needs a
declared contract.

### 7.2 Stage-indexed code

A minimal theoretical core has the typing judgement `Γ ⊢ₛ e : τ`, meaning that
`e` has type `τ` at stage `s`, and stage-indexed code values:

```text
value type  τ
code type   Code<s, τ>

Γ ⊢ₛ₊₁ e : τ
------------------------------ quote
Γ ⊢ₛ quote e : Code<s + 1, τ>

Γ ⊢ₛ e : Code<s + 1, τ>
------------------------------ splice
Γ ⊢ₛ₊₁ splice e : τ
```

A quotation at stage `s` constructs code for `s + 1`. A splice within that later
code evaluates an earlier-stage code producer and inserts its result. The type
system prevents a later-stage value from being demanded during an earlier stage
unless it is explicitly serializable through cross-stage persistence. MetaML
established typed multi-stage programming with explicit quotation, escape, and
execution constructs [11]; Template Haskell’s current level rules are a
production example of the same need for phase correctness [9].

For this compiler, stages are operationally simpler:

```text
S0  parse and early syntax expansion
S1  name and kind resolution
S2  constraint generation and solving
S3  typed expansion and specialization
S4  typed FCG lowering and Wasm emission
R   runtime execution of emitted Wasm
```

A macro type states both its stage and effect:

```text
Macro<input_stage, output_stage, effect, input, output>
```

The initial effects are:

```text
PureFinite
PureFuelled
ReadDeclaredResource
HostCapability(capability_id)
```

Only `PureFinite` and explicitly fuelled pure jobs are GPU-eligible. Resource
reads and other capabilities execute through JavaScript. The type does not prove
termination for a general language; the runtime still enforces fuel and heap
limits.

### 7.3 Expansion is a dependency graph, not a preprocessor pass

A declaration macro may create new bindings, imports, instances, types, or
further macro calls. A typed macro must wait for some type facts and may
invalidate later ones. The scheduler therefore works in expansion groups:

```text
parse group
    -> expand early syntax macros
    -> resolve names and kinds
    -> generate and solve constraints
    -> run eligible typed macros
    -> if declarations were produced, form a later group
    -> otherwise lower to FCG
```

Earlier groups cannot observe declarations from later groups. A generated
declaration receives a stable origin containing the macro call site, expansion
ordinal, and source span. Expansion depth and the number of generated syntax
nodes are bounded. This resembles Template Haskell declaration groups, where
top-level splices divide a module into separately compiled groups and later
groups can see earlier ones but not vice versa [9].

The compiler rejects a cycle such as “macro `M` needs the type of `x`, while `x`
is generated by `M`” with the stage-dependency path attached. It does not
repeatedly expand and hope for convergence.

### 7.4 Hygiene is structured identity

Macros return syntax objects, never unparsed source text. Every identifier
contains:

```text
(symbol_id, scope_set_id, source_origin_id)
```

Binding forms and macro expansion introduce scopes. Resolution chooses a binding
whose scope set is the most specific compatible subset of the reference’s
scopes. Flatt’s sets-of-scopes model provides a practical foundation for
hygienic expansion, including recursive and mixed definition contexts [12].

On the GPU, scope sets are interned sorted ID ranges or compact bitsets for
small universes. Subset checks, interning candidates, and use-to-binding joins
are parallel operations. The semantic rule remains source-language-level; the
GPU representation must not reduce hygiene to renaming strings.

### 7.5 Two evaluators, one explicit boundary

The practical design uses two compile-time evaluators.

**GPU batch evaluator.** Pure compile-time functions lower to a small typed
bytecode stored in flat arrays. Thousands of invocations share the same opcode
stream or are grouped by program counter to reduce divergence. Values live in
preallocated arenas; a work queue holds resumable frames. A dispatch performs a
bounded number of instructions, records completed results, and leaves unfinished
frames for the next superstep. Good inputs include generated lookup tables,
vectorized constant transforms, independent derivations, and normalization of
many similar type terms.

**CPU Wasm evaluator.** Irregular macros and every capability-bearing macro
compile to ordinary WebAssembly and run through the JavaScript `WebAssembly`
API. The module receives only explicit imports such as
`read_resource(resource_id)`. It does not inherit ambient filesystem, network,
clock, randomness, or process access. The host accounts for input bytes, output
syntax nodes, and linear-memory growth. Execution is instrumented with fuel; a
browser host may additionally run it in a dedicated Worker that can be
terminated at a wall-clock deadline. Wasm isolation is only one layer; the
JavaScript host still owns capability and resource enforcement.

The two evaluators implement the same serialization format for values and syntax
objects. A macro’s declared effect and a cost heuristic select an evaluator.
Users may force the reference CPU evaluator for reproducibility or diagnosis.

### 7.6 Cache keys include effects

A compile-time result cache is sound only when its key covers every observable
input:

```text
hash(
  macro_wasm_or_bytecode,
  serialized_arguments,
  visible_type_environment,
  syntax_scope_context,
  compiler_semantics_version,
  target_feature_profile,
  capability_manifest,
  declared_resource_hashes,
  evaluator_limits
)
```

Clock, undeclared environment variables, directory enumeration, and network
access are absent by default because they make both caching and reproducible
builds ill-defined. A language may expose them as non-reproducible capabilities,
but the build metadata must then say so.

## 8. Interaction nets, interaction calculus, and HVM

### 8.1 A short introduction

An interaction net is a graph of agents. Each agent has one principal port and
zero or more auxiliary ports. Computation occurs only when two principal ports
are connected, forming an active pair. For each pair of agent symbols there is
at most one interaction rule. A rule replaces that small neighborhood while
preserving its external wires.

The locality has two important consequences. Disjoint active pairs can reduce
independently, and interaction nets have a strong confluence property: competing
one-step reductions can be joined [13]. Lafont later showed that a universal
system can be built from only three interaction combinators—an eraser, a
duplicator, and a constructor—with six interaction rules [14]. Fernández and
Mackie’s interaction calculus gives interaction nets a textual term-and-equation
representation [15].

The name **Interaction Calculus** is now used for related but not identical
dialects. HVM2 describes a textual system representing extended interaction
combinators [16]. The current HVM documentation presents a lambda-like calculus
with affine variables, explicit duplication and superposition, and four central
interactions; it explains the relationship to Lafont’s combinators but should
not be treated as literally the same syntax or rule set [17]. Any implementation
or proof must name the exact dialect.

### 8.2 Why it is genuinely interesting here

Interaction-based evaluation offers properties that ordinary tree interpreters
lack:

- reductions are local;
- independent active pairs expose fine-grained parallelism;
- confluence decouples the result from reduction order;
- duplication and erasure are explicit rather than hidden in a heap graph;
- graph sharing can avoid repeating work under lambda abstractions; and
- higher-order computation is native rather than encoded as a first-order GPU
  instruction set.

These properties align with pure compile-time normalization. A macro or
type-level program could lower to an interaction net, reduce active pairs in
parallel, and read the normal form back into a typed value or syntax object. It
is especially plausible when many terms have abundant independent reductions and
the result is much smaller than the intermediate graph.

The calculus also contributes a design lesson even if no HVM code is used: make
duplication, erasure, and work creation explicit. FTCG and FCG already follow
that spirit through counted output, scans, and explicit worklists.

### 8.3 Why it is not the primary compiler IR

Most compiler passes in the main proposal are relational array computations:

- join identifier uses with declarations;
- group constraints by representative;
- scan output sizes;
- sort and compact edges;
- propagate finite facts; and
- assign deterministic Wasm indices.

Encoding each of these as a higher-order graph-reduction program would add
dynamic allocation, atomic linking, scheduling, and readback without removing
the need for arrays. Interaction nets are an execution model for reducible
programs; they are not automatically a good physical representation for every
bulk compiler table.

Type solving also benefits from a different proof. A finite monotone store
yields a least fixed point and a direct correspondence with compiler facts.
Confluence of net reduction says reduction order does not alter a normal form
when one is reached; it does not by itself prove termination, principal types,
class coherence, macro hygiene, staging correctness, or quality of type errors.

There are practical WebGPU mismatches as well. HVM2’s historical GPU design
targets CUDA, uses warp synchronization, global kernel relaunches, fine-grained
atomics, and a 96 KiB shared-memory node/substitution arena in its documented
fast path [16]. Portable WGSL guarantees much less workgroup storage, exposes
only limited integer atomics, and offers no CUDA-style warp contract in its
baseline [4]. HVM2’s own repository says its CUDA modes require NVIDIA CUDA
12.x, are less stable than its C output, and are not the production
recommendation [18]. A direct port would be a new runtime project.

### 8.4 Current HVM status must be read carefully

The HVM2 paper is explicitly a work in progress. Its source lists unfinished
sections and substantial limitations: unsound reductions for some cloned
higher-order functions under the single-duplicator design unless additional
typing or bookkeeping is supplied; ultra-eager evaluation restrictions; immature
single-core performance; lambda-encoded algebraic data; a 32-bit address model;
and unresolved I/O details [16]. Its performance figures are useful hypotheses
from the project, not independent validation.

The current `HigherOrderCO/HVM4` repository is a newer codebase. As inspected on
22 July 2026, its README describes a C implementation of the newer Interaction
Calculus, states “you’re here before launch,” and does not present the HVM2 CUDA
path as a ready WebGPU backend [17]. The responsible interpretation is:

- Lafont’s interaction-net theory is established;
- HVM2 is valuable experimental evidence for a CUDA implementation strategy;
- current HVM is active pre-launch software with a changing calculus and
  runtime; and
- none of these is presently an off-the-shelf component for this WebGPU
  compiler.

### 8.5 The controlled experiment

Interaction calculus belongs in the research program as an optional evaluator
with a narrow interface:

```text
typed pure compile-time term
        -> exact-dialect interaction net
        -> bounded parallel reduction
        -> typed normal form or resource result
```

It should be compared against the CPU Wasm evaluator and the simpler GPU
bytecode worklist on identical pure programs. Metrics are total reductions,
allocated nodes, peak live nodes, dispatches, global atomic traffic, readback
bytes, and end-to-end time. Correctness is differential normal-form comparison.
The experiment is successful only if a recognizable workload class wins after
translation and readback costs.

For the type solver itself, interaction calculus is initially a red herring. For
higher-order compile-time evaluation, it is a credible research branch.

## 9. What is deployed, demonstrated, and still speculative

The following status is as of 22 July 2026.

| Area                                            | Status                              | Evidence boundary                                                                                            |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| compile-time evaluation in production languages | deployed                            | Zig, D, and other languages interpret selected source constructs [6, 7]                                      |
| syntax macros and staged Haskell code           | deployed                            | Rust procedural macros and GHC Template Haskell [8, 9]                                                       |
| hygienic scope-set expansion                    | deployed/research-backed            | Racket model and implementation evidence [12]                                                                |
| parallel HM / rich type checking on CPUs        | demonstrated research               | LVars implementation and measured selected workloads [1]                                                     |
| deterministic GPU constraint propagation        | demonstrated research               | PCCP/TURBO scheduling problem prototype [2]                                                                  |
| GPU union-find                                  | demonstrated in graph/image domains | algorithmic precedent, not a type unifier [3]                                                                |
| HVM2 parallel functional evaluation             | experimental                        | C/CUDA project and work-in-progress paper [16, 18]                                                           |
| current HVM Interaction Calculus runtime        | pre-launch experimental             | current repository warning [17]                                                                              |
| portable WebGPU HM solver                       | proof-of-concept implemented        | the linked artifact runs equality closure and quotient occurs checks; comprehensive measurements remain open |
| hygienic WebGPU macro evaluator                 | proposed here                       | no implementation or measurements yet                                                                        |
| full Haskell type checking on WebGPU            | not proposed as an initial claim    | selected OutsideIn(X) kernels only                                                                           |
| interaction-calculus CTFE on WebGPU             | optional experiment                 | requires a new portable runtime                                                                              |

This literature review did not find an end-to-end system that accepts Haskell
source, performs type inference and compile-time metaprogramming on WebGPU, and
emits Wasm. That is a search result, not a proof that no unpublished or
differently described system exists.

## 10. Proof-of-concept sequence

The auxiliary work should precede, but not indefinitely delay, the original
Haskell-to-Wasm proof of concept.

### Experiment A: rank-1 CPU oracle

Implement a tiny Haskell-like language with variables, lambdas, application,
`let`, integers, booleans, and type annotations. Build name resolution,
constraint generation, conventional unification, generalisation, instantiation,
and source diagnostics in readable TypeScript.

Exit criteria:

- principal types agree with a separately written declarative checker on
  generated programs;
- recursive and non-recursive binding groups are distinct;
- infinite types, constructor clashes, unbound names, and ambiguous bindings
  have direct tests; and
- the typed output lowers to the existing FCG contract.

### Experiment B: WebGPU equality solver

Keep parsing, dependency SCCs, generalisation, and diagnostics on the CPU. Move
equality-class union, constructor grouping, child-constraint generation, and
quotient-graph occurs checks to WebGPU.

Exit criteria:

- normalized substitutions match the CPU oracle exactly;
- generated FCG and Wasm bytes are identical;
- results are stable across repeated schedules and workgroup sizes;
- resource exhaustion reports requested and allowed counts; and
- break-even curves separate upload, propagation, occurs check, and readback.

### Experiment C: pure compile-time bytecode

Add `comptime e` for typed, pure expressions returning serializable values.
Compile these expressions to the small evaluator bytecode. Run one CPU reference
and one batched WebGPU worklist implementation.

Exit criteria:

- evaluation results and resource failures match;
- generated values participate in later type checking without an implicit text
  round trip;
- infinite recursion consumes fuel and returns a resource diagnostic; and
- benchmarks include many tiny jobs, one irregular job, and large regular
  batches.

### Experiment D: hygienic syntax macros in CPU Wasm

Add declaration macros from structured syntax to structured syntax. Compile
macro bodies to Wasm and expose no capabilities in the first version. Add scope
sets, declaration groups, stable origins, and cache keys.

Exit criteria:

- capture and intentional-reference tests distinguish scope contexts;
- later groups see generated declarations while earlier groups do not;
- expansion cycles report the dependency path;
- repeated builds are byte-identical; and
- a malicious infinite or memory-growing macro is terminated by configured
  limits.

### Experiment E: interaction-calculus evaluator

Only after Experiment C establishes workloads and baselines, translate the pure
compile-time subset into one pinned interaction-calculus dialect. Implement or
adapt a CPU evaluator first; port reduction to WebGPU only if the representation
has a credible portable layout.

Exit criterion: it wins a specified workload class end to end, or the project
records that the translation, atomics, allocation, and readback outweigh its
parallel reductions. Either result answers the research question.

### Experiment F: Haskell frontend growth

Add algebraic data types and rank-1 class constraints, with dictionary evidence.
Treat signatures and local implications as later work. Template Haskell
compatibility is not part of the first Haskell artifact; the staged macro system
above is the experimental language’s semantics, not a promise to reproduce every
GHC behavior.

## 11. Falsifiable hypotheses

- **T1:** name resolution and constraint generation achieve higher throughput on
  WebGPU only for large or batched modules; CPU latency remains lower for small
  edits.
- **T2:** equality propagation plus a separate occurs check reproduces the CPU
  most-general unifier for the supported rank-1 language.
- **T3:** deterministic minimum representatives and stable sorting produce
  byte-identical elaboration across adapters.
- **T4:** let-generalisation barriers, rather than equality propagation,
  dominate dependency depth in ordinary polymorphic modules.
- **T5:** GPU class-candidate filtering reduces work, but recursive commitment
  and diagnostic replay remain more efficient on the CPU for the initial Haskell
  subset.
- **C1:** batched pure compile-time jobs amortize WebGPU dispatch and outperform
  CPU interpretation above a measurable job-count and work threshold.
- **C2:** capability-bearing macros cannot benefit directly from GPU execution;
  their useful GPU work appears only as explicit pure subcomputations.
- **C3:** structured hygienic syntax has acceptable transfer cost relative to
  token or text generation for large macro batches.
- **I1:** interaction-calculus evaluation beats the bytecode worklist only on
  terms with sufficient independent active pairs and sharing to repay graph
  allocation.
- **I2:** the portable WebGPU implementation has a materially different
  performance envelope from HVM2’s CUDA results because baseline WGSL lacks its
  shared-memory and warp assumptions.

Rejecting these hypotheses is useful. In particular, if T2 holds but no
practical workload crosses the GPU break-even point, the flat type
representation and CPU oracle remain valuable while the type solver stays on the
CPU.

## 12. Correctness obligations

### 12.1 Type inference

For the rank-1 subset:

1. constraint generation is sound and complete with respect to the declarative
   typing relation;
2. GPU equality closure is equivalent to first-order unification;
3. the quotient occurs check rejects exactly the forbidden cyclic substitutions;
4. generalisation quantifies exactly the variables free in the inferred type but
   not the environment;
5. instantiation replaces every quantified variable with a fresh variable; and
6. elaboration preserves the inferred source semantics.

For extensions, each predicate domain supplies its own entailment and evidence
theorem. Parallel candidate discovery cannot weaken class coherence.

### 12.2 Staging and macros

1. every splice consumes code from an earlier legal stage;
2. generated syntax is well-scoped under the hygiene model;
3. typed quotations cannot construct an ill-typed term of their claimed type;
4. macro expansion groups obey their visibility order;
5. capability effects cover every external observation;
6. evaluator selection does not change the result; and
7. cache reuse is observationally equivalent to re-execution.

Resource limits complicate the theorem. The operational result is one of:

```text
Success(value_or_syntax)
LanguageError(diagnostic)
ResourceLimit(kind, used, allowed, source)
HostFailure(capability, evidence)
```

A resource result is not interchangeable with divergence or a language error.

### 12.3 Interaction evaluator

The exact source-to-net translation must preserve meaning for the supported pure
subset. Parallel reduction must implement the pinned dialect’s rules, and
readback must yield the same normal form as the CPU reference. Claims about
Lafont’s combinators do not automatically prove extensions for numbers,
constructors, labels, global definitions, or HVM-specific operations.

## 13. Recommendation

The proof of concept should adopt three architectural decisions now.

First, place a flat, provenance-carrying constraint graph before FCG. Use the
GPU for name joins, constraint generation, deterministic equality closure, and
batch filtering. Keep dependency SCCs, generalisation boundaries, branching
solver policy, and explanatory diagnostics visible even when some later move to
the GPU.

Second, define compile-time execution as a staged, effect-typed subsystem. Run
pure regular batches in a GPU evaluator and irregular or capability-bearing
macros in CPU Wasm under JavaScript control. Preserve hygiene with syntax
contexts, not generated strings. This makes browser and Deno execution safer and
gives caching a coherent meaning.

Third, keep interaction calculus as a side experiment. It is not a shortcut to
compiling Haskell, resolving Haskell types, or emitting Wasm. It may become an
excellent evaluator for a pure higher-order compile-time fragment, and its
theory offers valuable guidance about locality, confluence, duplication, and
erasure. The project should earn that complexity through an A/B result against
the simpler evaluator.

The resulting system is less dramatic than “put the Haskell compiler on the
GPU,” but more defensible: a JavaScript-orchestrated compiler whose
data-parallel kernel includes parts of its frontend, whose metaprograms run
under explicit stages and capabilities, and whose typed result enters the same
GPU-hosted FCG-to-Wasm backend.

## References

1. Ryan R. Newton, Ömer S. Ağacan, Peter Fogg, and Sam Tobin-Hochstadt.
   [_Parallel Type-checking with Haskell using Saturating LVars and Stream Generators_](https://osa1.net/papers/type-checking-with-lvars.pdf).
   PPoPP 2016. DOI
   [10.1145/2851141.2851142](https://doi.org/10.1145/2851141.2851142).
2. Pierre Talbot, Frédéric Pinel, and Pascal Bouvry.
   [_A Variant of Concurrent Constraint Programming on GPU_](https://ptal.github.io/papers/aaai2022.pdf).
   AAAI 2022. DOI
   [10.1609/aaai.v36i4.20298](https://doi.org/10.1609/aaai.v36i4.20298).
3. Jun Chen, Qiang Yao, Houari Sabirin, Keisuke Nonaka, Hiroshi Sankoh, and Sei
   Naito.
   [_An Optimized Union-Find Algorithm for Connected Components Labeling Using GPUs_](https://arxiv.org/abs/1708.08180). 2017.
4. W3C GPU for the Web Working Group.
   [WebGPU Shading Language](https://www.w3.org/TR/WGSL/) and
   [WebGPU Specification](https://gpuweb.github.io/gpuweb/). Workgroup
   synchronization, atomics, storage limits, dispatch, and buffer access.
   Accessed 22 July 2026.
5. Dimitrios Vytiniotis, Simon Peyton Jones, Tom Schrijvers, and Martin
   Sulzmann.
   [_OutsideIn(X): Modular Type Inference with Local Assumptions_](https://simon.peytonjones.org/outsideinx/).
   _Journal of Functional Programming_ 21, 2011.
6. Zig Software Foundation.
   [Zig Language Reference: `comptime`](https://ziglang.org/documentation/master/#comptime).
   Accessed 22 July 2026.
7. D Language Foundation.
   [D Language Specification: Compile Time Function Execution](https://dlang.org/spec/function.html#interpretation).
   Accessed 22 July 2026.
8. Rust Project.
   [The Rust Reference: Procedural macros](https://doc.rust-lang.org/stable/reference/procedural-macros.html).
   Accessed 22 July 2026.
9. Glasgow Haskell Compiler.
   [Template Haskell: Levels, Stages, and Declaration Groups](https://downloads.haskell.org/ghc/latest/docs/users_guide/exts/template_haskell.html).
   Accessed 22 July 2026.
10. Tim Sheard and Simon Peyton Jones.
    [_Template Meta-programming for Haskell_](https://www.microsoft.com/en-us/research/publication/template-meta-programming-for-haskell/).
    Haskell Workshop, 2002.
11. Walid Taha and Tim Sheard.
    [_Multi-Stage Programming with Explicit Annotations_](https://doi.org/10.1145/258994.259019).
    PEPM 1997.
12. Matthew Flatt.
    [_Binding as Sets of Scopes_](https://users.cs.utah.edu/plt/scope-sets/).
    POPL 2016, extended version and artifacts.
13. Yves Lafont. [_Interaction Nets_](https://doi.org/10.1145/96709.96718).
    POPL 1990.
14. Yves Lafont.
    [_Interaction Combinators_](https://doi.org/10.1006/inco.1997.2643).
    _Information and Computation_ 137(1), 1997.
15. Maribel Fernández and Ian Mackie.
    [_A Calculus for Interaction Nets_](https://doi.org/10.1007/10704567_10).
    PPDP 1999.
16. Victor Taelin.
    [_HVM2: A Parallel Evaluator for Interaction Combinators_](https://raw.githubusercontent.com/HigherOrderCO/HVM2/main/paper/HVM2.pdf)
    and
    [current paper source](https://raw.githubusercontent.com/HigherOrderCO/HVM2/main/paper/HVM2.typst).
    Work in progress. Accessed 22 July 2026.
17. Higher Order Company.
    [HVM4 repository](https://github.com/HigherOrderCO/HVM4) and
    [Interaction Calculus documentation](https://raw.githubusercontent.com/HigherOrderCO/HVM4/main/docs/theory/interaction_calculus.md).
    Pre-launch software. Accessed 22 July 2026.
18. Higher Order Company.
    [HVM2 repository and runtime modes](https://github.com/HigherOrderCO/HVM2).
    Accessed 22 July 2026.

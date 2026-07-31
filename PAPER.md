# A Typed, Ownership-Safe Effect Boundary for a GPU-Parallel Compiler

## Abstract

This paper specifies the source semantics and compiler boundary for Ducklang,
the source language compiled by this project. Ducklang uses algebraic effects in
the source and typed semantic IR, eliminates handlers before resource-aware SSA,
and sends only effect-closed flat programs to GPU compiler passes. The selected
model is fine-grain call-by-value with open effect rows, lexically selected
capabilities, deep one-shot handlers, control-flow linearity, and structural
capability passing with direct state passing for linear tail-resumptive handlers
and selective CPS otherwise.

The GPU never executes source handlers and never searches for a handler. It
transforms CPU-validated, effect-closed payload IR. This separation keeps source
control semantics and trust-boundary validation on the CPU while preserving the
bulk, deterministic compiler transformations that are suitable for the GPU.

This document is simultaneously the language specification, derivation of the
compiler representation, implementation report, cost model, and continuous
research log. A passing test is evidence about an implementation, not a proof of
the specification. Each implemented claim below states its executable evidence;
unimplemented rules remain explicitly marked.

## 1. Status and review discipline

- Last semantic review: 2026-07-31.
- Implementation under review: the repository revision containing this document.
- Normative status: Sections 3 through 8 define the intended language and
  compiler boundary.
- Implementation status at the start of this migration: the effect prototype
  compiles the corpus but violates one-shot control and effect preservation.
- Review triggers: any change to effect syntax, callable types, ownership,
  handlers, Core signatures, the host ABI, handler lowering, WebAssembly
  continuation support, or the GPU flat schema.

Claims use four evidence classes:

1. **Theorem obligation**: a property the formal rules require.
2. **Executable invariant**: checked for every compiled program.
3. **Conformance evidence**: tests derived independently from the rule.
4. **Measurement**: an empirical result with a named workload and environment.

No empirical result discharges a theorem obligation by itself.

This repository retains two earlier design proposals: `paper.md` describes the
original flat GPU backend, and `type-resolution-and-comptime.md` describes the
original type and staging experiments. Their dated proposals and hypotheses are
historical inputs, not current implementation claims. This document is
normative; `PERFORMANCE.md` contains reproducible empirical evidence; `TASKS.md`
records completion criteria; and `THEORY.md` is historical migration material.

## 2. Research basis and design decision

Plotkin and Pretnar model algebraic operations as the free model of an algebraic
theory and handlers as induced homomorphisms. This justifies a computation-tree
reference semantics and the rule that a handler interprets operations while
preserving sequencing.

Daan Leijen gives a practical call-by-value type-and-effect system with open
rows and a type-directed selective CPS translation. His operational rule
captures a syntactic evaluation context and reinstalls a deep handler around the
resumption. The Koka design also demonstrates that row polymorphism must be part
of function types; a side table keyed only by statically known functions is
insufficient for higher-order calls.

Zhang and Myers show that conventional dynamic handler search breaks abstraction
for higher-order effect-polymorphic code. Ducklang therefore selects handlers
through lexical capability evidence. Code may handle only an effect instance its
static interface knows.

Schuster, Brachthäuser, and Ostermann derive capability-passing and iterated CPS
translations. Xie and Leijen derive evidence passing, including constant-time
handler selection and an in-place optimization for tail-resumptive operations.
Those results do not justify deleting the continuation merely because `resume`
is last in a clause: the continuation captured at the performance may still
contain arbitrary work. They do justify a different representation for the
restricted case. A whole handled region can be translated to an ordinary
state-passing function when every operation clause resumes exactly once in tail
position. The caller's remaining work then stays in direct style after the
operation transition returns; it is not discarded. Structural one-shot CPS
remains the semantics-preserving fallback for every other admitted handler.

Tang, Hillerström, Lindley, and Morris show that ordinary value linearity is
unsound in the presence of handlers that discard or duplicate continuations.
Their control-flow linearity tracks how often an operation's continuation may be
entered. Ducklang initially restricts all resumptions to one-shot control:
linear continuations are entered exactly once and affine continuations at most
once.

Bosman, van den Berg, Tang, and Schrijvers show that scoped operations require a
separate calculus with an internal computation and explicit forwarding. Ducklang
does not silently treat task groups, bracketing, transactional alternatives, or
other higher-order/scoped operations as ordinary algebraic operations.

The selected architecture is:

```text
Duck source
  -> syntax
  -> name-resolved syntax
  -> typed Effect HIR
  -> ownership and control-flow validation
  -> capability passing and direct-state/selective-CPS lowering
  -> effect-closed resource-aware SSA Core
  -> flat GPU package
  -> optimized Core
  -> structured WebAssembly
```

## 3. Source calculus

### 3.1 Signatures, values, computations, and rows

An effect signature maps each operation to a value parameter and result:

```text
Σ(op) = P -> R
```

An effect capability `κ : Σ` is a generative lexical identity. Two capabilities
with the same signature are distinct. An operation identity is the pair `κ.op`,
never only a textual family name.

Value and computation types are distinct:

```text
A, B ::= Unit | Bool | I32 | ... | A -> (B ! ε) | Capability Σ
C    ::= A ! ε
```

An effect row is an unordered, canonical row with an optional tail variable:

```text
ε ::= <> | <κ.op | ε> | ρ
```

Rows may be open during inference. A closed row contains no `ρ`. Source union,
intersection, and difference syntax elaborates to row constraints; it is not
implemented by untyped textual set arithmetic.

The static judgments separate unrestricted and owned environments:

```text
Γ ; Δ ⊢v v : A
Γ ; Δ ⊢c c : A ! ε
```

`Γ` contains unrestricted values. `Δ` contains affine or linear owners whose
consumption and cleanup obligations must be preserved.

### 3.2 Purity

A computation is algebraically pure exactly when its row is empty:

```text
pure(c) iff Γ ; Δ ⊢c c : A ! <>
```

This does not imply termination. Bounds traps, panic, allocation, immutable
reads, ownership transfer, and host capabilities have distinct operational
classifications. A pure handler may eliminate an operation by interpreting it as
a value. An impure handler forwards or introduces capabilities in its result
row.

### 3.3 Operations and sequencing

For `Σ(op) = P -> R`:

```text
Γ ; Δ ⊢v κ : Capability Σ    Γ ; Δ ⊢v v : P
────────────────────────────────────────────────
Γ ; Δ ⊢c perform κ.op(v) : R ! <κ.op>
```

Sequencing combines rows and transfers the returned value:

```text
Γ ; Δ1 ⊢c c1 : A ! ε1
Γ, x : A ; Δ2 ⊢c c2 : B ! ε2
────────────────────────────────────────────────
Γ ; Δ1 ⊎ Δ2 ⊢c let x <- c1 in c2 : B ! (ε1 ∪ ε2)
```

The ownership split is subject to the value's multiplicity and the language's
existing ownership rules.

### 3.4 Callable types and row polymorphism

Every function type carries the latent row of its body:

```text
A -> (B ! ε)
```

Application uses the callee expression's inferred type. It never assumes an
opaque callee is pure:

```text
Γ ; Δ1 ⊢v f : A -> (B ! ε)
Γ ; Δ2 ⊢v a : A
────────────────────────────────────
Γ ; Δ1 ⊎ Δ2 ⊢c f(a) : B ! ε
```

Row variables are generalized with ordinary type variables at permitted
let-generalization boundaries and instantiated freshly at every use. The
generalization rule must obey the same value and ownership restrictions as
ordinary polymorphism. A row variable is not represented as “effects of
parameter number n”; that representation loses equality between rows and cannot
type arbitrary callable expressions.

### 3.5 Deep handlers and answer types

Let computation `c` return `A`, perform operations belonging to capability `κ`,
and forward row `ε`. Let `ζ` be the output row of the whole handler. A handler
has one answer type `B`:

```text
Γ ; Δc ⊢c c : A ! (<κ> ∪ ε)
Γ, x : A ; Δr ⊢c h.return(x) : B ! ζ
Γ, p : Pi, k : Ri -q-> (B ! ζ) ; Δi ⊢c h.opi(p, k) : B ! ζ
ε ⊆ ζ
────────────────────────────────────────────────────────────
Γ ; Δc ⊎ Δr ⊎ (⊎i Δi) ⊢c handle κ with h in c : B ! ζ
```

Each operation in `Σ` must have a well-typed clause. The clause itself executes
outside the current handler. Invoking `k` reinstalls the deep handler.

The control multiplicity is:

```text
q ::= linear | affine
```

A linear resumption must be invoked exactly once on every normal path. An affine
resumption may be invoked zero or one time. Multi-shot control is not admitted.

### 3.6 Operational semantics

Evaluation contexts are defined by the source language's call-by-value order:

```text
E ::= []
    | let x <- E in c
    | E(v)
    | v(E)
    | if E then c1 else c2
    | handle κ with h in E
    | ... one production for every strict source construct
```

`Eκ` contains no intervening handler for capability `κ`. The essential rules
are:

```text
handle κ with h in return v
  -> h.return(v)

handle κ with h in Eκ[perform κ.op(v)]
  -> h.op(v, λq x. handle κ with h in Eκ[return x])
```

These rules define source behavior. Compiler traversal order, object layout,
hash-map order, and optimization order may not alter it.

## 4. Ownership and control-flow linearity

For a performance `p` in context `E`, the continuation captures:

```text
capture(p) = FV(E) ∩ Δ
```

The required multiplicity is derived from ownership evidence:

```text
non-discardable(capture(p)) ≠ ∅  => linear
otherwise                         => affine
```

This is a control-flow judgment. Counting syntax references is invalid because:

- one reference inside a loop may execute multiple times;
- two references in mutually exclusive branches may execute once;
- a reference stored in a closure may escape;
- early return, break, trap, and abort change the paths on which cleanup runs.

The checker operates on typed Effect HIR while performances and resumptions are
explicit. It uses the existing resolved symbol identities, not source text.
Dropping an affine continuation must emit or prove cleanup for every captured
affine owner. A continuation containing a non-discardable owner cannot be
dropped.

## 5. Typed Effect HIR

The Effect HIR is the last representation carrying source effect semantics. Its
normative operations are:

```text
return(value)
let(result, computation, body)
perform(capability_id, operation_id, operands)
handle(capability_id, handler_id, computation)
resume(resumption_id, value)
```

Each computation node carries:

- returned value type;
- canonical effect row;
- source span;
- resolved operand symbols;
- ownership inputs and outputs.

Each handler carries:

- generative capability ID and signature;
- input and answer types;
- forwarded and clause rows;
- typed return and operation clauses;
- resumption IDs and multiplicities.

Capability IDs are deterministic compiler IDs derived from resolved lexical
identity. Their deterministic representation does not remove their generative
semantic identity.

## 6. Structural lowering

### 6.1 Capability passing

Every function receives evidence for the capabilities in its monomorphic
required row. For a call site `c`:

```text
added_operands(c) = |capabilities(type(callee(c)))|
```

The program-wide count is:

```text
capability_operand_count =
  Σc added_operands(c)
```

This is not the number of distinct root effect-family names.

Operation clauses are explicit capability operands. A handler is eligible for
direct state passing only if each operation clause has the following syntactic
and typed evidence:

1. the clause has a resumption parameter;
2. exactly one use of that parameter occurs on every admitted path;
3. that use is the clause's tail computation;
4. the value supplied to `resume` does not itself use the resumption.

The first implementation admits a `resume` directly or a block whose result
satisfies the same rule and whose preceding steps contain neither a resumption
nor an early `return`. Branching around the resumption and all zero-use,
non-tail, or otherwise irregular clauses retain CPS. This deliberately
incomplete recognizer cannot change semantics: a false negative costs
performance, whereas a false positive would be unsound.

Let `S = S₁ × ... × Sₙ` be the product of immutable versions of the handler
state, and let operation `op : P -> R` have a qualifying clause. The direct
translation has:

```text
D[c] : S -> (A × S)
δop  : P × S -> (R × S)

D[return v] s =
  (v, s)

D[let x <- c₁; c₂] s =
  let (x, s₁) = D[c₁] s
  in D[c₂] s₁

D[perform op p] s =
  δop(p, s)

δop(p, s) =
  translate the clause prefix and replace tail `resume r` by (r, s')

H[c] s₀ =
  let (v, s_f) = D[c] s₀
  in return_clause(v, s_f)
```

This does not assert that the captured performance continuation is tail.
Instead, it represents the operation clause as a state transition and leaves the
caller's continuation after the ordinary call to `δop`. A straightforward
induction on the sequencing rules proves equivalence with the deep-handler rule:
the unique tail `resume r` feeds `(r, s')` to exactly the direct continuation
that CPS would invoke. Immutable shadow versions preserve the source assignment
order without introducing a shared mutable reference.

A prefix binding is a state component exactly when it is the root of a typed
`previous` shadow chain or carries linear ownership. Other immutable handler
parameters and immutable local bindings stay in the clause closure environment;
threading them would be semantically redundant and would enlarge every
transformed signature. A linear binding is threaded even when it is not
shadowed, because placing it in a reusable clause closure would duplicate its
ownership. Unit components are erased and singleton products are represented by
their element. These are the standard product isomorphisms `1 × A ≅ A` and do
not remove observable data.

For a transformed function with `a` original arguments, `c` lexical captures,
`n` shadowed or linearly owned state components, and `o` operation capabilities,
direct state passing uses `a + c + n + o` inputs and at most `1 + n` logical
outputs. CPS adds one continuation input and creates a continuation value at
each performance or effectful call boundary. The direct path therefore removes
continuation construction and its captured environment, at the cost of passing
and returning the non-erased state components.

### 6.2 Selective CPS and defunctionalization

General one-shot resumptions transform only the effectful call-graph slice.
Continuations become typed blocks or defunctionalized closure records. The
translation visits every HIR node once and never exposes an operation by
substituting or inlining source syntax.

For performance `p`, its continuation environment is:

```text
environment(p) = live_values_after(p)
environment_bytes(p) =
  align(header_bytes + Σv∈environment(p) representation_bytes(v))
```

A one-shot environment is consumed by `resume`. A second consumption is a
compiler invariant violation, not a runtime language behavior.

Handler layers are lowered from the inside out. If an outer effect occurs in a
continuation generated for an inner handler, lowering rewrites that generated
continuation too. The CPS fallback requires its result type to equal the outer
handler answer type. Directly lowered inner handlers do not create that
continuation boundary, so qualifying answer-type-changing handler composition is
admitted. Non-tail answer-type-changing composition still requires answer-type
polymorphism or a typed iterated CPS representation.

### 6.3 Demand-driven specialization

Specialization is an offline partial evaluation over typed HIR. A binding-time
classification separates values known to the compiler from residual runtime
values. The residual program must be observationally equivalent for every
runtime input; specialization may select a static branch or substitute a static
value, but may not evaluate a residual effect or duplicate a linear value.

Let `B` be module bindings, `r` the module result, `refs(e)` the binding symbols
referenced by expression `e`, and `I` the runtime non-function bindings whose
initializers must execute. The demanded binding set is the least fixed point:

```text
D₀ = refs(r) ∪ I
Dₙ₊₁ = Dₙ ∪ ⋃b∈Dₙ refs(value(b))
D = μDₙ
```

Every first-class function reference and every unresolved dynamic callee is an
ordinary reference in this equation. Demand analysis therefore preserves a
dynamic call rather than assuming a statically selected target. A binding
outside `D` cannot contribute a value or initializer effect to the module
result, so discarding it before specialization is equivalent to discarding it
after specialization.

An inline specialization request has the key:

```text
K = (
  function_identity,
  diagnostic_site,
  static_argument_identity,
  residual_argument_identity,
  referenced_static_environment_identity
)
```

Every value identity includes its type. Static scalars use a tagged value,
products and union cases compose the identities of their elements, functions use
immutable in-pass function identities, and references use resolved symbol
identities. An opaque residual expression uses immutable object identity. This
last case may miss an optimization when two separately allocated expressions are
equal, but it cannot merge two distinct in-pass values. Source spans form the
diagnostic-site component while diagnostics are source-attributed, so two
otherwise equal calls at different sites are not accidentally merged.

A key is entered as `pending` before its body is rewritten and becomes
`complete` afterward. Encountering the same pending key residualizes the call.
Recursive source functions are already excluded from inline specialization.
Consequently an exact cycle terminates without changing behavior, and every
complete key is rewritten at most once.

For the post-comptime pass, let `C` be bindings whose contents changed during
comptime replacement. The dirty frontier is the reverse dependency closure:

```text
F₀ = C
Fₙ₊₁ = Fₙ ∪ { b ∈ D | refs(value(b)) ∩ Fₙ ≠ ∅ }
F = μFₙ
```

Only bindings in `F` are specialized again. An unchanged binding retains the
immutable value produced by the first pass. The module result is revisited
exactly when its references intersect `F` or its own comptime replacement
changed.

If `C = ∅` and the module result did not change, then `F = ∅` by induction on
the frontier equation. Comptime returns the original immutable module object in
this case, and the compiler omits the second specialization call entirely. The
residual node count remains the first pass's exact count. Thus a clean second
stage has zero rewrite, lifting, reachability, and accounting work rather than
merely an empty rewrite set.

The comptime replacement relation itself defines change. A non-deferred
`comptime e` changes; the compiler-only projections `:>` and `:<` change; `:+`
changes when its rewritten operands satisfy the empty/product concatenation
rules; and a parent changes exactly when one of its children changes. This
syntax-directed judgment is both cheaper and more exact than comparing two fully
serialized trees after reconstruction.

The retention ledger records input bindings and nodes, demanded bindings and
nodes, residual bindings and nodes, distinct specialization keys, cache hits,
distinct and repeated source-function analyses, comptime-changed bindings, and
the post-comptime rewrite frontier. Define:

```text
binding_retention = residual_bindings / input_bindings
node_retention = residual_nodes / input_nodes
rewrite_amplification = residual_nodes / demanded_input_nodes
```

Node counting is a pure fold over one immutable expression root that counts each
object in that root's reachable DAG once. Input, demanded-input, rewritten-input,
and residual metrics frequently project the same root:

```text
node_count(e) = |reachable_expression_objects(e)|
```

A pass-local weak identity map memoizes `node_count(e)`. Reusing a cached result
is exact because typed expressions are immutable, and cache lifetime is one
specialization pass. Distinct root objects remain distinct even when
structurally equal; two ledger fields that include the same root still add its
count independently, as before. Thus memoization changes observation work but
not any reported count. If requested roots are \(e_1,\ldots,e_q\), work changes
from \(O(\sum_i |e_i|)\) to \(O(\sum_{e\in unique(e_i)} |e| + q)\). The ledger
reports cache hits and the sum of cached node counts, which is the exact number
of repeated logical node visits avoided by this implementation.

Every specialization pass also reports non-overlapping wall time for demand
discovery, frontier construction, rewriting, function lifting, reachability, and
exact ledger accounting. These measurements classify costs; they do not change
specialization decisions and are not semantic evidence.

For a typed immutable function value `f`, specialization caches the pure
summary:

```text
A(f) = (
  inlineable_body,
  referenced_symbols,
  parameter_symbols,
  directly_called_symbols
)
```

The key is the function object's in-pass identity, not its source span. Reusing
`A(f)` is sound because none of its components depends on call arguments or the
current static environment. A separately allocated function is analyzed
independently even when it has the same span. This deliberately trades possible
cache misses for the invariant that distinct rewritten closures are never
conflated.

Without the summary, a candidate with `p` parameters can scan its body once for
each of four static-value classes, again for intrinsic-call use, and again for
the environment:

```text
analysis_without_summary = O((5p + 1) body_nodes(f))
analysis_with_summary = O(body_nodes(f) + p) per distinct f
                        + O(p) per candidate call
```

The summary does not authorize specialization. Existing argument and
profitability predicates consume it and remain unchanged.

Parameter substitution is fused with rewriting. Let `Rρ(e)` be the rewriter
under a stack of immutable symbol environments and let Ducklang's resolved
symbol IDs be globally unique. The reference rule is:

```text
Rρ(reference x) =
  Rρ(ρ(x))  when the nearest environment binds x
  R(reference x) otherwise
```

Every other rule recursively applies `Rρ` to its children. By structural
induction, `Rρ(e)` equals rewriting the separately constructed capture-avoiding
substitution `e[ρ]`: the reference case is the definition above, and globally
unique binder IDs make the inductive constructor cases capture-free. Nested
specialization pushes an environment and removes it in a `finally` boundary.
This eliminates one complete substituted tree and one traversal per accepted
specialization request.

Lexical block values use a separate scoped environment. Let \(E_0\) be the map
of module and enclosing values at block entry, and let a block contain
globally-unique resolved binders \(x_1,\ldots,x_k\). Its sequential environment
transition is:

```text
v_j = R_E(j-1)(initializer_j)
E_j = E_(j-1)[x_j ↦ v_j]
result = R_Ek(block_result)
leave(E_k) = E_0
```

The earlier implementation represented `E_j` by first copying every entry of
\(E_0\) into a new `Map`. The selected implementation uses one active map,
records the prior value for each \(x_j\), and restores those entries in reverse
order in a `finally` boundary. Resolver IDs are globally unique across lexical
binders, but nested specialization can re-enter the same source body and hence
the same IDs; restoring prior values rather than unconditionally deleting them
preserves this case. Induction on the block steps gives the same lookup result
as the copied map: before step \(j\), both contain exactly \(E_{j-1}\).
Stack-disciplined rollback then restores exactly \(E_0\), including on a thrown
diagnostic and under re-entry.

For blocks \(b\), visible environment sizes \(|E_b|\), and local binding counts
\(k_b\), eager cloning performs:

```text
W_clone = Σb (|E_b| + k_b) map-entry writes
W_scoped = Σb 2k_b map-entry writes
```

Both retain expected constant-time lookup. Eager cloning allocates
\(\Theta(\sum_b |E_b|)\) transient entries; scoped rollback retains only the
maximum active environment plus \(O(\sum_{\text{active }b} k_b)\) rollback IDs.
The profile reports rewritten blocks and the counterfactual
\(\sum_b|E_b|\) entries that the deleted constructor would have copied.
Mutation is confined to compiler execution state; typed HIR remains immutable.

Static conditionals follow the source evaluation context instead of a generic
bottom-up map:

```text
Rρ(if c then t else f) =
  Rρ(t)                         when Rρ(c) is statically true
  Rρ(f)                         when Rρ(c) is statically false
  if Rρ(c) then Rρ(t) else Rρ(f) otherwise
```

For the static cases, the unselected arm is neither evaluated nor residualized.
This is observationally sound for call-by-value conditionals because source
evaluation also enters exactly one arm after evaluating `c`. Rewriting both arms
was excess work and could report a compile-time failure from unreachable code,
which is not source behavior.

Read-only traversal and reconstruction are separate primitives. For an
expression `e` with immediate children `children(e)`:

```text
visit_children(e, observe) = for c in children(e): observe(c)
rewrite_children(e, f) =
  let c' = map(f, children(e))
  if c' is pointer-identical to children(e) then e
  else rebuild e with c'
```

The former performs `O(|children(e)|)` calls and allocates no payload IR. The
latter allocates at most one replacement parent and preserves maximal existing
sharing when no child changes. The initial implementation defined
`visit_children` by invoking `rewrite_children` with the identity function and
discarding its result. It therefore allocated one useless parent during every
demand, reference, reachability, node-count, function-summary, and substitution
scheduling visit. That implementation contradicted the immutable snapshot model:
observation was secretly construction. The direct visitor is the selected
primitive and is checked exhaustively against every typed expression variant.

Child arrays still need an implementation choice. Native `map` followed by an
identity scan allocates one transient array even when every child is unchanged.
A copy-on-first-change loop can avoid that array, but adds a branch per child and
copies the unchanged prefix when a later child changes. For list length \(n\)
and first changed index \(p\), the lazy alternative is selected only if:

```text
A_array(n) + n(C_map + C_identity)
  > n(C_loop + C_branch) + changed × p C_copy
```

This inequality depends on the JavaScript engine. A 21-sample Codex experiment
falsified it on the measured V8: specialization rewriting regressed 3.65% and
complete compilation 2.14%. The lazy loop was removed. Native `map` plus
identity scan remains the selected transient representation; immutable parent
sharing is still preserved.

Closure lifting admits another product analysis. For a block \(b\) with
\(F_b\) candidate nested functions and \(S_b\) expression nodes, checking each
symbol independently for uses outside direct-callee position costs
\(O(F_bS_b)\). A single traversal can instead collect the set of every symbol
used outside a direct-callee position, making all decisions in
\(O(S_b+F_b)\). The equivalence follows by reference cases: a reference in a
direct callee contributes no member; every other reference contributes exactly
its symbol.

That asymptotic improvement is rejected for the current corpus. Applying the
product scan unconditionally to all blocks, including \(F_b=0\), regressed
Codex lifting by 55.80%. Guarding it with \(F_b>0\) restored parity but still
changed the median from 25.083 to 25.125 ms (+0.17%). Most eligible blocks do
not have enough candidate functions to amortize allocation of the set and the
extra traversal machinery. Per-symbol early-exit scanning remains selected
until the measured distribution of \(F_b\) changes.

Pointer preservation is semantically inert because typed expressions are
immutable: replacing an unchanged reconstructed node by the original node
preserves every field and child by constructor extensionality. It is
operationally significant inside the compiler. If two paths reach the same
function object before rewriting and neither path changes it, both paths still
reach the same object afterward. Function-identity memoization therefore sees
one function rather than allocation-history-dependent copies. The memo key still
includes the referenced static environment, so this sharing cannot merge two
closures with different captured values.

The eager rewrite costs `O(S + S')` even when most input is unreachable, where
`S` is input nodes and `S'` is residual nodes. Demand discovery plus memoized
rewriting costs:

```text
O(S_D + E_D + ΣK residual_nodes(K))
```

where `S_D` and `E_D` are nodes and reference edges reachable from the roots.
Identity construction is linear in the keyed static arguments and referenced
environment. The exact retention ledger currently performs an additional
`O(S + S')` read-only node count; this observability cost does not reconstruct
or specialize discarded nodes, but it means the measured implementation is not
sublinear in total input size. Memory is `O(|D| + |K| + S')`.

Jones, Gomard, and Sestoft provide the binding-time and partial-evaluation basis
for this separation. Acar, Blelloch, and Harper provide the comparison for
selective memoization with explicit equality and dependence choices. ThinLTO
provides an engineering comparison: combine compact summaries first, then
perform demanded importing and independent backend work. Ducklang does not copy
its complete Core into CPU workers. That alternative would use
`O(P × Core_bytes)` memory for `P` workers and add structured-clone latency.
Independent residual operations instead enter the existing flat, shared GPU
packages after demand pruning; deterministic IDs and commit order remain source
ordered.

The production GPU kernel is operation-parallel, not one-worker-per-function.
Every residual function contributes independent operation records to the same
flat package. `downstreamParallelFunctionCount` therefore counts functions
represented in a physically submitted GPU rewrite package; it is zero on CPU
and Core-identity paths. CPU workers were not introduced because cloning the
pointer-rich Core into `P` workers would add `O(P × Core_bytes)` memory before
any measured benefit.

### 6.4 Cache identities are owned by compilation sessions

A semantic identity is not part of Ducklang program meaning. It is an
operational key for one explicit `DucklangCompilationSession`:

```text
Session = absent
        | present(source_revisions, compilations, module_instances,
                  module_syntax, backend_functions)
```

The identity judgment is therefore partial:

```text
present(S) ⊢ identity(source, syntax, host, policy) ⇓ k
absent     ⊢ identity(source, syntax, host, policy) ⇓ unused
```

Only the first judgment admits `lookup(compilations, k)`,
`insert(compilations, k, artifact)`, revision reuse, or dependency validation.
With `Session = absent`, no continuation in the compiler can observe \(k\).
Constructing it would violate the discard-before-parallelize rule by performing
bookkeeping without an owner.

For \(N\) parsed syntax nodes, \(S\) source bytes, normalized identity length
\(L\), and \(H\) host-interface bytes, the skipped work is
\(O(N+S+L+H)\). Normalizing syntax constructs \(O(N)\) transient objects and
content encoding constructs \(O(L)\) string storage. Host identity adds file
resolution, reading, and hashing over \(H\); the semantic host-interface
application still reads the interface at its actual elaboration boundary.

The preservation argument is noninterference. Without a session there is no
cache lookup before elaboration and no insertion after artifact validation.
Deleting the unused key computation cannot change parsing, elaboration, Core,
Wasm, ABI construction, diagnostics, or artifact validation. With a session,
the identity construction and all exact, trailing-trivia, dependency, and
backend-function reuse rules are unchanged.

Profiles enforce the boundary: an independent compilation reports zero
semantic-context and semantic-fingerprint milliseconds and zero fingerprint
reuse. A session compilation retains the existing identity and reuse evidence.

### 6.5 Source-control lowering is a measured fixed point

The current source-control pass applies a whole-module transformation \(L\),
then searches the result for a remaining `loop`, `forRange`, or
`forCollection`:

```text
M₀ = input
Mᵢ₊₁ = L(Mᵢ)
stop when search(Mᵢ₊₁) = none
```

An outer source loop prevents ordinary expression recursion into its body;
lowering that loop can therefore expose a nested source loop for the following
round. This explains the need for a fixed point rather than proving a particular
round bound.

The search predicate is an exhaustive typed walk over the source AST:

\[
\operatorname{remaining}(M)
\iff \exists n\in\operatorname{syntax}(M).\;
\operatorname{kind}(n)\in\{\texttt{loop},\texttt{forRange},
\texttt{forCollection}\}.
\]

A matching constructor contributes one and traversal continues through its
body and control operands. Stopping at a match would count only the outer
frontier \(F(M)\). That is not a decreasing measure: one outer loop containing
two inner loops gives \(|F(M)|=1\), while removing only the outer loop exposes a
frontier of size two. The complete occurrence count \(\mu(M)=3\) instead
decreases to two. This counterexample requires full descent even when a target
has already been found.

The earlier reflective walk traversed every enumerable JavaScript field,
including spans, names, and type metadata. The typed walk enumerates every
statement and expression constructor and follows exactly its syntax-bearing
children. Structural induction on those constructors establishes predicate
equivalence: a target constructor contributes itself and the induction
hypothesis applies to every syntax child; every other constructor contributes
zero and likewise follows every and only syntax child. Metadata is excluded by
its static type and cannot contain a `DucklangExpression` or
`DucklangStatement`. An exhaustive `never` branch makes a future unhandled
constructor a type error.

For \(P\) transformations, \(N_i\) input nodes in round \(i\), and \(S_i\)
objects visited by the following search, work is

\[
O\left(\sum_{i=0}^{P-1}(N_i+S_i)\right),
\]

with \(O(\sum_i N_i)\) total reconstructed allocation and
\(O(\max_i N_i)\) live round storage when prior snapshots become unreachable.
Typed search changes \(S_i\) from the complete enumerable object graph to the
source-syntax graph and removes one `Object.values` allocation per inspected
object; it does not change the asymptotic bound.

Termination uses the natural-number measure \(\mu(M)\), the count of residual
source-control constructors, with the obligation

\[
\mu(M)>0 \Longrightarrow \mu(L(M))<\mu(M).
\]

The first pass establishes \(r_1=\mu(M_1)\). If \(r_1=0\), lowering finishes in
one pass. Otherwise every later nonterminal result must satisfy
\(r_{i+1}<r_i\); equality or increase fails immediately with the first residual
constructor's kind and span plus both counts. Well-foundedness of natural-number
descent then gives

\[
P\leq r_1+1.
\]

There is no numeric pass cap. More than 32 successively exposed layers are
admitted when the measure decreases. Inspection of every lowering constructor
shows it introduces functions, calls, branches, and blocks but no new
`loop`, `forRange`, or `forCollection`; it either removes or preserves source
control. A preserved unsupported position is diagnosed by non-decrease rather
than consuming 32 arbitrary rounds.

The executable profile currently exposes \(P\), first-pass residual count
\(r_1\), its disjoint loop, range-loop, and collection-loop components,
first-pass transformation time, and accumulated later-pass transformation
time. The components must sum to \(r_1\). The transformation times must be
contained by the enclosing control-flow interval; the residual is search and
orchestration. Component counting adds three scalar increments to the existing
complete residual traversal, so it remains \(O(S_i)\) work and \(O(1)\) state.
The frozen Codex program exercises \(r_1>0\), asserts both equalities, and
contains two residual ordinary loops with no residual range or collection loop.

Residual occurrences, AST vertices, and source constructors are different
domains. The immutable syntax representation is a rooted DAG, not necessarily
a tree. Let \(r_i\) count root-to-target occurrence paths, \(u_i\) count unique
target object identities, and
\(d_i=|\{(kind,file,start,end):n\in residual(M_i)\}|\) count source
provenances. Then

\[
0\leq d_i\leq u_i\leq r_i.
\]

The converses fail: copied nodes can share provenance, while one shared vertex
can be reached by multiple paths. Counting the two quotients uses expected
\(O(r_i)\) set work and \(O(u_i+d_i)\) transient storage in the existing scan.
Codex has \((r_1,u_1,d_1)=(2,1,1)\): two traversal occurrences reach one shared
AST vertex from one source loop. The termination measure remains \(r_i\), since
the lowering currently maps occurrences rather than preserving DAG identity.

For the complete syntax search, let \(O_i\) be visited occurrences and \(V_i\)
unique AST vertices. The current search costs \(O(O_i)\) switch work. Its
instrumentation performs one expected-constant identity-set operation per
occurrence and retains \(O(V_i)\) references. A DAG summary memoized per vertex
could instead cost \(O(V_i+E_i)\), followed by constant-time reuse at every
shared incoming path. The measurable redundant-visit fraction is

\[
\rho_i = 1 - V_i/O_i.
\]

This is an opportunity bound, not a predicted speedup: memo lookup, edge
aggregation, and occurrence multiplicities remain, and the transformation is
context-sensitive even where the search is not.

The evaluated DAG algorithm discovered every vertex and outgoing edge once,
computed incoming-edge counts, seeded root multiplicities, and propagated exact
root-path counts in topological order. For \(E_i\) syntax edges, its cost model
is

\[
T_{dag}=c_vV_i+c_eE_i+c_m(V_i+E_i),
\qquad
T_{walk}=c_oO_i,
\]

where \(c_m\) covers map/set operations and queue bookkeeping. It wins only if
\(c_o(O_i-V_i)>c_eE_i+c_m(V_i+E_i)+(c_v-c_o)V_i\). The frozen measurements
reject that inequality even for Tar's 4.42× occurrence sharing. The simple walk
therefore remains the specified implementation; the DAG formulation remains a
correct alternative for a representation with compact integer IDs and dense
arrays rather than JavaScript object maps.

Identity cardinalities use ordinary sets. Replacing an object set with a weak
set plus a scalar counter preserves the count during this synchronous scan,
because the module and worklist keep every reachable node alive. It does not,
however, reduce the live-memory bound: the module already strongly owns all
\(V_i\) vertices. Its work changes from approximately one set insertion per
occurrence to one membership query per occurrence, one insertion per unique
vertex, and a branch/increment per first visit. The relative constants are
engine- and sharing-dependent, so neither representation dominates from the
asymptotic model.

## 7. Effect closure and the GPU boundary

After capability/direct/CPS lowering, Core contains no source `perform`,
`handle`, `resume`, handler search, or open row. Residual host operations are
typed ordinary calls through root ABI capabilities.

Closure requires equality, including operation signatures:

```text
inferred_residual_row(main)
  = reachable_typed_host_calls(Core)
  = generated_ABI_requirements
```

Both set differences are errors. The boundary pass may canonicalize order but
may not add a missing inferred effect or delete an inferred effect. No later
pass may introduce a semantic host operation.

The GPU receives effect-closed monomorphic SSA and immutable provenance. It does
not solve source rows, select handlers, capture continuations, or decide
ownership policy.

### 7.1 Compiler-execution semantics

Payload IR and compiler-execution state are distinct. Let `P` be a CPU-validated
immutable flat payload, `L` the selected device limits, `K` a fixed compiler
kernel, and `Q` a candidate result. One GPU stage has the observable result:

```text
gpu_stage(K, P, L) =
  unavailable(reason)
  | invalid(diagnostic)
  | completed(Q, measurements)
```

The host performs these transitions in order:

```text
validate_cpu(P)
  -> calculate_exact_capacity(P, K)
  -> require_capacity(capacity, L)
  -> enqueue(P)
  -> encode_and_submit(K, P)
  -> race_completion_against_device_loss
  -> readback(Q)
  -> validate_candidate(P, Q)
  -> commit(Q)
```

No buffer is created and no dispatch is encoded before the capacity judgment. An
out-of-memory error, unavailable adapter, or lost device yields `unavailable`;
malformed payload or CPU/GPU disagreement yields `invalid`. Only unavailability
may select a CPU fallback, and only under the `optional` policy. The queue,
error-scope, device-loss, buffer-mapping, and device-limit mechanisms used for
these transitions are defined by the WebGPU specification; the failure
classification itself is this compiler's policy. The public policies are:

| Policy     | GPU unavailable                         | GPU semantic failure |
| ---------- | --------------------------------------- | -------------------- |
| `off`      | GPU is not requested                    | not applicable       |
| `optional` | execute the corresponding CPU stage     | fail compilation     |
| `required` | fail compilation with the device reason | fail compilation     |

Authority is stage-specific. Type equality and scalar comptime use CPU semantics
in production; direct GPU invocations add differential evidence without entering
the compilation dependency graph. Core input is CPU-validated, the GPU
authoritatively selects rewrite proposals, and the CPU validates and
deterministically commits those proposals. Wasm bytes are GPU-authoritative when
GPU emission completes. A GPU policy additionally emits CPU bytes by default and
requires byte-for-byte equality; `gpuWasmVerification: "none"` omits that oracle
but still performs engine and managed-artifact validation. The compilation
default is `off`, so ordinary latency does not include an uncalibrated GPU
attempt.

Batching changes scheduling, not meaning. A payload belongs to exactly one
logical job, offsets are assigned in enqueue order, and every returned slice is
validated against that job's input. A failed physical batch fails every payload
in that batch rather than returning partially trusted results. The latency
policy flushes ready work on the next scheduler turn; the throughput policy
waits for the first of a 2 ms deadline, 16 queued jobs, or a device-capacity
boundary. Sixteen is a partition boundary, not merely a wake-up hint: a burst of
\(J\) simultaneously ready jobs produces at least \(\lceil J / 16 \rceil\)
physical payload batches before any additional capacity splitting. Jobs retain
enqueue order across those partitions.

For one dirty compilation, the measured GPU-stage time must be decomposed as:

```text
T_gpu_stage =
  T_queue
  + T_pipeline_initialization
  + T_capacity_and_packing
  + T_upload
  + Σdispatch T_kernel
  + T_readback
  + T_candidate_validation
  + T_commit
```

Whole compilation also includes CPU parsing, semantic lowering, flattening, Wasm
planning, ABI construction, and final validation. Consequently a faster kernel
does not imply a faster compilation. `gpu_*_queue_wait`,
`gpuCoreExecutionMilliseconds`, `gpuCoreTransferMilliseconds`, payload and
submission batch sizes, Core candidate/proposal/rewrite-lane counts, Wasm atom
and length-atom counts, Core candidate-descriptor and logical device-buffer
bytes, Wasm resolved-offset bytes and scheduled lanes, and output-buffer bytes
expose the terms that the current implementation can measure. Pipeline
initialization and capacity/packing are currently combined with their containing
stage except where Core initialization is reported separately; this is a stated
instrumentation limit.

Comparative timing uses paired, counterbalanced observations: even samples run
CPU then GPU and odd samples run GPU then CPU for the same workload, batch size,
and scheduling policy. The sample count is even, so every CPU-first observation
has a GPU-first counterpart; even-sample medians average the two central
observations. For frontend pair \(i\), let \(C_i\) and \(G_i\) be adjacent CPU
and GPU elapsed times and define

\[
d_i = G_i-C_i,\qquad
\widetilde d=\operatorname{median}_i(d_i),\qquad
\operatorname{MAD}_d=\operatorname{median}_i|d_i-\widetilde d|.
\]

Under the nuisance model \(C_i=c+a_i+\epsilon^C_i\) and
\(G_i=g+a_i+\epsilon^G_i\), differencing cancels the pair-local additive term
\(a_i\). Alternating order counterbalances a first-order directional order
effect. The benchmark retains all \(C_i\), \(G_i\), and \(d_i\), because neither
a marginal median nor MAD identifies backend-specific stalls, autocorrelation,
or thermal drift. A reported stage breakdown is one observed profile nearest
the scalar median total, not a vector of independently selected component
medians. Thus
`accounted + unattributed = total` and all stage percentages refer to a possible
execution. Parser sub-stage reports select an observed parse by the same rule.
Medians and nearest-rank p95 values remain descriptive statistics; without
independent repetitions and uncertainty intervals they do not establish a
general speedup.

For a batch size \(N\), observed latency break-even is the predicate
\(\operatorname{median}_i(G_{N,i}-C_{N,i})\leq 0\). The difference of the two
marginal medians is not substituted for this estimator. If the predicate is
false for all \(N\) in a finite measured set \(S\), the only valid conclusion
without a monotonicity proof is “not observed through \(\max S\).” In
particular, \(\max S\) is not a lower bound on a future crossover.

Executable evidence consists of capacity-boundary tests, device-loss recovery,
physical-batch isolation tests, generated CPU/GPU differentials for type
closure, Core rewrites and Wasm plans, and the six-target required-GPU release
gate. These establish implementation behavior for tested inputs; they do not
prove arbitrary kernels correct.

### 7.2 Flat Core representation

The GPU boundary uses schema-versioned structure-of-arrays storage. Entity IDs
are dense `u32` indices. A semantic record such as an operation is split into
equal-length columns for its block, opcode, result, result type, operand range,
attribute range, and source location. Variable-arity relations use a parent
range table and one packed payload column.

For parent rows `i ∈ [0,n)` with starts `sᵢ`, counts `cᵢ`, and a packed payload
of length `m`, validity requires:

```text
s₀ = 0
sᵢ₊₁ = sᵢ + cᵢ
sₙ₋₁ + cₙ₋₁ = m
```

Thus the ranges form an ordered disjoint partition: they contain no overlap,
gap, or unowned suffix. Empty relations use `n = m = 0`. This representation is
used for type payloads, signature parameters, function blocks, block parameters,
block operations, operation operands and attributes, terminator edges and
returns, edge arguments, and layout components.

CPU structural validation establishes all of the following before a package is
branded as trusted:

1. every column for one entity has equal length;
2. every range family satisfies the partition equation;
3. every ID is inside its target table;
4. function block ranges preserve dense source order and contain their entry;
5. every block owns exactly one same-index terminator;
6. each `(function_id, local_value_id)` pair is unique and has exactly one
   parameter or operation definition;
7. operands, terminator values, edge arguments, and edge targets remain inside
   their function;
8. type, operation, terminator, attribute, and layout discriminants are known;
9. source spans have valid file IDs and `start ≤ end`; and
10. independently recomputed physical layouts equal the encoded layouts.

Inflation then reconstructs semantic Core, invokes the semantic Core validator,
and checks layouts again. For a valid semantic module `M`, the intended
round-trip property is:

```text
inflate(flatten(M)) = M
```

where equality includes source order, provenance, types, block/value identity,
and layout. The current test suite validates this property on representative
closures, control flow, values, and layouts and separately checks deterministic
columns. This is executable conformance evidence, not a universal proof of the
serializer.

The compiler retains the structured input \(M\) as a round-trip witness while
its flat image \(P=\operatorname{flatten}(M)\) passes through rewrite. Under the
immutable commit contract, reference identity of the returned package proves
that no rewrite constructed a successor snapshot. In that case:

```text
optimized_flat === P
implies optimized_core = M
because inflate(flatten(M)) = M
```

The implication depends on both properties: flatten/inflate round-trip
conformance and the prohibition on in-place rewrite mutation. Column equality
alone would require an \(O(B_{\mathrm{flat}})\) comparison; reference identity
is a constant-work certificate supplied by the empty-commit law in Section
7.3. A nonempty accepted batch returns a new package and still requires
inflation and validation.

Reusing \(M\) removes one complete traversal and allocation of the structured
Core graph. It also avoids source-provenance, type, layout, block, operation,
and value reconstruction. The exact saved byte count is engine-dependent
because the structured graph uses JavaScript objects and arrays, so the
implementation reports the inflation stage as exactly zero work rather than
claiming a portable allocation formula. This does not remove rewrite matching.

Flat trust has two derivations:

```text
valid_flat(P)
──────────────────────── validate
trusted(P, validation)

valid_core(M)    P = flatten(M)
──────────────────────────────── construct
trusted(P, construction)
```

The second is the standard smart-constructor rule for an abstract data type.
Flattening first validates \(M\), assigns every table range and ID from the
validated graph, and returns a wrapper carrying construction provenance. The
wrapper's brand is private to the flat-Core module, so ordinary typed callers
cannot manufacture this judgment. Arbitrary packages, including low-level GPU
API inputs, can earn trust only through complete flat validation.

The construction rule is conditional on the representation-preservation lemma
for `flatten`; a defect in that implementation could violate it just as a defect
in any trusted compiler pass could violate its postcondition. Deterministic
column tests, representative round trips, generated Core differentials, full
semantic execution, and independent validation of constructed packages are
executable evidence, not a machine-checked proof. This boundary therefore trusts
one small constructor rather than treating every internal value as valid. A raw
typed-array mutation loses the provenance argument and must re-enter through
validation.

Let `U(P)` be the multiset of `Uint32Array` columns and `S(P)` the string-byte
column. The exact payload storage occupied by the flat package, excluding
JavaScript object headers, is:

```text
B_flat(P) = |S(P)| + 4 Σa∈U(P) |a|
```

The three scalar header words are supplied separately. GPU stages upload only
the columns they consume and may add proposal, metadata, uniform, and readback
buffers, so `B_flat` is a lower bound on a stage's device allocation, not its
allocation formula. Each stage calculates those additional bytes explicitly and
checks both individual binding limits and device buffer limits before
allocation.

### 7.3 Rewrite proposals as checked certificates

Core optimization follows snapshot, propose, validate, resolve, and rebuild. For
valid snapshot `S` and operation `o`, the CPU defines a partial matching
function:

```text
M(S, o) =
  addZero(result(o), x)       when o = iadd(x, 0) or iadd(0, x)
  multiplyOne(result(o), x)   when o = imul(x, 1) or imul(1, x)
  undefined                   otherwise
```

The rules are restricted to `i32` and `i64`, whose Wasm arithmetic is modular.
They are deliberately not applied to floating point: `x + 0` can change negative
zero, and `x * 1` participates in NaN behavior.

Let \(H(S,o)\) be the structural head shared by every rule:

```text
kind(o) = scalarBinary
arity(o) = 2
operator(o) in {add, multiply}
result(o) in {i32, i64}
at least one operand is defined by a constant operation
```

The exact constant attribute and payload are deliberately absent from \(H\).
Let \(O\) be the operation count, \(H_S=\{o\mid H(S,o)\}\), and let the exact
frontier be \(C=\{o\in H_S\mid M(S,o)\text{ is defined}\}\). By inspection of
the two rule heads:

```text
M(S, o) defined implies H(S, o)
C = domain(M(S, ·))
```

The host therefore sends the stable increasing IDs in \(C\) as the rewrite
frontier. The CPU implements \(H\) as a pattern-head discrimination tree [21],
evaluates the complete matcher only under that head, and discards the resulting
proposal payload after retaining the operation ID. The GPU independently
recomputes the structural checks, exact constant payload, orientation, and
replacement. Its proposal remains authoritative: CPU preclassification cannot
cause a rewrite, while a faulty GPU omission can only forgo an optimization.

An empty exact frontier proves that `M` is undefined for every operation, so the
pass returns the branded input with empty proposal and acceptance sets before
requesting a device. Packed execution partitions identity jobs from nonempty
frontiers and preserves their logical result positions. For nonempty \(C\),
scheduled lanes are \(64\lceil|C|/64\rceil\), replacing
\(64\lceil O/64\rceil\).

Backend provenance is part of the result type:

```text
backend = identity  iff C is empty and no Core command is submitted
backend = gpu       iff a nonempty C is executed by a GPU command
backend = cpu       iff compilation selects CPU rewriting
```

An identity result has zero descriptor bytes, lanes, initialization, transfer,
GPU, commit, and physical submissions. It is a proof that the transformation is
unnecessary, not an execution backend. This distinction prevents zero-work jobs
from inflating GPU coverage.

The GPU queue preserves the trust derivation in a disjoint payload:

```text
GpuInput = raw(FlatCore) | trusted(TrustedFlatCore)
```

`raw` must pass complete validation before candidate discovery. `trusted`
already contains either validation or construction provenance and proceeds
directly. Stable batching, identity filtering, and capacity splitting carry the
tag rather than extracting an unbranded package, so no scheduling path can
silently downgrade a raw input into trusted input. Completed results report the
input provenance. This is an information-flow invariant: batching changes
physical grouping, not the proof attached to a logical job.

For compiler-owned trusted input, preparation precedes scheduling:

```text
submit(T) =
  identity(T)          when prepare(T) proves C empty
  queue(prepared(T,C)) otherwise
```

The prepared variant contains the trust wrapper, exact candidate IDs, and their
descriptors. Queue splitting and mixed-batch filtering preserve that value
without repeating matching or descriptor construction. The public raw API
continues to enter the queue before validation so its throughput-batch
observability remains explicit. This asymmetry follows the trust boundary:
internal construction provenance permits eager pure classification, while raw
input first belongs to the defensive scheduling boundary.

Batch accounting separates three cardinalities. \(L\) is the number of logical
jobs observed together by the queue, \(P\) the number of nonidentity payloads
packed into a Core command, and \(S\) the device scheduler's command-submission
batch size. In general \(0\leq P\leq L\). An identity result may have \(L>0\)
but must have \(P=S=0\); a physical rewrite has \(P>0\), nonzero dispatched
lanes, and backend `gpu`. The profile exposes all three rather than overloading
one `payloadBatchSize` field.

Validation is a trust-boundary operation rather than a property that becomes
stronger by repetition. `validateFlatDucklangCore` either rejects an untrusted
input or returns a validation-provenance snapshot held read-only by this stage.
The compiler's CPU path instead receives construction provenance from Section
7.2, and compiler-owned GPU jobs carry that same provenance. The public GPU
boundary still validates raw input before device work. The GPU does not
re-encode those invariants as validation records because it can neither commit
a mutation nor manufacture trusted Core: it can only return a proposal that
must satisfy the independent matcher equation below.

The theorem assumes exclusive read ownership of the flat package from validation
through commit. Compiler orchestration satisfies this condition because it
constructs the package and does not publish or mutate it during the pass.
TypeScript's readonly properties do not prevent an external caller from writing
through a `Uint32Array`, so the exported low-level function cannot enforce this
condition dynamically. A defensive copy would enforce it at
\(B_{\mathrm{flat}}\) additional host bytes and \(O(B_{\mathrm{flat}})\) work
per pass. The current API instead treats concurrent caller mutation as outside
its ownership contract; this is a stated enforcement limitation, not a proved
property of typed arrays.

Let \(R\) be the former number of four-word validation records. Removing the
duplicate pass eliminates exactly \(16R\) record bytes, its error and parameter
buffers, and \(64\lceil R/64\rceil\) scheduled lanes. It also removes the
eight-byte validation prefix from nonempty rewrite readback. Validation of a raw
package remains \(O(B_{\mathrm{flat}})\); construction provenance removes it
only from the internal CPU producer-consumer edge.

The discriminant scan costs \(O(O)\) work and is already required to construct
the frontier. Classifying the prepared job as the disjoint union
`invalid |
identity | rewrite` prevents GPU columns from existing for the first
two cases. For an empty frontier, this avoids host preparation of:

```text
B_empty_host = 32O + 20A + 16V + 8T
```

bytes, where \(A,V,T\) are attribute, value, and type counts. These are the two
four-word operation tables, a temporary one-word zero attribute column and its
four-word interleaved table, one four-word value table, and one two-word type
table. It also avoids all ten single-job device buffers. If \(E\) is the operand
count, their logical capacities were:

```text
B_empty_device =
    max(4, 16O) + max(4, 16O) + max(4, 4E)
  + max(4, 16A) + max(4, 16V) + max(8, 8T)
  + 4 + 4 + 24 + 8
```

as well as context initialization, command submission, and mapping the
eight-byte minimum readback. The transformation has no empirical break-even:
once \(C=\varnothing\), those resources cannot affect the result, and the
classification branch uses information already computed by the frontier scan.

For candidate operation \(o\), define the projection \(D(S,o)\) to contain its
operand and attribute counts, operator attribute kind and value, result type
kind and scalar, and two operand descriptors. An operand descriptor contains its
original value ID, definition kind, defining operation kind, and that
operation's attribute count, kind, low word, and high word. The flat-Core
validator has already proved every referenced ID and range safe. Direct
substitution into the matcher gives:

```text
M(S, o) = M_D(D(S, o))
```

because these are exactly the fields read by `hasIntegerScalarResult` and
`coreConstantEquals`; no other snapshot column affects either rule. The host
gathers both operands and all fields only after exact membership in \(C\) is
proved. It discards its proposal, and the GPU recomputes the complete matcher.
Thus host filtering decides whether useful work exists but not which
transformation is committed.

Each descriptor is 20 `u32` words: six operation words and two seven-word
operand records. Position \(q\) corresponds to the stable candidate ID at
position \(q\). Lane \(q\) writes only rule and replacement slot \(q\), while
the host retains the candidate IDs for certificate construction. The rewrite
pipeline therefore uses three storage bindings—descriptor, rules, and
replacements—rather than eight dense snapshot bindings.

For nonempty \(C\), the previous derived host allocation and logical device
capacity were:

```text
B_host_dense = 32O + 20A + 16V + 8T + 4C
B_device_dense = 32O + 4E + 16A + 16V + 8T + 16C + 24
```

where \(E,A,V,T\) are operand, attribute, value, and type counts. Candidate
projection changes them to:

```text
B_host_descriptor = 84C
B_device_descriptor = 96C + 4
```

The host formula contains the 80-byte descriptor and retained four-byte
operation ID. The device formula adds four-byte rule and replacement outputs,
their eight-byte readback, and one four-byte uniform per candidate batch.
Gathering costs \(O(C)\) work after \(O(O)\) discrimination and exact matching.
Projection is preferable exactly when these formulas are smaller; the frozen
targets satisfy that condition, but a rule domain approaching the complete graph
may not. Let \(T_M(O)\) be host matcher time and \(T_G(C)\) the complete GPU
boundary including submission and readback. Exact filtering dominates the
structural frontier when:

```text
T_M(O) + T_G(|C|) < T_G(|H_S|)
```

For \(C=\varnothing\), \(T_G(0)=0\). The measured Codex values are approximately
0.15 ms for \(T_M\) and 25 ms for the eliminated physical GPU boundary, so the
inequality holds by two orders of magnitude.

The GPU returns proposal certificates containing rule, function, operation,
result, replacement, and profit. A proposal `p` is admissible exactly when:

```text
M(S, p.operation) = p
```

The CPU recomputes `M` from the immutable snapshot. Structural validity alone is
insufficient: before this review, a false GPU proposal could name an arbitrary
same-function replacement and pass commit validation. Exact semantic
revalidation closes that boundary. A faulty GPU may omit an optimization, which
changes performance only; it cannot introduce an unproved rewrite.

Accepted proposals are ordered by descending profit and then stable function,
operation, result, and rule IDs. At most one proposal claims an operation.
Let \(A\) be the resulting accepted sequence. Batch application is defined by:

```text
commit(S, A) =
  S             when A is empty
  rebuild(S, A) otherwise
```

The first case is not an optimization heuristic. Rebuild is the ordered
application of accepted substitutions and deletions, so its empty fold is the
identity transformation. Since `S` was validated before proposal matching and
the identity case constructs no package, every invariant of `S` is preserved
without a second validation. The public rebuild boundary still validates
untrusted input before applying this law. Returning the same object is sound
under the exclusive read-ownership contract above; it would not be sound if a
caller could concurrently mutate the shared typed arrays.

For nonempty \(A\), rebuild removes claimed operations, resolves replacement
chains with cycle detection, remaps every use, retains source order, and
validates the complete new snapshot. The original snapshot is immutable.

With \(O\) operations and \(V\) values, the former empty-batch path allocated at
least \(B_{\mathrm{flat}}+5O+8V\) typed-array bytes: a complete new package,
one-byte removal marks, two value-ID tables, and one operation-ID table. It also
constructed transient JavaScript number arrays, visited the package during
rebuild, and validated the duplicate package. The identity case removes all of
that work. Initial validation and proposal matching remain
\(O(B_{\mathrm{flat}}+O)\), so an empty accepted set does not imply an empty
matcher frontier or a zero-cost pass.

CPU profiles decompose this remaining pass into validation, matching, conflict
resolution, and nonempty rebuild. These intervals are disjoint children of the
enclosing rewrite stage; instrumentation overhead and call boundaries remain in
the enclosing remainder. A profile is consistent when:

```text
validation + matching + resolution + rebuild <= CPU rewrite
```

Proposal and acceptance counts accompany the timings. This distinction is
necessary because \(C\ne\varnothing\), proposals \(=\varnothing\), and
acceptances \(=\varnothing\) describe different proofs and different work.

Executable evidence checks CPU/GPU proposal equality, immutable rebuild,
multi-step replacement, floating-point exclusion, and rejection of a
structurally valid but semantically false certificate. A separate regression
requires object identity when no proposal is accepted. Backend-neutral profile
counts expose proposals and acceptances, preventing a nonempty structural
frontier from being mistaken for useful rewrite work. A general optimization
framework would require a preservation proof and certificate checker for every
additional rule.

### 7.4 Wasm resolve and parallel write

The binary plan is a nonempty source-ordered atom sequence:

```text
atom ::= byte(u8)
       | unsigned(u32)
       | signed32(i32)
       | signed64(i64_bits)
       | length(range_start, range_count, dependency_level)
```

A length atom encodes the byte length of a contiguous atom range. Its dependency
level is strictly greater than every length atom in that range, so the relation
is acyclic. CPU validation checks atom domains, ranges, levels, and the declared
maximum level before GPU allocation.

Validation also resolves the layout. For non-length atom \(i\), \(s_i\) is its
exact LEB128 width. Length atoms are visited in increasing nonempty dependency
level:

```text
s_i     = unsigned_width(Σ[j in range(i)] s_j)
p_0     = 0
p_{i+1} = p_i + s_i
B       = p_A
```

The plan validator has already proved that every referenced dependency has a
lower level, so induction makes every \(s_j\) available. Every WebAssembly atom
has positive width, hence:

```text
0 = p_0 < p_1 < ... < p_A = B <= 2^32 - 1
```

For a length atom with range \([r,r+c)\), its encoded value is
\(p_{r+c}-p_r\). Thus the same boundaries resolve both nested lengths and output
placement. When \(B\leq 2^{16}-1\), every boundary fits in `u16` and two are
packed per `u32`:

```text
word_q = p_(2q) | (p_(2q+1) << 16)
p_i    = (word_(i >> 1) >> (16(i & 1))) & 0xffff
```

Otherwise boundaries remain one `u32` each. The GPU receives atom kinds,
resolved low/high value words, and this adaptive boundary vector. Lane \(i\)
owns exactly \([p_i,p_{i+1})\), encodes its atom there, and no sizing or scan
kernel is required. A byte lane uses its statically known width one, so it reads
only \(p_i\); every variable-width lane reads \(p_{i+1}\) as well. Packing is
lossless because \(0\leq p_i\leq B\); it changes representation, not the
interval proof.

Adjacent intervals may share a `u32` output word, so writers use `atomicOr` into
a zeroed buffer. The byte masks of distinct intervals are disjoint; the atomic
operations therefore commute. Per-atom correctness plus ordered disjoint
intervals proves that the final buffer is the source-ordered concatenation.

This division follows the trust boundary rather than a CPU/GPU preference. Exact
output allocation already requires the host to validate the atom DAG and
evaluate every \(s_i\). Recording each partial sum adds one \(O(A)\) store
sequence to work that cannot be discarded. Recomputing sizes, length values, and
prefixes on the GPU duplicated that resolved information. If a future pipeline
constructs the atom DAG on-device and does not traverse it on the host, a device
scan becomes justified again; under the present boundary it is redundant.

Let \(W=64\) and \(L(n)=W\lceil n/W\rceil\). GPU work is now exactly one
emission dispatch and \(L(A)\) scheduled lanes. The boundary vector transfers
\(P(A,p_A)\) bytes:

```text
P(A, p_A) = 4 ceil((A + 1) / 2)  when p_A <= 65535
            4(A + 1)             otherwise
```

The narrow representation adds two shifts, one mask, and one shared word load
per observed boundary lookup. With \(Q\) byte atoms, emission performs exactly
\(2A-Q\) boundary lookups rather than \(2A\). The host packing loop is \(O(A)\)
and requires no new pass or synchronization. Adjacent half words are assembled
in a scalar and assigned once, so host offset-vector stores equal the physical
\(\lceil(A+1)/2\rceil\) words rather than the \(A+1\) logical boundaries.
Output capacity is exactly \(4\lceil B/4\rceil\), and readback contains only
that output.

The kind domain has five inhabitants. It is represented as eight four-bit tags
per `u32`:

```text
kind(i) = (kind_words[i >> 3] >> (4(i & 7))) & 15
```

Tags 0 through 4 map injectively to the atom variants; the remaining nibble
values are invalid and emit nothing, which the byte differential detects. This
keeps \(O(1)\) lane-local lookup using shifts and masks while changing the kind
column from `4A` to \(4\lceil A/8\rceil\) bytes. On the host, disjoint nibble
masks are ORed into one scalar accumulator and committed at the end of each
eight-atom group. The construction therefore performs \(A\) local shifts/ORs
but only \(\lceil A/8\rceil\) typed-array stores; per-atom read/modify/write is
unnecessary.

Only signed-64 atoms read the high-word column. Let \(S\) be their count. Two
representations are available:

```text
H_dense(A)  = 4A
H_sparse(S) = 8S
```

The sparse representation is a source-ordered array of `(atom_id, high_word)`
pairs. A signed-64 lane finds its pair by lower-bound binary search; all other
lanes perform no high-word lookup. The compiler selects sparse exactly when
\(2S<A\), otherwise dense. At equality dense wins because capacity is equal and
direct indexing has less work. Therefore:

```text
H(A, S) = min(4A, 8S)
```

This representation is never larger than dense high words. Its additional sparse
lookup work is \(O(S\log\max(1,S))\), paid only when it saves capacity. An
atom-indexed rank column would restore \(O(1)\) lookup but itself costs `4A`,
eliminating the sparse saving. With \(S=0\), the logical frontier is empty;
WebGPU's nonempty-binding rule still gives a packed job a four-byte physical
region.

Before tag packing and adaptive high words, atom input required `16A + 4`. A
three-bit tag packing is denser but makes some tags cross word boundaries or
restricts each word to ten tags; the nibble representation trades at most one
bit per tag for one-word, shift-and-mask random access.

Low words adapt between direct atom indexing and rank/select compression. Let
\(Q\) be the byte-atom count, \(N=A-Q\), \(G=\lceil A/8\rceil\), and \(M\) the
maximum exclusive byte rank stored at a tag-word boundary. The ranked
representation has a packed byte stream, a dense non-byte stream, and an
exclusive byte rank for each eight-tag word. Its rank vector uses the least of
these two lossless widths:

```text
R(G, M) = 4 ceil(G / 2)  when M <= 65535
          4G              otherwise

L_ranked(A, Q, M) =
    4 ceil(Q / 4)
  + 4(A - Q)
  + R(ceil(A / 8), M)
```

It beats the dense `4A` low-word column exactly when
\(L_{\mathrm{ranked}}(A,Q,M)<4A\). With 32-bit ranks this reduces to:

```text
Q - ceil(Q / 4) > ceil(A / 8)
```

asymptotically \(Q>A/6\). The selector uses the exact \(L_{\mathrm{ranked}}<4A\)
inequality for the selected rank width; dense wins equal-capacity ties because
it has less lookup work.
Within ranked lookup, the rank word supplies the preceding eight-atom groups and
one bit-parallel expression supplies the within-group byte count. Byte has tag
zero, so for kind word \(x\):

```text
n = x | (x >> 1) | (x >> 2) | (x >> 3)
z = (~n) & 0x11111111
m_i = (1 << (4(i mod 8))) - 1
within_byte_rank(i) = popcount(z & m_i)
```

At bit \(4q\), \(n\) is set exactly when one of the four bits in nibble \(q\)
is set; shifts from the next nibble cannot reach bit \(4q\). Thus \(z\) has
exactly one bit for every zero-tag byte atom, and \(m_i\) retains exactly the
preceding nibbles. A byte lane indexes its packed stream by the resulting total
rank; a non-byte lane uses `atom_id - byte_rank`. Both are exactly the stable
ranks of their variants, so they recover the same low word as dense indexing.

The pipeline uses seven storage bindings—kind, primary low word, non-byte low
word, byte rank, high word, boundaries, and output—and one uniform. The logical
input capacity is:

```text
L(A, Q, M)   = min(4A, L_ranked(A, Q, M))
B_atom_input = L(A, Q, M) + P(A, p_A) + 4 ceil(A / 8) + H(A, S)
```

Scalar validation, atom sizing, byte counting, signed-64 counting, and maximum
byte-rank calculation form a product algebra over the same immutable atom
sequence. One inspection therefore computes all five components. Length-range
validation is carried by that inspection, while length sizing remains a
subsequent topological fold because a length atom depends on already-sized
atoms. Relative to separate validation, sizing, and statistics traversals, the
product fold removes \(2A\) atom visits. A validation-only caller supplies no
size column and allocates none; it pays one predictable sink-presence branch per
scalar atom.

Let \(D=\sum_i\mathrm{rangeCount}_i\), let \(s_0(i)\) be the encoded size of a
scalar atom and zero for a length atom, and define
\(P_0(t)=\sum_{i<t}s_0(i)\). Length atom indices are kept in source order. A
Fenwick tree [22] stores encoded sizes only for length atoms from completed
dependency levels. For a length range \([u,v)\):

```text
payload_size(u, v) =
    P₀(v) - P₀(u)
  + resolved_length_prefix(v) - resolved_length_prefix(u)
```

The dependency validator proves that a level-\(\ell\) range contains no length
at level \(\ell\) or above. Induction on \(\ell\) therefore shows that the
scalar prefix and tree contain every and only the already-known contributors to
that range. Updates occur only after the complete level is sized, preserving
same-level independence.

For \(K\) length atoms and \(b=\lceil\log_2(K+1)\rceil\), direct summation has
modeled work \(E_d=D\). Sparse sizing has the conservative iteration estimate
\(E_s=A+5Kb\): one scalar-prefix pass, two binary searches, two tree-prefix
queries, and one tree update per length atom. Validation assigns every length
atom its stable rank among length atoms in source order. The tree update uses
that rank directly; no atom-to-position map is reconstructed. The
implementation selects sparse sizing only when \(E_s<E_d\), so ties retain the
allocation-free direct loop. The scalar prefix reuses the final offset vector
and the sparse path adds one \(8(K+1)\)-byte tree. Tree sums use exact 53-bit
JavaScript integers so an invalid plan cannot wrap before the u32 module-size
boundary rejects it. This avoids the \(O(JK)\) counterexample of rebuilding a
sparse prefix after every dependency level and the \(JA\) work of rebuilding
dense prefixes. Validation still reads \(D\) dependencies independently; only
sizing uses the selector.

Rank construction and packing remain \(O(A)\). Four adjacent packed bytes are
accumulated before one physical-word store, reducing byte-stream stores from
\(Q\) to \(\lceil Q/4\rceil\). Ranked GPU lookup now has four constant shifts,
three ORs, three masks/complements, and one population count rather than zero to
seven data-dependent tag comparisons. Rank lookup adds one shift and mask on
the 16-bit path. Its two adjacent ranks are likewise assembled before one
physical word store. Five frozen targets use 16-bit ranks; Codex uses 32.
Relative to
dense low words, adaptive ranking removes 3,856–245,336 bytes and 14.14–25.05%
of complete atom input. A 21-pair counterbalanced experiment measured
ranked/dense median ratios from 0.9771 to 1.0015, so no latency improvement is
claimed; the representation is admitted because it strictly reduces capacity
without an observed material latency regression. Forced dense/ranked
differentials, both rank widths, and mixed-layout packed batches validate both
paths. A rank-free sparse pair frontier would require binary search in most
lanes and is strictly less attractive for the observed 56.19–62.63% byte
density.

For comparison with the superseded hierarchy, let \(K\) be the number of length
atoms, \(J\) its nonempty dependency levels, \(n_0=A\), \(n_{\ell+1}=\lceil
n_\ell/W\rceil\), \(h\) the number of hierarchy levels, and
\(H=\sum_{\ell=1}^{h-1}n_\ell\). Resolving before GPU execution removes these
logical device bytes:

```text
4A                  atom-size column
+ 12K               length frontier
+ 8(H + 2)          alternating hierarchy sums and prefixes
+ 16(|J| + 2h - 1)  per-pass uniforms
```

The old inclusive-prefix readback word exactly offsets the new vector's one
extra boundary word, so neither appears in the difference. Packed batches add
device-required alignment between logical jobs; it does not change this per-job
model. Host analysis work is
\(O(A+D+\min(D,A+K\log K))\): validation retains \(D\), while length sizing
chooses the smaller modeled representation.

The default verification for a GPU policy independently evaluates the length
DAG on the CPU and compares every emitted byte. It deliberately retains direct
range summation rather than sharing the adaptive GPU-boundary analysis.
Inspection validates scalars,
records their exact widths in a one-byte column, and accumulates their total
width. Let

```text
rankL(i) = |{j < i | atom j is a length}|
```

Validation records `rankL` in every length-frontier entry. The topological
direct fold records each derived payload width in an eight-byte column indexed
by `rankL`, records its LEB width in the atom-width column, and adds that width
to the total. Strict dependency-level descent proves by induction that every
range width is available before its consumer.

After allocating the exact result, one source-order pass writes each byte or
LEB value directly at a rolling offset. The width functions and writers
implement the same stopping predicates, so each writer advances by exactly the
validated width. Induction over source order proves that the final offset is
the accumulated module width and that concatenation order is preserved. The
oracle performs \(2A+2D\) atom/range visits plus \(B\) output-byte writes and
uses exactly \(A+8K+B\) logical typed-array bytes. It allocates no internal
per-atom encoding arrays, reference vector, canonical byte table, or value
cache. Public LEB encoders remain checked array-returning boundaries.

This direct representation supersedes two sound but more expensive
representations: canonical singleton arrays still required an \(A\)-entry
reference vector, while memoizing multi-byte arrays paid hash-map work. The
memoization experiment had an 88.75% hit rate and nevertheless regressed every
frozen target. An initially unguarded canonical lookup also exposed the
counterexample that unsigned 128 is `[128, 1]`, not `[128]`. Both failed
alternatives remain recorded in the continuous log.

Engine validation then checks the selected module. With differential
verification disabled, engine validity does not prove semantic equality to the
plan; that mode deliberately trades away the independent byte oracle.

### 7.5 Type equality as a certified conformance experiment

The direct GPU type experiment consumes first-order equality constraints over
variables and constructor terms. Production compilation does not invoke it. Let
\(E_0\) be the source equalities. The required
equivalence relation \(\equiv\) is the least relation satisfying:

```text
(a, b) ∈ E₀                              => a ≡ b
C(a₁, …, aₙ) ≡ C(b₁, …, bₙ)            => aᵢ ≡ bᵢ for every i
C(…) ≡ D(…) and (C != D or arity differs) => constructor clash
```

After closure, the quotient graph has one vertex per equivalence class and an
edge from a constructor's class to each child class. A cycle is an infinite type
and is rejected. Otherwise the least closed relation is the canonical solution.
This is first-order syntactic unification with constructor disjointness,
injectivity, and an occurs check, following the equation-solving model of
Martelli and Montanari.

When \(E_0=\varnothing\), flattening discovers no term universe, so \(T=0\). The
empty relation is the unique reflexive, symmetric, transitive congruence on the
empty carrier, and its representative vector is empty. The experiment therefore
returns this result before requesting a device. It reports zero union rounds,
decomposition equations, and physical submissions. This removes only GPU context
acquisition and pipeline-device selection—the former path already returned
before buffer allocation—and leaves the logical batch queue intact. No empirical
break-even is needed because no GPU computation can distinguish the unique empty
result.

A compressed parent forest alone is not a certificate of this judgment. It can
show that the reported relation is an equivalence, but cannot show minimality:
the forest that places every term in one class is compressed and satisfies all
input equalities while spuriously equating unconstrained terms. The selected
boundary therefore has two explicit responsibilities:

1. the CPU computes the deterministic least constructor congruence, using the
   lowest term ID as class representative, and rejects the first constructor
   clash;
2. the GPU unions the complete closed equality set and compresses every path,
   after which the CPU requires exact representative equality and checks the
   quotient graph for a cycle.

A mismatch is a compiler error, never an `optional` fallback. Constructor-clash
provenance remains at the CPU semantic boundary because the union kernel cannot
represent a clash. The number of child equations considered while constructing
the closure is a work metric rather than a semantic result: pairwise and
star-shaped constructor decomposition can prove the same partition with
different redundant equation sets.

Every accepted solve reports four non-overlapping internal timings—flattening,
CPU closure, GPU union including its queue and readback, and sparse cycle
checking—plus term count, closed-equality count, constructor comparisons, and
child-equation proposals. Their sum is bounded by the direct solve's wall time;
the remainder is orchestration and exact representative validation.

CPU closure is an eager union-find worklist. Each equivalence class carries
either no constructor witness or its lowest-ID constructor. Its invariant is:

1. the witness belongs to the class;
2. every constructor already merged into the class has the witness's label and
   arity;
3. for every such constructor, corresponding witness-child equalities have been
   processed or occur later in the worklist.

Merging classes with zero or one witness preserves the invariant directly.
Merging two witnessed classes either proves a clash or appends corresponding
child equalities and retains the lower-ID witness. The two old witness stars plus
these new edges form one star, proving the inductive step. Each successful union
reduces the class count; equality-pair deduplication and finite constructor arity
therefore establish termination. At the fixed point, the partition contains
\(E_0\), is constructor-injective, and adds only injectivity consequences, so it
is exactly the least constructor congruence.

For \(T\) flat terms, \(E\) source equalities, \(P\) child-equality proposals,
\(K\leq P\) distinct child equalities added to the certificate, and \(M=E+K\),
the worklist uses \(O(T+M)\) memory and
\(O((T+E+P)\alpha(T))\) work under word-sized equality keys. It performs at most
\(T-1\) constructor-witness comparisons. The prior frontier algorithm repeatedly
scanned all terms and re-emitted the complete witness star, costing
\(O(F(T+P)+(E+K)\alpha(T))\) for \(F\) nonempty frontiers. Sparse quotient-cycle
detection takes \(O(T+D)\) work and memory for \(D\) distinct
constructor-child edges. The GPU validation uses:

```text
logical device bytes = 4T parents + 8M equalities + 4T readback
compute passes        = 1 union + 1 path compression
scheduled lanes       = 64 ceil(M / 64) + 64 ceil(T / 64)
submissions/readbacks = 1 / 1
```

Packed batches add alignment but not logical per-job work. Union by minimum
representative makes the canonical result independent of successful atomic
order; exact CPU comparison detects missing or excess unions.

This stage is validation evidence, not an end-to-end GPU type-checking speedup.
An earlier implementation used two different algorithms separated by an
arbitrary 64-term cutoff. Its small branch compared \(T^2\) constructor pairs
per frontier, scanned that dense pair column, and performed \(T\) dense
reachability passes of \(T^2\) lanes. At the cutoff, one constructor frontier
alone scheduled 57,344 lanes, while reachability could schedule another 262,144
lanes and allocate \(4T^2=16{,}384\) bytes. Every frozen application exceeded
the cutoff, so the branch provided no production work and no measured
break-even. It has been removed rather than retained as an unscalable second
semantic implementation.

A future end-to-end GPU solver requires primitives justified independently of
this cutoff. Constructor terms can be keyed by
\((\operatorname{rep}(t),\operatorname{label}(t),\operatorname{arity}(t))\);
stable sort/group or an equivalently deterministic join can expose conflicting
labels and star-shaped child equations without enumerating all pairs. Sparse
cycle or strongly connected component analysis can replace dense transitive
closure. Hash tables are not yet selected because collision resolution,
capacity, and atomic insertion order would add unproved failure and
determinism obligations. Removing the CPU closure additionally requires a
GPU-produced derivation forest proving that every union follows from an input
equality or equal-constructor child position, plus independently checkable clash
and acyclicity certificates.

The production boundary deliberately discards this experiment. CPU inference
has already accepted or rejected the program and owns every type consumed by
specialization and Core lowering. A successful GPU result was not used
downstream; an unavailable result only introduced a second failure condition;
and invalid source had already failed before device work. Therefore removing
the call preserves accepted artifacts and language diagnostics while eliminating
one sequential submission/readback. Required-GPU mode still requires the
authoritative GPU compiler stages. The CLI `experiments` command and direct
solver tests retain the differential evidence without charging ordinary
compilation.

### 7.6 Scalar comptime integer semantics

The admitted scalar fragment has two kinds, `i32` and `bool`. Lowering derives a
kind for every expression:

```text
i32 arithmetic (+, -, *, /, %) : i32 × i32 -> i32
i32 order (<, <=, >, >=)       : i32 × i32 -> bool
equality (==, !=)               : A × A -> bool, A ∈ {i32, bool}
Boolean (&&, ||)                : bool × bool -> bool
if                              : bool × A × A -> A
```

Integer literals must lie in \([-2^{31}, 2^{31}-1]\). These checks run while
source expressions become bytecode, take \(O(S_c)\) work for \(S_c\) scalar
nodes, and make the bytecode result kind a derivation rather than an unchecked
annotation. The general frontend type checker provides the same facts for
ordinary compilation, but the exported scalar-lowering boundary establishes them
independently.

Scalar comptime integers denote Wasm `i32`, not unbounded JavaScript numbers.
Addition, subtraction, and multiplication compute modulo \(2^{32}\) and are then
interpreted as signed two's-complement values. Signed division truncates toward
zero and is partial:

```text
div_s(x, 0)      = trap
div_s(-2³¹, -1) = trap
div_s(x, y)      = trunc(x / y) otherwise
rem_s(x, 0)      = trap
rem_s(-2³¹, -1) = 0
rem_s(x, y)      = x - y × trunc(x / y) otherwise
```

These are the WebAssembly integer-operation rules that the residual runtime
uses. The production CPU evaluator checks both division traps before arithmetic.
The standalone GPU conformance kernel assigns explicit failure statuses before
evaluating the corresponding WGSL expression, so a differential test cannot
silently substitute shader-language overflow behavior for source comptime
behavior. Comparisons and Boolean results are canonicalized to zero or one.

Conditionals are branch-selective:

```text
if true  then e₁ else e₂ -> e₁
if false then e₁ else e₂ -> e₂
```

The unselected expression takes no steps and cannot trap. Bytecode lowering
emits a conditional forward jump around one branch and an unconditional forward
jump around the other. If branch instruction counts are \(N_t\) and \(N_f\),
eager selection performed \(N_t + N_f\) branch instructions per job;
control-flow lowering performs only \(N_t + 2\) or \(N_f + 2\). GPU jobs still
execute one interpreter invocation each. Jobs in the same workgroup that choose
different branches may diverge, so the saving depends on branch coherence, but
dead-branch arithmetic is no longer performed under any schedule.

### 7.7 Scalar bytecode validation

A packed comptime job is admitted to either evaluator only if a forward
data-flow judgment assigns one stack depth to every instruction:

```text
constant : h -> h + 1
binary   : h -> h - 1, requiring h >= 2
jump_if  : h -> h - 1 on both successors, requiring h >= 1
jump     : h -> h
halt     : 1 -> completed
```

Opcode and operand columns have equal nonzero length. Constants are i32 values;
other arithmetic operands are canonical zero. Every jump remains strictly
forward and inside its logical job, every join receives the same depth, every
instruction is reachable, depth never exceeds 64, and the sole halt is the final
instruction. These conditions make the control-flow graph acyclic and ensure
every path either reaches that halt or exhausts the explicit fuel bound.

For \(I\) instructions and \(B\) branch edges, validation takes \(O(I + B)\)
work and \(O(I)\) stack-depth memory. It runs before device request, packing,
allocation, or dispatch. This is required for job isolation: the packed GPU
representation stores starts but no end column, so safety follows from proving
that all reachable program counters remain in the job's validated range.

The same derivation supplies the exact batch stack height \(H_b = \max_j H_j\).
For \(J\) jobs the GPU stack arena is:

```text
B_stack = 4 J H_b bytes,  1 <= H_b <= 64
```

The previous allocation used the admitted maximum unconditionally,
\(B_\text{old}=256J\). Reusing the validated height adds no asymptotic work and
cannot under-allocate because every instruction's incoming and outgoing depth is
already part of the confinement judgment. The GPU result reports both \(H_b\)
and \(B_\text{stack}\).

## 8. Soundness and compiler obligations

The implementation must establish:

1. **Type preservation**: a source step preserves value type and does not
   introduce an operation outside the permitted row.
2. **Progress relative to effects**: a closed well-typed computation is a
   return, can step, or performs an operation named in its row.
3. **Empty-row safety**: a closed computation typed with `<>` cannot perform an
   unhandled algebraic operation.
4. **Handler correctness**: handling removes exactly its capability's
   operations, preserves forwarded effects, and adds clause effects.
5. **Abstraction safety**: only the statically selected capability handles a
   performance.
6. **Linear integrity**: lowering neither duplicates nor loses an owner and
   respects continuation multiplicity on every path.
7. **Lowering simulation**: Effect-HIR evaluation and lowered Core have the same
   observable result and residual host trace.
8. **Boundary equality**: the inferred, Core, and ABI rows are identical.
9. **Determinism**: source order, row order, capability IDs, diagnostics, Core,
   Flat Core, and Wasm bytes do not depend on map order or GPU scheduling.
10. **Failure monotonicity**: a device or semantic failure cannot be converted
    into a successful artifact by partial fallback.
11. **Job isolation**: batching cannot make one job observe another job's
    payload, diagnostics, or output bytes.
12. **Rewrite certification**: every committed GPU proposal is re-derived from
    the immutable CPU-validated snapshot.
13. **Type-closure minimality**: the accepted type partition is exactly the
    least constructor congruence generated by source equalities, and its
    quotient graph is acyclic.
14. **Comptime/runtime agreement**: every accepted scalar comptime operation has
    the same value or trap as its residual Wasm `i32` operation.
15. **Branch noninterference**: an unselected comptime branch contributes
    neither a value, a trap, nor executed arithmetic.
16. **Bytecode confinement**: every comptime program counter and stack access
    remains inside its validated logical job.
17. **Scalar kind preservation**: comptime lowering emits bytecode only for the
    typed `i32`/`bool` fragment and reports the derived result kind.

## 9. Cost model

Let:

- `S` be the number of typed source/HIR nodes;
- `N` be the number of functions;
- `E` be the number of call-graph edges;
- `L` be the number of monomorphic operation labels;
- `Sε` and `Eε` be the effectful slice;
- `V` be the number of SSA values.

With dense word bitsets after capability monomorphization, a worklist row
propagation pass is bounded by:

```text
O(S + (N + E) ceil(L / machine_word_bits))
```

because a row bit becomes present monotonically and need cross a relevant edge
at most once. Open rows remain symbolic before monomorphization.

For handler layers `i`, structural capability/direct/CPS lowering costs:

```text
O(Σi (Sε,i + Eε,i))
```

Effectful-call reachability is memoized once per handler layer. With one layer
this is `O(Sε + Eε)`. In the worst case `H` nested handlers each cover the same
slice, giving `O(H(S + E))` work and corresponding code growth. Live-value
analysis using bitsets costs at most:

```text
O(CFG_edges × ceil(V / machine_word_bits))
```

per convergence round, with the usual monotone finite-height bound. Runtime
continuation storage is:

```text
Σp environment_bytes(p)
```

Source substitution has no comparable linear bound and can duplicate a nested
callee at every call site. It is therefore excluded from the normative lowering.

Bundled-prelude parsing is a content-addressed pure function. For compiler
frontend version \(V\), canonical prelude path \(p\), and source hash \(h(s)\),
define:

```text
syntax_key(V, p, s) = (V, p, h(s))
parse(V, p, s) = immutable syntax tree
```

Within one compiler process \(V\) is constant. The cache stores at most one
current `(source_hash, pending_parse)` entry for each compiler-owned bundled
prelude path. Reusing an entry with the same path and hash is observationally
equivalent to reparsing because the parser is deterministic and the tree is
immutable. A changed hash replaces the entry before it can be reused. Ordinary
user and custom-prelude sources remain compilation- or session-scoped, so the
process cache is bounded by the fixed bundled set—23 paths in this repository—
rather than by the number of user files or edits.

For \(C\) independent compilations whose bundled import multisets contain
\(R\) total syntax requests and \(U\) distinct current bundled sources, parsing
work falls from \(R\) parses to \(U\) parses. Each request still resolves and
hashes its source, preserving change detection. Retained memory is
\(O(\sum_{p=1}^{U}|AST_p|)\) with \(U\le23\); the cache does not retain
elaboration, types, specialization state, or artifacts across compilations.

Contextual classification is a length-preserving transduction from source
characters to parser characters. Its state is the current quote and escape
state, line-comment membership, and delimiter stack. Outside quoted and
commented regions, a contextual rewrite at position \(i\) is selected by an
anchored pattern whose first character is necessary for that pattern. The
classifier therefore dispatches comma rewrites only at `,`, caret rewrites only
at `^`, numeric rewrites only at a digit, arrow rewrites only at `_` or an ASCII
letter, and record rewrites only at `{`. Every accepted rewrite replaces
characters in the same interval and never changes its length, so all parser
source spans remain source spans.

The previous implementation requested both `source.slice(i)` and
`source.slice(0, i).trimEnd()` at every one of \(n\) scan positions. Regardless
of whether a JavaScript engine copies or views those substrings, their logical
extent was:

```text
Σ(i = 0 .. n - 1) (n - i) + Σ(i = 0 .. n - 1) i = n² characters
```

For the 25,256-character Editor root this is 637,865,536 logically requested
characters. The current implementation keeps one source string and one
length-\(n\) character array. Sticky regular expressions are matched at the
current index, so classification no longer constructs an unconditional prefix
or suffix. The base state scan is \(O(n)\). Its conservative total bound is
\(O(n + Q + \sum_a L_a)\), where \(Q\) is text inspected by contextual
candidate patterns and \(L_a\) is the backward context inspected for each
lexical single-parameter arrow candidate. Accepted candidates advance past
their entire interval. This is not yet a proof of worst-case linear time:
adversarial failed record candidates or many arrow-like identifiers can make
the residual terms superlinear.

Arrow classification has two independent predicates at position \(i\):

```text
arrow(i) = lexical_arrow(i) ∧ arrow_context(i)
```

Both predicates are pure functions of the immutable source, and the sticky
lexical matcher resets its cursor to \(i\) before every test. Commutativity of
conjunction therefore permits lexical evaluation first. Let \(H\) be
letter-headed positions, \(B\subseteq H\) the positions admitted by the cheap
bare-context prefix, \(M\subseteq H\) lexical arrow spellings, and
\(K=B\cap M\). The previous order performed \(H\) bare-context checks, \(B\)
complete-prefix checks, and \(B\) lexical matches. The new order performs \(H\)
lexical matches, \(M\) bare-context checks, and only \(K\) complete-prefix
checks. The change is profitable when:

```text
H Clex + M Cbare + K Cprefix
  < H Cbare + B Cprefix + B Clex
```

This is not true for every regex engine or corpus, so the inequality is an
empirical selection criterion rather than a semantic premise. On the Editor
root, \(H=14,945\), \(B=858\), \(M=147\), and \(K=11\). Logical complete-prefix
extent falls from 10,153,696 to 178,601 characters, a 98.24% reduction.
Discarded-parameter arrows use the same lexical-first conjunction.

Record-context recognition is derived from the old predicate rather than
approximated. After skipping whitespace backwards from `{`, the prefix is empty
or ends in exactly one of `:+`, `<&`, `;`, or `}`. Checking the previous
non-whitespace character and its preceding pair is therefore equivalent to
constructing and trimming the complete prefix. Pattern priority is unchanged,
and a head dispatch may skip a pattern only when its anchored first character
cannot match. Patterns are local to one classifier invocation because sticky
regular expressions mutate `lastIndex`; sharing them would introduce reentrant
state. A whole-source regular-expression replacement was rejected because it
would rewrite apparent syntax inside strings and comments and would lose the
delimiter state needed by newline array classification.

The frozen applications measured on 2026-07-31 contain sparse effect metadata
and only one locally handled region:

| Target    | Row memberships | Capability operands | Root capabilities | Direct regions | Direct functions | CPS regions | CPS functions | Handled performances | Continuation captures | Wasm bytes |
| --------- | --------------: | ------------------: | ----------------: | -------------: | ---------------: | ----------: | ------------: | -------------------: | --------------------: | ---------: |
| Editor    |              10 |                 138 |                 1 |              1 |                9 |           0 |             0 |                    1 |                     0 |     24,460 |
| Codex     |              11 |                   0 |                 5 |              0 |                0 |           0 |             0 |                    0 |                     0 |    226,134 |
| grep      |               2 |                   0 |                 3 |              0 |                0 |           0 |             0 |                    0 |                     0 |      3,911 |
| tar       |               0 |                   0 |                 1 |              0 |                0 |           0 |             0 |                    0 |                     0 |     26,106 |
| wav       |               0 |                   0 |                 0 |              0 |                0 |           0 |             0 |                    0 |                     0 |      2,520 |
| raytracer |               0 |                   0 |                 0 |              0 |                0 |           0 |             0 |                    0 |                     0 |      3,864 |

`continuation captures` is the sum of distinct free symbols in retained
generated continuation expressions, not the peak live environment. Relative to
the contemporaneous CPS control, the direct Editor lowering changes Core
functions from 175 to 101, blocks from 649 to 545, operations from 1,611 to
1,341, and Wasm bytes from 33,602 to 24,460. The reductions are respectively
42.29%, 16.03%, 16.76%, and 27.21%. Continuation captures change from 2,265 to
zero. Five-sample warm medians were effectively neutral at this scale: CPU
209.74 to 211.14 ms and GPU 299.96 to 297.30 ms. The deterministic work
reduction is established; the timing delta is smaller than uncontrolled
run-order noise.

Capability operands, transformed functions, and continuation captures are
counted after unreachable generated bindings are removed. Handled performances
are keyed by effect family and source span, so nested specialization cannot
inflate one source operation into several metric entries.

## 10. Admitted language subset

The first sound implementation admits:

- first-order algebraic operations;
- deep handlers;
- linear and affine one-shot resumptions;
- open effect rows on every callable type;
- lexical capability evidence;
- pure handlers and residual typed host effects;
- ownership-aware continuation environments;
- baseline-WebAssembly capability/direct/CPS lowering.

It rejects until separately specified:

- multi-shot resumptions;
- escaping resumptions;
- answer-type polymorphism;
- non-tail answer-type-changing composition across a generated inner
  continuation;
- scoped or higher-order operations with computations as arguments;
- asynchronous or concurrent execution without a task/poll ABI;
- bracketing, task groups, transactional alternatives, and resource scopes
  presented as ordinary algebraic operations;
- native WebAssembly stack switching as a semantic dependency.

WebAssembly stack switching may become an optional backend after the proposal
and engines are stable. Baseline compiler-generated CPS remains the portability
contract.

## 11. Initial falsification results

Two independently constructed programs falsified the prototype's soundness
claims on 2026-07-30.

### 11.1 Dynamic duplication behind one syntactic resume

A handler clause contained one textual resumption inside a two-iteration loop.
The captured continuation incremented handler state. The program compiled and
returned `2`, proving that the one-shot continuation executed twice. The cause
is textual reference counting before loop expansion.

### 11.2 An effect hidden behind a non-reference callee

A function declared `() -> I32` selected an effectful function using an `if`
expression and called the result. The program compiled, performed `Input.read`,
and returned the host value `42`. The effect summary treats an unknown callee
shape as pure; the Core boundary then adds the surviving host operation to the
ABI. This violates preservation and empty-row safety.

These programs are required regression cases for the migration.

## 12. Implementation migration

The migration is performed in this dependency order:

1. preserve both falsifications as regression tests and reopen the previous
   completion claim;
2. retain handler syntax through resolution;
3. put latent rows in callable types and infer every call from its callee type;
4. elaborate resolved typed syntax to explicit Effect HIR;
5. validate ownership and path-sensitive resumption multiplicity on Effect HIR;
6. structurally lower capability passing and selective CPS;
7. enforce exact residual/Core/ABI equality and measure actual operands;
8. differentially compare reference evaluation and Core execution for generated
   well-typed programs.

## 13. Continuous implementation log

### 2026-07-30: specification reset

The earlier `THEORY.md` and Phase 7A checklist claimed that open rows,
generative source capabilities, typed handlers, control-flow linearity,
selective CPS, and exact boundary closure were implemented. A code audit and the
two falsification programs showed that these claims described the intended
architecture rather than the actual compiler.

This paper replaces those claims with the normative calculus, explicit soundness
obligations, cost model, admitted subset, and ordered migration above.
`AGENTS.md` now requires this paper to change continuously with the
implementation. No compiler behavior changed in this first documentation step.

### 2026-07-30: falsifications become conformance tests

The Phase 7A checklist was reopened. The dynamic-loop resumption and
conditional-callee effect programs were added to the test suite as required
rejections. A neighboring positive case resumes once on either mutually
exclusive branch; it prevents the multiplicity checker from replacing one
unsound textual count with a blanket ban on multiple syntax occurrences.

The source checker now computes a conservative execution interval
`[minimum, maximum]` for resumption calls. Sequential constructs add intervals,
exclusive branches join them, and any resumption reachable from a repeating loop
or escaping nested function has an unbounded maximum. Linear captures require
`[1, 1]`; all one-shot resumptions require `maximum <= 1`. This is an executable
approximation of Section 4. It remains a syntax analysis and will be deleted
when the same judgment runs over Effect HIR.

Effect propagation now joins the callable rows of conditional and block-valued
callees. This closes the concrete empty-row counterexample. It is not yet the
general callable-type rule in Section 3.4; field, index, returned closure, and
other opaque callable flows still require effect-bearing types.

### 2026-07-30: exact residual boundary

The Core boundary now checks equality in both directions. Every operation in the
inferred main row must have a reachable Core host call, and every reachable Core
host call must occur in that row. It no longer repairs an unsound inference by
silently replacing the inferred row with the operations found after lowering.
The reverse-direction regression constructs a Core module independently of the
frontend and verifies that an undeclared reachable call is rejected with its
source position. This is executable evidence for obligation 6 in Section 7; the
forward direction was already exercised by compiled boundary programs.

### 2026-07-30: closed rows enter callable types

The shared type representation now permits a canonical callable effect row.
Ducklang attaches an inferred closed row to the innermost callable arrow, and
type application preserves and compares that row. A conformance test observes
`i32 -> i32 ! <Input.read>` on the inferred binding rather than consulting only
the binding side table.

This is deliberately not marked as completion of open-row inference. Nullary
source functions are still represented by their result type, and declared row
variables are still summarized as callback-parameter indices. Both encodings
lose information required by Section 3.4. The next representation change must
give every source function an arrow, introduce row variables with independent
identity, and instantiate row and value variables together. The closed-row step
is retained because it makes concrete higher-order effect loss observable at
ordinary type-unification boundaries.

Calls produced by type inference also record the row selected from the actual
callee arrow. Compiler-generated calls created by later closure and control-flow
rewrites do not yet all carry this evidence, so the field remains optional until
those rewrites consume and reproduce typed Effect HIR rather than manufacturing
typed syntax. This is a tracked preservation gap, not permission to interpret a
missing row as purity.

### 2026-07-30: projected module callables preserve effects

Running the exact boundary over the whole test corpus exposed a third
counterexample: a linked module returned an effectful function in a record; the
root destructured that field and called it. Core retained `Io.print`, but the
pre-type effect analysis treated the field alias as pure. The callable analysis
now follows resolved binding identities, statically known record projections,
and the result record of a known module function. The existing managed
multi-file fixture is the regression: weakening this propagation causes the
exact boundary to reject the reachable `Io.print`.

This repair is intentionally narrow. It makes the current linked-module value
forms sound, but it reinforces why syntax-shape discovery cannot be the final
algorithm. Once all callable rows are inferred types, projection obtains its row
from the projected field type and this special traversal is deleted.

### 2026-07-30: nullary arrows and explicit open annotations

Nullary source functions now retain a function type:

```text
() -> A ! ε
```

The type uses a statically marked `Unit` domain, but Core signature extraction
omits that proof-only domain. Consequently no runtime operand or ABI parameter
was added. Zero-argument application consumes only this nullary arrow, and
ordinary application rejects it. The existing host-effect test now observes
`() -> i32 ! <Input.read>` while Core and Wasm continue to expose zero
parameters.

Function type references also retain written open rows. For the admitted
higher-order form:

```text
(A -> B ! <e>, A) -> B ! <e>
```

the inner arrow carries `e`; the outer inferred arrow carries evidence that its
row is supplied by parameter zero. Application takes the row from the actual
argument callable and removes the abstract parameter evidence. The conformance
case observes:

```text
(i32 -> i32 ! <e>) -> i32 -> i32 ! <ρ0>
apply(read, 0) : i32 ! <Input.read>
```

This is executable row instantiation for the language's currently admitted
rank-1 callback rows. A second conformance case applies the same `apply` binding
first to an `Input.read` callback and then to a pure callback; the call rows are
respectively `<Input.read>` and `<>`. Instantiation therefore does not
monomorphize the binding after its first use.

At this point in the migration row variables still had to be written and were
represented by callback-parameter indices. The later numeric-row entry below
replaces both restrictions. Open intersection and difference remain rejected;
they require row-lacks constraints rather than set arithmetic over an unknown
tail.

### 2026-07-30: effect syntax is no longer disguised

The syntax IR now has explicit `effectHandler` and `handle` variants. The parser
previously encoded these as a nominal record and a call to the nonexistent name
`$duck_try`; handler lowering then had to recognize those shapes before name
resolution. Both the modern `handler Effect` surface and the retained
`Effect { ... }` surface normalize to the explicit variants. A syntax
conformance test verifies that the variants survive parsing, boundary
normalization, and hygiene.

The existing lowering consumes these variants and all 121 vendored plus 35
frozen live sources still parse and compile. This is a representation migration,
not yet the Section 5 pass order: handler lowering still runs before resolution
and typing. Resolution now rejects an explicit handler if that ordering
invariant is broken, making the remaining seam observable rather than falling
through to an “unknown `$duck_try`” diagnostic. The next step is to replace that
invariant with resolved handler/capability nodes and type their clauses before
lowering.

### 2026-07-30: resolved and typed Effect HIR

Handler syntax now survives name resolution and type inference. Resolution
assigns each handler constructor the deterministic generative identity
`file:start:effect`, verifies that it has exactly the declared operation clauses
plus `return`, and turns a call through a clause's resumption parameter into an
explicit `resume(resumption_id, value)` node. The resumption ID is a resolved
symbol identity, so a same-spelled parameter in another scope cannot capture it.

Typing gives each handler two shared metavariables, `Input` and `Answer`.
`return` has type `Input -> Answer`; an operation `P -> R` has clause type
`P -> (R -> Answer) -> Answer`. All clauses therefore constrain one answer type,
while a resumption may legitimately change the handler's answer type from the
handled computation's input type. This distinction corrected a counterexample
test whose first form incorrectly assumed those types must be equal.

The compilation artifact exposes this representation as Effect HIR version 1.
The executable conformance case observes an explicit `handle`, its lexical
capability identity, and the `resume` node inside the selected operation clause.
The production backend still uses the older source-level lowering after this
typed preflight, so the frontend currently performs derivation, extension, loop,
control-flow, resolution, and type work twice. That duplication and the
source-substitution lowering remain implementation gaps; the typed preflight is
evidence for the typing boundary, not completion of structural lowering.

### 2026-07-30: ownership judgment moves onto Effect HIR

Resumption multiplicity is now validated over typed Effect HIR before any
handler is eliminated. The analysis keys resumptions and captured values by
resolved numeric symbol identity. Sequential paths add usage intervals,
exclusive branches join by minimum and maximum, early return stops the following
sequence, and a resumption captured by a nested function has an unbounded
maximum. Directly reachable effectful functions are inspected without
substituting their bodies at call sites.

For each handled performance, the validator finds linear symbols declared before
and referenced after the performance in its enclosing function. Their presence
changes the operation clause's control requirement from affine `[0, 1]` to
linear `[1, 1]`. The dynamic-loop, exclusive-branch, double-resume, aborting
affine, and captured-linear conformance cases all pass at this new boundary. The
older source checker is still run afterward as a differential oracle. Removing
it is contingent on selecting structural lowering, because the current source
lowerer also contains its own multiplicity checks.

### 2026-07-30: row variables receive independent identities

Callable rows no longer encode a row variable as “effects of parameter index.”
Each written or inferred row variable receives an inference-local numeric
identity. When the same written variable occurs in a callback parameter and the
enclosing result row, both positions carry that identity:

```text
(i32 -> i32 ! <ρ0>) -> i32 -> i32 ! <ρ0>
```

Application matches variables in formal callable arguments with the actual
argument rows, substitutes those rows into the callee result computation, and
does so afresh at every call. A higher-order function with no annotation now
infers the row above from `callback(value)`; applying it to an `Input.read`
callback produces `<Input.read>`. The existing two-call conformance case still
produces an effectful row followed by an empty row, so the variable is not
destructively unified at its first use.

The pre-type effect analysis still discovers which function parameters
contribute to a binding's latent row, but that parameter index is now only
analysis evidence. Type construction immediately resolves it to the row variable
carried by the parameter's callable type. It does not survive as the row's
semantic identity.

### 2026-07-30: handler rows and control multiplicity are typed evidence

Effect HIR handlers now record the canonical union of their clause rows. Every
`handle` records its lexical capability ID, handled family, forwarded body row,
clause row, resulting row, and one control-multiplicity record per operation.
The ownership pass changes an operation from affine to linear exactly when one
of its performances captures a non-discardable linear symbol, and records the
captured symbol identities as reviewable evidence.

The pure `Counter` handler has empty forwarded, clause, and result rows. A
second conformance handler performs `Audit.write` in its operation clause; its
clause and result rows both retain `<Audit.write>` after `<Counter.get>` is
subtracted. The linear `Gate.pass` case records the captured `token` and
linearity, while the non-capturing `Counter.get` case records affine control.
Thus purity, impurity, and control multiplicity are properties of typed HIR
rather than conclusions reconstructed after lowering.

### 2026-07-30: structural capability passing and selective CPS are selected

The production pipeline now lowers typed Effect HIR directly. The duplicate
derivation, extension, loop, control-flow, resolution, and inference path has
been removed, and the source-substitution lowerer has been deleted.

Every function in the effectful call-graph slice receives:

```text
original parameters
captured lexical values
explicit handler state
one typed clause capability per operation
one one-shot return continuation
```

A performance calls its operation capability with the current explicit state and
a continuation closure. Resuming consumes that closure and supplies both the
operation result and the next state. Handler assignments are therefore ordinary
immutable state versions threaded through calls; no shared mutable reference is
introduced. Aborting a clause simply does not invoke the continuation. The
return clause receives the final state.

The first structural draft used a tree splitter. The frozen Editor falsified it:
rebuilding a whole expression around a performance put already-evaluated
prefixes inside the continuation and produced an 18-byte frame instead of the
specified 126-byte frame. The selected translation is the direct
fine-grain-call-by-value derivation:

```text
T[let x <- c1; c2] k = T[c1] (λx. T[c2] k)
T[if c then t else f] k =
  T[c] (λb. if b then T[t] k else T[f] k)
```

It visits each Effect HIR node once per specialized handler and constructs only
the remaining suffix as a continuation. The Editor now emits all 126 terminal
bytes, the stateful `add`/aborting `get` case returns 2, and 24 generated
stateless and stateful abort/resume programs agree with the executable reference
calculus.

Imported generic effects are now retained in the linked semantic environment.
Effect declarations preserve their type parameters, and each handler or
performance instantiates one shared substitution for all operation parameter and
result types. This was required to type the source-defined `State value`,
`Reader environment`, and other exported default-handler factories once handlers
began surviving to inference.

Default-handler selection now retains the source extension's numeric `order`
evidence through extension elaboration and type inference. One handler is
selected per effect family, and families are nested by `(order, source span)`.
The conformance case declares `Bonus` before `Base` but orders them 20 and 10;
the result remains 42 rather than the source-order result 44.

The residual row is recomputed from typed Effect HIR before handler syntax is
removed. Operations from an original family with no selected handler remain in
the row, while selected families are replaced by the typed handle's forwarded
and clause rows. The Core boundary independently enumerates reachable typed
`host.call` operations and requires equality, so neither imported `Io.print` nor
a handler clause's `Audit.write` can disappear through metadata repair.

Nested default handlers exposed a second structural counterexample. The outer
operation may occur inside the continuation generated while lowering the inner
handler. Leaving generated functions opaque leaked the outer operation to Core.
The selected pass rewrites effectful compiler-generated resumptions and rejects
answer-type-changing composition there. It does not rewrite ordinary nested
source functions in place; those remain in the normal typed call-graph
specialization path.

### 2026-07-30: linear tail resumptions select direct state passing

The direct translation in Section 6.1 is implemented as a conservative
alternative to CPS. The recognizer admits only a unique tail `resume`,
optionally after a straight-line prefix; branching, aborting, and non-tail
clauses continue to select CPS. The generated differential suite, the
state-shadowing cases, and the linear-owner case exercise both paths. Qualifying
nested handlers now compose across an answer-type change because no generated
continuation lies at that boundary.

The first implementation threaded every handler-prefix binding and represented
every result as an aggregate. Editor falsified that representation: although it
removed 2,265 continuation captures, it increased Core operations to 3,809 and
Wasm to 59,758 bytes. The derivation was refined so that only roots of typed
`previous` chains and linearly owned bindings are state, unit values are erased
from products, and singleton products use their element directly. The resulting
Editor has 1,341 Core operations and 24,460 Wasm bytes. This failed measurement
is retained because it is evidence for the state criterion, not an
implementation anecdote.

The nullary stateless case also established a representation boundary:
zero-argument transition functions require an explicit nullary function type;
the empty parameter fold must not collapse a function into its result type.

### 2026-07-31: demand and exact dirty frontiers bound specialization

Static closure specialization now starts from the fixed-point demand set in
Section 6.3. Dynamic callees remain ordinary references, and runtime
non-function initializers remain conservative roots because Ducklang preserves
traps and residual effects. Only demanded bindings are rewritten and only
reachable or initializer bindings are emitted.

The specialization memo uses typed static-value identities, immutable function
and residual-value identities, referenced environment identities, and source
diagnostic sites. Pending entries break exact specialization cycles; complete
entries are reused. The six frozen targets produce 751 distinct keys and 6
complete-key hits. These are executable measurements, not a termination proof
for arbitrary online partial evaluation; recursive source functions remain
outside the inline rule.

Comptime replacement now returns the exact changed-binding set derived from its
rewrite relation. Reverse dependency closure turns that set into the second
specialization frontier. Editor revisits 5 bindings and 719 input nodes. Codex,
grep, tar, wav, and raytracer revisit zero bindings and zero nodes.

The first implementation compared complete serialized expressions to discover
changes and also used complete expression serialization in every memo key. The
focused corpus tests became several times slower even though outputs remained
identical. That falsified structural serialization as an admissible hot-path
identity. The selected implementation uses syntax-directed change evidence and
small typed identities. The full retained ledger is:

| Target    | Input bindings | Demanded bindings | Discarded bindings | Input nodes | Demanded nodes | Residual nodes | Keys | Hits | GPU functions |
| --------- | -------------: | ----------------: | -----------------: | ----------: | -------------: | -------------: | ---: | ---: | ------------: |
| Editor    |             87 |                82 |                  5 |       4,207 |          4,150 |          2,845 |   47 |    2 |           101 |
| Codex     |            101 |                47 |                 54 |      18,109 |         16,119 |         23,594 |  703 |    4 |           301 |
| grep      |             27 |                 7 |                 20 |         962 |            707 |            419 |    1 |    0 |            12 |
| tar       |             47 |                23 |                 24 |       4,897 |          4,411 |          3,220 |    0 |    0 |            12 |
| wav       |             13 |                12 |                  1 |         270 |            269 |            215 |    0 |    0 |             6 |
| raytracer |             13 |                 9 |                  4 |         462 |            458 |            433 |    0 |    0 |            15 |

Codex is the counterexample to treating discard ratio as sufficient:
specialization discards 53.47% of its bindings but still expands residual nodes
to 146.37% of demanded input nodes. Further reachability scanning alone cannot
address its dominant work.

### 2026-07-31: stable sharing removes allocation-history specialization

Six non-overlapping specialization substages identified Codex rewriting and
function lifting, not demand discovery, as the dominant costs. Function bodies
are now summarized once per immutable function object; substitution is fused
with rewriting; static conditionals rewrite only the selected arm; read-only
walks allocate nothing; and unchanged rewrites preserve the original expression
object. A clean comptime result skips the complete second specialization pass.

The before and after measurements are separate five-sample warm-median runs on
the same machine and day, so timing changes are empirical evidence rather than
proofs:

| Codex measurement            |    Before |     After |   Change |
| ---------------------------- | --------: | --------: | -------: |
| CPU compilation              | 985.18 ms | 755.73 ms |  -23.29% |
| Pre-comptime specialization  | 240.45 ms | 127.79 ms |  -46.85% |
| Specialization rewrite       | 176.46 ms |  91.08 ms |  -48.39% |
| Function lifting             |  43.83 ms |  24.99 ms |  -42.97% |
| Post-comptime specialization |  15.27 ms |      0 ms | -100.00% |

The deterministic structural deltas are stronger evidence:

| Codex residual measure |  Before |   After |  Change |
| ---------------------- | ------: | ------: | ------: |
| HIR nodes              |  25,392 |  23,594 |  -7.08% |
| Core functions         |     493 |     301 | -38.95% |
| Core blocks            |   5,168 |   3,824 | -26.01% |
| Core operations        |  16,412 |  12,956 | -21.06% |
| Wasm bytes             | 283,648 | 226,134 | -20.28% |

The unexpectedly large function and binary reductions falsified the assumption
that reconstruction identity was merely an implementation detail. The old
visitor and unconditional parent rebuilding repeatedly copied unchanged function
values; function lifting then treated those copies as separately generated
closures. The selected rule preserves existing immutable sharing. It does not
add global hash-consing: structural canonicalization would require `O(S')`
hashing and a table over the residual program, and the earlier
full-serialization experiment already measured that strategy as a hot-path
regression. Paraskevopoulou and Appel's safe-for-space analysis is also a
warning against treating additional closure sharing as universally beneficial;
the implemented rule only retains sharing already present in immutable HIR and
does not construct a more highly shared runtime environment.

Three-run byte determinism, the frozen managed Codex model-turn test, a
required-GPU CPU differential, engine validation, and the unselected-branch
regression are executable validations. They do not constitute a mechanized
semantic-preservation proof. The proof obligation discharged here is narrower:
identity-preserving reconstruction is extensionally equal on immutable typed
HIR, and memo-key environment components prevent closure conflation.

The final required-GPU release gate compiled every frozen application twice.
Codex completed in 1,041.63 ms and 964.69 ms and emitted 226,134 byte-identical
bytes; Editor completed in 384.42 ms and 284.92 ms and emitted 24,460
byte-identical bytes. All six targets passed GPU type validation, authoritative
Core rewriting and Wasm emission, CPU differential comparison, engine
validation, device-capacity preflight, and their time budgets. These two samples
are correctness evidence, not a latency distribution.

### 2026-07-31: Wasm scan work becomes observable

The implementation uses the Hillis–Steele scan specified in Section 7.4 rather
than the work-efficient scan proposed historically. New profile counters expose
length rounds, scan rounds, and scheduled invocations including workgroup
padding. Codex contains 204,099 atoms, requires 2 length rounds and 18 scan
rounds, and schedules 4,491,520 invocations across 22 full-width passes. Its
2,040,992-byte output buffer is 9.03 times the 226,134-byte result. These are
exact work counts from a required-GPU differential compilation; the associated
single timing observation is not promoted to a distribution.

The measurement separates two hypotheses. Replacing Hillis–Steele with a
hierarchical work-efficient scan should reduce arithmetic from `Θ(A log A)` to
`Θ(A)` but adds workgroup sums and another hierarchy. Computing a per-atom
maximum encoded size should reduce the output and readback buffers without
changing scan work. Neither optimization is justified by the count alone; each
requires an end-to-end before/after distribution and identical bytes.

### 2026-07-31: atom kinds tighten the Wasm capacity proof

The output and readback allocation now use the per-kind maximum derived in
Section 7.4 instead of `10A`. Across the six frozen applications this reduces
each buffer by 72.47–75.05% without changing a dispatch, scan value, or emitted
byte. Codex falls from 2,040,992 to 557,308 bytes per buffer, saving 2,967,368
bytes across output plus readback.

The new bound is still 2.34–2.62 times the final module because it uses
type-maximum rather than actual LEB128 widths. Exact allocation would require
learning the final prefix before allocating output, adding a readback and second
submission, or introducing a larger shared device arena with its own allocation
proof. The smaller static bound is selected because it improves capacity with
zero new synchronization. CPU/GPU byte differentials, the full-width signed
`i64` fixture, and all frozen outputs remain the executable evidence.

### 2026-07-31: the host atom DAG gives exact Wasm capacity

The preceding conclusion was false: the immutable atom DAG and all scalar values
already exist on the host. A width-only evaluator now resolves that DAG without
emitting bytes and allocates the exact byte length rounded to a word. The GPU
still independently calculates sizes and lengths; its final prefix must equal
the host measure before bytes are accepted.

Across the frozen applications, output buffers are Editor 24,460, Codex 226,136,
grep 3,912, tar 26,108, wav 2,520, and raytracer 3,864 bytes. Each is the module
length rounded upward by at most three bytes. Relative to the kind bound, this
removes another 57.28–61.80% from both output and readback buffers with no
device synchronization; Codex saves 331,172 bytes in each buffer. The full
six-target required-GPU gate, CPU byte differentials, and engine validation
passed.

### 2026-07-31: Wasm prefixes become hierarchical

The global Hillis–Steele scan was a correct but unnecessarily superlinear
execution schedule. The implementation now performs 64-element shared-memory
scans upward through a geometric hierarchy and propagates parent prefixes
downward. Section 7.4 proves the inclusive-prefix invariant and records the
exact work, span, storage, and non-aliasing rules. A first implementation bound
adjacent hierarchy levels through the same storage buffer; WebGPU rejected the
read-only/read-write alias. Alternating level buffers makes that illegal state
unrepresentable.

On the frozen corpus, this executable work count reduces scheduled invocations
by 62.34–72.58%. Codex changes from 18 scan dispatches and 4,491,520 total
scheduled invocations to 5 and 1,231,424. Its scan storage changes from
1,632,792 to 842,332 bytes, a 48.41% reduction. These are deterministic counts,
not timing claims. Generated-plan and CPU-byte differentials, shared-word
determinism, engine validation, and the full required-GPU gate are the
executable evidence; latency improvement remains an empirical question.

### 2026-07-31: Wasm length work becomes a sparse frontier

The hierarchical scan exposed the remaining two full-width length passes as
mostly inactive work. The host plan now groups known length-atom indices by
dependency level, transfers only that stable frontier, and dispatches its
nonempty levels in order. Section 7.4 derives readiness from the strict
dependency-level relation and records the exact work and transfer equations. A
level-1,000,000,000 plan with every lower level empty is the executable
counterexample ensuring that a numeric maximum is not confused with either
dispatch count or host iteration count.

The frozen modules contain only 14–348 length atoms among 2,477–204,099 total
atoms. Their length work changes from 4,992–408,320 scheduled lanes to 128–448,
a 97.44–99.89% reduction. Codex total Wasm-emission invocations change from
1,231,424 after hierarchical scan to 823,552; its dependency metadata transfer
changes from 816,396 to 1,392 bytes. These are deterministic counts. Generated
plan differentials, the sparse-level regression, packed emission, engine
validation, and the full required-GPU gate are executable evidence; no latency
distribution is claimed.

### 2026-07-31: Wasm length ranges join their frontier

The first sparse frontier carried only atom IDs and retained two dense
atom-indexed range columns. Since range start and count are immutable properties
of the same length record, that representation had no semantic justification.
The transferred frontier now carries all three words and the GPU indexes them by
frontier position. Its representation invariant is column-length equality:
position \(q\) contains one atom ID and exactly that atom's validated range.

Across the frozen plans, length metadata changes from `8A + 4K` to `12K` bytes,
a 99.11–99.86% reduction. Codex changes from 1,634,184 to 4,176 bytes. GPU work
and emitted bytes are unchanged. Generated and frozen CPU-byte differentials,
packed emission, engine validation, and the full required-GPU gate are the
executable evidence.

### 2026-07-31: Core rewrites gain an opcode frontier

The rewrite matcher previously scheduled and read back one lane for every Core
operation even though its complete rule set is undefined outside `scalarBinary`.
Section 7.3 proves that filtering on this outer discriminant cannot omit a
proposal. The stable candidate queue reuses the rule-output buffer so the kernel
stays within eight storage bindings; the empty-frontier regression proves that
zero candidates encode zero rewrite dispatches.

Frozen candidate frontiers contain 34–2,890 of 130–12,956 operations. Scheduled
rewrite lanes fall by 50.00–85.71%, and rule/replacement payload falls by
55.02–87.40%. Codex changes from 12,992 to 2,944 scheduled lanes and from
103,648 to 23,120 payload bytes. Candidate counts, scheduled lanes, and proposal
counts are executable profile fields. Generated CPU/GPU proposal equality,
semantic certificate validation, empty-frontier behavior, packed isolation, and
the full required-GPU gate are the executable evidence; no latency distribution
is claimed.

### 2026-07-31: redundant Core validation becomes measurable

The compact rewrite frontier made the separate GPU structural validator the
dominant Core schedule. Frozen plans contain 3,390–257,934 validation records
and schedule 3,392–257,984 validation lanes, compared with only 64–2,944 rewrite
lanes. Codex additionally uploads 4,126,944 bytes of `vec4<u32>` validation
records.

These are deterministic profile counts from required-GPU compilations. They
falsify the assumption that rewrite matching dominates the Core GPU boundary.
The records duplicate the stronger CPU structural and semantic validator that
already brands the exclusively held input before proposal generation. The
theoretical next step is removal, not a denser record encoding: Section 7.1
requires CPU-validated input, and Section 7.3 independently revalidates every
proposed semantic change.

### 2026-07-31: Core validation stays at one trust boundary

The duplicate GPU structural validator, its record construction, shader,
pipeline, three device buffers, readback prefix, dispatch, and profile fields
have been removed. An invalid flat-Core job now returns from CPU validation
without requesting a device on its behalf in both the single-job and packed
paths. Valid jobs receive the branded, exclusively held snapshot described in
Section 7.2; the GPU can only propose rewrites, and Section 7.3's exact CPU
matcher still validates every proposal before deterministic rebuild and complete
output validation.

This is a reduction in proof surface as well as work. The removed GPU predicate
checked only column lengths, ranges, discriminants, and ID bounds, whereas the
CPU boundary also checks ownership, definition uniqueness, same-function uses,
layouts, and semantic inflation. Agreement with a weaker duplicate did not prove
an additional invariant. Retaining it would therefore spend \(64\lceil
R/64\rceil\) lanes and \(16R\) record bytes without strengthening the
accepted-result theorem.

For the frozen applications, the deterministic savings are 3,392–257,984
scheduled lanes and 54,240–4,126,944 record bytes per Core pass, plus the small
error, parameter, and readback allocations. The malformed-type regression now
passes even when no adapter is available, which executes the pre-device trust
boundary. CPU/GPU rewrite equality, false-certificate rejection, packed
isolation, and the required-GPU release gate are executable validations. No
latency distribution or proof of the WebGPU kernel follows from these counts.
The post-removal gate passed all 493 tests and compiled each frozen application
twice with byte-identical CPU/GPU emission and engine validation. Codex's two
correctness samples were 1,016.31 ms and 847.40 ms; Editor's were 377.55 ms and
270.31 ms. They are not a controlled latency comparison.

### 2026-07-31: an empty Core frontier is an identity

The Core boundary previously encoded zero rewrite dispatches for
\(C=\varnothing\) but still constructed five derived host tables, requested the
GPU context, allocated ten buffers, submitted an empty command buffer, and
mapped an eight-byte readback. Section 7.3 proves that the candidate
discriminant is a complete outer filter for the current matcher. The prepared
job is now a tagged `invalid | identity | rewrite` state: only `rewrite` can
contain GPU columns, and an `identity` returns its validated package before
device acquisition.

Single-job and two-job throughput regressions require zero initialization,
transfer, execution, commit, submission, proposals, and accepted rewrites for
constant-only Core. They do not skip on GPU unavailability, so the identity path
is executable without an adapter. Packed execution removes identity jobs before
packing nonempty jobs and restores results in logical order. All frozen targets
have nonempty frontiers, so this change has no claimed effect on their release
samples. The full required-GPU gate passed 494 tests and compiled every frozen
target twice with byte-identical CPU/GPU emission and engine validation.

### 2026-07-31: an empty type equation set is solved before WebGPU

The type solver previously requested a device before flattening an empty
equation list and returning the unique empty congruence. Section 7.5 now makes
that base case explicit. The boundary returns zero terms, equations, union
rounds, decompositions, and submissions before adapter acquisition; the public
batch queue still records its logical payload and queue wait.

The regression has no unavailable branch, so it executes on runtimes without
WebGPU. Nonempty type graphs are unchanged. The 495-test required-GPU gate and
six frozen targets remain executable integration evidence; the empty case claims
no effect on those nonempty workloads.

### 2026-07-31: Core matching consumes candidate-local descriptors

The first opcode frontier still uploaded dense operation, operand, attribute,
value, and type columns because a candidate could refer to arbitrary
definitions. Section 7.3 now observes that the current rule set follows at most
two value-definition edges and reads a fixed 20-word projection. The CPU trust
boundary gathers that projection without evaluating the operator or identity;
the GPU matcher remains authoritative, and exact CPU certificate validation
still rejects any false result.

Across the frozen applications, derived host typed-array allocation falls by
48.57–85.11%, logical Core device capacity by 45.67–83.61%, and storage bindings
from eight to three. Codex changes from 908,316 to 242,760 derived host bytes
and from 956,080 to 277,444 logical device bytes. Candidate-descriptor and
logical device byte counts are executable profile fields. Generated CPU/GPU
equality, the false-certificate regression, packed isolation, and the
required-GPU gate are conformance evidence; deterministic byte counts do not
establish a latency distribution.

### 2026-07-31: Wasm layout is resolved once at the CPU trust boundary

Exact output allocation already traversed the validated atom DAG, resolved every
nested length, and summed every encoded width. The GPU nevertheless repeated
size calculation, length evaluation, and a hierarchical prefix scan. Section 7.4
now records every partial sum during the mandatory host traversal and sends the
resulting \(A+1\) boundaries to one parallel emission kernel.

The representation proof is \(p_{i+1}=p_i+s_i\): lane \(i\) owns
\([p_i,p_{i+1})\), while a length range \([r,r+c)\) has byte value
\(p_{r+c}-p_r\). The public analysis regression checks exact known boundaries;
GPU/CPU differential tests cover nested and sparse dependency levels, packed
jobs, signed LEB boundaries, and shared output words. Engine validation remains
the final binary conformance check. The full 496-test gate and two deterministic
compilations of every frozen target passed.

Across the frozen applications, scheduled Wasm lanes fall from 10,176–823,552 to
2,496–204,160, a 75.21–75.47% reduction. The change deletes three shader
modules, four compute pipelines, all length and scan dispatches, size and
hierarchy buffers, length-frontier buffers, and pass uniforms. Resolved-offset
bytes and the single padded emission frontier are executable profile fields.
These deterministic work reductions do not establish a latency distribution.

### 2026-07-31: Wasm atom tags become packed random-access nibbles

After redundant layout passes were deleted, the five-valued atom kind still
occupied one `u32` per atom. Section 7.4 now packs eight tags per word. The
mapping is injective over the source sum type, lanes decode in constant time,
and invalid spare tags cannot silently select signed-64 emission.

The frozen inputs fall by 8,668–714,344 logical bytes, or approximately 21.87%
of resolved atom input. Codex changes from 3,265,588 to 2,551,244 bytes. The
exact atom-input formula is an executable profile invariant; the existing
generated GPU/CPU differential exercises tag-word boundaries and all atom
variants. The full 496-test and six-target release gate passed. This is a
deterministic transfer/capacity reduction, not a latency claim.

### 2026-07-31: signed-64 high words become an adaptive frontier

The packed atom input still carried one high word for every atom, although only
signed-64 atoms can observe it. Frozen-plan measurement found zero signed-64
atoms in all six applications. Section 7.4 now selects the smaller of a dense
`4A` column and sorted `8S` `(atom_id, high_word)` pairs. Sparse lookup uses
binary search only in signed-64 lanes; the dense representation wins ties.

The choice proves \(H(A,S)=\min(4A,8S)\), so it cannot regress logical capacity.
Sparse and dense boundary regressions cover signed-64 extrema and compare every
byte to independent CPU emission. On the frozen \(S=0\) plans, editor removes
95,692 bytes and codex 816,396 bytes; resolved atom input falls by approximately
32%. Signed-64 count, high-word bytes, and total atom-input bytes are executable
profile fields. The full 498-test and six-target release gate passed. This is a
deterministic capacity result, not a latency claim.

### 2026-07-31: ranked low-word compression remains deferred

The remaining dense low-word column admits a rank/select representation: byte
values pack four per word, other values remain one word each, and one exclusive
byte rank is stored per eight atom tags. The exact break-even is \(B-\lceil
B/4\rceil>\lceil A/8\rceil\); all frozen targets satisfy it.

Derived savings are 3,236–245,336 bytes, or 13.94–16.21% of current atom input.
Unlike nibble tags or the empty signed-64 frontier, this representation adds two
bindings and up to seven tag comparisons to every emission lane. No
implementation or speedup is claimed. The alternative is recorded as a
performance hypothesis whose next admissible evidence is a counterbalanced
dense-versus-ranked kernel benchmark, not another capacity calculation.

### 2026-07-31: type closure gains a semantic oracle

The prior GPU boundary checked only that returned parent arrays were in range
and fully compressed. That structural condition did not establish the least
congruence property: a faulty kernel could over-unify unrelated terms. The type
stage now computes the canonical CPU closure specified in Section 7.5 and
requires exact semantic agreement before reporting GPU evidence. The existing
large-graph CPU closure was factored into the same oracle, so the two graph-size
paths no longer encode separate semantic definitions.

Compatible constructors, injective child decomposition, constructor clashes,
infinite types, deep graphs beyond the quadratic threshold, maximum-length union
chains, concurrent isolation, and generated CPU/GPU differentials are executable
validations. They do not prove the kernels; they ensure a corrupt result cannot
be accepted unless it also matches the independent oracle. An initial validator
also required identical generated-equation counts. The existing ADT/class
fixture supplied a counterexample: the CPU and GPU produced the same canonical
quotient through 41 and 42 explicit equations, respectively. That criterion was
removed because it compared proof schedules rather than unification semantics.

### 2026-07-31: signed comptime division matches Wasm

An edge probe found that `-2147483648 / -1` returned `2147483648` on the CPU
evaluator and `-2147483648` on the GPU. The former escaped the declared i32
domain; the latter reflected shader arithmetic rather than the residual Wasm
trap. Both evaluators now implement the Section 7.6 overflow judgment, and a
CPU/GPU regression checks the trap. This is executable conformance for the
identified boundary, not a proof for all bytecode sequences.

### 2026-07-31: comptime conditionals discard dead work

The prior bytecode lowering evaluated the condition and both branches before an
eager `select`. The counterexample `if 1 == 1 then 42 else 1 / 0` therefore
trapped in an expression whose source semantics returns 42. Forward branch
instructions now implement the Section 7.6 judgment on both CPU and GPU, the
obsolete eager-select opcode has been removed, and the counterexample completes
with 42 on both backends.

This also removes all arithmetic from the unselected branch. Static bytecode
size is unchanged up to two control instructions, while dynamic work changes
from the sum of both branch sizes to the selected branch size plus two. No
speedup is claimed without a branch-coherence distribution.

### 2026-07-31: comptime bytecode becomes a trusted boundary

The exported evaluators previously assumed their opcode arrays came from the
compiler. A malformed job without a halt could advance into the next job after
packing because the GPU stores job starts but not ends. Both evaluators now
apply the Section 7.7 forward-CFG and stack judgment first; the GPU path does so
before requesting a device. A two-job regression proves that malformed job zero
is rejected with its job, source, instruction, and target rather than reading
job one's valid bytecode.

### 2026-07-31: benchmark aggregation preserves real executions

The break-even harness previously measured CPU before GPU in every pair, making
backend indistinguishable from within-run order. It now uses complete,
even-counted CPU-first and GPU-first pairs and the conventional midpoint median.
The frontend harness previously assembled profiles from independent field
medians; such a vector need not correspond to any execution or preserve
accounting sums. It now uses three complete CPU-first/GPU-first warm pairs and
reports the observed profile nearest median total while retaining the scalar
median as the latency summary. Each mode's first observation resets parser state
independently. No historical timing was rewritten; future measurements use the
corrected design. Parser sub-stage vectors now follow the same observed-run rule
instead of combining independently selected initialization, classification,
syntax, and lowering times.

### 2026-07-31: scalar lowering checks its own type boundary

The main frontend inferred scalar types before comptime lowering, but the
exported scalar IR still admitted mixed-kind arithmetic, integer conditions, and
out-of-range constants. Lowering now derives the Section 7.6 kind at every node
and rejects those three counterexamples with source evidence before bytecode
exists. This duplicates a linear check at an explicit public trust boundary; it
does not replace general source inference.

### 2026-07-31: the type-solver cutoff is demoted from measurement to policy

The GPU solver comment claimed graphs above 64 terms were measured faster on the
linear CPU-closure path, but no retained experiment supported that crossover.
Section 7.5 now derives the exact pair-slot, allocation, pass, and lane bounds
that 64 enforces and labels latency optimality unverified. Compiler behavior is
unchanged; this review removes an unsupported empirical claim and specifies the
experiment required to tune it.

### 2026-07-31: validated stack height shrinks the comptime arena

The GPU comptime evaluator previously reserved 64 i32 stack words per job after
the validator had already derived a tighter maximum. Allocation now uses the
Section 7.7 batch maximum and reports it. `examples/all.hs` contains one scalar
job with derived height 2, reducing its stack buffer from 256 to 8 bytes
(96.875%, 32×) while CPU and GPU both return 42. The regression also checks an
8-byte arena for a branch-selective program whose dead arm reaches depth 2.
These exact capacities establish memory reduction, not a measurable latency
change for such a small job.

### 2026-07-31: type validation has one scalable boundary

The type stage previously retained a dense GPU constructor-decomposition and
transitive-reachability implementation for graphs of at most 64 terms. Every
frozen application bypassed it: term counts were 1,706 for Editor, 11,593 for
Codex, 773 for grep, 3,838 for tar, 99 for wav, and 86 for raytracer. Those jobs
already computed exact closure on the CPU and submitted its equality certificate
to one GPU union/compression command.

Section 7.5 now makes that boundary uniform. Removing the cutoff and four dormant
pipelines deletes 955 source lines. At the former cutoff, one constructor
frontier scheduled 57,344 lanes and dense reachability could schedule 262,144
more; the selected boundary schedules only the padded closed equalities and
terms. Frozen closed-equality counts are 3,838, 28,138, 1,292, 9,174, 264, and
292 in the same target order, each with one union round. Because the removed
branch ran for none of them, this is a scalability and specification result, not
a frozen latency improvement.

Compatible constructors, unrelated classes, child injectivity, clashes, cyclic
quotients, a 600-plus-term deep closure, maximum-length union, concurrent
isolation, and generated partitions are executable validations. Stable
sort/group plus sparse cycle analysis is the stated prerequisite for moving
closure itself to the GPU; dense pair enumeration is no longer an admitted
prototype. The full required-GPU gate passed 498 tests and compiled every frozen
application twice with byte-identical differential emission and engine
validation.

### 2026-07-31: type solving exposes its internal cost vector

The top-level GPU type duration previously combined flattening, CPU congruence
closure, WebGPU submission/readback, and quotient-cycle checking. The artifact
profile now reports those four child timings and the term, closed-equality,
constructor-comparison, and child-equation work volumes. Tests require the
children to fit inside the parent stage, closure to contain every source
equality, and generated unique equalities not to exceed proposed child
equations. A reused semantic artifact resets all new work fields to zero.

On the first six-warm-sample measurement, GPU union occupied 28.22–31.74 ms on
all targets. CPU closure ranged from 0.09 ms on raytracer to 131.60 ms on Codex;
Codex compared 41,971 constructor pairs and considered 83,484 child equations.
The observed profiles are executable measurements, not independent medians or a
causal speedup claim. They identify CPU closure and the constant
submission/readback floor as separate optimization problems.
The full required-GPU gate passed 498 tests and compiled every frozen target
twice with byte-identical differential emission and engine validation.

### 2026-07-31: constructor closure becomes an eager witness worklist

The measured CPU closure still rebuilt every representative and complete
constructor star until no new child equality appeared. Section 7.5 replaces
that global frontier with one constructor witness per union-find class. A class
merge compares two witnesses at most once, appends their child equations in
field order, and retains the lower-ID witness. A three-constructor regression
pins the resulting two-edge star, two comparisons, and two child proposals.

Deterministic work falls as follows:

| Target    | Comparisons before/after | Proposals before/after | Closed equalities before/after |
| --------- | -----------------------: | ---------------------: | -----------------------------: |
| Editor    |              4,176 / 711 |          8,035 / 1,367 |                  3,838 / 3,720 |
| Codex     |           41,971 / 5,276 |       83,484 / 10,494 |                28,138 / 27,467 |
| grep      |              1,264 / 266 |            2,528 / 532 |                  1,292 / 1,235 |
| tar       |           12,051 / 1,738 |         24,102 / 3,476 |                  9,174 / 9,067 |
| wav       |                  90 / 45 |               180 / 90 |                        264 / 264 |
| raytracer |                  36 / 36 |                72 / 72 |                        292 / 292 |

Observed CPU closure changed from 7.57 to 1.39 ms on Editor, 131.60 to 27.41 ms
on Codex, 1.67 to 1.07 ms on grep, 24.85 to 4.05 ms on tar, and 0.15 to 0.09 ms
on wav. Raytracer moved from 0.09 to 0.11 ms with identical work, below a useful
timing resolution. These are separate six-sample benchmark runs, not paired
confidence intervals; the exact work and certificate reductions are the
deterministic evidence. The full required-GPU gate passed 499 tests and compiled
all six frozen targets twice with byte-identical differential emission and
engine validation.

### 2026-07-31: production discards differential type validation

The decomposed profile proved that GPU type validation was a sequential
conformance experiment, not a payload transformation: CPU inference produced
the only types consumed downstream, while the GPU result was stored solely for
reporting. Production Haskell and Ducklang compilation now skip that call and
report `type=cpu`. The CLI `experiments` command still invokes the direct solver,
and all constructor, cycle, union, batching, and generated differential tests
remain.

For Editor, Codex, grep, tar, wav, and raytracer respectively, each compilation
removes 5,504, 39,168, 2,112, 12,928, 448, and 448 scheduled lanes; 43,408,
312,480, 16,064, 103,240, 2,904, and 3,024 logical buffer bytes; one command
submission; one mapped readback; and the CPU certificate derivation. The last
pre-removal observed stage durations were 33.08, 80.53, 34.02, 41.19, 30.22,
and 30.91 ms. Those observations measure the discarded stage, not a paired
end-to-end speedup.

The semantic argument is noninterference: successful validation had no consumer,
invalid source failed during prior CPU inference, and optional-mode
unavailability already discarded the result. Required mode continues to require
authoritative GPU Core rewriting and Wasm emission. Removing an unused validator
cannot alter accepted Wasm; the release gate checks this directly.

The post-removal sixteen-sample concurrent grep sweep reports throughput
GPU/CPU ratios of 1.520, 1.242, 1.130, 1.027, and 1.015 at 1, 2, 4, 8, and 16
jobs. No break-even is observed. Core/Wasm payload batches reach 1, 2, 3, 5,
and 8 jobs at those sizes; type batches no longer exist. Absolute CPU and GPU
times both rose materially from the preceding sweep, so cross-sweep latency
subtraction is not used as evidence.

The full gate passed 499 tests. Required-GPU differential samples were
377.01/263.53 ms for Editor, 1,100.74/919.52 ms for Codex, 138.70/135.17 ms for
grep, 203.80/208.31 ms for tar, 123.57/120.82 ms for wav, and 129.01/129.71 ms
for raytracer. Every pair emitted byte-identical Wasm and passed engine
validation. These pairs are release correctness evidence, not latency
distributions.

### 2026-07-31: production discards differential scalar GPU evaluation

Let \(E(e)\) be the general immutable constant semantics, \(B(e)\) scalar
bytecode lowering, \(S(B(e))\) the CPU bytecode semantics, and \(G(B(e))\) its
GPU implementation. Production Ducklang already required \(E(e)=S(B(e))\) for
every scalar comptime expression and replaced the source with \(E(e)\). The
additional condition \(S(B(e))=G(B(e))\) controlled only an error/report field:

```text
old(e) = if E(e) = S(B(e)) = G(B(e)) then lower(replace(e, E(e)))
new(e) = if E(e) = S(B(e))           then lower(replace(e, E(e)))
```

There is no path from the GPU value to replacement, specialization, Core, or
Wasm. Under the tested implementation-conformance obligation \(S(p)=G(p)\) for
admitted bytecode \(p\), the two partial functions therefore have equal
successful artifacts. Removing \(G\) changes implementation availability and the
location of differential bug detection, not the specified source semantics.
Direct fixed and generated CPU/GPU bytecode tests retain that evidence. This is
a backward slice from the emitted artifact in the sense of Weiser: the GPU
replay is outside the artifact's dependency slice [20].

For \(J>0\) jobs, \(I\) packed instructions, and validated maximum stack height
\(H\), the discarded GPU allocation is

```text
B_gpu = 8I + 20J + 4JH + 16 bytes
```

for opcode/operand columns, starts, results, statuses, stacks, parameters, and
readback. It also removes one command submission, \(J\) interpreter invocations,
at most the explicit per-job fuel in executed bytecode steps, and one mapped
readback. For \(J=0\), the implementation was already the identity before device
acquisition, so the removed physical work is zero.

Only Editor has a nonempty scalar batch in the six frozen applications: four
jobs. The other five report zero scalar jobs. A post-change five-sample run
observed enclosing comptime-stage medians of 2.85, 10.81, 0.27, 0.56, 0.04, and
0.08 ms for Editor through raytracer. Those stages include constant evaluation
and replacement and the observations are neither paired nor stable enough for a
latency claim. The proved dependency removal and exact work formula are the
supported result.

The full gate passed 499 tests. Required-GPU differential samples were
484.95/337.59 ms for Editor, 1,497.87/1,234.20 ms for Codex,
138.70/161.44 ms for grep, 260.31/263.73 ms for tar, 146.13/145.65 ms for
wav, and 146.31/148.17 ms for raytracer. Every pair emitted byte-identical Wasm
and passed engine validation. As above, these are correctness and budget
observations rather than a latency distribution.

### 2026-07-31: Core candidates follow the rewrite rule heads

The stable Core frontier previously admitted every `scalarBinary` operation
although the rule set contains only integer add-zero and multiply-one. Section
7.3 now compiles their common structural head into the CPU frontier. Completeness
is the direct implication \(M(S,o)\downarrow\Rightarrow H(S,o)\): every omitted
operation makes at least one necessary rule premise false. The CPU produces no
rule or replacement; exact constant payload matching and proposal construction
remain on the GPU, followed by independent CPU certificate validation.

Frozen candidate counts change from 169, 2,890, 34, 549, 43, and 103 to 15,
963, 3, 257, 4, and 0. Descriptor bytes fall from 303,040 to 99,360
(67.21%), while padded lanes fall from 3,968 to 1,536 (61.29%). Tar retains
its 24 proposals and the other five targets retain zero, establishing that the
filter removes only failed matches. A focused regression includes two positive
identities, one structurally admitted non-identity constant rejected by the GPU,
and a floating-point identity excluded by the head. These exact work counts and
CPU/GPU proposal equality are executable validations; latency remains
unmeasured.

The full gate passed 499 tests and compiled every frozen target twice with
byte-identical CPU/GPU emission and engine validation. Its samples were
966.91/757.85 ms for Editor, 2,989.80/3,037.06 ms for Codex,
344.93/347.40 ms for grep, 697.60/548.34 ms for tar, 316.84/355.19 ms for
wav, and 239.35/366.22 ms for raytracer. They establish conformance under the
observed heavy system load and are not used as performance evidence.

### 2026-07-31: backend labels denote physical execution

The rule-head frontier makes raytracer a Core identity job. The completed result
previously caused compiler orchestration to report `core=gpu` even though its
submission count and every GPU timing were zero. Section 7.3 now makes
provenance a disjoint result: `identity` is a host proof that the matcher domain
is empty, `gpu` requires a submitted nonempty frontier, and `cpu` is an explicit
CPU selection or optional fallback.

This is an accounting invariant rather than a semantic transformation. Focused
single and packed empty-frontier tests assert the identity label together with
zero submissions, bytes, lanes, and timings; a positive rewrite test asserts the
GPU label. The release contract expects `identity` only for raytracer and still
requires GPU Wasm emission for every target. The 499-test gate passed; its
required-GPU samples were 378.83/239.13 ms for Editor,
1,015.11/861.97 ms for Codex, 137.89/136.83 ms for grep,
198.51/194.43 ms for tar, 114.32/117.09 ms for wav, and
94.66/97.97 ms for raytracer. These are correctness observations, not a timing
claim.

### 2026-07-31: unobserved algebra does not enter the matcher

Three additional rules are semantically valid over the admitted modular integer
types:

```text
imul(x, 0) -> 0
isub(x, 0) -> x
idiv(x, 1) -> x
```

The first two are ring identities. For the third, the fixed divisor is nonzero
and signed division overflow occurs only at
\((-2^{w-1})/(-1)\), so division by positive one is total and returns its
dividend under the Wasm integer semantics [16].

An exact scan of every frozen pre-rewrite Flat Core snapshot under both CPU and
required-GPU policies found zero matches for each proposed rule. The current
rules found only Tar's 24 add-zero matches. Widening \(H\), the shader, the rule
ID domain, certificate validation, and generated tests would therefore add
implementation and scheduled-work surface without changing one frozen Core
module. The expansion is rejected under the cost model. It should be reopened
only when retained profiles show nonzero matches or a new workload establishes
a measured benefit. This is an empirical design rejection, not a claim that the
laws are unsound.

### 2026-07-31: resolved Wasm offsets use the least lossless width

Section 7.4 now derives offset width from the already-known final byte length.
If \(p_A\leq 65535\), all monotone boundaries lie in `u16`, so adjacent values
share one storage word; otherwise the existing u32 representation remains. The
choice adds no analysis pass, binding, dispatch, or synchronization.

Editor, grep, tar, wav, and raytracer select 16 bits; Codex's 226,134-byte
module selects 32. Frozen offset input falls from 1,041,816 to 929,108 bytes
(10.82%), and complete atom input falls from 2,213,848 to 2,101,140 bytes
(5.09%). A direct 65,535/65,536-byte boundary regression checks both
representations and every emitted byte. CPU/GPU byte differentials, packed
multi-job emission, engine validation, and the release gate remain the
executable soundness boundary. The required-GPU release gate passed 500 tests
and compiled every frozen target twice. Its paired samples in milliseconds were
Editor 1078.18/846.76, Codex 3395.07/2651.37, grep 441.34/333.38, Tar
445.61/502.97, wav 321.31/243.55, and raytracer 240.37/229.04. These
non-randomized correctness samples are recorded for reproducibility; the exact
capacity reductions do not establish a latency improvement.

### 2026-07-31: Wasm emission receives an isolated real-plan benchmark

The release gate and whole-compiler profiles cannot identify a small emitter
change beneath parser, specialization, Core, and validation variance. The new
benchmark constructs the final plan for each frozen application once, performs
one unrecorded warm emission, then samples only the boundary from host plan
analysis through mapped GPU readback and the final byte copy. It alternates
forward and reverse target order across 21 rounds to counterbalance monotone
thermal or temporal drift.

Every observation must equal the CPU-emitted artifact byte for byte. The report
couples median and p95 latency to atom count, input capacity, offset width,
output bytes, and scheduled lanes. These measurements do not separate host
packing, device execution, and readback, and alternating target order does not
remove autocorrelation; the benchmark therefore supports a paired
representation experiment but not a hardware-independent performance claim.

The first 21-round dense-low-word run measured median/p95 milliseconds of
27.99/28.74 for Editor, 37.09/38.36 for Codex, 27.01/27.18 for grep,
27.76/28.02 for Tar, 26.96/27.19 for wav, and 27.02/27.16 for raytracer. The
five small plans cluster near 27 ms despite a 9.66-fold atom-count range, which
is empirical evidence of a large fixed boundary cost, not a decomposition of
that cost. Codex adds roughly 10 ms at 204,099 atoms.

### 2026-07-31: ranked low words pass the paired experiment

Section 7.4 now admits the previously deferred rank/select representation under
an exact adaptive rule. For \(Q\) byte atoms, ranked storage is selected iff
\(Q-\lceil Q/4\rceil>\lceil A/8\rceil\); otherwise direct dense indexing
remains. The strict inequality proves that the adaptive representation never
increases logical low-word capacity, while dense wins equal-capacity ties.

All six frozen plans select ranked. Complete atom input changes from
155,504→125,784 bytes for Editor, 1,734,848→1,489,512 for Codex,
25,336→20,244 for grep, 144,312→117,996 for Tar, 16,104→12,868 for wav, and
25,036→19,728 for raytracer, reductions of 14.14–21.20%. The profile exposes
byte-atom count, selected layout, and low-word bytes, making the selector and
capacity equation executable invariants.

The counterbalanced 21-pair dense/ranked experiment measured median ratios of
1.0040, 0.9907, 0.9975, 0.9968, 1.0007, and 0.9992 in target order. This is
evidence of no material latency change on the measured adapter, not evidence of
a speedup or equivalence on other devices. Forced dense and ranked paths produce
the same bytes as the independent CPU emitter across all atom variants; packed
throughput tests mix both layouts in one submission. The required-GPU gate
passed 500 tests and compiled every target twice. Paired release samples in
milliseconds were Editor 334.16/229.35, Codex 949.72/788.76, grep
129.66/125.46, Tar 197.90/183.27, wav 115.33/110.38, and raytracer
99.43/92.84. They are correctness samples, not a latency comparison with an
earlier implementation.

### 2026-07-31: byte rank becomes a bit-parallel calculation

The first ranked decoder counted byte tags before a lane with a loop of zero to
seven iterations. Section 7.4 now derives all eight zero-nibble predicates at
once and uses `countOneBits` on the lane's prefix. The proof depends on byte
having physical tag zero and on four-bit tags; both are explicit representation
invariants.

This replaces divergent comparison work with a fixed expression and does not
change capacity, bindings, dispatches, or emitted bytes. Successive 21-pair
experiments measured ranked medians changing by -0.11% to -1.88% across the six
targets, but the implementations were not interleaved in one experiment, so
those values are advisory. Forced-layout differentials, generated plans, and
the mixed-layout batch regression remain the executable semantic evidence. A
direct forced-ranked regression enumerates all \(2^8=256\) byte/non-byte masks
for one kind word and compares the complete emission with the independent CPU
encoder. The exact 501-test required-GPU gate passed; paired target samples in
milliseconds were Editor 325.67/223.58, Codex 931.50/790.41, grep
125.21/127.96, Tar 191.43/181.10, wav 112.90/113.90, and raytracer
97.69/92.46.

### 2026-07-31: byte-rank width follows its observed maximum

The rank frontier still stored one `u32` per eight atoms although its maximum is
known during the mandatory byte-count pass. Section 7.4 now packs two ranks per
word iff the actual maximum stored boundary is at most 65,535. The proof is the
same injective fixed-width encoding used for output boundaries, but the
selection variables differ: output width depends on final byte length, while
rank width depends on the maximum exclusive byte count at a tag-word boundary.

Editor, grep, Tar, wav, and raytracer select 16 bits; Codex selects 32. Rank
input falls by 620–5,980 bytes on the five narrow plans and is unchanged on
Codex. Complete atom input becomes 119,804, 1,489,512, 19,268, 112,444,
12,248, and 18,764 bytes in target order. Profiles expose maximum rank, width,
and physical rank bytes. A direct boundary regression proves that maxima 65,535
and 65,536 select 16 and 32 bits and compares both outputs with the CPU oracle.
The post-change ranked/dense median ratios remain within 0.9771–1.0015; this is
no material measured regression, not a speedup claim. The required-GPU gate
passed 501 tests. Paired target samples in milliseconds were Editor
329.96/226.44, Codex 907.51/830.48, grep 123.49/128.36, Tar 191.72/175.71,
wav 120.78/111.96, and raytracer 97.33/93.22.

### 2026-07-31: kind packing commits once per physical word

The host tag packer still updated the typed array once per logical atom. Since
the eight four-bit destination masks in one word are pairwise disjoint, Section
7.4 now accumulates them in a scalar and commits only at a group boundary.
Formally, OR is associative and commutative on disjoint masks, so replacing
eight ordered read/modify/writes with one store preserves the packed word.

Frozen kind-column stores fall from 2,477–204,099 to 310–25,513, reductions of
87.48–87.50%. Allocated bytes, GPU bindings, scheduled lanes, and shader work
are identical. Successive isolated-emitter medians moved by less than 2.3%, but
the implementations were not interleaved and the boundary is dominated by
submission/readback, so no latency improvement is claimed. All 256 byte-tag
masks and every atom variant remain covered by GPU/CPU differentials. The exact
required-GPU gate passed 501 tests. Paired target samples in milliseconds were
Editor 344.68/227.20, Codex 951.33/803.70, grep 131.24/134.15, Tar
201.21/185.90, wav 115.76/108.91, and raytracer 96.58/92.49.

### 2026-07-31: packed u16 pairs commit once

The u16 output-offset and byte-rank packers still used one typed-array
read/modify/write per logical value. Their low and high half-word masks are
disjoint, so the same local-accumulation lemma as kind packing applies.
Section 7.4 now assigns each completed pair once.

This removes 1,394–13,457 derived host stores from the five narrow frozen
plans. Codex's two u32 vectors remain zero-copy/direct and remove no work.
Capacity, transfer, bindings, GPU instructions, and output bytes are unchanged.
The exact offset-width, rank-width, 256-mask, and CPU/GPU byte differentials
exercise odd and even physical-word tails. The post-change ranked/dense median
ratios are 0.9974–1.0026, detecting no material latency change. The required-GPU
gate passed 501 tests. Paired target samples in milliseconds were Editor
333.60/232.86, Codex 931.34/781.89, grep 132.36/128.21, Tar 196.53/178.44,
wav 110.98/109.15, and raytracer 98.65/91.83.

### 2026-07-31: packed bytes commit once per physical word

The ranked byte stream was the last packed host column still using one
read/modify/write per logical value. Its four byte masks are pairwise disjoint,
so Section 7.4 now accumulates one scalar and assigns it when the group is full
or the stream ends.

Frozen byte-stream stores fall from 1,493–115,797 to 374–28,950, removing
1,119–86,847 derived stores. Capacity, transfer, bindings, GPU work, and output
are unchanged. The exhaustive 256 tag masks include every possible packed-byte
tail position, while the CPU/GPU differential checks the values. Post-change
ranked/dense median ratios were 0.9731–1.0071; the fixed-cost boundary again
hides any small host effect, so no latency improvement is claimed. Required-GPU
gate passed 501 tests. Paired target samples in milliseconds were Editor
334.96/230.85, Codex 971.32/805.07, grep 130.73/130.47, Tar 192.80/180.05,
wav 114.29/114.13, and raytracer 94.42/93.19.

### 2026-07-31: byte lanes stop reading an unobserved boundary

The one-pass emitter computed every atom's dynamic interval width before
dispatching on its tag. Byte width is definitionally one, so its end boundary
and subtraction cannot affect byte emission. Section 7.4 now performs that work
only after the byte lane returns.

Frozen boundary reads fall by 28.09–31.32%, from \(2A\) to \(2A-Q\); 1,493 to
115,797 lane-local subtractions disappear as well. Capacity, transfer,
dispatches, and output are unchanged. The exhaustive byte-mask regression and
all CPU/GPU plan differentials validate the early return. The 21-round
post-change medians were 27.87/28.01 ms for Editor dense/ranked and
35.18/35.29 ms for Codex; the fixed boundary hides any latency effect, so no
speedup is claimed. The required-GPU gate passed 501 tests. Paired target
samples in milliseconds were Editor 355.83/223.95, Codex 907.54/794.40, grep
117.55/122.43, Tar 183.14/173.97, wav 109.50/111.68, and raytracer
92.28/96.82.

### 2026-07-31: Wasm statistics become a product fold

GPU column preparation traversed the complete atom sequence once to count bytes,
signed-64 values, and maximum byte rank, immediately after analysis traversed
the same sequence for encoded sizes. Section 7.4 now computes the product of
those prefix folds during the mandatory size pass.

This deletes one \(A\)-atom traversal without moving validation or changing
which facts are trusted. The six frozen plans remove 260,448 host atom visits;
predicate counts, allocation, transfer, GPU work, and bytes remain identical.
The public analysis regression now exposes the three statistics, while profile
equations and all emitter differentials consume them. The post-change 21-round
medians were 28.07/28.22 ms for Editor dense/ranked and 35.65/36.19 ms for
Codex. The fixed boundary and run-to-run drift dominate the removed iterator
overhead, so no latency improvement is claimed. The required-GPU release gate
passed 501 tests and compiled every frozen target twice. Its advisory samples in
milliseconds were Editor 335.21/231.17, Codex 936.04/806.90, grep
130.41/129.73, Tar 197.20/179.83, wav 113.49/110.44, and raytracer 95.57/95.01.

### 2026-07-31: Wasm validation and sizing become one inspection

GPU analysis still traversed all \(A\) atoms once for validation and again for
scalar sizing. These folds share an immutable domain and have no cross-atom
dependency. Section 7.4 now defines their product; length sizing remains
topological and separate.

The GPU path removes another 260,448 atom visits over the frozen batch, one per
atom in each target. It also removes a second atom-kind dispatch. Validation-only
CPU callers allocate no size column, but execute one sink-presence branch for
each scalar atom; this is the admitted local cost. A regression checks that
analysis still rejects an invalid byte before sizing it. Focused validation,
compiler, and generated CPU/GPU differential tests pass. Post-change 21-round
dense/ranked medians were 27.66/27.65 ms for Editor and 33.87/33.58 ms for
Codex. These samples are consistent with discarded work but do not isolate it
from run-to-run drift. The required-GPU release gate passed 502 tests and
compiled every frozen target twice. Its advisory samples in milliseconds were
Editor 341.45/224.94, Codex 955.82/840.71, grep 130.55/124.65, Tar
196.14/177.78, wav 115.04/113.19, and raytracer 100.00/90.38.

### 2026-07-31: Wasm length sizing uses adaptive sparse prefixes

Direct length sizing reread every dependency range after validation had already
traversed it. A dense prefix per dependency level initially appeared attractive
but loses on every frozen plan: two levels cost \(2A\) prefix visits versus
only 1.86–1.98\(A\) direct range visits, plus an \(A+1\)-word buffer. Rebuilding
a sparse prefix by level instead has an \(O(JK)\) deeply nested counterexample.

Section 7.4 now derives an adaptive alternative. A scalar prefix plus a Fenwick
tree over resolved length positions answers each range with prefix differences.
The direct path remains available, and the conservative selector admits sparse
sizing only when \(A+K(1+5\lceil\log_2(K+1)\rceil)<D\). Both sides and the
selected estimate are exposed in compiler profiles and the emitter benchmark.

All six frozen plans select sparse sizing. Their combined model falls from
511,136 dependency reads to 283,845 prefix/search/tree operations, a 44.46%
reduction. A focused counterexample proves that a level-two range counts a
resolved level-one length inside its interval but excludes one outside it;
another fixture selects the direct path. Focused compiler, profile, and
generated CPU/GPU differentials pass. Post-change 21-round dense/ranked medians
were 27.92/27.88 ms for Editor and 36.61/36.65 ms for Codex. The modeled host
reduction is below run-to-run variation at the complete emitter boundary, so no
latency claim is made. The required-GPU release gate passed 503 tests and
compiled every frozen target twice. Its advisory samples in milliseconds were
Editor 328.50/243.97, Codex 961.70/827.96, grep 129.25/123.81, Tar
226.99/174.06, wav 110.53/112.98, and raytracer 94.62/92.01.

### 2026-07-31: CPU Wasm validation produces its encoding

The independent CPU oracle validated \(A\) atoms, revisited them to encode
scalars, evaluated \(D\) length dependencies, revisited all \(A\) encodings to
sum their sizes, and revisited them again to copy bytes. Validation and scalar
encoding are a product fold, while scalar and topological length folds can
accumulate the final size.

Section 7.4 now derives the resulting \(4A+2D\) to \(2A+2D\) reduction. Across
the frozen batch, 520,896 atom visits disappear. The direct \(D\)-range
evaluation intentionally remains independent of adaptive GPU-boundary sizing,
preserving the differential's value as an oracle. The permanent emitter
benchmark now includes 101 CPU-oracle samples with ten warmups and alternating
target order. Post-change medians in milliseconds were Editor 1.139, Codex
15.155, grep 0.170, Tar 1.059, wav 0.100, and raytracer 0.161. A separately
ordered pre-change sample is not a controlled pair, so no latency change is
claimed. Focused tests pass; one Deno process reported all assertions passing
before an exit-139 WebGPU shutdown. A clean rerun of the full required-GPU gate
passed 503 tests and compiled every frozen target twice. Its advisory samples in
milliseconds were Editor 335.64/236.97, Codex 973.23/969.82, grep
138.68/130.72, Tar 238.84/190.68, wav 117.17/118.74, and raytracer
99.02/139.86.

### 2026-07-31: validated scalars skip duplicate LEB checks

Fusing inspection with CPU encoding exposed a remaining proof duplication:
inspection checked each non-byte scalar's range, then the public LEB entry point
checked it again. The encoder body is now factored behind an internal
validated-domain function. Public callers still cross the checked boundary, and
length payloads still use it because their values are derived after inspection.

The frozen CPU-oracle batch removes 111,472 duplicate scalar checks: 9,893
Editor, 87,954 Codex, 1,532 grep, 9,707 Tar, 970 wav, and 1,416 raytracer.
Signed-64 has no frozen occurrence but remains covered by the boundary test.
The post-change 101-sample CPU medians were 1.147 ms Editor, 14.801 Codex,
0.171 grep, 1.016 Tar, 0.100 wav, and 0.158 raytracer. Comparison with the
immediately preceding identical protocol resolves no material latency change,
so none is claimed. Focused scalar-boundary and CPU/GPU differential tests pass;
the required-GPU release gate passed 503 tests and compiled every frozen target
twice. Its advisory samples in milliseconds were Editor 355.69/243.04, Codex
1112.49/826.90, grep 132.29/137.33, Tar 252.61/189.81, wav 111.19/115.47, and
raytracer 99.07/99.23.

### 2026-07-31: validated length levels eliminate presence checks

The CPU oracle checked every range entry for an unresolved encoding after the
plan validator had already proved strict dependency-level descent. Scalars are
encoded in inspection, and induction over sorted levels proves every referenced
length encoding exists before its consumer is sized.

The interior presence branch is removed. The frozen batch eliminates 511,136
checks: 45,418 Editor, 403,062 Codex, 7,286 grep, 43,479 Tar, 4,609 wav, and
7,282 raytracer. A new public-boundary regression rejects a same-level length
dependency with both atom IDs and the invalid level; valid nested plans and
generated CPU/GPU differentials pass. Post-change 101-sample CPU medians were
1.251 ms Editor, 17.413 Codex, 0.198 grep, 1.120 Tar, 0.102 wav, and
0.163 raytracer. Run-to-run variation is larger than the removed predicate
cost, so no latency improvement is claimed. Required-GPU release evidence
passed 504 tests and compiled every frozen target twice. Its advisory samples in
milliseconds were Editor 329.86/225.05, Codex 966.56/820.40, grep
131.34/130.68, Tar 232.03/182.11, wav 119.89/115.77, and raytracer
96.45/89.32.

### 2026-07-31: byte encodings are canonical finite values

The CPU oracle allocated one fresh singleton array for every byte atom even
though byte encoding is the immutable function \(v\mapsto[v]\) on a 256-element
domain. Section 7.4 now treats these encodings as canonical values in a private
table.

One frozen batch removes 148,419 per-emission arrays—13,895 Editor, 115,797
Codex, 2,348 grep, 12,474 Tar, 1,493 wav, and 2,412 raytracer—while adding 256
persistent arrays once. The first batch therefore has 148,163 fewer allocations,
and subsequent batches remove all 148,419. CPU/GPU byte differentials prove the
sharing is unobservable. Post-change 101-sample CPU medians were 1.077 ms
Editor, 14.294 Codex, 0.169 grep, 0.969 Tar, 0.103 wav, and 0.199 raytracer.
The mixed changes do not resolve a latency effect. Required-GPU release evidence
passed 504 tests and compiled every frozen target twice. Its advisory samples in
milliseconds were Editor 349.09/243.67, Codex 948.26/839.47, grep
145.16/136.63, Tar 255.35/197.77, wav 126.10/124.12, and raytracer
105.14/98.83.

### 2026-07-31: canonical bytes cover one-byte LEB values

The existing private byte table also denotes every one-byte unsigned and signed
LEB encoding. Validated internal scalars now reuse it for unsigned 0–127 and
signed −64–63 values. Public encoders remain fresh-array APIs, so canonical
storage is not exposed to mutation.

This removes another 85,328 arrays per frozen CPU-oracle batch: 9,399 Editor,
66,201 Codex, 1,530 grep, 5,835 Tar, 950 wav, and 1,413 raytracer, with no new
persistent table. In an immediately consecutive identical 101-sample protocol,
all CPU medians fell: Editor 1.077→0.850 ms, Codex 14.294→8.936 ms, grep
0.169→0.142 ms, Tar 0.969→0.856 ms, wav 0.103→0.088 ms, and raytracer
0.199→0.138 ms. This is empirical evidence consistent with the allocation
model, not a counterbalanced causal estimate. Focused LEB boundaries and
CPU/GPU differentials pass. The required-GPU gate passed 504 tests and compiled
every frozen target twice. Its advisory samples in milliseconds were Editor
333.55/225.53, Codex
906.47/807.11, grep 128.21/132.47, Tar 232.97/180.96, wav 115.42/109.62, and
raytracer 93.73/89.05.

### 2026-07-31: multi-byte LEB memoization is rejected

An emission-local memoization experiment shared repeated multi-byte encodings
through separate unsigned, signed-32, and signed-64 maps; derived length values
shared the unsigned map. It would have reduced 26,701 dynamic encodings to
3,003 distinct encodings over the frozen batch:

| Target    | Fresh encodings | Distinct encodings | Avoided |
| --------- | --------------: | -----------------: | ------: |
| Editor    |             629 |                193 |     436 |
| Codex     |          22,101 |              1,255 |  20,846 |
| grep      |              19 |                  9 |      10 |
| tar       |           3,892 |              1,515 |   2,377 |
| wav       |              34 |                 19 |      15 |
| raytracer |              26 |                 12 |      14 |

Despite the 88.75% aggregate hit rate, the immediately consecutive
identical-protocol CPU medians regressed on every target: Editor
0.850→1.523 ms, Codex 8.936→13.856 ms, grep 0.142→0.259 ms, Tar
0.856→1.658 ms, wav 0.088→0.161 ms, and raytracer 0.138→0.234 ms. The
increases range from 55.05% to 93.82%. Section 7.4 now records the applicable
cost inequality. The maps were removed rather than retaining a
representation-level optimization contradicted by end-to-end evidence.

The first implementation also generalized the 256-entry byte table without
checking the one-byte unsigned domain. It encoded unsigned 128 as `[128]`
instead of `[128, 1]`; five focused tests failed, including engine validation
and a GPU differential. Adding the \(v<128\) guard made all 84 focused tests
pass and allowed the performance experiment to measure the intended
memoization. The rejected implementation left no production code change.

### 2026-07-31: CPU Wasm emission writes bytes directly

The retained CPU oracle still represented every encoded atom as an array
reference. Length resolution needs widths rather than byte arrays, so Section
7.4 now derives a smaller sufficient statistic: one byte of width per atom and
one eight-byte payload width per length atom. Validation assigns every length
atom its stable source-order rank. The same rank removes the sparse
GPU-boundary analysis's atom-to-position map.

The CPU oracle retains exactly \(2A+2D\) atom/range visits. It replaces the
\(A\)-entry reference vector, 26,701 frozen dynamic encoding arrays, and
256-entry canonical table with \(A+8K=264{,}904\) typed temporary bytes across
the frozen batch. One final source-order pass writes all \(B\) bytes directly
at a rolling offset. Existing LEB-boundary, nested-length, engine-validation,
and generated CPU/GPU differential tests establish executable agreement for 84
focused cases.

Stable ranks also change sparse length sizing from
\(A+K(1+5\lceil\log_2(K+1)\rceil)\) to
\(A+5K\lceil\log_2(K+1)\rceil\). Frozen selected work falls by another 557
operations, from 283,845 to 283,288, and sparse-only storage loses its
\(K\)-entry position map. The direct/sparse boundary fixture now checks the
revised estimate.

The 101-sample CPU medians are Editor 0.616 ms, Codex 5.697 ms, grep
0.115 ms, Tar 0.585 ms, wav 0.070 ms, and raytracer 0.095 ms. Relative to the
last retained array-emitter run under the same protocol, all six are lower by
19.22–36.24%. This is empirical evidence consistent with the allocation and
write model, not a counterbalanced causal estimate. The required-GPU gate
passed 504 tests and compiled every frozen target twice. Its advisory samples
in milliseconds were Editor 354.60/224.22, Codex 939.47/921.55, grep
139.67/135.81, Tar 205.56/204.96, wav 123.86/118.93, and raytracer
117.08/101.31.

### 2026-07-31: compiler-owned prelude syntax is process-shared

The frontend benchmark exposed a 50 ms `localImportResolution` floor on the
small targets and 161 ms on Codex. Work profiles showed that independent
compilations reparsed the same immutable bundled preludes: the six warm targets
performed 23 bundled syntax analyses even though the compiler owns a fixed
23-file prelude set.

Section 9 now defines a bounded content-addressed cache for only those
compiler-owned sources. One current AST per canonical prelude path is shared
across independent compilation caches. The source hash must match; a changed
source replaces the old entry. Custom prelude directories and user modules are
never admitted to the process cache. An executable regression compiles the same
prelude import without a session and requires the second artifact to report zero
syntax analyses, at least one syntax reuse, and byte-identical Wasm.

In the consecutive six-sample frontend protocol, warm bundled analyses fell
from 23 to zero. Codex still analyzed its two ordinary local modules.
`localImportResolution` fell from 25.79→1.41 ms for Editor,
160.90→24.53 ms for Codex, 50.60→0.81 ms for grep, 51.00→0.74 ms for Tar,
51.80→0.81 ms for wav, and 50.73→0.44 ms for raytracer. End-to-end CPU
medians fell respectively by 18.64%, 20.64%, 77.36%, 41.32%, 87.26%, and
81.60%. These are consecutive identical-protocol observations, not a
counterbalanced causal estimate. The required-GPU gate passed 505 tests and
compiled every frozen target twice. Its advisory samples in milliseconds were
Editor 402.79/228.33, Codex 1016.46/699.71, grep 72.24/74.98, Tar
140.71/133.29, wav 63.75/62.70, and raytracer 45.44/43.87.

### 2026-07-31: contextual classification stops slicing every position

Section 9 specifies the contextual classifier as a length-preserving state
transduction and derives its candidate dispatch. The production scan now uses
sticky current-index patterns and only examines backward dotted-field and
record context when the current character can begin those forms. It preserves
the old pattern order and the exact record-prefix predicate.

In 31 warm observations of the 25,256-character Editor root after one unrecorded
warmup, contextual classification fell from 18.476 to 4.670 ms and complete
syntax work fell from 25.349 to 11.845 ms. Generated parser execution was
unchanged at 6.901 versus 6.917 ms; AST lowering changed from 10.077 to
10.775 ms and is treated as run noise. These are consecutive measurements from
separate worktrees under one protocol, not a counterbalanced causal estimate.
The deterministic claim is removal of the two unconditional substring families
whose logical extent was \(n^2\).

The six-sample alternating frontend protocol then measured CPU medians of
103.66, 506.72, 13.26, 66.40, 7.55, and 11.37 ms for Editor, Codex, grep, Tar,
wav, and raytracer. Relative to the immediately preceding run, these are
reductions of 9.36%, 1.59%, 9.35%, 2.52%, 2.26%, and 1.98%. The complete
vendored/frozen syntax and corpus-contract suite passed 94 tests before the
release gate. The required-GPU gate passed all 505 tests and compiled every
frozen target twice. Its advisory samples in milliseconds were Editor
305.95/184.75, Codex 815.87/609.12, grep 69.84/70.94, Tar 137.94/123.68, wav
62.89/61.86, and raytracer 45.85/40.59.

### 2026-07-31: arrow spelling filters context work

The remaining contextual-classifier term came from evaluating arrow context
before establishing that the current identifier was followed by `=>`. Section
9 factors recognition into pure lexical and context predicates and derives the
cost inequality for commuting that conjunction. The implementation now tests
the anchored spelling first for both named and discarded parameters.

Against the immediately preceding 31-sample Editor-root protocol, contextual
classification fell from 4.670 to 1.455 ms, another 68.84%, and complete syntax
fell from 11.845 to 8.613 ms, another 27.29%. Generated parser execution remained
6.917 versus 7.033 ms. The exact complete-prefix extent falls 98.24%, from
10,153,696 to 178,601 characters; this is the deterministic work claim. The
focused syntax and corpus suites passed all 94 tests.

The subsequent six-sample alternating frontend run measured CPU/GPU medians of
98.09/153.37 ms for Editor, 513.01/587.65 for Codex, 13.72/70.24 for grep,
66.26/122.54 for Tar, 7.43/64.31 for wav, and 11.72/42.18 for raytracer.
Only the isolated classifier comparison supports attribution; the mixed
end-to-end changes are run noise outside the optimized stage. The required-GPU
gate passed all 505 tests and compiled every target twice. Its advisory samples
in milliseconds were Editor 332.50/195.31, Codex 894.57/679.17, grep
73.22/75.66, Tar 137.88/140.06, wav 63.89/63.88, and raytracer 44.88/43.54.

### 2026-07-31: specialization environments become scoped maps

A 250-microsecond V8 CPU profile over four Codex compilations attributed
311.00 ms total and 73.75 ms self time to block rewriting. Section 6.3 derives
the scoped rollback environment from globally unique resolved IDs. Production
now records prior entries, inserts locals into the active map, and restores the
entries in reverse order in `finally` instead of cloning all visible entries at
each block. Prior-value restoration admits nested re-entry of one source body.

The deterministic ledger reports rewritten blocks/avoided entry copies of
827/57,311 for Editor, 6,828/412,890 for Codex, 93/1,267 for grep, 480/22,293
for Tar, 27/210 for wav, and 47/492 for raytracer. The frozen batch therefore
avoids 494,463 counterfactual `Map` entry copies.

Eleven warm CPU observations after one unrecorded warmup were run in parallel
against a detached `d7357e7` worktree under the same Codex protocol.
Specialization rewrite medians fell from 86.252 to 74.484 ms (13.64%) and the
whole pre-comptime specialization stage from 119.946 to 108.074 ms (9.90%).
Total compilation changed from 553.30 to 549.18 ms (0.74%); lifting and
accounting moved in the opposite direction, so no larger end-to-end attribution
is claimed. A public profile regression requires nonzero block and avoided-copy
counts on a specializing nested closure. The required-GPU gate passed all 506
tests and compiled every target twice. Its advisory samples in milliseconds
were Editor 315.98/179.74, Codex 823.34/612.39, grep 72.44/68.78, Tar
133.62/123.21, wav 63.45/61.68, and raytracer 44.11/40.61.

### 2026-07-31: specialization ledger counts each immutable root once

Section 6.3 defines node counting as a pure DAG fold and derives pass-local
identity memoization. Production now computes each root count once, then
projects input, demanded, rewritten, and residual totals from those exact
counts. A public profile regression requires nonzero cache hits and avoided
node visits.

The frozen target profiles report cache hits/avoided logical node visits of
330/14,038 for Editor, 99/32,243 for Codex, 18/1,416 for grep, 67/8,843 for
Tar, 27/539 for wav, and 21/917 for raytracer. The batch removes 57,996 repeated
logical node visits without changing any retention count.

Twenty-one warm Codex CPU observations after one unrecorded warmup ran in
parallel against detached commit `f8a263d`. Median ledger accounting fell from
6.953 to 4.287 ms, a 38.35% reduction. The whole pre-specialization stage moved
108.989→109.728 ms and is unresolved; total compilation moved
555.87→548.51 ms but is not attributed because non-accounting stages varied.
The required-GPU gate passed all 506 tests and compiled every target twice. Its
advisory samples in milliseconds were Editor 312.93/193.50, Codex
831.60/597.99, grep 71.69/68.78, Tar 129.31/124.40, wav 62.21/62.21, and
raytracer 43.18/42.43.

### 2026-07-31: lazy child-list copying is rejected

The shared expression rewriter was changed experimentally from native `map`
plus an identity scan to a copy-on-first-change loop. The alternative preserves
the same immutable parent and child identities and avoids a transient list when
no child changes, but introduces an interpreted branch at every list element.
Section 6.3 records the engine-dependent break-even inequality.

Twenty-one warm Codex CPU observations after one unrecorded warmup ran in
parallel against detached commit `7aed752`. Median specialization rewrite time
regressed from 72.666 to 75.320 ms (3.65%), while function lifting was unchanged
at 24.226 versus 24.158 ms. Complete compilation regressed from 526.56 to
537.83 ms (2.14%). The production code was restored; this review changes only
the recorded rejected alternative.

### 2026-07-31: product direct-call classification is rejected

Closure lifting experimentally replaced one `isOnlyDirectlyCalled` traversal per
nested function with a product traversal collecting all symbols used outside
direct-callee positions. Section 6.3 records the equivalence and asymptotic cost.

The unguarded draft scanned blocks with no eligible function and increased the
21-sample Codex lifting median from 24.481 to 38.141 ms, a 55.80% regression.
Restricting the product traversal to blocks containing a non-generated function
restored lifting to 25.125 ms versus a concurrent detached-`3ae5dc2` median of
25.083 ms (+0.17%). Pre-specialization was likewise unresolved at
108.660 versus 108.547 ms. The production implementation was restored; current
corpus fan-out does not justify the product set.

### 2026-07-31: empty accepted Core batches preserve identity

The structural Core frontier is only a necessary rule-head filter. Five frozen
targets have nonempty or independently classified frontiers but accept no
rewrite, yet both CPU rewrite and validated GPU commit rebuilt and revalidated
the complete flat package. Section 7.3 now defines batch application as an
empty fold: `commit(S, []) = S`. This is a semantic identity, not a
corpus-specific shortcut.

The implementation returns the already-validated snapshot object after proposal
checking and conflict resolution find no acceptance. This removes at least
\(B_{\mathrm{flat}}+5O+8V\) typed-array allocation and the duplicate-package
validation while preserving initial validation and matcher work. A regression
checks reference identity, and backend-neutral profile fields report proposal
and acceptance counts.

In an alternating 21-pair Codex CPU experiment against detached commit
`d3def76`, median Core rewrite time changed from 74.181 to 34.773 ms (-53.13%)
and complete compilation from 527.788 to 489.262 ms (-7.30%). Core inflation,
which is outside the change, moved from 34.185 to 35.473 ms. Codex has 12,956
operations, 963 GPU structural candidates, and exactly zero proposals and
acceptances. The stage result is empirical evidence for the removed work; the
identity law and zero acceptance count are executable properties.

The required-GPU gate passed all 507 tests and compiled every frozen target
twice with byte-identical CPU/GPU emission and engine validation. Its advisory
samples in milliseconds were Editor 300.63/182.64, Codex 841.02/589.22, grep
72.53/69.16, Tar 139.02/134.32, wav 63.49/63.24, and raytracer 44.92/41.65.

### 2026-07-31: unchanged flat Core reuses its structured witness

After empty commit began preserving object identity, the compiler still
inflated the unchanged flat package immediately after validation had already
inflated it once. Section 7.2 derives a constant-work certificate from the
round-trip and immutability laws: if rewrite returns the exact package produced
by `flatten(M)`, the next structured Core is \(M\). A non-identical package
continues through ordinary inflation.

A public profile regression requires zero Core-inflation time together with
zero proposals and acceptances. An alternating 21-pair Codex CPU experiment
against detached commit `2511932` changed median inflation from 31.863 ms to
exactly 0 and complete compilation from 451.776 to 424.521 ms (-6.03%). Core
rewrite was stable at 33.367 versus 33.261 ms, and downstream Wasm planning
moved from 50.852 to 52.447 ms. The identical 226,134-byte output and unchanged
rewrite stage are negative controls; the full gate remains the integration
boundary.

The required-GPU gate passed all 508 tests. Its two byte-identical, validated
samples in milliseconds were Editor 283.09/170.11, Codex 754.22/536.71, grep
70.24/70.17, Tar 140.31/129.36, wav 62.45/60.98, and raytracer 44.21/42.18.
They are correctness observations rather than a second timing experiment.

### 2026-07-31: CPU Core rewrite is decomposed

The enclosing CPU rewrite timer could no longer distinguish matcher work from
flat-package validation. The result and artifact profiles now expose four
disjoint intervals: input validation, proposal matching, conflict resolution,
and rebuild plus successor validation. A containment regression prevents their
sum from exceeding the enclosing stage, and zero accepted batches report
exactly zero rebuild time.

Seven warm observations after one unrecorded warmup show that input validation
accounts for 34.708 of Codex's 34.860 ms median rewrite stage (99.56%).
Matching takes 0.147 ms, conflict resolution 0.002 ms, and rebuild zero. Tar is
the counterexample: its 24 accepted rewrites divide the 10.059 ms stage between
4.993 ms input validation and 4.825 ms rebuild, with 0.028 ms matching and
0.019 ms conflict resolution. These are empirical medians; the interval
containment and zero-rebuild identity are executable invariants.

The measurement falsifies CPU matcher parallelism as the next material target
for the frozen corpus. The next review must instead justify either a cheaper
flat validator or a stronger by-construction trust boundary; simply deleting
validation would weaken the accepted-package theorem.

The 508-test required-GPU gate passed with the decomposed profile. Its paired
correctness samples in milliseconds were Editor 286.78/173.54, Codex
743.25/523.55, grep 72.04/67.27, Tar 136.11/129.56, wav 62.60/60.85, and
raytracer 43.84/40.63.

### 2026-07-31: flat Core gains construction provenance

The decomposed profile showed that complete re-inflation validation dominated
CPU rewrite even though the flat package was produced immediately beforehand
from validated structured Core. Section 7.2 now gives flat trust two explicit
derivations: validation for arbitrary packages and construction for the output
of the module-private smart constructor. The wrapper records which derivation
was used; CPU rewrite accepts either trusted form, while its raw public entry
still validates.

This change does not assert that all typed arrays are valid. It narrows trust to
one validated structured input and one deterministic flattening implementation,
under exclusive ownership. The malformed raw-package tests continue through
full validation. A construction/validation provenance regression, round trips,
generated differentials, deterministic columns, semantic execution, and the
release gate are executable evidence for the constructor lemma.

In an alternating 21-pair Codex CPU experiment against detached commit
`79104b6`, median Core rewrite changed from 33.599 to 0.110 ms (-99.67%) and
complete compilation from 422.959 to 394.878 ms (-6.64%). Flat construction was
stable at 34.893 versus 35.300 ms, rule matching at 0.074 versus 0.095 ms, and
Wasm planning at 54.398 versus 54.604 ms. Every observation emitted the same
226,134-byte module. Seven-sample frozen medians report exactly zero input
validation for every CPU target; Tar still spends 6.505 ms rebuilding and
validating its successor after 24 accepted rewrites.

The 508-test required-GPU gate passed after the trust split. Its paired
byte-identical, engine-valid samples in milliseconds were Editor 287.80/172.28,
Codex 769.42/525.35, grep 71.03/69.57, Tar 138.07/130.93, wav 63.31/61.89, and
raytracer 43.20/40.97.

### 2026-07-31: GPU batching preserves flat-Core provenance

The first smart-constructor change accelerated only CPU rewrite; compiler GPU
jobs discarded their construction wrapper at the queue boundary and re-earned
trust by complete inflation validation. Section 7.3 now models queue input as
the disjoint sum `raw | trusted`. Every identity filter, mixed batch, and
capacity split preserves that tag. Raw public calls still validate and report
validation provenance; compiler jobs report construction provenance.

An alternating 21-pair Codex required-GPU experiment against detached commit
`8076dff` changed median GPU Core-pass time from 62.562 to 27.871 ms (-55.45%)
and complete compilation from 508.445 to 472.598 ms (-7.05%). GPU execution was
stable at 25.026 versus 25.070 ms, transfer at 0.174 versus 0.187 ms, commit at
0.008 versus 0.006 ms, and Wasm emission at 36.321 versus 37.065 ms. Every
observation emitted the same 226,134-byte module.

The timing delta is consistent with removal of the previously measured
34.708-ms Codex flat validation, while stable GPU execution is a negative
control. Provenance assertions, malformed raw input, mixed concurrency,
generated proposal equality, and the release gate are executable evidence.

The 508-test required-GPU gate passed. Its paired byte-identical, engine-valid
samples in milliseconds were Editor 270.61/175.51, Codex 684.59/510.98, grep
69.97/68.66, Tar 146.07/127.98, wav 62.10/62.04, and raytracer 43.31/42.54.

### 2026-07-31: Core dispatch uses an exact useful-work frontier

The structural rule-head frontier left five frozen targets submitting a GPU
command that returned no proposals. Section 7.3 now defines the physical
frontier as the exact matcher domain. The host matcher is already the
certificate oracle and CPU fallback; it retains only matching operation IDs and
discards its proposal payload. The GPU independently recomputes each retained
match, and only its checked proposals reach commit.

This preserves GPU authority while applying the project's discard-before-
parallelize rule. A host-empty exact frontier is a proof that no optimization
exists, so it has no descriptor, adapter request, submission, readback, or GPU
backend label. Tar's 24 matches still execute on the GPU; the other five frozen
targets become Core identity jobs. The positive GPU regression now has two exact
candidates rather than one additional known failure, while generated CPU/GPU
proposal equality remains unchanged.

An alternating 21-pair Codex required-GPU experiment against detached commit
`e1a739f` changed median Core-pass time from 27.410 to 2.285 ms (-91.66%) and
complete compilation from 466.411 to 442.888 ms (-5.04%). Physical Core GPU
execution changes from 24.529 ms to exactly zero; initialization, transfer, and
commit also become zero. The candidate frontier changes from 963 to zero and
the backend from `gpu` to `identity`. Every observation emitted the same
226,134-byte module.

The 2.285-ms identity stage includes queueing and host exact classification; it
is not GPU work. The observed 0.15-ms standalone CPU matcher and 24.529-ms GPU
execution make the break-even decision unambiguous for this corpus. The design
must be revisited if future rule matching becomes materially more expensive or
batched GPU work amortizes its fixed boundary below host classification.

The 508-test release gate passed with the exact frontier. Its paired
byte-identical, engine-valid samples in milliseconds were Editor 255.92/140.90,
Codex 679.85/487.44, grep 44.47/43.28, Tar 138.29/124.89, wav 37.67/36.10, and
raytracer 40.77/39.68.

### 2026-07-31: trusted Core identity stops before scheduling

The exact frontier initially proved identity only after a compiler job entered
the asynchronous GPU batch queue. This retained roughly one scheduler turn even
though no physical work could be shared. Section 7.3 now prepares trusted input
before queueing. Identity returns immediately; a nonempty prepared job carries
its descriptors through batching and capacity splits without recomputation.

An alternating 21-pair Codex required-GPU experiment against detached commit
`f8bd93a` changed median Core-pass time from 2.310 to 0.113 ms (-95.12%) and
complete compilation from 435.368 to 428.949 ms (-1.47%). GPU Wasm emission was
stable at 36.794 versus 36.745 ms, the Core backend remained `identity`, and
every observation emitted the same 226,134-byte module. The end-to-end movement
is larger than the isolated 2.198-ms removal and is therefore not wholly
attributed.

The concurrency regression now uses an actual add-zero match, so its physical
Core batching assertion continues to test nonempty work rather than demanding
that identity jobs enter a queue. Raw empty-frontier throughput tests retain
their logical batching contract.

The 508-test release gate passed. Its paired byte-identical, engine-valid
samples in milliseconds were Editor 263.72/146.35, Codex 790.83/540.59, grep
42.72/43.72, Tar 149.74/131.27, wav 35.52/34.73, and raytracer 41.43/40.59.

### 2026-07-31: Core batch accounting becomes physical

After exact identity moved before scheduling, completed identity results still
reported one payload and every residual function as downstream parallel work.
Those fields conflated logical queue membership with physical execution.
Section 7.3 now distinguishes logical batch size, packed physical payload size,
and command submission batch size. `downstreamParallelFunctionCount` is nonzero
only for backend `gpu`.

Exact required-GPU profiles now report logical/physical/submission cardinalities
of 1/0/0 and zero downstream functions for Editor, Codex, grep, wav, and
raytracer. Tar reports 1/1/1, 12 downstream functions, and 24 candidates. A new
profile regression pins the identity case; direct raw throughput tests retain
logical batch size two with physical size zero.

The concurrency regression was also made non-flaky and theoretically aligned.
It first observes malformed raw Core rejection, then separately submits four
real add-zero jobs under throughput scheduling and requires physical packing.
Concurrent compiler jobs independently require packed Wasm output and
byte-identical artifacts. Identity work is no longer used as evidence of
physical parallelism.

The 509-test release gate passed. Its paired byte-identical, engine-valid
samples in milliseconds were Editor 255.03/137.79, Codex 678.63/480.74, grep
41.96/41.33, Tar 138.67/127.84, wav 35.06/34.24, and raytracer 42.73/38.03.

### 2026-07-31: frontend measurements retain paired evidence

The frontend harness previously retained only each backend's scalar median and
one profile near that median. An initial post-Core audit observed an Editor GPU
median of 352.973 ms with 209.252 ms in representative Wasm emission, versus
roughly 115 and 29 ms in the following run. Because the six input observations
had been discarded, no calculation could distinguish a queue stall from a
repeatable compiler cost. That run is an inconclusive empirical measurement,
not evidence for or against a compiler transformation.

Section 7.1 now makes the paired estimator part of the measurement
specification. The output retains every warm CPU and GPU total and reports
\(\widetilde d\) and \(\operatorname{MAD}_d\). For Codex, the retained totals
were

\[
\begin{aligned}
C={}&[423.755,406.384,417.988,403.072,411.753,388.763],\\
G={}&[445.917,439.579,440.966,427.093,426.497,452.171]\ {\rm ms}.
\end{aligned}
\]

Their marginal medians are 409.068 and 440.273 ms, whose difference is
31.205 ms. The paired differences have median 23.499 ms and MAD 5.046 ms.
Therefore subtraction of marginal medians overstates the measured paired
latency difference by 7.706 ms on this run. This is an arithmetic property of
the retained observations; interpreting it as a population effect remains an
unverified hypothesis.

The same executable six-target run measured paired GPU-minus-CPU median/MAD
milliseconds of Editor 24.483/3.489, Codex 23.499/5.046, grep 28.226/0.377,
Tar 55.289/5.074, wav 28.020/0.511, and raytracer 28.379/1.306. Five programs
have an exact Core identity frontier and their premium is close to the measured
27--29 ms Wasm boundary. Tar alone performs physical Core rewriting and its
representative required-GPU profile spends 34.378 ms in Core plus 29.696 ms in
Wasm. This is empirical evidence that the next latency boundary is Wasm
scheduling for identity-Core programs and useful Core execution for Tar; it is
not a proof that either transformation will be profitable.

The benchmark execution itself is the validation for the serialization and
arithmetic contract: every completed pair produces one difference, incomplete
pairs omit the paired summary, and the existing required-GPU compilation path
still returns validated artifacts. No compiler semantics or emitted bytes
changed in this audit.

### 2026-07-31: break-even is bounded by measured pairs

The concurrency benchmark still selected a crossover by comparing marginal
CPU and GPU medians and described its largest tested size as a lower bound when
none was found. The Codex counterexample above already disproves equivalence of
the marginal and paired estimators. A lower-bound conclusion would additionally
require a proof that the paired GPU-minus-CPU difference is monotone in batch
size; the scheduler, capacity splits, frontend arrival order, and device queue
provide no such model.

The executable report now retains all CPU, GPU, and paired observations at each
batch size, selects break-even using the Section 7.1 paired predicate, and
reports only `maximumMeasuredBatchSize` on failure. The measured set expands
from \(\{1,2,4,8,16\}\) to \(\{1,2,4,8,16,32,64\}\).

A 16-sample run found no paired crossover under either policy. Latency-policy
paired median/MAD differences in milliseconds were

\[
[26.975/0.903,\ 26.232/0.970,\ 28.784/2.718,\ 28.192/3.924,\
30.808/5.522,\ 24.739/12.212,\ 41.324/13.775],
\]

and throughput-policy values were

\[
[29.813/0.818,\ 26.502/0.822,\ 36.796/2.253,\ 34.671/3.751,\
35.840/6.277,\ 26.990/11.506,\ 30.975/8.843].
\]

The entries follow increasing batch size. At \(N=64\), throughput CPU and GPU
medians were 603.336 and 645.696 ms. Thus marginal work per compilation was
9.427 and 10.089 ms, and the paired premium amortized to
\(30.975/64=0.484\) ms per job. The physical Wasm payload median saturated at
16 jobs for both \(N=32\) and \(N=64\).

These are empirical measurements. They prove neither monotonicity nor absence
of a crossover outside the measured set. They do reject, on this adapter and
protocol, the hypothesis that the configured scheduler reaches latency
break-even merely by presenting up to 64 concurrent grep compilations. Raising
the 16-job physical batch limit remains an unverified experiment rather than an
inferred optimization.

### 2026-07-31: larger physical Wasm batches are rejected

The next experiment changed the common payload/submission cap from 16 to 64.
Let \(K\) be that cap and suppose \(N\) jobs are ready together and within
device capacity. The number of physical payload batches is
\(b_K(N)=\lceil N/K\rceil\). Increasing \(K\) from 16 to 64 therefore removes
up to three physical boundaries at \(N=64\), without changing the sum of atom
work or logical payload bytes.

The possible saving is

\[
(b_{16}(N)-b_{64}(N))
  (T_{\rm allocate9}+T_{\rm encode}+T_{\rm map}),
\]

while the larger batch retains \(O(\sum_i A_i)\) host packing, GPU dispatch,
and copied output work and increases the live packed-buffer footprint and
alignment padding. Capacity preflight and stable recursive splitting preserve
correctness for oversized batches, so this was a performance-policy experiment
rather than a semantic change.

At 32 and 64 jobs, cap-16 to cap-64 physical payload medians changed from 16 to
32 and 16 to 64 under latency scheduling, and from 16 to 20.5 and 16 to 34.5
under throughput scheduling. The larger cap therefore exercised its intended
mechanism. Nevertheless, paired GPU-minus-CPU median/MAD milliseconds changed
as follows:

| Policy | \(N\) | Cap 16 | Cap 64 |
| ------ | ----: | -----: | -----: |
| latency | 32 | 24.739/12.212 | 40.804/19.935 |
| latency | 64 | 41.324/13.775 | 36.428/21.910 |
| throughput | 32 | 26.990/11.506 | 44.275/8.959 |
| throughput | 64 | 30.975/8.843 | 35.606/15.120 |

Both 32-job comparisons and 64-job throughput regressed. The sole lower median,
64-job latency, moved by 4.896 ms against a 21.910 ms post-change MAD and does
not resolve a benefit. The implementation therefore restores \(K=16\). This is
empirical rejection on the current adapter and arrival protocol; it neither
proves global optimality of 16 nor rules out a different scheduler that avoids
host packing and readback boundaries altogether.

### 2026-07-31: GPU availability is not a performance oracle

The former default `auto` policy always attempted Core and Wasm GPU execution
when a device existed. It selected on availability, not predicted completion
time. With default differential verification, it also encoded CPU Wasm before
waiting for GPU Wasm. Calling this behavior automatic performance selection had
no supporting model.

Let \(T_C(x)\) be CPU completion time for workload \(x\), \(T_G(x)\) successful
GPU completion time, and \(T_U(x)\) the cost of discovering GPU unavailability.
An availability-driven attempt has latency

\[
T_{\rm optional}(x)=
\begin{cases}
T_G(x), & \text{GPU succeeds without differential verification},\\
T_C(x)+T_G(x), & \text{GPU succeeds with sequential differential work},\\
T_U(x)+T_C(x), & \text{GPU is unavailable}.
\end{cases}
\]

It minimizes latency only under an independently justified selector. The
implementation has no online calibration, hardware-portable constants, or
proved crossover. The isolated emitter medians on the RTX 4080 SUPER were CPU
0.412/3.395/0.069/0.347/0.041/0.061 ms and adaptive GPU
28.008/35.804/27.286/28.028/27.067/27.175 ms for Editor, Codex, grep, Tar, wav,
and raytracer. CPU was 10.55--665.53 times faster at this boundary. Section
7.1's concurrency experiment also found no whole-compiler GPU crossover through
64 grep jobs.

The policy model is therefore explicit:

1. omitted mode or `off` selects CPU and never requests a device;
2. `optional` attempts GPU and falls back only on typed unavailability;
3. `required` attempts GPU and promotes the same unavailability to failure;
4. invalid IR, disagreement, and malformed output fail under both GPU modes.

This is a semantic simplification and a latency work-elimination rule, not a
claim that CPU is universally faster. Users asking for GPU execution select it
explicitly. The CLI spells optional execution `--try-gpu`; `--require-gpu`
retains the release and benchmark contract.

The first attempted simplification removed optional execution entirely. That
made portable differential tests stop exercising GPU work on available devices,
which is a counterexample to a two-policy model: optional execution has a
conformance and recovery role even though it is not a performance oracle. The
final disjoint policy retains that role without making it the default.

Executable evidence includes API and CLI default-CPU assertions, explicit
optional differential tests, explicit required-GPU tests, unavailable-device
classification tests, and the release gate. The isolated measurements are
empirical; the policy truth table and fail-stop conditions are specified
invariants.

The 513-test release gate passed after the policy split. Required-GPU
byte-identical, engine-valid samples in milliseconds were Editor
272.61/140.03, Codex 715.70/517.82, grep 42.97/44.77, Tar 143.47/132.24, wav
36.32/35.93, and raytracer 41.68/39.83. These correctness samples do not
measure the default-CPU latency removal.

### 2026-07-31: sessionless compilation discards cache identities

Profiling exposed semantic-context and semantic-fingerprint stages in every
from-scratch benchmark even though those runs pass no compilation session.
Inspection found exactly two consumers of the resulting identity: a session
compilation lookup and the corresponding validated-artifact insertion. Section
6.4 now makes identity construction conditional on ownership by that session.

Independent compilation no longer resolves and hashes the host interface for a
cache key, normalizes the full syntax tree, scans the source dependency suffix,
or content-encodes the normalized tree. The real host-interface elaboration,
all semantic stages, and all artifact validation remain. Session-backed
compilation executes the former code unchanged.

An executable profile regression requires both session-only stages and
fingerprint reuse count to be zero without a session. The existing exact-source,
trailing-trivia, internal-edit, dependency, and backend-function session tests
remain the counterboundary. Every post-change frozen CPU and required-GPU
representative reported exactly zero milliseconds for both removed stages.

Consecutive six-sample runs against detached parent `eede66b` measured CPU
medians changing from 88.388→83.309 ms Editor, 456.536→433.900 Codex,
14.487→11.649 grep, 69.623→65.890 Tar, 7.623→5.580 wav, and 11.738→9.208
raytracer. Required-GPU medians changed from 125.252→105.125, 489.596→477.767,
42.219→40.272, 124.367→122.679, 34.255→32.914, and 39.064→37.909 ms.

The parent CPU representative spent context/fingerprint milliseconds of
0.133/11.348, 0.172/1.679, 0.131/0.904, 0.160/2.201, 0.005/0.831, and
0.005/1.324 in target order. Removal of those stages is an implementation
invariant. The uniformly lower end-to-end observations are empirical and are
not wholly attributed because the comparisons are consecutive rather than
interleaved across commits.

The 514-test required-GPU release gate passed. Its byte-identical, engine-valid
samples in milliseconds were Editor 271.99/148.69, Codex 785.39/547.92, grep
43.09/46.37, Tar 160.52/135.64, wav 37.75/33.74, and raytracer 39.07/37.88.

### 2026-07-31: source-control fixed-point work becomes observable

The remaining Codex profile attributed roughly 74 ms to control-flow lowering,
but the artifact did not expose whether this was one expensive traversal or
many fixed-point rounds. Section 6.5 records the actual algorithm and the
unproved 32-round restriction.

Lowering now reports physical pass count and times its first and accumulated
subsequent transformations without adding another traversal. Existing callers
retain the module-only interface. The profile containment regression requires
the enclosing stage to contain both transformation intervals, and a
straight-line fixture pins one physical pass.

The six-target CPU representative measured pass counts
\([1,2,1,1,1,1]\). Enclosing/first/subsequent milliseconds were Editor
2.673/1.294/0, Codex 73.905/17.055/41.762, grep 0.619/0.200/0, Tar
2.066/0.212/0, wav 0.209/0.114/0, and raytracer 0.434/0.225/0. Subtraction
leaves 1.379, 15.088, 0.419, 1.854, 0.095, and 0.208 ms respectively inside
post-pass search and orchestration.

These are empirical representative observations. The pass count is exact for
each artifact. Codex's second pass must perform useful lowering because the
first pass's search found residual source control and the second pass's search
did not; timing alone does not identify which constructors dominate its
41.762 ms transformation. A fused decreasing measure is the next derived
algorithm, not an implemented claim.

The unchanged 514-test required-GPU gate passed with samples Editor
242.93/141.68 ms, Codex 691.27/517.66, grep 44.00/38.92, Tar 141.18/128.27,
wav 33.18/32.09, and raytracer 38.56/35.74. All paired artifacts were
byte-identical and engine-valid.

### 2026-07-31: source-control search follows typed syntax only

The fixed-point search used `Object.values` recursively over the complete
runtime object graph. It therefore inspected and allocated child arrays for
spans, names, declared types, and other metadata that cannot contain the three
source-control constructors. Section 6.5 replaces that reflection with one
exhaustive switch over the `DucklangStatement | DucklangExpression` sum.

Every syntax-bearing field is pushed explicitly. Leaf and declaration-only
constructors stop, and an exhaustive `never` branch turns AST extension without
scanner extension into a type error. This is executable support for the
structural-induction argument. Loop semantics, transformations, fixed-point
passes, and the 32-pass restriction are unchanged.

Consecutive CPU control-flow representative milliseconds changed from
2.673→1.276 Editor, 73.905→57.031 Codex, 0.619→0.200 grep, 2.066→0.292 Tar,
0.209→0.130 wav, and 0.434→0.260 raytracer. Pass counts remained
\([1,2,1,1,1,1]\). CPU total medians changed respectively
86.569→79.418, 446.661→396.694, 12.256→10.600, 59.854→57.457,
5.711→5.136, and 9.001→8.502 ms. Required-GPU medians also moved downward
in every case.

Predicate equivalence and pass-count preservation are executable/structural
evidence; timing is empirical. The end-to-end changes are not wholly attributed
because the before and after compiler runs were consecutive rather than
interleaved.

The 514-test required-GPU gate passed after the typed search. Its byte-identical,
engine-valid samples in milliseconds were Editor 267.58/151.45, Codex
775.22/576.47, grep 44.68/40.95, Tar 151.32/131.86, wav 34.86/34.18, and
raytracer 39.86/37.84.

### 2026-07-31: residual control proves fixed-point termination

The final control-flow audit removes the arbitrary 32-pass failure. The typed
search now counts every residual source-control constructor and retains the
first as diagnostic evidence. After the first pass establishes \(r_1\), each
later nonterminal pass must strictly decrease the count. Section 6.5 derives
the bound \(P\leq r_1+1\).

The frozen residual-count/pass pairs are Editor 0/1, Codex 2/2, grep 0/1, Tar
0/1, wav 0/1, and raytracer 0/1. A new Codex profile regression requires a
positive residual frontier and the derived pass bound; a straight-line
regression requires zero residual control. Stagnation reports the first
constructor's source span and kind plus prior and successor counts.

Because counting traverses the complete typed syntax graph rather than
returning at the first residual node, consecutive control-flow representatives
changed from 1.276→1.987 ms Editor, 57.031→56.020 Codex, 0.200→0.190 grep,
0.292→0.301 Tar, 0.130→0.181 wav, and 0.260→0.417 raytracer. This is a mixed
empirical performance result and no speedup is claimed. The selected design
prefers a well-founded semantic restriction over an unexplained numeric cap.

The 515-test required-GPU gate passed with byte-identical, engine-valid samples
Editor 239.12/130.66 ms, Codex 657.48/462.22, grep 40.67/40.35, Tar
139.90/120.23, wav 34.54/32.81, and raytracer 37.57/35.96.

### 2026-07-31: residual control is decomposed by constructor

Review 51 decomposes the first-pass measure without changing it. The residual
scanner now counts ordinary, range, and collection loops separately while
performing the already-required complete syntax traversal. The scalar work and
storage increments are constant per residual constructor and constant per
compilation respectively; there is no additional pass or allocation
proportional to syntax size.

The frozen component vectors in `(loop, range, collection)` order are Editor
`(0,0,0)`, Codex `(2,0,0)`, grep `(0,0,0)`, Tar `(0,0,0)`, wav `(0,0,0)`, and
raytracer `(0,0,0)`. Thus Codex's second transformation is caused by two
ordinary loops exposed beneath first-pass source control, not by either `for`
lowering. The component-sum invariant and zero straight-line vector are
executable validations; the corpus vector is empirical evidence, not a
language-wide distribution claim.

The same six-sample run measured CPU control-flow representatives of 1.609,
57.521, 0.203, 0.382, 0.131, and 0.260 ms. Instrumentation shares the residual
traversal and is not expected to affect latency beyond three predictable
branches on residual nodes; these timings are retained as observations, not a
speed claim.

### 2026-07-31: residual multiplicity is separated from provenance

Review 52 adds the distinct source-provenance count \(d_1\) to the residual
measure report. Identity is the tuple `(kind, file, start, end)`, which is
stable under linked AST copying and separates different constructors within a
file. The executable bounds are \(0\leq d_1\leq r_1\); straight-line syntax
pins both to zero.

Codex reports two ordinary-loop occurrences but one distinct source identity.
Temporary diagnostic inspection located both at
`prelude_runtime.duck:1424..1632`, the loop in `text_starts_with_at`. The
committed profile deliberately retains only counts rather than source paths;
source spans remain compiler diagnostic evidence, while benchmark work remains
numeric. This initially suggested two linked instances; the following review's
object-identity counterexample rejects that interpretation.

The distinctness set costs expected \(O(r_1)\) work and \(O(d_1)\) transient
storage. Here that is two insertions and one retained key. It is measurement
instrumentation, not a performance optimization; no timing improvement is
claimed.

### 2026-07-31: shared residual vertices are distinguished from occurrences

Review 53 tests the duplicate-instance hypothesis from Review 52. An identity
set over residual syntax objects shows Codex's vector is
`(occurrences, vertices, sources) = (2,1,1)`. Both root paths reach the exact
same immutable loop object. The linker has therefore retained structural
sharing; there are not two allocated or separately hygienised loop nodes at
this point. This is the counterexample that changes the design.

The executable inequalities are \(d_1\leq u_1\leq r_1\), and the frozen Codex
test pins all three observations. The scanner adds one expected-constant object
identity insertion per residual occurrence and \(O(u_1)\) transient storage.
For Codex that is two insertions retaining one reference.

Memoizing the transformation by input object identity is now theoretically
admissible only for context-free lowering rules. The control-flow pass also has
context-sensitive operations—visible bindings, expected result types, and loop
continuations—so global memoization by object alone would be unsound. The next
review must derive the smallest context key or locate a context-free subtree
boundary before sharing transformed output.

### 2026-07-31: complete syntax sharing is measured

Review 54 extended the first-pass report from residual targets to the entire
post-transformation syntax DAG. Its then-current scanner stopped below residual
targets, so these measurements are retained as frontier-pruned evidence and
superseded by Review 55. The recorded occurrence/vertex pairs were Editor
3,528/3,188, Codex 22,103/12,231, grep 1,193/934, Tar 6,083/1,375, wav
317/317, and raytracer 578/578. The respective redundant occurrence counts are
340, 9,872, 259, 4,708, zero, and zero; the corresponding sharing factors
\(O_1/V_1\) are 1.11, 1.81, 1.28, 4.42, 1.00, and 1.00.

Codex and Tar therefore justify investigating a vertex-memoized search; wav and
raytracer are counterexamples to any universal benefit. An executable invariant
requires \(V_1\leq O_1\), and the frozen Codex case requires strict inequality
so the shared-DAG path remains covered. Exact corpus counts are empirical and
may change with legitimate frontend output.

The same instrumented run measured CPU control-flow representatives of 1.312,
56.944, 0.237, 0.414, 0.191, and 0.373 ms, with CPU total medians of 81.344,
435.759, 11.526, 65.554, 5.779, and 9.584 ms. The identity set is itself new
work, so these are baselines for the next algorithm rather than an improvement
claim.

### 2026-07-31: residual search descends through source control

Review 55 finds that the residual scanner's three target cases counted a match
and stopped instead of traversing the target's operands and body. Section 6.5
now distinguishes the invalid outer-frontier measure from the complete syntax
occurrence measure and gives the `one outer containing two inner`
counterexample.

The scanner now follows a loop body, range start/end/optional-step/body, and
collection/body after counting the constructor. A regression builds two nested
unsupported refutable collection loops. Their second pass diagnoses
`forCollection count from 2 to 2`; the former scanner reported only one. This
is executable validation of full descent and stagnation, while strict decrease
for all admitted lowering shapes remains a dynamically checked invariant.

Five corpus targets are unchanged because no residual target remains after
pass one. Codex changes from 22,103/12,231 to 22,177/12,248 search
occurrences/vertices, exposing 74 occurrence visits and 17 vertices inside the
shared residual loop. Its residual vector remains two occurrences, one vertex,
and one source. Contemporary CPU control-flow representatives were 1.180,
60.108, 0.247, 0.369, 0.125, and 0.597 ms; CPU total medians were 80.157,
422.822, 11.636, 60.740, 4.964, and 9.425 ms. The change is semantic
measurement repair, not a speed claim.

### 2026-07-31: object-map DAG aggregation is rejected

Review 56 implemented the exact DAG alternative derived after Review 54. It
discovered each syntax vertex and edge once, rejected cycles, topologically
propagated root occurrence multiplicities, checked safe-integer arithmetic, and
preserved every frozen residual and search count. The 38 focused profile/Core
tests passed, including nested residual descent.

The implementation nevertheless raised CPU control-flow representatives from
1.180→2.095 ms Editor, 60.108→64.663 Codex, 0.247→0.478 grep,
0.369→0.717 Tar, and 0.125→0.224 wav. Raytracer measured 0.597→0.430 ms,
but its sub-millisecond change does not outweigh five coherent regressions.
Whole-compiler medians moved 80.157→76.180, 422.822→416.835,
11.636→11.104, 60.740→57.518, 4.964→5.193, and 9.425→9.924 ms; the
mixed totals demonstrate why the isolated stage decides this mechanism.

The failed implementation was removed before commit. Its counterexample is
important: structural sharing alone is insufficient when exploiting it needs
multiple object-keyed maps, edge arrays, an indegree pass, and a topological
queue. A future flat integer-ID syntax IR changes those constants and may cross
the derived inequality; the current object AST does not.

### 2026-07-31: weak identity sets are rejected

Review 57 tested replacing the two object-identity sets with weak sets and
explicit cardinality counters. Correctness and all frozen work counts were
unchanged. The lifetime proof is straightforward: weak membership cannot
disappear during the scan because the input module and pending traversal paths
retain every reachable node. Conversely, that same ownership proves there is
no peak-live-memory reduction.

An A/B/A sequence produced Weak/Set/Weak control-flow milliseconds of
1.794/2.087/2.571 Editor, 57.566/60.450/58.531 Codex,
0.271/0.228/0.261 grep, 0.404/0.372/0.420 Tar,
0.130/0.123/0.127 wav, and 0.241/0.289/0.245 raytracer. Codex and raytracer
favor weak identity; grep and Tar favor ordinary identity; Editor is unstable.
The result demonstrates target-dependent constants rather than an admissible
global speedup.

The weak-set implementation was removed before commit. Ordinary sets retain a
single insertion operation per occurrence, direct cardinality, and the same
asymptotic memory already forced by module ownership. A future arena IR should
replace both with dense visitation epochs, not choose between object-set APIs.

### 2026-07-31: the CPU frontier is re-ranked by absolute cost

Review 58 returns to the retained ordinary-set baseline and re-ranks the six
frozen CPU profiles. Representative totals sum to 548.552 ms; Codex contributes
393.665 ms, or 71.76%. Optimizing the equal-weight corpus sum therefore selects
Codex unless a cross-target primitive has comparable aggregate savings.

Across all targets, top-level stage sums are elaboration 114.595 ms,
pre-comptime specialization 110.790, type analysis 68.714, CPU Wasm planning
and emission 68.634, Core flattening 42.988, Core lowering 42.372, and parsing
34.668. These sums are workload-weighted observations, not intrinsic stage
complexities.

Within Codex, the largest substages are specialization rewrite 68.594 ms,
control-flow lowering 60.450, CPU Wasm planning/emission 52.286, type inference
40.457, Core flattening 32.570, Core lowering 31.706, specialization lifting
22.751, local-import resolution 18.349, and ABI construction 21.058. The next
review therefore moves to specialization rewrite, the largest isolated
substage, while retaining control flow as the second frontier.

Codex specialization observes 703 distinct keys but only four result-cache
hits, 884 distinct function analyses and 630 analysis-cache hits, 6,828
rewritten blocks, and
412,890 avoided environment-entry copies. Those counts do not yet prove that a
wider cache is sound or profitable; they define the questions for the next
derivation.

### 2026-07-31: function-analysis reuse is named as reuse

Review 59 traces the apparent 630 “repeated function analyses” to the metric's
increment site. The counter advances only when `functionAnalyses.get(factory)`
returns a cached analysis or cached non-inlineable result; the body scan is then
skipped. It measures successful memoization, not repeated work.

The metric is renamed `specializationFunctionAnalysisCacheHitCount` throughout
the specialization result and compilation profile. A focused program applies
the same higher-order function twice and requires both a positive distinct
analysis count and a positive cache-hit count. The WeakMap key is function AST
object identity, which is sound because the analysis depends only on that
immutable function's body and parameter symbols, not on the substitution
environment.

Codex's corrected interpretation is 884 scans plus 630 avoided scans, a 41.61%
hit share among 1,514 analysis requests. This does not reduce the measured
68.594 ms rewrite stage; it removes a false optimization lead. The four
completed-result hits beside 703 distinct specialization keys remain a separate
cache domain for Review 60.

The specialization-result key is

\[
K=(function,callsite,static\ arguments,captured\ environment).
\]

`function` is immutable object identity; static arguments and captured values
use structural identities where defined and stable object IDs otherwise. The
call-site file/start/end preserves source provenance in substituted output.
Removing it defines a coarser semantic key \(K_s\), but reuse under \(K_s\)
would return expressions carrying the first call site's substituted spans.
Semantic equality is insufficient for diagnostic equivalence unless a separate
provenance-relabeling operation is proved.

### 2026-07-31: specialization provenance is not the cache frontier

Review 60 temporarily counted distinct \(K_s\) keys alongside the existing
provenance-aware \(K\). The six `(K, K_s)` pairs were Editor `(47,46)`, Codex
`(703,698)`, grep `(1,1)`, and zero/zero for Tar, wav, and raytracer. Thus
call-site provenance distinguishes only one Editor key and five Codex keys.
Even perfect span-insensitive reuse could merge at most 0.71% of Codex's
distinct entries, while returning incorrect source provenance without a
relabeling pass.

The semantic-key set was removed before commit. During its instrumented run,
Codex rewrite measured 71.300 ms versus the preceding 68.594 ms baseline; this
single consecutive change is not an attributed regression, but it confirms
that permanent duplicate key construction needs a stronger benefit.

The cheap pending-cycle counter remains. Result-cache lookup requests partition
exactly into distinct insertions \(D\), complete hits \(H\), and pending-cycle
hits \(P\), so the hit rate is \(H/(D+H+P)\). Codex reports
\((D,H,P)=(703,4,0)\), or 0.566%; Editor reports `(47,2,0)`, or 4.082%.
A focused non-recursive two-call test pins positive analysis-cache reuse and
zero pending result cycles. The next review must inspect argument/environment
identity dispersion rather than call-site spans.

### 2026-07-31: final-expression identity memoization is rejected

Review 61 tested a WeakMap from immutable static-expression object identity to
its fully serialized specialization identity. This is semantically sound within
one specialization run: typed expressions and types are immutable, assigned
function/value IDs are stable in the context, and the identity function has no
substitution-environment input after `staticValue` selects its argument.

The cache observed 20 Editor hits and 223 Codex hits; the other four targets had
none. Its cost inequality is

\[
Hc_{serialize} > Qc_{lookup}+Uc_{insert},
\]

for \(Q\) identity requests, \(H\) hits, and \(U\) misses. A first consecutive
representative suggested a Codex improvement, but a second produced an 84.506
ms outlier. This exposed that the profile nearest the end-to-end median is not
an estimator for an individual substage.

Fifteen direct Codex rewrite samples per variant then measured median/MAD
65.263/2.175 ms cached and 65.000/1.825 ms baseline. The +0.41% median change is
smaller than either MAD and rejects the mechanism. The implementation and its
metric were removed before commit. Future substage decisions use samples and
statistics for that substage directly, not the total-median representative.

### 2026-07-31: rewrite amplification is measured

Review 62 temporarily counted every recursive `rewriteExpression` entry. Let
\(C\) be entries and \(N_d\) demanded input nodes. The measured
\(C/N_d\) factors were Editor 6,718/4,150 = 1.62, Codex
130,143/16,119 = 8.07, grep 670/707 = 0.95, Tar 3,499/4,411 = 0.79,
wav 269/269 = 1.00, and raytracer 458/458 = 1.00.

Codex's residual program has 23,594 nodes, only 1.46 times demanded input, so
output expansion alone cannot explain 8.07 traversals per input node. At least
106,549 rewrite entries exceed one visit per residual node, although this
subtraction is an empirical work comparison rather than an object-identity
proof: generated and eliminated expressions inhabit different sets.

The entry counter was removed before commit because it executes on the exact
hot recursion being measured. Its instrumented representative was 78.107 ms
and is not compared to an uninstrumented latency baseline. The work vector is
the evidence. The next decomposition separates entries under a specialization
substitution environment from ordinary top-level rewriting, which tests the
hypothesis that repeated partial-evaluation expansion—not generic traversal—is
Codex-specific.

### 2026-07-31: substitution breadth explains Codex amplification

Review 63 temporarily partitions rewrite entries by whether the substitution
environment stack is nonempty. Codex has 114,281 substitution entries out of
130,143 total, or 87.81%. Editor has 1,881/6,718 = 28.00%, grep has 2/670 =
0.30%, and Tar, wav, and raytracer have none. Codex's 15,862 ordinary entries
are close to its 16,119 demanded input nodes; nearly all excess work is inside
specialized bodies.

Maximum substitution depth is two for Editor and Codex, one for grep, and zero
otherwise. The counterexample rejects deep recursive nesting as the cause.
Codex instead performs broad specialization: its 114,281 substitution entries
average 162.56 per distinct result key. This average does not imply equal body
sizes or independent jobs, but it identifies request breadth as the dominant
work domain.

The hot counters were removed after measurement. The next sound optimization
must preserve the ordered substitution stack and pending-cycle semantics while
discarding or sharing work across equivalent request bodies. Parallel execution
is admissible only after dependencies through captured environments and nested
requests form an explicit acyclic frontier; the shallow stack alone is not a
proof of independence.

### 2026-07-31: substitution-stack flattening is rejected

Review 64 temporarily counts reference queries made while a substitution
environment is active, individual environment-map probes, and successful
substitutions. The `(queries, probes, hits)` vectors are Editor
`(823,883,125)`, Codex `(31,660,31,669,2,705)`, grep `(1,1,1)`, and zero for
Tar, wav, and raytracer.

Reverse stack search implements lexical shadowing: the newest parameter
substitution wins. An overlay map with rollback would reduce probes from
\(\sum q_i d_i\) to \(\sum q_i\), but must update and restore entries at every
request boundary. Codex has only nine probes beyond one per query, so its
maximum possible lookup saving is nine map reads against 703 push/pop updates.
Editor has 60 extra probes but only 823 queries in a 4 ms stage. The derived
inequality cannot hold on this corpus.

The counters were removed. Codex's 8.54% hit rate instead suggests a different
boundary: substitutions contain function parameter symbols, so references from
provably disjoint symbol scopes can bypass the stack entirely. Review 65 must
measure query scope before adding that guard; symbol scope is semantic evidence,
whereas a name or ID-range heuristic would be unsound.

### 2026-07-31: resolver scope proves substitution misses

Review 65 partitions active-substitution reference queries by the resolver's
symbol scope. Editor reports 107 module, 417 parameter, and 299 local queries;
Codex reports 56, 15,000, and 16,604; grep reports one parameter query. The
other targets have no active substitutions.

Each substitution environment is constructed exactly from
`factory.parameters`. Resolution assigns every such symbol scope `parameter`.
Therefore

\[
scope(r)\neq parameter \Longrightarrow
\forall E\in substitutionStack.\ r.id\notin dom(E).
\]

This is a proved negative lookup, independent of naming and numeric ID
allocation. It covers 16,660/31,660 = 52.62% of Codex queries and 406/823 =
49.33% of Editor queries. The temporary scope counters were removed. Review 66
can guard the reverse map search with `scope === parameter`; observable output
is unchanged because the skipped branch is proved unable to return a value.

### 2026-07-31: non-parameter substitution lookups are discarded

Review 66 implements the scope theorem from Review 65. Reverse substitution-map
search now runs only while an environment is active and the reference symbol's
resolver scope is `parameter`. Parameter search order, recursive substitution,
the ordinary value environment, and reference provenance are unchanged.

Preservation is by case analysis. For a parameter reference, execution is
identical. For module or local scope, every substitution-map lookup returned
`undefined` by the domain theorem, so removing those lookups reaches the same
`values` handling with unchanged state. A new executable example combines a
substituted parameter, local capture, module capture, and higher-order call and
still evaluates to 42; the existing two-level capture and full specialization
suite also pass.

Fifteen direct Codex rewrite samples in A/B/A order measured guarded
median/MAD 72.626/4.050 ms, unguarded 79.616/8.113, and guarded
68.083/2.717. Both guarded medians beat the intervening baseline; their
variation warns against a sharper attributed percentage. The deterministic
claim is removal of 16,660 proved-negative Codex map queries. The observed
latency direction supports retaining the guard.

### 2026-07-31: static alias cycle sets are allocated lazily

Review 67 models `staticValue` as following the partial alias function
\(A:symbol\rightharpoonup expression\) through transparent `comptime` wrappers
until reaching a non-reference, an unresolved reference, or a repeated symbol.
The former implementation allocated an empty cycle-detection set before knowing
whether any alias edge existed.

The new evaluator first strips wrappers and handles, without allocation: an
initial non-reference, an unresolved reference, a reference resolving to a
non-reference, and a self-cycle. Only a chain reaching a second distinct
reference allocates a set seeded with the first symbol and enters the general
cycle algorithm. Case analysis gives the same terminal expression and source
provenance as the former loop; multi-node cycles still stop on the first
repeated reference.

A direct-alias execution regression returns 42, and all eleven specialization
tests pass. Fifteen direct Codex rewrite samples in A/B/A order measured lazy
median/MAD 66.819/1.244 ms, eager 72.842/4.014, and lazy 67.403/2.324. Both
lazy medians beat the intervening eager baseline. This supports retaining the
zero-allocation terminating cases; no claim is made for programs dominated by
long alias chains.

### 2026-07-31: retained specialization fast paths reduce all six rewrites

Review 68 re-runs the paired six-target frontend protocol after the
resolver-scope guard and lazy static-alias set. Against the retained Review 57
ordinary-set baseline, specialization rewrite representatives change Editor
4.368→3.987 ms (-8.74%), Codex 68.594→64.079 (-6.58%), grep
0.305→0.262 (-13.92%), Tar 3.465→2.825 (-18.47%), wav 0.081→0.069
(-15.18%), and raytracer 0.199→0.172 (-13.67%). The coherent six-target stage
direction supports the local mechanisms; consecutive-run noise prevents
attributing each percentage exactly.

CPU total medians are 74.531, 386.544, 11.045, 57.620, 5.262, and 8.507 ms.
Required-GPU medians are 102.646, 440.070, 39.530, 113.605, 33.287, and
36.811 ms. Paired GPU premiums remain positive at 26.184, 54.538, 28.485,
58.059, 28.029, and 28.385 ms, so the default-CPU policy remains justified.

Deterministic Wasm sizes remain 24,460, 226,134, 3,911, 26,106, 2,520, and
3,864 bytes. The fast paths remove lookups and allocations but change no
specialization keys, demanded bindings, residual structure, or emitted bytes.
This checkpoint is empirical evidence, not yet the full release gate.

### 2026-07-31: specialization fast paths pass the release gate

Review 69 closes the checkpoint with `deno task release:gpu`. Formatting,
linting, and type checking passed across 133 formatted and 117 linted files.
All 519 tests passed. This includes the complete corpus, deterministic frozen
binaries, specialization semantics, effects, ownership, Core validation,
generated GPU differential properties, concurrency, and device-failure paths.

The required-GPU release adapter reported 256 MiB maximum buffer size and
128 MiB maximum storage binding size. Malformed input retained the expected
source diagnostic. Cold/repeated target samples in milliseconds were Editor
240.61/128.83, Codex 673.86/477.54, grep 41.51/40.53, Tar 137.24/125.43,
wav 34.41/33.48, and raytracer 38.88/39.13. Wasm sizes matched the checkpoint:
24,460, 226,134, 3,911, 26,106, 2,520, and 3,864 bytes.

Every GPU artifact matched the independently emitted CPU bytes and passed
engine and artifact validation. These are executable validations. The latency
samples are release observations, not distribution estimates; the six-sample
paired benchmark remains the performance evidence.

### 2026-07-31: environment-candidate sorting is not the frontier

Review 70 re-ranks the current Codex representative: specialization rewrite is
64.079 ms, control-flow lowering 54.832, CPU Wasm planning/emission 55.112, and
type inference 38.802. Specialization remains narrowly first.

Each specialization request derives captured-environment identity by removing
parameter symbols from the function's referenced-symbol set, sorting IDs, then
filtering for values present in the current environment. The parameter removal
and sort depend only on immutable function analysis, so hoisting a sorted
candidate list into the analysis is semantically valid and preserves canonical
key order.

Fifteen direct Codex rewrite samples in hoisted/baseline/hoisted order measured
median/MAD 66.411/1.931, 66.161/2.506, and 66.631/2.280 ms. Both hoisted
medians are slightly slower, and every difference is below MAD. The
implementation was removed. Candidate sorting is not the material cost at
current referenced-set sizes; request-specific membership and value identity
remain possible costs, but require their own work measurement.

### 2026-07-31: captured-environment keys are negligible

Review 71 temporarily counts entries that survive parameter removal and current
environment membership into specialization result keys. Editor constructs 26
entries across 47 distinct keys with maximum key arity seven. Codex constructs
26 entries across 703 keys with maximum arity two. Grep and the three remaining
targets construct none.

Thus Codex averages 0.037 captured entries per distinct key; at least 677 keys
have an empty captured-environment component. Sorting at most two entries and
serializing 26 entries total cannot account for a 64 ms rewrite stage. This
explains the rejected hoist and closes environment identity as a material
frontier on the frozen corpus.

The hot counters were removed. Static-argument identity and the 114,281 body
rewrite entries remain the two request-domain costs. Any environment
optimization must wait for a corpus whose measured key arity crosses a stated
break-even point.

### 2026-07-31: specialization key construction is closed

Review 72 temporarily counts static arguments entering result keys, maximum
argument arity, and every recursive expression-identity call. Editor has 83
arguments across 47 keys, maximum three, and 155 identity calls. Codex has
1,357 arguments across 703 keys, maximum seven, and 1,416 identity calls. Grep
has two arguments and two calls; the other targets have none.

Codex therefore averages 1.93 static arguments per key. Recursive structural
identity adds only 59 calls beyond the 1,357 top-level arguments; this includes
the 26 captured-environment entries measured in Review 71. All key identity
work is only 1.09% of the 130,143 rewrite entries measured in Review 62.

The hot counters were removed. Together Reviews 60, 61, 64, 70, 71, and 72
close call-site spans, final-identity caching, stack depth, candidate sorting,
captured environments, and static-argument serialization as primary causes.
The remaining specialization frontier is transformation of requested bodies,
not construction of their cache keys.

### 2026-07-31: specialization request work is heavy-tailed

Review 73 temporarily attributes rewrite entries exclusively to the innermost
active specialization request. Editor's completed requests contain 1,881
entries total and its largest contains 958, or 50.93%. Codex contains 114,281
entries total and its largest contains 32,184, or 28.16%. Grep's only request
contains two entries.

These maxima reject a uniform per-key work model: dividing Codex work by 703
keys gives 162.56 entries/key, but one request costs 197.98 times that mean.
Consequently, optimizing key lookup or scheduling every request equally cannot
address the dominant request. The counter stack correctly attributes nested
requests to the innermost request, so parent counts exclude child work.

The hot counters were removed. The next measurement must quantify how many
requests inhabit the heavy tail and how much work they cover before choosing
between large-body memoization, request fusion, or a body-specific rewrite
primitive.

### 2026-07-31: seven requests contain four-fifths of Codex rewrite work

Review 74 partitions the exclusive request counts from Review 73 at two fixed
work thresholds. A large request has at least 1,024 rewrite entries; a huge
request has at least 8,192. These thresholds classify measured work rather than
define source semantics, and their counters were removed after measurement.

Codex has seven large requests containing 90,688 of 114,281 exclusive entries,
or 79.36%. Four of those are huge and contain 82,234 entries, or 71.96%. Thus
the remaining 696 result keys together contribute at most 23,593 entries. No
other frozen target crosses either threshold: Editor's maximum is 958, grep's
is two, and Tar, wav, and raytracer have no completed specialization request.

This is empirical evidence for a sparse optimization domain, not a power-law
claim: two thresholds cannot identify a distribution. It rules out paying a
material fixed cost on every request to accelerate only the tail. A profitable
mechanism with setup cost \(S\), per-entry saving \(d\), and seven applicable
requests must satisfy \(7S < 90{,}688d\). The next review must identify the
largest requests' source/function provenance before proposing a representation
change; aggregate size alone cannot distinguish repeated traversal, genuinely
large bodies, or nested generated structure.

### 2026-07-31: JSON specialization owns the measured heavy tail

Review 75 temporarily records factory and call-site provenance for the seven
large Codex requests. All seven are JSON-path requests. Six factories originate
in `prelude_json.duck` and contain 86,172 entries, or 75.40% of all exclusive
request work; the remaining protocol encoder contains 4,516. The two largest
requests each contain 32,184 entries and specialize the identical
`encode_json` source span, bytes 18,021--19,590, at protocol call sites
6,697--6,728 and 7,078--7,109. Together they account for 56.33% of request work.

Those two requests have different ephemeral function IDs despite sharing a
source span. This proves only that distinct typed function objects reached the
specializer; it does not prove semantic equivalence. Canonicalizing by source
span would be unsound because two module instances may close over different
environments. The safe optimization boundary is earlier module-instance reuse
when module identity and captured inputs agree, or later memoization under the
existing complete specialization key. The other measured factories are
`parse_json`, `parse_json_document`, `parse_json_string`, and
`encode_tool_result`, so a generic compiler change must be evaluated against
JSON's recursive aggregate construction rather than assumed to help arbitrary
functions.

The provenance strings and request counters were removed. The next review must
determine whether the duplicate encoder bodies arise from legitimately distinct
module environments or avoidable repeated frontend instantiation before any
identity merge is attempted.

### 2026-07-31: duplicate encoder work is not a result-cache miss

Review 76 decomposes the two 32,184-entry encoder requests into static-argument
and captured-environment identities. Their captured environments are identical:
both capture the same recursive encoder function identity. Their sole static
arguments are both `Json.Object` cases, but the contained object-list references
have distinct value identities, 2,464 and 2,922. Therefore the complete
specialization keys are semantically distinct even if factory identity is
canonicalized by source and environment.

This rejects both module-instance deduplication and result-cache merging as an
explanation for the duplicated traversal. Reusing either specialized result
would substitute the wrong object payload. What is common is the encoder body
and its control skeleton; what differs is the leaf substitution. A safe reuse
mechanism must therefore be parametric: precompute a body traversal plan or
residual template whose holes are explicitly indexed by parameter symbols, then
instantiate those holes per request. Its correctness obligation is
\(instantiate(template(B), \sigma) = rewrite(B, \sigma)\) for every admitted
substitution \(\sigma\), including nested specialization requests and captured
values.

The identity instrumentation was removed. No implementation follows yet:
current rewriting performs context-sensitive reductions while traversing, so a
template is viable only after classifying how much of the 32,184 entries is
structurally invariant versus argument-dependent.

### 2026-07-31: most heavy-request entries prove no change

Review 77 wraps the recursive rewriter temporarily and classifies each entry by
object-identity preservation and direct parameter-substitution hits. Across the
seven large Codex requests, 71,647 of 90,688 entries return the input object,
79.00%, while only 940 entries, 1.04%, directly hit a substitution. Each
32,184-entry encoder request has exactly 26,663 unchanged entries (82.84%) and
six direct substitution hits. The other requests preserve between 63.80% and
82.77% of their entry objects.

Identity preservation is a lower bound on reusable work, not a complete
dependency proof: a changed parent may only reconstruct around a changed child,
and an unchanged node may still have required inspection. Nevertheless, the
measurement rejects a model in which distinct arguments make most encoder work
intrinsically request-specific. The dominant cost repeatedly establishes that
subtrees do not change.

For two requests with the same function body and captured environment but
substitutions \(\sigma_1\) and \(\sigma_2\), a subtree is reusable when its free
symbol set is disjoint from the parameters on which the substitutions differ,
and its reductions consult no request-varying value. This follows by structural
induction over the pure expression tree. Calls that launch nested
specialization, static lookup through varying values, and binding scopes are
the induction boundaries and must be represented explicitly. The temporary
counters were removed. The next review should measure free-parameter dependency
at subtree granularity rather than infer it from final object identity.

### 2026-07-31: encoder parameter dependence is structurally sparse

Review 78 computes occurrence counts bottom-up on each large factory body. An
occurrence is parameter-dependent when its subtree contains a reference to one
of the factory's parameters. The encoder body has 5,298 occurrences but only 12
dependent occurrences, 0.23%; both 32,184-entry requests share this body. The
protocol encoder has 9 of 4,514, 0.20%. By contrast, `parse_json_document` has
3,007 of 8,618 (34.89%), `parse_json` has 2,283 of 7,088 (32.21%), and each
`parse_json_string` request has 382 of 1,518 (25.16%).

The count follows directly from the free-variable equation
\(FV(n)=local(n)\cup\bigcup FV(child(n))\), intersected with the parameter set.
It is an executable measurement over occurrences, not unique DAG vertices. A
subtree with empty intersection can be rewritten once for a fixed captured
environment and reused for all substitutions. However, the body count alone
does not explain the encoder's 6.07 rewrite entries per source occurrence;
selected branches and recursively constructed expressions create additional
work. A template mechanism should therefore begin with the encoder's 5,286
independent occurrences and retain ordinary rewriting at the 12 dependent
boundary nodes, while parse requests need a different cost decision.

The dependency counters were removed. Before implementation, the next review
must measure whether caching invariant subtree rewrites by source object and
captured environment actually reduces entries, because contextual `values`
lookups can invalidate a parameter-only criterion across environments.

### 2026-07-31: per-request identity memoization is unprofitable

Review 79 implements the narrow safe cache experimentally. Each active request
owns a weak map from expression object to rewritten result. An environment epoch
increments on every lexical `values` insertion, deletion, or restoration; a hit
requires object identity and the same epoch. The substitution environment is
fixed for the lifetime of that request, and nested requests own separate caches,
so the key preserves shadowing and nested-specialization semantics.

Fifteen direct Codex samples in baseline/cache/baseline order measured
pre-specialization rewrite median/MAD 70.379/1.648, 76.230/2.688, and
71.077/3.744 ms. The cache regresses both neighboring baseline medians by 5.15
and 5.85 ms. Focused specialization tests passed, but semantic safety is not a
performance argument; the implementation was removed.

This counterexample distinguishes repeated traversal from repeated
object-and-context pairs. Paying a weak-map lookup at all 130,143 rewrite
entries cannot be justified by the 79% final identity-preservation rate. A
future template must mark invariant regions ahead of execution and bypass them
at their roots; it must not ask a dynamic cache at every visited node. The next
review measures the cache's actual hit rate to quantify that distinction.

### 2026-07-31: epoch-cache hits are too sparse

Review 80 adds temporary hit counters to the rejected Review 79 cache. Codex
records 4,869 hits against the uncached 130,143-entry work count, an upper-bound
hit rate of 3.74%. Editor records 65 against 6,718, 0.97%. Grep, Tar, wav, and
raytracer record zero. A hit may skip more than one descendant entry, so this
ratio is not an exact saved-work fraction, but it establishes the lookup domain:
more than 96% of Codex baseline entries cannot be direct hits.

Let \(L\) be lookup cost, \(H\) hits, \(E\) baseline entries, and \(R\) the
average work avoided per hit. A cache requires \(EL < HR\). With
\(E/H=26.73\), each hit must repay at least 26.73 lookups. The observed 5--6 ms
regression proves that this implementation does not. Precomputed root markers
invert the domain: they pay a branch at candidate roots rather than a map lookup
at all entries. The cache and counters were removed; the evidence closes dynamic
identity memoization for this corpus.

## References

1. Gordon Plotkin and Matija Pretnar. “Handlers of Algebraic Effects.” ESOP
   2009. <https://homepages.inf.ed.ac.uk/gdp/publications/Effect_Handlers.pdf>
2. Daan Leijen. “Koka: Programming with Row Polymorphic Effect Types.” 2014.
   <https://arxiv.org/abs/1406.2061>
3. Daan Leijen. “Type Directed Compilation of Row-Typed Algebraic Effects.”
   POPL 2017.
   <https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/algeff.pdf>
4. Yizhou Zhang and Andrew C. Myers. “Abstraction-Safe Effect Handlers via
   Tunneling.” POPL 2019.
   <https://www.cs.cornell.edu/andru/papers/tunnel-eff/tunnel-eff.pdf>
5. Philipp Schuster, Jonathan Immanuel Brachthäuser, and Klaus Ostermann.
   “Compiling Effect Handlers in Capability-Passing Style.” ICFP 2020.
   <https://se.cs.uni-tuebingen.de/publications/schuster20capability/>
6. Ningning Xie and Daan Leijen. “Generalized Evidence Passing for Effect
   Handlers.” ICFP 2021. <https://xnning.github.io/papers/multip.pdf>
7. Wenhao Tang, Daniel Hillerström, Sam Lindley, and J. Garrett Morris. “Soundly
   Handling Linearity.” POPL 2024.
   <https://www.pure.ed.ac.uk/ws/portalfiles/portal/407801113/Soundly_Handling_TANG_DOA07112023_VOR_CC_BY.pdf>
8. Roger Bosman, Birthe van den Berg, Wenhao Tang, and Tom Schrijvers. “A
   Calculus for Scoped Effects & Handlers.” LMCS 2024.
   <https://lmcs.episciences.org/14832/pdf>
9. WebAssembly Community Group. “Stack Switching Proposal.”
   <https://github.com/WebAssembly/stack-switching>
10. Neil D. Jones, Carsten K. Gomard, and Peter Sestoft. “Partial Evaluation and
    Automatic Program Generation.” 1993.
    <https://www.itu.dk/~sestoft/pebook/pebook.html>
11. LLVM Project. “ThinLTO.” <https://clang.llvm.org/docs/ThinLTO.html>
12. Umut A. Acar, Guy E. Blelloch, and Robert Harper. “Selective Memoization.”
    POPL 2003. <https://www.cs.cmu.edu/~rwh/papers/memoization/popl.pdf>
13. Zoe Paraskevopoulou and Andrew W. Appel. “Closure Conversion Is Safe for
    Space.” ICFP 2019.
    <https://www.cs.princeton.edu/~appel/papers/safe-closure.pdf>
14. W3C GPU for the Web Working Group. “WebGPU.”
    <https://gpuweb.github.io/gpuweb/>
15. Alberto Martelli and Ugo Montanari. “An Efficient Unification Algorithm.”
    ACM TOPLAS 4(2), 1982. <https://doi.org/10.1145/357162.357169>
16. WebAssembly Community Group. “WebAssembly Core Specification: Integer
    Operations.”
    <https://webassembly.github.io/spec/core/exec/numerics.html#integer-operations>
17. Guy E. Blelloch. “Prefix Sums and Their Applications.” CMU-CS-90-190, 1990.
    <https://www.cs.cmu.edu/afs/cs.cmu.edu/project/scandal/public/papers/CMU-CS-90-190.html>
18. Shubhabrata Sengupta, Mark Harris, Yao Zhang, and John D. Owens. “Efficient
    Parallel Scan Algorithms for GPUs.” NVIDIA Technical Report NVR-2008-003,
    2008.
    <https://research.nvidia.com/publication/2008-12_efficient-parallel-scan-algorithms-gpus>
19. Robert Tarjan. “Depth-First Search and Linear Graph Algorithms.” SIAM
    Journal on Computing 1(2), 1972.
    <https://doi.org/10.1137/0201010>
20. Mark Weiser. “Program Slicing.” ICSE 1981.
    <https://doi.org/10.1145/800078.802557>
21. Luc Maranget. “Compiling Pattern Matching to Good Decision Trees.” ML
    2008. <https://moscova.inria.fr/~maranget/papers/ml05e-maranget.pdf>
22. Peter M. Fenwick. “A New Data Structure for Cumulative Frequency Tables.”
    Software: Practice and Experience 24(3), 1994.
    <https://onlinelibrary.wiley.com/doi/10.1002/spe.4380240306>

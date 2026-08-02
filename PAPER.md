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

- Last semantic review: 2026-08-01.
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

#### 3.3.1 Source order is semantic; compiler work order is not

For a block

```text
let x1 <- c1
...
let xn <- cn
r
```

the source semantics evaluates `c1 ... cn` from left to right. Shadowing does
not weaken this rule: resolution gives every binder a fresh symbol identity, but
the newer identity enters the lexical environment only after its right-hand side
returns. The observable behavior includes the returned value, the ordered host
and capability trace, the first trap, termination versus divergence, and
ownership cleanup. A compiler may not infer a different evaluation order from an
unordered effect row.

This is distinct from the order in which the compiler analyzes or lowers the
already-resolved right-hand sides. Once name resolution, typing, effect closure,
and ownership validation have produced one immutable HIR snapshot, compiling two
right-hand sides into private fragments does not evaluate either source
computation. Those compiler jobs may run in any dependency-respecting order if
deterministic assembly restores source order and stable IDs. Section 7.11
derives that weaker and more useful freedom separately from payload reordering.

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
object in that root's reachable DAG once. Input, demanded-input,
rewritten-input, and residual metrics frequently project the same root:

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
The profile reports rewritten blocks and the counterfactual \(\sum_b|E_b|\)
entries that the deleted constructor would have copied. Mutation is confined to
compiler execution state; typed HIR remains immutable.

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
A copy-on-first-change loop can avoid that array, but adds a branch per child
and copies the unchanged prefix when a later child changes. For list length
\(n\) and first changed index \(p\), the lazy alternative is selected only if:

```text
A_array(n) + n(C_map + C_identity)
  > n(C_loop + C_branch) + changed × p C_copy
```

This inequality depends on the JavaScript engine. A 21-sample Codex experiment
falsified it on the measured V8: specialization rewriting regressed 3.65% and
complete compilation 2.14%. The lazy loop was removed. Native `map` plus
identity scan remains the selected transient representation; immutable parent
sharing is still preserved.

Closure lifting admits another product analysis. For a block \(b\) with \(F_b\)
candidate nested functions and \(S_b\) expression nodes, checking each symbol
independently for uses outside direct-callee position costs \(O(F_bS_b)\). A
single traversal can instead collect the set of every symbol used outside a
direct-callee position, making all decisions in \(O(S_b+F_b)\). The equivalence
follows by reference cases: a reference in a direct callee contributes no
member; every other reference contributes exactly its symbol.

That asymptotic improvement is rejected for the current corpus. Applying the
product scan unconditionally to all blocks, including \(F_b=0\), regressed Codex
lifting by 55.80%. Guarding it with \(F_b>0\) restored parity but still changed
the median from 25.083 to 25.125 ms (+0.17%). Most eligible blocks do not have
enough candidate functions to amortize allocation of the set and the extra
traversal machinery. Per-symbol early-exit scanning remains selected until the
measured distribution of \(F_b\) changes.

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
represented in a physically submitted GPU rewrite package; it is zero on CPU and
Core-identity paths. CPU workers were not introduced because cloning the
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
\(L\), and \(H\) host-interface bytes, the skipped work is \(O(N+S+L+H)\).
Normalizing syntax constructs \(O(N)\) transient objects and content encoding
constructs \(O(L)\) string storage. Host identity adds file resolution, reading,
and hashing over \(H\); the semantic host-interface application still reads the
interface at its actual elaboration boundary.

The preservation argument is noninterference. Without a session there is no
cache lookup before elaboration and no insertion after artifact validation.
Deleting the unused key computation cannot change parsing, elaboration, Core,
Wasm, ABI construction, diagnostics, or artifact validation. With a session, the
identity construction and all exact, trailing-trivia, dependency, and
backend-function reuse rules are unchanged.

Profiles enforce the boundary: an independent compilation reports zero
semantic-context and semantic-fingerprint milliseconds and zero fingerprint
reuse. A session compilation retains the existing identity and reuse evidence.

### 6.5 Source-control lowering is a measured fixed point

The current source-control pass applies a whole-module transformation \(L\),
then searches the result for a remaining `loop`, `forRange`, or `forCollection`:

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

\[ \operatorname{remaining}(M) \iff \exists n\in\operatorname{syntax}(M).\;
\operatorname{kind}(n)\in\{\texttt{loop},\texttt{forRange},
\texttt{forCollection}\}. \]

A matching constructor contributes one and traversal continues through its body
and control operands. Stopping at a match would count only the outer frontier
\(F(M)\). That is not a decreasing measure: one outer loop containing two inner
loops gives \(|F(M)|=1\), while removing only the outer loop exposes a frontier
of size two. The complete occurrence count \(\mu(M)=3\) instead decreases to
two. This counterexample requires full descent even when a target has already
been found.

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

\[ O\left(\sum_{i=0}^{P-1}(N_i+S_i)\right), \]

with \(O(\sum_i N_i)\) total reconstructed allocation and \(O(\max_i N_i)\) live
round storage when prior snapshots become unreachable. Typed search changes
\(S_i\) from the complete enumerable object graph to the source-syntax graph and
removes one `Object.values` allocation per inspected object; it does not change
the asymptotic bound.

Termination uses the natural-number measure \(\mu(M)\), the count of residual
source-control constructors, with the obligation

\[ \mu(M)>0 \Longrightarrow \mu(L(M))<\mu(M). \]

The first pass establishes \(r_1=\mu(M_1)\). If \(r_1=0\), lowering finishes in
one pass. Otherwise every later nonterminal result must satisfy \(r_{i+1}<r_i\);
equality or increase fails immediately with the first residual constructor's
kind and span plus both counts. Well-foundedness of natural-number descent then
gives

\[ P\leq r_1+1. \]

There is no numeric pass cap. More than 32 successively exposed layers are
admitted when the measure decreases. Inspection of every lowering constructor
shows it introduces functions, calls, branches, and blocks but no new `loop`,
`forRange`, or `forCollection`; it either removes or preserves source control. A
preserved unsupported position is diagnosed by non-decrease rather than
consuming 32 arbitrary rounds.

The executable profile currently exposes \(P\), first-pass residual count
\(r_1\), its disjoint loop, range-loop, and collection-loop components,
first-pass transformation time, and accumulated later-pass transformation time.
The components must sum to \(r_1\). The transformation times must be contained
by the enclosing control-flow interval; the residual is search and
orchestration. Component counting adds three scalar increments to the existing
complete residual traversal, so it remains \(O(S_i)\) work and \(O(1)\) state.
The frozen Codex program exercises \(r_1>0\), asserts both equalities, and
contains two residual ordinary loops with no residual range or collection loop.

Residual occurrences, AST vertices, and source constructors are different
domains. The immutable syntax representation is a rooted DAG, not necessarily a
tree. Let \(r_i\) count root-to-target occurrence paths, \(u_i\) count unique
target object identities, and \(d_i=|\{(kind,file,start,end):n\in
residual(M_i)\}|\) count source provenances. Then

\[ 0\leq d_i\leq u_i\leq r_i. \]

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

\[ \rho_i = 1 - V_i/O_i. \]

This is an opportunity bound, not a predicted speedup: memo lookup, edge
aggregation, and occurrence multiplicities remain, and the transformation is
context-sensitive even where the search is not.

The evaluated DAG algorithm discovered every vertex and outgoing edge once,
computed incoming-edge counts, seeded root multiplicities, and propagated exact
root-path counts in topological order. For \(E_i\) syntax edges, its cost model
is

\[ T_{dag}=c_vV_i+c_eE_i+c_m(V_i+E_i), \qquad T_{walk}=c_oO_i, \]

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

\[ d_i = G_i-C_i,\qquad \widetilde d=\operatorname{median}_i(d_i),\qquad
\operatorname{MAD}_d=\operatorname{median}_i|d_i-\widetilde d|. \]

Under the nuisance model \(C_i=c+a_i+\epsilon^C_i\) and
\(G_i=g+a_i+\epsilon^G_i\), differencing cancels the pair-local additive term
\(a_i\). Alternating order counterbalances a first-order directional order
effect. The benchmark retains all \(C_i\), \(G_i\), and \(d_i\), because neither
a marginal median nor MAD identifies backend-specific stalls, autocorrelation,
or thermal drift. A reported stage breakdown is one observed profile nearest the
scalar median total, not a vector of independently selected component medians.
Thus `accounted + unattributed = total` and all stage percentages refer to a
possible execution. Parser sub-stage reports select an observed parse by the
same rule. A p95 is reported only for at least 20 retained observations; below
that threshold the record exposes the maximum and an `insufficient` tail status.
Twenty is an instrument policy, not a proof of estimator precision. Medians,
MADs, and p95 values remain descriptive statistics; without independent process
repetitions and uncertainty intervals they do not establish a general speedup.

For positive adjacent times (L_i,R_i), comparison records both

\[ \Delta_i=L_i-R_i \quad\text{and}\quad \rho_i=\log(L_i/R_i). \]

The difference estimates additive latency cost. The log ratio is symmetric under
exchanging alternatives, composes additively, and its reported scale factor is
\(\exp(\operatorname{median}\rho_i)\). A ratio of independently selected
marginal medians is retained only when labeled descriptive; it is not the paired
estimator. Each stage vector used for explanation is selected from one observed
execution nearest the median total. Consequently the measurement algebra cannot
construct an impossible execution by independently selecting component medians.

Iterations are nested inside fresh runtime processes. The executable recorder
runs processes sequentially so their device work does not overlap and retains
every process result. Process results are not flattened into one artificial
sample: within-process pairs estimate short-timescale effects, while variation
between fresh processes exposes initialization, JIT, allocator, and thermal
state. The current records are descriptive at both levels; a confidence
procedure remains unimplemented.

For a batch size \(N\), observed latency break-even is the predicate
\(\operatorname{median}_i(G_{N,i}-C_{N,i})\leq 0\). The difference of the two
marginal medians is not substituted for this estimator. If the predicate is
false for all \(N\) in a finite measured set \(S\), the only valid conclusion
without a monotonicity proof is “not observed through \(\max S\).” In
particular, \(\max S\) is not a lower bound on a future crossover.

Executable evidence consists of capacity-boundary tests, device-loss recovery,
physical-batch isolation tests, generated CPU/GPU differentials for type
closure, deliberately noncanonical Core packages and Wasm plans, and the
six-target release gate requiring construction-certified Core identity plus GPU
Wasm emission. These establish implementation behavior for tested inputs; they
do not prove arbitrary kernels correct.

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
is a constant-work certificate supplied by the empty-commit law in Section 7.3.
A nonempty accepted batch returns a new package and still requires inflation and
validation.

Reusing \(M\) removes one complete traversal and allocation of the structured
Core graph. It also avoids source-provenance, type, layout, block, operation,
and value reconstruction. The exact saved byte count is engine-dependent because
the structured graph uses JavaScript objects and arrays, so the implementation
reports the inflation stage as exactly zero work rather than claiming a portable
allocation formula. This does not remove rewrite matching.

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

The exact constant attribute and payload are deliberately absent from \(H\). Let
\(O\) be the operation count, \(H_S=\{o\mid H(S,o)\}\), and let the exact
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
scheduled lanes are \(64\lceil|C|/64\rceil\), replacing \(64\lceil O/64\rceil\).

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
re-encode those invariants as validation records because it can neither commit a
mutation nor manufacture trusted Core: it can only return a proposal that must
satisfy the independent matcher equation below.

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
operation, result, and rule IDs. At most one proposal claims an operation. Let
\(A\) be the resulting accepted sequence. Batch application is defined by:

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

For a length atom with range \([r,r+c)\), its encoded value is \(p_{r+c}-p_r\).
Thus the same boundaries resolve both nested lengths and output placement. When
\(B\leq 2^{16}-1\), every boundary fits in `u16` and two are packed per `u32`:

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
\(\lceil(A+1)/2\rceil\) words rather than the \(A+1\) logical boundaries. Output
capacity is exactly \(4\lceil B/4\rceil\), and readback contains only that
output.

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
eight-atom group. The construction therefore performs \(A\) local shifts/ORs but
only \(\lceil A/8\rceil\) typed-array stores; per-atom read/modify/write is
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
it has less lookup work. Within ranked lookup, the rank word supplies the
preceding eight-atom groups and one bit-parallel expression supplies the
within-group byte count. Byte has tag zero, so for kind word \(x\):

```text
n = x | (x >> 1) | (x >> 2) | (x >> 3)
z = (~n) & 0x11111111
m_i = (1 << (4(i mod 8))) - 1
within_byte_rank(i) = popcount(z & m_i)
```

At bit \(4q\), \(n\) is set exactly when one of the four bits in nibble \(q\) is
set; shifts from the next nibble cannot reach bit \(4q\). Thus \(z\) has exactly
one bit for every zero-tag byte atom, and \(m_i\) retains exactly the preceding
nibbles. A byte lane indexes its packed stream by the resulting total rank; a
non-byte lane uses `atom_id - byte_rank`. Both are exactly the stable ranks of
their variants, so they recover the same low word as dense indexing.

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
scalar atom and zero for a length atom, and define \(P_0(t)=\sum_{i<t}s_0(i)\).
Length atom indices are kept in source order. A Fenwick tree [22] stores encoded
sizes only for length atoms from completed dependency levels. For a length range
\([u,v)\):

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
that rank directly; no atom-to-position map is reconstructed. The implementation
selects sparse sizing only when \(E_s<E_d\), so ties retain the allocation-free
direct loop. The scalar prefix reuses the final offset vector and the sparse
path adds one \(8(K+1)\)-byte tree. Tree sums use exact 53-bit JavaScript
integers so an invalid plan cannot wrap before the u32 module-size boundary
rejects it. This avoids the \(O(JK)\) counterexample of rebuilding a sparse
prefix after every dependency level and the \(JA\) work of rebuilding dense
prefixes. Validation still reads \(D\) dependencies independently; only sizing
uses the selector.

Rank construction and packing remain \(O(A)\). Four adjacent packed bytes are
accumulated before one physical-word store, reducing byte-stream stores from
\(Q\) to \(\lceil Q/4\rceil\). Ranked GPU lookup now has four constant shifts,
three ORs, three masks/complements, and one population count rather than zero to
seven data-dependent tag comparisons. Rank lookup adds one shift and mask on the
16-bit path. Its two adjacent ranks are likewise assembled before one physical
word store. Five frozen targets use 16-bit ranks; Codex uses 32. Relative to
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
+ 16K + 4n          payload-relative length frontier and module bases
+ 8(H + 2)          alternating hierarchy sums and prefixes
+ 16(|J| + 2h - 1)  per-pass uniforms
```

The old inclusive-prefix readback word exactly offsets the new vector's one
extra boundary word, so neither appears in the difference. The additional
payload word per length and base word per module are the price of virtual packed
relocation: they remove an \(O(A)\) rebasing copy. Packed batches add
device-required alignment between logical jobs; it does not change this per-job
model. Host analysis work is \(O(A+D+\min(D,A+K\log K))\): validation retains
\(D\), while length sizing chooses the smaller modeled representation.

The default verification for a GPU policy independently evaluates the length DAG
on the CPU and compares every emitted byte. It deliberately retains direct range
summation rather than sharing the adaptive GPU-boundary analysis. Inspection
validates scalars, records their exact widths in a one-byte column, and
accumulates their total width. Let

```text
rankL(i) = |{j < i | atom j is a length}|
```

Validation records `rankL` in every length-frontier entry. The topological
direct fold records each derived payload width in an eight-byte column indexed
by `rankL`, records its LEB width in the atom-width column, and adds that width
to the total. Strict dependency-level descent proves by induction that every
range width is available before its consumer.

After allocating the exact result, one source-order pass writes each byte or LEB
value directly at a rolling offset. The width functions and writers implement
the same stopping predicates, so each writer advances by exactly the validated
width. Induction over source order proves that the final offset is the
accumulated module width and that concatenation order is preserved. The oracle
performs \(2A+2D\) atom/range visits plus \(B\) output-byte writes and uses
exactly \(A+8K+B\) logical typed-array bytes. It allocates no internal per-atom
encoding arrays, reference vector, canonical byte table, or value cache. Public
LEB encoders remain checked array-returning boundaries.

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
\(E_0\) be the source equalities. The required equivalence relation \(\equiv\)
is the least relation satisfying:

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
child equalities and retains the lower-ID witness. The two old witness stars
plus these new edges form one star, proving the inductive step. Each successful
union reduces the class count; equality-pair deduplication and finite
constructor arity therefore establish termination. At the fixed point, the
partition contains \(E_0\), is constructor-injective, and adds only injectivity
consequences, so it is exactly the least constructor congruence.

For \(T\) flat terms, \(E\) source equalities, \(P\) child-equality proposals,
\(K\leq P\) distinct child equalities added to the certificate, and \(M=E+K\),
the worklist uses \(O(T+M)\) memory and \(O((T+E+P)\alpha(T))\) work under
word-sized equality keys. It performs at most \(T-1\) constructor-witness
comparisons. The prior frontier algorithm repeatedly scanned all terms and
re-emitted the complete witness star, costing \(O(F(T+P)+(E+K)\alpha(T))\) for
\(F\) nonempty frontiers. Sparse quotient-cycle detection takes \(O(T+D)\) work
and memory for \(D\) distinct constructor-child edges. The GPU validation uses:

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
capacity, and atomic insertion order would add unproved failure and determinism
obligations. Removing the CPU closure additionally requires a GPU-produced
derivation forest proving that every union follows from an input equality or
equal-constructor child position, plus independently checkable clash and
acyclicity certificates.

The production boundary deliberately discards this experiment. CPU inference has
already accepted or rejected the program and owns every type consumed by
specialization and Core lowering. A successful GPU result was not used
downstream; an unavailable result only introduced a second failure condition;
and invalid source had already failed before device work. Therefore removing the
call preserves accepted artifacts and language diagnostics while eliminating one
sequential submission/readback. Required-GPU mode still requires the
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

### 7.8 Certified fixed-width SIMD

SIMD exists at three distinct levels in this compiler:

1. a **payload vector** is a value in the user's program;
2. a **vectorization plan** is compiler evidence that several scalar payload
   operations may be replaced by payload-vector operations; and
3. a **GPU subgroup** is a set of compiler-execution invocations that the WebGPU
   implementation may execute together.

These levels do not share a width or a semantic identity. WebAssembly has one
128-bit vector value type whose lane interpretation is selected by each
instruction [27]. WebGPU subgroups are device-selected powers of two between 4
and 128 invocations, and WGSL defines no relationship between subgroup IDs and
local invocation indices [14]. Consequently Ducklang's vector width is derived
from the Wasm payload target, never from the GPU that happens to compile it. A
WGSL `vec4<f32>` used inside a compiler shader is likewise an ordinary shader
value, not four Ducklang computations and not proof of fourfold hardware
throughput.

#### Payload-vector calculus

Let `bits(i32) = bits(f32) = 32` and `bits(i64) = bits(f64) = 64`. A payload
vector type is

```text
Vec<W,T> where W bits(T) = 128
```

for `T in {i32, i64, f32, f64}`. This gives the initial shapes `i32x4`, `i64x2`,
`f32x4`, and `f64x2`. Smaller integer lanes may be added only with their own
source types and widening rules; a typeless `v128` is not admitted to Core
because it would make a lane interpretation implicit. The current source surface
exposes only `f32x4`. Fixed width is intentional: scalable or hardware-native
vector lengths would either make source types depend on the compiling adapter or
require a second, predicated backend model that Wasm `v128` does not implement.

The semantic operations are:

```text
pack      : T^W -> Vec<W,T>
splat     : T -> Vec<W,T>
extract   : Vec<W,T> x Fin(W) -> T
replace   : Vec<W,T> x Fin(W) x T -> Vec<W,T>
shuffle   : Vec<W,T> x Vec<W,T> x Fin(2W)^W -> Vec<W,T>
map_op    : Vec<W,T>^arity -> Vec<W,T>
compare   : Vec<W,T> x Vec<W,T> -> Mask<W,T>
select    : Mask<W,T> x Vec<W,T> x Vec<W,T> -> Vec<W,T>
```

`Fin(n)` is a compile-time integer in `[0,n)`. `Mask<W,T>` is a distinct Core
type, not a numeric vector or a product of source Booleans. It lowers to a Wasm
vector with an all-zero false lane and an all-one true lane of `bits(T)`. Making
masks distinct prevents arithmetic from accidentally consuming comparison
evidence while still matching Wasm's bit-select representation.

All admitted operations are pure values. For a lane-wise scalar operation `op`,
their meaning is pointwise:

```text
extract(map_op(v1, ..., vk), l)
  = op(extract(v1,l), ..., extract(vk,l))
```

for every `l in Fin(W)`. Integer arithmetic wraps exactly as the corresponding
Wasm scalar operation. Floating arithmetic uses the corresponding standard Wasm
lane operation with the same operand order and permitted result set.
Vectorization may not reassociate a floating expression, contract a multiply and
add, discard signed zero, or strengthen Wasm's permitted NaN results. A
differential oracle compares exact bits for non-NaNs and compares the permitted
Wasm result sets for NaNs; bit reinterpretation makes a NaN payload observable,
so a transform involving reinterpretation needs an exact bit-preservation proof.
The relaxed-SIMD proposal explicitly weakens determinism [32]. Its operations
therefore require a separate source policy and target feature and are not
enabled by an optimization level.

The selected Wasm target profile is part of the artifact identity:

```text
wasm-scalar
wasm-simd128
```

An explicit vector program or an accepted vectorization plan requires
`wasm-simd128`; it is not silently scalarized after planning. Standard-vector
operations lower one-for-one where Wasm has the operation, while `pack` may
lower to `splat` plus lane replacements. Vector values remain internal to Wasm
payload functions. The JavaScript Wasm interface throws `TypeError` when a
called imported or exported function has a `v128` parameter or result [28], so
the managed ABI must reject such signatures. Crossing that boundary later would
require an explicit memory-copy representation, not an undocumented host
coercion.

#### Vectorization as a checked plan

Automatic vectorization runs after effect lowering, ownership validation, and
Core construction, but before Wasm stackification. It never mutates its input
while discovering candidates:

```text
Core snapshot
  -> discover candidates
  -> prove legality
  -> construct and cost Vector Plans
  -> choose a deterministic non-overlapping plan set
  -> validate the chosen successor
  -> commit once
```

This mirrors the legality/plan/execute separation in LLVM's VPlan design [30]
and this compiler's existing snapshot/propose/resolve/commit discipline. The
scalar snapshot is always a candidate. A rejected or unprofitable plan is the
identity transformation, and plan allocation history cannot affect output IDs.

The first automatic transform is basic-block SLP. Larsen and Amarasinghe define
SLP by packing independent isomorphic statements in a basic block and note that
packing and unpacking can erase the gain [29]. Let a pack candidate
`P = <s_0,...,s_(W-1)>`. The judgment

```text
Gamma; Omega; Sigma |- P => V : Vec<W,T> ! empty
```

holds only when all of the following certificates exist:

1. every `s_l` has the same scalar opcode, type, and immediate attributes;
2. corresponding operands are an existing vector, a splat, or another legal pack
   with the same lane order;
3. every scalar dependency remains within one lane, except for an explicit
   shuffle or separately proved reduction;
4. every packed operation has an empty residual effect row and is total on the
   proved operand domain;
5. no source diagnostic, trap, resource move, or host observation is reordered
   or discarded; and
6. the vector result's uses can be represented by vector uses, legal extracts,
   or a scalar remainder without changing source order.

The empty-effect and totality restriction is the initial rule, not a claim that
all effects prevent vectorization. In the more general judgment, write
`epsilon_i >< epsilon_j` when executing lane effects `i` and `j` in either order
is observationally equivalent. All lane pairs must satisfy this relation,
outputs must be disjoint, errors must reduce in deterministic source order, and
a linear resource must have one destination. This is the payload analogue of the
segmented compiler-work condition recorded in Section 13. No present
implementation derives general effect commutativity, so admitting it now would
turn an obligation into an assumption.

Predication is also semantic. Replacing

```text
if c_l then a_l else b_l
```

with an eager vector `select` evaluates both arms. This is legal only when both
arms are pure and total and their values are otherwise unobservable. A trap,
host effect, ownership transfer, or resumable effect in either arm retains
control flow. General masked control and scalar lane replication are deferred
until their recipes preserve the same rule.

Loop vectorization requires more evidence than SLP. For a canonical induction
variable over `N` elements and width `W`, define

```text
q = floor(N / W)
r = N mod W
```

The vector loop executes exactly `q` iterations and a scalar epilogue executes
exactly `r`. It never reads padding. Wasm vector memory operations trap if any
accessed byte is out of bounds [27], so a width-`W` load of `T` at byte address
`p` requires a proof of the entire half-open footprint `[p, p + W bits(T)/8)`. A
read pack may share one immutable borrow. A write pack requires a unique region
owner and pairwise-disjoint lane footprints. A load/store group additionally
requires affine contiguous addresses, or an explicit gather/scatter recipe with
its own target lowering and cost.

The current managed-buffer Core exposes runtime calls rather than typed raw
memory regions. It therefore cannot prove vector load/store footprints or emit a
direct `v128.load/store` without changing the payload ABI. Automatic loop memory
vectorization is consequently **not yet soundly representable**. Its
prerequisite is a typed region IR whose bounds, alias, alignment, and ownership
facts survive to the vectorization point. Alignment may affect cost but not Wasm
validity because Wasm permits unaligned access; bounds remain mandatory.

Loop-carried dependencies reject a plan unless represented by a proved
reduction. A reduction needs an identity and an associative operation over its
actual semantic domain. Wrapping integer addition is associative modulo `2^n`.
Floating addition is not associative, so strict mode retains source order. A
future relaxed numerical policy may admit reassociation, but the policy, error
contract, and changed result set must be visible in the source or artifact
target rather than inferred from a benchmark.

Each immutable `VectorPlan` contains the vector factor, scalar statement IDs,
lane mapping, recipes, required target features, bounds and alias witnesses,
runtime guards, scalar epilogue, and cost terms. Candidate ordering is the
stable tuple `(function_id, block_id, first_operation_id, recipe_id)`. Conflict
resolution accepts a deterministic maximal non-overlapping set. Validation
rechecks types, lane domains, dependencies, effects, ownership, footprints,
target features, and scalar fallback reachability before commit.

The implemented `f32x4-slp-v1` schema specializes that general form to the proof
domain it can currently discharge. It records factor four, element `f32`,
required target `wasm-simd128`, empty residual effect, `not-applicable`
ownership, input-snapshot fallback, function and block IDs, four scalar
operation and result IDs per group, two pack recipes, extracted lanes, and both
scalar and vector recipe costs. Bounds, aliases, guards, and a scalar epilogue
are absent because this schema admits neither memory nor loops; adding
placeholder witnesses would falsely suggest that those obligations had been
proved. Validation rediscovers the canonical plans from the immutable snapshot
and requires exact schema equality. A changed profit, lane, recipe, or operation
ID is rejected before conflict resolution.

Candidate discovery admits four same-operator `f32` scalar arithmetic operations
in one block. Constants may occur between their definitions, but any other Core
operation is a scheduling barrier. No lane may depend on a result inside its own
pack. A source is classified as a previous vector only for an exact four-value
result tuple, as a splat for one repeated SSA value or four type-equal constants
related by `Object.is`, and otherwise as a four-value pack. The `Object.is` rule
deliberately distinguishes `+0` from `-0`; it does not perform approximate
constant equality. Chains grow only along explicit packed def-use dependencies.
This restriction makes the empty-effect, totality, and no-reordering premises
executable structural checks for the initial arithmetic fragment.

Standard Wasm scalar and vector floating operations may choose different
permitted NaN payloads. Because Ducklang exposes `i32.reinterpret_f32`, those
payload bits can become observable. The initial automatic pass therefore returns
identity for any module containing that observer. This whole-module condition is
conservative: a future bit-observability analysis may prove a particular vector
candidate cannot reach the reinterpretation, but ordinary reachability or
numeric equality is insufficient. Explicit source SIMD remains available because
it states the vector semantics directly; the restriction applies to an automatic
scalar-equivalence claim.

Define `scalarize(V)` as the ordered tuple of scalar lanes represented by a
vector recipe. The plan-correctness obligation is

```text
validate_vector_plan(S, P) = accepted
-------------------------------------------------
observe(commit(S, P)) = observe(S)
```

where observation includes the return value, trap behavior, host-effect trace,
owned-resource disposition, and strict numerical result set. For initial pure
SLP, the proof is induction over the acyclic recipe graph: leaves are packs or
splats, the pointwise equation proves lane-wise recipes, shuffles prove an index
bijection, and extracts are projections. The empty effect row makes both traces
empty. For a loop plan, the integer identity `N = qW + r` proves that vector
iterations and the scalar epilogue partition the original iteration domain
without overlap or omission. Typed-region footprints then prove that each memory
observation belongs to the same iteration. Predication, reductions, and relaxed
floating operations require additional cases and are not smuggled into this
initial induction.

#### Profitability and break-even

Legality does not imply profitability. Let one scalar iteration cost `c_s`, one
vector iteration cost `c_v`, and let `h` include runtime guards, packing,
unpacking, shuffles, extracts, and spill cost. For `N = qW + r`:

```text
T_scalar(N) = N c_s
T_vector(N) = h + q c_v + r c_s
```

When `r = 0`, a runtime break-even exists only if `W c_s > c_v`, and then

```text
N > W h / (W c_s - c_v).
```

For `K` isomorphic arithmetic operations already kept packed, the local saving
condition is

```text
K (W c_op - c_vec_op)
  > c_pack + c_unpack + c_shuffle + c_extract + c_spill.
```

This equation explains why the planner should grow packs through use-def chains
instead of vectorizing isolated additions. Values loaded and stored contiguously
can have zero explicit pack/unpack recipes; arbitrary scalar values cannot.
Register pressure is represented by predicted live vector values and a measured
spill penalty, not assumed away.

The current uncalibrated reference cost gives one unit to a scalar operation,
vector operation, splat, and extract, four units to an arbitrary scalar pack,
and zero units to reuse of a previous vector. For (G) four-lane groups, (P)
packs, (S) splats, and (E) extracts it accepts only when

```text
C_scalar = 4G
C_vector = G + 4P + S + E
C_scalar - C_vector > 0.
```

These are recipe-count units, not cycles. They prevent obvious instruction
expansion and explain every accepted plan, but they are not yet a calibrated
runtime predictor. In particular they contain no live-vector spill term and
cannot justify a universal speedup claim. The benchmark below exposes cases
where positive modeled profit is neutral or slower in V8, so target-specific
calibration remains a prerequisite for treating this heuristic as a performance
theorem.

Let `O` be scalar operations in the selected blocks, `D` their def-use edges,
`C` the bounded candidate packs, `R_p` plan recipes, and `E_p` recipe edges.
Unrestricted choice of `W` operations from an opcode bucket would create
`choose(n,W)` candidates and is rejected. Discovery instead forms at most `W`
width-`W` windows per operation in stable opcode/type buckets and
contiguous-memory seeds. Thus `C <= W O`, and fixed Wasm widths make `C = O(O)`.
Candidate construction and validation then require

```text
work = O(O + D + C + R_p + E_p)
storage = O(C + R_p + E_p).
```

The CPU reference realizes the linear-work bound by constructing each function's
value-type and def-use maps once, indexing four-value result tuples, tracking
uncovered scalar uses incrementally across prefixes, and indexing canonical
serialized plans once before conflict resolution. Earlier drafts searched the
whole function for every operand and searched every prior vector group for each
recipe, which made the implementation quadratic despite the stated model; those
searches are not retained. Current plans are JavaScript records, so their
physical bytes depend on V8 object layout and no portable typed-array byte
equation is claimed. A future GPU planner must first choose a flat plan schema
and state that schema's exact word count.

A concrete implementation must replace this asymptotic storage claim with its
typed-array byte equation. On the GPU execution path, classification, stable
grouping, recipe-frontier expansion, conflict resolution, and count-scan-write
rebuild are separate immutable phases. Recipe expansion has one global
dependency per use-def depth; all other phase boundaries need at least one
dispatch dependency. Thus vectorization is not “free parallelism”: its reported
compiler cost includes candidate bytes, frontier depth, scheduled invocations,
dispatches, scans, and successor bytes. Empty head buckets use the existing
identity law and allocate no plan or successor package.

Instruction throughput is only one ceiling. With operational intensity `I`,
sustainable memory bandwidth `BW`, and peak vector compute rate `P_peak`, the
Roofline bound is [31]:

```text
P_attainable <= min(P_peak, BW I).
```

SIMD usually reduces instructions but does not reduce compulsory payload bytes.
A memory-bound kernel therefore cannot be assigned a `W`-fold prediction. Layout
transformations may raise `I` or improve coalescing, but their copy bytes and
lifetime enter `h`. Structure-of-arrays is preferred for compiler columns
because a compiler pass usually consumes one field from many records; payload
vectors use contiguous 16-byte lane groups because that is the Wasm operation's
footprint. Neither layout is universally superior.

Vector planning also consumes compiler time. If a generated function is expected
to run `R` times, the end-to-end decision is

```text
Delta_total = Delta_compile + R Delta_run < 0.
```

Each delta is `vector - scalar`, so a negative value is an improvement.

The compiler reports `Delta_compile` independently from payload-runtime
measurements. It may use a target-calibrated recipe table to predict
`Delta_run`, but a recipe cost is an empirical parameter keyed by engine,
architecture, target profile, and operation family. A cost table from the RTX
GPU that runs compiler shaders is irrelevant to the CPU or Wasm engine that runs
the payload. Without a profile estimate for `R`, the default planner may choose
a plan only when it predicts lower steady-state runtime and stays within the
explicit compile-time budget; it must not claim an end-to-end speedup.

#### Compiler-execution SIMD and subgroups

Compiler shaders continue to schedule one logical compiler job per invocation
unless a separate data-layout proof and measurement justify record packing.
Replacing four scalar column accesses by one WGSL `vec4` may improve transaction
shape, do nothing, or increase register pressure. It is selected only when the
four records are contiguous, equally active, independently legal, and the
measured traffic plus occupancy model predicts a gain.

Subgroup collectives are a separate optional backend for scans, ballots,
reductions, and compaction. They require the WebGPU subgroup feature, execute in
subgroup-uniform control flow, and are parameterized by the reported subgroup
size. No algorithm may derive source order or a flat-array neighbor from
`subgroup_invocation_id`, because WGSL does not specify that mapping. Exact
integer associative collectives may be deterministic; floating reductions and
order-sensitive diagnostic selection are not admitted. Every subgroup path
retains the current workgroup/global algorithm as a differential reference and
must earn inclusion through a measured dispatch, traffic, and occupancy
reduction.

#### Status and executable obligations

Core now represents vectors and masks explicitly rather than treating `f32x4` as
a scalar spelling. The flat schema round-trips both kinds and explicit shuffle
lanes. The source fragment implements `f32x4` make, splat, four arithmetic
operations, six comparisons, select, four extracts, and four lane replacements.
The Wasm backend emits strict SIMD128 operations, byte-expanded `i8x16.shuffle`,
and the correct Wasm operand order for bit-select. The `wasm-scalar` target
rejects any internal vector or mask, and the managed JavaScript boundary rejects
vector imports and exports.

Executable validation observes explicit lanes and automatic SLP through scalar
results. It covers arithmetic, comparisons, select, replacement, shuffle,
subnormal and signed-zero bits, NaN comparison behavior, invalid shuffle lanes,
target rejection, ABI rejection, forged-plan rejection, non-operation-crossing,
empty-plan snapshot identity, and multiple non-overlapping plans in one block.
Generated Core fixtures compare scalar and vector Wasm for negative zero, the
minimum positive `f32` subnormal, infinity, and NaN. These tests are executable
evidence for the implemented `f32x4` fragment, not a proof for unimplemented
integer vector operations or every Wasm-permitted NaN payload. An additional
identity test places `i32.reinterpret_f32` after a profitable chain and proves
the conservative bit-observer boundary suppresses every plan.

The compiler runs SLP only for `wasm-simd128`, after scalar Core rewriting and
before Wasm planning. It profiles validation, planning, rebuild, successor
flattening, candidate windows, proposed and accepted plans, scalar operations,
vector operations, packs, splats, extracts, and both estimated costs. An empty
accepted set returns the exact input object and constructs no successor. A
nonempty set is rebuilt once, fully validated, and re-flattened so the
structured and flat optimized artifacts describe the same module. This CPU
reference establishes semantics and cost observability; it is not yet a GPU
vector-plan implementation.

Remaining obligations are deliberately narrower:

1. add integer vector source operations and their boundary conformance before
   claiming the full `Vec<W,T>` family executable;
2. calibrate recipe and spill costs per Wasm engine across chain length and
   live-vector pressure, and decide an explicit compile-time budget;
3. define typed memory regions and prove bounds, aliasing, ownership, and scalar
   tails before implementing loop memory vectorization;
4. add reductions only for a proved monoid or an explicit relaxed numerical
   policy; and
5. evaluate WebGPU subgroup compiler algorithms independently from payload SIMD,
   retaining non-subgroup differential references.

The semantic rules are specification obligations, the named tests are executable
validation, and the following timings are empirical measurements. None is
silently promoted into a proof.

The frozen SIMD microbenchmark ran on 2026-08-01 with Deno 2.9.4, V8 15.0.245.2,
and an AMD Ryzen 7 7800X3D. The later protocol audit found that its compiler
harness warmed only SIMD and always measured scalar before SIMD, contrary to the
claimed alternating protocol. The timing columns below are therefore historical
diagnostics, not admissible comparative evidence. Deterministic work counts and
artifact sizes remain valid. The corrected harness warms both targets and uses
16 balanced scalar-first/SIMD-first compiler pairs. Runtime samples use one
instantiated module per target, 100,000 calls per sample, 32 balanced samples, a
consumed checksum, and distinct per-chain constants to prevent cross-chain
common-subexpression collapse. The RTX 4080 SUPER does not execute these payload
operations; it is irrelevant to this table.

| independent six-operation chains | source bytes | scalar/SIMD compile ms | SIMD stage ms | scalar/SIMD ns per call | scalar/SIMD Wasm bytes | modeled scalar/vector cost |
| -------------------------------: | -----------: | ---------------------: | ------------: | ----------------------: | ---------------------: | -------------------------: |
|                                1 |        1,205 |          5.238 / 6.032 |         0.606 |         19.692 / 19.193 |              375 / 287 |                    24 / 20 |
|                                2 |        2,267 |          6.064 / 7.887 |         0.820 |         18.345 / 18.596 |              699 / 523 |                    48 / 40 |
|                                4 |        4,398 |        14.587 / 17.125 |         1.444 |         29.731 / 25.974 |            1,347 / 995 |                    96 / 80 |
|                                8 |        8,662 |        17.620 / 18.435 |         2.622 |         35.125 / 26.642 |          2,834 / 2,024 |                  192 / 160 |
|                               32 |       35,463 |       99.227 / 113.366 |        11.830 |        137.413 / 98.184 |         11,954 / 8,768 |                  768 / 640 |

SIMD reduces emitted bytes by 23.5%, 25.2%, 26.1%, 28.6%, and 26.7% in these
five cases. It increases median compilation by 15.2%, 30.1%, 17.4%, 4.6%, and
14.2%. At 32 chains, the SIMD stage decomposes into 2.045 ms validation, 4.131
ms planning, 0.356 ms rebuild, and 5.165 ms structured-to-flat reconstruction;
their 11.697 ms sum lies below the 11.830 ms enclosing interval. The remaining
0.133 ms is instrumentation and call-boundary remainder, so the profile
containment invariant holds.

In that diagnostic run, observed execution was not monotone at the smallest
sizes: two chains were 1.4% slower despite positive recipe profit, while four,
eight, and 32 chains are 12.6%, 24.2%, and 28.5% faster. This is a
counterexample to treating the current recipe units as calibrated cycles. Using
independent median differences in the end-to-end equation gives approximate
amortization counts of 676 thousand, 96 thousand, and 360 thousand calls for
four, eight, and 32 chains; the two-chain case has no break-even in this sample.
The one-chain difference is only 0.499 ns and is too small to use as a
threshold. These estimates are empirical hypotheses for this V8 and CPU, not
portable planner constants.

`deno task benchmark:simd` runs the corrected protocol, retains raw paired
differences and log ratios, and rejects a scalar/SIMD result mismatch or an
unexpected accepted-plan count before reporting timings.

### 7.9 Advisory branch likelihood and resolved computations

WebAssembly branch likelihood is code metadata, not a payload opcode. The
standardized branch-hint format attaches a one-byte `likely` or `unlikely`
payload to an existing `if` or `br_if`; the payload describes whether that
instruction's condition is likely to be true [33]. It lives in the custom
section `metadata.code.branch_hint`, and therefore has no validation or
execution semantics. A conforming implementation may ignore custom metadata
[27]. The source calculus, Core instruction set, and observable program are
unchanged by a hint.

This distinction gives the governing erasure obligation. Let `erase_hints`
remove only branch-hint metadata from a module, and let `Obs` include return
values, traps, host-effect traces, and resource disposition:

```text
erase_hints(emit(P, H)) = emit(P, empty)
-------------------------------------------------
Obs(emit(P, H)) = Obs(emit(P, empty))
```

The byte equality is over the semantic sections after removing the named custom
section, not over the complete artifacts. The observational equality follows
from Wasm custom-section erasure; it does not depend on the hint being accurate.
An inaccurate hint is a performance defect, never permission to remove a check,
speculate an effect, alter a trap, or weaken synchronization.

#### Strict values, delayed computations, and memoizing cells

Ducklang remains call-by-value. A compile-time `ConstValue` resolved during
specialization is substituted and erased before Core, so no runtime resolution
test exists to annotate. If control-flow and use analysis prove a residual
value's state, ordinary specialization and dead-code elimination must remove the
test before branch hinting is considered. Metadata is only for a genuinely
dynamic residual branch.

Future source-level delay must be explicit. Three constructs have different
semantics and must not share one convenient runtime representation:

```text
Delay<T, epsilon>  force repeats the latent computation and epsilon
Once<T, epsilon>   force consumes the owner and performs epsilon once
Need<T>            force shares one empty-row computation and memoizes its value
```

`Delay` is an ordinary closure-like computation and has no resolved state.
`Once` follows existing ownership: after its consuming force there is no legal
second observation, so a resolved fast path would be unreachable. The initial
`Need` is restricted to an empty effect row. Memoizing a general effectful
computation would change effect multiplicity and move its occurrence to the
first dynamic force; that requires a separate source construct and trace
semantics, not an optimizer heuristic. In particular, the absence of
user-shareable mutable references does not by itself make effectful memoization
observationally pure.

For `Need<T>`, the selected sequential runtime state is the finite sum

```text
NeedState<T> = Suspended(environment, expression)
             | Evaluating
             | Resolved(T)
```

and `force` has the transitions

```text
force(Resolved(v))  -> (Resolved(v), v)
force(Suspended(e)) -> Evaluating -> evaluate(e) -> Resolved(v) -> v
force(Evaluating)   -> cyclic-force trap
```

This is a heap-update implementation of explicit call-by-need sharing [34]. The
`Evaluating` state makes recursive forcing deterministic instead of recursively
allocating until an incidental resource failure. A source value still has no
mutable reference to the cell: the update is private runtime representation
state justified by the `Need` abstraction. Catchable failure is not cached in
this initial model; adding `Failed(error)` would require a rule for failure
identity and repeated observation.

This state machine is sequential. If a future Wasm-threads target permits two
agents to force one cell, the state transition and publication of `v` require a
separate atomic memory-ordering proof. A branch hint neither elects the
evaluator nor publishes the result. Until that proof exists, shared concurrent
`Need` is outside the admitted language.

#### Deriving the useful polarity

Suppose demanded thunk `i` is successfully entered `k_i >= 1` times. Exactly one
entry observes `Suspended`; the remaining `k_i - 1` entries observe `Resolved`.
For `D` distinct demanded thunks and `F = sum_i k_i` total successful force
entries,

```text
resolved observations   R = sum_i (k_i - 1) = F - D
suspended observations  U = D
p_resolved                = R / F = 1 - D / F
```

Therefore `p_resolved > 1/2` exactly when `F > 2D`: the mean demanded thunk must
be forced more than twice. A thunk forced once has resolved probability zero; a
thunk forced twice is exactly balanced. This is a proved counting identity for
the selected state machine, not evidence that any real workload has a particular
`F/D` ratio. Never-forced thunks contribute allocation cost but no force-branch
observation.

Hint polarity follows the emitted condition, not the source-level story:

```text
state == RESOLVED
if                    ;; likely means the resolved fast path is likely
  return cached_value
else
  evaluate_and_update
end

state != RESOLVED
br_if slow_path       ;; unlikely means the slow-path branch is unlikely
```

Condition inversion must invert the metadata. Layout, stackification, and
peephole passes either preserve the condition truth value and its hint together,
invert both, or discard the hint. Copying “resolved is likely” onto a `br_if`
whose true condition means unresolved is a polarity bug.

Static reference counts are only upper bounds when branches or loops control
forces. Profile evidence can estimate the residual probability. For `n = R + U`
observations and `p_hat = R/n`, Hoeffding's inequality gives

```text
Pr(|p_hat - p_resolved| >= delta) <= 2 exp(-2 n delta^2)
delta(alpha, n) = sqrt(log(2 / alpha) / (2 n)).
```

At `n = 10,000` and `alpha = 0.01`, `delta` is approximately `0.0163`. A
conservative classifier may call the resolved condition likely only when
`p_hat - delta > 1/2`, unlikely only when `p_hat + delta < 1/2`, and otherwise
emit no hint. This establishes statistical separation from one half under an
independent fixed-workload sampling assumption. It does not establish runtime
profitability, and phase-changing workloads invalidate that assumption.

The initial non-profiled policy is narrower. After all control-flow rewrites,
the backend may attach `likely` to `if c then value else trap` when the false
arm unconditionally traps and the true arm continues with the typed result. For
the successful-execution workload class, every completed execution that reaches
this branch takes the true arm, so the conditional completed-run probability is
one. Aggregate product selection has exactly this final bounds check. Earlier
selection tests, source conditionals, dispatch tests, and loop exits have no
such certificate and receive no hint. Trap-heavy fuzzing is a counterexample to
the workload assumption; it can make the hint unprofitable without affecting the
erasure theorem.

#### Runtime and artifact cost

Let a profiled branch execute `N` times. Let `C0` be measured mean cost without
metadata, `CT` the cost when a true-hint branch is true, and `CF` its cost when
false. The true hint is profitable in one named engine and architecture only if

```text
N (C0 - (p CT + (1 - p) CF))
  > C_profile + C_emit + C_decode + lambda B_hint.
```

`lambda` converts artifact bytes into the deployment's measured cost. Engines
may use hints for code layout, tiering, prediction, or not at all, so `CT`,
`CF`, and `C0` are empirical parameters. The inequality is a break-even model,
not a portable promise that a correctly classified branch becomes faster. The
official feature table currently records branch hinting as standardized but not
uniformly implemented across engines [35]; every benchmark claim must therefore
name the engine version and verify that it consumes the section.

The metadata byte cost is exact. Let `u(x)` be unsigned-LEB byte length, `G` the
number of functions with hints, `H_f` the hints in function `f`, and `off_h` an
instruction offset. The custom-section name has 25 UTF-8 bytes. Its payload and
complete section sizes are

```text
P = u(25) + 25 + u(G)
    + sum_f (u(function_index_f) + u(H_f)
      + sum_h (u(off_h) + u(1) + 1))

B_hint = 1 + u(P) + P.
```

The final `1` in each item is the likelihood payload and `u(1) = 1` encodes its
declared size. One hint in function zero at an offset below 128 therefore costs
`P = 32` and `B_hint = 34` bytes. Additional hints in that same small function
cost three bytes each until a vector count, offset, or section length crosses a
LEB boundary. This fixed section overhead argues against annotating isolated
cold branches even before engine compilation cost is considered.

#### IR placement and implementation boundary

Profile-derived likelihood is immutable compiler evidence beside the payload IR,
not a Core effect or arithmetic primitive:

```text
BranchEvidence {
  function_id
  branch_id
  true_count
  false_count
  provenance       // profile identity or proved static fact
}
```

Core optimization would consume stable branch IDs and transform or invalidate
that profile evidence. It remains unimplemented. The retained static trap policy
instead runs after final condition selection and inserts a non-emitting
`BranchHint(likelihood)` anchor immediately before the selected `if` or `br_if`.
This placement makes condition inversion an earlier phase that cannot silently
reverse an attached hint. Binary layout removes the anchor and replaces it with
the function-relative byte offset.

The proposal requires function entries in increasing function-index order, items
in increasing offset order, no duplicate offsets, and the single metadata
section to occur before the code section [33]. Defined functions and their
anchors are consumed in construction order, and duplicate or unattached anchors
are rejected before plan construction.

Offsets are relative to the beginning of the Wasm function declaration and are
known only after local declarations and all preceding instruction encodings have
exact sizes. `WasmModuleBuilder` now sizes those already-validated scalar atoms
while removing each anchor, emits the dedicated metadata section immediately
before code, and leaves generic custom sections in their existing trailing
position. The resulting metadata atoms enter the same binary plan as every other
section, so CPU and GPU count-size-scan-write emission remain byte-identical
without a CPU body re-encoding pass.

Required executable evidence is:

1. hinted and unhinted artifacts have byte-identical semantic sections and
   identical observations;
2. `if resolved` and `br_if slow` fixtures prove opposite correct polarities;
3. final-placement validation prevents later condition inversion and branch
   deletion from orphaning or reversing a hint;
4. offsets remain correct across local-declaration and multi-byte-LEB changes;
5. function/offset ordering and duplicate rejection match the metadata grammar;
6. removing the metadata section leaves byte-identical semantic sections and
   execution remains correct; and
7. thunk fixtures with one, two, and many forces reproduce `R = F - D` before
   any heuristic is benchmarked.

The branch-hint emitter and the static successful-bounds policy are implemented.
Focused tests parse the metadata payload, cover local-declaration and multi-byte
offsets, reject unattached anchors, erase the section, compare observations, and
require CPU/GPU byte identity on available WebGPU. Production aggregate bounds
tests require one likely-success hint while retaining both successful results
and out-of-bounds traps. No source `Need`, runtime thunk cell, or
profile-derived branch evidence is implemented.

The frozen branch microbenchmark ran in six fresh Deno 2.9.4 processes using V8
15.0.245.2 on Linux x86-64. Each process used 101 alternating
module-construction samples and 31 alternating runtime samples of one million
calls after 100,000 warmups. The condition was true 99.9% of the time. The
50-byte semantic module grew to 84 bytes, exactly the 34-byte minimum derived
above. Hinted/unhinted runtime medians in nanoseconds per call were:

```text
7.527/7.791  5.611/5.635  10.105/10.729
5.206/5.369  5.541/5.628   9.865/9.623
```

Five of six processes improved and one reversed. Ratios range from a 5.82%
improvement to a 2.52% regression; the paired median difference is -0.125
ns/call. Hinted module construction was slower in all six processes by a median
0.00018 ms. Ignoring artifact transfer cost, the median runtime difference
repays that construction delta after approximately 1,440 calls. This is
empirical evidence that the supported V8 consumes useful metadata for this
branch shape, plus a counterexample to deterministic improvement. It is not a
performance proof for every aggregate selection or another engine.

`deno task benchmark:branch-hints` now uses 100 module-construction and 32
runtime samples, giving each order equal weight, and rejects semantic
disagreement before reporting one process-level measurement.

Among the six frozen applications, only Codex contains the residual aggregate
selection shape admitted by the initial policy. Its deterministic module grows
from the historical 226,134-byte artifact to 226,211 bytes: 77 bytes of branch
metadata. Editor, grep, tar, wav, and raytracer are byte-identical to their
previous contracts. This is an executable artifact-size change, not a new
whole-application timing measurement.

### 7.10 Work-efficient resident compilation

This section specifies the resident-performance boundary. It replaces the
informal objective “put more stages on the GPU” with an optimization order:

1. eliminate semantic work whose result is unobservable;
2. minimize representation construction and host/device traffic;
3. minimize dependency span and synchronization;
4. parallelize the remaining work;
5. improve constant factors without weakening the first four properties.

GPU occupancy is not an objective by itself. An (O(n\log n))-work kernel is not
preferred to an (O(n))-work kernel merely because it schedules more lanes.
Blelloch's work/depth model and Brent's simulation bound justify tracking total
work and critical-path depth separately [17, 36].

#### Cost state

For stage (i), record

\[ C_i=(W_i,S_i,H_i,D_i,U_i,A_i,K_i,R_i), \]

where (W_i) is primitive work, (S_i) dependency span, (H_i) host bytes read or
written, (D_i) device bytes read or written, (U_i) host-to-device upload bytes,
(A_i) allocated bytes, (K_i) queue submissions or host synchronizations, and
(R_i) mapped readback bytes. Host bytes count CPU memory traffic, whereas upload
bytes count traffic across the host/device boundary; a byte may contribute to
both terms when it is first read by the host and then uploaded. For effective
parallelism (P_i), host/device bandwidths (B_h,B_d), transfer bandwidth (B_t),
allocation cost (c_a), submission latency (L), and mapping latency (M), the
first calibration model is

\[ \widehat T_i = \max(W_i/P_i,S_i)c_i + H_i/B_h + D_i/B_d + (U_i+R_i)/B_t + A_i
c_a + K_iL + [R_i>0]M. \]

This is an empirical predictor, not a proof of runtime. The proved lower bound
for the abstract parallel computation is

\[ T_i \ge \max(W_i/P_i,S_i), \]

after choosing one unit-cost primitive model. Queue contention, caches, driver
validation, and overlap can falsify an additive fit, so raw terms and residuals
remain visible. A retained strategy must beat its alternative under paired
measurements; a fitted coefficient alone is not evidence.

#### Benchmark-validity predicate

A measurement set (M) is admissible only when

\[ V(M)=I\land B\land O\land Q\land E, \]

where:

- (I): input bytes, semantic workload, target, and output identity are fixed;
- (B): named compiler boundaries are equal or explicitly incomparable;
- (O): order is randomized or balanced and every raw observation is retained;
- (Q): the selected adapter has no detected competing compiler/GPU workload;
- (E): environment, revision, runtime, adapter, verification mode, warmup, and
  sample hierarchy are recorded.

If (V(M)) is false, the harness emits a refusal record and no speedup. Kalibera
and Jones motivate preserving the hierarchy and uncertainty of repeated systems
measurements rather than treating iterations as independent draws [38]. The
current peer harness violates equal-boundary comparison: gpupaper measures
Ducklang source to Wasm while gpufuck receives a prepared Surface module. It is
useful as two named workload observations but not as a speedup denominator.

The frontend benchmark now selects `gpuWasmVerification: "none"`, retains every
warm profile, records repository/runtime/adapter/input identity, and applies the
same process/GPU load inspection before and after measurement as the peer, Wasm,
rebuild, break-even, and Blot harnesses. GPU process inspection treats every
foreign compute process reported by the driver as contention; executable names
are not an allowlist. CPU-only SIMD and branch harnesses ignore unrelated GPU
work but still reject foreign compiler and Deno/Node runtime work.
`--allow-contended` produces an explicitly diagnostic record rather than
weakening admission. Differential mode intentionally constructs CPU bytes as an
oracle and remains conformance evidence, never production GPU latency.

#### Resident ownership state

A resident artifact has the linear state

\[ \textsf{Allocated}\to\textsf{Queued}(q)\to
\textsf{Ready}(q)\to\textsf{Consumed}\to\textsf{Released}. \]

Queue order permits a consumer submitted after its producer on the same
`GPUQueue` to observe the produced bytes without a host wait [14]. Mapping is a
host observation and therefore a synchronization boundary. A buffer lease may
return to a pool only after every queued use has completed and any mapping has
ended. Device loss moves every lease and pool entry to `Invalid`; no buffer may
be reused across device generations.

The successful compilation invariant is:

\[ R_{syntax}+R_{hir}+R_{core}+R_{layout}=0, \qquad R_{final}=|wasm|. \]

Diagnostics may read back a bounded failure certificate. A successful path may
map only the final Wasm artifact because the JavaScript Wasm API consumes host
bytes [28]. Validation or benchmarking may additionally map independent oracle
artifacts, but those modes are not production latency.

#### Canonical flat representation

Every resident IR version is a tuple of immutable columns and stable integer
IDs. Let (G_v=(C_v,E_v)) be version (v). A transform emits a proposal set (P_v),
resolves conflicts deterministically, counts successor rows, reserves them by
scan, and writes (G_{v+1}). It must preserve:

1. every referenced ID names a row in the same declared version;
2. source, symbol, type, effect, ownership, function, block, operation, and
   value identities are stable unless a checked remap is emitted;
3. output row order is the stable source/IR order after removing rejected rows;
4. the identity proposal produces the same package object and no allocation;
5. no successful-path transform reconstructs a pointer graph merely to flatten
   it again.

Flat Core is the target canonical downstream representation. Object Core remains
a diagnostic or differential view. Vector planning, stackification, local
assignment, branch metadata, Wasm sizing, and emission must consume flat
columns. Phase 15 has removed the rewrite-induced half of the present

```text
object Core -> flat Core -> vectorize object Core -> Wasm nodes
```

cycle, but object vectorization and stackification still prevent the stronger
resident invariant from being an implementation claim.

#### Work-efficient segmented scan

For an associative operator (otimes) with identity (e), exclusive scan is

\[ y_i=e\otimes x_0\otimes\cdots\otimes x_{i-1}. \]

Segmented scan represents each input as ((h_i,x_i)), where (h_i) starts a new
segment, under

\[ (h,a)\odot(k,b)=(h\lor k,\; k?b:a\otimes b). \]

This operator is associative whenever (otimes) is associative. The proof is by
the two cases for the rightmost start flag: if it is set, both parenthesized
forms select the right value; otherwise both reduce to associativity of
(otimes). Count/compact, arena allocation, batched layout, and per-function Wasm
offsets are instances with natural-number addition.

The retained global algorithm is hierarchical:

1. each workgroup scans (b) values and writes one block total;
2. block totals are recursively scanned;
3. one carry pass adds the scanned block total to each local result.

For (n>0), (m=\lceil n/b\rceil), and work-efficient local scans, a two-level
instance has

\[ W(n,b)\le 2n+2m+n, \qquad S(n,b)=O(\log b+\log m), \]

where the final (n) term is carry propagation. Recursive block scans preserve
(O(n)) total work and (O(\log n)) span [17, 18]. Exact implementation metrics
replace the bound in evidence.

The existing Hillis--Steele primitive performs, for (q=\lceil\log_2(n+1)\rceil),

\[ W_{HS}=q(n+1)-(2^q-1). \]

At the grep Wasm frontier (n=3897), (q=12) and (W_{HS}=42{,}681) additions,
versus approximately (2n=7{,}794) for a Blelloch scan before small block/carry
terms. The existing primitive is a valid differential oracle, not the production
global scan. It is currently used by the reference Blot payload strategy and is
not integrated into Wasm layout.

#### GPU Wasm layout

Let atom (a) have final encoded size (s_a). Nested `length` atoms form an
acyclic containment graph because a sized node contains only proper descendants.
For dependency level (d), compute exact child byte sums and the LEB size of
those sums after level (d-1) is complete. Once every (s_a) is fixed, one
exclusive scan gives atom offsets. Emission writes the deterministic encoding of
(a) into ([o_a,o_a+s_a)); these intervals are disjoint and cover the final
buffer.

The production obligations are:

- size resolution and offsets are device results, not CPU inputs;
- level barriers occur inside queue-ordered command buffers or explicit
  submissions recorded in (K);
- exact CPU analysis remains a differential oracle only;
- branch-hint anchors use the same final offsets and therefore cannot drift;
- one final copy/map returns exactly the logical module length.

`prepareWasmGpuJob` structurally validates the plan and constructs scalar atom
columns on the CPU. It does not call `analyzeWasmBinaryPlan`, compute CPU
offsets, or resolve length values. Phase 15 still has to move scalar column
construction behind the resident Core boundary.

#### Bounded specialization

Unrestricted polyvariant specialization can create an unbounded family even when
each residual function is finite. That is not, however, the model currently
implemented by Ducklang. The current rewriter refuses every function marked
recursive before constructing a request. For admitted functions it performs
typed call-by-value beta reduction over immutable functions, products, sums, and
selected total intrinsic reductions. Exact request keys and pending/complete
states share repeated reductions and break an exact re-entry cycle; they are not
a finite abstraction and do not by themselves prove termination of a strictly
growing request sequence.

The intended proof basis for the admitted higher-order fragment is strong
normalization of simply typed lambda calculus by reducibility [39]. To transfer
that theorem, every intrinsic rewrite that constructs a function must be shown
to preserve typing and decrease the same reducibility measure, and recursive or
effectful computation must remain residual. Those extension lemmas have not yet
been mechanized, so current corpus termination is executable evidence rather
than a proved global property. If recursive polyvariance or a non-normalizing
intrinsic is admitted later, the request frontier must instead use a finite
abstraction or type-aware homeomorphic embedding and widening [37]. Adding that
machinery to the current restricted fragment without such a counterexample would
increase work and merge risk without strengthening an established proof.

Termination also does not justify optional cloning. For request (k), accept an
optional clone only when

\[ N_k\Delta t_k > c_cW_k+c_b\Delta B_k, \]

where (N_k) is expected runtime executions, (Delta t_k) estimated saving per
execution, (W_k) compiler work, (Delta B_k) emitted-byte increase, and (c_c,c_b)
calibrated compile and code-size prices. Mandatory normalization that erases a
compile-time type, module, protocol, or closure witness is a semantic lowering
obligation rather than an optional clone; its fallback is a separately specified
runtime representation, not silently skipping the lowering. With no profile or
static elimination proof, (N_kDelta t_k) is unknown and optional cloning is not
authorized. Exceeding a budget never identifies distinct static values.

Demand, reachability, effect, and ownership masks precede specialization.
Counting and scan allocation operate only over surviving nodes. If mask (m_i=0),
no later stage may rediscover or reconstruct node (i). This is the formal
version of “discard as much work as possible before parallelizing.”

#### Zero-domain theorem and fusion rule

Each optional pass defines a candidate-domain upper bound (U(G)) computable from
producer metadata. If (U(G)=0), then candidate discovery must return the
identity without allocating buffers or submitting commands. This is sound only
when every rule head is represented in (U); generated differential tests must
show that CPU discovery is empty whenever the bound is zero.

Producer (A) and consumer (B) may fuse exactly when (B) consumes only the
immutable version emitted by (A), no validation/diagnostic boundary observes
their intermediate representation, and the fused stable order equals sequential
(B(A(G))). Fusion is not justified merely by adjacent dispatches.

The implemented vectorization zero bound is intentionally cheaper than full rule
matching. Every `f32x4-slp-v1` group contains four scalar-`f32` binary
operations from `{+, -, *, /}` in one block. Therefore

\[ U_{vec}(G)=\max_b |\{o\in b\mid
o=\operatorname{binary}^{f32}_{\{+,-,\times,/\}}(x,y)\}| \]

is an upper bound on a four-lane rule head: if (U_vec(G)<4), no plan exists. The
count ignores def-use shape and intervening barriers, so it may conservatively
admit full planning but cannot incorrectly skip a plan. Core construction
updates the maximum while it emits each operation and associates the certificate
with the immutable construction-branded snapshot. The zero case is consequently
an O(1) lookup that returns the same object with zero validation and proposal
work. Raw external Core retains validation before this optimization boundary.

#### Phase 15 implementation evidence

The retained unsegmented scan uses workgroup width (b=128), a Blelloch
upsweep/downsweep inside each workgroup, recursive block-total scans, and a
carry pass. For a level of length (n), let (m=\lceil n/128\rceil). The
implementation reports, rather than estimates,

\[ A(n)=254m+[m>1](A(m)+n-128), \]

\[ D(n)=1+[m>1](D(m)+1), \]

and

\[ I(n)=128m+[m>1](I(m)+128m), \]

for executed additions, dispatches, and scheduled invocations respectively. Its
temporary storage recurrence is

\[ B(n)=4n+4m+16+[m>1](B(m)+16). \]

These are executable accounting identities. Nine hardware-backed tests validate
ordinary and segmented exclusive scans over empty, nonuniform, multi-workgroup,
sparse-head, arbitrary-nonzero-head, and wrapping-u32 inputs. The segmented
shader implements the pair operator defined above; it does not infer boundaries
from values. The previous test names incorrectly called the ordinary count scan
segmented, and the implementation added the missing head/value primitive rather
than retaining that false claim.

Device-scoped buffer pools now issue exclusive linear leases. Exact usage and a
power-of-two capacity bucket form the reuse key, at most one released buffer is
retained per key, a concurrent acquisition cannot observe a leased buffer, and a
second release is an invariant failure. A release in the Wasm path occurs only
after its mapping is ended and submission completion has been witnessed. Device
loss destroys released entries and makes the pool invalid. Thirteen focused unit
tests include exclusion, reuse, mapped-at-acquisition rejection, second-release
rejection, both released- and leased-buffer behavior at device loss, and a
failed mapping that cannot reject until device completion has also been
witnessed. This is executable validation of the ownership protocol, not a formal
proof of the WebGPU implementation.

Blot resident lowering now leases its source, candidate, payload, metadata,
parameter, and readback buffers from the same device pool. Its final map starts
with queue submission and is the completion witness; the old sequential
`onSubmittedWorkDone` then `mapAsync` boundary and unconditional destruction of
six buffers were removed. Temporary recursive-scan buffers remain privately
owned by the scan encoder and are destroyed after completion. Fourteen Blot
tests cover direct and segmented lowering, shadowing, diagnostics, deterministic
emission, and hardware-adapter agreement.

Single-payload GPU Wasm emission now executes the following queue-ordered
pipeline:

```text
scalar atom sizes
  -> bottom-up length levels
  -> hierarchical exact-size scan
  -> byte emission from device offsets
  -> output plus terminal offset copy
  -> one mapping
```

The CPU offsets produced by `analyzeWasmBinaryPlan` are no longer bound to any
production emission shader. Length payloads used by emission are device results,
and the mapped terminal offset determines the returned slice. Production mode
runs only CPU structural validation and scalar column construction; it does not
compute CPU byte lengths. Differential mode independently invokes the CPU
emitter before the GPU path, so its cost remains deliberately outside production
latency. Concurrent payloads each build a resident layout, while the submission
queue batches their command buffers and maps their final artifacts concurrently.
This replaced and deleted the packed CPU-offset implementation. Differential
tests cover nested lengths, sparse numeric dependency levels, signed LEB
boundaries, concurrent isolation, and both sides of 64 KiB.

Because WebGPU copy sizes are host-known, the one-map implementation reserves a
structural upper bound rather than the device-computed exact length. For byte,
unsigned, signed-32, signed-64, and length-atom counts (b,u,s_32,s_64,l),

\[ B_{max}=b+5(u+s_{32}+l)+10s_{64}. \]

The bounds are the maximum LEB widths of their admitted domains; hence every
device-resolved atom interval lies within the word-rounded arena. This replaces
the earlier (10n) allocation without calculating an exact CPU size. Editor's
recorded structural counts reduce its copied capacity from 239,232 bytes to
64,036 bytes while its logical output remains 24,460 bytes. An indirect GPU copy
still cannot make `copyBufferToBuffer` consume a device-computed size;
eliminating the remaining slack requires a second host synchronization, a fixed
resident arena amortized over a batch, or a backend that returns a mapped arena
with host-side logical slicing. The tighter bound is proved safe by atom domains
and differentially tested across every atom kind and the 64-KiB boundary; the
batch arena remains the preferred next experiment.

The submission queue now permits the final `mapAsync` to witness completion of
the command that fills the readback. Previously the single-payload path awaited
`queue.onSubmittedWorkDone()` and only then requested mapping, serializing two
driver waits. On the RTX 4080 SUPER, five ad hoc 37-atom runs before this change
had steady totals 25.20--25.57 ms, with about 13.4 ms in submission completion
followed by 11.1 ms mapping. Five runs after the change had steady totals
13.44--14.75 ms, with 10.37--11.68 ms in the mapping completion witness and
0.07--0.10 ms residual submission bookkeeping. These are contaminated ad hoc
measurements, not admissible benchmark claims, but the roughly 11 ms removed
serial span directly confirms the synchronization model. Pooling simultaneously
reduced steady preparation from roughly 0.55 ms on the second pre-pool sample to
0.25--0.40 ms after warmup; cold context creation remained 181--244 ms. Removing
the zero-delay host timer from the latency policy then reduced five later steady
37-atom observations to 11.97--12.34 ms total, with 0.006--0.013 ms queue wait
and 11.29--11.32 ms mapping completion. Throughput policy retains its
two-millisecond collection window. These observations are still contaminated
diagnostics, but they falsify the assumption that a zero-delay timer is free at
the latency boundary.

The scheduler now starts a queue-completion future and the final mapping future
concurrently from the same submission. Their durations overlap and therefore
must not be added. Four contaminated Editor diagnostics after the tighter arena
measured steady queue/device completion at 11.58--12.65 ms and mapping
completion at 12.28--12.66 ms; the post-device difference was 0.002--1.075 ms.
Thus the old `mappingMilliseconds` label did not establish an 11-ms mapping
overhead: it mostly observed the same device/driver critical path. Profiles now
expose both clocks and call the latter a completion witness. Column construction
is CPU atom packing; the following interval is named allocation-and-upload
rather than conflating the two stages.

Integer identity rules are now canonical Core-construction equations:

\[ \operatorname{core}(x+0)=\operatorname{core}(x),\qquad
\operatorname{core}(x\times1)=\operatorname{core}(x). \]

Both operands are lowered left-to-right before the result value is selected, so
the equation removes only the pure integer operation and preserves operand
evaluation. The rule is restricted to `i32` and `i64`; applying it to IEEE-754
values would be unsound for signed zero. Production therefore returns the
construction-certified flat package as the exact Core rewrite identity with zero
matching, descriptors, allocation, submission, or inflation. Focused Core,
GPU-conformance, compiler-profile, and execution tests pass. The standalone GPU
rewrite still differentially processes deliberately noncanonical validated flat
packages, which tests interoperability without making redundant work part of
normal compilation.

The contaminated Editor diagnostic that motivated the next zero gate spent 2.31
ms in a vector pass with no candidate windows: approximately 1.57 ms in repeat
validation and 0.73 ms in planning over 1,341 Core operations. An intermediate
bound still counted integer arithmetic and measured 0.60--1.60 ms because it
admitted full planning despite zero `f32` candidates. That counterexample caused
the bound to move into Core construction and become type-sensitive. Six later
contaminated observations were 0.0050--0.0218 ms with zero validation and zero
candidate windows, a 27--317 times reduction over the intermediate range. These
are diagnostic stage clocks, not an admissible speedup. Focused SIMD tests still
admit and execute the profitable six-group source plan, and producer-bound tests
cover both zero and exactly four rule heads.

Construction and validation provenance are now separate capabilities.
`flattenConstructedDucklangCore` accepts only the unforgeable constructed Core
type, while `flattenValidatedDucklangCore` validates an arbitrary object and
labels the result `validation`. This removes the former API hole in which any
object Core could be called construction-certified. Successful production still
does not inflate flat Core for identity rewriting; object vectorization and the
object stackifier remain the incomplete resident boundary.

The Wasm-plan microbenchmark now retains every raw wall observation, every raw
GPU timing record (inspection, column construction, context, allocation/upload,
command encoding, submission, queue/device completion, mapping witness, and
copy), CPU raw samples, and the wall-minus-internal residual. Because this
microbenchmark does not yet inspect load, it labels the record `diagnostic`. It
also names and times the currently nonresident boundary as
`validated-flat-core-through-object-stackifier-to-wasm-plan`. Three contaminated
samples split Editor into 3.20--4.21 ms of flat-to-object inflation plus
5.27--5.47 ms of object stackification/planning. Codex required 35.29--37.71 ms
of inflation plus 47.54--66.25 ms of planning. The split proves neither absolute
latency nor GPU benefit, but it identifies two independent representation costs:
removing inflation alone cannot remove more than its measured component, while a
flat backend must also replace the larger planner component on Codex.

The peer harness now refuses to run when Linux process inspection or NVIDIA
compute-process inspection finds another compiler/test workload. The 2026-08-01
attempt correctly refused while a Blot Deno server owned 205 MiB on the RTX 4080
SUPER. It retains raw sample order and input/output hashes, hashes tracked diffs
and every untracked file in all three repositories, and contains a paired,
alternating, warm-process/cold-session boundary. Both gpupaper and local
`../gpufuck` receive the exact bytes `return 42;\n`, compile Blot source to
valid Wasm, and are checked by invoking their respective export and requiring
`42n`. Different runtime sections and output sizes are implementation costs
rather than an input-boundary mismatch. The earlier 300-function experiment was
rejected: gpufuck always emitted its runtime table, memory, globals, and exports
while gpupaper emitted a minimal module, and gpufuck's public timer could not
isolate function bodies from CPU module assembly. The shared-source timing
remains unmeasured because the validity gate refused; there is deliberately no
fabricated speedup.

An explicit `--allow-contended` escape hatch may execute the same harness for
diagnosis, but it labels the validity status `diagnostic` and never
`admissible`. It retains the detected processes and raw samples, so such a run
can expose gross setup costs without becoming speedup evidence.

The adjacent dirty gpufuck checkout removed the obsolete
`EvaluationProfile.StrictEager` surface option before the adjacent dirty Blot
checkout removed its import. The peer harness supplies that one ignored legacy
name through an import-map compatibility module and otherwise re-exports the
exact local gpufuck API. The synthetic peer fixture omits the removed option.
This repairs benchmark construction without restoring strict evaluation or
changing the compiled Blot source.

A 15-pair `--allow-contended` diagnostic on 2026-08-01 then completed while the
Porffor test suite, a gpufuck GPU differential test, and Playwright were active
at the start. On the equal 11-byte `return 42;\n` boundary, gpupaper measured
251.642 ms p50 and 317.832 ms p95; gpufuck measured 183.671 ms p50 and 330.663
ms p95. The p50 ratio was therefore 1.370, or gpupaper 37.0% slower, while the
opposite p95 ordering and broad raw ranges show the expected contention noise.
Both outputs validated and returned `42n`. Gpupaper emitted 37 bytes versus
gpufuck's 2,371 bytes, 64.1 times smaller. This is executable diagnostic
evidence of a large cold-session setup cost and output-size difference, but its
validity status is explicitly `diagnostic`; it is not an admissible speedup or
tail-latency claim. Peer schema version 4 adds that status.

An independent byte-level check of the 37-byte gpupaper result found the
eight-byte Wasm header followed by a seven-byte type section, four-byte function
section, ten-byte export section, and eight-byte code section. The only function
has type `[] -> [i64]` and body `i64.const 42; end`; the only export is `main`.
`WebAssembly.validate` accepted the bytes and instantiation returned `42n`.
There are intentionally no imports, memory, table, globals, runtime, custom
sections, or embedded Baba parser. For this ABI and four-byte export name, every
field is already one-byte encoded, so 37 bytes is the exact structural minimum,
not omitted compiler output. Baba is compiler machinery and its plan and shaders
do not become part of the compiled payload.

Specialization now reports rejected optional candidates, the permanently zero
widening count, emitted/reused/pending requests, and source-span-indexed
residual node amplification. The only intrinsic rules that construct functions
are `compose`/`patch_compose` and `predicate_and`. Each is the typed expansion
of a fixed nonrecursive lambda term, removes its head intrinsic, introduces no
copy of either function argument, and introduces neither constructing intrinsic.
Translation to those closed definitions followed by Tait reducibility therefore
gives strong normalization for the admitted simply typed, nonrecursive fragment
[39]. A generated typed test exercises both delta rules and counts two consumed
redexes; recursive factories remain rejected and exact pending re-entry remains
residual. This is a paper proof plus executable rule-inventory evidence, not a
machine-checked proof.

An attempted profitability tightening allowed only compile-time records and
non-runtime intrinsic witnesses. It failed 7 of 114 focused language checks: two
compile-time closures escaped normalization, four expected specialization shapes
changed, and one three-level runtime closure exposed a capture-type invariant
failure. The change was reverted. This falsifies the claim that every existing
specialization is already optional cloning merely because Core has closure
operations. Optional and mandatory requests need explicit demand provenance, and
the closure capture bug needs repair, before the profitability inequality can
reject those requests safely.

#### Current quantitative falsification

The 2026-08-01 audit proves that the resident boundary is incomplete:

- Ducklang calls Baba's generated-Wasm cursor and lowers a host AST; only Blot
  uses Baba's GPU-resident frontend.
- Baba 7.10's public resident session creates and owns its own `GPUDevice`,
  accepts only host `string` or `Uint16Array` source, and publicly returns one
  leased resident buffer containing its header and token/node/edge columns. It
  also exposes that session's device, so a consumer can submit same-queue work
  before releasing the result; Blot exercises exactly this contract. What Baba
  does not expose is external-device adoption or resident source-buffer
  ingestion. Ducklang additionally has 19 contextual lexical terminals plus
  delimiter- and line-sensitive host classification. A host classifier followed
  by Baba GPU parsing would add a readback/re-upload boundary and is therefore
  not called resident. The missing primitives are a guard-free lexical product
  or equivalent GPU classifier and, for one compiler-wide device owner,
  external-device adoption with explicit ownership. Resident source ingestion
  removes the remaining duplicate source upload but is not a prerequisite for
  consuming syntax on the same device.
- The adjacent Binned checkout is at `4f06b1f9ca9276955e2def04de002ea9e48466c1`
  (2026-08-01, “Compose certified identity calls”) but is not a stable corpus
  input: it has 19 tracked modifications and four untracked paths, including a
  dirty manifest that adds `examples/compile_time/27_contracts_and_proofs.duck`.
  No generated contract was imported from that worktree. The vendored corpus
  remains the reproducible boundary until Binned is clean and pinned.
- Before canonical construction, most frozen programs reported zero GPU Core
  rewrite proposals and Tar reported 24. Those two integer identities are now
  removed before flat Core; a new frozen-corpus measurement is still required.
- Codex has 149 linked statements, 25,358 type equalities, 23,594 residual
  specialization nodes, 12,956 Core operations, 204,168 Wasm atoms, and a
  226,211-byte module. Per linked statement it has 6.2 times Editor's type
  equalities, 7.2 times residual nodes, 8.4 times Core operations, and 7.4 times
  Wasm atoms. This is representation amplification, not a hardware lower bound.
- One apparently idle peer run measured gpupaper at 42.596 ms p50 and gpufuck at
  0.197 ms p50 under unequal boundaries. During a concurrent gpufuck test suite,
  the identical harness measured 210.517 and 0.618 ms. Neither pair is an
  architectural speedup; the second falsifies a harness without a load gate.

These are executable observations or source audits, not proofs that the proposed
replacement is faster. Phase 15 implementation must update this section with
retained and rejected mechanisms, exact work equations, differential evidence,
and uncontended equal-boundary measurements.

### 7.11 Dependency-preserving compilation order

“Reorder let statements” names three different transformations with different
proof obligations:

1. execute compiler jobs for typed right-hand sides in another order while
   emitting the same source-ordered program;
2. reorder payload evaluation while retaining sequential execution; or
3. evaluate payload computations concurrently.

Only the first follows from the compiler's functional architecture. The second
requires a commutation theorem. The third additionally requires a parallel
effect semantics, deterministic join, race freedom, and a cancellation policy.
Conflating them would turn compiler parallelism into a source-language semantic
change.

#### Compiler-task reordering

Let a resolved, typed, effect-closed, ownership-validated HIR block contain jobs

\[ J_i=(s_i,c_i,i), \]

where \(s_i\) is a stable binder identity, \(c_i\) is its right-hand side, and
\(i\) is its source ordinal. There are two graphs. The semantic-readiness graph
\(G_s\) orders inference, staged evaluation, or interface construction when a
predecessor's semantic result is genuinely unavailable. Its recursive edges are
collapsed into strongly connected components. The compiler-execution graph
\(G_c=(V,E_c)\) is constructed only after every global table used by downstream
lowering is immutable. It contains an edge \(J_j\to J_i\) only when compiling
\(c_i\) needs information that is neither in the frozen snapshot nor expressible
as a stable relocation.

Ordinary resolved value use \(s_j\in FV(c_i)\) is therefore a relocation edge,
not necessarily a compiler scheduling edge. A consumer fragment can record the
stable symbol ID and expected type before the producer fragment finishes. After
all exact fragment counts are known, ordered scans map every exported local
result to its global ID and resolve those relocations. Mutually recursive
function bodies can likewise lower independently once their signatures, function
IDs, captures, and layouts are frozen. An SCC remains indivisible only at a
stage that still computes one of those interfaces or executes staged code.

For immutable snapshot \(H\), fragment lowering has the contract

\[ C(H,J_i)=(F_i,n_i,d_i), \]

where \(F_i\) uses fragment-local IDs and stable-symbol relocations, \(n_i\)
gives exact output-column counts, and \(d_i\) is a finite set of diagnostic
records. \(C\) must be a deterministic pure compiler computation. It does not
run \(c_i\), call a source host capability, allocate a source-visible object, or
consume a source owner. Thus source effects and ordinary value-flow relocations
do not add edges to \(G_c\). They remain ordered operations and checked
references inside the returned fragment.

After all predecessor components finish, fragments are committed by source
ordinal. For every output column \(k\), compute

\[ o_{i,k}=\operatorname{exclusiveScan}_i(n_{i,k}) \]

and rebase local IDs into the half-open range \([o_{i,k},o_{i,k}+n_{i,k})\).
Diagnostics are sorted by the existing canonical key containing stage, source
span, and stable diagnostic identity; completion order is never a tie-breaker.
The output is therefore the same as sequential source-order construction if the
current constructor can be factored into the same \(C\) and ordered
concatenation.

**Deterministic-fragment theorem obligation.** For every valid snapshot \(H\),
let \(S\) be any topological schedule of the SCC quotient of \(G_c\). If
fragment lowering reads only \(H\) and predecessor fragment interfaces, every
local ID is rebased by source-ordinal scans, and commit is ordered by source
ordinal, then

\[ \operatorname{assemble}(\{C(H,J_i)\}_{S})
=\operatorname{compile}_{source}(H). \]

The proof is induction over source ordinals: the count scan assigns the same
range that sequential append would assign, local rebasing preserves every
intra-fragment reference, relocation resolution preserves every cross-fragment
reference, and ordered concatenation preserves operation and diagnostic order.
This is currently a theorem obligation, not an implemented transform. The
present object Core constructor mutates global type, block, operation, and value
counters, so it does not yet satisfy the fragment contract.

#### Implemented job-analysis boundary

The first executable slice constructs schema-versioned `DucklangCompilerJobIR`
immediately after specialization and before Core lowering. There is one job for
each retained top-level binding and one final-result job. Its flat columns store
source ordinals, stable symbol IDs, source spans, typed-node work estimates,
packed relocation occurrences, packed semantic-dependency ranges, and the SCC ID
and level induced by the relocation graph. Reference occurrences are emitted in
deterministic expression-preorder and target the source-ordinal job owning the
exact resolved symbol ID. Consequently a shadowed name cannot accidentally
relocate to a textual-name match.

This slice deliberately represents a narrower boundary than the general \(G_s\)
model. Specialization has already produced the typed module and every downstream
interface inspected by the analysis is frozen, so its semantic dependency ranges
must be empty. Validation rejects a nonempty range rather than silently treating
it as a relocation. Relocation SCCs are retained only as a conservative
comparison with the earlier direct-reference audit; they do not constrain the
true downstream schedule. Thus mutually recursive functions share one relocation
SCC while remaining separate semantic-ready jobs.

For job weights \(w_i\), the implemented semantic-ready measurements are

\[ W=\sum_i w_i,\qquad L_s=\max_i w_i,\qquad P_s=W/L_s. \]

The implementation also contracts the relocation graph and reports its
conservative weighted span \(L_r\), level count, maximum level frontier, and
\(P_r=W/L_r\). Both analyses use the same typed-node proxy, so their difference
isolates false serialization by ordinary references rather than claiming a
wall-clock speedup. The validator recomputes SCC IDs and levels, checks every
packed range and target, requires ordinal \(i\) at job index \(i\), requires one
symbol-less final job, and rejects zero work. These are executable validations,
not proofs of the still-unimplemented fragment theorem.

One warm-up followed by seven warm-process, cold-compilation CPU observations on
2026-08-01 produced the following medians. `analysis` includes expression
inspection, IR construction, validation, SCC contraction, frontier analysis, and
metric calculation. This was an exploratory single-process measurement, not a
contention-screened benchmark:

| target    | jobs | nodes \(W\) | \(L_s\) | \(P_s\) | \(L_r\) | \(P_r\) | analysis ms |
| --------- | ---: | ----------: | ------: | ------: | ------: | ------: | ----------: |
| Editor    |   79 |       3,129 |     621 |    5.04 |   1,360 |    2.30 |       0.814 |
| Codex     |  264 |      32,675 |   2,177 |   15.01 |   3,502 |    9.33 |       4.225 |
| grep      |   14 |         439 |     201 |    2.18 |     328 |    1.34 |       0.150 |
| Tar       |   30 |       4,274 |   3,915 |    1.09 |   4,101 |    1.04 |       0.458 |
| wav       |    6 |         215 |     130 |    1.65 |     167 |    1.29 |       0.086 |
| raytracer |   15 |         447 |     131 |    3.41 |     350 |    1.28 |       0.140 |

The conservative spans exactly reproduce the earlier one-off audit. The new IR
also distinguishes relocation occurrences from distinct job edges and counts a
self-reference as a graph cycle; those quantities therefore must not be compared
to the audit's differently defined `direct edges` and `cyclic jobs` columns.
Codex exposes the largest top-level opportunity but also pays a measured 4.225
ms median analysis cost before any parallel lowering exists. Under the
break-even inequality this is presently an overhead, not a speedup.

No fragment column counts, frozen function/signature/layout table, local Core
fragment, rebasing, relocation commit, diagnostic merge, randomized schedule, or
GPU scheduler is implemented yet. In particular, this analysis does not justify
changing `downstreamParallelFunctionCount`: no physical parallel work ran. Those
omissions remain explicit tasks rather than being represented by placeholder
counts.

This graph is related to the program dependence graph of Ferrante, Ottenstein,
and Warren [44], but its nodes are compiler computations, not payload
operations. Their separation of data and control dependence motivates retaining
only real dependencies rather than a total source-order edge set. Stable
count/scan/write assembly is the GPU-compatible replacement for shared append.

#### Payload commutation is a pairwise semantic property

Moggi's computational lambda calculus gives the correct starting point: `let` is
monadic sequencing, not ordinary substitution [40]. Two value-independent
computations may be exchanged only when the relevant computational effects
commute. A set-valued effect row records which capabilities may occur, but its
union is commutative even when execution is not. Gordon's effect quantales make
the missing distinction explicit by giving sequential effects a generally
noncommutative product [41]. Tate likewise distinguishes nominal
order-insensitivity from a semantic proof that left-to-right and right-to-left
evaluation agree [42].

For runtime state \(\sigma\), define an observation as one of

\[ \begin{aligned} &\operatorname{return}(v,\sigma',\tau),\\
&\operatorname{trap}(p,\sigma',\tau),\\ &\operatorname{diverge}(\tau).
\end{aligned} \]

where \(\tau\) is the ordered trace of host operations, capability performances,
logical resource transitions, and cleanup, and \(p\) identifies the first source
trap. Two computations commute, written \(c\bowtie d\), only when, for every
well-typed input state, executing `c; d` and `d; c` produces equivalent paired
values and observations, modulo only explicitly unobservable representation
renaming.

For

```text
let x <- c
let y <- d
k
```

the adjacent exchange is admissible only if \(x\notin FV(d)\), \(y\notin
FV(c)\), and \(c\bowtie d\). The second free-variable condition is normally
guaranteed by lexical scope, but remains explicit for recursive groups and
transformed IR. Arbitrary sequential reorderings then follow by repeated
adjacent exchanges. This is stronger than finding a topological order of value
dependencies.

A conservative executable certificate would summarize each computation with

\[ Q(c)=(R_c,W_c,U_c,E_c,A_c,G_c,K_c), \]

where \(R,W\) are logical resource read/write footprints; \(U\) is an ownership
transition over moves, borrows, freezes, drops, and regions; \(E\) is a
sequential host/capability trace abstraction; \(A\) records possible trap, early
exit, and divergence; \(G\) records allocation and generative identity; and
\(K\) records control dependence. The first admitted exchange rule should
require all of the following:

1. value independence as above;
2. Bernstein's noninterference conditions [43], \(W_c\cap(R_d\cup
   W_d)=\varnothing\) and \(W_d\cap(R_c\cup W_c)=\varnothing\);
3. disjoint ownership transitions, except compatible shared reads through values
   already proved frozen and live for both computations;
4. a semantic primitive or handler certificate proving
   \(E_c\mathbin{\triangleright}E_d= E_d\mathbin{\triangleright}E_c\), not
   merely equal effect-row membership;
5. no trap, early exit, or divergence in the initial implementation;
6. no observable or fallible allocation and no generative identity whose order
   can escape, until logical source-ordinal identities and allocation-failure
   behavior are proved invariant; and
7. the same control region, unless separate speculation and control-dependence
   proofs apply.

These conditions are sufficient and deliberately incomplete. LLVM and MLIR
similarly separate memory effects from speculatability: absence of a write does
not prove that moving an operation onto a newly executed path is safe [45].
WebAssembly itself executes instruction sequences in order and reports traps to
the embedding [27], so the backend cannot appeal to an out-of-order hardware
implementation to change source observations.

The current primitive catalog demonstrates why `pure` is not a reorder
certificate. Integer division and truncating conversions may trap despite having
no algebraic capability row. Bounds-checked immutable reads may trap. Two host
calls with disjoint return values can still expose their order. A diverging
computation followed by panic is not equivalent to panic followed by divergence.
Moving or dropping one owner can invalidate another computation's borrow.
Allocation order can change a fallible allocator or a source-visible handle
unless the representation-independence proof explicitly hides it.

The following initial classification is therefore normative for future work:

| Computation                                       | Compiler jobs | Payload exchange                                                   |
| ------------------------------------------------- | ------------- | ------------------------------------------------------------------ |
| Independent typed RHSs, emitted in source order   | admissible    | unchanged                                                          |
| Total scalar operations with no trace or owner    | admissible    | admissible                                                         |
| Division, conversion, bounds check, or panic      | admissible    | ordered                                                            |
| Reads of the same frozen value with proved bounds | admissible    | admissible                                                         |
| Allocation or region transition                   | admissible    | ordered initially                                                  |
| Host or algebraic operation                       | admissible    | ordered unless its semantic handler certificate proves commutation |
| Move, freeze, drop, or live borrow transition     | admissible    | ordered unless footprints and ownership transitions are disjoint   |

Function bodies and source computations can therefore be compiled concurrently
even when the right-hand sides in the last four rows must execute sequentially.

#### Parallel payload execution is deferred

Pairwise sequential commutation does not by itself define concurrent execution.
A parallel source construct must specify which interleavings are observable, how
two failures are selected, whether one branch cancels another, how cleanup is
ordered, and how one-shot resumptions interact with scheduling. Tate shows that
useful parallel effects may admit arbitrary interleaving without making
same-thread logging commutative [42]. Ducklang currently has neither that
parallel merge operation nor a task calculus. The compiler must not manufacture
one from let syntax.

#### Pass ordering is a separate problem

Reordering compiler passes is also not justified by right-hand-side
independence. Two read-only analyses over one immutable snapshot can overlap.
Two transforms \(P,Q\) can be exchanged only with a checked property such as

\[ P(Q(I))=Q(P(I)) \]

for every admitted \(I\), or a proof that both terminating rewrite systems reach
one canonical normal form. Profitability, fixed iteration budgets, source
diagnostics, and code-size thresholds commonly break that equality. The current
snapshot/propose/resolve/commit model should overlap analyses, then preserve the
proved transform order until a confluence or differential certificate exists.

#### Work, span, and structural opportunity

For SCC jobs \(j\) with measured or estimated compiler work \(w_j\), let

\[ W=\sum_jw_j,\qquad L=\max_{\pi\in paths(G_c)}\sum_{j\in\pi}w_j. \]

On \(P\) effective workers, any scheduler satisfies

\[ T_P\ge\max(W/P,L). \]

With graph construction \(T_g\), \(q\) dispatches of latency \(D\), fragment
traffic \(M\) at effective bandwidth \(B\), and ordered scan/assembly \(T_a\),
the transform can repay itself only if

\[ T_{seq}-\max(W/P,L) > T_g+qD+M/B+T_a. \]

Graph construction and Tarjan SCC contraction take \(O(|V|+|E_c|)\) work [19].
Column offsets take \(O(|V|)\) work and \(O(\log |V|)\) scan span. Variable-size
fragments require exact count/scan/write; atomics into a shared append arena
would make IDs and diagnostics depend on completion order.

A one-off 2026-08-01 structural audit compiled the six frozen applications on
the CPU, treated every top-level typed binding plus the final result as one job,
used complete typed-expression node count as \(w_j\), conservatively treated
every direct value reference as a scheduling edge, collapsed its SCCs, and
calculated the weighted DAG span. A relocation-capable fragment compiler can
remove many of those scheduling edges, so the table understates downstream
lowering freedom. It did not time a parallel implementation and does not model
nested function-body parallelism:

| target    | jobs | typed nodes \(W\) | direct edges | cyclic jobs | levels | max frontier | weighted span \(L\) | \(W/L\) |
| --------- | ---: | ----------------: | -----------: | ----------: | -----: | -----------: | ------------------: | ------: |
| Editor    |   79 |             3,129 |          125 |           3 |     16 |           26 |               1,360 |    2.30 |
| Codex     |  264 |            32,675 |          333 |          20 |     19 |          108 |               3,502 |    9.33 |
| grep      |   14 |               439 |           15 |           0 |      5 |            6 |                 328 |    1.34 |
| Tar       |   30 |             4,274 |           13 |           0 |      6 |           22 |               4,101 |    1.04 |
| wav       |    6 |               215 |            6 |           0 |      4 |            2 |                 167 |    1.29 |
| raytracer |   15 |               447 |           19 |           0 |     11 |            3 |                 350 |    1.28 |

This is a static work proxy, not a speedup measurement. It supports a bounded
conclusion: top-level fragment parallelism is promising for Codex, modest for
Editor, and structurally unable to help Tar until its dominant function body is
partitioned internally. Maximum frontier width alone is misleading; Tar has 22
ready components but nearly all node work lies on one critical path. Scheduling
must use measured work, not job count.

#### Selected implementation order

The next implementation should not reorder source evaluation. It should:

1. freeze resolved symbol, type, effect, ownership, signature, capture, and
   layout tables;
2. separate true semantic-readiness edges from relocatable value references and
   form SCCs only for the former;
3. lower independent function and binding jobs into local flat fragments with
   stable-symbol relocations;
4. count, scan by source ordinal, rebase, resolve relocations, and emit
   canonical flat Core;
5. compare every result byte and diagnostic with sequential construction;
6. profile \(W,L,M,qD,T_g,T_a\) and reject parallel execution below the measured
   adapter-specific break-even point; and only then
7. consider a Core-level payload scheduler using explicit totality,
   trace-commutation, footprint, ownership, generativity, and control evidence.

The first six steps expose compiler parallelism without changing Ducklang. Step
seven is a new optimization with its own validation and remains unimplemented.

### 7.12 General high-level-IR target

Gpupaper's reusable language boundary is not Ducklang or Blot source. It is the
monomorphic typed SSA/CFG module $C$ consumed by Core validation and Wasm
lowering. The internal implementation types retain historical names, while the
consumer facade exports neutral `CoreModule`, `CoreType`, `CoreOperation`,
`validateCore`, and `lowerCoreToWasm` names from `src/core.ts` and
`src/core_wasm.ts`. The schema contains no parser node, module lookup rule,
source type variable, or language-specific binding construct. It consists of
type, signature, function, block, value, operation, terminator, span, and entry
tables. Therefore a language frontend $F$ targets gpupaper when it establishes

\[F:S\rightharpoonup C\]

for its accepted source domain $S$ and supplies the source-language proof
obligations erased before $C$: resolution, typing, effect permission, ownership,
specialization, and calling-convention policy. Gpupaper then implements the
partial backend function

\[G:C\rightharpoonup P\rightharpoonup B,\]

where $P$ is a validated deterministic Wasm binary plan and $B$ its unique byte
string. Calling the project a general compiler means that $G$ is reusable by
independent $F$ implementations; it does not mean gpupaper accepts arbitrary
source text or reconstructs a frontend's theorems.

The Core validator checks closed table indices, stable function and block IDs,
type-correct entry parameters, single SSA definition, dominance, typed CFG edge
arguments, function results, call signatures, Store operations, 128-bit vector
shapes, SIMD operations, representation-preserving seals, and resource/region
operation shapes. Wasm target validation adds physical restrictions such as
rejecting vectors on `wasm-scalar` and at the managed JavaScript boundary. The
validator does not infer a source effect row or prove that an ownership-labelled
transition was permitted by the source calculus; those facts belong to $F$.

The backend currently represents scalars, 128-bit vectors and masks, products,
sums, buffers, Stores, functions and closures; typed branches, back-edges,
returns, and traps; aggregate, call, host-call, resource, and region operations;
explicit exports and custom sections; functional-graph rewrites; structured Wasm
lowering; stackification; and deterministic plan construction. The plan can be
emitted by TypeScript, Rust compiled to WebAssembly, or WebGPU without changing
its byte semantics. Thus backend selection is below $C$ and cannot change the
source language admitted by $F$.

For a source program with frontend work $W_F$, Core size $|C|$, backend graph
work $W_G(C)$, plan atom/dependency counts $(A,D)$, and output bytes $y$, the
complete work is

\[W_{total}=W_F+W_G(C)+\Theta(A+D+y).\]

Only the final term is shared by the three binary emitters. A claim that GPU
emission accelerates an entire language compiler must therefore report all three
terms and the CPU--GPU transfer and completion latencies; emitter-only speedup
cannot be substituted for source-to-Wasm speedup. This separation is the reason
the public documentation leads with Core and labels the bundled languages as
conformance frontends.

Executable validation includes direct synthetic Core modules, generated
CPU/Rust/GPU binary-plan differentials, engine validation, and two independent
source producers. This proves exercised cases, not universality over every
possible frontend $F$. A new language integration is complete only when its own
source oracle and ABI observations agree with $G(F(s))$ on its declared corpus.
The neutral public facade has an executable import-level test that constructs a
Core module without a bundled frontend, validates and lowers it, emits its plan,
instantiates the Wasm, and observes the exported result.

#### Blot Runtime HIR as a conformance producer

The copied Blot grammar and the earlier `let*; return` payload were not a sound
route to full Blot compilation and have now been deleted. Blot's checker owns
staging, algebraic subtyping, nominal constructor sets, effect rows, ownership
proofs, imported module identities, and pinned-pattern domains. Reconstructing
any of those from Baba compact syntax would create a second type checker whose
agreement was neither specified nor proved. The selected target boundary is
therefore after Blot has erased compile-time values and specialized
polymorphism, but before a particular backend chooses Wasm layouts.

The boundary is a first-order typed SSA/CFG calculus. A module contains stable
type, signature, function, block, and value tables; explicit products, sums,
seals, stores, vectors, calls, host calls, ownership transitions, branches,
returns, and traps; declared capability signatures; and source-to-Wasm export
descriptors. Every operation carries its result type, ownership class, operands,
and source span. Effects inhabit function signatures, not a side table inferred
from host calls after lowering.

For a checked and staged Blot module \(M\), target lowering \(L\), gpupaper
emission \(E\), and an observation function containing results, traps, ordered
host operations, exported ABI values, and ownership-visible allocation behavior,
the required simulation is

\[ \operatorname{Obs}(M) =\operatorname{Obs}(L(M)) =\operatorname{Obs}(E(L(M))).
\]

Binary equality with gpufuck is not required because layout and optimization are
target choices. Equality of observations and Blot Core Wasm ABI 1 metadata is
required. The gpufuck backend remains an independent differential oracle until
the complete Blot corpus satisfies this equation.

An unvalidated JSON-shaped module is not accepted by lowering. The validator
returns an opaque `ValidatedBlotRuntimeModule` capability, and the CPU planner
and GPU target require that capability. This makes validation a parse boundary:
downstream code cannot accidentally treat structurally similar, untrusted input
as proved HIR without an explicit unsafe cast. The validator currently enforces
the following executable invariants:

1. schema version, table indices, stable table-order IDs, and unique exported,
   capability, operation, field, and constructor names;
2. signature/type closure and exact entry-block parameters;
3. single SSA definition and dominance for every operand and terminator value;
4. typed block-edge arguments and exact function result types;
5. every host call names a declared capability operation and every function's
   declared row is exactly the least fixed point of the capabilities named by
   its reachable host calls, direct callees, and indirect-call signatures; and
6. an in-place Store update is labelled `owned-reuse` only when its result
   carries owned evidence.

Dominance is calculated as the least fixed point

\[ D(entry)=\{entry\},\qquad D(b)=\{b\}\cup\bigcap_{p\in pred(b)}D(p). \]

The implementation uses immutable input and constructs predecessor and
definition maps before validation. For \(B\) blocks, \(V\) values, \(R\)
operand/edge references, and \(E\) CFG edges, table validation takes
\(O(V+R+E)\) work apart from the simple bit-set-free dominance iteration. That
iteration takes at most \(B\) shrinking rounds over \(B\)-element sets, giving
an explicit \(O(B^3+EB)\) conservative bound and \(O(B^2+V)\) memory. This CPU
trust-boundary validator is selected for clarity; the production GPU transform
will consume already validated flat columns. Replacing it with Lengauer--Tarjan
would change constants and asymptotics but not the target semantics, and is not
justified until validation is measured as material.

The executable target now maps scalar operations, typed CFG edges, direct and
indirect calls, captured closures, recursive functions, products, sums, seals,
SIMD operations, Store operations, text operations, host calls, and ownership
transitions into validated gpupaper Core. Checked signed 64-bit addition,
subtraction, and multiplication use explicit overflow predicates before the Wasm
operation; tests cover the safe and overflowing regions of all three families.
Store updates have separate persistent-copy and proved-owned-reuse operations.
Text length and comparison operate on Unicode scalar values rather than
JavaScript UTF-16 code units.

Effect labels at this boundary name capabilities, not individual operations. A
host call `C.o` therefore requires `C` in its enclosing row, while its import
still records the exact operation `o` and its signature. This is the algebra
that Blot handlers implement: handling `C` discharges the family of operations
belonging to that capability rather than one member selected after inference.
The rejected operation-labelled model produced `Console.write` where Blot and
its ABI require `Console`; exact-manifest comparison exposed the counterexample.

#### Checked staging and unit-effect residualization

The producer is now inside Blot after checking, staging, specialization, and
ordinary lowering have fixed expression types, export schemas, runtime nominal
types, grants, capability signatures, and staged values. Inference retains an
expression-to-type map instead of asking the target to infer syntax again. The
producer consumes Blot `Value`, `TypeSchema`, and runtime-type declarations and
emits Runtime HIR; it does not parse Blot or invent constructor sets.

The admitted source-to-target subset consists of closed value exports whose
strict-eager module evaluation can be residualized, plus synchronous host
operations with a stage-known first-order argument and either an inferred `Unit`
result or an unconstrained result that no expression observes. Blot's existing
host lowering canonicalizes exactly that unobservable result to `Unit`; the
target consumes the same checked grant fact rather than claiming the
unconstrained source variable was itself proved equal to `Unit`. Write

\[ \operatorname{eval}_{sym}(M)=(v,\tau),\qquad
\tau=[(C_0,o_0,a_0),\ldots,(C_{k-1},o_{k-1},a_{k-1})]. \]

The symbolic host answers each `C.o : A -> Unit` with `Unit` and appends the
call and its already evaluated argument to `tau`. If `pi_x` projects export `x`,
its generated runtime function is

\[ L_x(M)=\operatorname{replay}(\tau);\operatorname{encode}(\pi_x(v)). \]

This is an online partial-evaluation boundary in the sense of Jones, Gomard, and
Sestoft [10], with a deliberately smaller binding-time rule. The proof is by
induction over the strict evaluator. Pure steps are evaluated identically. At a
residual host step the result is the unique `Unit` inhabitant, so no host return
value can change later value flow or control; appending the exact capability,
operation, and argument preserves the sequential trace. Replay performs those
calls in the same order before exposing the result, so an external side effect
or trap is observed at the corresponding point. A non-`Unit` result, unknown
argument, asynchronous operation, or unresolved function value invalidates this
argument and is rejected rather than guessed.

#### Checked residual SSA for input-dependent effects

The admitted input-dependent binding-time rule generalizes the unit-trace proof
without turning an arbitrary evaluator value into a compiler IR node. For each
checked first-order type `t`, the residual domain is the disjoint sum

\[D_t=\operatorname{Static}(v:t)+\operatorname{Dynamic}(x:t).\]

Products used only to apply source closures may contain members from either
summand, but every `Dynamic` leaf names one dominating Runtime-HIR SSA
definition. Closures, host effects, operations, and partially applied intrinsics
remain static compiler values; they never cross the Runtime-HIR boundary. The
producer consumes the checker's expression types, open bindings, compile-time
declaration values, host signatures, and staged export schemas. It does not
infer a type, reconstruct a capability, or identify a primitive from a surface
spelling.

Residual evaluation is strict left-to-right call-by-value. Write

\[\langle e,\rho,b\rangle\Downarrow(d,b',G)\]

for expression `e`, residual environment `rho`, current block `b`, result `d`,
final block `b'`, and appended HIR graph fragment `G`. A pure operation whose
arguments are all static is evaluated at staging time. An admitted primitive
with at least one dynamic operand emits one typed SSA operation. A synchronous
host operation `C.o : A -> B` first residualizes `A`; it then emits `host.call`
in program order and returns `Dynamic(x:B)`, including when `B` is not `Unit`.
Therefore a later operation may depend on the host result without fabricating a
placeholder value. A dynamic Boolean conditional creates two successor blocks
and a join whose parameters are exactly the branch result's dynamic leaves;
static conditions select one arm and create no CFG. This is ordinary online
partial evaluation [10], but the residual language is the validated HIR rather
than source syntax.

Blot has already lowered source `return` through conditionals into finite
control sums when this boundary runs. Residual branches whose results are
different constructors therefore create an internal sum with one unit payload
per constructor, and a later case emits `sum.tag`, the checked branch, and
`sum.payload`. The rule depends on the constructor set carried by the residual
value, not generated name prefixes. For a binary generated sum, the canonical
text emitter represents the internal value by its `i32` discriminant; the unit
payload has no runtime information. This is the standard elimination rule for a
finite coproduct and preserves the already explicit source-control order.

The first executable calculus is intentionally `Unit + Bool + I32 + Text`,
synchronous host calls over `Unit` and `Text`, text concatenation and
comparison, and finite conditionals. It is enough for the terminal study: a host
returns a name, the program compares it with empty text, selects one of two
writes, and concatenates the dynamic name on one path. Loops, recursion,
handlers surviving staging, dynamic stores, and dynamic nominal aggregates
remain rejected. This boundary is semantic rather than fixture-specific:
admission is decided from checked types and HIR constructors, and any program in
the calculus receives the same lowering.

The producer must preserve four invariants. First, every dynamic use is
dominated by its definition or corresponding block parameter. Second, emitted
host calls have the same total order as the strict source evaluation along each
path. Third, a residual value's HIR type is the checked source type translated
once at the boundary. Fourth, joining control never merges different types or
different value arities. Static evaluation of a dynamic operand, syntax-based
primitive recognition, and answering a non-unit host operation with a dummy
value are counterexamples and are forbidden. Validation establishes the graph
invariants; differential tests compare both terminal branches and the exact host
trace.

For `N` visited source nodes, `R` residual operations, and `E` CFG edges, the
producer performs `O(N+R+E)` work and retains `O(R+E)` HIR words. It allocates
no runtime object while specializing static closure applications. A conditional
whose predicate is static discards one whole branch; a dynamic predicate emits
both once. This makes discard-before-parallelize explicit: staging removes
provably static work, while the remaining flat operations and blocks are the GPU
compiler's payload.

Strict eagerness requires evaluating the complete module result before
projecting an export. An earlier producer projected the syntax first; this
incorrectly omitted module-initialization effects from otherwise constant
fields. Exact effect-row comparison supplied the counterexample. The selected
producer evaluates the module symbolically once, obtaining one `v` and `tau`,
then projects all exports and attaches a copy of the same runtime replay trace.
For source-evaluation work `S` and `E` runtime exports, this changes
compile-time work from `O(E S)` to `O(S+E)` without memoizing or discarding
runtime effects.

#### Revision-keyed Runtime-HIR memoization

Warm batch measurements expose a second duplication boundary. `prepare()` is
already memoized by Blot's `Loaded` object identity, but `prepareGpupaperHir()`
repeats symbolic residualization and Runtime-HIR export on every call. The
loader supplies a semantic revision token: an unchanged source/dependency
closure returns the same `Loaded` object, while `refreshLoadedModules()` removes
every changed module and transitive importer so the next load receives a fresh
identity. A path alone is not such a token.

Let \(l\) be a loaded revision, \(P(l)\) its checked/staged prepared module, and
\(R(P(l))\) deterministic residualization plus HIR export. This is selective
memoization with the loader identity as the explicit dependence key [12]. The
cache is

\[ K[l] = \operatorname{freeze}(R(P(l))). \]

The lookup law is \(K[l]=R(P(l))\), not observational approximation. The batch
entry point must refresh the loaded graph once before any lookup. A hit may
return the same object only because the complete HIR object graph is frozen;
otherwise a JavaScript consumer could mutate one result and corrupt later
compilations. Failures are not cached. Weak identity keys allow obsolete
revisions to die after the loader and bounded incremental tables release them.

The invariants are:

1. same loaded identity implies the exact same frozen HIR identity and bytes;
2. a source or transitive dependency edit produces a fresh loaded identity and
   cannot hit the old HIR;
3. batch refresh occurs once before preparation, never once per module;
4. validation and Wasm artifacts from cached and freshly derived HIR are
   byte-identical; and
5. no compiler-visible mutation is possible through a returned HIR reference.

For module \(i\), let residualization/export cost be \(r_i\), HIR size \(h_i\),
lookup cost \(q\), one-time freeze cost \(f_i=O(h_i)\), and let the same
revision be prepared \(k_i\) times. The uncached work is \(\sum_i k_i r_i\);
memoized work is \(\sum_i(r_i+f_i+(k_i-1)q)\), retaining \(\sum_i h_i\) bytes
while revisions are live. A module benefits exactly when \((k_i-1)(r_i-q)>f_i\).
Cold one-shot compilation may regress by \(f_i\); the resident and
repeated-batch boundary is the intended case. Source refresh adds one
file-content comparison per known loaded revision and must remain a separately
measured stage rather than being hidden inside a cache-hit claim.

Blot now implements this cache as a weak map from `Loaded` to deeply frozen
Runtime HIR, and `buildGpupaperBatch` refreshes the loaded graph once before
preparing any member. A hit therefore avoids residualization and export rather
than merely avoiding parsing and checking. The executable evidence establishes
same-revision reference identity, rejects mutation, and gives both a root edit
and a transitive dependency edit fresh HIR with the changed value. The complete
Blot suite passes 741 tests. Gpupaper admits all 54 top-level examples with all
315 oracle observations and compiles all 54 to valid Wasm.

The diagnostic record
`measurements/blot-batch-hir-cache-diagnostic-2026-08-02.json` measures six warm
capacity profiles. Refresh costs 0.741 ms median for the resident graph and 54
cache lookups cost 0.132 ms median, or 2.44 microseconds per requested module.
The frozen cache reaches 5,246 JavaScript objects whose JSON logical payload is
295,194 bytes, 5,467 bytes per module and 1.69 times the 175,004 emitted Wasm
bytes. JSON payload is a deterministic lower bound, not a measurement of V8 heap
residency: object headers, hash-table capacity, strings, and weak-map storage
remain unmeasured.

The earlier diagnostic attributed 95.798 ms to repeated HIR preparation. Its
input hash differs from the new record, both records observed contention, and
the earlier record has only two samples, so their 726-fold raw preparation ratio
and 2.83-fold total ratio are localization evidence rather than an admissible
speedup estimate. The new record independently establishes the implemented
warm-cache cost. It does not isolate the one-time freeze cost \(f_i\), so the
cold break-even inequality above remains a model rather than a measured
threshold.

#### Revision-keyed final-artifact reuse

HIR reuse removes repeated source semantics but still validates, plans, submits,
reads back, and validates the same deterministic module. Let \(H\) be a frozen
Runtime HIR revision that is validated before its first cache installation, let
\(\gamma\) be the complete target configuration, and define

\[ A_\gamma(H)=(W,M,C), \]

where \(W\) is the validated Wasm byte string, \(M\) is the exact embedded and
sidecar manifest byte string, and \(C\) is the sorted capability-name sequence.
The current Blot gpupaper entry point has one fixed \(\gamma\), so frozen HIR
object identity is a sufficient cache key within one loaded compiler process. A
future target option must extend the key; silently sharing artifacts across
different configurations would violate the function above.

The selected incremental rule is

\[ K_A[H]=\operatorname{copy}(A_\gamma(H)) \quad\text{only after successful
target validation}. \]

JavaScript typed arrays remain caller-mutable even when their containing record
is frozen. The cache therefore owns byte arrays that are never returned and a
hit publishes defensive copies. This costs work linear in artifact bytes but
prevents a caller from changing a later build. Failed source preparation,
validation, backend emission, or artifact validation installs no entry.

For an ordered request \([H_0,\ldots,H_{n-1}]\), the batch algorithm classifies
each ordinal as a hit, local failure, or miss; compiles the stable miss
subsequence in one target batch; installs successful misses; and scatters copied
artifacts back to source ordinals. Hits never enter the target batch. A miss
batch failure changes only miss ordinals; prior hits remain successful. This is
stable filtering followed by stable scatter, not completion-order scheduling.

The invariants are:

1. a cache hit returns byte-identical Wasm, manifest bytes, and capabilities;
2. no returned typed array aliases cache-owned storage or another outcome;
3. direct and transitive source changes produce a fresh HIR identity and miss;
4. mixed hit/miss requests submit only misses and preserve every input ordinal;
5. failures are absent from the cache and may succeed after a source repair;
6. only fully validated successful artifacts are installed; and
7. compiler-throughput measurements bypass this cache, while incremental-build
   measurements exercise it.

For module \(i\), let validation, planning, GPU execution/readback, and final
validation costs be \(v_i,p_i,g_i,a_i\). Let \(b_i=|W_i|+|M_i|\), memory-copy
bandwidth be \(B_h\), lookup cost be \(q\), and let one revision be requested
\(k_i\) times. Uncached work is \(k_i(v_i+p_i+g_i+a_i)\). Cached work is one
full compilation plus retained storage \(b_i\) and \((k_i-1)(q+b_i/B_h)\)
publication work. A hit benefits exactly when

\[ q+b_i/B_h < v_i+p_i+g_i+a_i. \]

This cache does not make changed-module compilation faster. It discards
unchanged work before scheduling; the existing direct Runtime-HIR target remains
the cache-bypassing boundary for measuring and optimizing real compiler
throughput.

Blot now implements \(K_A\) as a weak map from frozen HIR identity to
cache-owned Wasm, manifest bytes, and a frozen capability sequence. The public
outcome reports whether an artifact was `compiled` or came from the
`revision-cache`. Batch construction converts and checks the complete returned
miss batch before installing any member, then returns fresh byte arrays and a
fresh capability array for both hits and misses. Six GPU integration tests cover
local failure isolation, mutation of both byte arrays and capabilities, direct
and transitive edits, reverse-ordered mixed hit/miss scatter, and
failed-then-repaired source. The existing HIR tests separately establish the
revision identity and dependency invalidation premises.

`benchmark:blot-batch` now exposes two named boundaries in one fresh-process
record. `incrementalRebuild` invokes the public API and asserts that every warm
success is a revision-cache hit. `compilerThroughput` starts from frozen HIR,
calls validation and the Runtime-HIR GPU target directly, and therefore cannot
hit the artifact cache. Candidate source failures are retained with their exact
causes; the benchmark neither times them as target work nor silently claims the
entire live corpus was admitted.

The diagnostic record
`measurements/blot-batch-artifact-cache-diagnostic-2026-08-02.json` observed a
concurrently changing Blot worktree with 56 top-level candidates, 18 admitted
target modules, 101 oracle observations, and 38 explicit rejections. A later
recording after another concurrent edit admitted 19 modules and retained 37
rejections; that final machine-readable record is authoritative. For those 19
revisions, packed unchanged rebuilds cost 0.795 ms median and 19 separate public
calls cost 12.794 ms median. The cache retains 53,366 Wasm bytes, 41,400
manifest bytes, and 82 logical capability-name bytes, or 94,848 logical bytes
before typed-array and object headers. The cache-bypassing capacity profile cost
28.304 ms median: 6.986 ms planning and 19.523 ms GPU emission dominated it. The
record observed competing work and has six samples, so these are diagnostic
boundary measurements, not an admissible speedup estimate. Its complete-corpus,
admitted-subset, and output hashes are respectively
`28b865e8ff72ed62cda138778f0df1ecf85042b6be968b38dee8be031d0eb01d`,
`a8b9fec1cab989d49c6c1c238713e59eacc8c78d99160c1e663bb5ca5312aea4`, and
`7b023f7b8f60052da7a6fe4ed871852526fa0fdab18f059d6c72a7fd64c96c80`. Gpupaper's
complete suite passes 609 tests, including all six new GPU cache tests. Blot
type-checks, but its concurrently edited worktree currently passes 526 tests and
fails 224 across inference, lowering, and unrelated source semantics. That dirty
sibling state prevents a clean whole-Blot-suite claim; the target admission and
rejection vectors above are retained instead of concealing the boundary.

#### CPU/GPU crossover is two-dimensional

“More code” is not one workload variable. Let \(n\) be the number of mutually
independent Runtime-HIR modules in one request, let \(a_i\) be the final Wasm
plan atoms for module \(i\), and let \(A=\sum_i a_i\). Increasing one \(a_i\)
exposes instruction-level work inside one dependency graph. Increasing \(n\)
also exposes independent payloads and amortizes submission, allocation, mapping,
and readback boundaries. These transformations have different depth and fixed
costs and must not be conflated.

For the present target, both backends first perform the same deterministic
Runtime-HIR validation, Core lowering, stackification, and Wasm planning. Write
that common host cost as \(P(n,A)\). A descriptive first-order model is

\[ T_C=P(n,A)+c_0+c_n n+c_a A, \qquad T_G=P(n,A)+g_0+g_n n+g_a A. \]

The constants are adapter-, runtime-, layout-, and workload-specific empirical
coefficients, not semantic constants. The GPU can beat the CPU only where

\[ \Delta(n,A)=T_G-T_C= (g_0-c_0)+(g_n-c_n)n+(g_a-c_a)A<0. \]

For \(n=1\), making one module larger has a finite crossover only if
\(g_a<c_a\), in which case the fitted threshold is
\(A^\star=-((g_0-c_0)+(g_n-c_n))/(g_a-c_a)\). If \(g_a\ge c_a\), no amount of
code within the validity range of this affine model repays the GPU boundary. For
a fixed module shape with \(a\) atoms, batching has a finite crossover only if
\((g_n-c_n)+(g_a-c_a)a<0\), with \(n^\star=-(g_0-c_0)/((g_n-c_n)+(g_a-c_a)a)\).
These are conditional algebraic consequences of a fitted model, not proofs that
its slopes remain linear outside the measured range.

The physical lower bound is stricter. A discrete GPU request has nonzero command
encoding, queue, synchronization, and mapped-readback latency \(L_G>0\).
Compilation also has to read \(\Omega(A)\) plan words and produce \(\Omega(Y)\)
output bytes. Thus

\[ T_G \ge L_G+\max(Aw/B_G,\;W_G/P_G)+Y/B_R, \]

where \(w\) is input bytes per atom, \(B_G\) and \(B_R\) are effective device
and readback bandwidths, \(W_G\) is shader work, and \(P_G\) is effective
parallel throughput. This bound makes zero-latency singleton GPU compilation
physically impossible under the current host-visible API. It does not preclude a
crossover: sufficiently many independent atoms can amortize \(L_G\) if their
marginal GPU cost is lower. Conversely, occupancy alone cannot establish a
speedup when the CPU has the lower marginal cost.

The frozen Wasm-plan diagnostics are counterexamples to an unconditional
single-module crossover claim. At 204,168 Codex atoms, direct CPU byte emission
was 3.624 ms median and GPU emission was 27.043 ms; the five smaller targets
also favored the CPU. The packed editor-shaped series gives a different but
still unresolved case: 64 CPU emissions extrapolate to about 25.46 ms from the
0.398 ms singleton median, while packed GPU emission measured 28.581 ms. That
near boundary is not a matched paired observation and cannot establish a
crossover.

`benchmark:blot-crossover` therefore constructs validated synthetic Runtime HIR
without involving Blot's moving source corpus. It varies chain length and
logical module count independently, prepares one exact Wasm plan per shape, and
measures two boundaries: plan-to-bytes emission and validated Runtime-HIR to
validated Wasm. CPU and GPU order is counterbalanced inside every cell. Every
GPU artifact must be byte-identical to the independent CPU artifact before a
timing is retained. The report retains atoms, output bytes, physical payload
partitions, raw paired samples, observed cells, and a descriptive affine fit.
The fit is an unverified interpolation until an admissible run supplies stable
residuals; an observed byte mismatch is a correctness failure rather than a
performance sample.

The first attempted 262,144-operation run falsified the assumption that the
common host term was linear. Checked-integer lowering reconstructed the complete
function value-type map inside every operation lookup. For \(V_f\) values and
\(O_f\) operations in function \(f\), the implementation performed

\[ \Theta\!\left(\sum_f O_fV_f\right), \]

which is quadratic for a single arithmetic chain. This was an implementation
counterexample, not a physical GPU limit. The typing judgement already assigns
one immutable environment \(\Gamma_f :
\text{ValueId}\rightharpoonup\text{TypeId}\) to each validated function.
Lowering now materializes \(\Gamma_f\) once and passes it to every operation
rule. Construction takes \(\Theta(V_f)\) work and space; all operation queries
take expected \(O(1)\), so the boundary becomes expected \(O(\sum_f(V_f+O_f))\).
The existing Runtime-HIR validator proves that every operand has a dominating
definition before this lookup. Rebuilding the same map cannot add semantic
evidence and is forbidden by this representation rule.

The next run exposed the same anti-pattern at the following trust boundary.
Canonical Core validation built a definition map, but operand type checks then
searched every block parameter and operation linearly. A one-block chain again
required \(\Theta(O_fV_f)\) work. The definition judgement is more precisely

\[ \Delta_f(x)=(b,k,\tau), \]

where value \(x\) is defined in block \(b\) at operation ordinal \(k\) with type
\(\tau\). Core validation now constructs the definition-position and type
projections together during its first pass. Dominance uses the former and all
typing rules use the latter in expected constant time. This preserves the same
undefined-value and duplicate-definition failures while reducing type-checking
work to expected \(O(V_f+O_f+E_f)\), excluding the separately stated dominator
algorithm. A failed 32,768-add diagnostic measured 1,990.653 ms for complete CPU
target compilation while its already prepared plan emitted in 5.533 ms; that
observation localizes the invalid model but is not retained as a post-repair
performance claim.

The post-repair diagnostic record
[blot-crossover-diagnostic-2026-08-02.json](measurements/blot-crossover-diagnostic-2026-08-02.json)
contains two paired observations per cell under recorded compiler and GPU
contention. It is correctness and localization evidence, not an admissible
speedup result. Every GPU artifact equals the independent CPU byte string. No
CPU/GPU crossover was observed at either boundary:

| chain adds | modules | total atoms | CPU emit ms | GPU emit ms | CPU full ms | GPU full ms |
| ---------: | ------: | ----------: | ----------: | ----------: | ----------: | ----------: |
|         16 |       1 |       1,285 |       0.030 |      15.398 |       0.293 |      14.939 |
|         16 |     256 |     328,960 |       4.813 |      30.587 |      49.286 |      75.431 |
|      4,096 |      64 |   2,693,568 |      38.994 |     163.827 |     646.352 |     802.716 |
|     32,768 |       1 |     328,808 |       4.753 |      98.421 |     104.130 |     210.601 |
|     32,768 |       8 |   2,630,464 |      38.304 |     195.013 |     894.601 |   1,147.294 |

Module count and atom count are independently relevant. The two roughly
2.6-million-atom cells have similar CPU emission but differ by 31.186 ms on the
GPU despite similar output size. A scalar “bytes of source” threshold therefore
cannot select this backend; plan shape, dependency ranges, and physical
partition work are required predictors.

The descriptive emission fit estimates
\(\Delta=27.727-0.0872n+4.529\times10^{-5}A\) milliseconds, with 17.963 ms
root-mean-square residual. The positive atom coefficient predicts no
single-module crossover inside the model. Its extrapolated 16-add crossover is
956 modules, far outside the largest measured 256-module cell, which still had a
positive 25.775 ms GPU premium. The complete-target fit likewise has a positive
atom coefficient and 25.348 ms residual. These residuals and counterexamples
make both fits hypotheses; the observed no-crossover cells are the evidence.

The 64-by-4,096 cell explains why merely adding host-produced code cannot close
the gap. The two GPU samples spent 57.135–57.515 ms partitioning and packing
before physical emission. Physical emission then spent 56.741–75.999 ms
inspecting the packed plan and constructing columns. Those host passes alone
exceed the complete 38.994 ms CPU emitter. Mapped device completion was only
29.771–33.469 ms, and final readback copying was 0.227–0.566 ms. Therefore the
gap is not a physical output-transfer lower bound. It is principally an
algorithmic boundary mismatch: a host object plan is inspected, copied into a
packed object plan, inspected again, converted to structure-of-arrays columns,
and only then submitted.

This yields a conditional feasibility result. If the plan remains a host object,
the GPU path has at least two additional \(\Omega(A)\) host passes before doing
the same necessary output work, so larger plans do not asymptotically erase the
measured disadvantage while those passes have higher combined marginal cost than
direct CPU emission. If the preceding lowering produces validated GPU-resident
columns and a capacity witness directly, partitioning becomes \(O(n)\) scalar
metadata work, atom packing becomes virtual prefix rebasing, column construction
disappears, and only terminal bytes cross to the host. The 29.771–33.469 ms
mapped completion interval versus 38.994 ms CPU emission shows that such a
boundary is physically capable of being competitive for this large independent
batch. It does not prove a speedup under a clear environment.

Amdahl's law sets the more important complete-compiler restriction. In the
64-by-4,096 cell, replacing the 38.994 ms CPU emitter with a zero-time emitter
could improve 646.352 ms by at most \(646.352/(646.352-38.994)=1.064\), or 6.4%.
In the eight-by-32,768 cell the corresponding limit is
\(894.601/(894.601-38.304)=1.045\), or 4.5%. More code makes this project useful
only if Core construction, stackification, layout, and validation also move to
the GPU or are discarded by revision caching. Accelerating only final Wasm bytes
is not a route to a large end-to-end gain.

The next representation boundary is therefore derived, not optional:

1. the producer emits immutable GPU-resident Wasm-plan columns plus a checked
   structure/capacity witness;
2. a stable exclusive scan assigns logical module atom bases without copying
   host atom objects;
3. length ranges are stored relative to a module base and interpreted with that
   base, so packing requires no atom rewrite;
4. GPU validation differentially checks the witness and byte output against the
   current CPU oracle; and
5. only final artifact boundaries and bytes are mapped to the host.

Until those invariants are implemented, the CPU emitter is the performance
oracle for host-resident plans, packed GPU emission is justified only relative
to separate GPU submissions or by a GPU-residency requirement, and unchanged
revisions should use the artifact cache rather than either emitter.

#### Resident Wasm-plan calculus

The migration target is an affine device resource, not another host snapshot.
For device identity \(d\), define

\[ R_d=(K,L,H,Q,I,P,\Lambda,C), \]

where \(K,L,H\) are dense per-atom kind, low-word, and high-word device columns;
\(Q,I\) are local length-range and local length-atom columns; \(P\) is the
stable payload atom-base column; \(\Lambda\) partitions length ranks by
dependency level; and \(C\) is the validated capacity certificate. Dense
per-atom columns deliberately replace the compact host-transfer representation:
they permit a preceding GPU pass to write atom \(j\) independently and permit
payload segments to be copied device-to-device without cross-payload bit-word
repair. Compact nibbles and ranked bytes are profitable only at a host upload
boundary, which residency removes.

Every length record stores

\[
(\text{payload},\text{localAtom},\text{localStart},\text{count},\text{level}).
\]

The sizing kernel resolves global positions as
\(P[\text{payload}]+\text{localAtom}\) and
\(P[\text{payload}]+\text{localStart}\). Therefore stable batching concatenates
payload address intervals and scans their sizes, but rewrites no atom or length
record. This is segmented relocation by a base environment, the same algebra as
link-time section-relative relocation. It replaces \(\Theta(A)\) host atom
rebasing with \(O(n)\) base metadata and any device-to-device segment copies
already required by ownership.

The certificate is

\[ C=(d,n,A,Y,\ell,D,\Lambda,\rho), \]

with payload count \(n\), atom count \(A\), maximum output capacity \(Y\),
length count \(\ell\), dependency work \(D\), level regions \(\Lambda\), and the
exact storage/dispatch resource witness \(\rho\). Construction accepts a
resident plan only after checking:

1. payload bases start at zero, strictly increase, and end at \(A\);
2. every local atom and range is confined to its payload interval;
3. length levels are topologically ordered and agree with \(\Lambda\);
4. all device buffers belong to \(d\) and meet the sizes certified by \(\rho\);
5. \(Y\), all prefix sums, and all copy ranges are safe integers and fit the
   adapter; and
6. ownership is affine: one resident handle releases every retained lease
   exactly once, emission only borrows it, and use after release fails before
   command encoding.

For a host-created compatibility plan, conversion still costs \(\Theta(A+\ell)\)
host work and \(\Theta(A+\ell)\) upload. It can amortize that cost across
repeated emissions but cannot support a cold speedup claim. The important
producer contract accepts already-resident dense columns and a certificate from
the preceding GPU lowering. Under that contract, preparation cost is
\(O(n+|\Lambda|)\) host metadata, no atom column crosses PCIe, and emission
borrows the producer's buffers. A differential oracle must construct the old
host plan outside the measured resident boundary until generated tests cover
every atom form, dependency level, payload partition, and capacity edge.

WebGPU creates one unavoidable terminal-layout choice. Copy command sizes are
encoded by the host; a shader cannot make a buffer-copy command consume the
final scan offset indirectly. A one-submission emitter can copy conservative
capacity \(Y\), map it once, and publish only the exact prefix \(y\le Y\). An
exact physical transfer must instead map the terminal offset, then issue and map
a second copy of exactly \(y\) bytes. If mapping/submission latency is \(L_m\)
and the avoided padding is \(Y-y\), exact transfer is profitable only if

\[ (Y-y)/B_R > L_m. \]

The one-submission mode is selected unless this inequality is supported by an
adapter measurement. Both modes return only owned exact artifact bytes; they
differ in physical transfer volume and synchronization depth, which benchmarks
must report separately.

The compatibility implementation now realizes the affine consumer half of this
calculus. `createGpuResidentWasmPlans` validates ordinary host plans, constructs
dense columns directly without first constructing a rebased packed atom graph,
uploads each capacity-safe physical partition once, and then drops every host
typed-array mirror. The retained host state is only payload boundaries, level
regions, scalar layout metadata, and the certificate. An emission borrows the
input leases and allocates fresh size, offset, output, and readback scratch.
Capacity partitioning passes its validated structure witness into column
construction, so compatibility creation performs one structural inspection
rather than two independent \(\Theta(A+D)\) inspections. Calling `release`
during a borrow marks the handle dead and defers lease return until the last
borrower finishes; double release and use after release fail. Thus repeated
emission implements items 2 and 3 of the derived boundary and the consumer side
of item 4. It does not yet implement item 1's important case: no current GPU
stackifier produces (R_d), so compatibility creation still pays one
(Theta(A+\ell)) host construction and upload. Calling that path direct GPU
production would erase the exact boundary the model is intended to expose.

The retained dense input size before allocator rounding is

\[ M_R=12A+16\ell+4n+16(1+|\Lambda|)\ \text{bytes}, \]

because kind, low, and high words are dense, each length has atom, payload,
range-start, and range-count words, each payload has one base, and every level
plus the scalar pass has a four-word uniform. This deliberately spends more
device memory than ranked host-transfer columns to make independent GPU writes
and zero-rewrite concatenation possible. The certificate reports actual leased
bytes after minimum-buffer and pool rounding. A `u32` atom or output domain and
all adapter buffer/dispatch limits are checked before a resident handle is
published.

The two-sample
[resident crossover diagnostic](measurements/blot-crossover-resident-diagnostic-2026-08-02.json)
ran on the RTX 4080 SUPER while another Deno GPU process was resident, so it is
correctness and localization evidence, not an admissible speedup claim. Every
resident output was byte-identical to independent CPU emission. Representative
medians are:

| chain adds | modules | total atoms | CPU emit ms | cold GPU ms | resident GPU ms | resident preparation ms |
| ---------: | ------: | ----------: | ----------: | ----------: | --------------: | ----------------------: |
|         16 |     256 |     328,960 |       7.802 |      30.977 |          17.692 |                  19.865 |
|        256 |     256 |     943,616 |      30.255 |      54.856 |          19.682 |                  42.200 |
|      4,096 |      64 |   2,693,568 |      72.121 |     173.388 |          71.654 |                  83.086 |
|     32,768 |       8 |   2,630,464 |      69.149 |     149.643 |          83.732 |                  99.207 |

The 64-by-4,096 cell removes 101.734 ms from the repeated boundary and is
nominally 0.467 ms below the paired CPU median, which confirms that host plan
conversion was the dominant removable term there. This is not an admissible
crossover: CPU contention inflated the CPU median relative to the prior
diagnostic, the two device-completion observations were 56.223 and 65.726 ms,
and the similar-atom eight-by-32,768 cell had a 44.065 versus 111.578 ms
completion spread. Module shape and external scheduling remain material hidden
variables. The measured actual/capacity output for the 64-by-4,096 cell was
3,202,176/7,970,368 bytes. Even though the single-map mode physically copied
4,768,192 padding bytes, owned host prefix copying took only 0.439--1.429 ms;
adding another submission and mapping synchronization is therefore not justified
by this diagnostic. The result reports `physicalReadbackBytes`,
`logicalReadbackBytes`, and `readbackPaddingBytes` so a different adapter can
test the inequality rather than inherit this choice.

Executable validation currently consists of CPU structural validation before
compatibility upload plus CPU/GPU byte differential tests covering nested
lengths, multiple physical partitions, repeated borrow, ordinal isolation, and
release races. A future direct GPU producer needs a producer-issued certificate
and a GPU validation pass before it can bypass the host structural oracle. That
missing proof boundary, not buffer adoption syntax, is the remaining part of
items 1 and 4.

#### Three-backend Wasm-emission equivalence

The CPU comparison must not depend on JavaScript object traversal alone. Define
the emission semantics as the partial function

\[ E:P\rightharpoonup B, \]

from a structurally valid `WasmBinaryPlan` to its unique byte string. The
TypeScript/V8, Rust/WebAssembly, and WGSL implementations are conforming
backends exactly when they accept the same supported plan domain and, for every
accepted plan $P$, return the same $E(P)$. The WebAssembly integer encodings are
fixed by the Core Specification [27]; backend agreement is executable evidence,
while engine validation of $E(P)$ is a distinct module-validity check and not a
proof that the three algorithms agree.

The Rust/WebAssembly boundary uses version 2 of a four-column atom ABI. For atom
index $i$ and atom count $A$, the contiguous input words are:

```text
kind[i]    : byte | unsigned | signed32 | signed64 | length
first[i]   : scalar low word or length-local range start
second[i]  : signed64 high word or length range count
third[i]   : zero for scalars or length dependency level
```

This representation is injective over the current atom domain. Signed 32-bit
values are recovered by two's-complement interpretation of `first[i]`, and
signed 64-bit values by concatenating `second[i]` and `first[i]`. A length atom
needs exactly the remaining three columns. Host ingestion rejects values that
cannot be represented before coercion, and the Rust module independently checks
kinds, scalar reserved words, ranges, strict dependency-level descent, and the
declared maximum level. The memory32 boundary additionally requires
$16A\le2^{32}-1$ before allocating the host column vector or calling the u32
word-count export; larger inputs fail before JavaScript-to-WebAssembly coercion.
The Rust implementation sorts length atom indices by `(level, atomIndex)` once;
emission then evaluates each topological level and publishes no partial output
on failure.

A Rust instance owns a linear plan table. Preparation copies the `16A`-byte
column vector into WebAssembly memory, validates it, computes the unique $E(P)$,
and returns an affine handle retaining those encoded bytes. Because the plan is
immutable and $E$ is a function, the memoization equation

\[\operatorname{emit}(\operatorname{prepare}(P))=E(P)\]

holds for every later live-handle emission without re-reading the atoms.
JavaScript immediately copies the retained pointer/length into an owned
`Uint8Array`; caller mutation therefore cannot alter the memoized witness.
Releasing a handle removes its bytes and invalidates the published pointer;
stale or double use fails. The module's shared input and current-output handle
make calls sequential within one instance. Parallel CPU emission requires
independent instances, which is an explicit scheduling choice rather than
unsound shared mutation.

The scalar sizing pass uses constant-work bit formulas rather than simulating an
encoding loop. For an unsigned $N$-bit word $x$, let
$b_u=N-\operatorname{clz}(x)$. Its canonical unsigned LEB size is

\[s_u(x)=\max(1,\lceil b_u/7\rceil).\]

For a signed two's-complement word, let $m=x\oplus(x\gg_{arith}(N-1))$: positive
values remain unchanged and negative values become their bitwise complement.
Then

\[s_s(x)=\lceil(N-\operatorname{clz}(m)+1)/7\rceil.\]

The extra bit is the required sign witness. The boundary cases $0,-1,63,-64,
64,-65$ and both signed extrema show that this is the same stopping condition as
canonical signed LEB emission. These formulas change sizing work from up to five
scalar loop iterations for u32/i32 and ten for i64 to one bounded sequence;
actual variable-length byte emission remains scalar.

For atom count $A$, dependency work $D$, length count $K$, and output bytes $y$,
TypeScript direct emission has work $O(A+D+y)$. Cold Rust/Wasm has the same
algorithmic work plus `16A` host-to-linear-memory traffic and $y$ owned-output
traffic. Preparation has temporary logical storage $16A+A+4K+y+O(1)$ bytes for
columns, one-byte sizes, length payloads, and the encoded witness. After
preparation it retains only $y+O(1)$ logical bytes per live plan. Resident
emission pays $O(1)$ handle selection plus the unavoidable $\Omega(y)$
owned-output copy, and no atom or dependency work. GPU resident emission has the
same logical atom work, parallel scan span, one device submission/mapping
latency, and conservative physical readback capacity $Y\ge y$. Therefore no
scalar size threshold alone orders the three backends: cold/resident state, $D$,
$A$, $y$, batch shape, and initialization state are required coordinates.

The benchmark must report four non-overlapping intervals: WebAssembly module
compile/instantiate, plan ingestion, emission, and owned-output copying. Cold
Rust numbers include ingestion; resident numbers exclude it only by retaining a
real affine handle before the timed interval. Module initialization is reported
separately and may be amortized only by a long-lived process. Every measured
output is compared byte-for-byte with the TypeScript oracle before any timing is
admitted. Counterexamples include every scalar boundary, nested and sparse
length levels, invalid same-level dependencies, release misuse, and repeated
emission after the caller mutates an earlier returned byte array.

SIMD is a preparation optimization, not part of resident emission after
memoization. The implemented structure-of-arrays ABI has four contiguous u32
columns `kind`, `first`, `second`, and `third`; it has `16A` bytes and four host
stores per atom, and four adjacent atom fields can be loaded by one `v128.load`.
For $A=4q+r$, $0\le r<4$, the SIMD validator applies the scalar validity
predicate lane-wise to $q$ vectors and the unchanged scalar predicate to the
$r$-atom tail. Reduction accepts a vector exactly when no lane reports an
invalid kind, byte range, or reserved word, preserving the scalar domain.
Range-dependency validation and variable-length byte placement remain scalar
because fixed-width WebAssembly SIMD has no general gather/scatter and their
work is irregular.

Length payload sizing is regular: each dependency contributes one size byte. For
a range of $c=16q+r$ entries, the implementation loads $q$ `v128` chunks, uses
unsigned pairwise widening addition from 16 u8 lanes to four u32 lanes, reduces
those exact partial sums into u64, and folds the $r<16$ tail scalarly. Each u32
lane sums four values of at most ten and therefore cannot overflow; the u64
accumulator preserves the existing explicit u32 payload-limit check. Ranges
shorter than 16 execute only the scalar tail [27, 29, 31, 48].

The implementation is a dependency-free Rust `cdylib` compiled for
`wasm32-unknown-unknown` with fixed-width `simd128`. Its checked-in 46,554-byte
artifact exports only linear memory and the versioned preparation, emission,
release, output, and error functions. The TypeScript boundary writes native
`Uint32Array` columns on a little-endian host and performs an explicit
little-endian conversion otherwise; this preserves the ABI without imposing four
`DataView` calls per atom on the measured platform. Released plans are removed
from a `HashMap` keyed by a monotonically increasing handle, so retained plan
memory is proportional to live handles rather than historical calls. Exhausting
the non-error u32 handle domain fails instead of reusing a stale identity. The
temporary input vector is freed after parsing. WebAssembly linear memory cannot
shrink, so physical pages remain at the instance high-water mark and are
allocator-reusable; resident memory claims therefore distinguish live logical
allocations from physical linear-memory capacity.

Backend selection is a total policy over a chosen CPU emitter
$C\in\{E_{TS},E_{RW}\}$ and GPU mode. CPU-only compilation returns $C(P)$.
Differential GPU compilation evaluates both $C(P)$ and $E_{GPU}(P)$ and returns
the GPU bytes only after exact equality. Optional authoritative GPU compilation
returns GPU bytes when available and otherwise evaluates $C(P)$; required
authoritative mode never evaluates a CPU emitter. Thus choosing Rust/WebAssembly
changes neither the accepted source semantics nor the fallback domain. It only
substitutes an independently implemented realization of $E$ at a boundary where
CPU bytes are required. The CLI exposes this choice as `--rust-wasm-emitter`,
and `CompilationOptions.cpuWasmEmitter` exposes it as `"rust-wasm"`.

A Ducklang compilation-session identity includes the CPU emitter choice. This is
necessary even though byte equivalence predicts the same artifact: backend and
timing evidence are observable fields of the returned compilation record, so
reusing a TypeScript record for a Rust request would falsify its provenance.
Executable integration tests compile both the Haskell-like and Ducklang
frontends through both CPU emitters, compare exact bytes, validate and execute
the Rust-produced modules, and exercise distinct session identities. The public
option boundary rejects any third CPU-emitter name before lowering. The compiler
deliberately uses the cold Rust path because each lowering produces a new plan;
retaining a plan is an explicit low-level operation and cannot be inferred
across compilations from equal source text.

The two-sample GPU portion and 101-sample CPU portions in
[wasm-rust-diagnostic-2026-08-02.json](measurements/wasm-rust-diagnostic-2026-08-02.json)
ran before resident memoization with recorded compiler and GPU contention. The
following historical medians are diagnostic rather than admissible speedup
claims:

| target    |   atoms | TypeScript ms | cold Rust/Wasm ms | resident Rust/Wasm ms | dense GPU ms |
| :-------- | ------: | ------------: | ----------------: | --------------------: | -----------: |
| editor    |  23,923 |         0.649 |             1.235 |                 0.217 |       14.421 |
| codex     | 204,168 |         6.812 |            10.763 |                 1.748 |       34.909 |
| grep      |   3,897 |         0.116 |             0.211 |                 0.037 |       13.099 |
| tar       |  22,201 |         0.572 |             1.142 |                 0.194 |       15.674 |
| wav       |   2,477 |         0.068 |             0.129 |                 0.024 |       12.487 |
| raytracer |   3,851 |         0.103 |             0.197 |                 0.035 |       12.901 |

Cold Rust/Wasm is 1.58--2.00 times the TypeScript median because atom
serialization and Rust validation dominate. Resident Rust/Wasm is 0.257--0.353
times the TypeScript median on all six targets. For Codex, its 1.722 ms Rust
execution and 0.021 ms owned copy explain nearly all of the 1.748 ms boundary;
cold serialization and copy/validation have 5.220 and 3.532 ms medians. The
single initialization observation was 0.589 ms and is not a distribution. Using
each one-time resident preparation observation, the descriptive session
break-even is 2--10 emissions depending on target, or two for Codex. This is a
hypothesis under contention, not a backend selection rule.

The post-memoization and SIMD
[diagnostic record](measurements/wasm-rust-simd-diagnostic-2026-08-02.json) uses
the same 10 warmups and 101 rotated CPU observations per target, with two GPU
observations, and again records foreign compiler/GPU work. It therefore supports
only diagnostic comparisons:

| target    | TypeScript ms | cold Rust/Wasm ms | resident Rust/Wasm ms | dense GPU ms |
| :-------- | ------------: | ----------------: | --------------------: | -----------: |
| editor    |         0.456 |             0.957 |                 0.005 |       14.832 |
| codex     |         4.711 |             7.638 |                 0.025 |       31.058 |
| grep      |         0.075 |             0.147 |                 0.003 |       12.507 |
| tar       |         0.392 |             0.849 |                 0.005 |       14.726 |
| wav       |         0.071 |             0.112 |                 0.002 |       12.463 |
| raytracer |         0.069 |             0.146 |                 0.002 |       12.563 |

Cold Rust/Wasm remains 1.58--2.16 times TypeScript because it must construct and
copy `16A` bytes and independently validate and encode a new plan. Memoized
resident Rust/Wasm is 0.0053--0.0345 times TypeScript, or 29.0--188.3 times
faster on this boundary. Codex resident execution has a 0.00039 ms median and
its mandatory 226,211-byte owned copy has a 0.02402 ms median; the previous
1.722 ms re-encoding term is absent. The descriptive preparation break-even is
two emissions for Codex, grep, and wav and three for Editor, tar, and raytracer.
The single 46,554-byte module initialization observation is 0.429 ms and is not
a distribution.

The optimization sequence also supplied a counterexample to indiscriminate SIMD.
Only 3.27--11.54% of four-atom groups in the frozen plans contain four bytes, so
vector validation plus all-byte classification alone increased the measured Rust
copy/validation/encoding component by 6.0--15.8% in an exploratory contended
run. Adding 16-byte SIMD range summation, where the exact dependency work is
4,609--403,129 size entries, reversed that result: the component fell by
14.0--17.9% relative to the fixed-field-only SIMD variant and by 4.2--9.8%
relative to the memoized scalar/AoS baseline on all six targets. Those
intermediate runs are unretained exploratory evidence, not an admissible paired
estimate; the final absolute observations and atom/work counts are retained in
the machine-readable record. The accepted design therefore uses SIMD for every
four-lane validity group and every 16-byte size-range chunk, retains a scalar
diagnostic/tail path, and does not attempt variable-width SIMD emission.

The decisive implementation result is independent of timing: every frozen and
generated output is byte-identical across TypeScript and Rust/Wasm, every GPU
comparison uses the same oracle, all five atom forms and sparse/nested levels
are covered, every LEB transition and SIMD range boundary is covered, malformed
vector lanes retain exact diagnostics, invalid dependency and numeric boundaries
fail, and affine release and owned-output isolation are executable tests. The
Rust backend is therefore feature-equivalent at the current Wasm-plan boundary.
It is not yet a direct consumer of GPU-resident columns, and its single-instance
calls are deliberately sequential.

#### Stable packed module batches

Blot exposes compilation parallelism only after checking and residualization. A
logical target batch is the ordered sequence

\[\mathcal B=[(o_0,M_0),\ldots,(o_{n-1},M_{n-1})],\]

where `o_i=i` is the input ordinal and every `M_i` is independently validated
Runtime HIR. Compilation performs no payload effects: host operations in `M_i`
are encoded into Wasm but never executed by the compiler. Consequently modules
have no cross-job effect edge. Import dependencies have already been checked and
specialized into each residual module, so inventing an inter-module effect DAG
at this boundary would confuse program execution with compiler execution.

Let `plan(M_i)=P_i`, let `a_i` be the atom count of `P_i`, and define prefix
atom boundaries `b_0=0` and `b_{i+1}=b_i+a_i`. The physical packed plan is the
ordered concatenation

\[P_{\mathcal B}=P_0\mathbin{+}\cdots\mathbin{+}P_{n-1}.\]

A non-length atom is copied unchanged. A length atom from `P_i` with local range
`[s,s+c)` becomes `[b_i+s,b_i+s+c)` and retains its dependency level. Because
every local length range lies inside its own plan, rebasing preserves the length
dependency graph and creates no cross-module edge. Independent length atoms at
the same level are therefore sized by the same GPU frontier. One exclusive scan
over the packed atom sizes gives global byte offsets. The emitter copies offsets
at `b_1,...,b_n` into the readback, yielding byte boundaries
`q_0=0,q_1,...,q_n`; artifact `i` is the isolated copy `output[q_i:q_{i+1}]`.

The required invariants are:

1. **Singleton equivalence:** packing `[M]` emits exactly the bytes and ABI
   manifest of ordinary compilation of `M`.
2. **Stable identity:** output position `i` belongs to input ordinal `o_i`, not
   GPU completion order.
3. **Range confinement:** every rebased length range remains inside
   `[b_i,b_{i+1})`, and every returned byte range remains inside
   `[q_i,q_{i+1})`.
4. **Byte isolation:** public artifacts receive disjoint owned byte arrays; a
   caller cannot reach the packed backing allocation through one artifact.
5. **Failure monotonicity:** a source preparation failure is local and excluded
   before GPU work. After submission the admitted logical batch is atomic: if
   one physical partition fails, completed sibling partitions are discarded and
   no admitted artifact is returned.
6. **Semantic noninterference:** batching changes compiler scheduling only. It
   neither executes nor reorders a Blot host effect.

The implementation now partitions by adapter capacity rather than a logical
payload count. It greedily takes the longest contiguous prefix whose
conservative resource vector fits `maxBufferSize`,
`maxStorageBufferBindingSize`, and `maxComputeWorkgroupsPerDimension`. Let `m`
be the resulting physical-plan count. Contiguous partitioning preserves ordinals
without a sort. For `A=sum_i a_i` atoms and total maximum encoded capacity
`Y=sum_i Y_i`, packing, column construction, scan, emission, boundary readback,
and artifact copying require `O(A+n+Y)` work and `O(A+Y+n)` space. Compared with
`n` separate emissions, it changes `n` atom scans, output arenas, mappings, and
payload command buffers into `m` of each. It does not remove Blot's
`sum_i T_prepare_i`, gpupaper's `sum_i T_plan_i`, or the total atom work. The
present owned-artifact API copies `Y` bytes from mapped GPU memory into one
packed host array and then copies the same `Y` bytes into isolated artifact
arrays. Thus it performs exactly two linear host-copy passes after mapping,
although its asymptotic host-copy work remains `Theta(Y)`. A singleton reuses
the first owned array directly and therefore performs only the mapped-memory
copy.

With per-physical-batch fixed cost `H`, per-module GPU work `g_i`, and packed
overhead `r(n,A)`, the first break-even condition is

\[nH+\sum_i g_i > mH+\sum_i g_i+r(n,A).\]

Equivalently, packing is justified only when `r(n,A)<(n-m)H`. This predicts no
benefit for `n=1` and explains why splitting one 29-operation terminal module is
the wrong transformation: it increases the number of boundaries without exposing
an independent semantic module. The earlier diagnostic terminal throughput of
524.4 modules/s at requested batch 16 corresponds to about 1.91 ms of service
capacity per module, but it used separate per-module arenas. It motivates the
packed experiment; it does not establish the new implementation's speedup.
Function-level splitting remains outside this model until callable relocation,
linking, and per-function output ownership are specified.

This construction instantiates the work/depth and scan models already selected
in Sections 7.1 and 7.10 [17, 36]. The singleton, rebasing, ordinal, isolation,
physical-failure, and CPU/GPU byte differentials are required executable
evidence; runtime improvement remains an empirical claim.

The packed boundary is implemented. Blot prepares every input path, retains its
ordinal, excludes local source failures, and sends the admitted sequence through
`compileBlotRuntimeModulesOnGpu`. Gpupaper validates every local plan before
packing, calculates a conservative resource witness, greedily forms
capacity-admitted prefixes, performs one combined GPU layout per prefix, maps
the terminal offsets, validates each resulting Wasm and exact embedded manifest,
and copies each public artifact into its own backing buffer. A singleton uses
the same batch API but retains the direct emitter's owned bytes. Tests cover a
locally invalid Blot source between two admitted sources, exact CPU/singleton
bytes, rebased nested lengths, a deliberately escaping local length range,
ordinal identity, distinct output buffers, capacity-forced 2/1 partitioning,
crossing the former command cap with one 17-module plan, dynamic Wasm validity,
and reported target timings. Existing queue tests establish that one physical
command failure rejects every payload in that submission. These are executable
validations of the listed invariants, not a proof for arbitrary driver
execution.

The benchmark now counterbalances the old queued-per-module emitter against the
packed emitter for identical terminal plans. A five-sample run on 2026-08-02 was
diagnostic because unrelated Cargo work was active:

| modules | queued p50 ms | packed p50 ms | queued/packed | packed modules/s |
| ------: | ------------: | ------------: | ------------: | ---------------: |
|       1 |        15.457 |        15.586 |         0.992 |             64.2 |
|       4 |        19.262 |        15.909 |         1.211 |            251.4 |
|      16 |        31.647 |        17.935 |         1.765 |            892.1 |
|      64 |       137.357 |        28.581 |         4.806 |          2,239.3 |

The singleton counterexample agrees with the break-even equation: packing one
module was 0.8% slower. At 16 modules one physical packed plan reduced median
emission by 43.3% and provided about 1.12 ms of service capacity per artifact.
At 64 modules, four packed plans shared one four-command submission and provided
about 0.447 ms per artifact, while the old path still allocated and mapped 64
arenas. These measurements support fixed-boundary amortization under this
adapter and workload but are not release evidence. They exclude Blot's serial
HIR preparation and gpupaper's per-module Wasm planning, neither of which this
batch changes. The same run's singleton source-to-Wasm latency remained 19.106
ms p50 versus gpufuck's 1.280 ms, as the model predicts for `n=1`.

`deno task benchmark:blot-batch` measures the actual multi-path Blot target and
requires every packed artifact and manifest to be byte-identical to singleton
compilation before reporting. One warmup followed by four counterbalanced
samples over all 53 top-level examples ran with a clear environment on the same
adapter. Packed compilation measured 131.401 ms p50 and 141.779 ms p95, or 403.3
modules/s. Repeating the former singleton target path measured 930.812 ms p50
and 1,007.078 ms p95, or 56.9 modules/s. Every paired packed-minus-singleton
difference was negative (`-790.82`, `-791.85`, `-893.25`, and `-790.05` ms), and
the p50 ratio was 7.084. All 53 outputs, totalling 173,721 bytes, were
identical. This is admissible empirical evidence for the stated warm-process,
warm-Blot-cache corpus boundary. It is not a cold-build result, an uncertainty
interval, or evidence that one module benefits.

#### Derived batch frontier and next proof obligations

The measurements reject a constant numerical interpretation of `H`. Dividing the
observed saving by the number of removed physical boundaries gives 1.118 ms at
four modules, 0.914 ms at 16, and 1.813 ms at 64. The real 53-module target
removed 49 boundaries and saved 799.411 ms, or 16.315 ms per removed boundary if
all of the saving is attributed to that count. These incompatible estimates do
not invalidate amortization; they show that `H` abbreviates queueing,
allocation, mapping, validation, JavaScript scheduling, and contention whose
costs depend on the surrounding workload. Treating any one quotient as an
adapter constant would be an unverified and contradicted model.

Two calculations remain useful without that assumption. First, the 53-module
packed path retains 14.117% of the old median wall time and removes 85.883%.
Therefore all work unchanged by packing is bounded above by 131.401 ms for this
run, but the measurement does not identify how much of that remainder is Blot
preparation, Wasm planning, GPU service, validation, or copying. Second, within
the diagnostic packed series, adding 15 modules to the singleton added 2.349 ms,
or 0.157 ms per added module, while moving from 16 to 64 added 10.646 ms, or
0.222 ms per added module. These are empirical slopes over two intervals, not
per-module constants. They establish that payload work remains after the fixed
boundary is shared and that the next benchmark must expose the remainder by
stage.

The physical partition should consequently be derived from resources rather than
a payload count. Associate plan `i` with the monotone resource vector

\[w_i=(a_i,Y_i,d_i,s_i,r_i),\]

where `a_i` is atom count, `Y_i` is output capacity, `d_i` is length-sizing
dependency work, `s_i` is a conservative largest storage-binding requirement,
and `r_i` is readback boundary count. The selected `s_i` bounds adaptive columns
by charging four bytes for every atom where a dense or sparse choice could vary.
For a contiguous interval `[j,k)`, plan inspection calculates this resource
witness before allocation. Define `F(j,k)` when the witness satisfies every
buffer, binding, dispatch, and safe-integer constraint. `F` is sufficient rather
than necessary: it may split a plan that a particular compact column layout
could admit, but it cannot admit a plan that the selected layout makes larger
than the bound. It is interval-hereditary because removing plans cannot add
atoms, bytes, dependencies, or boundaries. This deliberately conservative
predicate preserves the greedy proof across every adaptive representation.

Under the restricted objective “minimize the number of physical boundaries” with
a fixed cost per feasible partition, greedily selecting the longest feasible
stable prefix is optimal. Let its first endpoint be `g`. Any feasible partition
has first endpoint `e<=g`. If `g` crosses later partitions of an alternative,
remove every consumed partition and retain only the unconsumed suffix of the
last crossed one; interval heredity makes that suffix feasible. The transformed
alternative begins with `[j,g)` and uses no more partitions. Induction on the
remaining suffix proves optimality. This is a proof for boundary count only. It
does not prove minimum latency when large plans change shader occupancy,
length-level divergence, allocation bucket size, or queue overlap. For that
objective, measured interval cost `C(j,k)` leads to the ordered recurrence

\[D(k)=\min_{0\le j<k,\ F(j,k)}(D(j)+C(j,k)),\qquad D(0)=0.\]

The recurrence has `O(nK)` work if measurement or a proven capacity bound limits
predecessors to `K`, and `O(n^2)` otherwise. Introducing it before stable stage
timings would fit noise rather than structure. The implemented longest-prefix
rule instead has `O(n)` resource aggregation plus `O(A)` packing. Size-sorting
modules is not needed: compilation purity would permit restoring ordinals after
a physical reorder, but stable prefixes already minimize boundary count under a
single hereditary capacity predicate and avoid a new permutation,
failure-attribution, and memory cost.

There is a second independent frontier between sequential source preparation and
GPU emission. Let `c_j` be CPU preparation plus planning time for physical batch
`j`, and `g_j` its GPU emission plus readback time. In the idealized
non-overlapped model, preparing every module before submitting any packed work
has makespan

\[T_{serial}=\sum_j c_j+\sum_j g_j.\]

A two-stage, stable pipeline can submit batch `j` as soon as it is planned while
the CPU prepares `j+1`. With `P_j=sum_{h<=j} c_h`, GPU completion obeys

\[E_j=\max(E_{j-1},P_j)+g_j,\qquad E_{-1}=0.\]

and the makespan for `m` batches is `E_{m-1}`. Its lower bound is
`max(sum_j c_j,sum_j g_j)`; the exact recurrence accounts for pipeline fill and
drain. Its semantics are unchanged because planning is pure over admitted
immutable HIR and result ordinals remain stable. Naively preparing Blot modules
on multiple JavaScript workers is not yet justified: the frontend caches and
ownership of their mutable state have not been modeled. Overlap on one host
thread after GPU submission requires no such shared-state proof. It does require
batch-local failure cancellation and a bounded number of in-flight arenas so
that overlap does not turn `O(max_j(A_j+Y_j))` live GPU storage into
`O(sum_j(A_j+Y_j))`.

The singleton counterexample supplies a lawful specialization. Since
`pack([P])=P` by construction and singleton equivalence is already executable,
the plural API may route `n=1` through the direct emitter. This removes the
second host copy and the packed-boundary bookkeeping while preserving bytes and
failure semantics. The observed 0.835% regression is evidence to test this
specialization, not enough samples to claim its expected speedup.

For `n>1`, eliminating the second `Y`-byte host copy conflicts with the current
byte-isolation invariant. JavaScript `Uint8Array` values are mutable and expose
their backing `ArrayBuffer`; disjoint views into one packed array are therefore
not owned artifacts. A sound zero-extra-copy boundary must instead retain an
opaque readback arena and expose closed consumption operations such as “write
artifact `i` to this path” without returning a view or buffer to caller code.
The arena remains live until all asynchronous writes settle, then is released as
one region. A generic caller-provided sink would not suffice if it received and
could retain the view. This changes the API and lifetime proof, so it is not an
implementation detail. Returning ordinary typed-array views and documenting them
as immutable is a counterexample, not an ownership model.

The resulting evidence is ordered rather than speculative:

1. Add per-module and per-physical-batch timings for Blot preparation,
   residual-to-HIR conversion, plan construction, packing and inspection, column
   construction, GPU allocation/upload, device completion, mapping, artifact
   isolation, Wasm validation, and manifest validation. For the non-overlapped
   baseline, timings must sum to the measured boundary up to an explicitly
   reported unaccounted term; an overlapped implementation must also report
   critical-path and overlapped time rather than summing concurrent work.
   **Implemented for target planning, every emitter substage, validation, and
   the unaccounted term. Blot currently reports preparation and residualization
   together, so separating those producer substages remains external work.**
2. Record each plan's resource vector and the adapter limits, then compare
   count-16 partitions with longest-feasible-prefix partitions on the same
   randomized order and exact output differential. **Implemented and measured.**
3. Test the singleton direct specialization with counterbalanced process-level
   samples; retain it only if its paired distribution improves without changing
   bytes, manifests, or error classification. **Byte reuse is implemented; the
   first five-sample measurement does not establish a latency improvement.**
4. Measure a bounded two-stage pipeline at in-flight depths one and two. Reject
   it if overlap is absent or peak leased bytes violate its declared bound. **A
   differential depth-two benchmark and exact leased-byte accounting are
   implemented. A diagnostic run improved p50 slightly but contained a severe
   contention outlier, so production remains non-overlapped pending admissible
   evidence.**
5. Consider an opaque arena sink only after profiling shows the second `Y`-byte
   copy is material. **Rejected for now:** artifact isolation measured 0.037 ms
   in the representative reported capacity sample, about 0.031% of the 118.969
   ms target p50. Owned byte arrays remain the smaller proved interface.

The partition-count theorem and singleton identity are proved properties of the
stated model. Plan and Wasm differentials are executable validations. The
reported slopes and ratios are empirical measurements. Capacity-derived packing
and singleton byte reuse are implemented. CPU/GPU overlap remains a benchmarked
hypothesis pending an admissible run; an opaque arena sink is deliberately not
implemented.

The first instrumented clear run covered 54 current top-level Blot examples. The
stage-profile p50 values for the capacity path were 70.133 ms preparing HIR,
0.652 ms validating HIR, 18.928 ms planning Wasm, 26.949 ms emitting on the GPU,
0.472 ms validating Wasm, and 1.587 ms validating manifests, for 118.969 ms
total. Thus preparation, planning, and GPU emission accounted for approximately
59.0%, 15.9%, and 22.7% of the boundary. The target's unaccounted term was 0.059
ms. These timings share warm Blot caches and are empirical work decomposition,
not independent cold samples.

In the same counterbalanced stage run, four count-16 plans took 30.962 ms p50 in
the emission boundary and 125.028 ms total. One capacity-admitted 54-module plan
took 26.949 ms and 118.969 ms, reductions of 13.0% and 4.85%. Its 174,330 atoms
required at most 697,324 storage-binding bytes and 2,724 workgroups: 0.520% of
the adapter's 134,217,728-byte storage-binding limit and 4.16% of its 65,535
workgroup limit. A separate clear repeated-plan comparison at 64 modules found
18.831 ms for one physical plan versus 19.575 ms for four, a 3.95% improvement.
This evidence removes the inherited count-16 guard from Wasm physical plans; the
general command queue retains its independent submission-batching cap.

After promotion, an admissible four-sample production-boundary run compiled all
54 examples in 121.657 ms p50, or 443.9 modules/s, versus 768.546 ms and 70.3
modules/s through repeated singleton target calls. The ratio was 6.317 and all
artifacts remained byte-identical. The singleton plan-level comparison remained
slightly negative: 15.311 ms through the plural API versus 15.248 ms through the
queued direct API. Avoiding the second byte copy is proved by object identity,
but the first version still duplicated plan inspection. The final singleton path
now delegates to the direct queued emitter and reuses the resource and adapter
witnesses produced by that pass. An unguarded 12-sample synthetic follow-up
measured 11.856 ms through the plural API and 11.829 ms directly, a 0.23%
difference with mixed paired signs. This removes the known redundant work but is
still not admissible evidence of a latency improvement.

The depth-two harness was also run against the clean published Blot revision
after unrelated edits made the adjacent worktree non-executable. It retains
stable group order, compares every result byte with the one-plan capacity path,
and bounds simultaneous leased buffers by summing the exact pool leases and scan
buffers reported by both emissions. The diagnostic four-sample result measured
114.403 ms p50 versus 116.395 ms for one capacity plan, a 1.71% difference, with
a 3,932,220-byte (3.750 MiB) worst-case two-arena bound. One pipeline sample
took 172.642 ms while the other three took 116.987, 111.819, and 110.600 ms;
competing work was observed. This is evidence that overlap is viable, but not
admissible evidence that the extra physical boundary improves expected latency.
The production target therefore remains one longest capacity-safe plan.

#### Canonical ABI and call-scoped result regions

The target derives the Blot ABI 1 manifest directly from Runtime HIR,
pretty-prints one canonical byte sequence, and embeds those exact bytes in the
`blot:abi` custom section. Modules export memory, a preserving alignment-checked
bump `cabi_realloc`, and immutable ABI version globals. Text and arrays use
`(pointer:u32,length:u32)`, records place name-sorted fields at their
recursively aligned offsets, variants use a minimum-width sorted-case
discriminant followed by an aligned maximum payload, and seals reuse their
representation layout. Direct scalars flatten to one Wasm value; unit flattens
to none.

For a closed composite result, compilation constructs a template of `T` bytes
and `R` relative-pointer relocations. Each call allocates a fresh `T`-byte
region, copies the template, patches each relocation by adding the new base, and
returns the root pointer. Excluding `memory.grow`, call work is `O(T+R)` and
temporary compiler memory is `O(T+R)`. The allocator itself is `O(1)`;
preserving reallocation copies `O(min(old,new))`. Static UTF-8 host arguments
are borrowed from active data while the synchronous import executes. These
flattening and ownership conventions are the selected memory32, UTF-8 subset of
the Component Model Canonical ABI [46], not a claim that a Core module is itself
a Component.

The closed composite path now gives each export call a stack-disciplined result
region, following the region lifetime model of Tofte and Talpin [47]. Let the
allocator state be

\[q=(h,a,r,c),\]

where `h` is the current heap frontier, `a` is zero or the active export ID, `r`
is the active root pointer, and `c` is the call's heap checkpoint. A call to
export `i` is admitted only when `a=0`, then performs

\[\operatorname{begin}_i(h,0,0,c)=(h,i,0,h).\]

A direct result restores `h:=c` before returning. An indirect result at root `p`
leaves `(h,i,p,c)` active while the caller reads it. Its post-return is defined
only for the exact pair `(i,p)` and performs

\[\operatorname{post}_{i,p}(h,i,p,c)=(c,0,0,c).\]

A second export call, wrong export ID, wrong root pointer, or repeated
post-return traps. Consequently no allocation from one completed call aliases a
live allocation from another admitted call. This proof depends on the current
closed emitter placing every call-temporary allocation above `c` and exposing no
reference to it except the result graph. Resetting the frontier reclaims the
whole region in `O(1)` rather than walking its `N` nested allocations in `O(N)`.
If `H` is persistent pre-call memory and `A_i` is the aligned allocation volume
of call `i`, repeated sequential calls peak at

\[M_{peak}=H+\max_i A_i\]

rather than `H + sum_i A_i`. Reentrant exports through a host callback are
deliberately refused because they would violate the single-region stack law.
This is executable validation and a local simulation argument, not a general
proof for multiple outstanding results or asynchronous calls.

Dynamic direct scalar export parameters and non-unit scalar host results now
cross the direct Core path without staging: an executable `i64 -> i64` export
preserves two boundary values and an imported `i64 -> i64` result flows into the
export result. The import module is exactly `blot:host/<capability>`. The direct
admission predicate enforces the 16-flat-parameter limit. General parameter
lifting, boolean input validation, host operations returning indirect canonical
values other than `Text`, asynchronous effects, dynamic composite production,
and malformed caller-memory validation remain outside the admitted target. The
zero-parameter staged composite subset has no untrusted composite caller value
to validate; extending it requires canonical lifting checks rather than
broadening the template proof.

The remaining composite boundary cannot be obtained by wrapping the current
general Core representation. Core products, sums, stores, and text are opaque
managed-runtime handles of one `i32`, whereas Blot ABI text alone flattens to
`(i32,i32)` and nested aggregates are canonical memory graphs. There is no
representation-preserving cast from a caller graph to an opaque handle, nor a
way to lower a returned handle without the private projection tables. A bridge
would have to traverse `N` boundary nodes in `Theta(N)` work, allocate private
handles, and add undeclared JavaScript imports; the latter would violate the
published Blot module contract. Reusing the closed template would instead make
dynamic values constant. The implemented `Text` fragment therefore uses a
module-local canonical lowering whose ordinary operations use the same memory
representation as its adapters. General dynamic aggregates must extend that
route rather than introduce a hidden managed bridge or template generalization;
both remain rejected alternatives.

For the admitted dynamic `Text` calculus the selected module-local canonical
representation is two `i32` SSA components `(p,n)`, not a managed handle. Text
block arguments copy both components, while ordinary scalar values copy one.
Static UTF-8 literals occupy immutable active data. Concatenation allocates
`n_1+n_2` bytes through the exported `cabi_realloc` and performs two bounded
copies. Comparison scans the two valid UTF-8 byte sequences lexicographically;
UTF-8 preserves Unicode scalar ordering, so the byte order implements Blot's
declared text comparison without decoding scalar values. A host returning `Text`
uses Canonical ABI indirect-result form: the module passes an eight-byte result
header, the host writes `(p,n)` and allocates the payload with the module's
allocator, and the module validates the range and UTF-8 before use.
`Text -> Unit` imports receive the two flat components directly [46].

Every top-level direct-result call checkpoints the bump frontier and restores it
on every return, so host-returned and concatenated text have the same region
lifetime as the computation. With returned byte count `H`, concatenated byte
count `C`, and temporary headers `8K`, peak transient memory is `O(H+C+8K)` and
reclamation is `O(1)`. Concatenating lengths `a` and `b` costs `Theta(a+b)`
bytes copied; comparing them costs `O(min(a,b))` byte loads after constant-time
bounds checks. Validating a host result of `n` bytes costs `Theta(n)` loads and
constant auxiliary space. Packing text into a single opaque `i32`, importing
JavaScript text operations, or treating host memory as trusted would
respectively violate the ABI shape, module import contract, or
boundary-validation rule and are rejected alternatives.

Blot exposes this target explicitly as `blot build --target=gpupaper`. That
command checks and stages in the Blot checkout, validates Runtime HIR once, and
uses gpupaper's Rust/WebAssembly Wasm emitter. Gpupaper's former `.blot` parser,
copied Baba grammar, payload lowering, fixtures, and syntax benchmark have been
deleted; passing Blot source to gpupaper now reports the target-boundary command
instead of reconstructing Blot semantics.

#### Rust/WebAssembly production selection for Blot

Let the stable cache-miss subsequence after Blot preparation and Runtime-HIR
validation be $[M_0,\ldots,M_{n-1}]$, let $P_i=L(M_i)$ be gpupaper's immutable
binary plan, and let $E_{RW}$ be the Rust/WebAssembly realization of the
emission function defined in the three-backend equivalence section. The
production target now computes

\[W_i=E_{RW}(P_i)\]

in increasing miss ordinal. This changes compiler execution, not payload
semantics: $L$, the Blot ABI manifest, and the required byte string $E(P_i)$ are
unchanged. Exact TypeScript/Rust and GPU/Rust differentials are executable
validation of that equality on the tested domain; they are not a universal proof
of independent implementations.

One Rust/WebAssembly instance has shared input storage and one published output
handle, so production miss emission is sequential. Independent instances would
permit CPU parallelism, but would add module instantiation and linear-memory
high-water marks without evidence that current miss batches amortize them. A
successful emission is immediately validated as WebAssembly, checked for the
exact `blot:abi` section, copied into Blot's revision-keyed artifact cache, and
released by the cold emitter call. Retaining the Rust plan after that point
would duplicate the same $y_i$ encoded bytes already owned by the artifact
cache; it cannot discard more work than the final-artifact lookup. Consequently
module initialization is shared, while plan residence ends at successful cache
installation.

For miss $i$, with atom count $A_i$, dependency work $D_i$, and output length
$y_i$, the target performs

\[W_{RW}=\Theta\!\left(\sum_i(A_i+D_i+y_i)\right)\]

work and crosses the JavaScript/WebAssembly boundary with $\sum_i(16A_i+y_i)$
bytes, in addition to output and manifest validation. The GPU batch has the same
logical work, parallel scan span, atom upload and readback traffic, plus
submission and mapping latency. Existing diagnostics measure that fixed GPU
boundary at 12.5--31.1 ms for the frozen plans, whereas cold Rust/WebAssembly
emission measures 0.112--7.638 ms; these contended, different-workload
observations motivate the current policy but do not prove a global ordering. A
sufficiently large independent batch or a GPU-resident plan producer can reverse
it. The packed GPU API therefore remains an experimental backend and benchmark
subject rather than being deleted.

The target preserves five invariants. Misses retain source order. Returned Wasm
and manifest arrays are owned. A source failure remains local and never enters
emission. If any admitted miss fails emission or artifact validation, the Blot
batch wrapper publishes none of that miss subsequence, while already classified
cache hits remain valid. No declared payload effect executes during compiler
emission. Successful public outcomes report `wasmEmitter = "rust-wasm"`, making
backend provenance observable rather than inferred from timing. Executable tests
compare a multi-module Rust/WebAssembly batch byte-for-byte with the TypeScript
emitter, execute each ordinal, cover the empty batch, and require the public
Blot target to report Rust/WebAssembly provenance [27, 48].

#### Executable and empirical evidence

On 2026-08-02 the live corpus contained 53 top-level Blot examples. All 53
produced validated Runtime HIR and Wasm. The differential command admits all 53
and compares 313 runtime exports against the exact public ABI manifest, decoded
result, ordered capability/operation/argument trace, and required post-return
call from Blot's gpufuck CPU oracle with zero rejections. This is executable
validation over the admitted corpus, not a proof for programs outside the
binding-time rule. Twenty-six focused tests cover seven validator properties and
nineteen target scenarios, including dynamic scalar parameters, canonical import
identity, call-region pressure, repeated-call reclamation, Unicode scalar
ordering across UTF-8 length boundaries, and every malformed UTF-8 sequence
family. Two source integration tests prove that an observed `Text` host result
remains an SSA dependency through append and a later host call and that both
residual terminal branches execute with their exact ordered trace. The complete
gpupaper suite now passes 596 tests; the published Blot revision used for the
target baseline passed 673 tests.

A single warm-process corpus pass after the dynamic-Text implementation measured
1,442.60 ms in Blot-to-HIR production, 4.95 ms in explicit HIR validation, and
60.00 ms in target emission across all 53 files; medians were 23.997, 0.0435,
and 0.734 ms respectively. The artifacts totalled 173,721 bytes. These stage
sums share frontend caches and are workload evidence rather than independent
cold samples.

The alternating equal-source benchmark on `minimal.blot` used one warmup and
five samples on the RTX 4080 SUPER. Gpupaper measured 3.048 ms p50 (2.125 HIR
production, 0.0338 validation, 0.768 emission) and emitted 956 bytes; the
configured gpufuck GPU target measured 0.567 ms p50 and emitted 2,390 bytes.
Gpupaper was therefore 5.38 times slower at this boundary while emitting 60.0%
fewer bytes. A three-sample diagnostic on `storage.blot` before the module-wide
residualization measured 66.07 versus 3.18 ms; two subsequent runs were rejected
nondeterministically by published gpufuck 0.9.0 GPU inference with code
2201/detail 177, so that ratio is not admissible performance evidence. The
sibling `../gpufuck` checkout is API-incompatible with the current Blot checkout
and was not silently substituted. The benchmark command defaults to the
consistently admitted minimal workload and accepts `--file=` for explicit
diagnostics.

The target benchmark now shares the peer environment gate and separates HIR
production, HIR validation, Wasm planning, and GPU emission. It also records
physical plan traffic and throughput batches. A three-sample 2026-08-02 run was
explicitly diagnostic because unrelated Cargo and Deno GPU work was active.
Gpupaper measured 17.279 ms p50: 2.555 ms HIR production, 0.0476 ms validation,
0.4508 ms planning, and 14.0645 ms GPU emission, producing 956 bytes. Gpufuck
measured 1.907 ms p50 and produced 2,390 bytes, so the contended ratio was 9.06,
not release evidence. One module required 953 plan atoms, 2,036 atom-input
bytes, 1,288 output-buffer bytes, 3,816 offset bytes, 1,440 low-word bytes, 240
byte-rank bytes, 8 signed-64 high bytes, and 4,224 dispatched invocations. The
corresponding logical encodings were 871 bytes of diagnostic Runtime HIR JSON,
660 manifest bytes, and 956 final Wasm bytes. Throughput scheduling measured
60.06, 194.78, 412.11, and 432.78 modules/s at requested batches 1, 4, 16, and
64; the emitter capped physical submission batches at 16. The rebuild harness
uses separate temporary source identities, alternates literal edits, includes
cache invalidation, and executes each rebuilt artifact to require the new value.
A one-sample contended smoke run measured 57.997 ms for gpupaper, including
0.221 ms invalidation, and 36.729 ms for gpufuck. One sample under contention is
only executable benchmark validation, not performance evidence. An uncontended
multi-sample release run remains open.

A later 15-sample diagnostic on the same date again found a separate Deno
process holding 205 MiB on the GPU, so the normal gate refused and the run
required `--allow-contended`. Gpupaper measured 14.107 ms p50 and 16.648 ms p95;
its median stages were 1.596 ms HIR production, 0.0214 ms validation, 0.286 ms
planning, and 12.083 ms GPU emission. GPU emission was therefore 85.65% of
median end-to-end latency. Gpufuck measured 0.481 ms p50 and 1.330 ms p95,
making gpupaper 29.32 times slower for this one-operation cached module while
retaining the 956-byte versus 2,390-byte artifact advantage. Throughput
scheduling reached 66.09, 207.85, 560.62, and 529.37 modules/s at requested
batches 1, 4, 16, and 64. Five alternating literal rebuilds measured 27.703 ms
p50 for gpupaper, including 0.102 ms invalidation, and 12.200 ms for gpufuck.
These are diagnostic observations of the latency and batching shape, not
admissible release comparisons.

The same minimal source was then compiled at one identical temporary path to
explain the byte difference rather than infer from totals. Both modules had no
imports, returned `42`, and carried byte-identical 647-byte JSON manifests. The
`blot:abi` section occupied 659 bytes in each binary after its section and name
encoding. Whole-section bytes, including section headers, were:

| Binary component | gpupaper |   gpufuck | gpufuck excess |
| ---------------- | -------: | --------: | -------------: |
| Wasm preamble    |        8 |         8 |              0 |
| type             |       15 |        45 |             30 |
| function         |        5 |        14 |              9 |
| table            |        0 |         6 |              6 |
| memory           |        5 |         5 |              0 |
| global           |       18 |        51 |             33 |
| export           |       76 |       110 |             34 |
| element          |        0 |        11 |             11 |
| branch hints     |        0 |        92 |             92 |
| code             |      157 |     1,376 |          1,219 |
| `blot:abi`       |      659 |       659 |              0 |
| **module**       |  **943** | **2,377** |      **1,434** |

Gpupaper's exported body is five bytes and consists of the constant and return;
its other function is the 145-byte ABI allocator. Gpufuck has eleven functions.
Its body sizes expose 747 bytes of validated free-list allocation/reclamation,
134 bytes of cached thunk forcing and tagged-value resolution, 193 bytes of
runtime node/closure initialization and indirect-call support, a 131-byte ABI
wrapper instead of the five-byte direct export, and a 152-byte allocator. The
roles here are an inference from the disassembled state tests, block headers,
function table, indirect calls, and payload loads. The constant `42` is present,
but gpufuck constructs it inside the general graph representation and later
forces, resolves, unwraps, and releases that representation. Gpupaper consumes
Blot's already staged constant Runtime HIR and emits the public scalar directly.
Thus 1,219 of the 1,434 excess bytes are executable code and only 92 are branch
metadata; the difference is primarily retained generality, not the shared ABI
manifest.

Larger admitted examples preserve the same size direction, but they also expose
what is being measured. Deterministic same-process compilation produced:

| Blot example | Source bytes | gpupaper Wasm | gpufuck Wasm | gpufuck / gpupaper |
| ------------ | -----------: | ------------: | -----------: | -----------------: |
| `data`       |        1,732 |        10,259 |       31,048 |               3.03 |
| `storage`    |        3,887 |        13,218 |       37,783 |               2.86 |
| `tour`       |        4,393 |        12,687 |       36,018 |               2.84 |
| `simd`       |        3,363 |         3,380 |       11,309 |               3.35 |
| `walker`     |        2,088 |         1,256 |        3,119 |               2.48 |
| `effects`    |        3,154 |         2,789 |        6,244 |               2.24 |

These are output measurements, not equivalent evidence that both artifacts
retain the source computation. The current Blot-to-gpupaper producer evaluates
closed strict-eager regions at compile time, replays synchronous stage-known
unit-result host calls, and serializes their exported values; the separate
input-dependent calculus retains admitted `Text` host results and control. Thus
the mutually recursive walker reaches gpupaper as its final result, not as a
runtime tree walker. The SIMD fixture's unit `Console.write` is replayed, but
its vector chain is evaluated before Runtime HIR and its scalar exports are
serialized. Large composite results grow gpupaper through canonical templates,
relocations, and per-export wrappers rather than through the erased algorithm.
Gpufuck keeps the general runtime computation. The 2.24--3.35 size ratios
therefore quantify the selected partial-evaluation boundary as much as backend
compactness.

Blot's advanced case studies form the counterexample required to delimit that
claim. Gpufuck currently emits the 8,121-byte grep application with four host
imports, the 5,412-byte terminal application with two, the 11,828-byte agent
loop with three, and the 155,958-byte four-module engine with twelve. The engine
contains 790 Blot lines and 30,331 source bytes across its main, ECS, maths, and
renderer modules. Gpupaper now emits terminal as a 2,783-byte module with the
same 1,299-byte manifest and the same two imports as gpufuck's 5,412-byte
module. Its 29 residual operations in ten blocks retain `Terminal.read_line`,
text comparison, both branches, concatenation, three possible writes, and Blot's
two generated unit-payload control sums. Source-to-Wasm execution tests cover
empty and Unicode input; target tests repeat calls to prove checkpoint reuse and
trap lone continuation bytes, truncation, overlong encodings, surrogate
encodings, and out-of-range scalar encodings before they can influence control.
This is the first genuinely input-dependent gpupaper case study.

Grep, agent, and engine remain outside the admitted calculus at
`Arguments.pattern`, `Terminal.read_line` followed by a runtime loop, or
`Assets.count`. They require dynamic stores/loops and additional canonical
aggregate adapters. Using closed-value sizes as a proxy for those applications
would still overstate present coverage.

A five-sample alternating terminal benchmark on 2026-08-02 was diagnostic
because unrelated Cargo work and another Deno GPU allocation were present.
Gpupaper measured 19.832 ms p50 and 21.873 ms p95, including median stages of
4.894 ms HIR production, 0.138 ms validation, 2.268 ms Wasm planning, and 12.632
ms GPU emission. Gpufuck measured 1.747 ms p50 and 2.616 ms p95, so the
contended gpupaper ratio was 11.35 while its artifact was 48.6% smaller. GPU
emission was 63.7% of gpupaper's median. Throughput scheduling reached 65.1,
201.7, 524.4, and 456.0 modules/s at requested batches 1, 4, 16, and 64. These
figures establish measurement coverage and the output-size direction; they are
not admissible release performance evidence.

### 7.13 Zero: a controlled end-to-end benchmark language

Zero is the repository's consumer example and controlled benchmark frontend. It
is deliberately not a second production language specification. Its purpose is
to exercise one reproducible path from a generated Baba parser through the
public Core boundary and the Rust/WebAssembly plan emitter to an executable
WebAssembly payload.

#### 7.13.1 Calculus and dynamic semantics

Zero has one runtime type, WebAssembly `i32`. A program is a finite table of
first-order functions. Expressions are integer literals, variables, strict
left-to-right binary operations, lexical `let`, direct calls, conditionals, and
the bounded fold

```text
repeat n from z as x { e }
```

where `x` is bound only in `e`. Integer arithmetic is WebAssembly wrapping
arithmetic; signed division follows WebAssembly and traps on zero and signed
overflow. Comparisons produce canonical `0` or `1`, and a conditional selects
its first arm exactly when its condition is nonzero. Function calls are strict
and first-order. Every parameter and result has type `i32`; duplicate function
or parameter names, unbound variables, unknown callees, arity mismatches, and
integer literals outside signed 32-bit range are rejected at the frontend
boundary.

The repeat form is the primitive recursion

```text
R(n, z, f) = z                       when n <= 0
R(n, z, f) = R(n - 1, f(z), f)       when n > 0
```

with `f(x) = e`. The count and initial value are evaluated once, in that order.
Each positive iteration evaluates the body once. The decrement cannot overflow
because it occurs only while the signed count is positive. This is a pure fold,
not a mutable source variable, and termination follows from the natural-valued
variant `max(n, 0)`.

#### 7.13.2 Representation and lowering derivation

Baba's checked grammar produces a cursor forest. The Zero adapter materializes
only the small expression tree needed for semantic checks, then predeclares the
finite function/signature table before lowering bodies. A lexical environment
maps each source binder to its fresh SSA value. `let` extends a copied
environment after its value is lowered, preserving lexical shadowing and
left-to-right evaluation. A direct call names the predeclared function ID.

Conditionals lower to a condition block, two arm blocks, and one join block. The
join has one `i32` block parameter and each arm supplies exactly one edge
argument. Repeat lowers to a header with `(remaining, state)` block parameters,
a body back-edge carrying `(remaining - 1, next_state)`, and an exit parameter
carrying the final state. Thus the source fold equation becomes ordinary SSA
recurrence rather than source mutation.

The lowering preserves these executable invariants:

1. every function, block, signature, type, and value ID is stable and dense;
2. every use is dominated by one definition;
3. every edge has the exact arity and types of its target parameters;
4. each source expression is evaluated once and in source order except for the
   mutually exclusive conditional arms;
5. each repeat back-edge decreases a positive signed count by one;
6. every exported Zero function has the direct `(i32*) -> i32` Wasm ABI;
7. emitted bytes come from the Rust emitter compiled to WebAssembly and pass
   `WebAssembly.validate`.

The existing Core validator independently checks the first three properties and
the Wasm target. Zero conformance tests check parsing, shadowing, conditional
selection, zero and positive repeat counts, calls, diagnostics, Rust/Wasm versus
TypeScript-emitter byte identity, and executable results.

#### 7.13.3 Benchmark contract and cost model

The retained runtime workload is a deterministic wrapping recurrence. The Zero
and Rust sources export the same `run(seed, rounds) -> i32` function and use the
same signed loop condition and arithmetic. Before timing, the harness compares
both implementations over boundary and generated inputs; a mismatch invalidates
the run.

For `r = max(rounds, 0)`, useful payload work is `Theta(r)` with a constant
number of integer operations and one branch per iteration, and payload memory is
`Theta(1)`. Let `t_z(r)` and `t_r(r)` be paired invocation times after both Wasm
modules are compiled, instantiated, and warmed. The reported runtime quantity is
the paired log-ratio

```text
rho(r) = exp(median_i(log(t_z_i(r) / t_r_i(r))))
```

rather than a ratio of unrelated medians. Invocation order alternates within
each pair. The harness also reports raw observations, robust summaries, module
byte lengths, instantiation observations, repository/runtime identity, and
content hashes.

Compilation measurements have intentionally different boundaries and therefore
must not be presented as a compiler speedup ratio. The Zero path records Baba
parser initialization and parsing, AST-to-Core validation/lowering, Wasm
planning, Rust/Wasm-emitter initialization, and plan emission. The Rust path is
one fresh `rustc` process targeting `wasm32-unknown-unknown` at optimization
level 3. Those measurements locate costs; they do not claim that an incremental
in-process frontend and a whole external toolchain are equivalent.

JavaScript-to-Wasm call overhead can dominate tiny payloads. The benchmark
therefore performs the recurrence inside each Wasm invocation and uses enough
rounds that the `Theta(r)` term dominates the constant boundary cost. This does
not establish performance on allocation, memory bandwidth, SIMD, host effects,
or larger programs. It is one scalar control/arithmetic case study. Kalibera and
Jones [38] justify independent process-level analysis and explicit uncertainty;
the project benchmark discipline in Section 7.10 supplies the robust summaries
and evidence classification.

#### 7.13.4 Certified single-body natural-loop structuring

The first optimization target is not the repeat syntax. It is the following Core
CFG certificate over four distinct blocks `(E,H,B,X)`:

```text
E(args_E)  -> H(args_0)
H(params)  -> condition ? B(args_B) : X(args_X)
B(params_B)-> H(args_1)
X(params_X)-> return | trap
```

The condition arms may be exchanged. There are no other blocks or edges. Core
validation has already proved exact edge arities and types, SSA dominance, and
unique definitions. The edge `B -> H` is a natural-loop back-edge because `H`
dominates `B`; `E -> H` is its unique external entry, and `H -> X` is its unique
exit. This is the smallest reducible cyclic CFG and maps directly to nested Wasm
`block`/`loop`/`if` regions.

The lowering first evaluates `E`, performs the edge's parallel assignment into
the header locals, and enters `block { loop { ... } }`. Each header iteration
evaluates `H` once. The continuing arm performs the parallel assignment into
`B`, evaluates `B`, performs the back-edge parallel assignment into `H`, and
branches to the loop. The exiting arm performs the parallel assignment into `X`
and branches out of the enclosing block; `X` then executes once. Parallel
assignment means pushing all edge arguments before setting target locals in
reverse order, so swaps and cycles observe the pre-edge environment.

Let a Core state be `(q, sigma)` for current block `q` and value environment
`sigma`. Relate it to a Wasm state at the corresponding region point whose
locals agree with `sigma` on every live Core value. `E -> H`, `H -> B`,
`B -> H`, and `H -> X` each preserve this relation by the parallel-assignment
lemma. Block operations are unchanged. The Wasm condition selects the same
nonzero arm as Core, and `br` changes only the structured program counter.
Induction over the number of back-edges therefore gives the same return, trap,
and divergence behavior. This is a local simulation argument under the Core
validator's invariants, not a general CFG-structuring proof.

For `r` loop iterations, the dispatcher lowering executes five state equality
tests and five Wasm `if` headers per steady-state iteration in this four-block
shape: two while selecting `H` and three while selecting `B`. It also writes the
dispatch local twice. The structured form performs no state equality tests or
dispatch writes; it retains the source condition and one back-edge branch. Both
perform `Theta(r)` useful work and use `Theta(1)` memory, but the removed
administrative work is `12r + O(1)` scalar/control operations for this block
order. The certificate check is `Theta(1)` after Core validation because it
examines four blocks and their terminators. Functions outside the exact shape
retain the dispatcher, making refusal semantics-preserving.

The exact certificate and lowering are implemented. A public-Core conformance
test exchanges two loop-carried values on every back-edge, uses the condition's
false arm as the continuation, and checks four iteration counts. Its
less-than-160-byte module bound also rejects reintroduction of the larger
dispatcher shape. The ordinary Zero differential suite remains the independent
source-level oracle.

#### 7.13.5 Explicit module roots

A Zero program distinguishes its finite function table `F` from a nonempty set
of public roots `E ⊆ F`. The declaration `export fn f(...) = e;` places
`f` in `E`; an unmarked declaration remains callable by functions in `F` but is
not observable through the standalone module boundary. Requiring `E` to be
nonempty makes an accidentally closed benchmark module a frontend error instead
of silently producing an artifact with no callable experiment. This visibility
rule changes neither expression evaluation nor the Core call graph.

The lowering maps every member of `E`, in source order, to one WebAssembly
function export with the same name and dense function ID. Every direct call is
still resolved against all of `F`. Therefore an observer restricted to declared
exports sees exactly the Zero public interface, while internal calls preserve
the source function table semantics. Duplicate names remain illegal, so the
export-name map is injective without a second namespace check. The first member
of `E` is recorded as Core's entry function; this is metadata and does not grant
visibility to any other function.

For an internal function named `step`, removing its Wasm export removes
`1 + leb(|step|) + |step| + 1 + leb(index) = 7` bytes while all relevant lengths
fit in one-byte LEB encodings. It removes no function body or runtime call. The
expected runtime delta is therefore zero; a material timing change would be
evidence of measurement instability rather than an optimization. Computing
`E` and its first member takes `Theta(|F|)` work and `Theta(|E|)` output space,
already bounded by the existing function-table pass. Export-driven dead-code
elimination is deliberately separate: deleting an unexported but reachable
callee would be unsound, while deleting an unreachable function requires a
call-graph reachability proof.

The Baba grammar, Zero AST, Core entry selection, and Wasm export plan implement
this rule. Executable tests prove that an internal function remains directly
callable from an export, is absent from the instantiated export object, and that
a module with no public root is rejected. This is executable validation of the
boundary, not yet an implementation of reachability pruning.

#### 7.13.6 Certified loop-call diamond fusion

Let a call in the body `B` of the natural-loop certificate target a function
whose CFG is the diamond `(E,T,F,J)` from Section 7.13.4 without a back-edge.
The admitted callee has one result, `J` contains no operations and returns its
sole parameter, and every definition has a scalar type. Its operations are only
constants and scalar binary operations. At most 16 operations are admitted.
Calls, host operations, managed values, stores, resources, regions, closures,
multiple exits, recursion, and arbitrary CFGs are outside this certificate.

Fusion substitutes the diamond at the direct call's Wasm emission point. It
first evaluates every already-ordered caller operand once, then assigns the
values in reverse to fresh locals representing the callee entry parameters.
Every other callee SSA definition receives a fresh caller local. The condition
and exactly one arm execute, and the selected branch argument becomes the call
result. This is alpha-renaming plus call-by-value beta reduction, expressed as a
structured Wasm `if (result t)` rather than a Core CFG rewrite; it therefore
leaves the surrounding four-block natural-loop certificate intact.

Relate the pre-call states by equality of caller locals. Parallel parameter
assignment establishes equality between actual arguments and renamed formal
locals. Induction over the entry and selected arm operations preserves equality
for every renamed SSA definition. Wasm's `if` selects the same nonzero branch,
and the branch argument equals the callee return and hence the original call
result. Argument evaluation, partial scalar traps, and arm laziness are
preserved because arguments are captured once and the unselected arm is not
emitted on the executed path. This is a local simulation proof for the admitted
certificate, not a proof of general inlining.

For `n` loop iterations, let `C_call` be the engine's dynamic direct-call cost,
`C_copy` the cost of the extra local transfers after optimization, `D` the
one-time compilation/code-cache cost of duplicated code, and `m <= 16` the
callee operation count. Fusion is runtime-profitable only if

```text
n(C_call - C_copy) > D.
```

Both forms retain `Theta(nm)` payload work and `Theta(m)` scalar storage. The
current policy treats loop membership as a hotness prior and the 16-operation
limit as a code-growth guard; neither proves the inequality for a particular
engine or trip count. Retaining the original callee can increase bytes even
when runtime improves. Deleting it requires the separate reachability argument
from Section 7.13.5. The compiler scans only the certified body and at most 16
callee operations, so selection is `O(1)` for this exact loop shape. Every
callee that may affect a cached caller is included in the backend environment
identity; changing its body therefore invalidates dependent cached emission.

The backend implements this exact certificate. The Zero differential workload
exercises the fused call across signed boundary values and iteration counts. A
separate conformance case proves that the unselected trapping arm remains lazy
and that zero iterations never enter the callee. These are executable
validations of the simulation obligations; the performance inequality remains
an empirical hypothesis until measured.

#### 7.13.7 Residual call-graph reachability

After fusion, define the residual reference relation `f -> g` when a reachable
operation in `f` is either a non-fused direct call to `g` or constructs a closure
whose code is `g`. A fused call contributes no edge because Section 7.13.6 has
already substituted its complete behavior. For public roots `E`, the emitted
function set is the least fixed point

```text
R_0     = E
R_(k+1) = R_k union { g | exists f in R_k. f -> g }
R       = union_k R_k.
```

The table is finite, so the ascending chain stabilizes after at most `|F|`
insertions. A worklist computes `R` in `Theta(|R| + |A_R|)` time, where `A_R`
is the set of operations scanned in reachable functions, and uses `Theta(|F|)`
set entries plus a worklist. Emitted functions receive dense Wasm indices in original
function order; source Core IDs remain unchanged and map to those indices.

For any invocation through `E`, induction over dynamic calls proves that the
current function lies in `R`: the base invocation is a root, a residual direct
call follows an edge in the definition, and every indirect target must first be
introduced by a reachable `closure.make` edge. Fused calls are simulated by
Section 7.13.6. Therefore no execution through the published interface can
enter a function outside `R`. Removing those bodies, their otherwise-unused
function types, imports, closure-table entries, and text literals preserves all
published return, trap, effect, and divergence observations.

This theorem depends on Core being a closed module with no reflective function
lookup, late linker references, or fabricated table indices. Applying the rule
to an open object file would be unsound without additional external roots.
Treating every indirect call as an edge to every function would be sound but
would discard closure-construction precision and much of the benefit. Pruning
only bodies while retaining their imports and literals would preserve execution
but falsify the claimed artifact reduction, so all derived module components use
the same reachable set.

The backend implements this fixed point before module planning. Existing tests
cover residual internal direct calls, recursive calls, closure construction and
indirect calls, explicit exports, and fused calls; the complete suite is the
differential/conformance boundary. This is executable validation plus the
closed-world reachability argument above, not a linker-level theorem.

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
18. **SIMD lane refinement**: every committed payload-vector operation refines
    the corresponding ordered scalar lane operations under the selected strict
    or explicitly relaxed numerical policy.
19. **SIMD footprint safety**: every vector memory operation owns or borrows its
    complete byte footprint, stays in bounds, and leaves only the proved scalar
    tail.
20. **SIMD target separation**: fixed payload-vector width, variable GPU
    subgroup width, and JavaScript host ABI representation never substitute for
    one another.
21. **Advisory erasure**: removing branch-likelihood metadata leaves the same
    semantic Wasm module and observations; condition inversion preserves hint
    polarity, and an inaccurate hint cannot change execution semantics.
22. **Compiler-fragment determinism**: every parallel compiler-job schedule
    assembles the same flat columns, stable IDs, diagnostics, and Wasm bytes as
    source-order construction.
23. **Payload exchange safety**: a payload reordering is admitted only by a
    checked pairwise certificate covering value dependence, sequential effects,
    traps and divergence, resource footprints, ownership transitions, allocation
    identity, cleanup, and control dependence.

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

For \(C\) independent compilations whose bundled import multisets contain \(R\)
total syntax requests and \(U\) distinct current bundled sources, parsing work
falls from \(R\) parses to \(U\) parses. Each request still resolves and hashes
its source, preserving change detection. Retained memory is
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
current index, so classification no longer constructs an unconditional prefix or
suffix. The base state scan is \(O(n)\). Its conservative total bound is \(O(n +
Q + \sum_a L_a)\), where \(Q\) is text inspected by contextual candidate
patterns and \(L_a\) is the backward context inspected for each lexical
single-parameter arrow candidate. Accepted candidates advance past their entire
interval. This is not yet a proof of worst-case linear time: adversarial failed
record candidates or many arrow-like identifiers can make the residual terms
superlinear.

Arrow classification has two independent predicates at position \(i\):

```text
arrow(i) = lexical_arrow(i) ∧ arrow_context(i)
```

Both predicates are pure functions of the immutable source, and the sticky
lexical matcher resets its cursor to \(i\) before every test. Commutativity of
conjunction therefore permits lexical evaluation first. Let \(H\) be
letter-headed positions, \(B\subseteq H\) the positions admitted by the cheap
bare-context prefix, \(M\subseteq H\) lexical arrow spellings, and \(K=B\cap
M\). The previous order performed \(H\) bare-context checks, \(B\)
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
executable evidence. The later payload-relative resident representation extends
this historical three-word frontier to `16K + 4n` bytes so a packed module can
be relocated by its base rather than by rewriting every length record.

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

Section 7.5 now makes that boundary uniform. Removing the cutoff and four
dormant pipelines deletes 955 source lines. At the former cutoff, one
constructor frontier scheduled 57,344 lanes and dense reachability could
schedule 262,144 more; the selected boundary schedules only the padded closed
equalities and terms. Frozen closed-equality counts are 3,838, 28,138, 1,292,
9,174, 264, and 292 in the same target order, each with one union round. Because
the removed branch ran for none of them, this is a scalability and specification
result, not a frozen latency improvement.

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
submission/readback floor as separate optimization problems. The full
required-GPU gate passed 498 tests and compiled every frozen target twice with
byte-identical differential emission and engine validation.

### 2026-07-31: constructor closure becomes an eager witness worklist

The measured CPU closure still rebuilt every representative and complete
constructor star until no new child equality appeared. Section 7.5 replaces that
global frontier with one constructor witness per union-find class. A class merge
compares two witnesses at most once, appends their child equations in field
order, and retains the lower-ID witness. A three-constructor regression pins the
resulting two-edge star, two comparisons, and two child proposals.

Deterministic work falls as follows:

| Target    | Comparisons before/after | Proposals before/after | Closed equalities before/after |
| --------- | -----------------------: | ---------------------: | -----------------------------: |
| Editor    |              4,176 / 711 |          8,035 / 1,367 |                  3,838 / 3,720 |
| Codex     |           41,971 / 5,276 |        83,484 / 10,494 |                28,138 / 27,467 |
| grep      |              1,264 / 266 |            2,528 / 532 |                  1,292 / 1,235 |
| tar       |           12,051 / 1,738 |         24,102 / 3,476 |                  9,174 / 9,067 |
| wav       |                  90 / 45 |               180 / 90 |                      264 / 264 |
| raytracer |                  36 / 36 |                72 / 72 |                      292 / 292 |

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
conformance experiment, not a payload transformation: CPU inference produced the
only types consumed downstream, while the GPU result was stored solely for
reporting. Production Haskell and Ducklang compilation now skip that call and
report `type=cpu`. The CLI `experiments` command still invokes the direct
solver, and all constructor, cycle, union, batching, and generated differential
tests remain.

For Editor, Codex, grep, tar, wav, and raytracer respectively, each compilation
removes 5,504, 39,168, 2,112, 12,928, 448, and 448 scheduled lanes; 43,408,
312,480, 16,064, 103,240, 2,904, and 3,024 logical buffer bytes; one command
submission; one mapped readback; and the CPU certificate derivation. The last
pre-removal observed stage durations were 33.08, 80.53, 34.02, 41.19, 30.22, and
30.91 ms. Those observations measure the discarded stage, not a paired
end-to-end speedup.

The semantic argument is noninterference: successful validation had no consumer,
invalid source failed during prior CPU inference, and optional-mode
unavailability already discarded the result. Required mode continues to require
authoritative GPU Core rewriting and Wasm emission. Removing an unused validator
cannot alter accepted Wasm; the release gate checks this directly.

The post-removal sixteen-sample concurrent grep sweep reports throughput GPU/CPU
ratios of 1.520, 1.242, 1.130, 1.027, and 1.015 at 1, 2, 4, 8, and 16 jobs. No
break-even is observed. Core/Wasm payload batches reach 1, 2, 3, 5, and 8 jobs
at those sizes; type batches no longer exist. Absolute CPU and GPU times both
rose materially from the preceding sweep, so cross-sweep latency subtraction is
not used as evidence.

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
484.95/337.59 ms for Editor, 1,497.87/1,234.20 ms for Codex, 138.70/161.44 ms
for grep, 260.31/263.73 ms for tar, 146.13/145.65 ms for wav, and 146.31/148.17
ms for raytracer. Every pair emitted byte-identical Wasm and passed engine
validation. As above, these are correctness and budget observations rather than
a latency distribution.

### 2026-07-31: Core candidates follow the rewrite rule heads

The stable Core frontier previously admitted every `scalarBinary` operation
although the rule set contains only integer add-zero and multiply-one. Section
7.3 now compiles their common structural head into the CPU frontier.
Completeness is the direct implication \(M(S,o)\downarrow\Rightarrow H(S,o)\):
every omitted operation makes at least one necessary rule premise false. The CPU
produces no rule or replacement; exact constant payload matching and proposal
construction remain on the GPU, followed by independent CPU certificate
validation.

Frozen candidate counts change from 169, 2,890, 34, 549, 43, and 103 to 15, 963,
3, 257, 4, and 0. Descriptor bytes fall from 303,040 to 99,360 (67.21%), while
padded lanes fall from 3,968 to 1,536 (61.29%). Tar retains its 24 proposals and
the other five targets retain zero, establishing that the filter removes only
failed matches. A focused regression includes two positive identities, one
structurally admitted non-identity constant rejected by the GPU, and a
floating-point identity excluded by the head. These exact work counts and
CPU/GPU proposal equality are executable validations; latency remains
unmeasured.

The full gate passed 499 tests and compiled every frozen target twice with
byte-identical CPU/GPU emission and engine validation. Its samples were
966.91/757.85 ms for Editor, 2,989.80/3,037.06 ms for Codex, 344.93/347.40 ms
for grep, 697.60/548.34 ms for tar, 316.84/355.19 ms for wav, and 239.35/366.22
ms for raytracer. They establish conformance under the observed heavy system
load and are not used as performance evidence.

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
required-GPU samples were 378.83/239.13 ms for Editor, 1,015.11/861.97 ms for
Codex, 137.89/136.83 ms for grep, 198.51/194.43 ms for tar, 114.32/117.09 ms for
wav, and 94.66/97.97 ms for raytracer. These are correctness observations, not a
timing claim.

### 2026-07-31: unobserved algebra does not enter the matcher

Three additional rules are semantically valid over the admitted modular integer
types:

```text
imul(x, 0) -> 0
isub(x, 0) -> x
idiv(x, 1) -> x
```

The first two are ring identities. For the third, the fixed divisor is nonzero
and signed division overflow occurs only at \((-2^{w-1})/(-1)\), so division by
positive one is total and returns its dividend under the Wasm integer semantics
[16].

An exact scan of every frozen pre-rewrite Flat Core snapshot under both CPU and
required-GPU policies found zero matches for each proposed rule. The current
rules found only Tar's 24 add-zero matches. Widening \(H\), the shader, the rule
ID domain, certificate validation, and generated tests would therefore add
implementation and scheduled-work surface without changing one frozen Core
module. The expansion is rejected under the cost model. It should be reopened
only when retained profiles show nonzero matches or a new workload establishes a
measured benefit. This is an empirical design rejection, not a claim that the
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
remove autocorrelation; the benchmark therefore supports a paired representation
experiment but not a hardware-independent performance claim.

The first 21-round dense-low-word run measured median/p95 milliseconds of
27.99/28.74 for Editor, 37.09/38.36 for Codex, 27.01/27.18 for grep, 27.76/28.02
for Tar, 26.96/27.19 for wav, and 27.02/27.16 for raytracer. The five small
plans cluster near 27 ms despite a 9.66-fold atom-count range, which is
empirical evidence of a large fixed boundary cost, not a decomposition of that
cost. Codex adds roughly 10 ms at 204,099 atoms.

### 2026-07-31: ranked low words pass the paired experiment

Section 7.4 now admits the previously deferred rank/select representation under
an exact adaptive rule. For \(Q\) byte atoms, ranked storage is selected iff
\(Q-\lceil Q/4\rceil>\lceil A/8\rceil\); otherwise direct dense indexing
remains. The strict inequality proves that the adaptive representation never
increases logical low-word capacity, while dense wins equal-capacity ties.

All six frozen plans select ranked. Complete atom input changes from
155,504→125,784 bytes for Editor, 1,734,848→1,489,512 for Codex, 25,336→20,244
for grep, 144,312→117,996 for Tar, 16,104→12,868 for wav, and 25,036→19,728 for
raytracer, reductions of 14.14–21.20%. The profile exposes byte-atom count,
selected layout, and low-word bytes, making the selector and capacity equation
executable invariants.

The counterbalanced 21-pair dense/ranked experiment measured median ratios of
1.0040, 0.9907, 0.9975, 0.9968, 1.0007, and 0.9992 in target order. This is
evidence of no material latency change on the measured adapter, not evidence of
a speedup or equivalence on other devices. Forced dense and ranked paths produce
the same bytes as the independent CPU emitter across all atom variants; packed
throughput tests mix both layouts in one submission. The required-GPU gate
passed 500 tests and compiled every target twice. Paired release samples in
milliseconds were Editor 334.16/229.35, Codex 949.72/788.76, grep 129.66/125.46,
Tar 197.90/183.27, wav 115.33/110.38, and raytracer 99.43/92.84. They are
correctness samples, not a latency comparison with an earlier implementation.

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
those values are advisory. Forced-layout differentials, generated plans, and the
mixed-layout batch regression remain the executable semantic evidence. A direct
forced-ranked regression enumerates all \(2^8=256\) byte/non-byte masks for one
kind word and compares the complete emission with the independent CPU encoder.
The exact 501-test required-GPU gate passed; paired target samples in
milliseconds were Editor 325.67/223.58, Codex 931.50/790.41, grep 125.21/127.96,
Tar 191.43/181.10, wav 112.90/113.90, and raytracer 97.69/92.46.

### 2026-07-31: byte-rank width follows its observed maximum

The rank frontier still stored one `u32` per eight atoms although its maximum is
known during the mandatory byte-count pass. Section 7.4 now packs two ranks per
word iff the actual maximum stored boundary is at most 65,535. The proof is the
same injective fixed-width encoding used for output boundaries, but the
selection variables differ: output width depends on final byte length, while
rank width depends on the maximum exclusive byte count at a tag-word boundary.

Editor, grep, Tar, wav, and raytracer select 16 bits; Codex selects 32. Rank
input falls by 620–5,980 bytes on the five narrow plans and is unchanged on
Codex. Complete atom input becomes 119,804, 1,489,512, 19,268, 112,444, 12,248,
and 18,764 bytes in target order. Profiles expose maximum rank, width, and
physical rank bytes. A direct boundary regression proves that maxima 65,535 and
65,536 select 16 and 32 bits and compares both outputs with the CPU oracle. The
post-change ranked/dense median ratios remain within 0.9771–1.0015; this is no
material measured regression, not a speedup claim. The required-GPU gate passed
501 tests. Paired target samples in milliseconds were Editor 329.96/226.44,
Codex 907.51/830.48, grep 123.49/128.36, Tar 191.72/175.71, wav 120.78/111.96,
and raytracer 97.33/93.22.

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
disjoint, so the same local-accumulation lemma as kind packing applies. Section
7.4 now assigns each completed pair once.

This removes 1,394–13,457 derived host stores from the five narrow frozen plans.
Codex's two u32 vectors remain zero-copy/direct and remove no work. Capacity,
transfer, bindings, GPU instructions, and output bytes are unchanged. The exact
offset-width, rank-width, 256-mask, and CPU/GPU byte differentials exercise odd
and even physical-word tails. The post-change ranked/dense median ratios are
0.9974–1.0026, detecting no material latency change. The required-GPU gate
passed 501 tests. Paired target samples in milliseconds were Editor
333.60/232.86, Codex 931.34/781.89, grep 132.36/128.21, Tar 196.53/178.44, wav
110.98/109.15, and raytracer 98.65/91.83.

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
334.96/230.85, Codex 971.32/805.07, grep 130.73/130.47, Tar 192.80/180.05, wav
114.29/114.13, and raytracer 94.42/93.19.

### 2026-07-31: byte lanes stop reading an unobserved boundary

The one-pass emitter computed every atom's dynamic interval width before
dispatching on its tag. Byte width is definitionally one, so its end boundary
and subtraction cannot affect byte emission. Section 7.4 now performs that work
only after the byte lane returns.

Frozen boundary reads fall by 28.09–31.32%, from \(2A\) to \(2A-Q\); 1,493 to
115,797 lane-local subtractions disappear as well. Capacity, transfer,
dispatches, and output are unchanged. The exhaustive byte-mask regression and
all CPU/GPU plan differentials validate the early return. The 21-round
post-change medians were 27.87/28.01 ms for Editor dense/ranked and 35.18/35.29
ms for Codex; the fixed boundary hides any latency effect, so no speedup is
claimed. The required-GPU gate passed 501 tests. Paired target samples in
milliseconds were Editor 355.83/223.95, Codex 907.54/794.40, grep 117.55/122.43,
Tar 183.14/173.97, wav 109.50/111.68, and raytracer 92.28/96.82.

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
milliseconds were Editor 335.21/231.17, Codex 936.04/806.90, grep 130.41/129.73,
Tar 197.20/179.83, wav 113.49/110.44, and raytracer 95.57/95.01.

### 2026-07-31: Wasm validation and sizing become one inspection

GPU analysis still traversed all \(A\) atoms once for validation and again for
scalar sizing. These folds share an immutable domain and have no cross-atom
dependency. Section 7.4 now defines their product; length sizing remains
topological and separate.

The GPU path removes another 260,448 atom visits over the frozen batch, one per
atom in each target. It also removes a second atom-kind dispatch.
Validation-only CPU callers allocate no size column, but execute one
sink-presence branch for each scalar atom; this is the admitted local cost. A
regression checks that analysis still rejects an invalid byte before sizing it.
Focused validation, compiler, and generated CPU/GPU differential tests pass.
Post-change 21-round dense/ranked medians were 27.66/27.65 ms for Editor and
33.87/33.58 ms for Codex. These samples are consistent with discarded work but
do not isolate it from run-to-run drift. The required-GPU release gate passed
502 tests and compiled every frozen target twice. Its advisory samples in
milliseconds were Editor 341.45/224.94, Codex 955.82/840.71, grep 130.55/124.65,
Tar 196.14/177.78, wav 115.04/113.19, and raytracer 100.00/90.38.

### 2026-07-31: Wasm length sizing uses adaptive sparse prefixes

Direct length sizing reread every dependency range after validation had already
traversed it. A dense prefix per dependency level initially appeared attractive
but loses on every frozen plan: two levels cost \(2A\) prefix visits versus only
1.86–1.98\(A\) direct range visits, plus an \(A+1\)-word buffer. Rebuilding a
sparse prefix by level instead has an \(O(JK)\) deeply nested counterexample.

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
milliseconds were Editor 335.64/236.97, Codex 973.23/969.82, grep 138.68/130.72,
Tar 238.84/190.68, wav 117.17/118.74, and raytracer 99.02/139.86.

### 2026-07-31: validated scalars skip duplicate LEB checks

Fusing inspection with CPU encoding exposed a remaining proof duplication:
inspection checked each non-byte scalar's range, then the public LEB entry point
checked it again. The encoder body is now factored behind an internal
validated-domain function. Public callers still cross the checked boundary, and
length payloads still use it because their values are derived after inspection.

The frozen CPU-oracle batch removes 111,472 duplicate scalar checks: 9,893
Editor, 87,954 Codex, 1,532 grep, 9,707 Tar, 970 wav, and 1,416 raytracer.
Signed-64 has no frozen occurrence but remains covered by the boundary test. The
post-change 101-sample CPU medians were 1.147 ms Editor, 14.801 Codex, 0.171
grep, 1.016 Tar, 0.100 wav, and 0.158 raytracer. Comparison with the immediately
preceding identical protocol resolves no material latency change, so none is
claimed. Focused scalar-boundary and CPU/GPU differential tests pass; the
required-GPU release gate passed 503 tests and compiled every frozen target
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
1.251 ms Editor, 17.413 Codex, 0.198 grep, 1.120 Tar, 0.102 wav, and 0.163
raytracer. Run-to-run variation is larger than the removed predicate cost, so no
latency improvement is claimed. Required-GPU release evidence passed 504 tests
and compiled every frozen target twice. Its advisory samples in milliseconds
were Editor 329.86/225.05, Codex 966.56/820.40, grep 131.34/130.68, Tar
232.03/182.11, wav 119.89/115.77, and raytracer 96.45/89.32.

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
Editor, 14.294 Codex, 0.169 grep, 0.969 Tar, 0.103 wav, and 0.199 raytracer. The
mixed changes do not resolve a latency effect. Required-GPU release evidence
passed 504 tests and compiled every frozen target twice. Its advisory samples in
milliseconds were Editor 349.09/243.67, Codex 948.26/839.47, grep 145.16/136.63,
Tar 255.35/197.77, wav 126.10/124.12, and raytracer 105.14/98.83.

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
0.199→0.138 ms. This is empirical evidence consistent with the allocation model,
not a counterbalanced causal estimate. Focused LEB boundaries and CPU/GPU
differentials pass. The required-GPU gate passed 504 tests and compiled every
frozen target twice. Its advisory samples in milliseconds were Editor
333.55/225.53, Codex 906.47/807.11, grep 128.21/132.47, Tar 232.97/180.96, wav
115.42/109.62, and raytracer 93.73/89.05.

### 2026-07-31: multi-byte LEB memoization is rejected

An emission-local memoization experiment shared repeated multi-byte encodings
through separate unsigned, signed-32, and signed-64 maps; derived length values
shared the unsigned map. It would have reduced 26,701 dynamic encodings to 3,003
distinct encodings over the frozen batch:

| Target    | Fresh encodings | Distinct encodings | Avoided |
| --------- | --------------: | -----------------: | ------: |
| Editor    |             629 |                193 |     436 |
| Codex     |          22,101 |              1,255 |  20,846 |
| grep      |              19 |                  9 |      10 |
| tar       |           3,892 |              1,515 |   2,377 |
| wav       |              34 |                 19 |      15 |
| raytracer |              26 |                 12 |      14 |

Despite the 88.75% aggregate hit rate, the immediately consecutive
identical-protocol CPU medians regressed on every target: Editor 0.850→1.523 ms,
Codex 8.936→13.856 ms, grep 0.142→0.259 ms, Tar 0.856→1.658 ms, wav 0.088→0.161
ms, and raytracer 0.138→0.234 ms. The increases range from 55.05% to 93.82%.
Section 7.4 now records the applicable cost inequality. The maps were removed
rather than retaining a representation-level optimization contradicted by
end-to-end evidence.

The first implementation also generalized the 256-entry byte table without
checking the one-byte unsigned domain. It encoded unsigned 128 as `[128]`
instead of `[128, 1]`; five focused tests failed, including engine validation
and a GPU differential. Adding the \(v<128\) guard made all 84 focused tests
pass and allowed the performance experiment to measure the intended memoization.
The rejected implementation left no production code change.

### 2026-07-31: CPU Wasm emission writes bytes directly

The retained CPU oracle still represented every encoded atom as an array
reference. Length resolution needs widths rather than byte arrays, so Section
7.4 now derives a smaller sufficient statistic: one byte of width per atom and
one eight-byte payload width per length atom. Validation assigns every length
atom its stable source-order rank. The same rank removes the sparse GPU-boundary
analysis's atom-to-position map.

The CPU oracle retains exactly \(2A+2D\) atom/range visits. It replaces the
\(A\)-entry reference vector, 26,701 frozen dynamic encoding arrays, and
256-entry canonical table with \(A+8K=264{,}904\) typed temporary bytes across
the frozen batch. One final source-order pass writes all \(B\) bytes directly at
a rolling offset. Existing LEB-boundary, nested-length, engine-validation, and
generated CPU/GPU differential tests establish executable agreement for 84
focused cases.

Stable ranks also change sparse length sizing from
\(A+K(1+5\lceil\log_2(K+1)\rceil)\) to \(A+5K\lceil\log_2(K+1)\rceil\). Frozen
selected work falls by another 557 operations, from 283,845 to 283,288, and
sparse-only storage loses its \(K\)-entry position map. The direct/sparse
boundary fixture now checks the revised estimate.

The 101-sample CPU medians are Editor 0.616 ms, Codex 5.697 ms, grep 0.115 ms,
Tar 0.585 ms, wav 0.070 ms, and raytracer 0.095 ms. Relative to the last
retained array-emitter run under the same protocol, all six are lower by
19.22–36.24%. This is empirical evidence consistent with the allocation and
write model, not a counterbalanced causal estimate. The required-GPU gate passed
504 tests and compiled every frozen target twice. Its advisory samples in
milliseconds were Editor 354.60/224.22, Codex 939.47/921.55, grep 139.67/135.81,
Tar 205.56/204.96, wav 123.86/118.93, and raytracer 117.08/101.31.

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

In the consecutive six-sample frontend protocol, warm bundled analyses fell from
23 to zero. Codex still analyzed its two ordinary local modules.
`localImportResolution` fell from 25.79→1.41 ms for Editor, 160.90→24.53 ms for
Codex, 50.60→0.81 ms for grep, 51.00→0.74 ms for Tar, 51.80→0.81 ms for wav, and
50.73→0.44 ms for raytracer. End-to-end CPU medians fell respectively by 18.64%,
20.64%, 77.36%, 41.32%, 87.26%, and 81.60%. These are consecutive
identical-protocol observations, not a counterbalanced causal estimate. The
required-GPU gate passed 505 tests and compiled every frozen target twice. Its
advisory samples in milliseconds were Editor 402.79/228.33, Codex
1016.46/699.71, grep 72.24/74.98, Tar 140.71/133.29, wav 63.75/62.70, and
raytracer 45.44/43.87.

### 2026-07-31: contextual classification stops slicing every position

Section 9 specifies the contextual classifier as a length-preserving state
transduction and derives its candidate dispatch. The production scan now uses
sticky current-index patterns and only examines backward dotted-field and record
context when the current character can begin those forms. It preserves the old
pattern order and the exact record-prefix predicate.

In 31 warm observations of the 25,256-character Editor root after one unrecorded
warmup, contextual classification fell from 18.476 to 4.670 ms and complete
syntax work fell from 25.349 to 11.845 ms. Generated parser execution was
unchanged at 6.901 versus 6.917 ms; AST lowering changed from 10.077 to 10.775
ms and is treated as run noise. These are consecutive measurements from separate
worktrees under one protocol, not a counterbalanced causal estimate. The
deterministic claim is removal of the two unconditional substring families whose
logical extent was \(n^2\).

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
before establishing that the current identifier was followed by `=>`. Section 9
factors recognition into pure lexical and context predicates and derives the
cost inequality for commuting that conjunction. The implementation now tests the
anchored spelling first for both named and discarded parameters.

Against the immediately preceding 31-sample Editor-root protocol, contextual
classification fell from 4.670 to 1.455 ms, another 68.84%, and complete syntax
fell from 11.845 to 8.613 ms, another 27.29%. Generated parser execution
remained 6.917 versus 7.033 ms. The exact complete-prefix extent falls 98.24%,
from 10,153,696 to 178,601 characters; this is the deterministic work claim. The
focused syntax and corpus suites passed all 94 tests.

The subsequent six-sample alternating frontend run measured CPU/GPU medians of
98.09/153.37 ms for Editor, 513.01/587.65 for Codex, 13.72/70.24 for grep,
66.26/122.54 for Tar, 7.43/64.31 for wav, and 11.72/42.18 for raytracer. Only
the isolated classifier comparison supports attribution; the mixed end-to-end
changes are run noise outside the optimized stage. The required-GPU gate passed
all 505 tests and compiled every target twice. Its advisory samples in
milliseconds were Editor 332.50/195.31, Codex 894.57/679.17, grep 73.22/75.66,
Tar 137.88/140.06, wav 63.89/63.88, and raytracer 44.88/43.54.

### 2026-07-31: specialization environments become scoped maps

A 250-microsecond V8 CPU profile over four Codex compilations attributed 311.00
ms total and 73.75 ms self time to block rewriting. Section 6.3 derives the
scoped rollback environment from globally unique resolved IDs. Production now
records prior entries, inserts locals into the active map, and restores the
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
tests and compiled every target twice. Its advisory samples in milliseconds were
Editor 315.98/179.74, Codex 823.34/612.39, grep 72.44/68.78, Tar 133.62/123.21,
wav 63.45/61.68, and raytracer 44.11/40.61.

### 2026-07-31: specialization ledger counts each immutable root once

Section 6.3 defines node counting as a pure DAG fold and derives pass-local
identity memoization. Production now computes each root count once, then
projects input, demanded, rewritten, and residual totals from those exact
counts. A public profile regression requires nonzero cache hits and avoided node
visits.

The frozen target profiles report cache hits/avoided logical node visits of
330/14,038 for Editor, 99/32,243 for Codex, 18/1,416 for grep, 67/8,843 for Tar,
27/539 for wav, and 21/917 for raytracer. The batch removes 57,996 repeated
logical node visits without changing any retention count.

Twenty-one warm Codex CPU observations after one unrecorded warmup ran in
parallel against detached commit `f8a263d`. Median ledger accounting fell from
6.953 to 4.287 ms, a 38.35% reduction. The whole pre-specialization stage moved
108.989→109.728 ms and is unresolved; total compilation moved 555.87→548.51 ms
but is not attributed because non-accounting stages varied. The required-GPU
gate passed all 506 tests and compiled every target twice. Its advisory samples
in milliseconds were Editor 312.93/193.50, Codex 831.60/597.99, grep
71.69/68.78, Tar 129.31/124.40, wav 62.21/62.21, and raytracer 43.18/42.43.

### 2026-07-31: lazy child-list copying is rejected

The shared expression rewriter was changed experimentally from native `map` plus
an identity scan to a copy-on-first-change loop. The alternative preserves the
same immutable parent and child identities and avoids a transient list when no
child changes, but introduces an interpreted branch at every list element.
Section 6.3 records the engine-dependent break-even inequality.

Twenty-one warm Codex CPU observations after one unrecorded warmup ran in
parallel against detached commit `7aed752`. Median specialization rewrite time
regressed from 72.666 to 75.320 ms (3.65%), while function lifting was unchanged
at 24.226 versus 24.158 ms. Complete compilation regressed from 526.56 to 537.83
ms (2.14%). The production code was restored; this review changes only the
recorded rejected alternative.

### 2026-07-31: product direct-call classification is rejected

Closure lifting experimentally replaced one `isOnlyDirectlyCalled` traversal per
nested function with a product traversal collecting all symbols used outside
direct-callee positions. Section 6.3 records the equivalence and asymptotic
cost.

The unguarded draft scanned blocks with no eligible function and increased the
21-sample Codex lifting median from 24.481 to 38.141 ms, a 55.80% regression.
Restricting the product traversal to blocks containing a non-generated function
restored lifting to 25.125 ms versus a concurrent detached-`3ae5dc2` median of
25.083 ms (+0.17%). Pre-specialization was likewise unresolved at 108.660 versus
108.547 ms. The production implementation was restored; current corpus fan-out
does not justify the product set.

### 2026-07-31: empty accepted Core batches preserve identity

The structural Core frontier is only a necessary rule-head filter. Five frozen
targets have nonempty or independently classified frontiers but accept no
rewrite, yet both CPU rewrite and validated GPU commit rebuilt and revalidated
the complete flat package. Section 7.3 now defines batch application as an empty
fold: `commit(S, []) = S`. This is a semantic identity, not a corpus-specific
shortcut.

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

After empty commit began preserving object identity, the compiler still inflated
the unchanged flat package immediately after validation had already inflated it
once. Section 7.2 derives a constant-work certificate from the round-trip and
immutability laws: if rewrite returns the exact package produced by
`flatten(M)`, the next structured Core is \(M\). A non-identical package
continues through ordinary inflation.

A public profile regression requires zero Core-inflation time together with zero
proposals and acceptances. An alternating 21-pair Codex CPU experiment against
detached commit `2511932` changed median inflation from 31.863 ms to exactly 0
and complete compilation from 451.776 to 424.521 ms (-6.03%). Core rewrite was
stable at 33.367 versus 33.261 ms, and downstream Wasm planning moved from
50.852 to 52.447 ms. The identical 226,134-byte output and unchanged rewrite
stage are negative controls; the full gate remains the integration boundary.

The required-GPU gate passed all 508 tests. Its two byte-identical, validated
samples in milliseconds were Editor 283.09/170.11, Codex 754.22/536.71, grep
70.24/70.17, Tar 140.31/129.36, wav 62.45/60.98, and raytracer 44.21/42.18. They
are correctness observations rather than a second timing experiment.

### 2026-07-31: CPU Core rewrite is decomposed

The enclosing CPU rewrite timer could no longer distinguish matcher work from
flat-package validation. The result and artifact profiles now expose four
disjoint intervals: input validation, proposal matching, conflict resolution,
and rebuild plus successor validation. A containment regression prevents their
sum from exceeding the enclosing stage, and zero accepted batches report exactly
zero rebuild time.

Seven warm observations after one unrecorded warmup show that input validation
accounts for 34.708 of Codex's 34.860 ms median rewrite stage (99.56%). Matching
takes 0.147 ms, conflict resolution 0.002 ms, and rebuild zero. Tar is the
counterexample: its 24 accepted rewrites divide the 10.059 ms stage between
4.993 ms input validation and 4.825 ms rebuild, with 0.028 ms matching and 0.019
ms conflict resolution. These are empirical medians; the interval containment
and zero-rebuild identity are executable invariants.

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
under exclusive ownership. The malformed raw-package tests continue through full
validation. A construction/validation provenance regression, round trips,
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

The timing delta is consistent with removal of the previously measured 34.708-ms
Codex flat validation, while stable GPU execution is a negative control.
Provenance assertions, malformed raw input, mixed concurrency, generated
proposal equality, and the release gate are executable evidence.

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
commit also become zero. The candidate frontier changes from 963 to zero and the
backend from `gpu` to `identity`. Every observation emitted the same
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
Those fields conflated logical queue membership with physical execution. Section
7.3 now distinguishes logical batch size, packed physical payload size, and
command submission batch size. `downstreamParallelFunctionCount` is nonzero only
for backend `gpu`.

Exact required-GPU profiles now report logical/physical/submission cardinalities
of 1/0/0 and zero downstream functions for Editor, Codex, grep, wav, and
raytracer. Tar reports 1/1/1, 12 downstream functions, and 24 candidates. A new
profile regression pins the identity case; direct raw throughput tests retain
logical batch size two with physical size zero.

The concurrency regression was also made non-flaky and theoretically aligned. It
first observes malformed raw Core rejection, then separately submits four real
add-zero jobs under throughput scheduling and requires physical packing.
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
repeatable compiler cost. That run is an inconclusive empirical measurement, not
evidence for or against a compiler transformation.

Section 7.1 now makes the paired estimator part of the measurement
specification. The output retains every warm CPU and GPU total and reports
\(\widetilde d\) and \(\operatorname{MAD}_d\). For Codex, the retained totals
were

\[ \begin{aligned} C={}&[423.755,406.384,417.988,403.072,411.753,388.763],\\
G={}&[445.917,439.579,440.966,427.093,426.497,452.171]\ {\rm ms}. \end{aligned}
\]

Their marginal medians are 409.068 and 440.273 ms, whose difference is 31.205
ms. The paired differences have median 23.499 ms and MAD 5.046 ms. Therefore
subtraction of marginal medians overstates the measured paired latency
difference by 7.706 ms on this run. This is an arithmetic property of the
retained observations; interpreting it as a population effect remains an
unverified hypothesis.

The same executable six-target run measured paired GPU-minus-CPU median/MAD
milliseconds of Editor 24.483/3.489, Codex 23.499/5.046, grep 28.226/0.377, Tar
55.289/5.074, wav 28.020/0.511, and raytracer 28.379/1.306. Five programs have
an exact Core identity frontier and their premium is close to the measured
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

The concurrency benchmark still selected a crossover by comparing marginal CPU
and GPU medians and described its largest tested size as a lower bound when none
was found. The Codex counterexample above already disproves equivalence of the
marginal and paired estimators. A lower-bound conclusion would additionally
require a proof that the paired GPU-minus-CPU difference is monotone in batch
size; the scheduler, capacity splits, frontend arrival order, and device queue
provide no such model.

The executable report now retains all CPU, GPU, and paired observations at each
batch size, selects break-even using the Section 7.1 paired predicate, and
reports only `maximumMeasuredBatchSize` on failure. The measured set expands
from \(\{1,2,4,8,16\}\) to \(\{1,2,4,8,16,32,64\}\).

A 16-sample run found no paired crossover under either policy. Latency-policy
paired median/MAD differences in milliseconds were

\[ [26.975/0.903,\ 26.232/0.970,\ 28.784/2.718,\ 28.192/3.924,\
30.808/5.522,\ 24.739/12.212,\ 41.324/13.775], \]

and throughput-policy values were

\[ [29.813/0.818,\ 26.502/0.822,\ 36.796/2.253,\ 34.671/3.751,\
35.840/6.277,\ 26.990/11.506,\ 30.975/8.843]. \]

The entries follow increasing batch size. At \(N=64\), throughput CPU and GPU
medians were 603.336 and 645.696 ms. Thus marginal work per compilation was
9.427 and 10.089 ms, and the paired premium amortized to \(30.975/64=0.484\) ms
per job. The physical Wasm payload median saturated at 16 jobs for both \(N=32\)
and \(N=64\).

These are empirical measurements. They prove neither monotonicity nor absence of
a crossover outside the measured set. They do reject, on this adapter and
protocol, the hypothesis that the configured scheduler reaches latency
break-even merely by presenting up to 64 concurrent grep compilations. Raising
the 16-job physical batch limit remains an unverified experiment rather than an
inferred optimization.

### 2026-07-31: larger physical Wasm batches are rejected

The next experiment changed the common payload/submission cap from 16 to 64. Let
\(K\) be that cap and suppose \(N\) jobs are ready together and within device
capacity. The number of physical payload batches is \(b_K(N)=\lceil N/K\rceil\).
Increasing \(K\) from 16 to 64 therefore removes up to three physical boundaries
at \(N=64\), without changing the sum of atom work or logical payload bytes.

The possible saving is

\[ (b_{16}(N)-b_{64}(N)) (T_{\rm allocate9}+T_{\rm encode}+T_{\rm map}), \]

while the larger batch retains \(O(\sum_i A_i)\) host packing, GPU dispatch, and
copied output work and increases the live packed-buffer footprint and alignment
padding. Capacity preflight and stable recursive splitting preserve correctness
for oversized batches, so this was a performance-policy experiment rather than a
semantic change.

At 32 and 64 jobs, cap-16 to cap-64 physical payload medians changed from 16 to
32 and 16 to 64 under latency scheduling, and from 16 to 20.5 and 16 to 34.5
under throughput scheduling. The larger cap therefore exercised its intended
mechanism. Nevertheless, paired GPU-minus-CPU median/MAD milliseconds changed as
follows:

| Policy     | \(N\) |        Cap 16 |        Cap 64 |
| ---------- | ----: | ------------: | ------------: |
| latency    |    32 | 24.739/12.212 | 40.804/19.935 |
| latency    |    64 | 41.324/13.775 | 36.428/21.910 |
| throughput |    32 | 26.990/11.506 |  44.275/8.959 |
| throughput |    64 |  30.975/8.843 | 35.606/15.120 |

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

\[ T_{\rm optional}(x)= \begin{cases} T_G(x), & \text{GPU succeeds without
differential verification},\\ T_C(x)+T_G(x), & \text{GPU succeeds with
sequential differential work},\\ T_U(x)+T_C(x), & \text{GPU is unavailable}.
\end{cases} \]

It minimizes latency only under an independently justified selector. The
implementation has no online calibration, hardware-portable constants, or proved
crossover. The isolated emitter medians on the RTX 4080 SUPER were CPU
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
byte-identical, engine-valid samples in milliseconds were Editor 272.61/140.03,
Codex 715.70/517.82, grep 42.97/44.77, Tar 143.47/132.24, wav 36.32/35.93, and
raytracer 41.68/39.83. These correctness samples do not measure the default-CPU
latency removal.

### 2026-07-31: sessionless compilation discards cache identities

Profiling exposed semantic-context and semantic-fingerprint stages in every
from-scratch benchmark even though those runs pass no compilation session.
Inspection found exactly two consumers of the resulting identity: a session
compilation lookup and the corresponding validated-artifact insertion. Section
6.4 now makes identity construction conditional on ownership by that session.

Independent compilation no longer resolves and hashes the host interface for a
cache key, normalizes the full syntax tree, scans the source dependency suffix,
or content-encodes the normalized tree. The real host-interface elaboration, all
semantic stages, and all artifact validation remain. Session-backed compilation
executes the former code unchanged.

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
invariant. The uniformly lower end-to-end observations are empirical and are not
wholly attributed because the comparisons are consecutive rather than
interleaved across commits.

The 514-test required-GPU release gate passed. Its byte-identical, engine-valid
samples in milliseconds were Editor 271.99/148.69, Codex 785.39/547.92, grep
43.09/46.37, Tar 160.52/135.64, wav 37.75/33.74, and raytracer 39.07/37.88.

### 2026-07-31: source-control fixed-point work becomes observable

The remaining Codex profile attributed roughly 74 ms to control-flow lowering,
but the artifact did not expose whether this was one expensive traversal or many
fixed-point rounds. Section 6.5 records the actual algorithm and the unproved
32-round restriction.

Lowering now reports physical pass count and times its first and accumulated
subsequent transformations without adding another traversal. Existing callers
retain the module-only interface. The profile containment regression requires
the enclosing stage to contain both transformation intervals, and a
straight-line fixture pins one physical pass.

The six-target CPU representative measured pass counts \([1,2,1,1,1,1]\).
Enclosing/first/subsequent milliseconds were Editor 2.673/1.294/0, Codex
73.905/17.055/41.762, grep 0.619/0.200/0, Tar 2.066/0.212/0, wav 0.209/0.114/0,
and raytracer 0.434/0.225/0. Subtraction leaves 1.379, 15.088, 0.419, 1.854,
0.095, and 0.208 ms respectively inside post-pass search and orchestration.

These are empirical representative observations. The pass count is exact for
each artifact. Codex's second pass must perform useful lowering because the
first pass's search found residual source control and the second pass's search
did not; timing alone does not identify which constructors dominate its 41.762
ms transformation. A fused decreasing measure is the next derived algorithm, not
an implemented claim.

The unchanged 514-test required-GPU gate passed with samples Editor
242.93/141.68 ms, Codex 691.27/517.66, grep 44.00/38.92, Tar 141.18/128.27, wav
33.18/32.09, and raytracer 38.56/35.74. All paired artifacts were byte-identical
and engine-valid.

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
\([1,2,1,1,1,1]\). CPU total medians changed respectively 86.569→79.418,
446.661→396.694, 12.256→10.600, 59.854→57.457, 5.711→5.136, and 9.001→8.502 ms.
Required-GPU medians also moved downward in every case.

Predicate equivalence and pass-count preservation are executable/structural
evidence; timing is empirical. The end-to-end changes are not wholly attributed
because the before and after compiler runs were consecutive rather than
interleaved.

The 514-test required-GPU gate passed after the typed search. Its
byte-identical, engine-valid samples in milliseconds were Editor 267.58/151.45,
Codex 775.22/576.47, grep 44.68/40.95, Tar 151.32/131.86, wav 34.86/34.18, and
raytracer 39.86/37.84.

### 2026-07-31: residual control proves fixed-point termination

The final control-flow audit removes the arbitrary 32-pass failure. The typed
search now counts every residual source-control constructor and retains the
first as diagnostic evidence. After the first pass establishes \(r_1\), each
later nonterminal pass must strictly decrease the count. Section 6.5 derives the
bound \(P\leq r_1+1\).

The frozen residual-count/pass pairs are Editor 0/1, Codex 2/2, grep 0/1, Tar
0/1, wav 0/1, and raytracer 0/1. A new Codex profile regression requires a
positive residual frontier and the derived pass bound; a straight-line
regression requires zero residual control. Stagnation reports the first
constructor's source span and kind plus prior and successor counts.

Because counting traverses the complete typed syntax graph rather than returning
at the first residual node, consecutive control-flow representatives changed
from 1.276→1.987 ms Editor, 57.031→56.020 Codex, 0.200→0.190 grep, 0.292→0.301
Tar, 0.130→0.181 wav, and 0.260→0.417 raytracer. This is a mixed empirical
performance result and no speedup is claimed. The selected design prefers a
well-founded semantic restriction over an unexplained numeric cap.

The 515-test required-GPU gate passed with byte-identical, engine-valid samples
Editor 239.12/130.66 ms, Codex 657.48/462.22, grep 40.67/40.35, Tar
139.90/120.23, wav 34.54/32.81, and raytracer 37.57/35.96.

### 2026-07-31: residual control is decomposed by constructor

Review 51 decomposes the first-pass measure without changing it. The residual
scanner now counts ordinary, range, and collection loops separately while
performing the already-required complete syntax traversal. The scalar work and
storage increments are constant per residual constructor and constant per
compilation respectively; there is no additional pass or allocation proportional
to syntax size.

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
file. The executable bounds are \(0\leq d_1\leq r_1\); straight-line syntax pins
both to zero.

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
sharing; there are not two allocated or separately hygienised loop nodes at this
point. This is the counterexample that changes the design.

The executable inequalities are \(d_1\leq u_1\leq r_1\), and the frozen Codex
test pins all three observations. The scanner adds one expected-constant object
identity insertion per residual occurrence and \(O(u_1)\) transient storage. For
Codex that is two insertions retaining one reference.

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
3,528/3,188, Codex 22,103/12,231, grep 1,193/934, Tar 6,083/1,375, wav 317/317,
and raytracer 578/578. The respective redundant occurrence counts are 340,
9,872, 259, 4,708, zero, and zero; the corresponding sharing factors \(O_1/V_1\)
are 1.11, 1.81, 1.28, 4.42, 1.00, and 1.00.

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
`forCollection count from 2 to 2`; the former scanner reported only one. This is
executable validation of full descent and stagnation, while strict decrease for
all admitted lowering shapes remains a dynamically checked invariant.

Five corpus targets are unchanged because no residual target remains after pass
one. Codex changes from 22,103/12,231 to 22,177/12,248 search
occurrences/vertices, exposing 74 occurrence visits and 17 vertices inside the
shared residual loop. Its residual vector remains two occurrences, one vertex,
and one source. Contemporary CPU control-flow representatives were 1.180,
60.108, 0.247, 0.369, 0.125, and 0.597 ms; CPU total medians were 80.157,
422.822, 11.636, 60.740, 4.964, and 9.425 ms. The change is semantic measurement
repair, not a speed claim.

### 2026-07-31: object-map DAG aggregation is rejected

Review 56 implemented the exact DAG alternative derived after Review 54. It
discovered each syntax vertex and edge once, rejected cycles, topologically
propagated root occurrence multiplicities, checked safe-integer arithmetic, and
preserved every frozen residual and search count. The 38 focused profile/Core
tests passed, including nested residual descent.

The implementation nevertheless raised CPU control-flow representatives from
1.180→2.095 ms Editor, 60.108→64.663 Codex, 0.247→0.478 grep, 0.369→0.717 Tar,
and 0.125→0.224 wav. Raytracer measured 0.597→0.430 ms, but its sub-millisecond
change does not outweigh five coherent regressions. Whole-compiler medians moved
80.157→76.180, 422.822→416.835, 11.636→11.104, 60.740→57.518, 4.964→5.193, and
9.425→9.924 ms; the mixed totals demonstrate why the isolated stage decides this
mechanism.

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
retain every reachable node. Conversely, that same ownership proves there is no
peak-live-memory reduction.

An A/B/A sequence produced Weak/Set/Weak control-flow milliseconds of
1.794/2.087/2.571 Editor, 57.566/60.450/58.531 Codex, 0.271/0.228/0.261 grep,
0.404/0.372/0.420 Tar, 0.130/0.123/0.127 wav, and 0.241/0.289/0.245 raytracer.
Codex and raytracer favor weak identity; grep and Tar favor ordinary identity;
Editor is unstable. The result demonstrates target-dependent constants rather
than an admissible global speedup.

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
pre-comptime specialization 110.790, type analysis 68.714, CPU Wasm planning and
emission 68.634, Core flattening 42.988, Core lowering 42.372, and parsing
34.668. These sums are workload-weighted observations, not intrinsic stage
complexities.

Within Codex, the largest substages are specialization rewrite 68.594 ms,
control-flow lowering 60.450, CPU Wasm planning/emission 52.286, type inference
40.457, Core flattening 32.570, Core lowering 31.706, specialization lifting
22.751, local-import resolution 18.349, and ABI construction 21.058. The next
review therefore moves to specialization rewrite, the largest isolated substage,
while retaining control flow as the second frontier.

Codex specialization observes 703 distinct keys but only four result-cache hits,
884 distinct function analyses and 630 analysis-cache hits, 6,828 rewritten
blocks, and 412,890 avoided environment-entry copies. Those counts do not yet
prove that a wider cache is sound or profitable; they define the questions for
the next derivation.

### 2026-07-31: function-analysis reuse is named as reuse

Review 59 traces the apparent 630 “repeated function analyses” to the metric's
increment site. The counter advances only when `functionAnalyses.get(factory)`
returns a cached analysis or cached non-inlineable result; the body scan is then
skipped. It measures successful memoization, not repeated work.

The metric is renamed `specializationFunctionAnalysisCacheHitCount` throughout
the specialization result and compilation profile. A focused program applies the
same higher-order function twice and requires both a positive distinct analysis
count and a positive cache-hit count. The WeakMap key is function AST object
identity, which is sound because the analysis depends only on that immutable
function's body and parameter symbols, not on the substitution environment.

Codex's corrected interpretation is 884 scans plus 630 avoided scans, a 41.61%
hit share among 1,514 analysis requests. This does not reduce the measured
68.594 ms rewrite stage; it removes a false optimization lead. The four
completed-result hits beside 703 distinct specialization keys remain a separate
cache domain for Review 60.

The specialization-result key is

\[ K=(function,callsite,static\ arguments,captured\ environment). \]

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
call-site provenance distinguishes only one Editor key and five Codex keys. Even
perfect span-insensitive reuse could merge at most 0.71% of Codex's distinct
entries, while returning incorrect source provenance without a relabeling pass.

The semantic-key set was removed before commit. During its instrumented run,
Codex rewrite measured 71.300 ms versus the preceding 68.594 ms baseline; this
single consecutive change is not an attributed regression, but it confirms that
permanent duplicate key construction needs a stronger benefit.

The cheap pending-cycle counter remains. Result-cache lookup requests partition
exactly into distinct insertions \(D\), complete hits \(H\), and pending-cycle
hits \(P\), so the hit rate is \(H/(D+H+P)\). Codex reports
\((D,H,P)=(703,4,0)\), or 0.566%; Editor reports `(47,2,0)`, or 4.082%. A
focused non-recursive two-call test pins positive analysis-cache reuse and zero
pending result cycles. The next review must inspect argument/environment
identity dispersion rather than call-site spans.

### 2026-07-31: final-expression identity memoization is rejected

Review 61 tested a WeakMap from immutable static-expression object identity to
its fully serialized specialization identity. This is semantically sound within
one specialization run: typed expressions and types are immutable, assigned
function/value IDs are stable in the context, and the identity function has no
substitution-environment input after `staticValue` selects its argument.

The cache observed 20 Editor hits and 223 Codex hits; the other four targets had
none. Its cost inequality is

\[ Hc_{serialize} > Qc_{lookup}+Uc_{insert}, \]

for \(Q\) identity requests, \(H\) hits, and \(U\) misses. A first consecutive
representative suggested a Codex improvement, but a second produced an 84.506 ms
outlier. This exposed that the profile nearest the end-to-end median is not an
estimator for an individual substage.

Fifteen direct Codex rewrite samples per variant then measured median/MAD
65.263/2.175 ms cached and 65.000/1.825 ms baseline. The +0.41% median change is
smaller than either MAD and rejects the mechanism. The implementation and its
metric were removed before commit. Future substage decisions use samples and
statistics for that substage directly, not the total-median representative.

### 2026-07-31: rewrite amplification is measured

Review 62 temporarily counted every recursive `rewriteExpression` entry. Let
\(C\) be entries and \(N_d\) demanded input nodes. The measured \(C/N_d\)
factors were Editor 6,718/4,150 = 1.62, Codex 130,143/16,119 = 8.07, grep
670/707 = 0.95, Tar 3,499/4,411 = 0.79, wav 269/269 = 1.00, and raytracer
458/458 = 1.00.

Codex's residual program has 23,594 nodes, only 1.46 times demanded input, so
output expansion alone cannot explain 8.07 traversals per input node. At least
106,549 rewrite entries exceed one visit per residual node, although this
subtraction is an empirical work comparison rather than an object-identity
proof: generated and eliminated expressions inhabit different sets.

The entry counter was removed before commit because it executes on the exact hot
recursion being measured. Its instrumented representative was 78.107 ms and is
not compared to an uninstrumented latency baseline. The work vector is the
evidence. The next decomposition separates entries under a specialization
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
otherwise. The counterexample rejects deep recursive nesting as the cause. Codex
instead performs broad specialization: its 114,281 substitution entries average
162.56 per distinct result key. This average does not imply equal body sizes or
independent jobs, but it identifies request breadth as the dominant work domain.

The hot counters were removed after measurement. The next sound optimization
must preserve the ordered substitution stack and pending-cycle semantics while
discarding or sharing work across equivalent request bodies. Parallel execution
is admissible only after dependencies through captured environments and nested
requests form an explicit acyclic frontier; the shallow stack alone is not a
proof of independence.

### 2026-07-31: substitution-stack flattening is rejected

Review 64 temporarily counts reference queries made while a substitution
environment is active, individual environment-map probes, and successful
substitutions. The `(queries, probes, hits)` vectors are Editor `(823,883,125)`,
Codex `(31,660,31,669,2,705)`, grep `(1,1,1)`, and zero for Tar, wav, and
raytracer.

Reverse stack search implements lexical shadowing: the newest parameter
substitution wins. An overlay map with rollback would reduce probes from \(\sum
q_i d_i\) to \(\sum q_i\), but must update and restore entries at every request
boundary. Codex has only nine probes beyond one per query, so its maximum
possible lookup saving is nine map reads against 703 push/pop updates. Editor
has 60 extra probes but only 823 queries in a 4 ms stage. The derived inequality
cannot hold on this corpus.

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

Each substitution environment is constructed exactly from `factory.parameters`.
Resolution assigns every such symbol scope `parameter`. Therefore

\[ scope(r)\neq parameter \Longrightarrow \forall E\in substitutionStack.\
r.id\notin dom(E). \]

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

Fifteen direct Codex rewrite samples in A/B/A order measured guarded median/MAD
72.626/4.050 ms, unguarded 79.616/8.113, and guarded 68.083/2.717. Both guarded
medians beat the intervening baseline; their variation warns against a sharper
attributed percentage. The deterministic claim is removal of 16,660
proved-negative Codex map queries. The observed latency direction supports
retaining the guard.

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
median/MAD 66.819/1.244 ms, eager 72.842/4.014, and lazy 67.403/2.324. Both lazy
medians beat the intervening eager baseline. This supports retaining the
zero-allocation terminating cases; no claim is made for programs dominated by
long alias chains.

### 2026-07-31: retained specialization fast paths reduce all six rewrites

Review 68 re-runs the paired six-target frontend protocol after the
resolver-scope guard and lazy static-alias set. Against the retained Review 57
ordinary-set baseline, specialization rewrite representatives change Editor
4.368→3.987 ms (-8.74%), Codex 68.594→64.079 (-6.58%), grep 0.305→0.262
(-13.92%), Tar 3.465→2.825 (-18.47%), wav 0.081→0.069 (-15.18%), and raytracer
0.199→0.172 (-13.67%). The coherent six-target stage direction supports the
local mechanisms; consecutive-run noise prevents attributing each percentage
exactly.

CPU total medians are 74.531, 386.544, 11.045, 57.620, 5.262, and 8.507 ms.
Required-GPU medians are 102.646, 440.070, 39.530, 113.605, 33.287, and 36.811
ms. Paired GPU premiums remain positive at 26.184, 54.538, 28.485, 58.059,
28.029, and 28.385 ms, so the default-CPU policy remains justified.

Deterministic Wasm sizes remain 24,460, 226,134, 3,911, 26,106, 2,520, and 3,864
bytes. The fast paths remove lookups and allocations but change no
specialization keys, demanded bindings, residual structure, or emitted bytes.
This checkpoint is empirical evidence, not yet the full release gate.

### 2026-07-31: specialization fast paths pass the release gate

Review 69 closes the checkpoint with `deno task release:gpu`. Formatting,
linting, and type checking passed across 133 formatted and 117 linted files. All
519 tests passed. This includes the complete corpus, deterministic frozen
binaries, specialization semantics, effects, ownership, Core validation,
generated GPU differential properties, concurrency, and device-failure paths.

The required-GPU release adapter reported 256 MiB maximum buffer size and 128
MiB maximum storage binding size. Malformed input retained the expected source
diagnostic. Cold/repeated target samples in milliseconds were Editor
240.61/128.83, Codex 673.86/477.54, grep 41.51/40.53, Tar 137.24/125.43, wav
34.41/33.48, and raytracer 38.88/39.13. Wasm sizes matched the checkpoint:
24,460, 226,134, 3,911, 26,106, 2,520, and 3,864 bytes.

Every GPU artifact matched the independently emitted CPU bytes and passed engine
and artifact validation. These are executable validations. The latency samples
are release observations, not distribution estimates; the six-sample paired
benchmark remains the performance evidence.

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
median/MAD 66.411/1.931, 66.161/2.506, and 66.631/2.280 ms. Both hoisted medians
are slightly slower, and every difference is below MAD. The implementation was
removed. Candidate sorting is not the material cost at current referenced-set
sizes; request-specific membership and value identity remain possible costs, but
require their own work measurement.

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
arguments across 47 keys, maximum three, and 155 identity calls. Codex has 1,357
arguments across 703 keys, maximum seven, and 1,416 identity calls. Grep has two
arguments and two calls; the other targets have none.

Codex therefore averages 1.93 static arguments per key. Recursive structural
identity adds only 59 calls beyond the 1,357 top-level arguments; this includes
the 26 captured-environment entries measured in Review 71. All key identity work
is only 1.09% of the 130,143 rewrite entries measured in Review 62.

The hot counters were removed. Together Reviews 60, 61, 64, 70, 71, and 72 close
call-site spans, final-identity caching, stack depth, candidate sorting,
captured environments, and static-argument serialization as primary causes. The
remaining specialization frontier is transformation of requested bodies, not
construction of their cache keys.

### 2026-07-31: specialization request work is heavy-tailed

Review 73 temporarily attributes rewrite entries exclusively to the innermost
active specialization request. Editor's completed requests contain 1,881 entries
total and its largest contains 958, or 50.93%. Codex contains 114,281 entries
total and its largest contains 32,184, or 28.16%. Grep's only request contains
two entries.

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
other frozen target crosses either threshold: Editor's maximum is 958, grep's is
two, and Tar, wav, and raytracer have no completed specialization request.

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
requests each contain 32,184 entries and specialize the identical `encode_json`
source span, bytes 18,021--19,590, at protocol call sites 6,697--6,728 and
7,078--7,109. Together they account for 56.33% of request work.

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

The identity instrumentation was removed. No implementation follows yet: current
rewriting performs context-sensitive reductions while traversing, so a template
is viable only after classifying how much of the 32,184 entries is structurally
invariant versus argument-dependent.

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
specialization, static lookup through varying values, and binding scopes are the
induction boundaries and must be represented explicitly. The temporary counters
were removed. The next review should measure free-parameter dependency at
subtree granularity rather than infer it from final object identity.

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
environment and reused for all substitutions. However, the body count alone does
not explain the encoder's 6.07 rewrite entries per source occurrence; selected
branches and recursively constructed expressions create additional work. A
template mechanism should therefore begin with the encoder's 5,286 independent
occurrences and retain ordinary rewriting at the 12 dependent boundary nodes,
while parse requests need a different cost decision.

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
average work avoided per hit. A cache requires \(EL < HR\). With \(E/H=26.73\),
each hit must repay at least 26.73 lookups. The observed 5--6 ms regression
proves that this implementation does not. Precomputed root markers invert the
domain: they pay a branch at candidate roots rather than a map lookup at all
entries. The cache and counters were removed; the evidence closes dynamic
identity memoization for this corpus.

### 2026-07-31: invariant regions require semantic environment keys

Review 81 specifies, but does not implement, a specialization invariant-region
primitive. For body occurrence \(n\), parameter set \(P\), captured value map
\(\rho\), and substitution \(\sigma\), define \(dependent(n)=FV(n)\cap
P\ne\varnothing\). A maximal invariant region is a node with `dependent = false`
whose parent is dependent or absent. Its reusable key is
`(body semantic identity, region index, captured-environment identity)`. Source
span alone is excluded: equal spans in parameterized module instances can denote
closures with different captures.

The lowering computes dependency bits bottom-up, compacts maximal roots, and
rewrites each root once under \(\rho\). Request rewriting treats the cached
result as an immutable leaf and traverses dependent regions normally. By
structural induction, substitution cannot alter an invariant root because none
of its free references belongs to \(P\); equality of captured-environment
identity supplies equal values for the remaining free references. Unique typed
symbol IDs discharge shadowing. Nested specialization remains inside the cached
root's one-time rewrite and must use the same captured key.

With \(V\) body occurrences and \(K\) requests sharing the key, analysis costs
\(O(V)\) once and stores one bit plus compacted roots. The maximum traversal
saving is \((K-1)(V-D)\), where \(D\) is dependent occurrences. For the two
encoder requests, this source-level ceiling is 5,286 avoided occurrences for
about 663 bytes of dependency bits before packing. Generated rewrite work may
raise the benefit, but only an implementation experiment can establish it.

### 2026-07-31: existing fingerprints cannot directly name typed bodies

Review 82 audits the repository's identity mechanisms. The module-instance key
contains frontend version, canonical module ID, transitive analysis hash,
parameter names, and compile-time argument keys. The session semantic
fingerprint names root syntax plus host/backend context. `contentIdentity` is an
injective structural serialization for acyclic values, not a fixed-size hash;
applying it to every typed body would cost \(O(V)\) bytes and work per identity
construction and duplicate the traversal being optimized.

Neither module identity nor source span alone selects one typed function:
desugaring may create multiple functions at one span, while one module contains
many spans. The derived body key is therefore
`(module-instance key,
lexical-definition path, typed-lowering schema)`. A
lexical-definition path is the stable sequence of statement/binder ordinals in
source order, not the allocator-dependent symbol ID. Generated functions append
a deterministic generation ordinal. This key is collision-free by construction
when each component uses the existing length-prefixed encoding.

Current specialization does not retain that provenance on typed functions, so
Review 81's cross-object template cannot be implemented soundly yet. Adding it
would touch parsing, linking, hygiene, typing, and specialization and therefore
is a separate representation feature, not a local cache patch. Until its
invariants and differential tests exist, optimization remains bounded to object
identity within one typed module.

### 2026-07-31: invariant discovery is currently a CPU preparation pass

Review 83 derives the execution boundary for Review 81. On a flat expression DAG
with reverse edges, dependency marking is a Boolean data-flow problem: parameter
references seed a frontier, parents receive logical OR, and compaction produces
maximal invariant roots. Work is \(O(V+E)\); level-synchronous span is \(O(h)\),
or \(O(\log V)\) for tree contraction with greater constants. Storage is one
dependency bit per vertex plus frontier and reverse-edge arrays.

The implementation does not yet have that flat payload. Typed Ducklang uses
object variants and child arrays, so GPU discovery would first serialize every
node and edge, allocate reverse adjacency, submit kernels, and read or retain a
new index mapping. The largest measured encoder body has only 5,298 occurrences
(about 663 packed dependency bytes), while current isolated GPU emission has a
roughly 27--28 ms small-job floor. Even zero-cost device propagation cannot
repay that boundary for one body when the entire CPU rewrite stage is about 70
ms and discovery is only its prerequisite.

Therefore invariant analysis, if implemented before flat HIR exists, belongs in
the existing CPU function analysis and emits compact root annotations consumed
by rewriting. A future flat HIR can reuse the same monotone equation on GPU when
many bodies are batched; the break-even condition is
\(T_{serialize}+T_{submit}+T_{readback}<T_{CPU-mark}-T_{GPU-mark}\). Current
measurements provide no positive right-hand margin, so GPU offload is an
unverified future hypothesis rather than part of this optimization.

### 2026-07-31: lexical environment copying is already eliminated

Review 84 reads the retained block metrics rather than adding instrumentation.
Codex rewrites 6,828 blocks while avoiding 412,890 entries that a full map copy
per block would duplicate, an average of 60.47 entries per block. Editor avoids
57,311 across 827 (69.30/block); Tar avoids 22,293 across 480 (46.44/block).
Grep, wav, and raytracer avoid 1,267, 210, and 492 entries respectively.

The current algorithm mutates one lexical value map at the boundary, records
only overwritten bindings, and restores them in reverse order. If block \(b\)
introduces \(k_b\) bindings, its environment bookkeeping is \(O(k_b)\), versus
\(O(|\rho_b|)\) for copying. Unique symbol IDs and reverse restoration preserve
the functional shadowing model. Replacing this with a persistent map would add
path-node allocation and \(O(\log |\rho|)\) lookup without removing shared
mutation, because the mutation is already scoped and unobservable.

Thus the 412,890 figure is avoided work, not a remaining optimization ceiling.
The live cost is allocation of the small restoration arrays and map operations
for introduced bindings; it must be measured separately before alteration.
Environment copying is closed as an explanation for the 32,184-entry encoder
requests.

### 2026-07-31: lexical restoration work is small and proportional

Review 85 temporarily counts every value-map install and corresponding restore.
Codex performs 13,992 mutations, representing 6,996 rewritten bindings, across
6,828 blocks: 2.05 map operations per block and 10.75% as many operations as the
130,143 rewrite entries. Editor performs 1,406, grep 164, Tar 772, wav zero, and
raytracer 98. Each admitted binding induces exactly two mutations, so the
algorithm meets its \(2\sum_b k_b\) cost model.

Eliminating the restoration array cannot eliminate the map operations without
changing representation, and its maximum record count is only 6,996 for Codex. A
persistent environment would instead allocate at least one path node per install
and increase lookup depth. These counts close lexical restoration as a primary
specialization frontier. The temporary counter was removed.

### 2026-07-31: residual accounting already exploits structural sharing

Review 86 uses retained metrics. Codex's node-count cache hits 99 shared roots
whose cached subtrees contain 32,243 occurrence nodes, exceeding the final
23,594-node residual occurrence count. Editor skips 14,038 nodes through 330
hits; Tar skips 8,843 through 67. The representative Codex accounting stage is
3.887 ms, versus 64.079 ms rewriting and 22.199 ms function lifting.

The cache is outside the recursive transformation hot path and performs one weak
lookup per residual root traversal, where each hit can skip hundreds of
descendants. This is the favorable inverse of Review 80's cache domain. Its
observable result is only a metric count, and object identity is sufficient
because immutable sharing makes equal objects equal subtrees. No semantic key or
cross-request reuse is required.

Accounting is therefore functioning as intended and is not the next frontier.
The retained evidence redirects the audit to lifting, now the second-largest
specialization substage and 5.71 times accounting on the representative Codex
sample.

### 2026-07-31: Codex lifting is generated-function dominated

Review 87 temporarily exposes lifted binding and direct-function counts. Codex
lifts 403 bindings from a set of 433 direct function symbols in 22.926 ms, or
56.89 microseconds per lifted binding. Editor lifts 55 of 194 in 1.630 ms; grep
13 of 17 in 0.344 ms; Tar 6 of 10 in 1.285 ms; wav none of five; raytracer 9 of
14 in 0.136 ms.

The implementation discovers all direct functions in one traversal, but each
eligible block binding can then trigger a scope scan for direct-only use, a
capture scan, call-argument rewriting, recursive lifting, step filtering, and
possibly symbol-reference renaming. For \(F\) lift candidates in a scope of
\(V\) occurrences, the current worst case is \(O(FV)\), not \(O(V+F)\). Codex's
403 lifts make that repeated-work term plausible; wav's zero lifts and 0.019 ms
provide the opposite boundary.

The counters were removed. The next review must count the actual nodes visited
by direct-use and capture scans before changing algorithms; lifted-binding count
alone does not identify which repeated traversal dominates.

### 2026-07-31: direct-use validation is not the lifting multiplier

Review 88 instruments `isOnlyDirectlyCalled`. Codex invokes it 57 times and
visits 19,541 expression occurrences, less than one traversal of the 23,594-node
residual program. Editor visits 820 in 10 scans, grep 257 in four, and raytracer
828 in nine; generated-control-only Tar and wav invoke no scan.

The 403 Codex lifts do not imply 403 direct-use traversals because generated
loop/range functions are call-only by construction and bypass validation. The
measured 19,541 occurrences are only 15.02% of specialization rewrite entries
and cannot explain an \(O(FV)\) multiplier. Removing or memoizing this scan
would also weaken validation for ordinary nested functions unless an equivalent
use classification were produced upstream.

The counters were removed. Lifting review narrows to the work performed for the
403 accepted functions: capture discovery, capture-argument insertion, step
removal, and repeated block rebuilding.

### 2026-07-31: capture discovery is the measured lifting multiplier

Review 89 counts occurrences visited by `collectFunctionCaptures` for accepted
lifts. Codex visits 107,069 occurrences, 4.54 times its 23,594-node residual and
5.48 times the 19,541 direct-use visits. Editor visits 2,114, grep 672, Tar
4,070, raytracer 256, and wav zero. Codex capture visits are also 82.27% of the
130,143 specialization rewrite entries.

Each accepted function currently constructs its defined-symbol set and walks its
complete body independently. Nested generated functions cause ancestors and
descendants to be revisited. Capture sets satisfy the compositional equation
\(FV(function)=FV(body)-parameters-localDefinitions-directFunctions\), so a
single bottom-up free-variable analysis can replace repeated scans if it
preserves lexical ownership and deterministic first-use order.

The temporary counters were removed. The next review must measure the number of
captures emitted versus nodes scanned; then an implementation can choose between
cached per-function summaries and a whole-residual bottom-up pass with a stated
memory cost.

### 2026-07-31: capture discovery has 0.39% output density

Review 90 counts capture records produced by the scans from Review 89. Codex
emits 418 captures from 107,069 visited occurrences: 1.04 captures per 403
lifted functions and 0.39% output density. Editor emits 65 from 2,114, grep 20
from 672, Tar eight from 4,070, raytracer nine from 256, and wav none.

The compact result domain is therefore \(O(F+C)\), where \(F=403\) and \(C=418\)
for Codex, while repeated discovery performs 107,069 visits. A summary record
needs a function ID, capture offset, and capture count (12 bytes with 32-bit
fields), plus capture symbol/type references. Even at 16 bytes per capture,
Codex metadata is about 11.5 KiB, far below the object traffic of the repeated
scans. Deterministic first-reference order can be retained by stable source
occurrence order rather than set iteration accident.

The counters were removed. This measurement justifies implementing one capture
summary per function, but correctness still requires nested-binder subtraction
and direct-function treatment to match `collectDefinedSymbols` exactly.

### 2026-07-31: capture summaries derive from lexical ownership

Review 91 rejects caching `collectFunctionCaptures(functionObject)` as the
algorithmic solution. Lifting appends capture parameters, rewrites call sites,
and may rename duplicate function symbols, producing new function objects before
recursive lifting. Object-keyed summaries would miss precisely along that
transformation path.

The stable formulation assigns every non-module symbol a lexical owner function
before lifting. During one source-order traversal, maintain the function-owner
stack. A reference from current function \(f\) to symbol owned by ancestor \(g\)
is added once to every function on the stack from \(f\) up to but excluding
\(g\). A reference whose owner is outside the outermost current function
propagates through the whole stack. Parameters and block bindings establish
owners; module and direct-function symbols require no capture.

This is equivalent to independent free-variable scans: every function between a
use and its definition must transport the value, and no function outside that
lexical path may observe it. A sibling reference is impossible after name
resolution. Stable first-use order follows the traversal order; a per-function
seen set prevents duplicates. Work is \(O(V+C\cdot d)\) in the direct stack
form, where \(d\) is propagation depth, and storage is \(O(S+F+C)\). A parent
pointer plus path-difference accumulation can reduce propagation toward
\(O(V+C)\) if measured depth warrants it.

The implementation prerequisite is a stable mapping from each nested function
binding to its pre-lift summary, preserved across deterministic renaming. This
is naturally the binding symbol ID plus an occurrence ordinal for duplicated
IDs; function object identity is not the proof key.

### 2026-07-31: capture propagation depth is bounded by six

Review 92 measures pre-lift function nesting. Maximum depth is six for Codex,
four for Editor, grep, and raytracer, three for Tar, and one for wav. Therefore
the direct owner-stack algorithm from Review 91 performs at most \(C
d=418\cdot6=2{,}508\) Codex capture insertion attempts before deduplication,
only 2.34% of the 107,069 occurrences currently scanned.

This rejects path-difference accumulation and tree-query machinery for the
frozen corpus. A six-element stack is bounded local state, and straightforward
propagation keeps ordering and ownership proofs visible. The temporary depth
counter was removed. A future corpus crossing a declared depth threshold can
reopen the choice, but generalized deep-nesting machinery would currently be
speculative complexity.

### 2026-07-31: capture-argument insertion traverses 8.77 residuals

Review 93 counts every occurrence visited by `appendCallArguments` during
lifting. Codex visits 206,835 occurrences, 8.77 times the 23,594-node residual,
1.93 times capture discovery, and 1.59 times specialization rewriting. Editor
visits 7,207, grep 1,525, Tar 11,841, raytracer 846, and wav zero.

For each accepted function, lifting applies capture insertion to its body and
again to the remaining containing block. Repeating this after every removal
creates a quadratic suffix-rewrite pattern in blocks with many generated
functions. Moreover, the traversal currently runs when the capture-reference
array is empty, although appending an empty argument vector is the identity by
the list monoid law \(xs\mathbin{++}[]=xs\).

The counters were removed. Zero-capture frequency must be measured next; if
material, an early identity return is a semantics-preserving first reduction
independent of the larger one-pass lifting redesign.

### 2026-07-31: over one-third of Codex lifts have no captures

Review 94 counts accepted functions whose capture vector is empty. Codex has 143
of 403 zero-capture lifts, 35.48%. Editor has 20 of 55, grep three of 13, Tar
one of six, and raytracer six of nine. Wav lifts no functions.

For these functions, both uses of `appendCaptures` are provably identity:
parameters append `[]`, call arguments append `[]`, and no closure environment
is introduced. Returning the candidate object directly preserves IDs, spans,
types, and sharing while eliminating traversal and reconstruction. The temporary
counters were removed. Review 95 implements this rule and must retain it only if
focused semantics, deterministic binaries, and A/B/A lifting timing agree.

### 2026-07-31: empty capture insertion now returns immediately

Review 95 implements the empty-vector identity rule at the `appendCaptures`
boundary. Capturing functions retain the existing traversal unchanged;
zero-capture functions return the candidate object directly. All 11 focused
specialization tests pass, including nested captures, two-level capture
propagation, direct-only lifting, and mixed scope identities.

Fifteen direct Codex samples in baseline/fast-path/baseline order measured
pre-specialization lifting median/MAD 23.684/0.718, 20.788/1.934, and
21.961/0.980 ms. The fast path is 2.896 and 1.173 ms below its neighboring
baselines. The second difference overlaps the candidate MAD, so this is a
directional improvement rather than a precise effect estimate. It is retained
because it removes two proven identity traversals for 143 functions, preserves
object sharing, and adds only one branch after captures are already known.

The implementation does not solve the remaining 260 capturing Codex lifts or
replace repeated capture discovery. Review 96 must remeasure traversal work
after the retained rule before advancing to broader reconstruction changes.

### 2026-07-31: empty-capture skipping removes half the traversal

Review 96 reruns Review 93's temporary occurrence counter with the retained
identity rule. Codex capture-argument visits fall from 206,835 to 98,211,
removing 108,624 visits or 52.52%. Editor falls from 7,207 to 4,246 (41.09%),
Tar from 11,841 to 7,941 (32.94%), raytracer from 846 to 396 (53.19%), and grep
from 1,525 to 1,424 (6.62%). Wav remains zero.

The removed share exceeds the 35.48% zero-capture function share because those
functions occupy larger containing suffixes on average. This validates the cost
model at the actual traversal boundary and explains the directional timing
improvement. The counter was removed again; the retained implementation remains
one branch and no profile surface.

### 2026-07-31: lifting step-list scans are secondary

Review 97 counts comparisons in the per-binding `block.steps.find` and
`removeGeneratedFunctionStep` filter. Codex performs 6,258 comparisons, only
6.37% of the remaining 98,211 capture-argument visits. Editor performs 1,360,
Tar 553, raytracer 225, grep 180, and wav zero.

An index from symbol to step could reduce lookup but would not remove filtering,
would require updates after every removal, and would add allocation at every
block. The measured comparison count is below one third of a residual traversal
and does not justify that representation. The temporary counter was removed;
capturing-function call rewriting remains the lifting frontier.

### 2026-07-31: remaining capture insertion has 0.90% output density

Review 98 counts calls changed by `appendCallArguments` after the empty-capture
fast path. Codex updates 886 call sites while visiting 98,211 occurrences, 0.90%
output density. Editor updates 67 of 4,246, grep 23 of 1,424, Tar 68 of 7,941,
and raytracer six of 396. Wav remains zero.

A use index could find those calls, but lifting immediately rebuilds and renames
surrounding immutable objects, invalidating object-location indexes. The derived
primitive is instead a batched rewrite: after capture summaries are known, build
one map from function symbol to ordered capture references and traverse each
residual root once. At a call whose callee symbol is in the map, append its
captures; otherwise preserve identity. This changes work from \(O(\sum_f V_f)\)
to \(O(V+A)\), where \(A=886\) updated Codex calls.

The temporary counters were removed. Batched rewriting must be sequenced with
deterministic duplicate-symbol renaming; applying a map keyed only by a symbol
before resolving duplicate occurrences would conflate distinct lifted functions.

### 2026-07-31: duplicate lifted symbols are the common Codex case

Review 99 counts accepted functions whose original symbol was already lifted and
therefore receives a fresh ID. Codex renames 274 of 403 lifts, 67.99%, and
Editor renames 28 of 55. Grep, Tar, wav, and raytracer rename none.

The duplicate arises when specialization shares or reproduces a generated
binding whose resolver symbol remains the same across occurrences. A batched map
from old symbol ID directly to captures would conflate these occurrences and
route calls to the wrong lifted function. Planning must first assign each
function-binding occurrence a deterministic new ID and associate call
occurrences with that lexical binding occurrence; only then can capture operands
be appended in one traversal.

Thus occurrence identity is normative for lifting even though symbol identity
remains normative for source name resolution. The temporary counter was removed.
Review 100 closes this series by measuring the rename traversal itself and
recording the complete one-pass lifting primitive and next implementation gate.

### 2026-07-31: rename traversal completes the one-pass lifting case

Review 100 counts occurrences visited by `renameSymbolReferences` during
lifting. Codex visits 127,326, 5.40 residual traversals and more than the 98,211
remaining capture-argument visits. Editor visits 3,682; grep, Tar, wav, and
raytracer visit zero because they have no duplicate lifted symbols.

The measured Codex lifting work now includes 107,069 capture-discovery visits,
98,211 post-fast-path argument-rewrite visits, 127,326 rename visits, 19,541
direct-use visits, and 6,258 step comparisons. These categories can overlap in
source objects but represent 358,405 explicit visits/comparisons. The desired
primitive is a three-phase immutable transformation:

1. Analyze one residual snapshot to assign lexical function-occurrence IDs,
   symbol owners, direct-use status, and ordered capture summaries.
2. Deterministically allocate all fresh symbols and construct occurrence-aware
   old-binding-to-new-binding and capture maps.
3. Rebuild each residual root once, removing lifted bindings, rewriting bound
   references and calls with the planned symbol, and appending planned captures;
   emit lifted functions into source-occurrence order.

The correctness invariant is alpha-equivalence plus closure conversion: every
reference resolves to the same lexical binding, every lifted function receives
exactly its free non-module values, every direct call supplies those values in
the same order, and no non-call use is converted without a closure. Work becomes
\(O(V+F+C+A)\) and auxiliary storage \(O(S+F+C)\), versus the measured repeated
traversals. CPU implementation comes before GPU execution; flat occurrence,
owner, capture, and rewrite arrays later map naturally to scan/compact/gather.

The rename counter was removed. This is a specified and measured next task, not
an implemented claim. Review 95's empty-capture rule is the only production code
retained from Reviews 74--100.

The post-Review-100 `release:gpu` gate checked 133 formatted and 117 linted
files, type-checked all source, test, and benchmark entry points, and passed all
519 tests. Required GPU compilation produced independently CPU-matched,
engine-valid artifacts for Editor, Codex, grep, Tar, wav, and raytracer at
24,460, 226,134, 3,911, 26,106, 2,520, and 3,864 bytes. Cold/repeated release
observations were 266.57/143.09, 751.13/550.51, 43.99/40.69, 145.60/134.31,
34.59/32.96, and 39.70/38.29 ms. These two-point observations validate the
release boundary but are not distribution estimates.

### 2026-07-31: Baba GPU syntax is a proved grammar profile

Baba 7.10 has two distinct syntax runtimes. Its generated Wasm runtime is the
complete synchronous grammar implementation and executes on the host CPU. Its
experimental version-3 WebGPU frontend executes lexing, delimiter matching,
island recognition, reachable compact token/node/edge allocation, and ordered
diagnostic construction. Owned ingestion maps those arrays once and then runs
bounded semantic recipes on the host. Resident ingestion stops after submitting
the GPU work and leaves status, counts, and flat syntax on the device. Neither
surface silently falls back.

Let \(G_{gpu}\) be the grammar profiles for which Baba generation proves fixed
terminal identity, deterministic island transducers, explicit structural
boundaries, bounded contraction, and bounded output multiplicity. Selecting the
GPU frontend is sound only for \(G\in G_{gpu}\). This resembles the local
parsability restriction used by PAPAGENO [23] and the grammar reshaping used by
Pareas [24]: parallelism follows from a restricted grammar model rather than
from speculating that a conventional parser stack is parallel.

Accepted-input conformance is equality of all token, node, edge, symbol, and
type words against Baba's independent `CpuFrontend` oracle. Rejected-input
conformance is equality of ordered diagnostic codes and source spans, not of
internal attribution. The executable counterexample `let answer = ;` is
attributed to island 19 by the CPU and island 3 by the GPU, while both report
`GPU_FRONTEND_SYNTAX_ERROR` at `[13, 14)`. Diagnostic-record byte equality is
therefore not a sound Baba 7.10 invariant.

The current Ducklang grammar is not in \(G_{gpu}\). Its generated lexer has a
29-state guard DFA, 16 excluded words, and guarded token specifications for
contextual whitespace, statement terminators, arrow-parameter forms, and
disambiguated product delimiters. Removing those guards without changing the
language would alter token identity. Ducklang therefore uses Baba 7.10's
complete Wasm parser until its source grammar is redesigned around explicit,
state-free boundaries. A static test pins this rejection before adapter
acquisition; it is an explicit semantic limit, not a runtime fallback.

Blot is the first admitted GPU-syntax fixture. Its copied grammar uses
semicolon-terminated declarations, `end`-terminated variable regions, flat
operator chains, and a strict repeated root island. The generated plan proves a
guard-free 114-state lexer, 20 islands with 854 states and 5,866 transitions, a
repeated root island, at most one node and two edges per token, six candidates
per token, and 33 bounded contraction rounds. Accepted and rejected examples
pass the conformance relation above on the RTX 4080 SUPER.

For source size \(S\), token count \(T\), and compact output words \(R\), the
CPU oracle performs \(O(S+T+R)\) host work. Owned GPU ingestion performs
\(O(S)\) upload, bounded scan/transducer work parameterized by the proved plan,
\(O(R)\) readback, and host semantic recipes. It also pays device and plan
constants. Resident ingestion removes the \(O(R)\) host materialization, but it
does not prove success to the host. Its header is
`[status, tokenCount, nodeCount, edgeCount]`, followed by capacity-sized
four-word tokens, eight-word nodes, and four-word edges.

Five warm samples on the RTX 4080 SUPER measured the following medians. Runtime
creation was 233.72 ms and plan compilation 94.63 ms; both were amortized and
excluded from per-source rows.

|    source |  tokens | CPU oracle | owned GPU | resident submit | resident completion |
| --------: | ------: | ---------: | --------: | --------------: | ------------------: |
|     605 B |     293 |    0.51 ms |  12.92 ms |         1.74 ms |            12.81 ms |
|  10,550 B |   4,613 |    4.71 ms |  14.37 ms |         2.84 ms |            13.91 ms |
| 186,215 B |  73,733 |   51.30 ms |  18.60 ms |         3.76 ms |            14.81 ms |
| 797,000 B | 294,917 |  224.82 ms |  31.25 ms |         6.36 ms |            17.53 ms |

Owned GPU first wins in the measured set at 186,215 bytes (2.76 times faster)
and is 7.19 times faster at 797,000 bytes. Linear interpolation of the signed
CPU/GPU difference between 10,550 and 186,215 bytes estimates 50,610 bytes, but
that is an unverified hypothesis rather than a selection threshold. The only
validated crossover bracket is `(10,550, 186,215]` bytes for this grammar,
adapter, driver, and source distribution. Resident completion is reported only
as device completion; it excludes mapped diagnostics, symbols, types, and host
semantic recipes and is not a completed-parser speedup.

At this 2026-07-31 measurement boundary, keeping the next boundary resident
still required a lowering kernel that consumed the same buffer and queue. The
preservation obligation was equality with a CPU flat-syntax-to-HIR oracle plus
rejection of unknown rules, fields, and arities. Blot then lowered Baba's
pointer-like Wasm cursor on the CPU. The copied minimal program compiled through
the sibling Blot/gpufuck backend to a 2,105-byte Wasm module, and the 4,275-byte
tour compiled to 38,985 bytes, but neither result consumed resident flat syntax.
The later resident implementation and its remaining host Wasm-planning boundary
are specified below; these historical measurements are not current architecture
claims.

The final release gate checked 138 formatted files and 120 linted files,
type-checked every source, test, and benchmark entry point, and passed all 525
tests. Required-GPU differential compilation retained the six frozen artifact
sizes: Editor 24,460, Codex 226,134, grep 3,911, Tar 26,106, wav 2,520, and
raytracer 3,864 bytes. This is executable validation of the upgraded Duck
runtime and the new Blot syntax boundary, not a proof that Blot lowering is
resident.

### 2026-07-31: GPU-profile membership is language admission

Production syntax now admits a language plan \(P\) exactly when

\[ A(P) = \operatorname{version3}(P) \land \operatorname{guardFree}(P). \]

Version-3 generation already proves deterministic islands, bounded contraction,
and bounded output multiplicity. The explicit guard-free conjunct pins fixed
terminal identity at the runtime boundary rather than relying on an incidental
generator failure. Both general and strict throughput profiles satisfy the
semantic admission rule; strict is a performance proof about the repeated root,
not a stronger language-correctness proof.

`BabaGpuSyntaxSession.create` evaluates \(A(P)\) before acquiring an adapter. If
it holds, the session requires a non-fallback hardware device, compiles the
plan, and exposes only GPU owned ingestion and GPU resident submission. It
imports no CPU frontend and contains no fallback state. If it does not hold,
creation fails with the missing proof. In particular, the contextual Duck plan
is rejected before device work. This is executable validation of the admission
rule.

Baba's CPU frontend remains an independent oracle in tests and benchmarks. It is
not a production recovery path: an unavailable device, capacity failure, device
loss, or rejected plan is an explicit compilation failure. Removing the oracle
would weaken the evidence without reducing production work, so “no CPU” means no
CPU syntax execution in an admitted compilation, not no reference implementation
in the repository.

Admission inspection is \(O(|P|)\) host work once per compiled plan. For \(n\)
sources in one session, its amortized cost is \(O(|P|/n)\); adapter and pipeline
setup are likewise session constants. No source bytes are parsed on the host.
Owned ingestion still maps compact output and runs Baba semantic recipes on the
host, while resident ingestion keeps even that syntax boundary on-device. The
latter is the selected production target.

The existing Duck and Haskell entry points predate this rule and remain only as
a transitional integrated payload-lowering reference. They are outside the new
language-admission path and must not gain new fallback behavior. Blot now
reaches typed payload IR from resident syntax, but host code still materializes
that payload and plans Wasm before required GPU emission through a separately
acquired runtime. The old CPU-syntax entry points can be removed only after that
remaining planning and device-handoff boundary is closed. This sequencing
preserves an executable differential target while making deletion, rather than
compatibility, the terminal design.

### 2026-08-01: Segmented compiler work and flattening avoidance

The compiler-execution IR distinguishes payload values from the work that
produces them. For \(P\in\mathbb N\), a segmented work value is

\[ S=(P,c,o,V),\quad c\in\mathbb N^P,\quad o\in\mathbb N^{P+1},\quad o_0=0,\quad
o_{i+1}=o_i+c_i,\quad |V|=o_P. \]

The stable outputs of parent \(i\) occupy exactly \(V[o_i,o_{i+1})\). `classify`
computes immutable candidates and \(c\), an exclusive scan computes \(o\), and
`emit` writes those disjoint ranges. The equations are representation
invariants: they prove complete, non-overlapping ownership of \(V\) and
deterministic parent-major order without ordered atomics. This is the compiler
analogue of segmented-array flattening [26].

Flattening also has an effect condition. Write \(\Gamma\vdash J_i:R_i\ !\
\epsilon_i\) for a job, and let \(\epsilon_i\bowtie\epsilon_j\) mean that
executing the two effects in either order is observationally equivalent. A
family may be flattened only if every job is total over its bounded admitted
input, reads the same immutable snapshot, owns a disjoint output range, and
\(\epsilon_i\bowtie\epsilon_j\) for every \(i\ne j\). Expected failures are
ordinary result evidence combined by a deterministic source-order reduction;
they are not lane traps whose winner depends on scheduling. A linear resource in
a job's footprint must move to exactly one output; it may not be replicated.
Purity is the special case \(\epsilon_i=\varnothing\). A frontier iteration
publishes a new immutable snapshot before dependent work becomes eligible.
Syntax classification, immutable name queries, rewrite matching, and binary
sizing satisfy this judgment. Arbitrary handler execution, shared mutation, and
an ownership transfer without a unique destination do not. The judgment is a
specification claim, not a mechanized theorem; current executable evidence
covers disjoint ranges and deterministic equality, not general effect
commutativity.

The scan implementation is a global ping-pong Hillis--Steele reference. The
abstract primitive accepts \(P\) counts, but Blot supplies an allocated capacity
\(C\) because the exact declaration count remains on-device. Let \(n=C+1\) and
\(q=\lceil\log_2 n\rceil\). Initialization plus \(q\) scan rounds schedule

\[ q+1\text{ dispatches},\qquad 128(q+1)\left\lceil n/128\right\rceil\text{
invocations}. \]

The exact number of conditional additions is

\[ A(n)=\sum_{r=0}^{q-1}(n-2^r)=qn-(2^q-1)\le qn. \]

Two scratch arrays consume \(8n\) bytes. The count array consumes \(4C\) bytes.
If \(a\) is `minStorageBufferOffsetAlignment`, the dynamically indexed parameter
records consume \((q+1)\max(8,a)\) bytes. The implementation reports both
\(A(n)\) and the upper bound \(qn\), along with scheduled invocations and
temporary bytes. This is \(O(C\log C)\) work and \(O(\log C)\) dependent
dispatches; a hierarchical Blelloch scan has \(O(C)\) work and \(O(\log C)\)
span [17, 18]. Replacement is justified only if hardware measurements make scan
work material.

The shader primitive is a `u32` scan. Its arithmetic is natural-number prefix
addition only under the caller obligation \(\sum_i c_i\le2^{32}-1\); otherwise
WGSL addition wraps. The API rejects a count whose terminal offset cannot be
represented. Blot proves the stronger fact \(c_i\in\{0,1\}\), and the scan API
requires \(C+1\le2^{32}\), so \(\sum_i c_i\le C\le2^{32}-1\). This proof is part
of the instantiation, not a hidden property of Hillis--Steele.

Full flattening is not automatically profitable. A constant-count family does
satisfy

\[ (\forall i<P.\ c_i=k)\Longrightarrow o_i=ik, \]

but Blot is not such a family. Its admitted module is \(M=L_0\ldots L_{B-1}R\),
so over the allocated lanes

\[ c_i=\begin{cases}1&i<B\\0&B\le i<C,\end{cases}\qquad o_i=\min(i,B). \]

The return declaration and capacity padding contribute zero bindings. Thus a let
at declaration ordinal \(i<B\) has binding ID \(i\) directly. This
direct-ordinal theorem, rather than a false uniformity premise, proves the
scan-free fused strategy. The scan strategy is a differential reference for
binding-ID assignment; it is not yet a general variable-cardinality payload
emitter, because payload rows remain declaration-indexed and offsets are used
only as binding IDs. A future general segmented emitter must use \(o\) to place
all \(|V|\) rows and separately prove an output-capacity bound.

Let \(D_g\) be dispatch latency, \(M_s\) intermediate scan traffic, and \(T_d\)
divergence or retained scalar work. The relevant estimates are

\[ T_{scan}=T_{classify}+(q+1)D_g+M_s/BW+T_{emit},\qquad
T_{direct}=T_{classify}+T_{emit}+T_d. \]

The direct strategy is legal because its ordinal proof preserves binding
identity and because both shaders have only immutable reads and disjoint row
writes. It now compiles only its two shaders; selecting it no longer compiles
the segmented classifier, segmented emitter, or scan pipelines on the cold path.
Futhark's vectorization avoidance groups scalar “super-statements” to avoid
administrative kernels and global intermediates, while its “uniformity” means
shapes invariant to an enclosing map [25]. Our scan elision is analogous cost
avoidance, not the same uniformity analysis.

Name resolution is a predecessor query. For use \(u\) at declaration ordinal
\(p\),

\[ resolve(u)=\max\{j\mid j<p\land name(L_j)=name(u)\}. \]

The maximum is exactly immutable lexical shadowing: a binding's right-hand side
cannot see that binding, and a later equal name does not mutate an earlier one.
One lane per expression scans preceding lets backwards and compares UTF-16
source spans exactly. For \(B\) bindings, \(U\) identifier uses, and maximum
name length \(L\), this performs \(O(BUL)\) character work and has \(O(BL)\)
worst per-lane span. A sort/group/predecessor design reduces large-batch work
but adds hashing, radix sorting, grouping, and collision resolution. Hash-only
equality is forbidden because a collision would change binding semantics. The
benchmark's adversarial family performs exactly \(B(B+1)/2\)
predecessor-candidate checks before character short-circuiting.

The resident boundary consumes Baba's syntax buffer on the same device and queue
before releasing its lease. Baba 7.10 does not expose its source buffer, so the
implementation uploads UTF-16 code units again; this is an API limitation, not
parser work. The shortest let is eight code units and every valid module also
has a final return. If \(N_c\) is Baba's node capacity, then
\(C=\min(N_c,\max(1,\lfloor S/8\rfloor))\) is a conservative declaration
capacity for source length \(S\): every accepted declaration owns a node, and
the source-density bound holds independently. Excluding the already-resident
Baba buffer, the direct strategy requests

\[ 4S+48C+48C+32+48+(32+48C)=4S+144C+112\text{ bytes}, \]

covering duplicated source, candidates, payload, metadata, layout parameters,
and readback. The scan strategy adds \(4C+8(C+1)+(q+1)\max(8,a)\) bytes. Both
classification and emission schedule \(64\lceil C/64\rceil\) invocations,
although only the first \(D=B+1\) lanes do declaration work. WebGPU specifies
that every newly allocated buffer byte is zero [14]; the implementation relies
on this for unused counts and error cells. This is semantically defined but may
cause a backend clear, so it belongs in the cost model.

Capacity by source length has a counterexample: arbitrarily long skipped trivia
can increase \(S\), buffers, and scheduled lanes while leaving \(D\) unchanged.
At the measured 32/512/8,192/32,768-binding sources, \(C\) is respectively
75/1,318/23,276/99,625, so padding is already 42/805/15,083/66,856 declaration
lanes. Device-derived indirect dispatch can discard padded execution, but
exact-size allocation additionally needs a resident arena or a count readback;
neither is implemented. Only the compact typed payload and error evidence return
to the host. The owned decoder remains an independent differential oracle, never
a production fallback.

### 2026-07-31: First closed Blot payload fragment

The first integrated Blot payload is deliberately smaller than the admitted
syntax language. Its grammar is

\[ \begin{aligned} M &::= L^*\;\mathtt{return}\;E\mathtt{;} \\ L &::=
\mathtt{let}\;x\mathtt{=}E\mathtt{;} \\ E &::= n \mid x, \end{aligned} \]

where \(n\) is a decimal integer in \([0,2^{31}-1]\), and a variable use may
refer only to a preceding binding. Every expression has the sole payload type
`I64`. A module environment \(\Gamma\) maps a source name to its latest binding
identity. The rules are

\[ \frac{0 \le n < 2^{31}}{\Gamma \vdash n : \mathrm{I64}} \qquad
\frac{\Gamma(x)=b}{\Gamma \vdash x_b : \mathrm{I64}} \qquad \frac{\Gamma \vdash
E : \mathrm{I64}} {\Gamma \vdash \mathtt{let}\;x=E : \Gamma[x \mapsto
b_{fresh}]}. \]

Thus shadowing creates a fresh immutable binding and changes only the
environment's latest-name map. It does not mutate or alias an earlier binding.
The runtime representation may reuse storage after liveness proves an earlier
binding dead, but that optimization is not part of the source semantics.

The payload IR is a straight-line sequence of fresh binding IDs whose right hand
sides are either an `I64` constant or a reference to a lower binding ID,
followed by one result expression. Lowering assigns binding \(b_i\) to Wasm
local \(i\), emits the right-hand-side expression followed by `local.set i`,
then emits the result expression. The module exports `main : [] -> [i64]`.
Induction over the binding sequence proves the local environment after step
\(i\) agrees with the source environment for every live latest-name binding; the
result therefore preserves the fragment's evaluation.

The compact Baba boundary is accepted only if node 0 is `program`, every ordered
program child is `declaration`, and each declaration, pattern, and expression
has exactly one of the event shapes above. Token spellings are read from
GPU-produced token spans. Unknown rules, edge kinds, arities, declaration
orders, identifiers, literals, and out-of-range references fail with a source
span. GPU syntax acceptance is necessary but not sufficient for membership in
this payload fragment.

This boundary rejects several tempting but unsound shortcuts. Reusing the
existing Haskell Core would silently change Blot's `i64` integer ABI to `i32`.
The Baba 7.10 semantic validator currently rejects every unsigned decimal
magnitude above signed `I32` maximum before payload lowering, so the source
literal subset is narrower than its `I64` result type. Accepted literals are
widened exactly to `I64`; constructing larger values needs a future Baba
integer-domain parameter or an independently specified Blot primitive. Treating
`+`, `*`, or other surface operators as Wasm instructions would bypass Blot's
prelude-defined fixities and ordinary function meanings. Headers, imports,
applications, effects, patterns other than one identifier, and all other
declarations remain outside the fragment until their own typing and lowering
rules are specified.

For \(T\) compact tokens, \(N\) nodes, \(E_g\) edges, and \(B\) bindings, the
production implementation leaves all \(4T+8N+4E_g\) compact words resident. The
current capacity-bound dispatch schedules \(O(C)\) lanes; its active structural
work is \(O(B)\), literal and identifier inspection is linear in the admitted
atom characters, and exact predecessor selection performs at most \(O(B^2)\)
source-span comparisons. The direct-ordinal path emits one typed row per
declaration without a scan. It requires one GPU syntax submission and one GPU
Wasm submission; the payload readback exists because Wasm planning is still on
the host. Moving that plan to the same resident device is a later boundary and
is not implied by resident syntax lowering.

The implementation obligations are executable tests for literal evaluation,
prior-binding resolution, shadowing, unbound-use rejection, overflow rejection,
payload-shape rejection, deterministic Wasm, and CPU/GPU binary-emission
equality. Differential comparison with the sibling Blot compiler is valid only
inside this fragment and compares exported `i64` results, not binary identity.
The typing and preservation statements above are paper derivations; the tests
are executable validation, not mechanized proofs.

The resident implementation is integrated in `compileModuleSource`: a `.blot`
input implies required GPU syntax, GPU payload validation and name resolution,
and required GPU Wasm emission. CPU binary emission occurs only when
differential verification is explicitly requested through the API. The owned
compact decoder remains test-only. Focused tests cover the obligations above,
pin Baba's numeric compact schema, and compare both resident strategies with the
independent decoder. The 32-byte example `let answer = 42; return answer;` emits
a 43-byte Wasm module whose exported `main` returns `42n`. The sibling Blot
evaluator independently returns `{ kind: "signed-integer-64", value: 42n }` for
that source. This is empirical semantic agreement for one fragment witness, not
equivalence of the compilers. The last pre-resident release gate passed all 536
tests and retained the frozen Editor, Codex, grep, Tar, wav, and raytracer sizes
of 24,460, 226,134, 3,911, 26,106, 2,520, and 3,864 bytes. New release evidence
is recorded below after the resident change; these historical counts are not
silently presented as validation of the new kernels.

Before resident lowering, one cold CLI observation on the RTX 4080 SUPER
measured 531.08 ms for runtime creation, 375.90 ms for plan compilation, 134.70
ms for owned syntax, 2.73 ms for host compact-to-payload lowering and Wasm
planning, 317.93 ms for GPU Wasm emission through a separately acquired runtime,
and 3.90 ms for engine validation. These components total approximately 1.37
seconds; the reported frontend total of 1.14 seconds ends before binary
emission. This historical single profile is not a measurement of the resident
implementation. Reusing one runtime and compiled pipelines across syntax and
emission remains the next constant-cost target.

### 2026-08-01: Resident Blot implementation evidence

Production Blot compilation now calls Baba's resident ingestion, submits
classification and payload emission to the same device queue, and disposes the
resident lease only after typed-payload readback completes. The scan-free path
allocates no count or scan buffer. The reference path executes the
Hillis--Steele scan and uses its offsets as binding IDs. Both perform exact
source-span name comparison and choose the greatest preceding matching binding;
neither uses a host symbol table or a hash-only equality shortcut. Literal
parsing and the signed-I32 admission bound are also enforced in the GPU
classifier, because Baba resident ingestion intentionally does not execute host
semantic recipes. Independent primitive tests validate the generic scan on
counts \([0,3,1,0,2]\), which must produce offsets \([0,0,3,4,4,6]\), and on the
empty family, which must produce the sole offset \([0]\). A 257-count case
crosses two 128-lane workgroup boundaries and compares every offset with a
sequential natural-number prefix oracle.

The pinned compact schema test ties every numeric rule, terminal, and field ID
used by the shaders to an independently decoded Baba witness. The resident
differential test includes an astral character in skipped trivia, which
validates that uploaded source words preserve Baba's UTF-16 offsets rather than
JavaScript code-point iteration. The complete check formatted 143 files, linted
125 files, type-checked all entry points, and passed 543 tests. The benchmark's
adapter request selected llvmpipe and correctly refused to report it as hardware
performance; required-hardware tests likewise skip whenever their adapter
request selects a fallback.

A repository test now explicitly enables an available fallback adapter, which is
not reachable from production, and runs both payload strategies over the UTF-16
shadowing witness. Both agree with the owned compact oracle; the direct path
reports zero scan dispatches and the segmented path reports a nonzero count. No
llvmpipe wall time is retained as performance evidence.
`deno task benchmark:syntax 10` reports resident syntax completion,
direct-ordinal lowering, segmented lowering, exact and upper-bound scan work,
scheduled invocations, scan temporary bytes, payload readback bytes, and the
strategy ratio on the required hardware adapter. A separate 32/512/2,048-binding
family exposes \(B(B+1)/2\) predecessor candidates so the quadratic resolver
cannot hide behind literal-only inputs. An RTX result remains an unverified
empirical obligation rather than a fabricated threshold.

The reference audit retrieved the official WebGPU specification, Blelloch and
Sengupta scan sources, the ARRAY 2019 flattening paper, and the 2026 Futhark
engineering article successfully. It corrected the article's title and, more
importantly, stopped using Futhark's shape-uniformity term for Blot's nonuniform
binding counts. Source availability is reference hygiene; it does not prove this
implementation. The scan equations above are checked separately by executable
metric assertions.

### 2026-08-01: SIMD is separated into semantics, plans, and execution

The SIMD review rejected a single undifferentiated “vectorization” mechanism.
Wasm payload vectors have a fixed 128-bit semantic width, while WebGPU subgroups
have a device-selected execution width and WGSL vectors are shader values. The
selected model therefore keeps these representations disjoint, makes standard
Wasm lane semantics the strict payload default, and treats relaxed SIMD as an
explicit numerical policy rather than an optimization flag.

The review selected immutable legality/cost plans and straight-line SLP as the
first automatic transform. It deferred memory-loop vectorization because the
current managed-buffer Core has no typed byte-region operation from which to
derive complete vector bounds and disjoint ownership. It also deferred floating
reductions because source-order addition is not associative. These are semantic
boundaries, not missing opcode-table entries.

The current source audit found only explicit `F32x4` construction, splat, and
four arithmetic operations, plus Wasm emission and ABI rejection. No frozen
payload executes those operations and no scalar extraction primitive makes a
lane observable through the JavaScript host boundary. Accordingly the paper
records implementation structure but makes no runtime-correctness or performance
claim. Section 7.8 states the new theorem obligations, break-even equations,
failure cases, and dependency-ordered conformance work.

### 2026-08-01: strict `f32x4` execution and checked SLP are implemented

The implementation review replaced the former scalar-spelled `f32x4` with
explicit vector and mask Core kinds, extended the flat schema, completed the
strict SIMD primitive family, and made target and managed-ABI rejection
executable. Scalar extraction now observes explicit vector programs, so the
earlier “emission only” status above is historical evidence rather than the
current boundary.

The first automatic pass implements immutable `f32x4-slp-v1` plans. Candidate
discovery, exact canonical validation, profit ordering, conflict resolution,
single successor rebuild, and the empty identity law are separate operations.
The first draft accidentally used whole-function searches for operand types,
prior-vector searches for every source recipe, and a canonical-plan scan per
proposal. Those operations contradicted the paper's linear-work claim. The
retained implementation constructs type, use, result-tuple, and canonical-plan
indices once, and its generated tests exercise two independent accepted plans
inside one block.

The measured V8 results in Section 7.8 show real byte and large-fixture runtime
reductions, but also a two-chain runtime regression under a positive recipe
score. The paper therefore records the current cost as an uncalibrated
instruction-count guard. Typed regions, loop memory operations, reductions,
integer vector source operations, relaxed numerics, and compiler-execution
subgroups remain explicit future proof boundaries.

### 2026-08-01: branch likelihood remains erasable metadata

The Wasm review corrected the proposed “likely/unlikely opcode” model: branch
likelihood is a custom code-metadata payload attached to an existing `if` or
`br_if`. Section 7.9 derives semantic erasure, exact binary cost, condition
polarity, layout dependencies, and an engine-specific break-even inequality.

The thunk example also exposed a false static heuristic. For `D` demanded
memoizing thunks and `F` force entries, exactly `F - D` entries see resolved
values. Resolved is more likely than suspended only when `F > 2D`; linear
one-shot computations never need a resolved path, while compile-time-resolved
values should lose the branch entirely. Ducklang remains strict and has no
source thunk implementation. The current Wasm builder also emits generic custom
sections too late for this format, so the implementation adds a dedicated
pre-code section and non-emitting instruction anchors rather than changing the
meaning of generic custom sections. The first retained policy hints only the
successful arm of aggregate selection's final trapping bounds check. Six fresh
V8 benchmark processes improve in five cases and regress in one, preserving the
distinction between useful empirical evidence and a universal speedup claim.

### 2026-08-01: compiler jobs may reorder before source computations

The ordering review retained Ducklang's left-to-right call-by-value semantics.
The Core constructor, compile-time evaluator, and specializer all currently walk
block steps in source order. Resolved shadow bindings already have fresh symbol
IDs, which removes name ambiguity but does not itself commute their evaluation.
The algebraic effect analysis records unordered capability membership, while the
primitive catalog separately records coarse `pure`, `read`, `allocate`, and
`trap` labels. Integer division demonstrates that these are not a totality or
commutation proof: its descriptor is algebraically pure while its Wasm operation
can trap.

The retained design first parallelizes the compiler's pure work over an
immutable typed snapshot. Stable-symbol relocations allow a consumer fragment to
compile before its producer even when runtime value flow must remain ordered.
Source-ordinal count/scan/rebase/relocate assembly must reproduce sequential
flat Core exactly. The source audit and one-off six-target calculation are
recorded in Section 7.11. They are measurements of structural opportunity using
typed-node count as a proxy, not timings or implementation evidence.

Runtime let exchange, compiler-pass permutation, and concurrent source execution
were rejected as consequences of that compiler freedom. They require,
respectively, a pairwise observational commutation certificate, pass commutation
or common-normal-form evidence, and an explicit parallel effect and failure
calculus. No payload reorder or parallel fragment compiler is implemented by
this change. The first subsequent executable slice adds the validated
job-analysis boundary described in Section 7.11, profiles its cost, and leaves
the source-order Core constructor unchanged.

### 2026-08-02: benchmark evidence becomes an executable contract

A measurement audit found five protocol/model defects: the release gate still
required a GPU Core rewrite after production had proved the canonical rewrite
frontier empty; rebuild reports synthesized profiles from independent field
medians; the SIMD implementation did not implement its stated ordering; a peer
order label named a measurement that did not exist; and several four- or
fifteen-observation reports called their maximum-like order statistic “p95.”
These are failed evidence mechanisms, not compiler performance regressions.

The release contract now requires `coreRewrite = identity`, zero Core
candidate/dispatch/payload work, GPU Wasm emission, and differential GPU/CPU
byte equality. The benchmark algebra in Section 7.10 is implemented by shared
median, interpolation, observed-representative, tail-admission, and paired
difference/log-ratio primitives. Regression tests reject synthetic profiles,
reasonless diagnostic records, even-sample upper-median selection, and p95
claims below 20 observations. Frontend, rebuild, break-even, Wasm, SIMD, branch,
peer, and Blot harnesses record their raw observations and machine identities;
the GPU harnesses inspect every foreign driver compute process. The break-even
matrix balances both backend order and policy/batch traversal, hashes every
input and output, and rejects CPU/GPU byte disagreement before estimating a
crossover.

The raw-evidence boundary is `measurements/*.json`. The process recorder invokes
each supported task in sequential fresh Deno processes and stores the complete
per-process result; checked-in summaries must be derived from those records.
This supplies hierarchy and auditability, not statistical certainty. Remaining
limits are explicit: OS process enumeration cannot detect undisclosed hardware
work, NVIDIA inspection is currently the only implemented GPU load backend, 20
samples is a reporting threshold rather than an accuracy theorem, and no
bootstrap or random-effects confidence interval is implemented.

The first post-repair executions are retained as diagnostic records because
foreign compiler processes and GPU contexts were active. They are empirical
instrument checks, not admissible speedup claims. Six-target paired
GPU-minus-CPU medians were positive for every Duck target. The 54-module Blot
capacity profile attributed median 95.798 ms of 151.680 ms (63.2%) to HIR
preparation, 24.723 ms (16.3%) to Wasm planning, and 27.910 ms (18.4%) to GPU
emission. Packed compilation measured 150.646 ms versus 779.400 ms for singleton
submissions, while `minimal.blot` measured 17.596 ms through gpupaper versus
1.636 ms through gpufuck. The latter is a paired equal-source/ABI comparison;
the general peer record remains incomparable because it gives the three
compilers different boundaries. These diagnostics prioritize Blot HIR
preparation and Codex Wasm planning over a larger physical GPU batch. Exact
records are named in `PERFORMANCE.md` and retained under `measurements/`.

The next implementation keys deeply frozen Runtime HIR by Blot loaded-revision
identity and refreshes the dependency graph once per public batch. All 741 Blot
tests pass, including direct and transitive invalidation, and the 54-module
oracle retains 315 observations. A six-observation diagnostic measures 0.741 ms
for graph refresh and 0.132 ms for all 54 cache lookups; its 295,194-byte
logical JSON footprint is a lower bound on retained heap. The prior and current
records have different input hashes and both observed contention, so their
timing delta is not promoted to an admissible speedup claim. The current profile
moves the measured bottleneck to GPU emission and host Wasm planning.

The corrected 100/32 branch-hint harness also ran in six fresh processes. Five
paired runtime medians favored hints and one regressed by 0.005 ns/call;
construction was slower with hints in all six. Foreign runtime work makes this
record diagnostic, but its process-level reversal independently preserves the
counterexample to a universal engine speedup.

The cost-state tuple now includes the previously used but undefined upload term
`U_i`. `H_i` counts host memory traffic and `U_i` counts host-to-device traffic,
so an uploaded byte may contribute to both terms. This repairs the dimensional
definition without claiming the additive calibration model fits the current
adapter.

### 2026-08-02: Zero closes a controlled source-to-runtime comparison

Section 7.13 introduces Zero as the sole consumer example language and runtime
comparison fixture. The implemented path uses a 66,344-byte Baba plan and the
17,983-byte Baba parser engine, materializes a checked first-order expression
tree, lowers lexical values and the bounded repeat fold to validated Core, plans
Wasm, and emits the payload through the Rust compiler compiled to WebAssembly.
Seven conformance tests independently exercise shadowing, calls, conditional
joins, nonpositive and positive repeat counts, signed boundary inputs, exact
Rust/Wasm-versus-TypeScript plan bytes, and three semantic rejection classes.
The benchmark adds a further 70-probe differential check against both an
independent JavaScript recurrence and an optimized Rust-to-Wasm implementation
before timing either payload.

A 30-pair local execution with 100,000 iterations in each of eight calls per
sample is retained in `measurements/zero-runtime-diagnostic-2026-08-02.json` as
diagnostic observation, not admissible speedup evidence, because other Node
compiler-agent processes were active. Zero produced 299 bytes and Rust produced
371 bytes. The warm Zero source-to-Wasm median was 1.188 ms (p95 2.091 ms); a
fresh `rustc` process median was 41.340 ms (p95 47.059 ms). These compilation
boundaries are explicitly incomparable. Hot payload execution measured 4.045
ns/iteration for Zero and 1.497 ns/iteration for Rust, with a paired median
log-ratio of 2.702. This falsifies any current claim of Rust-equivalent
generated scalar-loop performance. The likely object of the next investigation
is the generic multi-block dispatch structure, but that attribution is an
unverified hypothesis until instruction-level and engine-profile evidence
separates it from local assignment, branch shape, and tiering. Zero's smaller
artifact and faster measured instantiation do not discharge that runtime gap.

### 2026-08-02: natural-loop structuring refutes the first bottleneck hypothesis

The first theory/implementation iteration recognizes only the certified
four-block natural loop in Section 7.13.4. It emits parallel edge assignments
inside nested Wasm `block`/`loop`/`if` regions and omits the dispatch local for
both structured diamonds and this loop. Reverse-arm and value-swap conformance
tests pass, as do the seven Zero tests.

`measurements/zero-natural-loop-diagnostic-2026-08-02.json` retains one 30-pair
contended process. The Zero artifact fell from 299 to 240 bytes, a 19.7%
reduction, while Rust remained 371 bytes. Zero measured 4.021 ns/iteration, Rust
1.479 ns/iteration, and the within-process paired log-ratio was 2.658. The
earlier Zero median was 4.045 ns/iteration in a different contended process, so
their 0.6% difference is not an admissible speedup. The large static
administrative-work removal without a corresponding observed runtime change
refutes the hypothesis that dispatch alone explains most of the 2.7-fold gap. A
non-inlined call and local-heavy callee are now the leading unverified
explanation.

### 2026-08-02: explicit exports correct the Zero comparison boundary

Section 7.13.5 now separates Zero's public roots from its internal function
table. The benchmark marks only `run` for export; `step` remains an ordinary
direct-call target. Two executable tests cover positive and negative boundary
cases. As predicted, the artifact shrank by exactly seven bytes, from 240 to 233
bytes, without deleting code or calls.

`measurements/zero-explicit-export-diagnostic-2026-08-02.json` records one
contended 30-pair process. It observed 3.856 ns/iteration for Zero, 1.467 for
Rust, and a paired ratio of 2.621. The apparent 4.1% Zero change from the prior
diagnostic exceeds the transformation's zero-work prediction, but the processes
were independently contended and therefore cannot establish a speedup or
regression. The result preserves the leading hypothesis: dynamic call and
callee-local overhead, not export metadata, explains the remaining static
difference and may explain part of the runtime gap.

### 2026-08-02: certified loop-call fusion closes most of the runtime gap

Section 7.13.6 derives and implements only small scalar diamonds called from a
certified natural-loop body. Fresh locals capture arguments once and alpha-rename
callee definitions; the surrounding loop remains structured. Ten Zero tests and
the public natural-loop test pass, including a fused conditional whose
unselected arm would trap and a zero-iteration case that must not enter the
callee. Backend cache identity now includes every eligible callee body.

`measurements/zero-loop-call-fusion-diagnostic-2026-08-02.json` retains one
contended 30-pair process. Zero measured 2.878 ns/iteration, Rust measured 1.463,
and the paired ratio was 1.940. The artifact grew from 233 to 334 bytes, or
43.3%, while remaining smaller than Rust's 371 bytes. Relative to the prior
independently contended process, Zero's median fell by 25.4%; this is diagnostic
evidence consistent with the call-boundary hypothesis, not an admissible
cross-process speedup claim. The static growth is predicted by retaining both
the original callee and its fused copy. Export-root reachability is therefore
the next derived transformation; local pressure and redundant scalar transfers
remain subsequent hypotheses.

The full Ducklang corpus supplies a counterexample to universal code growth.
With the same transform, editor shrank from 24,460 to 24,440 bytes, codex from
226,211 to 226,149, and tar from 26,106 to 26,104; grep remained 3,911 bytes.
The deterministic size sentinels were updated only after all executable corpus
semantics passed. These four observations show that local/control encoding can
offset duplication, but they do not identify runtime wins or a general size
law.

### 2026-08-02: residual reachability removes the fused callee

Section 7.13.7 now computes the least residual call/closure fixed point from
published exports before planning any module component. Function types, bodies,
imports, text literals, closure-table entries, FCG functions, and Wasm indices
all use the same source-ordered reachable set. The complete 642-test suite
passes, including recursive and indirect-call cases; the deterministic Ducklang
artifact sizes from the fusion iteration remain unchanged.

`measurements/zero-reachability-diagnostic-2026-08-02.json` retains one
contended 30-pair process. Removing the now-unreferenced `step` body and type cut
Zero from 334 to 222 bytes, a 33.5% reduction, and made it 40.2% smaller than the
371-byte Rust artifact. Zero measured 2.827 ns/iteration, Rust 1.469, and the
paired ratio was 1.918. The 1.8% Zero difference from the previous independent
diagnostic is consistent with the theorem's zero dynamic-work prediction and
does not establish a runtime change. The remaining performance question is now
inside the fused loop: local allocation and redundant value transfers, followed
by loop scheduling/unrolling, rather than module reachability.

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
    Journal on Computing 1(2), 1972. <https://doi.org/10.1137/0201010>
20. Mark Weiser. “Program Slicing.” ICSE 1981.
    <https://doi.org/10.1145/800078.802557>
21. Luc Maranget. “Compiling Pattern Matching to Good Decision Trees.” ML 2008.
    <https://moscova.inria.fr/~maranget/papers/ml05e-maranget.pdf>
22. Peter M. Fenwick. “A New Data Structure for Cumulative Frequency Tables.”
    Software: Practice and Experience 24(3), 1994.
    <https://onlinelibrary.wiley.com/doi/10.1002/spe.4380240306>
23. Massimo Pradella, Matteo Reghizzi, and Paola Panazza. “Parallel Parsing with
    Operator Precedence Grammars.” Compiler Construction 2014.
    <https://pradella.faculty.polimi.it/papers/cc2014.pdf>
24. Robin Voetter. “Pareas: A GPU-Accelerated Compiler.” MSc thesis, 2023.
    <https://futhark-lang.org/student-projects/robin-voetter-msc-thesis.pdf>
25. Troels Henriksen. “Full flattening of nested data parallelism.” 2026.
    <https://futhark-lang.org/blog/2026-07-31-full-flattening.html>
26. Troels Henriksen, Frederik Thorøe, Martin Elsman, and Cosmin Oancea.
    “Data-Parallel Flattening by Expansion.” ARRAY 2019.
    <https://futhark-lang.org/publications/array19.pdf>
27. WebAssembly Community Group. “WebAssembly Core Specification 3.0.” 2026.
    <https://webassembly.github.io/spec/core/>
28. W3C WebAssembly Working Group. “WebAssembly JavaScript Interface.” 2026.
    <https://webassembly.github.io/spec/js-api/>
29. Samuel Larsen and Saman Amarasinghe. “Exploiting Superword Level Parallelism
    with Multimedia Instruction Sets.” PLDI 2000.
    <https://groups.csail.mit.edu/cag/slp/SLP-PLDI-2000.pdf>
30. LLVM Project. “Vectorization Plan.”
    <https://llvm.org/docs/VectorizationPlan.html>
31. Samuel Williams, Andrew Waterman, and David Patterson. “Roofline: An
    Insightful Visual Performance Model for Multicore Architectures.”
    Communications of the ACM 52(4), 2009.
    <https://doi.org/10.1145/1498765.1498785>
32. WebAssembly Community Group. “Relaxed SIMD Proposal.”
    <https://github.com/WebAssembly/relaxed-simd>
33. WebAssembly Community Group. “WebAssembly Code Metadata: Branch Hints.”
    <https://webassembly.github.io/branch-hinting/metadata/code/binary.html>
34. Zena M. Ariola and Matthias Felleisen. “The Call-by-Need Lambda Calculus.”
    Journal of Functional Programming 7(3), 1997.
    <https://www.cambridge.org/core/services/aop-cambridge-core/content/view/F4FC3C34E9CAE3F4326503E254FCF6F2/S0956796897002724a.pdf/the-call-by-need-lambda-calculus.pdf>
35. WebAssembly Community Group. “WebAssembly Feature Status.”
    <https://webassembly.org/features/>
36. Guy E. Blelloch. “Programming Parallel Algorithms.” Communications of the
    ACM 39(3), 1996. <https://www.cs.cmu.edu/~scandal/cacm.html>
37. Elvira Albert, John P. Gallagher, Miguel Gómez-Zamalloa, and Germán Puebla.
    “Type-Based Homeomorphic Embedding and Its Applications to Online Partial
    Evaluation.” LOPSTR 2007. <https://doi.org/10.1007/978-3-540-78769-3_3>
38. Tomas Kalibera and Richard E. Jones. “Rigorous Benchmarking in Reasonable
    Time.” ISMM 2013. <https://doi.org/10.1145/2464157.2464160>
39. William W. Tait. “Intensional Interpretations of Functionals of Finite Type
    I.” Journal of Symbolic Logic 32(2), 1967. <https://doi.org/10.2307/2271658>
40. Eugenio Moggi. “Computational Lambda-Calculus and Monads.” LICS 1989.
    <https://www.lfcs.inf.ed.ac.uk/reports/88/ECS-LFCS-88-66/>
41. Colin S. Gordon. “Polymorphic Iterable Sequential Effect Systems.” ACM
    TOPLAS 41(3), 2019. <https://arxiv.org/abs/1808.02010>
42. Ross Tate. “A Flexible Semantic Framework for Effects.” 2013.
    <https://cseweb.ucsd.edu/~rtate/effectstr.pdf>
43. Arthur J. Bernstein. “Analysis of Programs for Parallel Processing.” IEEE
    Transactions on Electronic Computers EC-15(5), 1966.
    <https://doi.org/10.1109/PGEC.1966.264565>
44. Jeanne Ferrante, Karl J. Ottenstein, and Joe D. Warren. “The Program
    Dependence Graph and Its Use in Optimization.” ACM TOPLAS 9(3), 1987.
    <https://doi.org/10.1145/24039.24041>
45. LLVM Project. “LLVM Language Reference: Memory Effects and Speculatable” and
    “MLIR Side Effects and Speculation.”
    <https://llvm.org/docs/LangRef.html#function-attributes>
    <https://mlir.llvm.org/docs/Rationale/SideEffectsAndSpeculation/>
46. WebAssembly Community Group. “Component Model Canonical ABI.”
    <https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md>
47. Mads Tofte and Jean-Pierre Talpin. “Region-Based Memory Management.”
    Information and Computation 132(2), 1997.
    <https://doi.org/10.1006/inco.1996.2613>
48. Rust Project. “`core::arch::wasm32` SIMD intrinsics” and “WebAssembly target
    features.” 2026. <https://doc.rust-lang.org/core/arch/wasm32/index.html>
    <https://doc.rust-lang.org/stable/rustc/platform-support/wasm32-unknown-unknown.html>

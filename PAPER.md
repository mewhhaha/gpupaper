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
validates and transforms an effect-closed payload IR. This separation keeps
source control semantics on the CPU while preserving the bulk, deterministic
compiler transformations that are suitable for the GPU.

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
represented in a completed GPU package; it is zero on the CPU path. CPU workers
were not introduced because cloning the pointer-rich Core into `P` workers would
add `O(P × Core_bytes)` memory before any measured benefit.

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
may select a CPU fallback, and only under the `auto` policy. The queue,
error-scope, device-loss, buffer-mapping, and device-limit mechanisms used for
these transitions are defined by the WebGPU specification; the failure
classification itself is this compiler's policy. The public policies are:

| Policy     | GPU unavailable                         | GPU semantic failure |
| ---------- | --------------------------------------- | -------------------- |
| `off`      | GPU is not requested                    | not applicable       |
| `auto`     | execute the corresponding CPU stage     | fail compilation     |
| `required` | fail compilation with the device reason | fail compilation     |

Authority is stage-specific. Type equality and scalar comptime always retain a
CPU semantic oracle; a completed GPU result adds differential evidence. Core
input is CPU-validated, the GPU authoritatively selects rewrite proposals, and
the CPU validates and deterministically commits those proposals. Wasm bytes are
GPU-authoritative when GPU emission completes. The default additionally emits
CPU bytes and requires byte-for-byte equality; `gpuWasmVerification: "none"`
omits that oracle but still performs engine and managed-artifact validation.

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
submission batch sizes, validation records, proposal counts, Wasm atoms, and
output-buffer bytes expose the terms that the current implementation can
measure. Pipeline initialization and capacity/packing are currently combined
with their containing stage except where Core initialization is reported
separately; this is a stated instrumentation limit.

Comparative timing uses paired, counterbalanced observations: even samples run
CPU then GPU and odd samples run GPU then CPU for the same workload, batch size,
and scheduling policy. The sample count is even, so every CPU-first observation
has a GPU-first counterpart; even-sample medians average the two central
observations. This cancels a linear run-order trend within adjacent pairs. A
reported stage breakdown is one observed profile nearest the scalar median
total, not a vector of independently selected component medians. Thus
`accounted + unattributed = total` and all stage percentages refer to a possible
execution. Parser sub-stage reports select an observed parse by the same rule.
Medians and nearest-rank p95 values remain descriptive statistics; without
independent repetitions and uncertainty intervals they do not establish a
general speedup.

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

Structural validation establishes all of the following before a package is
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

Let `U(P)` be the multiset of `Uint32Array` columns and `S(P)` the string-byte
column. The exact payload storage occupied by the flat package, excluding
JavaScript object headers, is:

```text
B_flat(P) = |S(P)| + 4 Σa∈U(P) |a|
```

The three scalar header words are supplied separately. GPU stages upload only
the columns they consume and may add validation, proposal, metadata, uniform,
and readback buffers, so `B_flat` is a lower bound on a stage's device
allocation, not its allocation formula. Each stage calculates those additional
bytes explicitly and checks both individual binding limits and device buffer
limits before allocation.

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
Rebuild removes claimed operations, resolves replacement chains with cycle
detection, remaps every use, retains source order, and validates the complete
new snapshot. The original snapshot is immutable.

Executable evidence checks CPU/GPU proposal equality, immutable rebuild,
multi-step replacement, floating-point exclusion, and rejection of a
structurally valid but semantically false certificate. A general optimization
framework would require a preservation proof and certificate checker for every
additional rule.

### 7.4 Wasm count, scan, and write

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

For `A` atoms and maximum length level `D`, emission performs:

1. one full-array pass computing the encoded size of non-length atoms;
2. `D` full-array passes, in increasing level order, resolving length atoms;
3. an inclusive prefix sum of all resolved sizes;
4. one full-array pass writing each atom into its assigned byte interval.

The current prefix implementation is Hillis–Steele. For distances
`1, 2, 4, … < A`, round `r` computes:

```text
pᵣ[i] = pᵣ₋₁[i] + (i ≥ 2ʳ ? pᵣ₋₁[i - 2ʳ] : 0)
```

After round `r`, `pᵣ[i]` is the sum of the last at most `2ʳ⁺¹` input sizes
ending at `i`; induction yields the complete inclusive prefix after:

```text
R = ceil(log₂ A)
```

This is not the work-efficient Blelloch scan discussed by the historical design
paper. With workgroup width 64, the exact scheduled lane count for one plan is:

```text
L = 64 ceil(A / 64)
dispatches = 2 + D + R
scheduled_invocations = L(2 + D + R)
work = Θ(A(D + log A))
span = Θ(D + log A) dispatch rounds
```

Only length atoms at the active level do useful work during a length pass, so
the formula includes inactive lanes. The profile reports `A`, `D`, `R`, and the
scheduled invocation count. This makes a future hierarchical or level-compacted
implementation comparable without changing the semantic plan.

Each atom owns a disjoint byte interval from the prefix result. Adjacent atoms
may share a `u32` output word, so writers use `atomicOr` into a zeroed buffer.
Their shifted byte masks are disjoint; therefore the atomic operations commute
and the final word equals the source-ordered byte concatenation independently of
invocation order.

Before allocation, the CPU evaluates encoded widths without emitting bytes. For
non-length atoms, \(s_i\) is the exact LEB128 width of the atom value. Length
atoms are visited in dependency-level order:

```text
s_i = unsigned_width(Σ[j in range(i)] s_j)
B_exact = Σi s_i
B_output = 4 ceil(B_exact / 4)
```

The plan validator has already proved that every referenced dependency has a
lower level, so induction on levels makes every \(s_j\) available. This takes
\(O(A + \sum_i range_count_i)\) work and one byte of host memory per atom
because all admitted widths are at most 10. It is not CPU emission: no encoded
byte or offset is constructed. The GPU independently executes its size, length,
scan, and write passes, and the returned final prefix must equal
\(B_\text{exact}\).

An earlier uniform `10A` bound and then a per-kind `1/5/10` bound were safe by
case analysis but conservative. Exact host sizing removes their slack without a
device readback or an additional submission because the immutable atom DAG is
already a host payload. The scan still uses two `4A`-byte prefix buffers, and
the size column uses another `4A` bytes. Packed batches add device-required
alignment between job regions but do not change per-job atom semantics.

The default CPU differential independently evaluates the length DAG, encodes
LEB128 values, concatenates atoms, and compares every byte. Engine validation
then checks the selected module. With differential verification disabled, engine
validity does not prove semantic equality to the plan; that mode deliberately
trades away the independent byte oracle.

### 7.5 Type equality as certified congruence closure

The GPU type stage consumes first-order equality constraints over variables and
constructor terms. Let \(E_0\) be the source equalities. The required
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

A compressed parent forest alone is not a certificate of this judgment. It can
show that the reported relation is an equivalence, but cannot show minimality:
the forest that places every term in one class is compressed and satisfies all
input equalities while spuriously equating unconstrained terms. Therefore the
current stage independently computes the deterministic CPU closure, using the
lowest term ID as class representative, and requires exact agreement with the
GPU representatives, clash diagnostic, or minimum cyclic class. A mismatch is a
compiler error, never an `auto` fallback. The number of explicitly generated
child equations is a work metric rather than a semantic result: pairwise and
star-shaped constructor decomposition can prove the same partition with
different redundant equation sets.

For \(T\) flat terms, \(E\) source equalities, \(K\) distinct equalities added
by constructor injectivity, and \(F\) nonempty closure frontiers, the CPU oracle
uses \(O(T + E + K)\) memory and \(O(F(T + K) + (E + K)\alpha(T))\) work in the
current implementation, with the coarse bound \(F \leq K + 1\). The small GPU
path admits at most 64 terms, considers \(T^2\) constructor pairs per closure
frontier, and uses \(T\) transitive-closure dispatches of \(T^2\) lanes for the
occurs check. Larger graphs perform constructor closure and the quotient-cycle
check on the CPU, then differentially check the final union on the GPU.
Consequently this stage is validation evidence, not an end-to-end type-checking
speedup. Removing the CPU oracle would require a GPU-produced derivation forest
proving that every union follows from an input equality or equal-constructor
child position, plus independently checkable clash and acyclicity certificates.

The 64-term switch is a resource policy, not a measured break-even. For one
small-path constructor frontier, let \(C\) be maximum constructor arity, \(Q =
T^2\), and \(L = 64\lceil Q/64\rceil\). Pair counts and two scan columns use
\(12Q\) bytes; equality and parent output columns reserve
\(12\min(1{,}048{,}576, QC)\) bytes. Count, scan, and emit schedule:

```text
pair_passes = 2 + ceil(log₂ Q)
pair_invocations = L × pair_passes
```

At \(T=64\), \(Q=4{,}096\), so one frontier schedules 14 pair passes and 57,344
lanes. Since all child terms are included in \(T\), \(C \leq 63\), giving a
worst-case quadratic allocation below 3.2 MiB before linear metadata. These
bounds explain the conservative cutoff but do not show that 64 minimizes wall
time. A threshold change requires a counterbalanced sweep of neighboring graph
sizes and constructor shapes.

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
uses. The CPU evaluator checks both division traps before arithmetic. The GPU
kernel assigns explicit failure statuses before evaluating the corresponding
WGSL expression, so shader-language overflow behavior cannot silently define
source comptime behavior. Comparisons and Boolean results are canonicalized to
zero or one.

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

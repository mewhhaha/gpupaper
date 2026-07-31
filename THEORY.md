# Theoretical basis

> Historical design record. [PAPER.md](PAPER.md) is the authoritative current
> specification and implementation report. In particular, this file's
> implementation-audit claims about the deleted source lowerer and a selected
> direct tail path were falsified and superseded during the Effect-HIR
> migration.

## Status

- Last reviewed: 2026-07-30
- Implementation reviewed: `50423f5` plus the current working tree
- Review trigger: any change to effect typing, handlers, ownership, Core
  signatures, the host ABI, or the WebAssembly stack-switching proposal

This document records the model the compiler is intended to implement, the
invariants that make it sound, and the measurements behind representation
choices. It distinguishes implemented behavior from proposed behavior. A checked
task or passing corpus is evidence about examples; it is not a proof that the
language semantics are sound.

## Effect-system decision

Ducklang should have first-class effects at the source and semantic-IR levels.
It should not carry source handlers into the flat GPU package.

The selected model is:

1. fine-grain call-by-value, with separate value and computation judgments;
2. typed algebraic operations and open effect rows;
3. lexically scoped, generative effect capabilities;
4. deep handlers with control-flow linearity;
5. capability passing plus type-directed selective CPS before resource-aware
   SSA;
6. an effect-closed SSA Core in which residual host capabilities are explicit
   ordinary inputs.

This is a refinement of the current architecture, not an endorsement of the
current handler implementation.

Algebraic effects are a good fit for ordinary operations such as input, output,
state queries, failure, and yielding. They are not a claim that every behavior
is algebraic. Bracketing, local state scopes, concurrency scopes, and other
higher-order operations require a separately specified scoped-effect calculus.

## Terms

An **effect signature** gives names and types to operations:

```text
Σ = {
  read  : Unit -> Text
  write : Text -> Unit
}
```

An **effect capability** `κ : Σ` identifies one lexical instance of that
signature. An operation is selected by both capability and operation:
`κ.write(message)`. Two capabilities with the same signature are not the same
effect instance.

A **computation type** separates the returned value from the operations that may
be performed:

```text
A ! ε
```

`A` is the value type and `ε` is an effect row. A closed computation is pure
with respect to algebraic effects exactly when `ε = ∅`.

Purity here does not imply termination. Bounds traps, explicit panic,
allocation, and compiler-visible buffer reads have separate operational
classifications. Reading an immutable value or allocating an unobservable fresh
immutable value does not introduce an algebraic capability into the source
effect row.

A **handler** interprets operations of one capability. A **resumption** is the
delimited continuation from an operation performance to its handler.

## Static model

The intended judgments are:

```text
Γ ⊢ v : A
Γ ⊢ c : A ! ε
```

Values do not perform operations. Computations return values and may perform the
operations in their rows.

### Operation

For `op : P -> R` in signature `Σ`:

```text
Γ ⊢ κ : Σ        Γ ⊢ v : P
────────────────────────────────────
Γ ⊢ perform κ.op(v) : R ! {κ.op}
```

### Sequencing

```text
Γ ⊢ c1 : A ! ε1        Γ, x : A ⊢ c2 : B ! ε2
────────────────────────────────────────────────
Γ ⊢ let x <- c1 in c2 : B ! (ε1 ∪ ε2)
```

Rows are canonical sets of capability-operation identities with an optional tail
variable:

```text
ε ::= ∅ | {κ.op | ε} | ρ
```

Surface unions, intersections, and differences normalize into row constraints.
They are not implemented by unconstrained textual set subtraction. Lexical
capability identities prevent two same-named effect instances from being
accidentally merged.

### Functions

Effect rows are part of function types:

```text
A -> (B ! ε)
```

Higher-order application therefore preserves effects without relying on the
callee having a statically known source name. Row variables are generalized only
where the ordinary type variables are generalized and are instantiated at every
call.

### Handlers

Suppose computation `c` returns `A`, performs operations from capability `κ`,
and may forward row `ε`. A deep handler has:

- a return clause from `A` to answer type `B`;
- one clause for every handled operation;
- a resumption from the operation result to `B`;
- its own effect row `δ`.

The simplified rule is:

```text
Γ ⊢ c : A ! ({κ} ∪ ε)
Γ, x : A ⊢ h.return(x) : B ! δ
Γ, p : Pi, k : Ri ->q (B ! δ) ⊢ h.opi(p, k) : B ! δ
────────────────────────────────────────────────────────
Γ ⊢ handle κ with h in c : B ! (ε ∪ δ)
```

`q` is the control-flow multiplicity. Ducklang initially admits:

- `linear`: the resumption must be invoked exactly once;
- `affine`: the resumption may be invoked zero or one time.

Multi-shot resumptions are excluded. An affine resumption may be discarded only
when every captured owned value has a valid cleanup path. If the continuation
captures a non-discardable linear value, its multiplicity is linear. Ownership
checking therefore runs on effectful computation IR before handler elimination;
counting the textual uses of a parameter is not sufficient.

Handlers are lexical binders. An effect-polymorphic abstraction cannot capture
an operation merely because a same-named handler happens to be dynamically
nearby. This is the abstraction-safety property.

## Compilation model

```text
Duck source
  -> syntax
  -> typed Effect HIR                values versus computations, open rows
  -> handler and capability IR       perform, handle, typed resumptions
  -> capability passing/selective CPS
  -> monomorphic resource-aware SSA  no source handlers or open rows
  -> flat GPU package
  -> Wasm
```

Effect HIR is the last representation with source effect semantics.

Capability passing adds one implicit argument for each required lexical
capability. A residual host capability is supplied at `main` from the typed
module ABI. Statically known handlers may specialize away.

Tail-resumptive operations can lower to direct capability calls. General
one-shot resumptions require selective CPS over only the effectful region.
Capability and CPS lowering must emit ordinary functions, closures, block
parameters, and resource operations before the flat GPU boundary.

The GPU consumes an effect-closed package. It may use effect provenance as
immutable validation metadata, but it does not search for handlers, capture
continuations, solve effect rows, or decide source effect policy.

The portable backend continues to target baseline WebAssembly using the
compiler's lowering. Native WebAssembly stack switching may become an optional
backend after its proposal and engine availability are stable; it is not a
semantic dependency.

## Soundness obligations

The implementation is not complete until each obligation has an executable
reference rule and tests derived from it.

### Type-and-effect preservation

If `Γ ⊢ c : A ! ε` and `c -> c'`, then `Γ ⊢ c' : A ! ε'` for an effect row `ε'`
permitted by `ε`.

### Progress relative to effects

A closed well-typed computation is a returned value, can take a step, or
performs an operation named in its row. A closed computation typed with `∅`
cannot become stuck on an unhandled algebraic operation.

### Handler correctness

Handling `κ` removes exactly the operations belonging to `κ`, preserves every
forwarded effect, and adds the effects of the clauses. Resuming executes the
captured continuation; returning without resuming discards it subject to
control-flow linearity.

### Abstraction safety

Only the lexical capability selected at an operation can handle it.
Effect-polymorphic code cannot observe or capture an effect that its interface
does not name.

### Linear-resource integrity

No reduction or compiler transformation duplicates a linear value, discards a
non-discardable value, or resumes a continuation more often than its
control-flow multiplicity permits.

### Lowering simulation

Every Effect-HIR reduction is simulated by capability-passing/CPS Core, modulo
administrative steps. Handler specialization must be observationally equivalent
to the unspecialized reference evaluator.

### Boundary closure

After handler lowering:

```text
residual capabilities of main = ABI requirements
```

Every non-host capability must be discharged. Every ABI operation has an exact
parameter and result type. No later pass may introduce a semantic effect.

### Determinism

Canonical row ordering, capability IDs, specialization order, diagnostics, flat
IDs, and emitted Wasm bytes are independent of hash-map order and GPU
scheduling.

## Implementation audit

The selected model is now executable at both semantic boundaries:

- [`src/ducklang_effect_ir.ts`](src/ducklang_effect_ir.ts) implements return,
  sequencing, performances, deep handling, one-shot resumptions, generative
  capability identities, canonical rows, capability subtraction, and
  discardability checks;
- [`src/ducklang_effects.ts`](src/ducklang_effects.ts) infers canonical
  operation rows plus effect-parameter positions to a fixed point and
  instantiates them at higher-order calls;
- function type references retain latent rows, including callback row variables,
  and typed bindings carry their canonical latent row;
- [`src/ducklang_effect_lowering.ts`](src/ducklang_effect_lowering.ts) is the
  sole source handler lowering. A clause that does not resume discards the
  delimited continuation; a clause that resumes re-enters it;
- tail-resumptive handlers take a direct capability-passing path. This is the
  type-directed optimization described by Leijen: no continuation object is
  needed when the clause performs local work and resumes once in tail position;
- ownership checking runs while performances are still present. The effect
  lowerer then calculates lexical owners live across each performance and
  upgrades the continuation to linear when discarding it would lose an owner;
- [`src/ducklang_effect_boundary.ts`](src/ducklang_effect_boundary.ts) closes
  the final row from reachable typed Core host calls, rejects inferred
  requirements lost during lowering, and supplies exactly that row to ABI
  construction;
- Flat Core contains ordinary direct/indirect calls, resource operations, and
  typed `host.call`; it contains no source handler, resumption, open row, or
  handler search.

The counterexample that motivated the change is now a regression test:

```text
handle (
  let x <- perform get()
  return x + 2
) with {
  get(_, k) -> return 40
}
```

It returns `40`. Resuming with `40` returns `42`.

### Admitted limits

The effect calculus is deliberately one-shot. Multi-shot continuations,
asynchronous task effects, and scoped higher-order effects are not inferred or
silently simulated.

Source capture analysis is conservative. It uses lexical source identity and
resource-use evidence to reject discarding a continuation that may own a linear
value. The executable Effect IR additionally models discardable cleanup
directly. A future source feature that exposes user-defined destructors must
carry explicit cleanup evidence into Effect HIR rather than weakening this rule.

The ordinary reusable `Type` representation is effect-erased; effect rows live
in the Ducklang computation/function layer and are removed before monomorphic
Core. This is intentional phase separation, not an assertion that effects are
absent from source function types.

## Corpus measurements

Measurements were taken on 2026-07-30 by parsing every Duck source and compiling
the six frozen applications with the CPU backend.

### Source surface

| Corpus              | Files | Effect families | Operations | Performances | Annotated rows | Handlers |
| ------------------- | ----: | --------------: | ---------: | -----------: | -------------: | -------: |
| Contract corpus     |   121 |              24 |         28 |           29 |             12 |        3 |
| Frozen live sources |    35 |              32 |         73 |           31 |            161 |       23 |

The contract corpus excludes `examples/binned/live`; the live row counts are
separate and are not summed as one program.

### Compiled frozen applications

| Target    | Core functions | Core operations | Row memberships | Root capabilities | CPS regions | Handled performances | Live captures |
| --------- | -------------: | --------------: | --------------: | ----------------: | ----------: | -------------------: | ------------: |
| editor    |             74 |           1,268 |              10 |                 1 |           1 |                   32 |             0 |
| codex     |            493 |          16,412 |              11 |                 5 |           0 |                    0 |             0 |
| grep      |             12 |             166 |               2 |                 3 |           0 |                    0 |             0 |
| tar       |             12 |           1,576 |               0 |                 1 |           0 |                    0 |             0 |
| wav       |              6 |             130 |               0 |                 0 |           0 |                    0 |             0 |
| raytracer |             15 |             229 |               0 |                 0 |           0 |                    0 |             0 |
| **Total** |        **612** |      **19,781** |          **23** |            **10** |       **1** |               **32** |         **0** |

The editor's 32 handled performances are specialized tail resumptions inside one
handled region. They therefore add no live continuation environment. A separate
linearity conformance program records one live captured owner and proves that an
aborting clause is rejected.

### Representation calculation

Let:

- `S` be the number of canonical function signatures;
- `M` be the total number of effect-row memberships;
- `P` be the number of residual operation sites;
- `L_p` be the number of live machine words captured at performance `p`.

A structure-of-arrays row table needs starts and counts per signature plus one
operation ID per membership:

```text
row_table_bytes = 4S + 4S + 4M = 8S + 4M
```

Across the frozen applications, `S = 138` and `M = 23`:

```text
8(138) + 4(23) = 1,196 bytes
```

This metadata is negligible, but it belongs in Effect HIR rather than being
attached indiscriminately to every low-level operation.

The root ABI carries one operand per residual capability family. The measured
applications require 10 root capability operands:

```text
10 × 4-byte Wasm handle = 40 bytes of root operands
```

The 33 residual operation sites need two interned IDs if represented before
capability lowering:

```text
33 × (4-byte capability ID + 4-byte operation ID) = 264 bytes
```

Adding a separate four-byte effect tag to all 19,781 Core operations would cost:

```text
19,781 × 4 = 79,124 bytes
```

That is unnecessary. Operation kinds already distinguish capability calls after
lowering, and row metadata is sparse.

For general resumptions, the continuation-environment traffic is:

```text
capture_bytes = Σp align(header + machine_word_bytes × L_p)
```

`L_p` is recorded as `continuationCaptureCount`. It is zero for the frozen
applications because their only local handler is tail-resumptive. Consequently,
the selected lowering allocates zero continuation environments for the corpus.
The metric must be re-evaluated before choosing heap, stack-segment, or
defunctionalized layouts for a future workload with non-tail resumptions.

The compile-time work for row propagation over call graph `G = (F, C)` with
canonical sparse rows is bounded by:

```text
O(Σ(f,g)∈C (|row(f)| + |row(g)|))
```

Capability lowering is linear in effectful calls plus performances. Selective
CPS is linear in the transformed effectful slice, not the entire program. The
current corpus has only four effectful function bindings out of the measured
application set, so whole-program CPS would transform far more code than
necessary.

Because effects close before Flat Core, the chosen model adds no GPU handler
search, continuation allocation, or CPU–GPU synchronization.

## Alternatives

### Dynamic stack search

Rejected as the language model. It permits accidental handling across
abstraction boundaries and makes operation cost depend on dynamic handler depth.
It may remain an optional backend implementation only if it preserves lexical
capability identity.

### First-class handlers in flat SSA

Rejected for the current boundary. Continuations introduce non-local control,
answer types, and ownership-sensitive environments into every GPU pass. That
would move source policy past the semantic boundary without improving the
current corpus.

### Whole-program CPS

Semantically viable but rejected as the default lowering. It changes every
calling convention and obscures direct SSA control flow. Type-directed selective
CPS preserves direct code for effect-free functions.

### Monadic surface encoding

Sound when implemented correctly, but rejected as Ducklang's user model. It
would expose sequencing machinery and function coloring that direct-style
handlers are intended to hide. A free-monad evaluator remains useful as a small
reference semantics for differential tests.

### Lexical capabilities with selective CPS

Selected. It provides explicit evidence for operations, supports abstraction
safety, can erase statically known handlers, preserves ordinary pure functions,
and lowers to the existing closure/SSA machinery before GPU execution.

## Completed lowering order

The implementation follows this checked order:

1. executable reference calculus;
2. computation/function rows and higher-order row instantiation;
3. generative capability identities;
4. deep-handler lowering and one-shot control multiplicity;
5. ownership and live-capture analysis before effect elimination;
6. tail capability passing or selective continuation lowering;
7. residual-row closure against reachable typed host calls;
8. effect-closed monomorphic and Flat Core.

`host.call` is now a backend spelling for a call through an explicit root ABI
capability, not a source-semantic escape hatch. The next theory review is
required before admitting scoped effects, user-defined cleanup evidence,
multi-shot control, asynchronous task/poll effects, or a native Wasm
stack-switching backend.

## References

- Gordon Plotkin and Matija Pretnar, “Handlers of Algebraic Effects,” ESOP 2009:
  <https://www.pure.ed.ac.uk/ws/portalfiles/portal/17909848/Plotkin_Pretnar_2009_Handlers_of_Algebraic_Effects.pdf>
- Daan Leijen, “Koka: Programming with Row Polymorphic Effect Types,” 2014:
  <https://arxiv.org/abs/1406.2061>
- Daan Leijen, “Type Directed Compilation of Row-Typed Algebraic Effects,” POPL
  2017:
  <https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/algeff.pdf>
- Philipp Schuster, Jonathan Brachthäuser, and Klaus Ostermann, “Compiling
  Effect Handlers in Capability-Passing Style,” ICFP 2020:
  <https://ps.informatik.uni-tuebingen.de/publications/schuster20capability.pdf>
- Yizhou Zhang and Andrew C. Myers, “Abstraction-Safe Effect Handlers via
  Tunneling,” POPL 2019:
  <https://www.cs.cornell.edu/andru/papers/tunnel-eff/tunnel-eff.pdf>
- Ningning Xie and Daan Leijen, “Generalized Evidence Passing for Effect
  Handlers,” ICFP 2021: <https://xnning.github.io/papers/multip.pdf>
- Wenhao Tang, Daniel Hillerström, Sam Lindley, and J. Garrett Morris, “Soundly
  Handling Linearity,” POPL 2024:
  <https://www.research.ed.ac.uk/files/407801113/Soundly_Handling_TANG_DOA07112023_VOR_CC_BY.pdf>
- Roger Bosman, Birthe van den Berg, Wenhao Tang, and Tom Schrijvers, “A
  Calculus for Scoped Effects & Handlers,” LMCS 2024:
  <https://lmcs.episciences.org/14832/pdf>
- WebAssembly stack-switching proposal:
  <https://github.com/WebAssembly/stack-switching>

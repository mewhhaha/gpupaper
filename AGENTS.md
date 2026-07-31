# Repository instructions

## Theoretical basis

Build language semantics, compiler IRs, algorithms, and performance work from an
explicit theoretical basis. Do not introduce a mechanism only because it appears
to make the current examples work.

Before implementing a new semantic feature or compiler primitive:

1. State the model being implemented and define its terms.
2. Derive the representation and lowering rules from that model.
3. Record the invariants that every compiler stage must preserve.
4. Compare credible alternatives and identify counterexamples or failure modes.
5. Include a cost model with concrete calculations for work, memory,
   synchronization, and expected break-even points where performance motivates
   the design.
6. Cite primary research, specifications, or proofs for non-obvious claims.
7. Turn the invariants into validation, property, differential, or conformance
   tests before considering the work complete.

Keep [PAPER.md](PAPER.md) synchronized with the implementation continuously, not
as a cleanup step at the end of a task. It is the authoritative, self-contained
paper and specification for the project. Every semantic, representation,
lowering, validation, performance, or benchmark change must update the
corresponding definitions, derivations, invariants, calculations, implementation
status, evidence, limitations, and references in `PAPER.md` in the same diff.
Record failed approaches and counterexamples when they change the design. A
claim in `PAPER.md` must distinguish a proved property, an executable
validation, an empirical measurement, and an unverified hypothesis.

`THEORY.md` is retained only as historical design material. Do not add new
normative claims there; migrate any still-relevant claim into `PAPER.md` before
depending on it.

Prefer a smaller model with stated limits over an unsound generalization. If the
theory does not justify a requested behavior, stop at the semantic boundary and
report what proof, model, or design decision is missing.

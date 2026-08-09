# Derived managed indirection

Gpupaper does not need a distinct reference type or `ref.make` / `ref.load`
operations to represent frontend-private immutable indirection. Core already has
the required semantics through one-field products:

```text
indirect(τ)  := product(τ)
make(x)      := product.make(x)
load(r)      := product.project(r, 0)
```

This is a derived form, not an extension to the Core calculus. It is appropriate
when the frontend needs an immutable private box to close a recursive runtime
representation, for example a positive recursive algebraic value. It does not
model general references, identity-observable cells, or mutation.

## Why this fits Core

Core's semantic type identity is separate from physical layout identity. Product
and sum values are managed aggregates, while layout planning detects cycles in
the product/sum type graph. Every type participating in such a cycle receives an
opaque managed-handle layout. The target bytes are therefore not recursively
embedded in the handle itself.

For example, a frontend may lower a list representation as:

```text
List         = sum(Unit, Cons)
Cons         = product(I64, IndirectList)
IndirectList = product(List)
```

The graph `List -> Cons -> IndirectList -> List` is finite as a type table even
though it is recursive. `planCoreLayouts` assigns the recursive nodes the
managed-handle representation. Construction and projection continue to use the
ordinary product runtime operations, so Wasm lowering requires no new primitive
or runtime policy.

This preserves the backend boundary described in `PAPER.md`: the frontend chooses
source representation, while gpupaper validates and lowers the resulting closed,
monomorphic Core graph. Adding a dedicated immutable-reference operation would
encode a second semantic distinction with the same observable behavior and the
same managed representation.

## Boundary

This equivalence holds only for private immutable indirection whose identity is
not observable. A source language that exposes mutable references, pointer
identity, alias-sensitive operations, weak references, or a public reference ABI
needs a distinct semantic model rather than this derived form.

`tests/recursive_indirection.test.ts` is the executable regression for this
contract: it validates a recursive list-shaped Core graph, constructs and loads
a one-field product, and requires every recursive type in the cycle to receive a
four-byte managed-handle layout.

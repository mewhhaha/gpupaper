# Ducklang corpus compatibility

The Ducklang frontend follows the production grammar and semantic examples
vendored from the sibling `binned` repository. Baba owns syntax recognition; the
compiler then uses a Duck-specific AST, resolver, typed IR, effect analysis,
GPU-assisted equality checking, semantic SSA Core, flat Core, and a Wasm
backend. Duck source is never translated through the Haskell-like frontend.

The copied sources retain their MIT notice in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Their origin and snapshot
revision are recorded in [examples/binned/SOURCE.md](examples/binned/SOURCE.md).

## Enforced corpus contract

The generated Baba 6 Wasm parser accepts all 121 vendored `.duck` files. The
semantic contract then classifies every file exactly once:

- 94 success fixtures compile to Wasm and return every declared result;
- 13 intentional compile failures reject for their declared reason;
- 4 trap fixtures compile and trap for every declared runtime input;
- 1 inline source-test module discovers and executes its `@[test]` functions;
- 9 dependency modules compile through their success, failure, or managed host
  consumers.

The effect dependencies include three standalone managed programs and a
host-interface/logger/entry module graph. Their JavaScript runtime tests verify
dynamic Unicode `Text`, exact effect requirements, missing-method failures, and
capability narrowing across files.

## Frontend and typed-IR pipeline

```text
Baba cursor
  -> Duck AST
  -> includes, imports, attributes, derivations, handlers, and control flow
  -> module/name resolution
  -> Duck type and effect inference
  -> GPU differential equality solving
  -> compile-time and closure specialization
  -> immutable typed SSA Core
  -> validated flat Core
  -> authoritative GPU Core rewrite proposals
  -> structured and stackified Wasm plan
  -> GPU binary emission
  -> selected-artifact and managed-ABI validation
  -> optional managed JavaScript ABI
```

The CPU type engine remains the semantic oracle. It records constructor
equalities for the WebGPU solver, which independently detects constructor
clashes and infinite types. Effect rows are finite operation sets analyzed on
the CPU because their ordering, diagnostics, and module-capability provenance
are semantic control decisions rather than bulk equality closure.

Source spans survive every frontend stage. Module, parameter, and local names
receive stable symbols. Assignment, linear use, ownership escape, effect-row,
and aggregate-shape failures therefore report the original file offset and the
values that violated the invariant.

Every GPU buffer, binding span, pipeline shape, and dispatch is preflighted
against the selected adapter. Automatic mode falls back only for GPU
unavailability; required mode fails on the same condition. Invalid compiler IR,
CPU/GPU disagreement, and malformed output are hard failures. The default Wasm
policy compares CPU and GPU bytes, while production authoritative mode returns
the GPU-emitted bytes without first encoding them on the CPU.

## Implemented semantic families

| Family       | Corpus behavior                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scalars      | `I32`, `I64`, `F32`, `F64`, `F32x4`, booleans, exact literals, arithmetic, comparison, bitwise operations, conversion, and reinterpretation                 |
| Functions    | multiple arguments, recursion, mutual recursion, captures, returned and selected closures, and early return                                                 |
| Control flow | conditional chains, dynamic branches, ranges, collection loops, `break`, `continue`, and loop expressions                                                   |
| Aggregates   | tuples, arrays, structs, generic structs, updates, dynamic indexing, unions, matches, and type rows/sets                                                    |
| Text         | UTF-8 length, append, slicing, equality, byte indexing, dynamic host values, and bounds traps                                                               |
| Compile time | `const`, `comptime`, higher-order specialization, includes, attributes, type reflection, protocols, extensions, custom operators, and structural derivation |
| Modules      | open imports, namespace modules, parameter records, capability narrowing, exported functions, and missing-export diagnostics                                |
| Effects      | declarations, inferred and annotated latent rows, effectful `<-` sequencing, source handlers, ordered defaults, and host operations                         |
| Ownership    | linear consumption, borrow/freeze checks, scratch promotion, frozen mutation rejection, and host ownership contracts                                        |
| Testing      | ordered `@[test]` discovery plus trapping `assert` and `assert_false` intrinsics                                                                            |

## Managed host ABI

Dynamic `Text`, `Bytes`, aggregates, and host effects use a deliberately small
browser-compatible ABI. Wasm carries artifact-local `i32` handles; JavaScript
owns the managed tables, decodes host arguments, allocates handles for returned
values, and decodes the declared export. Static text handles are deterministic
and recorded in the compilation artifact.

The artifact also records:

- effect operation parameter and result types;
- `Init` field-to-effect capabilities;
- exact module and per-function operation requirements;
- source export names, value types, and aggregate layouts.

Host methods are synchronous. Missing fields, missing methods, invalid return
types, unknown text handles, and out-of-range `i32` results fail before Wasm can
silently coerce them.

## Deliberate boundaries

The compiler implements the complete vendored contract, not every legal program
in the grammar. The managed ABI exposes at most one source export through the
single Wasm `main` function, uses opaque handles instead of a linear-memory text
layout, and does not provide asynchronous host effects. The module elaborator
implements the record and function-export shapes exercised by the corpus rather
than a general separately compiled linker.

The semantic frontend, ownership/effect analysis, type oracle, and ABI policy
remain CPU responsibilities. GPU type solving is a standalone conformance
experiment rather than production compilation work; GPU scalar bytecode
evaluation is likewise confined to direct differential tests. Production
compile-time normalization retains an independent CPU scalar check against the
general constant evaluator. Flat-Core rewrite matching is GPU-authoritative, and
Wasm emission can be either GPU-authoritative or CPU-differential. This division
is intentional: the GPU executes bulk compiler transformations whose results are
consumed, while source-language policy is settled before flat Core.

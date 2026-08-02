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
equivalent Rust workload, and benchmark live under `examples/zero`. It is test
scaffolding, not a privileged source language.

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

## 11. Continuous implementation log

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

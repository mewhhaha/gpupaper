# gpupaper

Gpupaper is a compiler backend for language implementers. Give it a monomorphic,
typed high-level IR; it validates the IR, lowers it through functional Core and
Wasm planning stages, and emits deterministic WebAssembly.

```text
your source language
  -> your parser, resolver, type checker, effects, and specialization
  -> gpupaper typed SSA/CFG Core
  -> functional compiler graph
  -> structured Wasm + stackification
  -> deterministic binary plan
  -> TypeScript CPU | Rust/WebAssembly CPU | WebGPU
  -> .wasm
```

The source program never becomes a GPU kernel. WebGPU, when selected, executes
the compiler's count/scan/write work. The resulting payload is an ordinary Wasm
module.

Bundled and external frontends exercise the backend, but no source language
defines gpupaper's architecture or public target boundary.

## Install

```sh
deno add jsr:@mewhhaha/gpupaper@0.1.1
```

The default entrypoint contains Core, Core-to-Wasm lowering, TypeScript CPU
emission, and Rust/WebAssembly emission. Advanced contracts are explicit
subpaths:

```ts
import { emitWasmPlanOnGpu } from "@mewhhaha/gpupaper/gpu";
import { rewriteFlatCore } from "@mewhhaha/gpupaper/rewrite";
import { createRuntimeHeap } from "@mewhhaha/gpupaper/runtime";
import { WasmModuleBuilder } from "@mewhhaha/gpupaper/wasm";
```

The TypeScript emitter requires no runtime permissions. The checked-in
Rust/WebAssembly emitter is loaded from the package with Deno file access and
therefore requires `--allow-read` when selected. WebGPU entrypoints require a
WebGPU-capable host; Deno currently exposes them with `--unstable-webgpu`.

## What a frontend supplies

The public target is `CoreModule` in [`src/core.ts`](src/core.ts): a
language-independent, monomorphic typed SSA/CFG module.

A frontend supplies:

- a closed table of runtime types and function signatures;
- functions containing stable block and value IDs;
- block parameters and typed branch arguments instead of implicit phi nodes;
- SSA operations whose operands dominate their uses;
- explicit exports, host operations, ownership transitions, and source spans;
- all source-level type checking, effect checking, ownership proofs, name
  resolution, monomorphization, and compile-time evaluation needed by its
  language.

Gpupaper validates table indices, type closure, function and block identities,
single SSA definitions, dominance, branch signatures, return types, call
signatures, Store operations, SIMD shapes, resource operations, and the selected
Wasm target before producing a binary plan. Structural errors identify the
offending table, function, block, or value; lowering errors retain source spans.

## Minimal language target

This complete Core module exports a function returning `42`, lowers it without
materializing TypeScript bytes, and emits it through the checked-in
Rust/WebAssembly backend:

```ts
import type {
  CoreBlockId,
  CoreFunctionId,
  CoreModule,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
} from "@mewhhaha/gpupaper";
import {
  emitWasmPlanOnRustWasm,
  lowerCoreToWasm,
  validateCore,
} from "@mewhhaha/gpupaper";

const i32 = 0 as CoreTypeId;
const signature = 0 as CoreSignatureId;
const main = 0 as CoreFunctionId;
const entry = 0 as CoreBlockId;
const answer = 0 as CoreValueId;
const span = { file: "answer.example", start: 0, end: 9 };

const core: CoreModule = {
  schemaVersion: 1,
  file: span.file,
  types: [{ kind: "scalar", scalar: "i32" }],
  signatures: [{ parameters: [], result: i32 }],
  functions: [{
    id: main,
    name: "answer",
    sourceIdentity: undefined,
    signature,
    entryBlock: entry,
    blocks: [{
      id: entry,
      parameters: [],
      operations: [{
        kind: "constant",
        result: answer,
        type: i32,
        operands: [],
        value: 42,
        span,
      }],
      terminator: { kind: "return", values: [answer], span },
    }],
    span,
  }],
  entryFunction: main,
};

validateCore(core);
const lowered = lowerCoreToWasm(core, {
  emission: "planOnly",
  target: "wasm-scalar",
  exports: [{ name: "answer", functionId: main }],
});
const emitted = await emitWasmPlanOnRustWasm(lowered.wasmPlan);
const wasm = Uint8Array.from(emitted.bytes);

if (!WebAssembly.validate(wasm)) {
  throw new Error("gpupaper emitted invalid WebAssembly");
}
await Deno.writeFile("answer.wasm", wasm);
```

The same adapter pattern scales to a complete language: assign stable IDs while
lowering the frontend's typed representation, translate source control into
blocks and branch arguments, and choose an emission backend only after Core has
validated.

## Complete reference frontend

[`examples/zero/`](examples/zero/) contains Zero, the repository's controlled
example language. It demonstrates the complete integration without making its
source semantics part of gpupaper:

```text
Zero source
  -> Baba-generated Wasm parser
  -> cursor-to-Core frontend adapter
  -> validated Core and deterministic Wasm plan
  -> Rust compiled to WebAssembly plan emitter
  -> payload .wasm
```

Zero has one wrapping `i32` type, first-order functions, lexical bindings,
direct calls, conditionals, and a bounded fold. That is enough to exercise SSA
values, multi-function calls, CFG joins, loops, validation, and executable
output while keeping the source-to-Core mapping auditable.

```sh
deno task zero:grammar
deno test --allow-read tests/zero.test.ts
deno task benchmark:zero
```

The benchmark differentially checks Zero-generated Wasm against an equivalent
Rust-to-Wasm program before measuring their runtime. It reports compiler stages,
module construction, instantiation, output size, and paired hot-execution
samples separately.

## Mapping a language into Core

| Source-language concept     | Gpupaper representation                                       |
| --------------------------- | ------------------------------------------------------------- |
| Immutable binding or shadow | A new SSA `CoreValueId`                                       |
| Function                    | Typed signature, entry block, and block table                 |
| `if` or pattern decision    | `conditional_branch` and explicit join-block parameters       |
| Loop                        | A CFG back-edge carrying the next block arguments             |
| Early return or failure     | `return` or `trap` terminator                                 |
| Tuple or record             | `product.make`, projection, update, index, and selection      |
| Variant or enum             | `sum.make`, tag, and typed payload operations                 |
| Direct function call        | `call.direct`                                                 |
| First-class function        | `closure.make` and `call.indirect` with an explicit signature |
| Persistent collection       | `store.*` operations                                          |
| Proved unique update        | `store.write` or `store.grow` with `owned-reuse`              |
| Text or bytes               | Buffer types and canonical buffer/text primitives             |
| Host effect                 | `host.call` with explicit capability and operation names      |
| Ownership/lifetime evidence | Resource and region operations                                |
| Source diagnostic location  | A span on every operation and terminator                      |

Core is intentionally after source semantics. Gpupaper does not guess whether an
effect is allowed, whether an ownership transfer is legal, or which polymorphic
instance a call means. Those are frontend theorems. Core records their residual
runtime consequences and rejects structural contradictions.

## Implemented backend features

### Types and computation

- `i32`, `i64`, `f32`, `f64`, and `unit` scalar storage;
- explicit 128-bit vector and mask types, with the implemented `f32x4`
  arithmetic, comparison, lane, select, and shuffle family;
- products, sums, opaque text and byte buffers, persistent Stores, functions,
  closures, and typed indirect calls;
- constants, scalar arithmetic/comparison/bitwise/conversion primitives,
  aggregate construction and projection, direct recursion, mutual recursion, and
  trapping control;
- region entry/allocation/exit plus move, borrow, freeze, drop, seal, and unseal
  operations;
- synchronous typed host calls with explicit import module and operation names.

### Control and lowering

- typed block graphs with block parameters and validated back-edges;
- SSA dominance and exact edge-argument validation;
- immutable Core snapshots and deterministic functional-graph rewrites;
- closure environment construction and indirect-call tables;
- product, sum, Store, buffer, and resource layout lowering;
- structured Wasm regions, local assignment, stackification, and exact binary
  size planning;
- explicit source exports and arbitrary custom sections;
- `wasm-scalar` and `wasm-simd128` target validation.

### Emission and execution policy

- direct TypeScript CPU emission;
- a dependency-free Rust emitter compiled to WebAssembly, using `simd128` for
  validated preparation and supporting affine resident plans;
- WebGPU count/scan/write emission for one plan or stable multi-plan batches;
- resident GPU plan columns for repeated emission;
- byte-for-byte CPU/GPU differential verification;
- adapter-capacity checks before allocation, binding, or dispatch;
- deterministic plan validation, output ownership, device-loss handling, and
  resource-aware GPU fallback.

The high-level IR admits more semantic distinctions than every physical target.
For example, a scalar Wasm target rejects vector types, the JavaScript host ABI
rejects vector values crossing its boundary, and host effects are synchronous.
Gpupaper refuses such mismatches instead of silently changing the program.

## Choose an emitter

Lower Core once with `emission: "planOnly"`, then select the byte emitter for
the workload.

### TypeScript CPU

```ts
import { emitWasmPlanOnCpu } from "@mewhhaha/gpupaper";

const bytes = emitWasmPlanOnCpu(lowered.wasmPlan);
```

This is currently the fastest cold emitter for a single host-resident plan.

### Rust compiled to WebAssembly

```ts
import { createRustWasmEmitter } from "@mewhhaha/gpupaper";

const { emitter } = await createRustWasmEmitter();
const resident = emitter.prepare(lowered.wasmPlan);
try {
  const first = resident.emit().bytes;
  const second = resident.emit().bytes;
  await consume(first, second);
} finally {
  resident.release();
}
```

`emitter.emit(plan)` is the cold convenience path. A resident handle retains the
unique encoded bytes in Wasm linear memory, so repeated emission performs only
handle selection and an owned output copy. One emitter instance is sequential;
use independent instances for parallel CPU workers.

### WebGPU

```ts
import { emitWasmPlanOnGpu } from "@mewhhaha/gpupaper/gpu";

const result = await emitWasmPlanOnGpu(lowered.wasmPlan);
if (result.status === "unavailable") throw new Error(result.reason);
const bytes = result.bytes;
```

WebGPU has fixed adapter, submission, completion, and mapping costs. It is a
throughput backend for sufficiently large work, multiple independent modules, or
a future producer that already owns certified GPU-resident columns. It is
usually not the fastest way to emit one small host-resident plan.

For multiple plans, preserve their logical order and let gpupaper choose safe
physical groups:

```ts
import { emitWasmPlansOnGpu } from "@mewhhaha/gpupaper/gpu";

const result = await emitWasmPlansOnGpu(plans, {
  scheduling: "throughput",
});
if (result.status === "unavailable") throw new Error(result.reason);
await consumeAll(result.bytes);
```

For correctness-sensitive deployment, emit with an independent CPU backend and
compare every byte before accepting GPU output. The repository's release gate
does this across frozen and generated plans.

## Reuse and incremental compilation

The backend exposes reuse at distinct semantic boundaries:

- `createBackendFunctionCache()` reuses unchanged per-function backend analysis
  under an explicit environment identity;
- Rust resident plans reuse validated, encoded bytes;
- GPU resident plans reuse validated device columns while allocating fresh
  scratch and owned outputs per emission;
- `emitWasmPlansOnGpu()` packs independent logical plans into capacity-safe
  physical batches;
- a language frontend can cache its own immutable typed modules and final
  artifacts by semantic revision.

Cache the latest proven representation, not merely source text. A cache key must
include every target option observable in bytes, diagnostics, or profiling.
Returned typed arrays are caller-mutable, so a cache must retain private bytes
and publish defensive copies.

## Frontend and ABI responsibilities

Gpupaper deliberately does not impose one source language or one public runtime
ABI.

Your frontend owns:

- syntax, modules, names, type inference, effects, ownership, and compile-time
  execution;
- specialization to the monomorphic Core boundary;
- the meaning and legality of host capabilities;
- exported calling conventions, memory ownership, and post-return behavior;
- any metadata or custom section consumers require.

Gpupaper owns:

- validation of the submitted Core and selected physical target;
- deterministic Core-to-Wasm lowering and binary planning;
- backend selection, batching, residency, and differential byte checking;
- exact owned output bytes or an explicit refusal.

Direct scalar exports can be named with the `exports` option shown above.
Language-specific canonical ABIs can add wrappers and embed their manifest with
`customSections`.

## Integration pattern

A separate language repository targets gpupaper in four steps:

1. Parse, resolve, check, specialize, and prove source-language obligations in
   the frontend.
2. Assign stable type, signature, function, block, and value IDs while lowering
   the settled program into `CoreModule`.
3. Validate and lower Core into a Wasm plan.
4. Select an emitter, validate the resulting module and ABI metadata, then cache
   the owned artifact by semantic revision.

Keep frontend and backend caches separate. A frontend cache may reuse checked
semantic facts; the backend cache may reuse Core analysis, binary plans, or
final bytes. Neither cache may infer equality from a path alone when imports,
target options, effects, or ABI configuration can change the result.

## Requirements

- Deno 2 for the TypeScript API and repository tasks;
- a Wasm engine with fixed-width SIMD when selecting `wasm-simd128` or using the
  checked-in Rust emitter;
- WebGPU and Deno's `--unstable-webgpu` flag only when selecting a GPU backend;
- Rust's `wasm32-unknown-unknown` target only when rebuilding the checked-in
  Rust emitter.

Validate the source checkout before integration:

```sh
deno task check
deno task test
```

After changing the Rust source, rebuild and verify the checked-in module:

```sh
deno task rust-wasm:build
deno task rust-wasm:check
```

## Performance guidance

Performance claims require an exact boundary. Current diagnostics show:

- TypeScript direct emission is the best cold path for the frozen host-resident
  plans;
- cold Rust/WebAssembly pays serialization and independent validation;
- resident Rust/WebAssembly reduces repeated plan emission to handle selection
  plus the mandatory owned-output copy;
- current WebGPU emission pays roughly millisecond-scale fixed completion and
  mapping latency, so it needs larger or batched work to win;
- frontend, Core lowering, plan construction, emission, and output copying must
  be measured separately.

Run the retained harnesses rather than timing an unverified CLI wall clock:

```sh
deno task benchmark:branch-hints
deno task benchmark:zero
```

Benchmark records include repository and runtime identity, input/output hashes,
raw observations, order balancing, environment inspection, and explicit
`admissible` or `diagnostic` validity. The harness refuses competing compiler or
GPU work unless `--allow-contended` is requested, in which case it cannot
support a release speedup claim.

See [`PERFORMANCE.md`](PERFORMANCE.md) for current measurements and
[`measurements/`](measurements/) for the immutable raw ledger.

## Current limits

- Core is monomorphic and each function has one result.
- The package publishes source TypeScript and a generated module containing the
  checked Rust/WebAssembly emitter bytes; it does not publish a native binary or
  read an adjacent checkout at runtime.
- Host calls are synchronous and memory32-based.
- The managed JavaScript boundary cannot carry vector or mask values.
- `wasm-scalar` rejects all vector and mask types.
- Explicit `f32x4` is the implemented portable SIMD family; unsupported Core
  vector combinations are rejected.
- GPU acceleration begins after a host-resident Wasm plan unless a consumer
  explicitly uses the resident-column API.
- Gpupaper validates residual compiler IR; it does not prove a frontend's source
  type system, effect calculus, or ownership rules.

Prefer an explicit refusal at one of these boundaries over an unsound lowering.

## Design and implementation

[`PAPER.md`](PAPER.md) is the authoritative paper and specification. It states
the semantic models, lowering rules, invariants, cost calculations, empirical
evidence, failed alternatives, and primary references. Claims distinguish proved
properties, executable validation, measurements, and hypotheses.

Principal consumer-facing files:

- [`mod.ts`](mod.ts): default package entrypoint;
- [`src/core.ts`](src/core.ts): general typed Core schema and validator;
- [`src/core_wasm.ts`](src/core_wasm.ts): Core-to-FCG and Wasm plan lowering;
- [`src/wasm.ts`](src/wasm.ts): deterministic plan model and TypeScript emitter;
- [`src/rust_wasm_emitter.ts`](src/rust_wasm_emitter.ts): Rust/WebAssembly
  emitter and resident handles;
- [`src/gpu_wasm.ts`](src/gpu_wasm.ts): GPU emission, batching, capacity, and
  residency.

## Release preparation

The package is configured as `@mewhhaha/gpupaper` in `deno.json`. Before
publishing a new immutable version, update its SemVer version and run:

```sh
deno task check
deno task test
deno task publish:dry-run
```

The dry run checks the complete exported module graph, rejects slow public
types, and reports the exact package contents without uploading them.

For provenance-bearing releases, first create and link the package to
`mewhhaha/gpupaper` in JSR, then publish a GitHub release whose tag matches the
version in `deno.json`. The release workflow reruns every check and publishes
through GitHub's short-lived OIDC identity; it stores no registry token.

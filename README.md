# GPU-backed Ducklang-to-Wasm compiler

This repository contains an executable Ducklang compiler that accepts the frozen
Binned application corpus, constructs validated semantic and SSA IR, runs
bounded compiler passes through WebGPU, and emits an independently validated
WebAssembly module.

The production contract covers the six frozen applications—editor, Codex, grep,
tar, wav, and raytracer—and all 23 frontend preludes they consume. A second
compatibility contract covers the older 121-file Binned examples snapshot:

- 94 successful programs;
- 13 intended compile failures;
- 4 intended runtime traps;
- 1 source-test module;
- 9 dependency modules exercised through their consumers.

Production here is deliberately scoped. Every admitted source either produces
the same deterministic artifact under the documented CPU and GPU policies or
fails with source evidence. It is not a claim that every syntactically legal
Ducklang program is supported. See
[Ducklang corpus compatibility](duck-compatibility.md) for the exact semantic
contract.

The repository also retains the smaller Haskell-like Experiments A–F described
in
[GPU-Parallel Type Resolution and Compile-Time Execution](type-resolution-and-comptime.md).
Those experiments and Ducklang share GPU type solving, scalar compile-time
evaluation, and Wasm emission infrastructure, but Ducklang has its own frontend
and semantic pipeline.

## Run it

Deno 2 with WebGPU is required for GPU execution.

```sh
deno task check
deno task test
deno task release:gpu

deno task compile \
  examples/binned/live/case-studies/editor/editor.duck \
  editor.wasm \
  --require-gpu \
  --no-gpu-verification \
  --host-interface examples/binned/live/case-studies/editor/host.duck
```

The compiler has three GPU policies:

- default `auto` uses a GPU when available and falls back only when a GPU stage
  reports device unavailability, device loss, capacity exhaustion, or
  out-of-memory;
- `--require-gpu` makes the same condition a compilation failure;
- `--cpu` disables WebGPU.

GPU Wasm emission is CPU-differential by default. Pass `--no-gpu-verification`
to make the GPU-produced byte buffer authoritative and avoid CPU encoding unless
automatic mode needs a fallback. GPU Core rewrite matching is authoritative in
either GPU mode. Compilation output reports the backend that completed type
checking, compile-time evaluation, Core rewriting, Wasm emission, and
verification.

Useful project commands are:

```sh
deno task benchmark:frontend
deno task benchmark:break-even
deno task experiments
deno task run examples/all.hs
deno task run examples/duck/06_functions_and_blocks.duck
```

The release gate runs formatting, linting, type checking, all CPU/GPU tests,
malformed-input rejection, and two required-GPU differential compilations of
each frozen application. It checks exact Wasm sizes, backend selection, timing
budgets, and repeated byte identity.

Recorded RTX 4080 SUPER measurements, device limits, and the measured break-even
interval are in [Ducklang frontend performance](PERFORMANCE.md).

## Managed applications

Dynamic `Text`, aggregate values, and host effects use a browser-compatible
managed ABI. Wasm carries deterministic `i32` handles while JavaScript owns the
runtime tables. The compilation artifact declares exact effect operations,
capabilities, aggregate layouts, exports, and text literals; the selected Wasm
imports and metadata are checked against that declaration before the artifact is
returned.

```ts
import { compileModuleSource } from "./src/compiler.ts";
import { runDucklangManaged } from "./src/ducklang_runtime.ts";

const file = "examples/binned/live/case-studies/editor/editor.duck" as const;
const artifact = await compileModuleSource(
  file,
  await Deno.readTextFile(file),
  {
    gpuMode: "required",
    gpuWasmVerification: "none",
    hostInterface: "examples/binned/live/case-studies/editor/host.duck",
  },
);

await runDucklangManaged(artifact, {
  terminal: {
    load: () => new Uint8Array(),
    read: () => ({ case: "End", value: undefined }),
    write: (frame) => console.log(frame),
    save: () => ({ case: "Ok", value: undefined }),
    columns: () => 80,
    rows: () => 24,
  },
});
```

Host interfaces are ordinary declaration-only Duck modules. The runtime never
parses source to discover an artifact's ABI.

## Compiler pipeline

```text
Duck source
  -> generated Baba cursor and source AST
  -> canonical module graph and compile-time modules
  -> derivations, handlers, protocols, extensions, and static specialization
  -> scope resolution, ownership/effect analysis, and typed IR
  -> CPU type semantics + GPU equality verification
  -> compile-time normalization + GPU scalar verification
  -> closure conversion and structured control-flow lowering
  -> immutable typed SSA Core
  -> validated structure-of-arrays flat Core
  -> authoritative GPU snapshot/propose/resolve/rebuild rewrites
  -> structured Wasm regions, stackification, and binary plan
  -> GPU count/scan/write emission
  -> optional CPU byte differential
  -> engine, import, export, and managed-ABI validation
```

The compiler-execution and payload boundaries are separate. Ducklang source is
never converted into a GPU kernel. WGSL kernels transform flat compiler IR; the
resulting payload runs as WebAssembly.

Every GPU allocation, binding span, pipeline binding count, and dispatch is
checked against the selected device before use. Submitted readbacks race the
device-loss promise. A lost device invalidates the shared device and every
pipeline cache so a later automatic compilation can request a fresh device.
Invalid IR, CPU/GPU disagreement, and malformed GPU output are hard failures,
never fallback conditions.

## Implemented Ducklang semantics

The admitted compiler contract and focused tests cover:

- `I32`, `I64`, `F32`, `F64`, `F32x4`, boolean, bitwise, conversion, and
  reinterpretation primitives;
- lexical shadowing, recursion, mutual recursion, direct and first-class calls,
  captures, and closure environments;
- expression and statement branches, matches, early returns, unbounded loops,
  dynamic ranges, collection loops, valued `break`, and `continue`;
- tuples, arrays, structs, generic structs, functional updates, unions, dynamic
  indexing, lists, text, bytes, and UTF-8;
- `const`, `comptime`, type reflection, protocols, extensions, custom operators,
  structural derivation, and parameterized modules;
- linear ownership, shared borrows, freezing, scratch regions, explicit Core
  cleanup, source handlers, affine resumptions, and typed host effects.

Source bindings are immutable values. Rebinding creates a new symbol and Core
`ValueId`; the resolver enforces ownership transfers and borrows, while layout
identity remains independent of those source names. This semantics permits
lifetime-based physical reuse without exposing a shareable mutating reference.

The canonical grammar is [grammar/duck.baba](grammar/duck.baba).
`@mewhhaha/baba` 6.1.0 is pinned for deterministic parser generation and its
standalone Wasm runtime. Generated parser artifacts are checked in.

## Deliberate boundaries

- The managed ABI is synchronous and exports at most one source value through
  the single Wasm `main` function. Asynchronous effects remain reserved until
  there is a portable task/poll contract.
- Managed `Text`, `Bytes`, aggregates, and closures use opaque runtime handles.
  GPU kernels compile the payload; they do not execute its buffer operations.
- The semantic frontend, ownership/effect policy, type oracle, and host-ABI
  policy run on the CPU. GPU stages handle equality closure, scalar compile-time
  batches, flat-Core validation and rewrite matching, and Wasm binary emission.
- The separate Haskell-like frontend remains eager and rank-1. It is an
  experiment, not a GHC-compatible implementation.

Unsupported input is rejected at its semantic boundary rather than accepted with
altered behavior.

## Principal files

- `src/compiler.ts`, `src/cli.ts`: compiler policies, orchestration, and CLI.
- `src/ducklang_parser.ts`, `src/ducklang_ast.ts`: Baba cursor and source AST.
- `src/ducklang_module_graph.ts`, `src/ducklang_const.ts`: module graph and
  compile-time values.
- `src/ducklang_resolution.ts`, `src/ducklang_types.ts`,
  `src/ducklang_ownership.ts`: symbols, types, effects, and resources.
- `src/ducklang_core.ts`, `src/flat_ducklang_core.ts`: immutable SSA Core and
  its GPU-facing flat schema.
- `src/gpu_ducklang_core.ts`, `src/gpu_solver.ts`, `src/comptime.ts`,
  `src/gpu_wasm.ts`: bounded WebGPU stages.
- `src/ducklang_core_wasm.ts`, `src/wasm.ts`: Wasm structuring, stackification,
  planning, and CPU oracle.
- `src/artifact_validation.ts`, `src/ducklang_runtime.ts`: selected-artifact
  validation and managed runtime.
- `scripts/release_gpu.ts`: reproducible production release gate.

Baba is the only third-party dependency. It is pinned because grammar analysis
and parser generation are compiler infrastructure rather than replaceable glue.

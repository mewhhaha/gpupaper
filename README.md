# gpupaper

Gpupaper compiles admitted Ducklang programs and checked Blot Runtime HIR to
deterministic WebAssembly. Production WebGPU work is count/scan/write Wasm
emission. Canonical Core construction proves the production rewrite frontier
empty before scheduling; the standalone GPU Core matcher remains a differential
conformance tool. The source program does not become a GPU kernel, and Ducklang
parsing, semantic analysis, ownership, effects, and type checking currently
remain on the CPU.

This repository is currently consumed from a local checkout rather than as a
published package. Choose the integration that owns your source language:

| Input                        | Entry point                                    | Output                                               |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Ducklang source              | `deno task compile` or `compileModuleSource`   | Wasm plus a typed compilation artifact               |
| Managed Ducklang application | `compileModuleSource` and `runDucklangManaged` | Wasm hosted by explicit JavaScript capabilities      |
| Blot source                  | Blot's `build --target=gpupaper`               | Wasm plus a Blot ABI manifest                        |
| Haskell-like experiments     | `deno task experiments`                        | Research results, not a production language contract |

Do not pass `.blot` files to `compileModuleSource`. Blot owns parsing, checking,
staging, specialization, and ownership analysis; gpupaper accepts its validated
Runtime HIR.

## Requirements

- Deno 2.
- A WebGPU adapter and Deno's `--unstable-webgpu` support for either GPU mode.
- An adjacent `../blot` checkout when using the Blot target.

CPU compilation does not request a GPU. The repository tasks already supply the
required Deno permissions and WebGPU flag. If you invoke the TypeScript entry
points yourself, grant only the source read and artifact write permissions your
application needs.

Validate a checkout before integrating it:

```sh
deno task check
deno task test
```

On a machine intended to produce authoritative GPU artifacts, also run:

```sh
deno task release:gpu
```

The GPU release gate runs formatting, linting, type checking, CPU/GPU tests,
malformed-input rejection, and repeated differential compilations of the frozen
applications. It checks exact Wasm sizes, backend selection, timing budgets, and
byte identity.

## Compile Ducklang

Start with CPU compilation to establish that the program belongs to the
supported semantic contract:

```sh
deno task compile \
  examples/duck/06_functions_and_blocks.duck \
  example.wasm \
  --cpu
```

Omit the output path to write beside the source with a `.wasm` extension. The
compiler writes through a temporary file and refuses to overwrite the input. For
an unmanaged module with a scalar `main`, compile and execute in one step:

```sh
deno task run examples/duck/06_functions_and_blocks.duck --cpu
```

Select the checked-in Rust/WebAssembly CPU emitter when you want the compiler
itself to exercise that backend:

```sh
deno task compile \
  examples/duck/06_functions_and_blocks.duck \
  example.wasm \
  --cpu \
  --rust-wasm-emitter
```

This is a cold plan boundary for each compilation. It is useful for deployment
and differential coverage, but the current measurements favor the default
TypeScript emitter for one-off plans. Use the resident library API below when
the same plan is emitted repeatedly.

Use the GPU while retaining an independent CPU encoding comparison:

```sh
deno task compile \
  examples/duck/06_functions_and_blocks.duck \
  example.wasm \
  --require-gpu
```

After the exact workload has passed the GPU release gate, the lower-overhead
authoritative GPU path is:

```sh
deno task compile \
  examples/duck/06_functions_and_blocks.duck \
  example.wasm \
  --require-gpu \
  --no-gpu-verification
```

### GPU policy and verification

GPU selection and GPU output verification are separate decisions:

| CLI option              | Policy                                        | Intended use                                                                       |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| no option or `--cpu`    | Do not request WebGPU                         | Portable builds and semantic debugging                                             |
| `--try-gpu`             | Prefer WebGPU, with resource-related fallback | Applications where CPU output is acceptable when a device cannot complete the work |
| `--require-gpu`         | Fail unless GPU stages complete               | Benchmarking and deployments that require the GPU backend                          |
| `--rust-wasm-emitter`   | Use Rust/WebAssembly for required CPU bytes   | CPU output or the independent oracle in differential GPU mode                      |
| `--no-gpu-verification` | Trust GPU Wasm bytes without CPU re-encoding  | Latency-sensitive builds already covered by differential release testing           |

Without `--no-gpu-verification`, either GPU policy emits Wasm on both GPU and
CPU and requires byte-for-byte agreement. Optional mode falls back only for GPU
unavailability, device loss, capacity exhaustion, or out-of-memory. Invalid
source, invalid IR, CPU/GPU disagreement, and malformed output are compilation
failures under every policy.

The CLI reports the backend selected for each stage. `core=identity` means
canonical construction proved that the rewrite frontier was empty, so no Core
matching or GPU command was needed.

## Use the TypeScript API

`compileModuleSource` returns the Wasm bytes, validated managed ABI, selected
backends, and a detailed compilation profile. Reuse a compilation session for
edits made within one process:

```ts
import {
  compileModuleSource,
  createDucklangCompilationSession,
} from "./src/compiler.ts";

const session = createDucklangCompilationSession();
const file = "examples/duck/06_functions_and_blocks.duck" as const;
const artifact = await compileModuleSource(
  file,
  await Deno.readTextFile(file),
  {
    gpuMode: "required",
    gpuWasmVerification: "differential",
    session,
  },
);

await Deno.writeFile("example.wasm", artifact.wasm);
console.log(artifact.backends, artifact.profile);
```

The session retains immutable module, semantic, and per-function backend
artifacts. Exact-source and trailing-trivia edits can also reuse the lowered AST
and semantic fingerprint. Use `gpuScheduling: "throughput"` to allow a bounded 2
ms batching window when several compilations share a process. The default
`"latency"` policy flushes ready GPU work on the next scheduler turn. Set
`cpuWasmEmitter: "rust-wasm"` to use Rust/WebAssembly for CPU output or as the
independent encoder in GPU differential mode.

## Host managed Ducklang applications

Dynamic `Text`, aggregate values, and host effects use a managed ABI. Wasm
carries deterministic `i32` handles while JavaScript owns the runtime tables.
The artifact declares its exact effect operations, capabilities, aggregate
layouts, exports, and text literals; gpupaper checks the Wasm imports and
metadata against that declaration before returning it.

Pass a declaration-only host interface at compilation and provide the matching
capabilities when the program starts:

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

const exports = await runDucklangManaged(artifact, {
  terminal: {
    load: () => new Uint8Array(),
    read: () => ({ case: "End", value: undefined }),
    write: (frame) => console.log(frame),
    save: () => ({ case: "Ok", value: undefined }),
    columns: () => 80,
    rows: () => 24,
  },
});

console.log(exports);
```

The runtime uses the artifact ABI; it does not parse source to discover imports.
Host operations are synchronous. Async effects, multi-shot handlers, and scoped
higher-order effects are not silently approximated.

## Compile Blot

Run the target from the adjacent Blot checkout. Pass related inputs in one
command so Blot can reuse its loaded graph, Runtime HIR, and artifact cache:

```sh
cd ../blot
deno run \
  --allow-read \
  --allow-write \
  src/cli.ts build \
  --target=gpupaper \
  examples/minimal.blot \
  examples/arithmetic.blot
```

Each successful input produces `<name>.wasm` and `<name>.wasm.json`. The JSON
manifest describes the public Blot ABI; the same manifest is embedded in the
`blot:abi` custom section. Source failures remain local to their input. Once an
admitted miss batch reaches Rust/WebAssembly emission, a failure rejects every
miss rather than returning a partially trusted set of artifacts. Successful
outcomes identify `wasmEmitter` as `rust-wasm`.

Do not start one process per Blot file and do not manually split a small module
into synthetic chunks. Blot exposes independent checked modules; gpupaper emits
the stable cache-miss subsequence through one shared Rust/WebAssembly instance.
A resident Blot process refreshes the loaded graph once per requested batch and
reuses deeply frozen Runtime HIR for unchanged module revisions; rebuilding
through one process preserves that reuse without permitting callers to mutate a
later compilation. Successful artifacts are also revision-cached. Each outcome
reports `artifactSource` as `compiled` or `revision-cache`, and returned Wasm
and manifest arrays are defensive copies, so consumer mutation cannot corrupt
the cache.

Low-level consumers that emit the same validated Wasm plans repeatedly can
retain the device columns explicitly:

```ts
import {
  createGpuResidentWasmPlans,
  emitResidentWasmPlansOnGpu,
} from "./src/gpu_wasm.ts";

const creation = await createGpuResidentWasmPlans(plans);
if (creation.status === "unavailable") throw new Error(creation.reason);

try {
  const emission = await emitResidentWasmPlansOnGpu(creation.resident);
  if (emission.status === "unavailable") throw new Error(emission.reason);
  await consume(emission.bytes);
} finally {
  creation.resident.release();
}
```

Creation validates the host plans, constructs dense payload-relative columns,
uploads them once, and discards their host mirrors. Emission allocates fresh
scratch space and returns independently owned exact artifact arrays. The handle
is affine: release it exactly once; an emission already borrowing it may finish,
while later use fails. This compatibility API amortizes preparation but does not
make cold host-plan conversion GPU-native. Direct GPU production of the
certified columns remains a separate lowering boundary.

The same plan semantics also have a dependency-free Rust/WebAssembly CPU
backend:

```ts
import { createRustWasmEmitter } from "./src/rust_wasm_emitter.ts";

const { emitter, timings: initialization } = await createRustWasmEmitter();
const resident = emitter.prepare(plan);
try {
  const first = resident.emit();
  const second = resident.emit();
  await consume(first.bytes, second.bytes, initialization);
} finally {
  resident.release();
}
```

`emitter.emit(plan)` is the cold convenience path and includes serialization,
copying, Rust validation, emission, and release. A resident handle retains the
unique encoded bytes in WebAssembly linear memory, so repeated emission performs
only handle selection and an owned-output copy. The checked-in module uses
fixed-width WebAssembly `simd128` during preparation. Calls through one emitter
instance are sequential; create independent emitter instances for parallel CPU
jobs. Every returned byte array is owned by the caller.

The generated module is checked in for consumers. Rebuild it after changing the
Rust source:

```sh
deno task rust-wasm:build
```

## Operational considerations

- **Supported inputs are deliberate.** Gpupaper covers the frozen Ducklang
  application corpus and the validated Blot Runtime HIR contract; it is not a
  promise to compile every syntactically legal program. Unsupported input fails
  at the semantic boundary with source evidence.
- **A GPU is not automatically faster.** WebGPU adapter, pipeline, submission,
  and readback costs dominate small one-off modules. Reuse a process and
  session, batch independent Blot modules, and measure your own workload before
  choosing GPU compilation for latency.
- **Choose the CPU boundary deliberately.** TypeScript direct emission is the
  fastest cold path in current diagnostics. Rust/WebAssembly is the fastest
  retained-plan path, but its one-time plan ingestion must be amortized.
- **Differential mode does extra work by design.** It is the correctness mode,
  not the fastest GPU path. Use authoritative GPU emission only after the same
  device and corpus have passed `deno task release:gpu`.
- **Fallback is narrow.** `--try-gpu` handles a device that cannot perform an
  otherwise valid compilation. It never converts semantic or validation errors
  into CPU success.
- **The compiler is GPU-backed, not GPU-only.** Ducklang frontend semantics,
  canonical Core construction, Wasm planning, and ABI policy run on the CPU.
  Blot performs its own frontend work before the gpupaper boundary. Its current
  production target emits with Rust/WebAssembly and does not require a GPU.
- **Device capacity is checked before submission.** Buffer sizes, binding spans,
  pipeline binding counts, and dispatches are admitted against the selected
  adapter. Capacity grouping preserves input order.
- **Managed values require the matching host.** Dynamic values are opaque Wasm
  handles. Store the ABI with the Wasm artifact and instantiate it through the
  managed runtime or an implementation of the same contract.

The production Ducklang contract covers editor, Codex, grep, tar, wav, and
raytracer plus their 23 frontend preludes. The compatibility contract for the
older 121-file Binned snapshot contains 94 successful programs, 13 intended
compile failures, 4 intended runtime traps, 1 source-test module, and 9
dependency modules exercised through consumers. See
[Ducklang corpus compatibility](duck-compatibility.md) for the exact contract
and [Ducklang frontend performance](PERFORMANCE.md) for recorded RTX 4080 SUPER
measurements and measured break-even intervals.

Language semantics and compiler representations are governed by
[the paper and specification](PAPER.md). It distinguishes proved properties,
executable validation, empirical measurements, and unverified hypotheses.

## Compiler pipeline

The following is the currently implemented pipeline. Typed effect rows and the
executable Effect HIR semantics govern capability/selective-continuation
lowering before SSA; see [the paper and specification](PAPER.md).

```text
Duck source
  -> generated Baba cursor and source AST
  -> canonical module graph and compile-time modules
  -> derivations, handlers, protocols, extensions, and static specialization
  -> scope resolution, ownership/effect analysis, and typed IR
  -> CPU type semantics
  -> compile-time normalization + independent CPU scalar verification
  -> closure conversion and structured control-flow lowering
  -> immutable typed SSA Core
  -> validated structure-of-arrays flat Core
  -> construction-certified empty Core rewrite frontier
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
pipeline cache so a later optional or required compilation can request a fresh
device. Invalid IR, CPU/GPU disagreement, and malformed GPU output are hard
failures, never fallback conditions.

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
  cleanup, canonical open effect rows, deep one-shot handlers, row-polymorphic
  callbacks, and typed synchronous host capabilities.

Source bindings are immutable values. Rebinding creates a new symbol and Core
`ValueId`; the resolver enforces ownership transfers and borrows, while layout
identity remains independent of those source names. This semantics permits
lifetime-based physical reuse without exposing a shareable mutating reference.

The canonical grammar is [grammar/duck.baba](grammar/duck.baba).
`@mewhhaha/baba` 7.10.0 is pinned for deterministic parser generation and its
standalone Wasm runtime. Generated parser artifacts are checked in.

Duck's contextual token guards are outside Baba's strict GPU grammar profile, so
Duck is not admitted by the GPU-only language path. Its existing complete Wasm
parser is a transitional payload-lowering reference, not a fallback. Blot owns
its Baba frontend, checking, staging, specialization, and ownership analysis;
gpupaper no longer carries a copied Blot grammar or reconstructs source
semantics. The boundary is validated typed Runtime HIR. A multi-path Blot build
emits its stable cache-miss subsequence through the shared Rust/WebAssembly
emitter and keeps the resulting owned artifacts in the revision cache. The GPU
batch API remains available for research measurements but is not the production
Blot target. Run `deno task blot:verify` for semantic agreement,
`deno task benchmark:blot-targets` for singleton and plan-level GPU comparison,
and `deno task benchmark:blot-batch` for artifact-cache and experimental GPU
batch profiles.

## Benchmarking

Benchmark results are admissible only when the harness fixes and hashes the
input and output, names the measured boundary, balances order, retains every raw
observation, records repository/runtime/adapter identity, and sees no competing
compiler or GPU work before or after the run. The harnesses refuse otherwise.
`--allow-contended` is useful for exploration but marks the result diagnostic.

```sh
deno task benchmark:frontend
deno task benchmark:wasm
deno task benchmark:blot-targets
deno task benchmark:blot-batch
deno task benchmark:blot-crossover
```

The Blot batch benchmark reports two distinct measurements. `incrementalRebuild`
uses the public artifact cache; `compilerThroughput` calls the Runtime-HIR
target directly and cannot hit it. The warmup records every non-admitted corpus
file and its exact failure instead of silently treating a partial corpus as
complete.

`benchmark:blot-crossover` does not depend on Blot's moving source corpus. It
compiles byte-checked synthetic Runtime HIR while varying code size and module
count independently, and reports both plan-to-byte emission and the complete
validated-HIR target. Use it to decide whether a workload is large enough for
GPU emission; packed GPU throughput relative to singleton GPU submissions is not
evidence that the GPU beats direct CPU emission.

Use fresh-process recording for evidence intended for the paper:

```sh
deno task benchmark:record \
  --task=benchmark:branch-hints \
  --processes=6 \
  --output=measurements/branch-hints-YYYY-MM-DD.json
```

The JSON retains the process hierarchy, raw paired differences and log-ratios,
environment inspection, and exact revisions. Fewer than 20 observations report
an insufficient tail estimate instead of calling the largest observation p95.
See [the measurement ledger](measurements/README.md) and
[performance history](PERFORMANCE.md).

## Deliberate boundaries

- The managed ABI is synchronous and exports at most one source value through
  the single Wasm `main` function. Asynchronous effects remain reserved until
  there is a portable task/poll contract.
- Multi-shot handlers, scoped higher-order effects, and user-defined cleanup
  evidence require extensions to the calculus in
  [the paper and specification](PAPER.md); they are not approximated by the
  one-shot algebraic effect implementation.
- Managed `Text`, `Bytes`, aggregates, and closures use opaque runtime handles.
  GPU kernels compile the payload; they do not execute its buffer operations.
- Duck's semantic frontend, ownership/effect policy, type oracle, canonical Core
  construction, and host-ABI policy run on the CPU. Blot owns its separate
  source semantics and hands gpupaper validated Runtime HIR. The Blot target's
  production Wasm emission is Rust/WebAssembly. Packed GPU emission, Core
  rewriting, type equality, and scalar bytecode remain direct GPU conformance
  experiments outside ordinary Blot compilation.
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
- `src/ducklang_effect_ir.ts`, `src/ducklang_effects.ts`,
  `src/ducklang_effect_cps.ts`, `src/ducklang_effect_boundary.ts`: reference
  semantics, row inference, selective lowering, and ABI closure.
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

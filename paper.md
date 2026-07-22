# GPU-Hosted Compilation to WebAssembly

*A data-parallel intermediate language and a WebGPU implementation path, with Haskell as the stress test*

**Status:** research and engineering proposal, not an empirical results paper

**Date:** 22 July 2026

**Companion:** [GPU-Parallel Type Resolution and Compile-Time Execution](type-resolution-and-comptime.md)

**Implementation:** [Executable Experiments A–F](README.md)

## Abstract

This paper asks whether a compiler backend can run substantially on a GPU, through WebGPU, and emit a WebAssembly module that a JavaScript host then validates and instantiates. The proposal is deliberately narrower than “run an ordinary compiler in a shader.” A language-specific frontend first translates a source program into a typed, flat, pointer-free intermediate representation. WebGPU compute pipelines perform bulk validation, graph and tree transformations, closure layout, control-flow lowering, index assignment, and binary emission. The final compute pass produces packed WebAssembly bytes in a storage buffer; JavaScript copies those bytes through a readback buffer and calls the standard `WebAssembly` API.

The central design is **Flat Compilation Graph (FCG)**, a first-order, administrative-normal-form intermediate language stored as columns of integers. FCG has explicit functions, closures, thunks, algebraic constructors, basic blocks, effects, and heap operations. Its semantic language is intentionally small, while its physical form makes compiler passes expressible with five bulk operations: elementwise transform, associative scan, gather, conflict-controlled scatter, and bounded convergence. Filtering, allocation, grouping, radix sorting, joins, and variable-length output are derived rather than primitive.

Haskell is the stress test because non-strict evaluation makes evaluation state, updateable thunks, closures, and runtime services unavoidable. A practical Haskell frontend should therefore branch from an STG-like representation rather than attempt to rediscover laziness from source syntax. The first artifact should implement a pure, single-threaded Haskell subset and a small linear-memory runtime; full GHC compatibility is explicitly not an initial goal.

The design is feasible under present WebGPU and WebAssembly APIs, but a speedup is not established. GPU dispatch, multi-pass synchronization, transfer, and browser WebAssembly compilation impose fixed costs. The defensible hypothesis is that GPU hosting benefits large modules, whole-program optimization, and batches of modules; small interactive compilations will probably remain faster on the CPU. The paper ends with falsifiable hypotheses, a staged implementation plan, and proof obligations.

## 1. What “compilation on the GPU to Wasm” means

The phrase can describe three different systems:

1. a CPU compiler that emits GPU shaders;
2. a compiler that emits WebAssembly which later uses a GPU; or
3. a compiler whose own passes execute on a GPU and whose output is WebAssembly.

This paper studies the third.

The intended pipeline is:

```text
Haskell / another source language
        │
        │ language-specific frontend
        ▼
typed Flat Compilation Graph
        │
        │ upload once
        ▼
WebGPU validation and transformation passes
        │
        │ size → scan → encode → pack
        ▼
GPU buffer containing a .wasm binary
        │
        │ copy to MAP_READ staging buffer
        ▼
Uint8Array in JavaScript
        │
        ├── WebAssembly.validate(bytes)
        └── WebAssembly.compile/instantiate(bytes, imports)
```

The JavaScript boundary is required. WGSL code can write storage buffers, but it cannot call JavaScript, instantiate Wasm, create a new shader module, or recursively launch an unbounded sequence of new kernels. Shader source is supplied when JavaScript creates a `GPUShaderModule`, and executable entry points are selected when it creates a pipeline [1]. The WebGPU queue and `GPUBuffer.mapAsync()` provide the submission and readback boundary [2]. The WebAssembly JavaScript interface accepts a `BufferSource`, copies stable bytes, decodes and validates them, and compiles asynchronously [3].

This is consequently a **GPU-hosted backend with a JavaScript control plane**, not a fully autonomous compiler device.

### 1.1 Scope

The proposed first system includes:

- a documented binary frontend contract;
- WebGPU passes from that contract to core Wasm;
- deterministic diagnostics with source locations;
- an eager functional-language frontend used to bring the system up;
- an STG-like Haskell frontend for a pure, single-threaded subset;
- a small Wasm runtime for closures, thunks, algebraic values, allocation, and collection; and
- browser and Deno hosts using the same WebGPU-facing JavaScript.

It does not initially include:

- parsing arbitrary source languages on the GPU;
- a complete GHC replacement;
- Template Haskell, plugins, the complete Haskell FFI, asynchronous exceptions, weak pointers, or a threaded runtime;
- source-level optimization competitive with mature GHC;
- direct GPU-to-Wasm instantiation without a readback; or
- a claim that every program size compiles faster on a GPU.

Parsing can later become another data-parallel stage. It is not necessary to test the more fundamental proposition: whether a portable compiler middle and backend can be organized as bulk GPU transformations.

## 2. Evidence and constraints

### 2.1 There is direct precedent for a GPU-hosted compiler

Hsu’s dissertation, *A Data Parallel Compiler Hosted on the GPU*, presents a complete compiler for a lexically scoped functional commercial language as data-parallel tree transformations. Its central result is architectural: compiler trees can be flattened and manipulated without recursive pointer chasing, and the same data-parallel formulation can run on CPUs and GPUs [4]. It is the closest prior work to this proposal.

The proposal does not inherit Hsu’s performance conclusions unchanged. WebGPU has different dispatch, shader, memory, and host-transfer constraints, and FCG targets a standardized variable-length binary rather than Hsu’s target. The work must be re-evaluated in this environment.

### 2.2 Scan is the allocation and layout primitive

An exclusive prefix sum transforms a vector of sizes

```text
size   = [3, 0, 2, 5]
offset = [0, 3, 3, 5]
total  = 10
```

into non-overlapping output ranges. Blelloch identifies all-prefix-sums as a general parallel building block and gives work-efficient algorithms [5]. GPU segmented scans extend the same idea to many logical sequences stored in one flat vector and support the flattening of nested parallel programs [6].

For a compiler, scan replaces many familiar mutable operations:

- `filter` becomes predicate → scan → scatter;
- arena allocation becomes requested sizes → scan → assigned ranges;
- adjacency construction becomes degrees → scan → edge scatter;
- closure layout becomes capture flags → segmented scan → field numbers;
- instruction emission becomes encoded lengths → scan → byte ranges; and
- section layout becomes section sizes → scan → module offsets.

This observation is the main bridge between compiler construction and GPU execution.

### 2.3 Functional array languages show what maps well

NESL demonstrated a strongly typed, applicative language with nested data parallelism over sequences [7]. Futhark later showed that a purely functional array language can combine nested parallelism, fusion, and uniqueness-controlled in-place updates while compiling to GPUs [8]. Accelerate showed a related approach embedded in Haskell, where collective array operations serve as algorithmic skeletons for generated GPU code [9].

Those systems compile programs *for* GPUs; this proposal runs compiler transformations *on* a GPU. The common lesson is nevertheless important: flat arrays, collective operations, explicit uniqueness, and controlled mutation are a better semantic fit than object graphs and recursively allocated syntax trees.

### 2.4 WGSL is intentionally restrictive

Current WGSL forbids direct and indirect recursion because the module-scope declaration graph may not contain cycles [10]. Pointers are not storable, cannot be converted to integers, and cannot be returned from functions [11]. Portable atomics are over `i32` and `u32`, and only workgroup or read-write storage objects can contain them [12]. Portable workgroup storage is finite; the WGSL minimum supported limit is 16 KiB [1].

These restrictions rule out a literal port of a pointer-rich recursive compiler. They favor:

- integer indices instead of pointers;
- structure-of-arrays storage instead of object graphs;
- bounded loops inside a shader;
- dispatch boundaries for device-wide supersteps;
- preallocated arenas instead of dynamic allocation; and
- pairs of `u32` words for source values that the compiler must preserve but WGSL cannot compute on natively, such as `i64` and `f64` bit patterns.

WGSL barriers synchronize a workgroup, not every invocation in every workgroup. A compiler pass needing a device-wide barrier must end one dispatch and begin another. The host therefore schedules a bulk-synchronous sequence rather than one giant shader, following the compute/communicate/synchronize structure of the BSP model [24].

WGSL's recursion restriction applies to the compiler kernels, not to the generated program. FCG call-graph cycles are ordinary table edges, and the emitted Wasm functions may call themselves or one another recursively.

### 2.5 Wasm is unusually suitable for parallel emission

WebAssembly is a validated, portable, language-independent virtual ISA. Its design explicitly calls for efficient single-pass decoding and for compilation that can be split into independent parallel tasks [13]. The binary format is a dense encoding of abstract syntax [14]. Sections have an identifier, a LEB128-encoded content length, and their contents [15]; integer immediates use signed or unsigned LEB128 [16].

These properties allow independent functions to be encoded in parallel once all module indices are assigned. The final problem is variable-length concatenation, which is exactly a size-and-scan problem.

WebAssembly structured control is a constraint, not an obstacle. `block`, `loop`, and `if` are structured instructions [17]. Reducible frontend control flow can retain structure. Arbitrary control-flow graphs can always use a correctness-first dispatcher loop and `br_table`; later passes may recover more efficient structured regions.

## 3. Design principles

The design follows six principles.

### 3.1 Separate semantic minimality from physical regularity

The semantic IR should expose only distinctions needed to preserve source behavior: values, calls, closures, laziness, algebraic cases, effects, and control. The physical representation should expose regular arrays, stable integer identities, and explicit adjacency. Conflating these layers either makes the language an awkward array calculus or makes the GPU implementation chase a tree.

### 3.2 Make the frontend prove source-specific facts

A Haskell frontend already knows which bindings are recursive, which operations are primitive, where strictness is demanded, how type classes became dictionary arguments, and where thunks are required. FCG records those decisions rather than reconstructing them. A strict ML or C-like frontend emits no updateable thunks. The common backend should not rediscover a source language’s evaluation strategy.

### 3.3 Use immutable pass outputs

Each pass reads generation `g` and writes generation `g + 1`, or writes a side table keyed by stable IDs. This ping-pong discipline avoids partially rewritten graphs and makes pass invariants testable. In-place updates are permitted only when each output location has one statically determined writer or uses an explicitly specified associative atomic operation.

### 3.4 Put nondeterminism outside semantics

Parallel scheduling must not change generated bytes, diagnostic selection, function indices, closure field order, or optimization choices. Stable source IDs provide the tie-breaker everywhere. Atomics may count or combine commutative facts; they may not decide semantic order.

### 3.5 Keep runtime policy explicit

Compilation and execution are different problems. FCG lowers high-level operations to calls or imports defined by a runtime ABI. The initial linear-memory runtime makes allocation, thunk entry, update, garbage collection, exceptions, and host I/O explicit. WebAssembly GC can be studied later as another lowering, not assumed by the core design.

### 3.6 Preserve a CPU reference path

Every GPU pass has a straightforward reference implementation over the same tables. The reference is an executable specification, a differential oracle, and the fallback for devices without WebGPU. It also establishes whether a poor result is caused by the algorithm or by its GPU mapping.

## 4. Flat Compilation Graph

FCG has a semantic form used for reasoning and a flat form used for transport and execution.

### 4.1 Semantic types

The minimal types are:

```text
τ ::= I32 | I64 | F32 | F64
    | Ref k                  heap reference of representation class k
    | Code σ                 callable code with signature σ
    | Token r                ordering token for effect region r

σ ::= (τ*) -> (τ*) ! ε
ε ::= finite set of { alloc, read, write, throw, io }
```

`Ref k` is represented as an `i32` offset in the initial Wasm lowering. The representation class distinguishes, for example, a known constructor from an arbitrary closure during validation; it may be erased by code generation. `Token r` is not a runtime object when it can be erased safely. It makes effect order a data dependency in the compiler graph.

The type language intentionally does not reproduce a source language’s type system. Parametric polymorphism, kinds, type families, coercions, and type classes are resolved or erased by the frontend. Runtime-relevant representation types remain.

### 4.2 Semantic operations

Function bodies are in administrative normal form: operation arguments are atoms, and intermediate results receive IDs.

```text
module   ::= definition*
definition
         ::= function(name, signature, blocks)
          |  closure_layout(name, entry, fields, update_mode)
          |  constructor_layout(name, tag, fields)
          |  import(module, name, signature)
          |  export(name, function)

operation
         ::= const literal
          |  prim primitive atom*
          |  call function atom*
          |  call_indirect signature code atom*
          |  allocate token layout atom*
          |  enter token ref
          |  load token ref field
          |  store token ref field atom
          |  host_call token import atom*

terminator
         ::= return atom*
          |  jump block atom*
          |  branch atom then_block else_block
          |  switch atom (tag, block)* default_block
          |  trap diagnostic_id
```

There is no general `letrec` operation in the backend form. Recursive source bindings become top-level code plus explicitly allocated cyclic environments, or mutually recursive top-level functions. This is the same semantic information in a form compatible with indexed tables.

`enter` is the source-neutral hook needed by lazy languages. In an eager frontend it is absent. In the Haskell lowering it evaluates a closure to weak head normal form, including black-hole detection and update when the layout is updateable.

The primitive set is target-shaped:

- integer and floating arithmetic and comparisons;
- bit operations and conversions;
- memory-size-independent address arithmetic;
- constructor tag and layout queries; and
- explicit traps.

Anything requiring a policy—allocation, collection, scheduling, strings, big integers, files, clocks, randomness, or JavaScript objects—is a runtime call, not a primitive.

### 4.3 Effects and ordering

Pure operations have no token. An effectful operation consumes a `Token r` and produces its successor. For example:

```text
(heap1, x) = allocate heap0 Cons [head, tail]
(heap2, _) = store    heap1 x field0 head
(io1,  y)  = host_call io0 console_write [x]
```

Validation requires a token to form one dynamic chain. A token may be passed to multiple mutually exclusive branch successors, because only one edge executes; it may not feed two operations that can both execute unless an explicit fork/join operation permits that region policy. Code generation erases tokens after it has obtained a total order within each basic block and legal inter-block token parameters. Later examples suppress token operands where they would obscure the source-language point.

This is “parse, do not repeatedly validate” at the compiler boundary: the frontend converts source effects into a trusted ordering representation once; later passes preserve edges.

### 4.4 Operational meaning

An execution state is

```text
⟨F, H, V, b, pc, K⟩
```

where `F` is the function table, `H` the heap, `V` the environment mapping value IDs to runtime values, `(b, pc)` the current block and operation, and `K` the call stack. Pure operations extend `V`. Allocation extends `H` with a layout-tagged object. `enter` follows the object’s entry code; an updateable thunk transitions through `unevaluated → evaluating → value`. Terminators select the next block, return through `K`, or trap.

This small-step machine is not intended as a new execution engine. It is the relation against which the linear-memory Wasm runtime must simulate FCG behavior.

### 4.5 Flat physical encoding

All cross-references are `u32` IDs. Variable-length children live in shared edge arrays.

| Table | Required columns |
|---|---|
| Module | format version, feature bits, counts, source hash |
| Function | signature ID, parameter range, block range, flags, source ID |
| Block | owner function, parameter range, operation range, terminator ID, source ID |
| Operation | opcode, result range, argument range, immediate low/high words, source ID |
| Argument | value ID |
| Layout | kind, entry function, field-type range, update mode, source ID |
| Type | kind, component range |
| Symbol | UTF-8 byte range, namespace, source ID |
| Source | file ID, start byte, end byte |

The actual storage is structure-of-arrays:

```text
opOpcode:      array<u32>
opArgStart:    array<u32>
opArgCount:    array<u32>
opImmLow:      array<u32>
opImmHigh:     array<u32>
opSource:      array<u32>
arguments:     array<u32>
```

This avoids padding, permits a pass to bind only the columns it needs, and makes adjacent invocations read adjacent words. A schema version and declared buffer lengths precede every package. Validation checks all ranges before any transformation shader consumes them.

### 4.6 Why not a syntax tree or generic SSA file

A pointer-based tree is natural for a CPU but conflicts with WGSL’s non-storable pointers and makes memory access irregular. A generic SSA representation solves control and data dependence but does not by itself represent thunk entry, update modes, constructor layout, or runtime ordering. FCG is close to block-argument SSA, with the small additions required for managed functional languages and the flat storage required by WebGPU.

## 5. The compiler’s primitive algebra

Only five operations need optimized GPU implementations.

### 5.1 Transform

```text
transform f [x0, ..., xn-1] = [f(0,x0), ..., f(n-1,xn-1)]
```

Each invocation owns one or a small tile of elements. Validation predicates, local rewrites, encoded-size calculation, hash construction, and output packing use transform.

### 5.2 Associative scan

```text
scan⊕ [x0, ..., xn-1]
```

requires an associative operator and identity. Addition allocates output space; `max` propagates facts; pairs `(flag, value)` implement segmented scans. Reduction is the last element of a scan or a cheaper tree reduction when prefixes are not needed.

### 5.3 Gather

```text
gather values indices = map (values[·]) indices
```

Gather follows def-use edges, block ownership, type IDs, layout fields, and source mappings. All indices are already bounds-checked by boundary validation.

### 5.4 Conflict-controlled scatter

Scatter writes values to computed destinations under one of three declared policies:

- **unique:** validation or construction proves one writer;
- **stable:** values are first ordered by `(destination, source_id)`, then a segmented operation chooses or combines them; or
- **atomic:** an associative integer operation such as add, min, max, and, or, or compare-exchange is semantically sufficient.

An unconstrained last-writer-wins scatter is not part of the algebra.

### 5.5 Bounded convergence

Some analyses require repeated propagation. FCG permits only convergence with one of:

- a statically known round bound;
- a finite-height lattice and an explicit maximum height;
- pointer jumping with a logarithmic bound derived from the table size; or
- host-observed convergence in batches of `k` dispatches.

WebGPU cannot perform a device-wide barrier inside a dispatch. Each round is therefore a distinct dispatch. A status word can make already-recorded later rounds no-ops, but it cannot prevent their dispatch overhead. Reading a status word after every round is also expensive. The implementation should use proven bounds for core passes and batch host checks only for optional optimizations.

### 5.6 Derived operations

The familiar compiler toolbox follows:

```text
compact(p, xs) = scatterUnique(scan(+ , map p xs), xs where p)
allocate(sizes) = scan(+, sizes)
group(key, xs) = radixSort(key, xs) then segmented ranges
join(a, b) = sort/group compatible keys then gather matching ranges
```

An LSD radix-sort pass over a fixed number of key bits is histogram/scan/scatter. A stable `(key, source_id)` ordering makes results deterministic. Trees become preorder node arrays with depth or parent columns; child and descendant ranges are computed with scan, grouping, and pointer jumping, following the flat-tree approach demonstrated by Hsu [4].

## 6. Pass pipeline

The backend is a fixed sequence of separately testable table transformations.

### 6.0 Target profile

The first emitter targets a conservative `wasm32` profile: core numeric types, one 32-bit linear memory, one function table, direct and indirect calls, locals, globals, and structured control. It does not require Wasm GC, tail calls, native exception handling, multiple memories, memory64, SIMD, or threads. Allocation, collection, thunk update, and exceptions are library/runtime operations inside ordinary Wasm. Optional profiles may use newer standardized features, but each module records its required profile and the baseline remains the correctness oracle.

### 6.1 Boundary validation

The first pass treats the package as hostile input. It checks:

- schema version and feature flags;
- multiplication and addition overflow in every byte/range calculation;
- every `(start, count)` against the declared column length;
- all referenced IDs against their table counts;
- one terminator per block and ownership consistency;
- opcode/immediate combinations;
- signature and result arities;
- source-range ordering; and
- configured resource limits.

Each row writes either `no_error` or a diagnostic tuple `(source_id, code, evidence0, evidence1)`. A deterministic reduction selects the least tuple by `(source_id, code, row_id)`. Later passes do not scatter defensive bounds checks through their interior logic; they consume a trusted FCG package.

### 6.2 Type and effect checking

The frontend normally supplies types. The GPU verifies rather than infers them:

1. gather each argument’s declared result type;
2. compare the argument vector with the opcode or callee signature;
3. check block arguments against block parameters;
4. check each terminator against successor signatures; and
5. verify token use and effect annotations.

This is embarrassingly parallel except for use counts, which are a keyed reduction. Avoiding general Hindley–Milner inference in the common backend is deliberate: inference is a language frontend concern and would introduce global unification policy into an otherwise representation-level IR.

### 6.3 Reachability and dead definition removal

Roots are exports, start functions, referenced runtime hooks, and retained reflection metadata. Edges are direct calls, closure entries, layout references, and data references. Reachability propagates over the finite function/layout graph. The survivors are compacted in stable source order, then every reference gathers its new index. Dead operations within functions are removed similarly, with effectful operations and terminators as roots of a reverse def-use traversal.

### 6.4 Closure layout

For a frontend that emits symbolic captures:

1. mark each free-variable occurrence with `(closure_id, value_id, source_id)`;
2. stable-sort by that key;
3. unique adjacent equal `(closure_id, value_id)` pairs;
4. segmented-scan within each closure to assign field numbers;
5. scan field counts to assign global layout ranges; and
6. rewrite occurrences to field loads.

A Haskell STG frontend may already provide ordered free-variable lists. In that case the backend validates and lays them out without recomputation.

### 6.5 Representation lowering

Representation lowering maps source-neutral operations to the selected runtime ABI:

- `Ref` becomes an `i32` linear-memory offset;
- `allocate layout fields` becomes bump allocation plus header/payload stores;
- `enter ref` becomes a fast test followed by an indirect entry call;
- constructor tag queries become header loads;
- tokens become ordering edges and then disappear; and
- `i64`/`f64` literals remain two `u32` words until emission.

The compiler need not evaluate `i64` or `f64` values to encode them. Constant folding for operations unsupported by portable WGSL belongs in a small CPU reference evaluator, a multiword integer library, or is simply omitted from the GPU optimization set. Correct compilation does not depend on constant folding.

### 6.6 Control-flow lowering

There are two paths.

**Structured path.** Frontends preserve region structure for expression-oriented `case`, `if`, and loops. The backend maps regions directly to Wasm `block`, `loop`, and `if`, assigning label depths with parent/depth tables.

**Universal path.** Any remaining control-flow graph becomes:

```wat
(loop $dispatch
  ;; nested blocks establish branch-table labels
  (local.get $pc)
  (br_table $block0 $block1 ... $invalid)
  ;; each translated block computes values, sets $pc, and branches to $dispatch
)
```

This path handles irreducible flow and is the correctness baseline. It may produce slower code because locals carry values across blocks and every edge returns to the dispatcher. Structure recovery is an optimization, not a prerequisite for a general frontend contract.

### 6.7 Index assignment

Wasm type, function, table, global, memory, element, and data indices must be fixed before final encoding. Stable compaction assigns indices. Function signatures are canonicalized by stable sort on their complete type vectors, then deduplicated. Imports precede defined functions as required by the index spaces. Relocation becomes a gather from entity ID to assigned Wasm index; there is no serial linker patch loop.

### 6.8 Stackification

The correctness-first emitter stores every nontrivial FCG result in a Wasm local and reloads atoms with `local.get`. This creates valid, predictable stack code at the cost of extra local traffic. A later local pass can inline single-use pure producers when:

- the producer dominates the use;
- argument evaluation order is preserved;
- no token edge is crossed; and
- the estimated encoded size does not grow unexpectedly.

WebAssembly validates instructions by their operand-stack effects [18]. The backend independently computes each emitted block’s input/output type vector and rejects a mismatch before emission; the host’s `WebAssembly.validate` remains a final independent check.

### 6.9 Binary emission

Emission is a hierarchy of size/scan/write operations.

For each instruction, function body, vector, and section:

1. calculate its exact encoded byte length, including LEB128 lengths;
2. exclusive-scan lengths to obtain offsets;
3. write bytes to assigned ranges;
4. calculate the enclosing object’s length prefix; and
5. repeat at the next level.

The dependency is bottom-up because an enclosing LEB128 length depends on the exact child size. It is not serial across siblings.

#### Packed bytes in WGSL

Portable storage is naturally `array<u32>`, not an independently writable byte array. Two correct strategies are useful:

- **Simple oracle:** write one logical byte per `u32`, read back, and narrow in JavaScript. This uses four times the output storage and transfer bandwidth.
- **Packed artifact:** give each record a word-aligned scratch range, write private words without races, then run a packing transform where each output-word invocation gathers the four logical bytes that belong to it. The final buffer has `ceil(byte_length / 4)` words.

The packed strategy avoids adjacent instruction writers racing on one word and does not require atomic OR for every byte. JavaScript must unpack words numerically into a `Uint8Array` (or explicitly establish byte order with `DataView`) rather than assume host typed-array endianness.

The module begins with the fixed Wasm magic and version bytes. Standard sections are then written in prescribed order. A custom name/source-map section is optional and should be a separate feature so that debug metadata cannot perturb semantic indices.

## 7. JavaScript, browser, and Deno runtime

Deno exposes WebGPU at `navigator.gpu`, using the same entry point as browser JavaScript [19], and documents native compute-shader execution with the same adapter/device model [20]. The host can therefore be small and environment-neutral.

Conceptually:

```js
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("no WebGPU adapter is available");

const device = await adapter.requestDevice({ requiredLimits });
uploadFlatCompilationGraph(device, packageBytes);

const commandEncoder = device.createCommandEncoder();
for (const compilerPass of scheduledPasses) {
  encodeDispatch(commandEncoder, compilerPass);
}
commandEncoder.copyBufferToBuffer(
  packedModuleBuffer,
  0,
  readbackBuffer,
  0,
  packedByteLength,
);
device.queue.submit([commandEncoder.finish()]);

await readbackBuffer.mapAsync(GPUMapMode.READ);
const wasmBytes = unpackModuleWords(readbackBuffer.getMappedRange(), byteLength);

if (!WebAssembly.validate(wasmBytes)) {
  throw new Error("GPU backend emitted an invalid WebAssembly module");
}
const module = await WebAssembly.compile(wasmBytes);
const instance = await WebAssembly.instantiate(module, runtimeImports);
```

This is illustrative, not an API listing. A real host needs error scopes, `device.lost` handling, adapter-limit negotiation, staging-buffer lifetime management, and diagnostic readback.

### 7.1 Pipeline creation and caching

WGSL compiler pipelines are static assets built with the application. They should be created asynchronously and cached per `GPUDevice`. Feature variants—subgroups, wider limits, debug checks—are separate pipelines selected from adapter capabilities. User source never becomes WGSL, which avoids shader-source injection and repeated driver shader compilation.

### 7.2 Buffer lifecycle

The host allocates:

- immutable input columns;
- two transformation arenas for ping-pong generations;
- scan scratch;
- diagnostics and status words;
- logical-byte or aligned-record emission scratch;
- a packed output buffer with `COPY_SRC`; and
- a staging buffer restricted to `MAP_READ | COPY_DST`, as required by WebGPU buffer-usage rules [2].

Capacity planning is explicit. A count pass produces required sizes before a write pass. If a required size exceeds the declared cap, compilation returns a resource diagnostic containing the requested and allowed values; it never wraps or silently truncates.

### 7.3 Scheduling supersteps

Pass dependencies are known for validation, lowering, and emission, so the host can encode many dispatches into one command buffer. Indirect dispatch can derive workgroup counts from GPU-written counts without reading them into JavaScript. Optional fixed-point optimizations should execute several rounds per submission and expose a completion flag; the host reads the flag only at batch boundaries.

### 7.4 Wasm instantiation is a second compiler

The browser or Deno engine still decodes, validates, and compiles the emitted module to native code. GPU emission does not replace that implementation-defined compilation. End-to-end measurements must report it separately:

```text
frontend + upload + GPU passes + readback + Wasm engine compile + instantiation
```

Omitting the last two terms would answer a different performance question.

## 8. Haskell as the stress test

### 8.1 Why Haskell is revealing

An eager arithmetic language can map almost directly to Wasm locals and calls. Haskell requires a compiler to preserve:

- non-strict evaluation;
- sharing of evaluated thunks;
- higher-order closures;
- recursive and cyclic bindings;
- algebraic data and pattern matching;
- unboxed primitives alongside boxed values;
- exceptions and `IO` ordering; and
- a managed heap and runtime scheduler.

The Spineless Tagless G-machine was designed precisely as an abstract-machine target for non-strict higher-order functional languages, with an austere functional language and defined operational meaning [21]. GHC’s documented pipeline exposes Core-to-Core optimization, then STG passes, then Cmm and backend code generation [22]. This suggests a realistic seam: use an existing Haskell frontend through Core optimization, translate an STG-like program into FCG, and move the representation-level middle/backend work to WebGPU.

This is also an honest comparison point. Current GHC has a WebAssembly cross compiler targeting `wasm32-wasi`, uses post-MVP Wasm features, and supports browsers through a JavaScript-provided WASI layer [23]. The proposed system is not the first Haskell-to-Wasm compiler; its novelty is GPU-hosted transformation and a language-neutral flat contract.

### 8.2 Frontend mapping

An STG-like frontend maps as follows:

| Haskell/STG concept | FCG concept |
|---|---|
| top-level function | `function` definition |
| lambda free variables | `closure_layout` fields |
| updatable thunk | closure with `update_mode = single_entry_update` |
| function closure | closure with arity and entry function |
| constructor application | constructor layout plus `allocate` |
| saturated known call | direct `call` |
| unknown/higher-order call | `enter` or `call_indirect` |
| `case` | `switch` on constructor tag or primitive branch |
| unboxed value | Wasm numeric local/value |
| `letrec` | preallocated environment followed by field initialization |
| `raise#`, `catch#`, `IO` primops | runtime calls threaded by tokens |

Core type abstractions and coercions that have no runtime representation are erased before FCG. Type-class methods are ordinary dictionary fields and calls by this stage. Source strictness and demand information can select evaluated fields or unboxed representations, but FCG correctness does not depend on aggressive demand analysis.

### 8.3 Worked example

Consider a deliberately small lazy program:

```haskell
data Nat = Z | S Nat

double :: Nat -> Nat
double Z     = Z
double (S n) = S (S (double n))
```

An FCG sketch is:

```text
layout Nat.Z  = constructor(tag = 0, fields = [])
layout Nat.S  = constructor(tag = 1, fields = [Ref Nat])
layout Double = thunk(entry = double_thunk, captures = [Ref Nat], update = yes)

function double(x: Ref Nat) -> Ref Nat ! {alloc, read, write}:
  entry:
    x_whnf = enter x
    tag = constructor_tag x_whnf
    switch tag [0: zero, 1: successor] default: invalid_tag

  zero:
    z = allocate Nat.Z []
    return z

  successor:
    n = load x_whnf field0
    delayed = allocate Double [n]
    inner = allocate Nat.S [delayed]
    outer = allocate Nat.S [inner]
    return outer

  invalid_tag:
    trap InvalidConstructorTag(tag)

function double_thunk(environment: Ref Double) -> Ref Nat:
  n = load environment field0
  result = call double [n]
  return result
```

The recursive call is suspended in an updateable thunk because the field of `S` is lazy. Nothing in the GPU compiler recursively evaluates this structure. It transforms rows describing the functions and layouts. At runtime, `enter` invokes `double_thunk` only when the tail is demanded, then overwrites or forwards the thunk to its value according to the runtime ABI.

A simplified Wasm lowering of `double` uses:

- an `i32` reference for `x`;
- a call to `$enter`;
- an `i32.load` of the info/tag word;
- structured blocks or `br_table` for the alternatives;
- calls to `$allocate_words`; and
- stores of layout IDs and payload references.

The exact object header is runtime policy, not FCG semantics.

### 8.4 Initial runtime ABI

The MVP uses 32-bit linear-memory references and four-byte words. A heap object has:

```text
word 0: info-table index
word 1: payload word count and runtime flags
word 2...: payload
```

The info-table index addresses static metadata describing object kind, constructor tag or arity, pointer bitmap, entry function-table index, and update behavior. The table may live in a Wasm data segment or globals. Entry uses `call_indirect` through a Wasm table.

Allocation begins with a bump-pointer nursery. Collection is implemented in Wasm and tested independently of the compiler. A semispace copying collector is conceptually simple for the subset because pointer bitmaps are known, but it requires enough linear memory for two spaces; mark-sweep uses less peak space but is more complex. This is a product choice to make after measuring representative browser limits, not a fact to hide inside code generation.

### 8.5 `letrec` and cyclic values

Recursive closures require two phases:

1. compute every closure’s size and scan to reserve all addresses; and
2. initialize headers and fields using those now-known addresses.

This is a particularly good fit for the GPU allocation model. The compiler emits runtime code that follows the same reserve-then-fill discipline. During compilation, closure metadata is also allocated with size/scan/write.

### 8.6 What full Haskell would still require

A complete implementation needs decisions and tests for:

- partial applications and generic apply routines;
- CAF initialization and retention;
- black holes and re-entrant thunk evaluation;
- precise garbage-collector roots in Wasm locals and shadow stacks;
- asynchronous and synchronous exceptions;
- stable names, weak references, finalizers, and compact regions;
- arbitrary precision integers;
- profiling and cost centres;
- the JavaScript FFI and a capability-aware host boundary;
- concurrency, sparks, and a threaded runtime; and
- linking separately compiled packages.

These are runtime and ecosystem projects. Pretending that closure conversion alone compiles “Haskell” would make the proposal unfalsifiable. The first paper artifact should instead state and test a language subset.

## 9. Correctness argument and proof obligations

The desired theorem is conditional:

> If a frontend translates source program `S` to well-typed FCG program `P` while preserving its source semantics; every FCG pass preserves the FCG transition relation; the runtime simulates FCG heap and effect operations; and binary emission implements the WebAssembly encoding, then executing the validated emitted module has the observable behavior of `S`, up to the frontend’s specified resource limits and host imports.

This paper does not claim that theorem is proved. It decomposes it into tractable obligations.

### 9.1 Frontend preservation

Each frontend owns a simulation from source states to FCG states. For Haskell, the STG-to-FCG mapping must preserve thunk allocation, entry, sharing, constructor cases, and exceptions for the supported subset.

### 9.2 Pass preservation

Each table transformation declares:

- input well-formedness invariants;
- output well-formedness invariants;
- a mapping from old IDs to new IDs; and
- a local or global semantic preservation lemma.

Compaction, for example, must show that every retained reference gathers the new ID of the same semantic entity. Dead-code removal must show that removed pure operations are unreachable from returned values or effects.

### 9.3 Runtime simulation

The runtime’s linear-memory objects simulate abstract FCG heap objects. Info-table metadata defines the relation. Enter/update transitions are the most important part of the Haskell proof because they preserve both result and sharing.

### 9.4 Encoding correctness

For every emitted entity `e`, size calculation must equal the number of bytes written, and decoding those bytes under the WebAssembly binary grammar must yield the intended abstract Wasm entity. Scanned ranges must be disjoint and cover the enclosing payload exactly. LEB128 tests should exhaust boundary classes around every 7-bit transition and include minimum/maximum supported signed values.

### 9.5 Independent validation

GPU-side validation protects the compiler’s own buffer accesses and yields useful source diagnostics. `WebAssembly.validate` protects the host from an invalid generated module. Differential execution against the CPU reference protects against the more dangerous case: a valid module with the wrong meaning.

## 10. Security, limits, and determinism

### 10.1 Untrusted input

Browser compilation is an input-processing boundary. Before dispatch, JavaScript checks the fixed header and total buffer sizes. The first GPU stage checks internal ranges. Every size accumulation uses overflow-aware arithmetic. Configured caps cover:

- definitions, blocks, operations, and edges;
- maximum per-function body size;
- maximum output module size;
- maximum analysis rounds;
- scratch and heap bytes; and
- diagnostic count.

The WebAssembly JavaScript API also defines implementation limits, including a maximum module size and limits on functions, types, locals, and function-body sizes [3]. The compiler should use stricter portable caps by default and report its own evidence-rich resource error before the engine returns a generic `CompileError` or out-of-memory failure.

### 10.2 Shader robustness is not semantic validation

WebGPU implementations provide safety guarantees around GPU access, but out-of-bounds reads becoming harmless values would still let a malformed graph turn into a misleading compiler result. Boundary validation is therefore required even when the API prevents memory corruption.

### 10.3 Deterministic builds

The same FCG bytes, compiler version, feature profile, and runtime version must produce identical Wasm bytes. Requirements include:

- stable sort or explicit source-ID tie-breakers;
- no floating-point computation in decisions that affect generated structure;
- no first-arriving atomic winner;
- canonical signature and symbol ordering;
- zeroed padding and scratch before packing; and
- a custom section recording input and compiler hashes.

Reproducibility tests compare bytes across repeated runs, workgroup sizes, adapters, browser/Deno hosts, and CPU reference execution.

## 11. Cost model and expected performance

Let:

- `N` be the number of FCG rows and edges;
- `D` the number of dispatches;
- `U` and `R` uploaded and read-back bytes;
- `W` total parallel work; and
- `B_g`, `B_u`, and `B_r` effective GPU memory, upload, and readback bandwidths.

A useful first model is:

```text
T_gpu ≈ T_pipeline_warmup
      + D · T_dispatch
      + U / B_u
      + W / B_g
      + R / B_r
      + T_wasm_engine_compile
```

Scan is `O(N)` work and `O(log N)` span in the standard model [5]. Fixed-radix sorting is `O(kN)` work for `k` digit passes. Most FCG passes are linear; reachability adds bounded propagation rounds. These asymptotics do not erase fixed costs.

The likely regimes are:

| Workload | Expected result before measurement |
|---|---|
| one tiny function | CPU wins decisively |
| ordinary small interactive module | CPU likely wins |
| large generated module | uncertain; GPU may amortize costs |
| whole-program optimization | plausible GPU benefit |
| many independent modules batched together | strongest GPU case |
| output dominated by Wasm engine compilation | backend speedup has limited end-to-end effect |

The backend should batch modules by adding a segment/module ID to tables. Segmented scan and sort then preserve module boundaries while filling the GPU. This is more promising than trying to reduce a single ten-line function’s latency.

## 12. Evaluation plan

The project should answer four questions rather than report one aggregate speedup.

### Q1. Is the representation general enough?

Compile:

- a strict first-order functional language;
- a language with closures and algebraic data;
- the stated Haskell subset; and
- an imperative frontend with arbitrary CFGs through the dispatcher path.

Record which source constructs require new semantic operations. Success means new frontends mostly add frontend logic and runtime imports, not new compiler primitives.

### Q2. Is GPU compilation correct and deterministic?

For randomly generated and curated programs:

1. run CPU and GPU FCG pipelines;
2. compare every intermediate table after canonicalization;
3. validate both Wasm modules;
4. execute exports over generated inputs; and
5. compare return values, traps, heap observations exposed by tests, and imported-effect traces.

Mutation testing should corrupt ranges, IDs, types, token chains, section sizes, and LEB encodings to demonstrate that the relevant check fails with the offending values.

### Q3. Where is the break-even point?

Measure cold and warm runs separately across logarithmic program sizes and batch counts. Baselines are:

- a clear single-threaded JavaScript implementation;
- the same reference compiled to CPU Wasm where practical;
- the GPU implementation; and
- for Haskell execution artifacts, the current GHC Wasm backend as an output/runtime comparison, not as an identical-pass comparison.

Report medians and tail latency for frontend, upload, each pass family, readback, host validation, engine compilation, and instantiation. Record adapter, driver/browser or Deno version, requested limits, power mode, and whether the adapter is a fallback.

### Q4. Which primitives dominate?

Collect bytes read/written and time for transform, scan, radix sort, propagation, and packing. Compare the simple one-`u32`-per-byte emitter with packed emission. Measure how workgroup size and subgroup availability affect each kernel without making subgroup support a correctness requirement.

### 12.1 Falsifiable hypotheses

The initial hypotheses are:

- **H1:** warm GPU backend throughput exceeds the CPU reference for sufficiently large or sufficiently batched FCG input;
- **H2:** transfer and dispatch prevent a latency advantage on small modules;
- **H3:** exact binary emission is a mostly linear fraction of GPU time, not the dominant superlinear cost;
- **H4:** closure/layout transforms require no primitives beyond the five-operation algebra;
- **H5:** identical bytes can be produced across conforming adapters when deterministic ordering rules are enforced; and
- **H6:** Haskell’s runtime complexity dominates the size of its frontend mapping, but does not require a different GPU compiler architecture.

A result that rejects H1 would still be useful: it would bound where GPU-hosted compilation is inappropriate while leaving the flat IR and parallel algorithms available to multicore CPU and native GPU environments.

## 13. Implementation roadmap

### Stage 0: executable specification

Define the FCG schema, semantic interpreter, validator, and Wasm emitter in readable JavaScript or TypeScript. Implement the eager first-order frontend. Run the WebAssembly specification tests relevant to emitted instructions and maintain golden binaries for every encoding boundary.

Exit criterion: generated modules validate and differentially execute; every table invariant has a failing test.

### Stage 1: WebGPU emission kernel

Implement transform, hierarchical scan, unique scatter, count/allocate, and logical-byte emission. Port only validation, index assignment, and Wasm emission. Keep all optimization on the CPU.

Exit criterion: CPU and GPU emit byte-identical modules; report the first break-even curves without claiming a general speedup.

### Stage 2: graph transformations

Add deterministic radix sort, segmented operations, reachability, dead-code removal, signature canonicalization, and packed output.

Exit criterion: intermediate GPU tables match the CPU oracle under randomized testing and across at least three distinct adapter families.

### Stage 3: closures and algebraic data

Add closure layouts, indirect calls, constructors, cases, linear-memory allocation, and a minimal collector. Compile a strict ML-like frontend first.

Exit criterion: higher-order and recursive programs survive forced collections and differential tests.

### Stage 4: Haskell subset

Build an exporter after an STG-like frontend stage. Support algebraic data, higher-order functions, updateable thunks, recursive bindings, unboxed arithmetic, and pure exceptions. State the supported source subset as a grammar and semantics.

Exit criterion: thunk sharing, cyclic bindings, black-hole behavior, pattern matching, and collection are directly tested; representative programs agree with the reference implementation.

### Stage 5: optimization and linking

Only after correctness and profiling, study structured control recovery, single-use stackification, specialization, separately compiled module linking, incremental recompilation, and batched service operation.

The order matters: optimizing before a CPU/GPU differential oracle would make failures difficult to localize.

## 14. Risks and alternatives

### 14.1 Dispatch latency overwhelms useful work

Mitigations are batching, pass fusion where it does not hide invariants, indirect dispatch, and bounded multi-round scheduling. If these do not establish a useful regime, retain FCG but execute its operations on a multicore CPU or a native compute API with lower orchestration cost.

### 14.2 Irregular compiler graphs underutilize the GPU

Stable sorting and grouping turn random graph edges into contiguous segments at a cost. The evaluation must measure whether locality gained exceeds sorting traffic. High-degree outliers may need tiled processing; tiny functions can remain on the CPU while large functions or cross-module analyses use the GPU.

### 14.3 WebGPU portability constrains arithmetic

The backend carries 64-bit bit patterns as pairs and avoids depending on unsupported arithmetic. A feature profile may use shader extensions where available, but the portable path remains the correctness reference. Optimization quality may differ; semantics must not.

### 14.4 Haskell runtime work obscures the compiler experiment

Bring up the backend with an eager language, then add an STG-like frontend and minimal runtime. Benchmark backend passes separately from generated-code execution. Compare Haskell with current GHC output to identify runtime and code-quality gaps without conflating them with GPU compile throughput.

### 14.5 Existing CPU compilers are already fast

That is a valid outcome boundary. The strongest application may be a browser compiler service processing generated code, notebooks compiling many cells, or whole-program optimization—not replacement of a mature native compiler for ordinary modules. The project should select its use case from measured break-even points.

## 15. Conclusion

Compilation on a GPU to WebAssembly is technically possible today if the problem is shaped for the machine. The compiler should not be a recursive object-oriented program translated mechanically into WGSL. It should be a sequence of deterministic transformations over flat, typed tables, with allocation and variable-length output reduced to scan.

FCG provides the source-language boundary: small semantic operations represent calls, control, closures, thunks, algebraic values, heap access, and effects; a columnar encoding makes those operations available to WebGPU. Five implementation primitives—transform, scan, gather, controlled scatter, and bounded convergence—are sufficient to derive the needed compiler algorithms. WebAssembly is a good output format because functions and sections can be sized and emitted independently before scans assemble the binary.

Haskell does not invalidate the architecture, but it prevents hand-waving. Laziness moves complexity into explicit closures, entry/update transitions, and the runtime. An STG-like frontend is therefore the right first Haskell seam, and a precisely stated subset is the right first result.

The remaining question is empirical rather than conceptual: at what program size and batch size do parallel transformation and emission repay WebGPU’s orchestration and transfer costs? The roadmap is designed to answer that question early, with a CPU oracle, byte-identical output, and no speedup claim embedded in the architecture.

## References

1. W3C GPU for the Web Working Group. [WebGPU Shading Language](https://www.w3.org/TR/WGSL/). Candidate Recommendation Draft. Sections 2.1, 2.4, 5.1, 6, 11, 15, and 17. Accessed 22 July 2026.
2. W3C GPU for the Web Working Group. [WebGPU Specification](https://gpuweb.github.io/gpuweb/). Buffer mapping, queue submission, buffer usages, limits, and timelines. Accessed 22 July 2026.
3. WebAssembly Community Group. [WebAssembly JavaScript Interface](https://webassembly.github.io/spec/js-api/). `validate`, asynchronous compilation, instantiation, and implementation-defined limits. Accessed 22 July 2026.
4. Aaron W. Hsu. [*A Data Parallel Compiler Hosted on the GPU*](https://scholarworks.iu.edu/dspace/items/3ab772c9-92c9-4f59-bd95-40aff99e8c7a). PhD dissertation, Indiana University, 2019.
5. Guy E. Blelloch. [*Prefix Sums and Their Applications*](https://www.cs.cmu.edu/afs/cs.cmu.edu/project/scandal/public/papers/CMU-CS-90-190.html). CMU-CS-90-190, Carnegie Mellon University, 1990.
6. Shubhabrata Sengupta, Mark Harris, and Michael Garland. [*Efficient Parallel Scan Algorithms for GPUs*](https://research.nvidia.com/publication/2008-12_efficient-parallel-scan-algorithms-gpus). NVIDIA Technical Report NVR-2008-003, 2008.
7. Guy E. Blelloch. [*NESL: A Nested Data-Parallel Language*](https://www.cs.cmu.edu/~scandal/papers/CMU-CS-93-129.html). CMU-CS-93-129, Carnegie Mellon University, 1993.
8. Troels Henriksen, Niels G. W. Serup, Martin Elsman, Fritz Henglein, and Cosmin E. Oancea. [*Futhark: Purely Functional GPU-Programming with Nested Parallelism and In-Place Array Updates*](https://futhark-lang.org/publications/pldi17.pdf). PLDI 2017.
9. Manuel M. T. Chakravarty, Gabriele Keller, Sean Lee, Trevor L. McDonell, and Vinod Grover. [*Accelerating Haskell Array Codes with Multicore GPUs*](https://media.githubusercontent.com/media/tmcdonell/tmcdonell.github.io/master/papers/acc-cuda-damp2011.pdf). DAMP 2011.
10. W3C GPU for the Web Working Group. [WGSL §5.1, Module Scope and declaration cycles](https://www.w3.org/TR/WGSL/#module-scope). Accessed 22 July 2026.
11. W3C GPU for the Web Working Group. [WGSL §6.4.6, Pointer and reference types](https://www.w3.org/TR/WGSL/#ref-ptr-types). Accessed 22 July 2026.
12. W3C GPU for the Web Working Group. [WGSL §6.2.8, Atomic types](https://www.w3.org/TR/WGSL/#atomic-types). Accessed 22 July 2026.
13. WebAssembly Community Group. [WebAssembly Core Specification: Introduction](https://webassembly.github.io/spec/core/intro/introduction.html). Version 3.0. Accessed 22 July 2026.
14. WebAssembly Community Group. [WebAssembly binary format conventions](https://webassembly.github.io/spec/core/binary/conventions.html). Version 3.0. Accessed 22 July 2026.
15. WebAssembly Community Group. [WebAssembly binary modules and sections](https://webassembly.github.io/spec/core/binary/modules.html). Version 3.0. Accessed 22 July 2026.
16. WebAssembly Community Group. [WebAssembly binary value encoding](https://webassembly.github.io/spec/core/binary/values.html). Version 3.0. Accessed 22 July 2026.
17. WebAssembly Community Group. [WebAssembly instruction syntax](https://webassembly.github.io/spec/core/syntax/instructions.html). Structured control instructions. Version 3.0. Accessed 22 July 2026.
18. WebAssembly Community Group. [WebAssembly instruction validation](https://webassembly.github.io/spec/core/valid/instructions.html). Operand-stack instruction types. Version 3.0. Accessed 22 July 2026.
19. Deno. [`GPU` Web API documentation](https://docs.deno.com/api/web/gpu/). Accessed 22 July 2026.
20. Deno. [Run a compute shader with WebGPU](https://docs.deno.com/examples/webgpu_compute/). Accessed 22 July 2026.
21. Simon L. Peyton Jones. [*Implementing Lazy Functional Languages on Stock Hardware: The Spineless Tagless G-machine*](https://www.cambridge.org/core/journals/journal-of-functional-programming/article/implementing-lazy-functional-languages-on-stock-hardware-the-spineless-tagless-gmachine/354FFB29102309CCD2A3824F894A2799). *Journal of Functional Programming*, 2(2), 1992.
22. Glasgow Haskell Compiler. [Debugging the compiler: intermediate structures](https://downloads.haskell.org/ghc/latest/docs/users_guide/debugging.html#dumping-out-compiler-intermediate-structures). Core, STG, and Cmm pipeline documentation. Accessed 22 July 2026.
23. Glasgow Haskell Compiler. [Using the GHC WebAssembly backend](https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html). Accessed 22 July 2026.
24. Leslie G. Valiant. [*A Bridging Model for Parallel Computation*](https://doi.org/10.1145/79173.79181). *Communications of the ACM*, 33(8), 1990.

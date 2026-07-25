# Ducklang semantic Core roadmap

## Objective

Compile the current Binned preludes and applications by translating Ducklang
surface behavior into a small, monomorphic Core before bulk GPU optimization and
Wasm emission.

The GPU must not learn about source modules, protocols, extensions, generic
types, lexical shadowing, iterators, or source-defined handlers. Those features
must be resolved by the frontend and expressed through theoretically grounded
primitives:

- compile-time values and partial evaluation;
- modules as records and parameterized modules as functions;
- protocols as compile-time dictionaries;
- products, sums, and closures;
- SSA blocks with parameters;
- linear resource and region obligations;
- explicit memory, calls, and control flow.

The existing vendored corpus contract, stable source spans, CPU type oracle, GPU
differential checks, and deterministic output remain required throughout this
work.

## Required separation

```text
Duck source
  -> syntax and source AST
  -> names, module graph, and canonical types
  -> compile-time normalization and specialization
  -> monomorphic resource-aware SSA Core
  -> closure, aggregate, ownership, and layout planning
  -> flat Core package
  -> GPU rewrite, layout, and Wasm emission
```

### 1. Surface frontend

Owns syntax, source diagnostics, lexical scopes, declarations, and preservation
of source spans. It may represent all legal Ducklang syntax but must not decide
Wasm layouts.

### 2. Staged elaboration

Owns modules, imports, type values, `const`, `comptime`, generics, protocols,
extensions, reflection, source attributes, and source-defined type builders. Its
output contains no unresolved compile-time values or method search.

### 3. Monomorphic Core

Owns typed runtime values and explicit control flow. Every value has a stable
`ValueId`, every block has explicit parameters, and every control-flow edge
supplies arguments for those parameters.

### 4. Resource and layout planning

Owns closure environments, aggregate layouts, allocation, ownership, borrows,
freezing, scratch regions, cleanup, and host-boundary representations. It lowers
semantic aggregate and resource operations to explicit machine-facing
operations.

### 5. Flat GPU package

Owns immutable structure-of-arrays storage for functions, blocks, values,
operations, edges, layouts, and source locations. GPU passes transform this
package deterministically; they do not perform source-language policy or
method/module lookup.

### 6. Wasm backend

Owns stackification, locals, structured-control formation, binary layout, and
byte emission. CPU and GPU emission remain differential until the GPU path is
fully validated.

## Primitive sets

### Compile-time values

Implement one evaluator over this value domain instead of separate ad hoc
module, extension, and scalar-comptime evaluators:

```text
ConstValue =
  Scalar
  Type(TypeId)
  Product(fields)
  Sum(case, payload)
  Closure(code, environment)
  Module(exports)
```

Required compile-time operations:

```text
const.call
const.project
const.extend

type.apply
type.product
type.sum
type.record
type.union
type.intersection
type.difference
type.extend

type.fields
type.cases
type.has
type.size
type.align
type.layout

module.select
```

`Module` may use the same persistent product representation as ordinary
compile-time records. Protocol dictionaries and extension families should also
be ordinary compile-time records wherever possible.

### Monomorphic Core types

Core must distinguish semantic types from their eventual storage layouts:

```text
I32
I64
F32
F64
V128
Product(TypeId...)
Sum(CaseId...)
Function(SignatureId)
Buffer(BufferKind)
```

`Text` and `Bytes` are distinct semantic buffer kinds even if a later layout
pass gives them compatible physical representations.

### Control-flow primitives

```text
block(parameters...)
branch(target, arguments...)
conditional_branch(condition, true_target, true_arguments,
                    false_target, false_arguments)
switch(discriminant, cases..., default)
return(values...)
tail_call(callee, arguments...)
trap
```

These primitives must express:

- statement-only branches returning `Unit`;
- expression branches returning one or more values;
- the latest shadowed binding versions at joins;
- loop headers and carried bindings;
- `continue` as a loop-header edge;
- bare and valued `break` as loop-exit edges;
- nested loop boundaries;
- early `return` as a function terminator.

### Runtime value primitives

```text
scalar.constant
scalar.unary
scalar.binary
scalar.convert
scalar.reinterpret

product.make
product.project
product.update

sum.make
sum.tag
sum.payload

call.direct
call.indirect
closure.make

buffer.length
buffer.get
buffer.set
buffer.slice
buffer.concat
buffer.allocate

memory.load
memory.store
memory.copy
memory.allocate

host.call
```

The scalar primitive registry must cover the corresponding Wasm families for
`i32`, `i64`, `f32`, `f64`, and the admitted `f32x4` SIMD operations. Each
primitive needs one canonical ID, signature, stage, effect classification, and
lowering rule. Source aliases and imported wrapper names must resolve to that ID
before Core construction.

### Resource primitives

Resource operations remain explicit until the ownership and layout plan has
proved their lowering:

```text
resource.move
resource.borrow
resource.freeze
resource.drop

region.enter
region.allocate
region.exit
```

Every Core edge must carry a valid resource state. Mutually exclusive branches
may consume the same incoming linear value once per path, but joins must agree
on the resulting ownership state.

### Effect primitives

```text
effect.perform
effect.resume
effect.abort
host.call
```

Source-defined handlers should lower through handler passing or CPS before the
flat GPU boundary. Operations that remain at the module boundary become typed
`host.call` operations. Portable asynchronous effects require a separately
specified task/poll protocol and are not part of this roadmap.

### Deliberate non-primitives

Do not introduce Core or GPU opcodes for:

- `IntoIterator`, `Iterator`, `List`, or protocol names;
- modules, imports, namespaces, or export records;
- extension lookup or custom operator lookup;
- `for`, `loop`, `break`, or `continue`;
- `struct`, type aliases, `forall`, or type reflection syntax;
- `text_find`, `path_basename`, JSON, Base64, or other prelude algorithms.

Those behaviors must be built from compile-time dictionaries, source functions,
CFG edges, products, sums, closures, buffers, and scalar operations.

## Ordered implementation tasks

The phases below are dependency ordered. A later phase must not add a temporary
source-language special case to bypass an unfinished earlier phase.

## Phase 0: Freeze and parse the live target

- [x] Record the sibling Binned revision used for the editor, Codex, preludes,
      and the additional top-level applications.
- [x] Vendor the required prelude and application sources or add stable fixtures
      that do not depend on an unrecorded sibling working tree.
- [x] Import the latest production grammar and regenerate the Baba artifacts.
- [x] Parse no-demand lambda parameters such as `_ => value`.
- [x] Parse shorthand record values such as `{ shape, new }`.
- [x] Parse handler and named constructor records such as `Do { unwrap: ... }`.
- [x] Parse call postfixes after inline conditional and match expressions.
- [x] Parse hexadecimal integer literals with checked target-width lowering.
- [x] Parse `f32` and `f64` literals without passing them through JavaScript
      `number` when that would lose source precision.
- [x] Represent the minimum signed `i64` without first rejecting its unsigned
      literal magnitude.
- [x] Add a syntax test covering every vendored prelude and selected
      application.

Exit criterion: every recorded target reaches semantic analysis, so no remaining
target is hidden behind a syntax error.

## Phase 1: Canonical primitive registry and builtin universe

- [x] Introduce stable `PrimitiveId` and `BuiltinTypeId` representations.
- [x] Give every primitive one descriptor containing its signature, stage,
      effects, validation, and eventual lowering.
- [x] Add builtin types for `I32`, `I64`, `F32`, `F64`, `F32x4`, `Bool`, `Char`,
      `Text`, `Bytes`, and `Unit`.
- [x] Canonicalize arithmetic, comparison, bitwise, shift, conversion,
      reinterpretation, SIMD, trap, buffer, and UTF-8 builtin names.
- [x] Resolve source spellings such as `@append`, `@panic`, `@len`, `@get`,
      `@slice`, and `@Utf8.encode` at the source boundary.
- [x] Remove module-path/export-name string dispatch once every current use has
      migrated to canonical primitive IDs.
- [x] Test primitive arity, operand types, result types, stage restrictions,
      effects, and source diagnostics independently of the backend.

Exit criterion: type inference and later passes receive canonical IDs rather
than interpreting source names repeatedly.

## Phase 2: Real module graph

- [x] Introduce stable `ModuleId`s.
- [x] Thread module-qualified symbol identities through resolution.
- [x] Add a source provider for relative files and bundled `duck:` modules.
- [x] Parse and analyze each module once per canonical source and parameter
      environment.
- [ ] Resolve imports to exported symbol IDs instead of splicing raw statements.
- [ ] Preserve the complete transitive environment of exported functions,
      constants, types, protocols, extensions, and fixities.
- [ ] Represent namespace selection as compile-time module projection.
- [ ] Represent parameterized modules as compile-time functions from parameter
      records to export records.
- [x] Detect import cycles with the complete module path in the diagnostic.
- [ ] Cache module instances by source identity, source hash, compiler version,
      and canonical compile-time arguments. The instance key and cache exist and
      cover all four components; the argument component stays empty until
      parameterized modules become compile-time functions.
- [ ] Delete the exported-function hoisting path after all callers use the
      module graph.
- [x] Test that `citation_parser.duck` retains the captured `texts` binding.
- [x] Test that importing `duck:prelude/iterators` makes `IntoIterator` and its
      extensions visible to the editor.

Exit criterion: imports never lose lexical captures or declarations, and module
behavior no longer depends on statement concatenation order.

## Phase 3: Compile-time normalization and specialization

- [ ] Implement the complete `ConstValue` domain.
- [ ] Evaluate compile-time closures with immutable lexical environments.
- [ ] Evaluate compile-time products, sums, projection, and extension.
- [ ] Evaluate type constructors and canonicalize applications to `TypeId`s.
- [ ] Implement structural type reflection over canonical type values.
- [ ] Specialize `const` parameters and `forall` type parameters.
- [ ] Represent protocol evidence as a compile-time dictionary.
- [ ] Select extension implementations using canonical receiver types.
- [ ] Reject missing, ambiguous, and incoherent implementations before Core.
- [ ] Preserve binding-time environments across type aliases and extension
      layers.
- [ ] Add explicit fuel and recursion diagnostics for non-terminating
      compile-time evaluation.
- [ ] Erase all compile-time-only bindings and values before Core construction.
- [ ] Replace scalar-only comptime evaluation and ad hoc static closure
      substitution after equivalent behavior is covered.

Milestones:

- [ ] `prelude_types.duck` normalizes to an export module without reaching FCG.
- [ ] `prelude.duck` normalizes using the source-defined type builders.
- [ ] `prelude_functional.duck`, `prelude_list.duck`, and
      `prelude_iterators.duck` specialize their generic source definitions.

Exit criterion: Core is monomorphic and contains no modules, type values,
protocol search, extension search, or compile-time closures.

## Phase 4: SSA Core and structured control flow

- [ ] Define immutable Core tables for functions, blocks, block parameters,
      values, operations, terminators, and source spans.
- [ ] Validate block ownership, unique value definitions, dominance, edge arity,
      edge types, and terminator presence.
- [ ] Lower lexical shadowing to fresh `ValueId`s.
- [ ] Lower statement-only blocks and branches to `Unit` plus continuation
      edges.
- [ ] Lower expression `if` and `match` to join blocks with result parameters.
- [ ] Lower unbounded loops to header and exit blocks.
- [ ] Pass every carried binding on loop back-edges and exits.
- [ ] Lower bare and valued `break` without mixing their result signatures.
- [ ] Lower `continue` to the nearest loop header.
- [ ] Lower early `return` to a function terminator.
- [ ] Preserve nested loop and match control boundaries.
- [ ] Lower dynamic ranges after evaluating start, end, and step once.
- [ ] Reject a static zero range step and emit a dynamic zero-step trap edge.
- [ ] Lower collection loops after protocol specialization, without a
      collection-specific backend loop.
- [ ] Replace recursive-function loop lowering after Core covers its tests.

Milestones:

- [ ] Statement-only branches in the Base64, JSON, and time preludes reach Core.
- [ ] Nested loops in JSON encoding reach Core.
- [ ] Valued loop exits in the grep application reach Core.
- [ ] Dynamic ranges in the tar application reach Core.

Exit criterion: all source control flow is represented only by blocks,
terminators, and edge arguments.

## Phase 5: Aggregate and buffer semantics

- [ ] Assign canonical semantic types to tuples, records, arrays, and unions.
- [ ] Lower construction, projection, functional update, tag access, and payload
      access to Core value primitives.
- [ ] Define `LayoutId` independently from `TypeId`.
- [ ] Calculate size, alignment, field offsets, union tags, and payload storage
      deterministically.
- [ ] Choose and document physical representations for owned and frozen `Text`
      and `Bytes`.
- [ ] Lower semantic buffer operations to allocation, length, bounds checks,
      loads, stores, and copies.
- [ ] Implement UTF-8 encode/decode at the runtime boundary or from buffer
      primitives with equivalent validation.
- [ ] Lower generic source `List` through ordinary sum/product layout; do not
      add list opcodes.
- [ ] Add deterministic out-of-bounds traps for buffer and aggregate indexing.
- [ ] Replace opaque managed text handles where a linear-memory representation
      is required, while retaining an adapter for host strings.

Exit criterion: no product, projection, record update, union, buffer, or index
operation reaches flat Core without an assigned layout strategy.

## Phase 6: Closure conversion and calls

- [ ] Compute free variables for every runtime function.
- [ ] Lift nested functions to top-level code identities.
- [ ] Build typed closure environments from captured values.
- [ ] Preserve direct calls when the callee is statically known.
- [ ] Lower first-class calls to a code-table index plus environment pointer.
- [ ] Add `call_indirect` signature validation.
- [ ] Preserve recursive and mutually recursive closure groups.
- [ ] Carry resource classifications into closure environment fields.
- [ ] Reject reusable closures that would duplicate a linear capture.
- [ ] Compile iterator records and combinators without iterator-specific backend
      behavior.

Milestones:

- [ ] `prelude_iterators.duck` reaches layout planning.
- [ ] The editor reaches flat Core with iterator methods fully specialized.
- [ ] The Codex citation parser reaches flat Core with its module captures
      intact.

Exit criterion: flat Core contains direct or indirect calls only; it contains no
nested source functions.

## Phase 7: Ownership, regions, effects, and ABI

- [ ] Replace global linear-use counting with path-sensitive resource states.
- [ ] Require compatible resource states at CFG joins.
- [ ] Insert explicit drops on every owning exit edge.
- [ ] Lower borrow lifetimes to checked regions.
- [ ] Prove freeze transitions and erase or lower them according to layout.
- [ ] Lower scratch blocks to region enter, allocate, cleanup, and exit edges.
- [ ] Prevent region-backed values from escaping their region.
- [ ] Elaborate source-defined handlers through handler passing or CPS.
- [ ] Enforce affine or linear use of resumptions.
- [ ] Lower unresolved module-boundary effects to typed host calls.
- [ ] Extend the managed ABI to aggregate arguments and results only after their
      layouts and ownership transfers are explicit.
- [ ] Keep asynchronous effects reserved until a portable task/poll contract
      exists.

Exit criterion: every Core function has validated resource, cleanup, effect, and
host-boundary plans before flattening.

## Phase 8: Flat Core and GPU passes

- [ ] Version a new flat schema with structure-of-arrays columns for functions,
      signatures, blocks, block parameters, values, operations, operands,
      terminators, edges, layouts, and source locations.
- [ ] Use integer IDs for every cross-reference and validate every range.
- [ ] Preserve deterministic source order for initial IDs.
- [ ] Represent successor arguments explicitly rather than through region IDs.
- [ ] Round-trip structured Core to flat Core and back in tests.
- [ ] Port rewrite matching from adjacent stack instructions to value-use
      graphs.
- [ ] Resolve rewrite conflicts by stable profit and source/value order.
- [ ] Rebuild immutable snapshots after accepted rewrite batches.
- [ ] Add GPU differential validation against the CPU Core validator and
      rewriter.
- [ ] Structure reducible CFGs into Wasm regions and diagnose or dispatch-lower
      irreducible CFGs.
- [ ] Stackify values, assign locals, and calculate branch signatures.
- [ ] Calculate binary sizes and offsets with count-scan-write passes.
- [ ] Emit byte-identical CPU and GPU Wasm for every admitted target.

Exit criterion: the GPU consumes only validated flat Core and performs no source
name lookup, typeclass search, module resolution, ownership policy, or ABI
policy.

## Phase 9: Application milestones and performance

- [ ] Compile every recorded prelude module independently to its intended stage:
      compile-time export module, runtime library, or host interface.
- [ ] Compile and execute the editor with its declared host interface.
- [ ] Compile and execute the Codex application with its declared host
      interface.
- [ ] Compile and execute grep and tar, including dynamic control flow.
- [ ] Compile and execute wav after hexadecimal and bitwise coverage.
- [ ] Compile and execute the raytracer after `F32`, `F64`, and SIMD coverage.
- [ ] Record cold parser initialization separately from warm compilation.
- [ ] Record CPU semantic elaboration, flat-Core construction, GPU rewrite, GPU
      emission, transfer, and total timings separately.
- [ ] Compare CPU-only and GPU paths by source size, Core operation count,
      function count, and batch size.
- [ ] Preserve byte-identical output and deterministic diagnostics across
      repeated runs.

Exit criterion: compatibility and performance claims name the exact recorded
Binned revision, target set, hardware, execution mode, and measured pipeline
boundaries.

## Current live first-error inventory

This inventory records the first observed failure for each target, not every
failure hidden behind it. Re-run and update it after each phase.

| Boundary                    | Current examples                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Syntax drift                | cleared across 121 legacy and 35 frozen live sources                                                                                                                                                  |
| Module graph and namespaces | initial editor and Codex capture failures cleared; the graph now owns every followed import, so linking parses and analyzes each canonical source once; module values still use compatibility linking |
| Extension dictionaries      | editor reaches type-directed `IntoIterator.iterator` selection                                                                                                                                        |
| CFG and loop edges          | Codex citation parser reaches branch-local `next_parser`; attributes, Base64, JSON, JSON encode, time, grep, and tar                                                                                  |
| Staged types and literals   | collections, iterators, JSON values, numeric, numeric parse                                                                                                                                           |
| Primitive canonicalization  | stable IDs cover scalar, SIMD, buffer, UTF-8, and trap operations; legacy intrinsic dispatch remains                                                                                                  |
| ABI and layout              | effects prelude                                                                                                                                                                                       |

## Completion rule

A feature is complete only when:

1. its source behavior is represented by the appropriate pre-GPU primitive;
2. the semantic and resource validators accept or reject it with source
   evidence;
3. its high-level representation is erased or lowered before flat Core;
4. focused tests cover the observable behavior and its actual boundary cases;
5. the recorded Binned milestone advances;
6. CPU and GPU paths agree wherever both are implemented;
7. `deno task check` and `deno task test` pass.

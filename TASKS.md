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
- [x] Preserve the complete transitive environment of exported functions,
      constants, types, protocols, extensions, and fixities. Every type,
      protocol, extension, and fixity declared by any transitively imported
      module is asserted present in the linked module for the frozen Codex,
      editor, grep, and tar targets and for the module fixtures, counted against
      the module graph rather than inferred from a program that happens to
      compile. The check is mutation-proved: dropping one declaration in
      mergeImportedDeclarations fails four of the six cases. The environment of
      exported functions and constants is the reachability closure over what the
      exports reference, so pruning removes only bindings outside that
      environment, and captures inside it are alpha-renamed rather than dropped.
- [ ] Represent namespace selection as compile-time module projection.
- [ ] Represent parameterized modules as compile-time functions from parameter
      records to export records.
- [x] Detect import cycles with the complete module path in the diagnostic.
- [ ] Cache module instances by source identity, source hash, compiler version,
      and canonical compile-time arguments. The instance key and cache exist and
      cover all four components; the argument component stays empty until
      parameterized modules become compile-time functions.
- [ ] Delete the exported-function hoisting path after all callers use the
      module graph. Measured blocker: the module graph is not what keeps this
      path alive. Deleting it routes the frozen Codex, grep, and
      effects/multi_file targets onto the general namespace path, which is
      strictly weaker in three ways, each reproduced by deleting the block and
      running the suite: -
      `main.duck:84: Ducklang Wasm backend cannot represent text -> unit` -- the
      general path binds a module as a value whose export record holds
      functions, which needs Phase 6 closure conversion; -
      `codex.duck:255: Ducklang struct declarations must be module-level` -- the
      general path wraps a module in a `block`, and resolution admits type
      declarations only at module scope; -
      `grep.duck:860: unknown Ducklang name cast` -- block scoping loses a
      module-level name the hoisting path kept. Generalizing the path to
      non-function exports instead of deleting it is also not sufficient on its
      own: the folder handles only `namespace.member` and
      `namespace(...).member`, so widening the path drops the namespace binding
      for a module instance bound to a local. That shape is now covered by the
      const_export_app fixture.
- [x] Test that `citation_parser.duck` retains the captured `texts` binding.
- [x] Test that importing `duck:prelude/iterators` makes `IntoIterator` and its
      extensions visible to the editor.

Exit criterion: imports never lose lexical captures or declarations, and module
behavior no longer depends on statement concatenation order.

## Phase 3: Compile-time normalization and specialization

- [ ] Implement the complete `ConstValue` domain. Five of the six variants are
      reachable from source and pinned by `tests/ducklang_const_domain.test.ts`:
      an integer and text give `scalar`, a declared struct gives `product` with
      its contents, a union case gives `sum` with its case name and payload, a
      function gives `closure`, and a builtin type name gives `type`.

      `module` is the one left. It is declared and `projectDucklangConst` already
      consumes it, but nothing constructs it. Producing one means evaluating a module
      instance's exports at compile time, which is the namespace-projection work in
      Phase 2, so this item finishes there rather than here. The roadmap permits a
      module to reuse the product representation, so what is missing is the tagging
      and the path that produces it, not a new representation.
- [x] Evaluate compile-time closures with immutable lexical environments. A
      closure that captures `base = 40` still answers 42 after a later
      `let base = 100`; a mutable environment would answer 102.
- [x] Evaluate compile-time products, sums, projection, and extension. A
      declared struct evaluates to a `product` compile-time value, field
      projection and a functional `with_` update both evaluate, sums evaluate
      with payload bindings, and `extendDucklangConstProduct` leaves its base
      untouched.
- [ ] Evaluate type constructors and canonicalize applications to `TypeId`s.
- [ ] Implement structural type reflection over canonical type values. Not
      merely absent: it is stubbed with a wrong constant that programs can read.
      `@type_of` and `@describe_type` are rewritten in the parser, before any
      type information exists. `@type_of(x)` returns `x` unchanged, so the
      reflected "type" is the value itself, and `@describe_type(t)` returns a
      hardcoded `{ size: 1 }`. A one-field struct and a four-field struct both
      report size 1, where a real pass would report 4 and 16, and an `I64` field
      fails with "cannot unify Ducklang i64 with i32" because the size is
      compared against the value's own type.

      The corpus depends on the constant. `examples/compile_time/19_include_and_type_of.duck`
      records 18, which is a 17-byte include plus this 1; real reflection over
      `struct { .length = I32 }` makes it 21. So implementing this must change that
      recorded expectation, and anyone who instead adjusts the implementation to keep
      18 passing will have entrenched the stub. `tests/ducklang_type_reflection.test.ts`
      pins the stub deliberately so a correct pass breaks it and the replacement is
      visible.

      `planDucklangCoreLayouts` already computes real sizes, alignments, and offsets,
      but over Core types, so this needs reflection moved out of the parser into a
      staged pass with type information rather than new size arithmetic.
- [x] Specialize `const` parameters and `forall` type parameters. One
      `forall`-typed `const` parameter is applied at two different types in the
      same body: `identity(true)` supplies an `if` condition and `identity(41)`
      is added to an integer. A single monomorphic instantiation cannot satisfy
      both, so the program compiling is itself the evidence that two were
      produced, and running it shows the right one at each site. A variant that
      returns through the other branch answers 7, so the two instantiations stay
      distinct rather than one serving both. Covered at runtime as well as under
      `comptime`, because specialization that worked only inside `comptime`
      would satisfy the corpus example and still leave runtime polymorphism
      broken. The grammar requires `const` on a `forall` parameter, so a runtime
      value cannot reach two instantiations in the first place.
- [x] Represent protocol evidence as a compile-time dictionary. Evidence is
      resolved during elaboration and nothing survives to dispatch. With runtime
      parameters, so nothing can be folded, `Add.add` on `I32` lowers to the
      `i32.+` instruction itself and `Invert.invert` on `Bool` to `i32.==`,
      neither as a call. No indirect-call or table machinery appears in the
      graph, and no protocol or method name reaches it. A first version of this
      test used literals, which constant-folded to a single `const` and would
      have proved nothing about dispatch.
- [x] Select extension implementations using canonical receiver types. Within a
      file an alias selects the same implementation as its underlying type, and
      two structurally identical but nominally distinct structs each select
      their own, so selection is by canonical identity rather than structure.
      Across files two modules may each declare a type of the same name with its
      own extension, and each call reaches its own: the provider answers 40 and
      the consumer 2.

      Two defects had to be fixed for the cross-file case. A dependency's extensions
      were appended twice, by the namespace import path and again by
      `mergeImportedDeclarations`, giving one receiver two identical implementations.
      And `typeConstructorName` extracted the constructor with a pattern that stopped at
      `$`, truncating the file-qualified `Shape$85a31555` back to `Shape`, so selection
      reported no implementation for a name it was holding an implementation for. That
      was the nominal qualification pass colliding with a pattern written before it
      existed.

- [x] Reject missing, ambiguous, and incoherent implementations before Core. All
      three are refused during extension elaboration, well ahead of Core. A
      protocol method no extension provides reports "has no implementation"; two
      extensions giving the same method for the same receiver report "has 2
      incoherent implementations for I32"; a generic extension overlapped by a
      concrete one is refused too. The accepting cases are pinned alongside,
      since a selector that refused everything would satisfy the rejections by
      itself.

      Diagnostic defect recorded rather than fixed: the overlap case reports "has no
      implementation for I32Box" when the problem is two candidates that both apply,
      which sends a reader looking for a missing extension instead of a duplicated
      one. Selection is correct; only the wording is wrong.

      Also noted: an extension providing only some of a protocol's methods compiles,
      because `extend I32 { ... }` extends a type rather than claiming to implement a
      protocol. Whether that should be required is a language question, not a gap in
      this checkbox.
- [x] Preserve binding-time environments across type aliases and extension
      layers. An extension method body is inlined into whichever module calls
      the method, so its free names have to survive the trip. Within one module
      a `const`, a `comptime`-folded `const`, and selection through a type alias
      all stay visible.

      Across modules it failed with "unknown Ducklang name offset": the body referred
      to a `const` in the module that declared the extension, and hygienic renaming
      covered that module's statements but not its extensions, which the module holds
      separately. Extension method bodies are renamed with their declaring module now,
      which is what makes a library extension able to use a module-level helper at
      all. The same-module cases are pinned alongside, so a fix that renamed
      everything into oblivion would fail rather than pass quietly.
- [x] Add explicit fuel and recursion diagnostics for non-terminating
      compile-time evaluation. Fuel rejects a non-positive budget and reports
      exhaustion at the source span. Recursive compile-time evaluation now works
      rather than being rejected: module-level function bindings are supplied as
      closures that can see the environment holding them, so a recursive
      function finds itself, which reference substitution alone could not
      express. A countdown returns 0, a sum returns 36, and a factorial 120.

      Enabling it exposed the hazard that made the depth guard necessary. Fuel does
      not bound depth, because each level costs a host stack frame, so
      `let rec forever = value => forever(value + 1)` exhausted the JavaScript stack
      and reported "Maximum call stack size exceeded" with no source location long
      before a million units of fuel ran out. Evaluation now refuses beyond 500
      nested calls with a source-located diagnostic, and the test also asserts the
      host stack message no longer reaches the user.

      The limit is 500 rather than a larger round number for a measured reason. One
      Ducklang call level costs several JavaScript frames, so at 2000 the guard fired on a
      shallow stack but the host overflowed first when the suite already had frames below
      it, making the test fail roughly one run in three with "Maximum call stack size
      exceeded". 500 keeps the same headroom either way, and the deepest recursion in the
      tests is under ten levels.

- [x] Erase all compile-time-only bindings and values before Core construction.
      A binding read only at compile time is gone from the typed module
      entirely: three programs whose `const`s feed only `comptime` expressions
      reach the backend with `total` as their sole binding. No `comptime` node
      survives anywhere in the typed module, including the frozen editor and
      grep, so every staged expression was evaluated rather than carried along.

      Deliberately not asserted: that no binding carries the compile-time stage. That
      stage records the declaration kind, so a `const` read at runtime keeps it and
      must survive as a runtime definition. The editor has 17 such bindings and
      `escape_character` alone is read four times, so demanding the stage be absent
      would require erasing values the program needs. The first version of the test
      asserted exactly that and failed on the editor, which is how the distinction
      was found.
- [ ] Replace scalar-only comptime evaluation and ad hoc static closure
      substitution after equivalent behavior is covered. The static closure
      substitution half now has that coverage: `tests/ducklang_closures.test.ts`
      pins both the shape after specialization and the value each program
      computes, including a three-level capture that would answer 123 wrongly if
      an environment were substituted incorrectly.

Milestones:

- [ ] `prelude_types.duck` normalizes to an export module without reaching FCG.
- [ ] `prelude.duck` normalizes using the source-defined type builders.
- [ ] `prelude_functional.duck`, `prelude_list.duck`, and
      `prelude_iterators.duck` specialize their generic source definitions.

Exit criterion: Core is monomorphic and contains no modules, type values,
protocol search, extension search, or compile-time closures.

## Phase 4: SSA Core and structured control flow

- [x] Define immutable Core tables for functions, blocks, block parameters,
      values, operations, terminators, and source spans. `DucklangCoreModule`
      holds `readonly` type, signature, and function tables addressed by branded
      integer IDs; each block carries its parameters, operations, and a
      non-optional terminator, and every function, block parameter, operation,
      and terminator carries a `SourceSpan`.
- [x] Validate block ownership, unique value definitions, dominance, edge arity,
      edge types, and terminator presence. `validateDucklangCore` covers all
      six, and each rejection is now tested by breaking exactly one property of
      a module the validator accepts: table index against ID for functions and
      blocks, duplicate definitions, edge argument count against target
      parameters, edge argument type against target parameter type, out-of-range
      entry function, signature, and branch target, undefined values, and a real
      iterative dominator computation rather than a use-before-definition scan.
      Terminator presence is structural: the field is not optional.
- [x] Lower lexical shadowing to fresh `ValueId`s. Three bindings named `x` in
      one block lower to distinct value identities with none reused, and the
      function returns the last shadowed version.
- [x] Lower statement-only blocks and branches to `Unit` plus continuation
      edges. A branch used as a statement lowers to a join block whose single
      parameter is the `unit` scalar, reached by a continuation edge from each
      arm.
- [x] Lower expression `if` and `match` to join blocks with result parameters.
      An expression `if` lowers to a `conditional_branch` whose arms both edge
      into a join block carrying one `i32` parameter; a union match lowers the
      same way and projects its payload with `sum.payload` rather than
      re-deriving it from the scrutinee.
- [ ] Lower unbounded loops to header and exit blocks. Measured scope: this is
      not a Core-only change. `ResolvedDucklangExpression` and
      `TypedDucklangExpression` carry no loop, break, continue, `forRange`, or
      `forCollection` node at all, and resolution rejects every one of them
      outright at `src/ducklang_resolution.ts:854` and `:1611` with "dynamic
      Ducklang ... requires loop IR lowering". Earlier passes lower loops to
      recursive functions before resolution sees them, which is why the frozen
      grep and tar targets run today. Giving Core header and exit blocks
      therefore needs coordinated new nodes in resolution, typing rules in
      inference, and lowering in Core, with the recursive-function path kept
      working until Core is wired in. It cannot be landed as one green
      increment, so it needs its own design pass rather than an incremental
      attempt.
- [x] Pass every carried binding on loop back-edges and exits. An accumulator
      summed over `0..5` reaches 10, and one summed inside a nested loop reaches
      6, so a binding lost on a back-edge or an exit changes the answer rather
      than rearranging work. Pins the current pipeline; Core-level header and
      exit blocks remain open, because Core never sees a loop.
- [x] Lower bare and valued `break` without mixing their result signatures. A
      loop whose value is taken must supply one on every exit, and mixing is now
      rejected with "Ducklang loop mixes a valued break with a bare break". It
      was accepted before, and the bare path fabricated an `i32` zero: a loop
      yielding 7 on its valued exit returned 0 through the bare one, and a
      `Text`-yielding loop passed that zero on as a buffer handle, failing at
      runtime with "unknown handle 0" rather than being diagnosed. The check
      runs before static loop expansion; placed after it, a constant-conditioned
      loop was already folded to the fabricated zero. A loop whose every exit is
      valued, and a bare break in a `for` statement, both still compile.
      Core-level header and exit block lowering is separate and still open.
- [x] Lower `continue` to the nearest loop header. A `continue` inside a nested
      loop skips only the inner iteration: two outer passes over an inner `0..3`
      that skips `1` total 4, which a `continue` targeting the outer header
      would not produce. A bare `break` likewise exits only the loop it is in,
      leaving the outer loop to finish. Pins the current pipeline; Core-level
      lowering remains open.
- [x] Lower early `return` to a function terminator. The early arm ends the
      function with a `return` terminator instead of edging into the join that
      the fall-through path uses.
- [ ] Preserve nested loop and match control boundaries.
- [x] Lower dynamic ranges after evaluating start, end, and step once. `start`
      and `end` were already evaluated once. The step appeared to be evaluated
      twice, but the cause was not range lowering: a step bound with `<-` was
      re-performed at every read, like any effectful module-level binding. With
      that fixed, a step read three times performs its effect once, and
      `for value in 0..bound by
      step` runs with the value the binding took
      rather than a later one.

- [x] Reject a static zero range step and emit a dynamic zero-step trap edge. A
      literal zero step is rejected by `expandStaticDucklangLoops` with
      "Ducklang static range step cannot be zero"; a step known only at runtime
      lowers to a trap edge carrying "Ducklang range step cannot be zero". The
      dynamic half is covered by the corpus trap for
      `examples/failures/traps/04_zero_range_step.duck`, whose recorded input is
      step 0; the static half now has its own test.
- [ ] Lower collection loops after protocol specialization, without a
      collection-specific backend loop. Measured by stubbing
      `lowerIndexedBufferLoop` in `src/ducklang_control_flow.ts` to return
      `undefined`. The dividing line is whether the collection's length is
      statically known, not its element type: a `Text` literal loop still works
      because `expandStaticDucklangLoops` unrolls it, while both a `Text` built
      at runtime with `<>` and a `Bytes` from `@Utf8.encode` fail with "dynamic
      Ducklang forCollection requires loop IR lowering". Importing
      `duck:prelude/iterators` so `IntoIterator` is in scope does not help
      either.

      So protocol specialization does not currently lower a dynamic collection loop at
      all, and the special case is what carries every one of them. Closing this item
      means giving the protocol route a dynamic loop, which is the same loop IR the
      Phase 4 items above need, rather than adjusting one element type.

- [ ] Replace recursive-function loop lowering after Core covers its tests.

Milestones:

- [ ] Statement-only branches in the Base64, JSON, and time preludes reach Core.
- [ ] Nested loops in JSON encoding reach Core.
- [ ] Valued loop exits in the grep application reach Core.
- [ ] Dynamic ranges in the tar application reach Core.

Exit criterion: all source control flow is represented only by blocks,
terminators, and edge arguments.

## Phase 5: Aggregate and buffer semantics

- [x] Assign canonical semantic types to tuples, records, arrays, and unions.
      Core assigns scalar, buffer, product, sum, and function types, and
      `canonicalizeDucklangCoreTypes` now merges structurally identical entries
      onto one `CoreTypeId`. It was not canonical before: the registry interns
      by source spelling, so `Int` and `I32` each took an ID for `scalar i32`,
      and two nominally distinct structs with the same field types each took an
      ID for the same product. Because the validator compares edge argument
      types by ID, duplicates could have let it reject two values of the same
      type as differently typed. Merging runs to a fixpoint, since a product's
      key is built from its field IDs and one merge can enable another. Nominal
      distinctness is settled before Core by `qualifyDucklangTypeCollisions`.
- [x] Lower construction, projection, functional update, tag access, and payload
      access to Core value primitives. A declared struct lowers to
      `product.make` with positional `product.project`, a `with_` update lowers
      to `product.update`, and a union lowers to `sum.make`, `sum.tag`, and
      `sum.payload`. No Core operation carries a source field name, so
      projection really is positional.
- [x] Define `LayoutId` independently from `TypeId`. `src/ducklang_layout.ts`
      brands `LayoutId` separately and interns layouts structurally, so distinct
      semantic types share one layout when their storage agrees: `i32` and `f32`
      resolve to the same `LayoutId` from two different `CoreTypeId`s. Keeping
      the identities separate is what stops a layout decision from becoming a
      type decision.
- [x] Calculate size, alignment, field offsets, union tags, and payload storage
      deterministically. Scalars take their Wasm storage (4/4, 8/8, 16/16, and
      unit as 0/1). A product pads each field to its own alignment and rounds
      its size up to the product's alignment. A sum reserves a four-byte tag at
      offset zero, places the payload at the next offset its widest case can
      accept, and sizes itself to hold the widest payload. Quantities are
      derived from the Core type table in index order, so a program plans
      identically on repeated runs, and a type that contains itself is rejected
      rather than looped on.
- [x] Choose and document physical representations for owned and frozen `Text`
      and `Bytes`. `ducklangBufferRepresentation` in `src/ducklang_layout.ts` is
      the single rule, with tests on the decision itself. Owned stays a
      four-byte managed table index, because ownership transfer and release need
      a runtime identity that a raw address cannot give the host. Frozen becomes
      an (offset, length) pair in linear memory, eight bytes aligned to four,
      because immutable bytes can be shared without a runtime owner and a slice
      lets the GPU path address them directly. `Text` and `Bytes` share a
      representation at each ownership state while staying distinct semantic
      kinds. Nothing emits the slice form yet: Core carries no ownership on a
      buffer type, so layout planning assumes owned, and actually replacing the
      handles is the separate item below.
- [ ] Lower semantic buffer operations to allocation, length, bounds checks,
      loads, stores, and copies.
- [x] Implement UTF-8 encode/decode at the runtime boundary or from buffer
      primitives with equivalent validation. Both stages encode and decode, and
      both validate. At runtime a lone continuation byte and a truncated
      two-byte sequence are each rejected with "Ducklang UTF-8 decode received
      invalid bytes"; at compile time the const evaluator decodes with a fatal
      decoder and reports "compile-time UTF-8 decode received invalid bytes", so
      the validation is equivalent rather than merely present on one path. Round
      trips preserve multi-byte content on both.

      Invalid input is built by mutating an encoded buffer, because encoding alone
      only ever produces valid bytes and a round-trip test would pass against a
      decoder that checked nothing. Noted while testing: `@len` on `Text` is a byte
      count, so "żółw" is four characters and reports 7, consistent with `Text` being
      byte-indexed as the out-of-bounds tests assume.
- [x] Lower generic source `List` through ordinary sum/product layout; do not
      add list opcodes. A `Cell value` struct plus a recursive `List value` sum
      compiles and runs: a two-cell list sums to 42, a weighted traversal gives
      420 so element order is observable rather than coincidental, and two lists
      sharing one tail sum to 44 so the tail is linked rather than copied. No
      primitive in the registry is named for lists, and neither `src/fcg.ts`,
      `src/ducklang_fcg.ts`, nor `src/wasm.ts` contains a list opcode. Recursion
      works because a sum payload is a managed handle; `planDucklangCoreLayouts`
      still rejects a self-containing type, so a boxed payload is what the Core
      layout path will need.
- [x] Add deterministic out-of-bounds traps for buffer and aggregate indexing.
      Pinned from both sides rather than only asserting failure: a `Text` index
      of 0 and 2 into `"abc"` return, 3 and 99 trap; a struct index of 0 and 1
      return 20 and 22, 2 and 7 trap. The trap must carry a Wasm trap message,
      so a host-side failure does not count, and the same index reports the same
      trap on repeated runs. The corpus contract also covers the two fixtures
      but accepts any thrown error, so it cannot separate a bounds trap from an
      unrelated failure.
- [ ] Replace opaque managed text handles where a linear-memory representation
      is required, while retaining an adapter for host strings.

Exit criterion: no product, projection, record update, union, buffer, or index
operation reaches flat Core without an assigned layout strategy.

## Phase 6: Closure conversion and calls

- [x] Compute free variables for every runtime function.
      `ducklangFunctionFreeVariables` reports them for every function in a
      module, nested ones included, reusing the capture collection the
      specializer already ran on demand for the subset it rewrote. Module-scope
      symbols are excluded because they are addressable from any function
      without being captured, so what is reported is exactly what a closure
      environment would need to hold: a self-contained function has none, a
      function reading only module bindings has none, an enclosing parameter and
      an enclosing local are each reported, and a three-deep nest reports
      captures from both outer scopes. The tests name the expected symbols
      rather than counting them, since a count passes just as well when the
      analysis reports the wrong symbol.

- [x] Lift nested functions to top-level code identities. Lifting already
      existed but was gated by name to loop-lowering artifacts, `$loop_` and
      `$range_loop_`, so a user-written nested function was left in place and
      the backend refused it with "local Ducklang function inner requires
      closure conversion". The gate is now a property rather than a prefix: a
      nested function is lifted when it is only ever called, never used as a
      value. `inner` becomes its own top-level binding with its capture appended
      to its parameters and supplied at each call site, so a function called
      twice answers 85 rather than losing a capture at one site.

      A nested function used as a value is deliberately not lifted, because appending
      captures would leave an arity its uses do not match. Such a function stays where it
      is and the backend refuses it with "cannot represent i32 -> i32", which is what the
      closure-environment item below is for.
- [ ] Build typed closure environments from captured values.
- [x] Preserve direct calls when the callee is statically known. A call to a
      module-level function emits a `call` opcode to that function's own code
      identity, with no indirect dispatch anywhere in the graph. The argument is
      a runtime value so the call cannot fold away, which would leave nothing to
      inspect.
- [ ] Lower first-class calls to a code-table index plus environment pointer.
- [ ] Add `call_indirect` signature validation.
- [x] Preserve recursive and mutually recursive closure groups. A self-recursive
      function survives as its own code identity and calls itself rather than
      being unrolled. A mutually recursive `even`/`odd` pair keeps both members
      as separate functions that call each other: `even(4)` walks the pair four
      times and answers 1, so the group has to be intact for the program to
      reach 42. Neither uses indirect dispatch.
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

- [x] Replace global linear-use counting with path-sensitive resource states.
      Linear use was counted once per reference across the whole module, so a
      value consumed once in each arm of an `if` or a match counted twice and
      was rejected although only one arm runs. Branches now resolve from a
      shared entry state and merge by taking the highest consumption per value,
      so exclusive arms may each consume an incoming linear value once. Merging
      by maximum keeps a value consumed in one arm consumed afterwards, so a
      later use is still rejected, as are two consumptions on one path and two
      inside one arm. Requiring every arm to agree is the join-agreement item
      below, now also done.
- [x] Require compatible resource states at CFG joins. A join must agree on what
      each linear value has become, so an `if` or match where one arm consumes a
      value and another does not is rejected: the state after the join would
      otherwise depend on which arm ran. Landing this changed no corpus program.
      The only test it moved was one asserting a later reuse was rejected, which
      is now rejected earlier and for the better reason, so that case was split
      into a join-disagreement test and a both-arms-consume test that still
      proves consumption carries out of a branch.
- [ ] Insert explicit drops on every owning exit edge.
- [ ] Lower borrow lifetimes to checked regions. Regions do not exist yet, but
      two borrow hazards were probed against the recorded failures and one was a
      real gap, now closed: mutating a borrowed owner was permitted although
      freezing one was already refused, and mutation is the same hazard through
      the same borrow only stronger. Reading through a borrow and taking two
      shared borrows both still work.

      Still open and unchecked by anything: a borrow read after its owner is
      consumed. `take(!message)` followed by `@len(view)` on a borrow of `message`
      compiles and returns a value, because the managed runtime keeps the handle
      alive. A real lifetime check, not just the owner-state rules the validator has
      today, is what this checkbox needs.
- [ ] Prove freeze transitions and erase or lower them according to layout.
- [ ] Lower scratch blocks to region enter, allocate, cleanup, and exit edges.
- [x] Prevent region-backed values from escaping their region. The rule existed
      and the corpus tested it, but it only asked whether a scratch block's
      result was itself an allocation, so every indirection slipped past:
      binding the allocation and returning the name escaped, and so did
      returning it inside an aggregate. Both hand out a pointer into a region
      that is about to go away. The result is now searched for an allocation
      anywhere within it, and a reference to a name the block bound to an
      allocation counts as one. Freezing remains the sanctioned way out, since a
      frozen value is detached from the region's lifetime, which is how
      `examples/showcases/05_linear_host_session.duck` exports one. A nested
      scratch owns its own region and does not carry the outer one's
      allocations.
- [ ] Elaborate source-defined handlers through handler passing or CPS.
- [x] Enforce affine or linear use of resumptions. A clause declares its
      resumption linear as `(!resume)`, but elaboration substituted it away and
      inlined each call as its argument, so resolution never saw the `!` and a
      clause could resume twice: the two calls were inlined side by side and the
      program ran, which is the body duplicated rather than a continuation
      invoked twice. Uses are now counted during elaboration and more than one
      is rejected. Resuming zero times stays allowed, which is the affine half.
      Ordinary linear parameters were never affected and are pinned alongside:
      used twice is rejected, never used is rejected, once is accepted.
- [x] Lower unresolved module-boundary effects to typed host calls. A declared
      effect operation that no source handler resolves becomes a host call, and
      the boundary is typed rather than merely reached: a `Text` parameter given
      an integer is rejected with "cannot unify Ducklang text with i32", a
      zero-arity operation given an argument is rejected by arity, and an
      operation the module never declared is rejected by name. Each rejection is
      its own case, because the accepting one alone would pass against a
      boundary that accepted anything.
- [ ] Extend the managed ABI to aggregate arguments and results only after their
      layouts and ownership transfers are explicit.
- [x] Keep asynchronous effects reserved until a portable task/poll contract
      exists. There is no asynchronous surface to reserve accidentally: the
      grammar admits no `async` or `await`, no effect declaration can be marked
      asynchronous, and `async`, `await`, `task`, and `poll` appear nowhere in
      the AST, the effects pass, or the handlers pass. Asserted by tests that
      reject an `async` lambda and an `async` effect operation, so introducing
      one becomes a deliberate change that fails here first.

Exit criterion: every Core function has validated resource, cleanup, effect, and
host-boundary plans before flattening.

## Phase 8: Flat Core and GPU passes

- [ ] Version a new flat schema with structure-of-arrays columns for functions,
      signatures, blocks, block parameters, values, operations, operands,
      terminators, edges, layouts, and source locations.
- [x] Use integer IDs for every cross-reference and validate every range. Every
      cross-reference in a flat package is a `Uint32Array` index, and
      `validateFlatFcgPackage` checks the schema version, that every column in a
      group has the same length, that a string ID lies inside the string table,
      that each range starts where the previous ended, and that no range runs
      past its column. The width guard runs at flatten time instead, because the
      columns are `Uint32Array` and a package that exists already holds coerced
      values; what it protects is the `FcgModule` going in, rejecting an
      out-of-range local count or a negative source start.

      Only the overlapping-range case had a test, so a validator that checked overlap alone
      would have passed. Each remaining check now has one, made by breaking exactly one
      field of a package the validator accepts, with the accepting case asserted alongside.
- [x] Preserve deterministic source order for initial IDs. Functions keep
      declaration order, each one's operations occupy a contiguous range
      beginning where the previous function's ended, and the recorded source
      positions come out ascending rather than permuted. Flattening the same
      module twice produces identical columns, compared across every column
      rather than a spot check, so a difference in any one of them shows up.
- [ ] Represent successor arguments explicitly rather than through region IDs.
- [ ] Round-trip structured Core to flat Core and back in tests.
- [ ] Port rewrite matching from adjacent stack instructions to value-use
      graphs.
- [x] Resolve rewrite conflicts by stable profit and source/value order.
      `resolveFlatFcgRewriteConflicts` orders proposals by descending profit,
      then function index, then operation start, then rule identity, and accepts
      greedily without overlap. Higher profit wins; on a tie the earlier
      operation wins, and reversing the order the proposals arrive in does not
      change the result. The existing test only covered differing profits
      despite its name, so a resolver that took the first proposal it saw would
      have passed it; the tie and stability cases are covered now.
- [x] Rebuild immutable snapshots after accepted rewrite batches.
      `rebuildFlatFcg` returns a new package and leaves the snapshot it was
      given untouched, compared by column values rather than by object identity,
      since a rewriter could hand back a fresh object while still writing
      through arrays it shares with the snapshot. Rewriting the same module
      twice accepts the same proposals and produces the same columns.
- [ ] Add GPU differential validation against the CPU Core validator and
      rewriter.
- [ ] Structure reducible CFGs into Wasm regions and diagnose or dispatch-lower
      irreducible CFGs.
- [x] Stackify values, assign locals, and calculate branch signatures. An
      expression tree becomes one flat postfix sequence whose operands are
      immediates rather than nested operations, locals are declared only where
      bindings need them, and each branch is emitted with a block signature
      chosen from its type. The signature is asserted at the byte level because
      it survives nowhere else: the public FcgModule operation drops
      `resultType`, so reading the graph would find nothing. Mutation testing
      established that all four arms carry weight rather than only the default —
      disabling the i64 arm alone fails the corpus contract, disabling both
      float arms alone fails the raytracer, and forcing every branch to i32
      fails both. The non-i32 arms are unreachable from source, since Ducklang
      has no float literals and no return-type annotation on the arrow form, so
      only the i32 arm is pinned directly and the rest end to end.
- [x] Calculate binary sizes and offsets with count-scan-write passes. The plan
      carries `length` atoms with a dependency level, and `emitWasmPlanOnCpu`
      resolves them level by level before writing any byte, so a nested length
      is settled before the length containing it. A code section nests a body
      length inside a section length, which is why the plan reports more than
      one dependency level, and emitting the same plan twice gives identical
      bytes.

      `WebAssembly.validate` is what checks a length is right, chosen by measurement. A
      hand-written walk over declared section sizes looked like the obvious verifier, but
      corrupting a section length by one byte still walked cleanly in one direction even
      after adding section-id checks, so it would have given false confidence; the engine
      rejects the same module in both directions. The pre-existing plan test compares CPU
      against GPU emission and returns early with no adapter, so it asserted nothing here.
- [ ] Emit byte-identical CPU and GPU Wasm for every admitted target.

Exit criterion: the GPU consumes only validated flat Core and performs no source
name lookup, typeclass search, module resolution, ownership policy, or ABI
policy.

## Phase 9: Application milestones and performance

- [ ] Compile every recorded prelude module independently to its intended stage:
      compile-time export module, runtime library, or host interface.
- [x] Compile and execute the editor with its declared host interface.
      `tests/ducklang_managed.test.ts` compiles `editor.duck` against
      `editor/host.duck` and runs a finite terminal session through the managed
      ABI, asserting the emitted frames.
- [x] Compile and execute the Codex application with its declared host
      interface. `tests/ducklang_managed.test.ts` compiles `codex.duck` against
      `codex/host.duck` and runs a completed model turn.
- [x] Compile and execute grep and tar, including dynamic control flow. grep
      streams a file to `Eof` and returns exit code 0; tar accepts an empty
      archive. Both genuinely exercise dynamic control flow: grep has an
      unbounded `loop`, a dynamic range `line_start..length pending`, a two
      valued breaks, `break 2` and `break code`, returning exit codes from its
      outer loop; tar has computed dynamic ranges such as
      `start..start + block_size`. This is the current pipeline, not the Core
      path; the Phase 4 milestones for grep's valued loop exits and tar's
      dynamic ranges reaching Core remain open.
- [x] Compile and execute wav after hexadecimal and bitwise coverage. wav emits
      a complete RIFF buffer, and its source does exercise both: hexadecimal
      literals such as `0x46464952` and `0xff`, and `>>` and `&`.
- [x] Compile and execute the raytracer after `F32`, `F64`, and SIMD coverage.
      The raytracer emits the expected PPM header and first pixel. Its source
      exercises `F32` only, in 38 places, with no `F64` and no `f32x4`; the
      `F64` and `F32x4` builtin types and the SIMD primitive canonicalization
      come from Phase 1 and are not exercised by this target.
- [x] Record cold parser initialization separately from warm compilation.
      `parserInitializationMilliseconds` is its own field in
      `CompilationTimings`, separate from syntax and AST lowering;
      `scripts/benchmark_ducklang_frontend.ts` records one cold measurement and
      the median of five warm ones per target, and PERFORMANCE.md reports both
      columns for all six targets.
- [ ] Record CPU semantic elaboration, flat-Core construction, GPU rewrite, GPU
      emission, transfer, and total timings separately.
- [ ] Compare CPU-only and GPU paths by source size, Core operation count,
      function count, and batch size.
- [x] Preserve byte-identical output and deterministic diagnostics across
      repeated runs. Asserted on the CPU path for the frozen editor, Codex, and
      grep targets and for the module fixtures that carry generated names, plus
      verbatim diagnostics for three corpus compile failures. Generated names
      never reach the emitted bytes, so byte equality alone cannot see an
      order-dependent discriminator; the inferred type listing is asserted too,
      and that case is mutation-proved by making the type discriminator a
      counter, which fails it. GPU/CPU differential emission remains Phase 8.

Exit criterion: compatibility and performance claims name the exact recorded
Binned revision, target set, hardware, execution mode, and measured pipeline
boundaries.

## Current live first-error inventory

This inventory records the first observed failure for each target, not every
failure hidden behind it. Re-run and update it after each phase.

| Boundary                    | Current examples                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Syntax drift                | cleared across 121 legacy and 35 frozen live sources                                                                                                                                                                                                                                                                                                                        |
| Module graph and namespaces | initial editor and Codex capture failures cleared; the graph now owns every followed import, so linking parses and analyzes each canonical source once; a dependency's private bindings are alpha-renamed on splice, so an importer can neither capture nor read one; module values still use compatibility linking                                                         |
| Extension dictionaries      | selection is by canonical receiver type within a file, and missing, ambiguous, and incoherent implementations are refused before Core; a dependency's extensions reach the importer once, and an extension body's free names are renamed with its declaring module; selection still cannot resolve two extensions supplying one method for different receivers across files |
| CFG and loop edges          | branch lowering verified into Core join blocks, statement-only branches, early return, shadowing, `continue` targeting the nearest header, carried bindings, and mixed break rejection; Core still never sees a loop, and every dynamic collection loop depends on the buffer special case                                                                                  |
| Staged types and literals   | compile-time products, sums, closures, projection, extension, recursion with a depth guard, `const`/`forall` specialization, protocol evidence with no residual dispatch, and erasure of compile-time-only bindings all verified; type reflection is a stub returning a constant `size` of 1, and the `module` `ConstValue` variant is still unconstructed                  |
| Primitive canonicalization  | stable IDs cover scalar, SIMD, buffer, UTF-8, and trap operations, and UTF-8 validates equivalently at both stages; legacy intrinsic dispatch remains                                                                                                                                                                                                                       |
| Ownership and effects       | linear consumption is path-sensitive with agreeing joins, mutation of a borrowed owner is refused, scratch escapes are closed with `freeze` as the sanctioned exit, resumptions are affine, and the host boundary is typed with async reserved; drops, borrow regions, and freeze lowering await Core resource primitives                                                   |
| ABI and layout              | `LayoutId` is independent of `TypeId` with deterministic sizes, alignments, offsets, union tags, and payload storage, and owned versus frozen buffer representations are chosen; nothing emits the frozen slice form, and buffer operations are not decomposed because Core has no `memory.*`                                                                               |
| Effect bindings             | an effectful module-level binding is computed once into a Wasm global, so a host effect is no longer re-performed per read; this fixed two corpus programs that were passing only because their hosts returned constants                                                                                                                                                    |

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

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
- explicit buffers, calls, and control flow.

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
byte emission. GPU emission may be checked against the CPU encoder or selected
authoritatively; the selected artifact is always validated independently.

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

host.call
```

The scalar primitive registry must cover the corresponding Wasm families for
`i32`, `i64`, `f32`, `f64`, and the admitted `f32x4` SIMD operations. Each
primitive needs one canonical ID, signature, stage, effect classification, and
lowering rule. Source aliases and imported wrapper names must resolve to that ID
before Core construction.

Raw `memory.*` operations are not part of the current Core contract. The payload
ABI represents buffers and aggregates with managed handles, so their
machine-facing operations are typed runtime calls. Introducing linear-memory
loads and stores would define a different payload ABI; it is not required by a
GPU that executes compiler passes rather than the payload program.

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
- [x] Make contextual classification inspect token-head candidates without
      constructing unconditional source prefixes and suffixes. Preserve source
      length and spans, dispatch only by necessary first characters, and retain
      the quote, escape, comment, and delimiter state machine.
- [x] Filter arrow spellings before evaluating their backward context. The two
      predicates are pure and conjunctive, so lexical-first evaluation preserves
      acceptance while discarding context work for non-arrows.

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
- [x] Resolve imports to exported symbol IDs instead of splicing definitions
      into the importer's lexical scope. Every linked definition receives a
      stable module-qualified name derived from its declaring source and keeps
      that identity through transitive imports. An import emits a local alias
      whose resolved reference points at the exported definition's
      `DucklangSymbol.id`; the definition itself is linked once. The diamond
      graph test asserts that the shared definition occurs once, and the alias
      test compares the resolved IDs rather than their spellings.
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
- [x] Represent namespace selection as compile-time module projection. Namespace
      export records carry the `compileTimeModule` proof into typed products;
      the `ConstValue.module` evaluator projects them with the same persistent
      product operation as any other compile-time record.
- [x] Represent parameterized modules as compile-time functions from parameter
      records to export modules. The parameter record is typed structurally, the
      function body returns a `compileTimeModule`, and specialization erases the
      application before Core. A `Text` capability record is checked
      structurally and executes through this path.
- [x] Detect import cycles with the complete module path in the diagnostic.
- [x] Cache module instances by source identity, source hash, compiler version,
      and canonical compile-time arguments. Linking caches the immutable module
      definition under the first three components and its parameter list. That
      key travels on the typed compile-time export module; applying a
      parameterized module extends it with a length-prefixed canonical encoding
      of scalar, type, product, sum, and module arguments. Closures are not
      canonical values and deliberately disable reuse rather than receiving an
      unstable identity.
- [x] Share immutable syntax for the fixed compiler-owned prelude set across
      independent compilations. Canonical path plus source hash guards reuse,
      changed sources replace their entry, and user/custom-prelude syntax
      remains scoped to one compilation or explicit session.
- [x] Delete the exported-function hoisting path. Selected exports are now
      ordinary aliases to linked definitions, while namespace imports are
      compile-time export modules. Functions therefore use the same closure and
      direct-call machinery whether selected, projected, or captured; import
      linking no longer renames an exported function into the caller's scope.
- [x] Test that `citation_parser.duck` retains the captured `texts` binding.
- [x] Test that importing `duck:prelude/iterators` makes `IntoIterator` and its
      extensions visible to the editor.

Exit criterion: imports never lose lexical captures or declarations, and module
behavior no longer depends on statement concatenation order.

## Phase 3: Compile-time normalization and specialization

- [x] Implement the complete `ConstValue` domain. Scalars, products, sums,
      closures, types, and modules are all constructed from source.
      `evaluateDucklangConstModule` evaluates an export record to the module
      variant, and module normalization tests project its exports.
- [x] Evaluate compile-time closures with immutable lexical environments. A
      closure that captures `base = 40` still answers 42 after a later
      `let base = 100`; a mutable environment would answer 102.
- [x] Evaluate compile-time products, sums, projection, and extension. A
      declared struct evaluates to a `product` compile-time value, field
      projection and a functional `with_` update both evaluate, sums evaluate
      with payload bindings, and `extendDucklangConstProduct` leaves its base
      untouched.
- [x] Evaluate type constructors and canonicalize applications to `TypeId`s.
      Canonical identities preserve nested applications and are asserted in
      `tests/ducklang_const.test.ts` and `tests/ducklang_const_domain.test.ts`.
- [x] Implement structural type reflection over canonical type values. This
      replaced a stub that was worse than absence: `@type_of` and
      `@describe_type` were rewritten in the parser, before any type information
      existed, so `@type_of(x)` became `x` and `@describe_type` became a
      hardcoded `{ size: 1 }`. Every type reported size 1, which programs could
      read as a wrong answer rather than hit as a missing feature.

      `@type_of` now folds to the same `duck:type/*` intrinsic a written type name
      already resolves to, so a reflected type and a written type are the same value
      afterwards and `@describe_type` cannot tell which it was handed. That reuses
      the payload and the folding path `duck:compiler/type-pattern` matching already
      used, so reflection introduced no representation of its own. Sizes come from
      `ducklangReflectedLayout`, which delegates to the same `scalarLayout` and
      `align` helpers Core layout uses rather than restating them, so Core and
      reflection cannot silently disagree about what a value costs. An unknown type
      name throws instead of answering zero.

      The earlier note here claimed this was blocked on changing a vendored
      expectation. That was wrong, and it is what kept the item unclaimed. Upstream
      `../binned/examples/manifest.ts:189` already recorded `run(21)`; only the local
      copies said 18, which was the stub's size 1 frozen in. `config.json` is 17
      bytes and `struct { .length = I32 }` is 4, so 21 is correct: implementing this
      *converged* with the contract. `examples/binned/manifest.ts`, `contract.json`,
      and `README.md` were corrected to 21 by hand rather than by
      `deno task duck:contract`, because regeneration rewrites the whole file and the
      local copy has drifted broadly from upstream (352 insertions, 188 deletions).

      Nesting and generic application are resolved, which the first attempt at this
      item did not do and which measurement caught before the claim was made. A field
      whose type is another struct records only the bare name `Inner`, and a generic
      field records the parameter name `a`, so neither can be laid out from the
      payload alone and both were refused. `reflectDucklangTypes` now resolves the
      layout against the declaration table with the type arguments substituted in, and
      carries the result in the payload, because that context exists there and nowhere
      downstream. A written struct name is enriched the same way, so `@describe_type(Outer)`
      and `@describe_type(@type_of(o))` agree; they disagreed at first, with only the
      reflected path carrying a layout. A recursive struct is left unenriched rather
      than rejected during the pass, since type pattern matching over one is legitimate
      and never asks for a size; asking for its size still refuses.

      The old note also blamed the wrong cause for the `I64` case. It said an `I64`
      field failed "because the size is compared against the value's own type".
      Measurement says otherwise: `let c: C = [.x = 1]` fails to unify i64 with i32
      with reflection entirely absent, because an integer literal does not widen to
      an `I64` field. That is a separate limitation, so `I64` padding is asserted
      directly against `ducklangReflectedLayout` instead of through a program that
      cannot be written yet.
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

      Alias expansion participates in receiver matching, so an overlapping
      generic and concrete `Box` implementation reports both candidates for
      `I32Box` rather than falsely reporting that none exists.

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
- [x] Replace scalar-only comptime evaluation and ad hoc static closure
      substitution after equivalent behavior is covered. `DucklangConstValue` is
      now the semantic evaluator for scalars, products, sums, types, closures,
      and modules. Independent CPU scalar bytecode validates closed scalar
      expressions, while the direct GPU evaluator remains a conformance test
      rather than production work. Expressions closed over function parameters
      stay in their immutable closure environment until specialization.
      `tests/ducklang_closures.test.ts` pins both the specialized shape and the
      value, including a three-level capture that would answer 123 if an
      environment were substituted incorrectly.

Milestones:

- [x] `prelude_types.duck` normalizes to an export module without reaching FCG.
- [x] `prelude.duck` normalizes using the source-defined type builders.
- [x] `prelude_functional.duck`, `prelude_list.duck`, and
      `prelude_iterators.duck` specialize their generic source definitions.
      `tests/ducklang_module_normalization.test.ts` pins all five milestones.

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
- [x] Lower unbounded loops to header and exit blocks. Dynamic source loops are
      normalized to generated functions before typing, then Core recognizes
      those functions and replaces their recursion with explicit header,
      back-edge, and exit blocks.
- [x] Pass every carried binding on loop back-edges and exits. An accumulator
      summed over `0..5` reaches 10, and one summed inside a nested loop reaches
      6, so a binding lost on a back-edge or an exit changes the answer rather
      than rearranging work. Core replaces the frontend's private recursive
      builder with explicit header, back-edge, and exit blocks before
      flattening.
- [x] Lower bare and valued `break` without mixing their result signatures. A
      loop whose value is taken must supply one on every exit, and mixing is now
      rejected with "Ducklang loop mixes a valued break with a bare break". It
      was accepted before, and the bare path fabricated an `i32` zero: a loop
      yielding 7 on its valued exit returned 0 through the bare one, and a
      `Text`-yielding loop passed that zero on as a buffer handle, failing at
      runtime with "unknown handle 0" rather than being diagnosed. The check
      runs before static loop expansion; placed after it, a constant-conditioned
      loop was already folded to the fabricated zero. A loop whose every exit is
      valued, and a bare break in a `for` statement, both still compile and
      reach typed Core exit edges.
- [x] Lower `continue` to the nearest loop header. A `continue` inside a nested
      loop skips only the inner iteration: two outer passes over an inner `0..3`
      that skips `1` total 4, which a `continue` targeting the outer header
      would not produce. A bare `break` likewise exits only the loop it is in,
      leaving the outer loop to finish. The generated continuation becomes the
      nearest typed Core header edge.
- [x] Lower early `return` to a function terminator. The early arm ends the
      function with a `return` terminator instead of edging into the join that
      the fall-through path uses.
- [x] Preserve nested loop and match control boundaries. Nested loop exits and
      continues retain their nearest generated continuation, and Core tests pin
      nested branches independently.
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
- [x] Lower collection loops after protocol specialization, without a
      collection-specific backend loop. Collection traversal specializes to
      ordinary length/index operations and the same dynamic Core loop edges as
      ranges; flat Core and Wasm have no collection-loop opcode.

- [x] Replace recursive-function loop lowering at the Core boundary. The
      frontend may use a private recursive builder while it discovers carried
      bindings, but `lowerDucklangToCore` recognizes that role and emits a
      header back-edge plus one typed exit block. The Core test asserts the
      back-edge targets the entry block, the exit carries its value as a block
      parameter, and no self `call.direct` survives. Flat Core and the GPU
      therefore see only blocks, terminators, and edge arguments.

Milestones:

- [x] Statement-only branches in the Base64, JSON, and time preludes reach Core.
- [x] Nested loops in JSON encoding reach Core.
- [x] Valued loop exits in the grep application reach Core.
- [x] Dynamic ranges in the tar application reach Core.

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
      the single rule, with tests on the decision itself. Both states remain
      four-byte managed table indices because ownership transfer, release, host
      adaptation, and aggregate sharing need stable runtime identity. Freezing
      changes the legal operations, not the physical identity. `Text` and
      `Bytes` share a representation while staying distinct semantic kinds.
- [x] Lower semantic buffer operations to allocation, length, checked access,
      functional update, slicing, concatenation, generation, fill, equality, and
      UTF-8 conversion. Each has one canonical primitive descriptor with effects
      identifying allocation, reads, and traps; flat Core carries only its
      stable ID. The managed runtime implements allocation and copies at the
      payload ABI, with deterministic bounds traps pinned independently for
      reads and updates.
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
      works because a recursive sum payload is a managed handle;
      `planDucklangCoreLayouts` detects self-containment and assigns that boxed
      representation deterministically.
- [x] Add deterministic out-of-bounds traps for buffer and aggregate indexing.
      Pinned from both sides rather than only asserting failure: a `Text` index
      of 0 and 2 into `"abc"` return, 3 and 99 trap; a struct index of 0 and 1
      return 20 and 22, 2 and 7 trap. The trap must carry a Wasm trap message,
      so a host-side failure does not count, and the same index reports the same
      trap on repeated runs. The corpus contract also covers the two fixtures
      but accepts any thrown error, so it cannot separate a bounds trap from an
      unrelated failure.
- [x] Keep opaque managed text handles because no current payload boundary
      requires a linear-memory representation. The GPU executes compiler passes,
      not the Ducklang payload; the payload executes as Wasm against a host ABI
      that needs stable identity for ownership, release, and string adaptation.
      A future payload backend that consumes linear-memory slices is a new ABI,
      not a requirement to leak GPU addressing into semantic Core.

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
- [x] Build typed closure environments from captured values. `closure.make`
      carries a typed function identity and capture operands; layout planning
      assigns the environment fields.
- [x] Preserve direct calls when the callee is statically known. A call to a
      module-level function emits a `call` opcode to that function's own code
      identity, with no indirect dispatch anywhere in the graph. The argument is
      a runtime value so the call cannot fold away, which would leave nothing to
      inspect.
- [x] Lower first-class calls to a code-table index plus environment pointer.
- [x] Add `call_indirect` signature validation. Core validates the closure
      signature, and Wasm emission creates type, table, and element sections
      before emitting the indirect call.
- [x] Preserve recursive and mutually recursive closure groups. A self-recursive
      function survives as its own code identity and calls itself rather than
      being unrolled. A mutually recursive `even`/`odd` pair keeps both members
      as separate functions that call each other: `even(4)` walks the pair four
      times and answers 1, so the group has to be intact for the program to
      reach 42. Neither uses indirect dispatch.
- [x] Carry resource classifications into closure environment fields.
- [x] Reject reusable closures that would duplicate a linear capture.
- [x] Compile iterator records and combinators without iterator-specific backend
      behavior.

Milestones:

- [x] `prelude_iterators.duck` reaches layout planning.
- [x] The editor reaches flat Core with iterator methods fully specialized.
- [x] The Codex citation parser reaches flat Core with its module captures
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
- [x] Insert explicit drops on every owning exit edge. Linear values must be
      transferred by `resource.move`; they cannot disappear at an exit. Scratch
      arenas are the remaining locally owned resources, and every normal,
      return, trap, and outward branch edge emits `resource.drop` followed by
      `region.exit`. Arena-wide drop is valid across mutually exclusive
      allocation paths and is validated before flattening.
- [x] Lower borrow lifetimes to checked lexical regions. A borrow records its
      owner in the resolver's resource state for the remainder of the enclosing
      lexical block. While that region is live, moving, mutating, or freezing
      the owner is rejected; reading through the borrow and taking multiple
      shared borrows remain legal. This is deliberately conservative—the region
      may outlive the final borrow use—but it is sound and requires no runtime
      lifetime object. The move-while-borrowed test also reads the borrow after
      the attempted move, so a checker that relied on the managed handle staying
      alive does not pass.
- [x] Prove freeze transitions and erase them according to layout. Resolution
      rejects freezing a borrowed owner and region validation prevents an
      unfrozen scratch value from escaping. Core retains `resource.freeze` until
      layout planning; owned and frozen payload buffers both use the managed
      handle ABI, so Wasm erases the proof operation without changing the
      handle. This is representation independence, not a missing copy.
- [x] Lower scratch blocks to region enter, allocate, cleanup, and exit edges.
      Allocating primitives inside a scratch block are wrapped in
      `region.allocate`; the region token is the owning arena resource.
      `resource.drop` followed by `region.exit` is inserted on normal completion
      and on every return, trap, or branch that leaves the lexical region.
      Dropping the arena rather than each allocation separately keeps cleanup
      valid across mutually exclusive allocation paths. Core validation checks
      token, operand, and result types, and flat-Core round trips preserve every
      resource operation.
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
- [x] Replace source-handler substitution with typed deep-handler semantics.
      `ducklang_effect_ir.ts` is the executable fine-grain reference semantics;
      `ducklang_effect_cps.ts` splits a performance from its delimited
      continuation, and an aborting clause now returns 40 rather than executing
      the discarded `+ 2` continuation and returning 42. Handler state is
      preserved as ordinary shadowed bindings threaded through the one-shot CPS
      translation.
- [x] Infer control-flow linearity for resumptions from their captured
      resources. The reference evaluator rejects discarding a non-discardable
      capture. Source lowering identifies lexical linear owners live across a
      performance and requires exactly one resume when one is captured; every
      resumption remains one-shot. This is deliberately conservative and keeps
      multi-shot resumptions outside the admitted contract.
- [x] Lower unresolved module-boundary effects to typed host calls. A declared
      effect operation that no source handler resolves becomes a host call, and
      the boundary is typed rather than merely reached: a `Text` parameter given
      an integer is rejected with "cannot unify Ducklang text with i32", a
      zero-arity operation given an argument is rejected by arity, and an
      operation the module never declared is rejected by name. Each rejection is
      its own case, because the accepting one alone would pass against a
      boundary that accepted anything.
- [x] Extend the managed ABI to aggregate arguments and results only after their
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

### Phase 7A: Sound first-class effect elaboration (reopened)

- [x] Add an executable fine-grain call-by-value reference calculus with
      `return`, sequencing, lexical capabilities, `perform`, deep handlers, and
      typed resumptions. Six conformance tests cover abort, resume, one-shot
      use, lexical identity, capture cleanup, row canonicalization, and exact
      capability subtraction.
- [x] Put canonical open effect rows in computation and function types. Infer,
      generalize, and instantiate row variables so higher-order calls preserve
      the callee's effects rather than relying on a statically named binding.
      Function type references retain their latent rows, typed bindings carry a
      canonical operation/parameter row, and higher-order call summaries
      instantiate the actual callback row.
- [x] Give every handler instance a generative lexical capability identity.
      Operations may be handled only by the capability selected at their source,
      preventing accidental capture across effect-polymorphic abstractions.
      Source identities are stable file/span/binding identities; the reference
      calculus uses numeric generative identities. Two handlers for the same
      signature select independently.
- [x] Type handler clauses with an answer type, forwarded row, clause row, and
      control-flow multiplicity. Prove the empty-row progress property and
      handler row subtraction with reference-evaluator conformance tests.
      `EffectHandler<Result, Answer>` fixes the answer type for return and
      operation clauses, records its clause row, and admits only linear or
      affine one-shot control.
- [x] Run ownership analysis while performances and resumptions remain explicit,
      then lower capabilities and only the effectful program slice through
      type-directed selective CPS. Ownership validation precedes effect
      elimination, captured linear owners constrain multiplicity, general
      handlers split continuations. The proposed direct path was not selected:
      tail position in a clause does not imply tail position of the captured
      performance continuation. The admitted baseline uses one-shot CPS and
      records the whole-region proof required before adding that optimization.
- [x] Require the residual capability row at `main` to equal the generated ABI
      requirements. `closeDucklangEffectBoundary` derives the final canonical
      row from reachable, typed Core host calls and rejects any inferred
      requirement that lowering lost. The managed ABI is generated from that
      closed row.
- [x] Delete the source-substitution handler lowering after structural lowering
      is selected. `ducklang_effect_cps.ts` is the sole production source-effect
      lowering.
- [x] Measure effect-row propagation, added capability operands, transformed CPS
      functions, live continuation captures, and generated code size against the
      calculations in [PAPER.md](PAPER.md). Every artifact profile records row
      memberships, root capability operands, transformed regions, handled
      performances, continuation captures, Core volume, and Wasm bytes.

Exit criterion: the reference semantics, type-and-effect checker, ownership
checker, capability/CPS lowering, residual ABI, and observable execution agree;
closed empty-row computations cannot perform an unhandled operation; and Flat
Core receives no source handler or open effect row.

## Phase 8: Flat Core and GPU passes

- [x] Version a new flat schema with structure-of-arrays columns for functions,
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
- [x] Represent successor arguments explicitly rather than through region IDs.
- [x] Round-trip structured Core to flat Core and back in tests.
- [x] Port rewrite matching from adjacent stack instructions to value-use
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
- [x] Validate flat Core once at the CPU trust boundary and use generated exact
      CPU/GPU matcher comparisons as the rewrite oracle. Production GPU
      compilation treats only CPU-checked GPU proposals as authoritative.
- [x] Treat an empty Core rewrite frontier as a validated identity before GPU
      preparation. Packed execution removes identity jobs while preserving
      logical result order; zero-work tests do not require an adapter.
- [x] Project each nonempty Core rewrite candidate to the exact 20-word matcher
      neighborhood. The GPU still decides the rule, while profiles prove
      descriptor and total device capacities and CPU certificates check output.
- [x] Resolve validated Wasm atom widths and exclusive byte boundaries once at
      the CPU trust boundary. One GPU emission frontier consumes those
      boundaries; size, nested-length, and hierarchical-scan kernels are
      deleted, with exact-offset and byte-differential regressions.
- [x] Pack the five Wasm atom tags as eight random-access nibbles per word.
      Profiles prove the exact input-byte formula, and generated CPU/GPU
      differentials cross tag-word boundaries.
- [x] Accumulate each eight-atom kind word locally and commit it once. Disjoint
      nibble masks reduce host typed-array stores from `A` to `ceil(A / 8)`
      without changing representation or GPU work.
- [x] Represent signed-64 high words by the smaller of a dense column and a
      sorted sparse frontier. The `min(4A, 8S)` rule has dense and sparse
      byte-differential regressions and executable capacity metrics.
- [x] Select ranked low-word compression exactly when its logical input is
      strictly smaller than dense storage. It removes 14.14–21.20% of current
      frozen atom input, while a 21-pair dense/ranked benchmark found median
      ratios within ±0.40%. Forced-layout differentials and mixed-layout packed
      batches validate both representations.
- [x] Derive within-word byte rank with nibble-parallel zero detection and
      `countOneBits`. Four fixed shifts replace a divergent zero-to-seven
      comparison loop while preserving the exact stable-rank proof. A GPU/CPU
      differential enumerates all 256 byte/non-byte masks in one kind word.
- [x] Pack two byte-rank boundaries per word exactly when the maximum stored
      rank fits u16. Five frozen targets halve the rank frontier; Codex retains
      u32. Direct boundary tests distinguish a 65,535 maximum from 65,536.
- [x] Assemble adjacent u16 offsets and byte ranks before assigning their
      physical word. Pairwise-disjoint half-word masks reduce host stores to the
      exact physical word count instead of read/modify/writing once per logical
      value.
- [x] Accumulate four packed byte values before assigning their low-word entry.
      Disjoint byte masks reduce host byte-stream stores from `Q` to
      `ceil(Q / 4)` while preserving the ranked lookup proof.
- [x] Use the definitional width one of byte atoms to skip their end-boundary
      lookup. GPU emission now performs `2A - Q` offset reads and avoids one
      subtraction for every byte lane.
- [x] Fuse byte count, signed-64 count, and maximum byte rank into the mandatory
      atom-size traversal. This product fold deletes one complete host pass over
      every Wasm plan without changing validation or packing.
- [x] Fuse scalar validation and sizing into one plan inspection while retaining
      validation-only operation without a size allocation. Length sizing remains
      a separate topological fold.
- [x] Select direct or sparse Wasm length sizing from an explicit cost model.
      The sparse path uses a scalar prefix and level-batched Fenwick updates;
      profiles expose both the direct dependency count and selected work.
- [x] Fuse CPU-oracle scalar encoding into validated inspection and accumulate
      output size during scalar and length folds. This removes two atom passes
      without sharing the GPU boundary's adaptive length-sizing algorithm.
- [x] Separate checked public LEB entry points from validated-domain encoder
      bodies. Inspected scalar atoms skip duplicate predicates; derived length
      values remain checked.
- [x] Use strict dependency-level descent as the proof that every CPU length
      dependency is encoded before use. The interior range loop no longer
      rechecks an impossible unresolved state.
- [x] Canonicalize the finite set of immutable one-byte encodings. CPU emission
      reuses 256 private singleton arrays instead of allocating one per byte
      atom.
- [x] Reuse the private byte table for validated one-byte unsigned and signed
      LEB values while keeping exported mutable-array encoders fresh.
- [x] Audit emission-local memoization of remaining multi-byte LEB encodings.
      An 88.75% frozen-batch hit rate still regressed every CPU-oracle median by
      55.05–93.82%, so retain fresh encodings and record the rejected cost model
      and unsigned-128 counterexample.
- [x] Replace the CPU oracle's per-atom encoding graph with width analysis and
      direct rolling-offset emission. Stable length ranks index the \(K\)
      derived payloads and remove the sparse GPU analysis's position map; the
      final representation allocates no compiler-internal encoding arrays.
- [x] Structure reducible CFGs into Wasm regions and dispatch-lower general
      CFGs. The Core backend emits direct structured `if`/`block` forms for the
      reducible diamond and uses a deterministic block-state local inside a
      `loop` for the general case. That dispatch representation also admits
      irreducible graphs without pretending their edges are well nested.
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
- [x] Emit byte-identical CPU and GPU Wasm for every admitted target. Required
      GPU benchmark mode compiled editor, Codex, grep, tar, wav, and raytracer
      on the recorded RTX 4080 SUPER; the compiler rejects a mismatch before
      returning, and all six completed. The measured byte counts and flat-Core
      batch sizes are recorded in `PERFORMANCE.md`.

Exit criterion: the GPU consumes only validated flat Core and performs no source
name lookup, typeclass search, module resolution, ownership policy, or ABI
policy.

## Phase 9: Application milestones and performance

- [x] Compile every recorded frontend prelude independently to its intended
      compile-time export-module boundary. The corpus test enumerates the
      directory, asserts the exact set of 23 modules, normalizes each one, and
      checks its export count. `prelude_collections.duck` deliberately relies on
      Binned's ambient type prelude, so the test supplies that dependency
      explicitly rather than giving the isolated file an accidental global.
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
      unbounded `loop`, a dynamic range `line_start..length pending`, and two
      valued breaks, `break 2` and `break code`, returning exit codes from its
      outer loop; tar has computed dynamic ranges such as
      `start..start + block_size`. Phase 4 Core tests assert grep's valued exit
      edges and tar's dynamic range header and exit blocks.
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
- [x] Record CPU semantic elaboration, Core construction, flat-Core
      construction, CPU rewrite, GPU initialization, GPU rewrite, transfer, CPU
      Wasm emission, GPU Wasm emission, and total timings separately.
- [x] Compare CPU-only and GPU paths by source size, Core operation count,
      function count, GPU validation batch size, Wasm size, and warm total.
      `scripts/benchmark_ducklang_frontend.ts` emits those fields for every
      target and `PERFORMANCE.md` records the current six-target run.
- [x] Preserve byte-identical output and deterministic diagnostics across
      repeated runs. Asserted on the CPU path for the frozen editor, Codex, and
      grep targets and for the module fixtures that carry generated names, plus
      verbatim diagnostics for three corpus compile failures. Generated names
      never reach the emitted bytes, so byte equality alone cannot see an
      order-dependent discriminator; the inferred type listing is asserted too,
      and that case is mutation-proved by making the type discriminator a
      counter, which fails it. GPU/CPU differential emission is covered by
      Phase 8.

Exit criterion: compatibility and performance claims name the exact recorded
Binned revision, target set, hardware, execution mode, and measured pipeline
boundaries.

## Phase 10: Production GPU compiler boundary

Production here means the admitted Ducklang corpus can be compiled
deterministically by a long-lived process or the CLI on a conforming WebGPU
implementation, with explicit resource bounds, recoverable optional-GPU
fallback, strict required-GPU behavior, and an independently validated Wasm
artifact. It does not mean accepting source outside the language contract or
hiding CPU frontend work behind a GPU label.

The theoretical basis is fail-stop stage composition: every stage either
produces a validated value for the next stage or returns a typed inability to
run. Optional mode may replace only an unavailable GPU implementation with the
equivalent CPU implementation. It may not reinterpret invalid IR, ignore a
CPU/GPU disagreement, or return partially written output.

- [x] Make GPU Core rewrite proposals authoritative, resolve them in stable
      order, compact the flat package directly, and validate the rebuilt
      snapshot before lowering.
- [x] Derive the Core candidate frontier from the common structural head of the
      admitted rules. CPU discrimination checks only necessary representation
      facts; the GPU still decides constant identity, orientation, and
      replacement. Frozen candidates fall from 3,788 to 1,242 without removing
      a possible match.
- [x] Make Core backend provenance disjoint. A host-proved empty frontier reports
      `identity`, a submitted matcher reports `gpu`, and fallback reports `cpu`.
      Raytracer no longer claims GPU Core execution after its frontier became
      empty.
- [x] Pack two resolved Wasm offsets per word exactly when the final module is at
      most 65,535 bytes. Five frozen targets use lossless u16 boundaries; Codex
      retains u32. Boundary tests pin both sides of the threshold and profiles
      report the selected width.
- [x] Isolate real-plan Wasm emission measurement from frontend and backend
      lowering. The benchmark constructs each frozen plan once, warms the
      persistent GPU context, alternates target order, reports median and p95
      for analysis through mapped readback, and rejects every byte disagreement
      with independent CPU emission.
- [x] Hash-cons repeated type constructors before solving, derive the least
      constructor congruence on the CPU, validate its complete equality
      certificate with one GPU union/compression submission, and pack four
      emitted Wasm bytes into each output word. The removed alternative compared
      all term pairs and formed a dense transitive closure; neither operation
      scales with the admitted corpus.
- [x] Split GPU type time into flattening, CPU closure, GPU union/readback, and
      quotient-cycle checking. Report terms, closed equalities, constructor
      comparisons, and child-equation proposals, reset them on semantic reuse,
      and assert their accounting relationships in the compilation profile.
- [x] Replace repeated whole-term constructor frontiers with one lowest-ID
      constructor witness per union-find class. Enqueue injective child
      equalities when witnessed classes merge, prove the witness-star invariant,
      and pin one comparison per additional compatible constructor.
- [x] Remove differential type solving from production compilation after
      proving that its result has no semantic or backend consumer. Keep the
      standalone conformance experiment and generated tests; required GPU builds
      now spend device work only on compiler stages whose output is consumed.
- [x] Remove differential scalar bytecode evaluation from production compilation
      under the same noninterference criterion. Keep the independent CPU
      scalar-versus-constant check and direct CPU/GPU conformance tests. Only
      Editor had nonempty scalar GPU work in the frozen corpus: four jobs, one
      submission, and one mapped readback.
- [x] Admit algebraic rewrites only where the value type proves the required
      law. `x + 0` and `x * 1` are currently integer rules: bypassing an
      IEEE-754 operation can change signed-zero or NaN payload bits observable
      through reinterpretation.
- [x] Preflight every GPU buffer, binding, dispatch, and generated-work bound
      against the selected device before allocation. One shared boundary now
      checks safe-integer byte counts, `maxBufferSize`, storage and uniform
      binding spans, and one-dimensional workgroup counts. Type solving,
      compile-time evaluation, Core validation and rewrite matching, and Wasm
      emission have no direct `createBuffer` or `dispatchWorkgroups` calls
      outside that boundary. Capacity tests pin exact-limit acceptance and
      evidence-bearing rejection; optional compilation receives `unavailable`,
      while required mode promotes the same reason to failure.
- [x] Treat device loss and out-of-memory as recoverable GPU unavailability in
      optional mode, invalidate every cached pipeline tied to that device, and
      retry a later compilation on a newly requested device. Every submitted
      readback races the device-loss promise and carries its reason and driver
      message. The shared device, Core, comptime, Wasm, and union caches all
      discard state tied to a lost device. Required
      mode promotes unavailability to failure; validation errors, semantic
      disagreement, and malformed GPU output remain hard failures.
- [x] Separate production execution from differential verification.
      `gpuWasmVerification: "none"` lowers only a Wasm plan, lets GPU emission
      produce the first byte buffer, and encodes on CPU only if optional mode
      needs a fallback. Differential byte comparison remains the default.
      Focused Haskell and Ducklang tests compare authoritative and verified GPU
      output.
- [x] Validate the selected final Wasm bytes with the engine and validate their
      imports, exports, and managed ABI metadata before returning a compilation
      artifact. The validator requires exactly the `main` function export,
      function-only imports, declared and unique ABI references, exact managed
      host imports, and text-literal custom-section agreement.
- [x] Let the CLI compile managed applications by accepting an explicit host
      interface, report which backend completed each GPU-capable stage, and
      preserve atomic output replacement on every failure path. The CLI accepts
      `--host-interface host.duck` and `--no-gpu-verification`; compilation
      artifacts and CLI output name the type, comptime, Core, Wasm, and
      verification backends. Output still goes through a same-directory
      temporary file followed by rename.
- [x] Add generated differential tests for type solving, compile-time bytecode,
      Core rewrite batches, and Wasm plans. Six fixed hexadecimal seeds generate
      union partitions, arithmetic programs, mixed integer/float Core
      identities, and variable-sized modules. Independent CPU expectations run
      without WebGPU; a GPU-enabled run compares every generated batch, and each
      failure reports its seed.
- [x] Stress concurrent compilations through the shared device and prove
      deterministic isolation, bounded cleanup, and recovery after a failed job.
      Eight mixed Haskell and Ducklang compilations share the device and
      pipeline caches while an invalid Core package is rejected. Every result
      matches its baseline byte-for-byte, Deno's resource sanitizer observes the
      test boundary, and a subsequent required-GPU compilation completes through
      both Core and Wasm.
- [x] Define release gates for the frozen corpus, malformed inputs, GPU-required
      execution, repeated output identity, and benchmark regressions. Record the
      adapter limits and enough samples to state a break-even interval rather
      than a single-run speedup. `deno task release:gpu` runs the repository
      checks and full suite, rejects malformed source, then compiles all six
      applications twice in required differential mode. It checks the exact Wasm
      size, every GPU backend selection, byte identity, and a per-target timing
      budget. The recorded RTX 4080 SUPER limits and sixteen-sample
      authoritative grep batches are in `PERFORMANCE.md`; after discarding
      production type validation, no break-even was observed through sixteen
      concurrent compilations and throughput GPU/CPU reached 1.015.
- [x] Reconcile the README, compatibility matrix, live-error inventory, and
      performance report with the implemented pipeline. Remove stale
      proof-of-concept limits and claims contradicted by executable tests. The
      README now distinguishes the frozen production contract from general
      language coverage, the compatibility matrix names authoritative and
      differential GPU stages, the final inventory points to executable boundary
      proofs, and the performance report records the current artifact sizes,
      adapter limits, pipeline timings, and bounded negative break-even result.

Exit criterion: CPU, optional-GPU, and required-GPU policies have observable,
tested semantics; no GPU allocation or dispatch is attempted outside a checked
device bound; the returned Wasm and ABI are independently valid; editor, Codex,
grep, tar, wav, and raytracer compile in required-GPU verification mode; and the
documented release command passes from a clean checkout.

## Phase 11: Demand-specialization boundary

- [x] Add a retention ledger for input, demanded, rewritten, and residual
      bindings and nodes, plus specialization keys and cache hits.
- [x] Define specialization requests from typed function, diagnostic-site,
      argument, and referenced-environment identities, with pending and complete
      memo states.
- [x] Compute the least demanded binding closure before rewriting instead of
      specializing every module binding.
- [x] Emit only reachable demanded bindings while conservatively retaining
      runtime non-function initializers and dynamic callees.
- [x] Derive the post-comptime dirty frontier from exact rewrite evidence and
      reverse dependencies; clean applications now perform zero second-pass node
      rewrites.
- [x] Feed every residual function into the shared flat GPU package after
      pruning. Keep operation-level GPU parallelism and stable commit order;
      reject CPU worker cloning until a measured cost model justifies
      `O(P × Core_bytes)` replication.

Exit criterion: demand and frontier tests pin discarded and clean work,
determinism and frozen execution still pass, every artifact reports the ledger,
and `PAPER.md` records the identity model, failed structural-hash approach,
resource cost, and corpus measurements.

## Phase 12: Sharing-preserving specialization

- [x] Split read-only typed-HIR traversal from reconstruction so observation
      allocates no payload nodes.
- [x] Preserve the original immutable expression object when every rewritten
      child is pointer-identical.
- [x] Summarize each immutable function body once per specialization pass and
      record distinct and repeated analysis counts.
- [x] Fuse capture-free parameter substitution with rewriting under globally
      unique resolved symbol IDs.
- [x] Rewrite only the selected arm of a static call-by-value conditional and
      test that an unreachable compile-time failure is not evaluated.
- [x] Represent block-local specialization values with a stack-disciplined
      active environment. Insert/prior-value rollback is equivalent to cloning
      the visible map, including under source-body re-entry; profile the exact
      avoided entries.
- [x] Count each immutable specialization-ledger root once per pass. Reuse exact
      identity-memoized DAG counts across input, demanded, rewritten, and
      residual projections, and report avoided logical node visits.
- [x] Audit copy-on-first-change child lists. Twenty-one-sample Codex medians
      regressed rewrite by 3.65% and total CPU time by 2.14%; retain native
      `map` plus identity scan and record the rejected cost inequality.
- [x] Audit product direct-call classification during closure lifting. An
      unguarded scan regressed lifting by 55.80%; a necessary block-head guard
      reached parity but no gain, so retain per-symbol early-exit scans.
- [x] Define empty accepted Core rewrite batches as the identity transformation.
      CPU and validated GPU commit preserve the input object, backend-neutral
      profiles expose proposal and acceptance counts, and a 21-pair Codex
      experiment isolates the removed rebuild and second validation.
- [x] Reuse the retained structured Core round-trip witness when rewrite returns
      the exact package produced by flattening. Identity profiles report zero
      inflation; transformed packages remain on the validated inflation path.
- [x] Decompose CPU Core rewrite into validation, matching, conflict resolution,
      and rebuild intervals. The profile containment invariant and frozen
      measurements identify validation—not matching—as the remaining cost.
- [x] Give flat Core an explicit smart-constructor trust derivation. Internal
      CPU rewrite consumes construction provenance without reinflation; raw
      packages retain full validation and malformed-package rejection.
- [x] Preserve the flat-Core trust derivation through GPU queueing, identity
      filtering, mixed batches, and capacity splitting. Compiler jobs report
      construction provenance; direct raw jobs validate and report validation.
- [x] Replace the necessary-only Core rule-head queue with the exact matcher
      domain. Discard host proposal payloads, independently recompute retained
      matches on GPU, and submit only Tar's 24 useful frozen-corpus operations.
- [x] Prepare trusted Core before GPU scheduling. Return exact-frontier identity
      immediately and carry nonempty descriptors through batching and capacity
      splits without recomputation.
- [x] Separate Core logical batch size, physically packed payload size, and
      command submission size. Identity reports no physical payload or
      downstream parallel functions; concurrency uses real rewrite work.
- [x] Retain every frontend benchmark observation and report paired
      GPU-minus-CPU median and MAD. Record the discarded-observation
      counterexample and remeasure the six-target post-Core stage frontier.
- [x] Apply the paired estimator to concurrency break-even, stop treating a
      finite non-observation as a monotone lower bound, and extend the measured
      domain through 64 concurrent grep compilations.
- [x] Audit a 64-job physical GPU batch cap. Confirm that larger payloads form,
      reject the inconsistent latency result against paired MAD, and retain the
      measured 16-job cap.
- [x] Separate availability policy from performance selection. Default to CPU,
      rename explicit best-effort GPU execution to `optional`, retain fail-stop
      `required`, and preserve portable differential GPU coverage.
- [x] Stop semantic context and normalized-syntax identity construction at the
      compilation-session boundary. Independent builds report zero cache-key
      work; all session reuse semantics remain covered.
- [x] Expose source-control fixed-point pass count and first/subsequent
      transformation time. Record the unproved 32-pass restriction, decreasing
      measure obligation, and six-target physical-pass frontier.
- [x] Replace reflective source-control search with an exhaustive typed syntax
      walk. Preserve physical pass counts and record the six-target scan and
      whole-compiler reductions.
- [x] Replace the unexplained 32-pass control-flow cap with an exact residual
      constructor count and strict natural-number descent. Pin the positive
      Codex frontier, derived pass bound, and mixed performance result.
- [x] Decompose the residual source-control measure by constructor without an
      additional traversal. Prove the component sum and identify Codex's two
      residual nodes as ordinary loops.
- [x] Separate residual occurrence multiplicity from source provenance.
      Prove the quotient bounds and identify Codex's two residual occurrences
      as one prelude-runtime source constructor.
- [x] Separate residual occurrence paths from AST object identity. Reject the
      duplicate-instance hypothesis with Codex's `(2,1,1)`
      occurrence/vertex/source vector and bound safe memoization by context.
- [x] Measure complete first-pass syntax occurrences and unique AST vertices.
      Quantify sharing per target and derive the vertex-memoized search
      opportunity without assuming a universal benefit.
- [x] Skip the complete post-comptime specialization pass when both the changed
      binding set and result-change witness are empty.
- [x] Measure all six frozen applications on CPU and required GPU, pin the new
      deterministic Codex binary size, and record substage and structural deltas
      in `PAPER.md` and `PERFORMANCE.md`.

Exit criterion: identity rewriting, unselected-branch behavior, deterministic
Wasm, managed Codex execution, and required-GPU differential emission pass; the
paper derives the immutable-sharing rule, records its limits, and distinguishes
proof obligations from empirical timing evidence.

## Final boundary inventory

The live targets have no remaining first-error boundary inside the admitted
contract. Each former boundary now has an executable completion proof:

| Boundary                    | Final state                                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Syntax                      | The generated parser accepts all 121 compatibility sources and all 35 frozen live sources. Exact and trailing-trivia revisions reuse the lowered AST and semantic fingerprint; earlier edits conservatively reparse.                                                                                      |
| Modules and namespaces      | Canonical module instances preserve private captures, namespace projections, parameterized modules, and complete transitive declaration environments.                                                                                                                                                     |
| Extensions and protocols    | Canonical receiver identities select same-file and cross-file implementations; missing, ambiguous, overlapping, and incoherent implementations fail before Core with receiver evidence.                                                                                                                   |
| Staging                     | Scalars, products, sums, types, closures, and modules inhabit one `ConstValue` domain; specialization erases modules, protocols, extensions, type values, and compile-time closures before Core.                                                                                                          |
| Control flow                | Shadowing, joins, early return, nested loops, carried values, valued exits, dynamic ranges, collection loops, and `continue` reach typed Core blocks and edges.                                                                                                                                           |
| Primitives                  | Scalar, SIMD, buffer, UTF-8, conversion, reinterpretation, trap, and host operations use stable primitive IDs before flat Core.                                                                                                                                                                           |
| Closures and aggregates     | Direct and indirect calls, captured environments, products, sums, recursive boxed layouts, lists, buffers, and bounds traps lower through ordinary typed operations rather than source-specific GPU opcodes.                                                                                              |
| Ownership and effects       | Path-sensitive moves and borrows, compatible joins, freeze proofs, scratch regions, explicit Core cleanup, canonical open rows, lexical capability identities, deep one-shot resumptions, capture-sensitive control linearity, selective lowering, and exact host-row closure validate before flattening. |
| ABI and artifact validation | Layout identity is separate from type identity; managed representations are deterministic; the selected Wasm, imports, exports, ABI declarations, requirements, and text metadata are independently checked before return.                                                                                |
| GPU production boundary     | Capacity preflight, device-loss recovery, authoritative Core rewrites, optional authoritative Wasm emission, stable suballocated Core/Wasm payload batches, direct type-conformance and generated differential tests, concurrent isolation, and the six-application release gate are implemented and measured.              |

Deliberate exclusions are part of the contract rather than live errors:
asynchronous, scoped, and multi-shot effects await their own typed calculi, and
raw linear-memory payload operations await a payload ABI that needs them. None
is inferred or silently emulated.

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

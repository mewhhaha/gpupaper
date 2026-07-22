# GPU-hosted Haskell-to-Wasm proof of concept

This repository contains the papers and an executable proof-of-concept vertical
slice through Experiments A–F proposed in
[GPU-Parallel Type Resolution and Compile-Time Execution](type-resolution-and-comptime.md).
It accepts a deliberately small Haskell-like language, runs selected compiler
work through WebGPU, and emits a validated WebAssembly module whose `main`
export returns an `i32`.

This is a research artifact, not a GHC frontend. Its purpose is to make the
architectural claims executable and falsifiable before expanding the language.

## Run it

Deno 2 with WebGPU is required for the GPU paths.

```sh
deno task check
deno task test
deno task experiments
deno task run examples/all.hs
deno task compile examples/all.hs output.wasm
```

Pass `--cpu` after the filename to disable WebGPU. Pass `--require-gpu` to fail
instead of reporting that an adapter is unavailable.

`deno task experiments` prints one JSON object containing the observable result
of Experiments A–F. The combined example returns `42` and exercises algebraic
data, a class instance, two hygienic Wasm macros, CPU/GPU compile-time
evaluation, interaction-calculus evaluation, FCG lowering, and Wasm emission.

## Implemented experiments

| Paper experiment               | Executable implementation                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Rank-1 CPU oracle           | parser, scope-aware resolution, dependency SCC strata, Hindley–Milner inference, generalisation, instantiation, occurs checks, and source diagnostics |
| B. WebGPU equality solver      | deterministic concurrent union, constructor decomposition, and GPU transitive closure for quotient-graph occurs checks                                |
| C. Pure compile-time bytecode  | matching CPU and batched WGSL stack evaluators with bounded fuel and stack capacity                                                                   |
| D. Hygienic macros in CPU Wasm | macro declarations compile to Wasm modules with one explicit compiler import; generated names carry scope sets                                        |
| E. Interaction calculus        | pinned affine lambda/duplication/superposition evaluator with scalar normal forms and named interaction counts                                        |
| F. Haskell frontend growth     | algebraic datatypes, rank-1 `Eq` predicates, instance discharge, packed FCG constructors, direct calls, cases, and executable Wasm                    |

The GPU solver is intentionally differential. The CPU unifier remains the
semantic oracle; compilation records its equality constraints and independently
submits them to WebGPU. A GPU result never silently replaces a contradictory CPU
result.

This artifact exercises every experiment, but it does not claim every research
exit criterion has been met. In particular, it does not yet include generated
program testing against a second declarative checker, adapter/workgroup sweeps,
break-even benchmark curves, macro cache keys and expansion cycles, or a WebGPU
interaction-calculus runtime. Those remain measurements or extensions of this
working baseline.

## Source language

Declarations occupy one line. Supported forms include:

```haskell
data Maybe a = Nothing | Just a
class Eq a where eq :: a -> a -> Bool
instance Eq Int where eq = primEqInt

identity :: a -> a
identity x = x

fromMaybe fallback value = case value of { Nothing -> fallback; Just x -> x }
answer = comptime (6 * 7)
shared = ic ((\x -> x + x) 21)
main = fromMaybe 0 (Just (identity answer))
```

Expressions support integers, booleans, variables, lambdas, application, `let`,
`if`, `case`, `+`, `-`, `*`, `==`, `comptime`, and `ic`.

Macro definitions use a deliberately tiny staged language:

```haskell
macro makeIdentity = identity
makeIdentity!(generatedId)

macro makeConstant = constant
makeConstant!(answer, 42)
```

Each invocation instantiates a generated Wasm module. `identity` and `constant`
are the only macro operations in this artifact. The host exposes only
`emit_identity` or `emit_constant`; there is no ambient filesystem, network,
clock, or process import.

## Important boundaries

- Source evaluation is eager. This artifact does not yet implement Haskell
  thunks, sharing, `IO`, exceptions, or an STG runtime.
- HM inference supports rank-1 polymorphism. GADTs, type families, implication
  constraints, overlapping instances, and general recursive class solving remain
  outside the accepted language.
- Wasm lowering supports direct, saturated calls and scalar `i32`
  representations. Nested runtime lambdas are inferred but rejected by lowering
  because closure conversion is not implemented yet.
- The packed ADT representation supports nullary and unary constructors. It
  stores the tag in the low eight bits and the scalar payload above it; it is an
  experiment, not the final FCG heap ABI.
- `comptime` accepts closed scalar expressions. Its WGSL evaluator has a 64-word
  stack and explicit fuel.
- The interaction-calculus backend is a pinned CPU reference experiment. It
  implements the four relevant higher-order interactions plus scalar rules; it
  is not HVM2/HVM4 and makes no claim to reproduce their performance.
- The WebGPU type solver caps the flat graph at 512 terms so its quadratic
  reachability matrix remains an honest proof-of-concept cost.
- Parsing is line-oriented. Multi-line layout, imports, modules, and the
  complete Haskell grammar are not implemented.

These boundaries are rejected with evidence-bearing errors rather than accepted
with altered semantics.

## Architecture

```text
source
  -> lexer/parser
  -> Wasm macro expansion with scope sets
  -> name resolution and dependency SCCs
  -> CPU HM oracle + flat equality capture
  -> WebGPU equality closure (differential)
  -> IC and CPU/GPU bytecode compile-time evaluation
  -> final type inference
  -> FCG operation rows
  -> exact Wasm binary emission
  -> WebAssembly.validate / instantiate
```

The JavaScript host controls every WebGPU dispatch and Wasm instantiation. User
source never becomes WGSL.

## Files

- `src/syntax.ts`, `lexer.ts`, `parser.ts`: source boundary.
- `src/resolution.ts`, `types.ts`: CPU reference frontend and FTCG equality
  capture.
- `src/gpu_solver.ts`: WebGPU union and occurs-check kernels.
- `src/comptime.ts`: CPU and WebGPU compile-time bytecode.
- `src/macros.ts`: hygienic Wasm macro boundary.
- `src/interaction.ts`: pinned interaction-calculus experiment.
- `src/fcg.ts`, `wasm.ts`: FCG lowering and dependency-free Wasm encoding.
- `src/compiler.ts`, `cli.ts`: orchestration and commands.
- `tests/compiler.test.ts`: observable regression and differential tests.

No third-party runtime dependency is used.

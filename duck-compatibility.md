# Ducklang grammar compatibility slice

This frontend follows the production shapes in Binned's Duck grammar. The syntax
and backend milestones are deliberately separate: Baba owns complete syntax
acceptance, while the existing scalar bridge demonstrates that an admitted
subset can target the shared GPU-assisted compiler pipeline.

The compatibility fixtures were copied from the Binned working tree under its
MIT license. The notice is preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Baba 6 syntax frontend

The project pins `@mewhhaha/baba` 6.0.0. Baba now supports portable trailing
lookahead guards and parser-state promotion for contextual trivia in its
generated Wasm runtime. The integration gate exercises all five distinctions
formerly implemented by Duck's external scanner:

- application whitespace and its stop keywords;
- type-application whitespace;
- `break` value whitespace;
- `break` terminator whitespace;
- extension-member newline terminators.

The vendored `grammar/binned-tree-sitter-grammar.json` snapshot is translated
into `grammar/duck.baba`. Tree-sitter precedence annotations become explicit
effect, expression, and type layers; attributed statements are left-factored;
and Baba metadata records deterministic LR choices. A few prefixes requiring
more than one token of lookahead use portable fused DFA tokens. Their complete
source text remains available to cursor lowering.

The generated standalone Wasm parser accepts all 118 vendored `.duck` files.
This establishes syntax compatibility, not type checking or execution parity.
The admitted grammar below describes the transitional scalar backend bridge.

## Admitted grammar

The implemented contract can be summarized as:

```ebnf
source       = { binding | assignment }, expression ;
binding      = "let", [ "rec" ], identifier, "=", expression ;
assignment   = identifier, ( "=" | ":=" ), expression ;
expression   = arrow | if | block | binary | call | primary ;
arrow        = ( identifier | "(", identifiers, ")" ), "=>", expression ;
if           = "if", expression, block, "else", ( block | if ) ;
block        = "{", { binding | assignment }, expression, "}" ;
binary       = expression, ( "+" | "-" | "*" | "==" ), expression ;
call         = expression, "(", [ expressions ], ")" ;
primary      = i32 | boolean | identifier | "(", expression, ")"
             | "comptime", expression ;
```

Newlines and semicolons terminate statements. `//` comments are ignored. Integer
literals may be unsuffixed or use `i32`. Operator precedence matches the
corresponding Binned productions for the admitted operators.

## Lowering invariants

- Every top-level Duck binding becomes a pure core value declaration.
- Rebindings receive deterministic internal generations such as `factor__duck2`;
  uses are rewritten to the generation visible at that source position.
- `=` emits a pure, unreachable-branch type witness that unifies the previous
  and new generations; `:=` omits that witness so its generation may have a
  different type.
- A top-level arrow becomes a direct core function. Captured top-level values
  become dependency edges, so no runtime closure is needed for this case.
- Local scalar bindings become nested core `let` expressions.
- Multi-argument calls become curried applications in the source AST and are
  recovered as saturated direct calls by FCG lowering.
- Duck `==` admits the existing integer equality primitive during inference;
  generated Wasm still contains the ordinary `i32.eq` instruction.
- Explicit `comptime` uses the same bounded CPU/WebGPU bytecode evaluation as
  the Haskell-like frontend.

## Explicitly rejected grammar families

| Duck grammar family                                    | Required compiler representation                            |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `const` and compile-time functions                     | dependency-aware staged environment and specialization      |
| numeric widths other than signed i32                   | typed scalar FCG operations and additional Wasm value types |
| `/`, `%`, comparisons, logic, custom fixity            | corresponding typed primitive operations                    |
| strings, characters, arrays, products, structs, unions | memory layout and aggregate FCG values                      |
| local and returned functions                           | closure conversion and indirect calls                       |
| `return`, loops, `break`, `continue`                   | structured control-flow regions                             |
| modules, imports, includes                             | module graph and linking contract                           |
| effects, handlers, ownership, borrowing                | effect rows, linearity proofs, and resource-aware lowering  |
| type declarations and annotations                      | Duck type syntax elaboration into shared type terms         |
| pattern, `match`, and `if let` forms                   | full pattern decision trees and aggregate projections       |

Each recognized but unsupported construct fails at the source boundary with its
file offset and the missing representation. Unknown syntax is never silently
reinterpreted as Haskell-like source.

## Backend result

The copied programs compile to validated Wasm and return the same values as
Binned: arithmetic/shadowing returns 42, functions/blocks returns 42, `else if`
returns 42, and lexical capture returns 43. This demonstrates that the shared
core is already usable as a second frontend target for pure scalar programs. It
does not yet demonstrate that the core is sufficient for all of Ducklang; the
rejection table is the concrete growth plan.

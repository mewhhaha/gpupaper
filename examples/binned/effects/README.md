# Effect examples

These examples exercise file modules, opaque host effects, inferred and
annotated operation rows, effectful `<-` binding, and swappable runners.

- `01_inferred_io.duck` infers `Io.read` and `Io.print` from direct operation
  calls.
- `02_annotated_effect_row.duck` uses `-> <row>` function types as checked upper
  bounds and forwards the inferred row through `read_name()`.
- `03_cli_stdin_stdout.duck` declares separate `Stdin` and `Stdout` effects. Its
  neighboring Deno adapter exposes explicit live, mock, and custom effect
  runners. The CLI selects a runner before calling `main(runner)`.
- `../handlers/01_local_counter.duck` implements a deep, stateful `Counter`
  effect entirely inside Duck and installs it with `try ... with ...`.
- `../handlers/02_inferred_option_do.duck` imports the `Do` defaults and lets
  `try calculate()` select Option's exact affine interpretation.
- `../handlers/03_composed_default_handlers.duck` defines two source default
  handlers. The lower-order handler runs inside the higher-order handler, so
  their return transformations produce `(10 + 10) * 2 + 2 = 42`.
- `multi_file/` separates a host interface, an effect-using module, and an entry
  module. `host.duck` is supplied as the compiler's host interface; it is not an
  authority-bearing runtime import.

Run the command-line example with live stdin/stdout:

```sh
deno run --allow-read --allow-run=wat2wasm \
  examples/effects/03_cli_stdin_stdout.ts
```

Or run it without touching host stdin/stdout:

```sh
deno run --allow-read --allow-run=wat2wasm \
  examples/effects/03_cli_stdin_stdout.ts --dry-run
```

The managed Duck entry still has the current single-parameter shape
`module (!init: Init) where`. The Deno adapter keeps runner selection outside
`main`: `live_runner()` grants Deno stdin/stdout authority, while
`mock_runner()` grants deterministic mock effects and exposes its captured
`stdout` array. Use `DuckRunner(init)` to supply another complete handler set.

The host gives only the entry module an `Init` value. The entry narrows that
authority when it instantiates `logger.duck`, and the imported file exports an
effectful function through its final record.

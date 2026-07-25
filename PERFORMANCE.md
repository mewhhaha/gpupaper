# Ducklang frontend performance

These measurements were recorded on 2026-07-24 with:

- NVIDIA GeForce RTX 4080 SUPER, vendor `4318`, device `9986`;
- Deno 2.9.2, V8 14.9.207.2, TypeScript 6.0.3;
- Linux 7.1.3-2-cachyos on x86-64;
- the frozen Binned snapshot whose digest is
  `610f8d487a19d9d20e879bc7ed7b740a1975f828e12e5111a8d45a606f6dffad`;
- gpupaper base commit `76f44462df2294577445c9c27427dbeea4bc70f6` plus the
  working changes described by `TASKS.md`.

The Codex Wasm byte count has since changed and is annotated in the table below.
Every other figure was re-verified against the current tree: all six source byte
counts and the Editor, grep, tar, wav, and raytracer Wasm byte counts are
unchanged. The timing columns are not re-measured here, because reproducing them
faithfully requires the recorded hardware and adapter above.

The command was:

```sh
deno task benchmark:frontend
```

Each warm value is the median of five compilations in one process. CPU mode
disables WebGPU. GPU mode requires the adapter and rejects any CPU/GPU Wasm byte
mismatch. Parser initialization is measured separately from syntax and AST
lowering.

## End-to-end results

All times are milliseconds.

| Target    | Source bytes | Cold parser | Warm parser | First CPU compile | Warm CPU compile | First GPU compile | Warm GPU compile | Wasm bytes |
| --------- | -----------: | ----------: | ----------: | ----------------: | ---------------: | ----------------: | ---------------: | ---------: |
| Editor    |       25,256 |      223.75 |       41.66 |            319.44 |           131.88 |            553.76 |           191.43 |     8,385² |
| Codex     |        3,573 |      124.94 |        4.63 |            525.77 |           321.25 |            546.36 |           401.32 |  26,942¹ ² |
| grep      |        2,856 |      117.90 |        2.64 |            209.26 |            66.60 |            218.32 |            91.83 |     1,428² |
| tar       |        6,587 |      121.12 |        9.86 |            242.25 |           101.92 |            385.19 |           197.67 |     8,461² |
| wav       |        2,047 |      134.13 |        3.29 |            913.09 |           734.93 |          1,058.20 |         1,110.00 |    802,312 |
| raytracer |        3,952 |      144.16 |        7.00 |            413.58 |           253.75 |            444.71 |           285.71 |    183,403 |

¹ Recorded as 26,837 on 2026-07-24. Codex grew by 93 bytes when value-level
hygiene stopped the linker from silently dropping a dependency's private binding
whose name collided with one of the importer's, so bindings that were previously
discarded are now retained. The other five targets emit byte-identical output.

² Grew by 12 bytes when an effectful module-level binding moved from a
zero-argument function that each reference called into a mutable global computed
once in main's prologue, which fixed a re-performed host effect. The 12 bytes
are the global declaration plus one store and the load. wav and raytracer are
unchanged, because neither binds an effect at module level.

The cold parser cost is dominated by loading and instantiating the generated
Baba parser. Its warm initialization component is below 0.003 ms for every
target; warm syntax and AST work scale with the source being parsed.

## Warm backend boundaries

These are medians from the same five GPU-mode samples. “CPU backend” currently
includes FCG construction, immutable flat-FCG rewrite selection, Wasm layout,
and CPU byte emission. GPU emission independently encodes the same Wasm plan.

| Target    | GPU type differential | CPU backend | GPU Wasm emission |
| --------- | --------------------: | ----------: | ----------------: |
| Editor    |                 30.01 |       20.24 |             13.94 |
| Codex     |                 70.41 |       57.94 |             16.67 |
| grep      |                 13.21 |        2.22 |             12.38 |
| tar       |                 76.58 |       21.13 |             13.85 |
| wav       |                 13.16 |      850.66 |            169.34 |
| raytracer |                 13.65 |      149.22 |             51.44 |

The generated-buffer applications are deliberately revealing: their source is
small, but the current backend unrolls one operation per output byte. That
inflates both Wasm size and CPU backend time. It is a backend representation
cost, not a parser or type-system cost, and is the next meaningful optimization
boundary for those targets.

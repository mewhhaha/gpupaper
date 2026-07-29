# Ducklang frontend performance

These measurements were recorded on 2026-07-29 with:

- NVIDIA GeForce RTX 4080 SUPER, vendor `4318`, device `9986`;
- Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3;
- Linux 7.1.5-1-cachyos on x86-64;
- Binned revision `ac535c400e21f94787b41098d0657790fcdcb553`;
- frozen source digest
  `610f8d487a19d9d20e879bc7ed7b740a1975f828e12e5111a8d45a606f6dffad`;
- gpupaper commit `b03f642`.

The command was:

```sh
deno task benchmark:frontend
```

Each warm value is the median of five compilations in one process. CPU mode
disables WebGPU. GPU mode requires the adapter, validates and rewrites flat Core
on the GPU, emits the Wasm plan independently on CPU and GPU, and rejects any
byte mismatch. Times are milliseconds.

## End-to-end and structural results

| Target    | Source bytes | Cold parser | Warm parser | First CPU | Warm CPU | First GPU | Warm GPU | Functions | Core ops | GPU records | Wasm bytes |
| --------- | -----------: | ----------: | ----------: | --------: | -------: | --------: | -------: | --------: | -------: | ----------: | ---------: |
| Editor    |       25,256 |      240.31 |       51.14 |    466.18 |   216.05 |    679.03 |   270.25 |        74 |    1,268 |      31,085 |     22,382 |
| Codex     |        3,573 |      147.81 |        3.67 |  2,264.20 | 1,498.11 |  2,224.98 | 1,972.40 |       493 |   16,412 |     332,802 |    283,648 |
| grep      |        2,856 |      212.68 |        5.65 |    396.20 |   123.67 |    388.24 |   117.14 |        12 |      166 |       4,874 |      3,911 |
| tar       |        6,587 |      116.30 |        9.67 |    294.80 |   192.51 |    718.12 |   388.87 |        12 |    1,576 |      28,832 |     26,106 |
| wav       |        2,047 |      110.26 |        2.60 |    190.32 |    64.61 |    255.04 |   109.35 |         6 |      130 |       3,390 |      2,520 |
| raytracer |        3,952 |      160.48 |        4.23 |    245.27 |    67.63 |    266.31 |   110.70 |        15 |      229 |       5,495 |      3,855 |

The roughly constant cold parser cost is generated Baba parser loading and
instantiation. Warm syntax and AST lowering then scale with the source.

## Warm GPU-mode pipeline boundaries

| Target    | Elaborate | Resolve | Initial type | Comptime |  Core | Flat Core | CPU rewrite | GPU init | GPU rewrite | Transfer | CPU Wasm | GPU Wasm |
| --------- | --------: | ------: | -----------: | -------: | ----: | --------: | ----------: | -------: | ----------: | -------: | -------: | -------: |
| Editor    |     60.37 |    2.76 |         7.49 |    21.87 |  4.08 |      4.16 |       17.52 |     0.01 |       11.38 |     0.25 |    10.40 |    16.12 |
| Codex     |    322.79 |   22.52 |        49.11 |   272.44 | 55.85 |     63.30 |      270.77 |     0.01 |       12.17 |     1.65 |   109.25 |    49.75 |
| grep      |     56.44 |    0.52 |         1.39 |     1.47 |  0.55 |      0.67 |        2.82 |     0.00 |       11.34 |     0.17 |     1.18 |    12.70 |
| tar       |     91.99 |    6.18 |        12.99 |    15.27 |  5.27 |      5.78 |       27.71 |     0.01 |       11.37 |     0.27 |     9.40 |    15.15 |
| wav       |     62.35 |    0.13 |         0.28 |     0.24 |  0.31 |      0.50 |        1.84 |     0.00 |       11.27 |     0.14 |     0.92 |    12.50 |
| raytracer |     56.06 |    0.19 |         0.46 |     0.76 |  0.47 |      0.73 |        2.41 |     0.00 |       11.29 |     0.15 |     1.40 |    12.65 |

`finalTypeMilliseconds` is zero because the semantic frontend now produces the
typed module used by Core directly. GPU mode is currently slower end to end: the
fixed dispatch and differential-emission costs dominate small targets, and Codex
still spends most of its time in semantic elaboration, compile-time
normalization, and the CPU reference rewrite. The GPU run is therefore a
correctness and boundary measurement, not yet a speedup claim.

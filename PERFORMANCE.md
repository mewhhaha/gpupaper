# Ducklang frontend performance

These measurements were recorded on 2026-07-29 with:

- NVIDIA GeForce RTX 4080 SUPER, vendor `4318`, device `9986`;
- Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3;
- Linux 7.1.5-1-cachyos on x86-64;
- Binned revision `ac535c400e21f94787b41098d0657790fcdcb553`;
- frozen source digest
  `610f8d487a19d9d20e879bc7ed7b740a1975f828e12e5111a8d45a606f6dffad`;
- gpupaper commit `a453ba1`.

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
| Editor    |       25,256 |      207.79 |       44.87 |    412.04 |   196.93 |    789.59 |   345.62 |        74 |    1,268 |      31,085 |     22,382 |
| Codex     |        3,573 |      203.91 |        7.38 |  2,074.80 | 1,168.22 |  2,022.57 | 2,405.37 |       493 |   16,412 |     332,802 |    283,648 |
| grep      |        2,856 |      137.09 |        2.70 |    238.55 |    76.79 |    272.58 |   110.38 |        12 |      166 |       4,874 |      3,911 |
| tar       |        6,587 |      115.90 |        7.17 |    302.89 |   169.40 |    459.22 |   389.49 |        12 |    1,576 |      28,832 |     26,106 |
| wav       |        2,047 |      158.86 |        2.39 |    198.87 |    66.84 |    233.09 |   118.36 |         6 |      130 |       3,390 |      2,520 |
| raytracer |        3,952 |      192.05 |        5.66 |    314.49 |   100.66 |    349.74 |   144.50 |        15 |      229 |       5,495 |      3,855 |

The roughly constant cold parser cost is generated Baba parser loading and
instantiation. Warm syntax and AST lowering then scale with the source.

## Warm GPU-mode pipeline boundaries

| Target    | Elaborate | Resolve | Initial type | Comptime |  Core | Flat Core | CPU rewrite | GPU init | GPU rewrite | Transfer | CPU Wasm | GPU Wasm |
| --------- | --------: | ------: | -----------: | -------: | ----: | --------: | ----------: | -------: | ----------: | -------: | -------: | -------: |
| Editor    |     83.59 |    3.39 |         9.66 |    23.99 |  5.66 |      6.58 |       24.53 |     0.01 |       11.46 |     0.35 |     9.99 |    16.35 |
| Codex     |    422.69 |   25.59 |        58.67 |   381.85 | 69.16 |     78.16 |      353.98 |     0.01 |       11.82 |     2.39 |   134.03 |    59.55 |
| grep      |     55.65 |    0.43 |         1.43 |     1.34 |  0.54 |      0.60 |        2.74 |     0.00 |       11.27 |     0.14 |     1.35 |    12.74 |
| tar       |     68.58 |    3.18 |        11.83 |    14.73 |  6.61 |      6.20 |       29.85 |     0.01 |       11.42 |     0.31 |    10.55 |    15.06 |
| wav       |     71.49 |    0.11 |         0.33 |     0.31 |  0.36 |      0.53 |        1.77 |     0.00 |       11.27 |     0.15 |     1.25 |    12.56 |
| raytracer |     82.20 |    0.24 |         0.71 |     1.16 |  0.78 |      1.06 |        3.97 |     0.00 |       11.35 |     0.20 |     2.86 |    13.14 |

`finalTypeMilliseconds` is zero because the semantic frontend now produces the
typed module used by Core directly. GPU mode is currently slower end to end: the
fixed dispatch and differential-emission costs dominate small targets, and Codex
still spends most of its time in semantic elaboration, compile-time
normalization, and the CPU reference rewrite. The GPU run is therefore a
correctness and boundary measurement, not yet a speedup claim.

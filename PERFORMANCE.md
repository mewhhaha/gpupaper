# Ducklang frontend performance

These measurements were recorded on 2026-07-29 with:

- NVIDIA GeForce RTX 4080 SUPER, vendor `4318`, device `9986`;
- Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3;
- Linux 7.1.5-1-cachyos on x86-64;
- frozen Binned snapshot based on `3b033713c93b515540a71d993194ee1a7b5f74c2`;
- frozen source digest
  `610f8d487a19d9d20e879bc7ed7b740a1975f828e12e5111a8d45a606f6dffad`;
- gpupaper commit `cd3fdf5`.

The recorded adapter limits were:

| Limit                               |       Value |
| ----------------------------------- | ----------: |
| Maximum buffer size                 | 268,435,456 |
| Maximum storage-buffer binding size | 134,217,728 |
| Maximum uniform-buffer binding size |      65,536 |
| Maximum workgroups per dimension    |      65,535 |
| Maximum storage buffers per stage   |           8 |
| Maximum uniform buffers per stage   |          12 |

The complete frontend command was:

```sh
deno task benchmark:frontend
```

Each warm value is the median of five compilations in one process. CPU mode
disables WebGPU. GPU mode requires the adapter, verifies type and scalar
compile-time batches, validates and rewrites flat Core on the GPU, independently
emits the Wasm plan on CPU and GPU, and rejects any byte mismatch. Times are
milliseconds.

## End-to-end and structural results

| Target    | Source bytes | Cold parser | Warm parser | First CPU | Warm CPU | First GPU | Warm GPU | Functions | Core ops | GPU records | Wasm bytes |
| --------- | -----------: | ----------: | ----------: | --------: | -------: | --------: | -------: | --------: | -------: | ----------: | ---------: |
| Editor    |       25,256 |      187.69 |       39.35 |    317.92 |   142.94 |    561.60 |   186.82 |        74 |    1,268 |      31,085 |     22,382 |
| Codex     |        3,573 |      111.39 |        3.44 |  1,336.70 |   874.45 |  1,203.46 | 1,205.44 |       493 |   16,412 |     332,802 |    283,648 |
| grep      |        2,856 |      107.51 |        2.92 |    188.67 |    67.20 |    212.49 |   106.33 |        12 |      166 |       4,874 |      3,911 |
| tar       |        6,587 |      108.16 |        8.65 |    239.29 |   128.94 |    329.18 |   202.33 |        12 |    1,576 |      28,832 |     26,106 |
| wav       |        2,047 |      193.85 |        3.94 |    323.23 |    99.70 |    267.21 |    97.03 |         6 |      130 |       3,390 |      2,520 |
| raytracer |        3,952 |      109.08 |        5.60 |    179.36 |    58.87 |    214.60 |   100.09 |        15 |      229 |       5,495 |      3,864 |

The roughly constant cold parser cost is generated Baba parser loading and
instantiation. Warm syntax and AST lowering then scale with the source.

## Warm differential-GPU pipeline boundaries

| Target    | Elaborate | Resolve | Initial type | GPU type | Comptime |  Core | Flat Core | GPU init | GPU rewrite | Transfer | GPU commit | CPU Wasm | GPU Wasm |
| --------- | --------: | ------: | -----------: | -------: | -------: | ----: | --------: | -------: | ----------: | -------: | ---------: | -------: | -------: |
| Editor    |     47.00 |    2.49 |         5.41 |    16.97 |    19.41 |  3.56 |      3.64 |     0.00 |       11.30 |     0.29 |       3.44 |     6.61 |    13.76 |
| Codex     |    245.10 |   17.21 |        38.94 |    60.62 |   220.67 | 40.37 |     45.64 |     0.01 |       12.08 |     5.03 |      44.72 |    73.70 |   132.30 |
| grep      |     52.89 |    0.51 |         1.28 |    14.07 |     1.47 |  0.53 |      0.55 |     0.00 |       11.64 |     0.47 |       0.74 |     1.28 |    14.28 |
| tar       |     56.29 |    3.44 |         7.44 |    22.32 |    11.27 |  5.14 |      5.72 |     0.00 |       11.90 |     0.81 |       5.50 |     8.59 |    34.70 |
| wav       |     50.42 |    0.09 |         0.21 |    12.29 |     0.22 |  0.27 |      0.42 |     0.00 |       11.71 |     0.46 |       0.50 |     0.82 |    14.99 |
| raytracer |     48.48 |    0.18 |         0.43 |    12.25 |     0.81 |  0.50 |      0.63 |     0.00 |       11.74 |     0.48 |       0.72 |     1.25 |    15.43 |

`GPU commit` is deterministic conflict resolution, direct flat-package
compaction, and validation of the package produced from GPU rewrite proposals.
GPU mode does not run the CPU rewrite matcher.

## GPU batch shapes

| Target    | Type terms | Type equalities | Core validation records | Core rewrites | Wasm atoms | Worst-case output buffer | Wasm bytes |
| --------- | ---------: | --------------: | ----------------------: | ------------: | ---------: | -----------------------: | ---------: |
| Editor    |      1,862 |           4,207 |                  31,085 |             0 |     22,309 |                  223,092 |     22,382 |
| Codex     |     11,790 |          28,002 |                 332,802 |             0 |    259,139 |                2,591,392 |    283,648 |
| grep      |        781 |           1,376 |                   4,874 |             0 |      3,897 |                   38,972 |      3,911 |
| tar       |      3,912 |           9,179 |                  28,832 |            24 |     22,201 |                  222,012 |     26,106 |
| wav       |         99 |             264 |                   3,390 |             0 |      2,477 |                   24,772 |      2,520 |
| raytracer |         86 |             292 |                   5,495 |             0 |      3,851 |                   38,512 |      3,864 |

Type constructors are hash-consed before upload, so repeated applications share
one graph node. The Wasm emitter packs four independently written bytes into
each atomic output word. Floating-point `x * 1` is deliberately not rewritten:
bypassing an IEEE-754 operation can change signed-zero or NaN payload bits
observable through reinterpretation.

`finalTypeMilliseconds` is zero because the semantic frontend produces the typed
module used by Core directly. Type solving and scalar compile-time jobs remain
differential against CPU semantics. Core rewrite matching is GPU-authoritative.
Wasm emission is differential in this table; production mode can omit CPU
encoding.

## Authoritative-GPU break-even interval

The break-even command was:

```sh
deno task benchmark:break-even
```

It compiles grep concurrently at batch sizes 1, 2, 4, and 8. GPU mode is
required and authoritative for Core and Wasm; CPU Wasm differential verification
is disabled. Each value is the median of five warmed batches.

| Batch | CPU batch | GPU batch | CPU per compile | GPU per compile | GPU / CPU |
| ----: | --------: | --------: | --------------: | --------------: | --------: |
|     1 |     65.95 |    106.27 |           65.95 |          106.27 |      1.61 |
|     2 |    133.53 |    178.07 |           66.77 |           89.03 |      1.33 |
|     4 |    258.08 |    356.97 |           64.52 |           89.24 |      1.38 |
|     8 |    509.06 |    731.51 |           63.63 |           91.44 |      1.44 |

No break-even was observed through batch size 8, so the measured interval is
strictly above 8 concurrent grep compilations on this hardware and
implementation. This is a bounded statement, not an extrapolated speedup claim.

Differential GPU mode is slower on five of the six warm targets in this sample;
wav is within three milliseconds. Fixed dispatch costs dominate small targets,
while Codex spends most of its time in CPU semantic elaboration and compile-time
normalization. The measurements establish correctness boundaries and current
costs, not a general GPU speedup.

import { compileModuleSource } from "../src/compiler.ts";
import { expandDucklangIncludes } from "../src/ducklang_module_graph.ts";

/**
 * Repeated compilation must produce the same bytes and the same diagnostics.
 *
 * The frontend now generates names from content rather than from traversal
 * order: qualifyDucklangTypeCollisions derives a discriminator from a
 * declaration's file, and hygieniseDucklangDependency derives one from a
 * dependency's canonical source. Both would still compile if they were derived
 * from something order-dependent instead, and the failure would only show up as
 * output that differs between runs, so it needs its own assertion.
 *
 * The existing coverage in tests/compiler.test.ts checks one trivial Haskell
 * program. These cases cover the Ducklang path, including the module-heavy
 * targets where generated names actually occur.
 */

const targets: readonly (readonly [string, string | undefined])[] = [
  [
    "examples/binned/live/case-studies/editor/editor.duck",
    "examples/binned/live/case-studies/editor/host.duck",
  ],
  [
    "examples/binned/live/case-studies/codex/codex.duck",
    "examples/binned/live/case-studies/codex/host.duck",
  ],
  [
    "examples/binned/live/case-studies/grep/grep.duck",
    "examples/binned/live/case-studies/grep/host.duck",
  ],
  ["tests/fixtures/point_layout_app.duck", undefined],
  ["tests/fixtures/private_binding_collision_app.duck", undefined],
  ["tests/fixtures/const_export_app.duck", undefined],
];

for (const [target, host] of targets) {
  Deno.test(
    `Ducklang compilation of ${
      target.split("/").at(-1)
    } is byte-identical across runs`,
    async () => {
      const first = await compile(target, host);
      const second = await compile(target, host);

      assertEquals(first.length === second.length, true);
      assertEquals(digest(first), digest(second));
      // A non-empty module, so an empty result cannot pass as identical.
      assertEquals(first.length > 0, true);
    },
  );
}

Deno.test("Ducklang diagnostics repeat verbatim across runs", async () => {
  const failing = [
    "examples/binned/failures/compile/12_missing_imported_export.duck",
    "examples/binned/failures/compile/01_reused_linear_value.duck",
    "examples/binned/failures/compile/06_missing_struct_field.duck",
  ];
  for (const target of failing) {
    const first = await diagnostic(target);
    const second = await diagnostic(target);
    assertEquals(first, second);
    // The target must actually fail, so a silently compiling program cannot
    // pass as a stable diagnostic.
    assertEquals(first.length > 0, true);
  }
});

Deno.test("Ducklang generated names are stable across runs", async () => {
  // Generated names never reach the emitted bytes, so byte equality cannot see
  // an order-dependent discriminator. The inferred type listing does carry them,
  // so it is the surface this asserts on.
  const collision = "tests/fixtures/private_binding_collision_app.duck";
  const layout = "tests/fixtures/point_layout_app.duck";

  const firstCollision = await inferredNames(collision);
  const secondCollision = await inferredNames(collision);
  assertEquals(firstCollision, secondCollision);

  const firstLayout = await inferredNames(layout);
  const secondLayout = await inferredNames(layout);
  assertEquals(firstLayout, secondLayout);

  // Guard against a vacuous pass: each program must actually carry a generated
  // name, one hygienic binding and one file-qualified type.
  assertEquals(
    firstCollision.some((entry) => /^helper\$[0-9a-f]{8}#/.test(entry)),
    true,
  );
  assertEquals(
    firstLayout.some((entry) => /Point\$[0-9a-f]{8}/.test(entry)),
    true,
  );
});

async function inferredNames(target: string): Promise<readonly string[]> {
  const file = await Deno.realPath(target);
  const artifact = await compileModuleSource(
    file as `${string}.duck`,
    await Deno.readTextFile(file),
    { gpuMode: "off" },
  );
  return artifact.initialTypes;
}

/**
 * The Wasm byte counts recorded in PERFORMANCE.md, pinned so the document cannot
 * silently drift from the compiler again. The Codex figure went stale once
 * already: value-level hygiene grew it by 93 bytes and the table kept the old
 * number. A change here is not a failure, it is a signal to re-record the
 * document and say why the size moved.
 */
const recordedWasmBytes:
  readonly (readonly [string, string | undefined, number])[] = [
    [
      "examples/binned/live/case-studies/editor/editor.duck",
      "examples/binned/live/case-studies/editor/host.duck",
      8373,
    ],
    [
      "examples/binned/live/case-studies/codex/codex.duck",
      "examples/binned/live/case-studies/codex/host.duck",
      26930,
    ],
    [
      "examples/binned/live/case-studies/grep/grep.duck",
      "examples/binned/live/case-studies/grep/host.duck",
      1416,
    ],
    [
      "examples/binned/live/case-studies/tar/tar.duck",
      "examples/binned/live/case-studies/tar/host.duck",
      8449,
    ],
  ];

for (const [target, host, expected] of recordedWasmBytes) {
  Deno.test(
    `Ducklang ${target.split("/").at(-1)} matches its recorded Wasm size`,
    async () => {
      assertEquals((await compile(target, host)).length, expected);
    },
  );
}

async function compile(
  target: string,
  host: string | undefined,
): Promise<Uint8Array> {
  const file = await Deno.realPath(target);
  const source = await expandDucklangIncludes(
    file,
    await Deno.readTextFile(file),
  );
  const artifact = await compileModuleSource(
    file as `${string}.duck`,
    source,
    {
      gpuMode: "off",
      ...(host === undefined
        ? {}
        : { hostInterface: await Deno.realPath(host) }),
    },
  );
  return artifact.wasm;
}

async function diagnostic(target: string): Promise<string> {
  const file = await Deno.realPath(target);
  const source = await expandDucklangIncludes(
    file,
    await Deno.readTextFile(file),
  );
  try {
    await compileModuleSource(file as `${string}.duck`, source, {
      gpuMode: "off",
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${target} was expected to fail compilation`);
}

function digest(bytes: Uint8Array): string {
  // FNV-1a over the emitted module, enough to detect any byte difference.
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${bytes.length}:${hash.toString(16).padStart(8, "0")}`;
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

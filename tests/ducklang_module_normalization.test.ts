import { normalizeDucklangModuleSource } from "../src/compiler.ts";

const livePreludeDirectory = new URL(
  "../examples/binned/live/src/frontend/",
  import.meta.url,
);

Deno.test("every frontend prelude reaches its compile-time module boundary", async () => {
  const expectedExportCounts = new Map<string, number>([
    ["prelude.duck", 12],
    ["prelude_abstractions.duck", 71],
    ["prelude_attributes.duck", 2],
    ["prelude_base64.duck", 2],
    ["prelude_collections.duck", 5],
    ["prelude_csv.duck", 4],
    ["prelude_effect_defaults.duck", 20],
    ["prelude_effects.duck", 0],
    ["prelude_functional.duck", 124],
    ["prelude_iterators.duck", 8],
    ["prelude_json.duck", 30],
    ["prelude_json_encode.duck", 5],
    ["prelude_json_string.duck", 1],
    ["prelude_json_values.duck", 24],
    ["prelude_list.duck", 10],
    ["prelude_numeric.duck", 29],
    ["prelude_numeric_parse.duck", 3],
    ["prelude_path.duck", 5],
    ["prelude_runtime.duck", 89],
    ["prelude_testing.duck", 3],
    ["prelude_text.duck", 32],
    ["prelude_time.duck", 4],
    ["prelude_types.duck", 10],
  ]);
  const recordedPreludes: string[] = [];
  for await (const entry of Deno.readDir(livePreludeDirectory)) {
    if (entry.isFile && /^prelude.*\.duck$/.test(entry.name)) {
      recordedPreludes.push(entry.name);
    }
  }
  recordedPreludes.sort();
  assertEquals(recordedPreludes, [...expectedExportCounts.keys()].sort());

  for (const file of recordedPreludes) {
    const sourceUrl = new URL(file, livePreludeDirectory);
    let source = await Deno.readTextFile(sourceUrl);
    if (file === "prelude_collections.duck") {
      // This prelude deliberately has no imports and is loaded after the ambient
      // type prelude by Binned; make that compilation environment explicit here.
      source = source.replace(
        "module () where",
        'module () where\n\nconst {} = import "duck:prelude/types" ();',
      );
    }
    const artifact = await normalizeDucklangModuleSource(
      sourceUrl.pathname,
      source,
      { gpuMode: "off" },
    );
    assertEquals(artifact.stage, "compileTimeModule");
    assertEquals(
      artifact.value.exports.fields.length,
      expectedExportCounts.get(file),
    );
  }
});

Deno.test("prelude types normalizes to a compile-time export module", async () => {
  const sourceUrl = new URL("prelude_types.duck", livePreludeDirectory);
  const artifact = await normalizeDucklangModuleSource(
    sourceUrl.pathname,
    await Deno.readTextFile(sourceUrl),
    { gpuMode: "off" },
  );

  assertEquals(artifact.stage, "compileTimeModule");
  assertEquals(
    artifact.value.exports.fields.map((field) => field.name),
    [
      "struct",
      "packed",
      "newtype",
      "cast",
      "seal",
      "representation",
      "type_extend",
      "type_union",
      "type_intersection",
      "type_difference",
    ],
  );
});

Deno.test("prelude list specializes to a compile-time export module", async () => {
  const sourceUrl = new URL("prelude_list.duck", livePreludeDirectory);
  const artifact = await normalizeDucklangModuleSource(
    sourceUrl.pathname,
    await Deno.readTextFile(sourceUrl),
    { gpuMode: "off" },
  );

  assertEquals(
    artifact.value.exports.fields.map((field) => field.name),
    [
      "list",
      "list_empty",
      "list_prepend",
      "list_singleton",
      "list_reverse",
      "list_append",
      "list_length",
      "list_take",
      "list_drop",
      "list_nth_or",
    ],
  );
});

Deno.test("prelude normalizes through source-defined type builders", async () => {
  const fields = await normalizePrelude("prelude.duck");
  assertEquals(fields, [
    "struct",
    "packed",
    "newtype",
    "cast",
    "seal",
    "representation",
    "type_extend",
    "type_union",
    "type_intersection",
    "type_difference",
    "not",
    "slice",
  ]);
});

Deno.test("functional prelude specializes every generic export", async () => {
  const fields = await normalizePrelude("prelude_functional.duck");
  assertEquals(fields.length, 124);
  for (
    const required of [
      "compose",
      "list_fold_left",
      "text_truncate_middle_tokens",
      "format_f32",
      "f32x4_divide",
    ]
  ) {
    if (!fields.includes(required)) {
      throw new Error(`functional prelude is missing export ${required}`);
    }
  }
});

Deno.test("iterator prelude specializes its generic combinators", async () => {
  assertEquals(await normalizePrelude("prelude_iterators.duck"), [
    "iterator_map",
    "iterator_zip",
    "iterator_scan",
    "iterator_fold",
    "iterator_find",
    "iterator_find_index",
    "iterator_count",
    "iterator_windows",
  ]);
});

async function normalizePrelude(file: string): Promise<(string | undefined)[]> {
  const sourceUrl = new URL(file, livePreludeDirectory);
  const artifact = await normalizeDucklangModuleSource(
    sourceUrl.pathname,
    await Deno.readTextFile(sourceUrl),
    { gpuMode: "off" },
  );
  return artifact.value.exports.fields.map((field) => field.name);
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

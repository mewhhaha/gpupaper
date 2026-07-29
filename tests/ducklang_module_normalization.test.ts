import { normalizeDucklangModuleSource } from "../src/compiler.ts";

const livePreludeDirectory = new URL(
  "../examples/binned/live/src/frontend/",
  import.meta.url,
);

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

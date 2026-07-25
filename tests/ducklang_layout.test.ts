import type { DucklangCoreModule } from "../src/ducklang_core.ts";
import { lowerDucklangToCore } from "../src/ducklang_core.ts";
import { planDucklangCoreLayouts } from "../src/ducklang_layout.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * Layout planning over Core types.
 *
 * The assertions are exact sizes, alignments, and offsets rather than
 * relationships, because a planner that returned a constant would satisfy
 * "alignment divides size" and most other invariants. Padding is checked where it
 * actually occurs, which is the case a naive sum-of-sizes implementation gets
 * wrong.
 */

function layoutsOf(types: DucklangCoreModule["types"]) {
  return planDucklangCoreLayouts({
    schemaVersion: 1,
    file: "layout.duck",
    types,
    signatures: [],
    functions: [],
    entryFunction: 0 as never,
  });
}

Deno.test("Ducklang scalar layouts match their Wasm storage", () => {
  const plan = layoutsOf([
    { kind: "scalar", scalar: "i32" },
    { kind: "scalar", scalar: "i64" },
    { kind: "scalar", scalar: "f32" },
    { kind: "scalar", scalar: "f64" },
    { kind: "scalar", scalar: "f32x4" },
    { kind: "scalar", scalar: "unit" },
  ]);
  const sizes = plan.typeLayouts.map((id) => plan.layouts[id].size);
  const alignments = plan.typeLayouts.map((id) => plan.layouts[id].alignment);

  assertEquals(sizes, [4, 8, 4, 8, 16, 0]);
  assertEquals(alignments, [4, 8, 4, 8, 16, 1]);
});

Deno.test("LayoutId is independent of CoreTypeId", () => {
  const plan = layoutsOf([
    { kind: "scalar", scalar: "i32" },
    { kind: "scalar", scalar: "f32" },
  ]);

  // Two distinct semantic types, one shared layout: that separation is the
  // point of a separate identity.
  assertEquals(plan.typeLayouts[0], plan.typeLayouts[1]);
  assertEquals(plan.layouts.length, 1);
});

Deno.test("Ducklang product layouts pad each field to its alignment", () => {
  const plan = layoutsOf([
    { kind: "scalar", scalar: "i32" },
    { kind: "scalar", scalar: "i64" },
    // { i32, i64 } pads before the i64; { i64, i32 } pads at the tail. Both end
    // up 16 bytes with offsets [0, 8], so neither ordering is the discriminating
    // case; the all-i32 product below is.
    { kind: "product", fields: [0, 1] as never },
    { kind: "product", fields: [1, 0] as never },
  ]);
  const mixed = plan.layouts[plan.typeLayouts[2]];
  const reversed = plan.layouts[plan.typeLayouts[3]];
  if (mixed.kind !== "product" || reversed.kind !== "product") {
    throw new Error("expected product layouts");
  }

  assertEquals(mixed.offsets, [0, 8]);
  assertEquals(mixed.size, 16);
  assertEquals(mixed.alignment, 8);

  assertEquals(reversed.offsets, [0, 8]);
  assertEquals(reversed.size, 16);
  assertEquals(reversed.alignment, 8);

  // An all-i32 pair packs with no padding, which a planner that always aligned
  // to eight would get wrong.
  const packed = layoutsOf([
    { kind: "scalar", scalar: "i32" },
    { kind: "product", fields: [0, 0] as never },
  ]);
  const pair = packed.layouts[packed.typeLayouts[1]];
  if (pair.kind !== "product") throw new Error("expected a product layout");
  assertEquals(pair.offsets, [0, 4]);
  assertEquals(pair.size, 8);
  assertEquals(pair.alignment, 4);
});

Deno.test("Ducklang sum layouts reserve a tag and the widest payload", () => {
  const plan = layoutsOf([
    { kind: "scalar", scalar: "i32" },
    { kind: "scalar", scalar: "i64" },
    { kind: "sum", cases: [0, 1] as never },
    { kind: "sum", cases: [0, 0] as never },
  ]);
  const wide = plan.layouts[plan.typeLayouts[2]];
  const narrow = plan.layouts[plan.typeLayouts[3]];
  if (wide.kind !== "sum" || narrow.kind !== "sum") {
    throw new Error("expected sum layouts");
  }

  // The i64 payload forces eight-byte alignment, so the payload starts at 8.
  assertEquals(wide.tagOffset, 0);
  assertEquals(wide.tagSize, 4);
  assertEquals(wide.payloadOffset, 8);
  assertEquals(wide.size, 16);
  assertEquals(wide.alignment, 8);

  // With only i32 payloads the payload packs immediately after the tag.
  assertEquals(narrow.payloadOffset, 4);
  assertEquals(narrow.size, 8);
  assertEquals(narrow.alignment, 4);
});

Deno.test("Ducklang buffers and functions lay out as managed handles", () => {
  const plan = layoutsOf([
    { kind: "buffer", buffer: "text" },
    { kind: "buffer", buffer: "bytes" },
  ]);

  for (const id of plan.typeLayouts) {
    const layout = plan.layouts[id];
    assertEquals(layout.kind, "handle");
    assertEquals(layout.size, 4);
    assertEquals(layout.alignment, 4);
  }
  // Text and Bytes stay distinct semantic types that currently share a
  // representation, so they share a layout.
  assertEquals(plan.typeLayouts[0], plan.typeLayouts[1]);
});

Deno.test("Ducklang layout planning rejects a self-containing type", () => {
  try {
    layoutsOf([{ kind: "product", fields: [0] as never }]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/recursive and has no direct layout/.test(message)) {
      throw new Error(`unexpected diagnostic ${JSON.stringify(message)}`);
    }
    return;
  }
  throw new Error("expected a recursive-layout diagnostic");
});

Deno.test("Ducklang layout planning is deterministic for a real program", async () => {
  const source =
    "type Pair = struct { .x = Int, .y = Int }\nlet f = () => {\n  let p: Pair = [1, 2]\n  p.x + p.y\n}\nf()\n";
  const plan = async () => {
    const parsed = await parseDucklangModule("layout_program.duck", source);
    return planDucklangCoreLayouts(
      lowerDucklangToCore(inferDucklangModule(resolveDucklangModule(parsed))),
    );
  };
  const first = await plan();
  const second = await plan();

  assertEquals(JSON.stringify(first), JSON.stringify(second));
  // Every Core type received a layout, and every referenced layout is in range.
  assertEquals(
    first.typeLayouts.every((id) => id < first.layouts.length),
    true,
  );
  assertEquals(first.layouts.length > 0, true);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

import { compileModuleSource, runMain } from "../src/compiler.ts";
import {
  primitiveDescriptor,
  PrimitiveId,
} from "../src/ducklang_primitives.ts";

/**
 * A source-defined generic list must compile through ordinary product and sum
 * machinery, with no list-specific construct anywhere in the compiler.
 *
 * The value assertions matter more than compilation succeeding: a list whose
 * cells were laid out or traversed wrongly would still compile, and only the
 * traversal result shows the cells are linked in the right order with the right
 * elements.
 */

const genericList =
  `type Cell value = struct { .head = value, .tail = List value }
type List value = | \`Cons Cell value | \`Nil Unit

let sum_list = rec (l: List Int) => {
  if let \`Cons cell = l {
    cell.head + sum_list(cell.tail)
  } else {
    0
  }
}

let empty: List Int = \`Nil ()
let one: List Int = \`Cons ([2, empty])
let two: List Int = \`Cons ([40, one])
sum_list(two)
`;

Deno.test("Ducklang compiles a generic source list through products and sums", async () => {
  // 40 + 2 + 0: the traversal must visit both cells in order and stop at Nil.
  assertEquals(await run("generic_list.duck", genericList), 42);
});

Deno.test("Ducklang list element order is observable", async () => {
  // Order-sensitive so a traversal that reversed or repeated a cell fails rather
  // than coincidentally summing to the same total.
  const ordered = genericList.replace(
    "cell.head + sum_list(cell.tail)",
    "(cell.head * 10) + sum_list(cell.tail)",
  );

  // (40*10) + (2*10) = 420, only if head is read once per cell in order.
  assertEquals(await run("ordered_list.duck", ordered), 420);
});

Deno.test("Ducklang lists reuse a shared tail without copying it", async () => {
  const shared = `type Cell value = struct { .head = value, .tail = List value }
type List value = | \`Cons Cell value | \`Nil Unit

let sum_list = rec (l: List Int) => {
  if let \`Cons cell = l {
    cell.head + sum_list(cell.tail)
  } else {
    0
  }
}

let empty: List Int = \`Nil ()
let tail: List Int = \`Cons ([2, empty])
let left: List Int = \`Cons ([10, tail])
let right: List Int = \`Cons ([30, tail])
sum_list(left) + sum_list(right)
`;

  // 10 + 2 + 30 + 2 = 44: the shared tail contributes to both lists.
  assertEquals(await run("shared_tail.duck", shared), 44);
});

Deno.test("Ducklang has no list-specific primitive", () => {
  // The roadmap forbids list opcodes, so no primitive may be named for lists.
  const named = Object.values(PrimitiveId).flatMap((id) => {
    const descriptor = primitiveDescriptor(id);
    return /list/i.test(descriptor.name) ? [descriptor.name] : [];
  });

  assertEquals(named, []);
});

async function run(name: string, source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource(
    name as `${string}.duck`,
    source,
    { gpuMode: "off" },
  );
  return await runMain(artifact.wasm);
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

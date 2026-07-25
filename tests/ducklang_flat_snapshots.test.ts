import type { FcgModule } from "../src/fcg.ts";
import { rewriteFlatFcg } from "../src/fcg_rewrite.ts";
import { flattenFcgModule, validateFlatFcgPackage } from "../src/flat_fcg.ts";

/**
 * Initial IDs follow source order, and a rewrite batch rebuilds rather than mutates.
 *
 * Both properties are what let a rewrite be reasoned about at all: IDs that depended on
 * traversal order would make a package's meaning depend on how it was built, and a rewriter
 * that edited its input in place would leave no snapshot to compare a batch against.
 *
 * The immutability check compares the input's columns before and after by value, not by
 * identity, because a rewriter could hand back a fresh object while still having written
 * through to the arrays it shares with the snapshot.
 */

function module(): FcgModule {
  return {
    functions: [
      {
        name: "alpha",
        parameters: ["a"],
        localCount: 1,
        operations: [
          { opcode: "const", operands: [0], sourceStart: 10, regionId: 0 },
          { opcode: "i32.+", operands: [], sourceStart: 11, regionId: 0 },
          { opcode: "drop", operands: [], sourceStart: 12, regionId: 0 },
        ],
      },
      {
        name: "beta",
        parameters: [],
        localCount: 0,
        operations: [
          { opcode: "const", operands: [1], sourceStart: 20, regionId: 0 },
          { opcode: "drop", operands: [], sourceStart: 21, regionId: 0 },
        ],
      },
    ],
    constructorTags: new Map(),
  };
}

Deno.test("flat FCG assigns initial IDs in source order", () => {
  const flat = flattenFcgModule(module());
  validateFlatFcgPackage(flat);

  // Functions keep declaration order, and each one's operations occupy a contiguous
  // range beginning where the previous function's ended.
  assertEquals([...flat.functionOperationStarts], [0, 3]);
  assertEquals([...flat.functionOperationCounts], [3, 2]);
  // Operation order within a function follows the source, so the recorded source
  // positions come out ascending rather than permuted.
  assertEquals([...flat.operationSourceStarts], [10, 11, 12, 20, 21]);
});

Deno.test("flat FCG flattening is deterministic", () => {
  const first = flattenFcgModule(module());
  const second = flattenFcgModule(module());

  // Every column, so a difference in any single one shows up rather than only the
  // columns a spot check happened to name.
  assertEquals(columns(first), columns(second));
});

Deno.test("flat FCG rewrites rebuild instead of mutating the snapshot", () => {
  const snapshot = flattenFcgModule(module());
  const before = columns(snapshot);

  const result = rewriteFlatFcg(snapshot);

  // The snapshot handed in is untouched, by value rather than by identity.
  assertEquals(columns(snapshot), before);
  // And the result is a package in its own right, not the same one returned.
  validateFlatFcgPackage(result.package);
  assertEquals(result.package === snapshot, false);
});

Deno.test("flat FCG rewrite results are reproducible", () => {
  const first = rewriteFlatFcg(flattenFcgModule(module()));
  const second = rewriteFlatFcg(flattenFcgModule(module()));

  assertEquals(columns(first.package), columns(second.package));
  assertEquals(first.accepted, second.accepted);
});

function columns(package_: Record<string, unknown>): string {
  const entries: (readonly [string, readonly number[]])[] = [];
  for (const [key, value] of Object.entries(package_)) {
    if (value instanceof Uint32Array || value instanceof Uint8Array) {
      entries.push([key, [...value]]);
    }
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  if (entries.length === 0) throw new Error("package exposed no columns");
  return JSON.stringify(entries);
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

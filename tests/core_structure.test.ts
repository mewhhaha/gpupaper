import { compileZeroSource } from "../examples/zero/compiler.ts";
import { zeroWorkloads } from "../examples/zero/workloads.ts";
import { measureCoreStructure } from "../scripts/core_structure.ts";

Deno.test("Core structure separates reachability sharing and partial operations", async () => {
  const compiled = await compileZeroSource(
    "structure.zero",
    `
      private: dead value = @value 3 * ;
      private: shared value = 100 @value / ;
      private: left value = @value call:shared:1 7 + ;
      private: right value = @value call:shared:1 11 - ;
      export: run seed rounds = @seed call:left:1 @seed call:right:1 + ;
    `,
  );
  const structure = measureCoreStructure(compiled.core);
  assertEquals(structure.coreFunctions, 5, "function count");
  assertEquals(structure.reachableCoreFunctions, 4, "reachable functions");
  assertEquals(structure.deadCoreFunctions, 1, "dead functions");
  assertEquals(structure.directCallSites, 4, "direct calls");
  assertEquals(structure.maximumCalleeReferences, 2, "callee multiplicity");
  assertEquals(structure.partialScalarOperations, 1, "partial operations");
  assertEquals(structure.maximumCallDepth, 2, "call depth");
  if (structure.recursiveCallGraph) {
    throw new Error("acyclic structure was classified as recursive");
  }
  if (structure.maximumBlockLiveValues < 2) {
    throw new Error(
      `maximum live values was ${structure.maximumBlockLiveValues}; expected at least 2`,
    );
  }
});

Deno.test("complexity workloads certify their claimed structural boundary", async () => {
  for (const workload of zeroWorkloads.slice(6)) {
    const source = await Deno.readTextFile(workload.zeroSourceUrl);
    const compiled = await compileZeroSource(
      workload.zeroSourceUrl.pathname,
      source,
    );
    const structure = measureCoreStructure(compiled.core);
    switch (workload.name) {
      case "07-shared-call-dag":
        assertEquals(
          structure.maximumCalleeReferences,
          2,
          "shared callee multiplicity",
        );
        break;
      case "08-wide-binding-frontier":
        if (structure.maximumBlockLiveValues < 5) {
          throw new Error(
            `wide frontier had ${structure.maximumBlockLiveValues} live values; expected at least 5`,
          );
        }
        break;
      case "09-partial-lazy":
        assertEquals(
          structure.partialScalarOperations,
          1,
          "guarded partial operations",
        );
        break;
      case "10-dead-module":
        assertEquals(structure.reachableCoreFunctions, 2, "live functions");
        assertEquals(structure.deadCoreFunctions, 16, "dead functions");
        break;
      case "11-polynomial":
        assertEquals(structure.maximumCallDepth, 1, "monolithic call depth");
        break;
      case "12-deep-polynomial-chain":
        if (
          structure.maximumCallDepth === null || structure.maximumCallDepth < 13
        ) {
          throw new Error(
            `deep chain had call depth ${structure.maximumCallDepth}; expected at least 13`,
          );
        }
        break;
      case "13-shared-polynomial-dag":
        assertEquals(
          structure.maximumCalleeReferences,
          2,
          "polynomial callee multiplicity",
        );
        break;
      case "14-dynamic-nested-fold":
        assertEquals(
          structure.partialScalarOperations,
          1,
          "dynamic-fold partial operations",
        );
        assertEquals(structure.maximumCallDepth, 2, "nested-fold call depth");
        break;
      default:
        throw new Error(`unclassified complexity workload ${workload.name}`);
    }
  }
});

Deno.test("recursive call graphs have no finite DAG depth", async () => {
  const compiled = await compileZeroSource(
    "recursive.zero",
    `
      private: recurse value = @value call:recurse:1 ;
      export: run seed rounds = @seed call:recurse:1 ;
    `,
  );
  const structure = measureCoreStructure(compiled.core);
  if (!structure.recursiveCallGraph) {
    throw new Error("recursive call graph was classified as acyclic");
  }
  if (structure.maximumCallDepth !== null) {
    throw new Error(
      `recursive call depth was ${structure.maximumCallDepth}; expected null`,
    );
  }
});

function assertEquals(
  actual: number | null,
  expected: number,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`${label} was ${actual}; expected ${expected}`);
  }
}

import { compileZeroSource } from "../examples/zero/compiler.ts";
import { zeroWorkloads } from "../examples/zero/workloads.ts";
import { measureCoreStructure } from "../scripts/core_structure.ts";
import type { CoreModule } from "../src/core.ts";

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
      case "15-fixed-affine-seven":
      case "16-fixed-affine-eight":
      case "17-fixed-affine-sixteen":
      case "18-fixed-affine-thirty-two":
        assertEquals(structure.coreFunctions, 3, "fixed-fold functions");
        assertEquals(structure.coreBlocks, 9, "fixed-fold blocks");
        assertEquals(structure.coreOperations, 15, "fixed-fold operations");
        assertEquals(structure.directCallSites, 2, "fixed-fold calls");
        assertEquals(structure.maximumCallDepth, 2, "fixed-fold call depth");
        break;
      case "19-affine-pretransform":
      case "20-affine-reset":
      case "21-affine-posttransform":
      case "22-affine-sandwich": {
        const expectedOperations = new Map([
          ["19-affine-pretransform", 19],
          ["20-affine-reset", 16],
          ["21-affine-posttransform", 19],
          ["22-affine-sandwich", 23],
        ]).get(workload.name)!;
        assertEquals(structure.coreFunctions, 3, "affine-region functions");
        assertEquals(structure.coreBlocks, 9, "affine-region blocks");
        assertEquals(
          structure.coreOperations,
          expectedOperations,
          "affine-region operations",
        );
        assertEquals(structure.directCallSites, 2, "affine-region calls");
        assertEquals(structure.maximumCallDepth, 2, "affine-region call depth");
        break;
      }
      case "23-shared-leaf-fanout-five":
        assertEquals(
          structure.maximumCalleeReferences,
          5,
          "pathological leaf fanout",
        );
        assertEquals(structure.coreOperations, 24, "fanout operations");
        break;
      case "24-over-budget-call-chain": {
        const expandedOperations = countOperationsOutsideRun(compiled.core);
        assertEquals(expandedOperations, 91, "expanded scalar operations");
        assertEquals(structure.maximumCallDepth, 18, "over-budget call depth");
        break;
      }
      case "25-wide-frontier-thirty-two":
        assertEquals(
          structure.maximumBlockLiveValues,
          33,
          "pathological live frontier",
        );
        assertEquals(structure.coreOperations, 165, "wide-frontier operations");
        break;
      case "26-oversized-nested-fold": {
        const candidateOperations = countOperationsOutsideRun(compiled.core);
        assertEquals(candidateOperations, 27, "nested composition operations");
        assertEquals(structure.coreOperations, 32, "nested-fold operations");
        break;
      }
      case "27-call-tree-fifty-six":
      case "28-call-tree-sixty-one":
      case "29-call-tree-sixty-six":
      case "30-call-tree-seventy-one": {
        const expected = new Map([
          ["27-call-tree-fifty-six", { operations: 56, depth: 11 }],
          ["28-call-tree-sixty-one", { operations: 61, depth: 12 }],
          ["29-call-tree-sixty-six", { operations: 66, depth: 13 }],
          ["30-call-tree-seventy-one", { operations: 71, depth: 14 }],
        ]).get(workload.name)!;
        assertEquals(
          countOperationsOutsideRun(compiled.core),
          expected.operations,
          "threshold-tree operations",
        );
        assertEquals(
          structure.maximumCallDepth,
          expected.depth,
          "threshold-tree call depth",
        );
        assertEquals(
          structure.maximumCalleeReferences,
          1,
          "threshold-tree callee references",
        );
        assertEquals(
          structure.partialScalarOperations,
          0,
          "threshold-tree partial operations",
        );
        break;
      }
      case "31-toroidal-life":
        assertEquals(structure.coreFunctions, 4, "Life functions");
        assertEquals(structure.coreOperations, 354, "Life operations");
        assertEquals(structure.directCallSites, 35, "Life call sites");
        assertEquals(
          structure.maximumCalleeReferences,
          25,
          "Life cell-call multiplicity",
        );
        assertEquals(
          structure.partialScalarOperations,
          2,
          "Life extraction operations",
        );
        assertEquals(structure.maximumBlockLiveValues, 11, "Life liveness");
        assertEquals(structure.maximumCallDepth, 3, "Life call depth");
        break;
      case "32-toroidal-life-simd":
        assertEquals(structure.coreFunctions, 5, "SIMD Life functions");
        assertEquals(structure.coreBlocks, 8, "SIMD Life blocks");
        assertEquals(structure.coreOperations, 385, "SIMD Life operations");
        assertEquals(structure.directCallSites, 36, "SIMD Life call sites");
        assertEquals(
          structure.maximumCalleeReferences,
          25,
          "SIMD Life cell-call multiplicity",
        );
        assertEquals(
          structure.partialScalarOperations,
          0,
          "SIMD Life partial operations",
        );
        assertEquals(
          structure.maximumBlockLiveValues,
          11,
          "SIMD Life liveness",
        );
        assertEquals(structure.maximumCallDepth, 4, "SIMD Life call depth");
        break;
      case "33-xorshift32-simd":
        assertEquals(structure.coreFunctions, 2, "SIMD xorshift functions");
        assertEquals(structure.coreBlocks, 5, "SIMD xorshift blocks");
        assertEquals(structure.coreOperations, 34, "SIMD xorshift operations");
        assertEquals(structure.directCallSites, 1, "SIMD xorshift calls");
        assertEquals(
          structure.partialScalarOperations,
          0,
          "SIMD xorshift partial operations",
        );
        assertEquals(
          structure.maximumBlockLiveValues,
          5,
          "SIMD xorshift liveness",
        );
        assertEquals(structure.maximumCallDepth, 1, "SIMD xorshift call depth");
        break;
      case "34-newton-sqrt-simd":
        assertEquals(structure.coreFunctions, 2, "SIMD Newton functions");
        assertEquals(structure.coreBlocks, 5, "SIMD Newton blocks");
        assertEquals(structure.coreOperations, 44, "SIMD Newton operations");
        assertEquals(structure.directCallSites, 1, "SIMD Newton calls");
        assertEquals(
          structure.maximumBlockLiveValues,
          5,
          "SIMD Newton liveness",
        );
        assertEquals(structure.maximumCallDepth, 1, "SIMD Newton call depth");
        break;
      case "35-packed-threshold-simd":
        assertEquals(structure.coreFunctions, 2, "packed threshold functions");
        assertEquals(structure.coreBlocks, 5, "packed threshold blocks");
        assertEquals(
          structure.coreOperations,
          25,
          "packed threshold operations",
        );
        assertEquals(structure.directCallSites, 1, "packed threshold calls");
        assertEquals(
          structure.maximumBlockLiveValues,
          5,
          "packed threshold liveness",
        );
        assertEquals(
          structure.maximumCallDepth,
          1,
          "packed threshold call depth",
        );
        break;
      case "36-packed-recurrence-simd":
        assertEquals(structure.coreFunctions, 2, "packed recurrence functions");
        assertEquals(structure.coreBlocks, 5, "packed recurrence blocks");
        assertEquals(
          structure.coreOperations,
          28,
          "packed recurrence operations",
        );
        assertEquals(structure.directCallSites, 1, "packed recurrence calls");
        assertEquals(
          structure.maximumBlockLiveValues,
          5,
          "packed recurrence liveness",
        );
        assertEquals(
          structure.maximumCallDepth,
          1,
          "packed recurrence call depth",
        );
        break;
      case "37-byte-mixer-simd":
        assertEquals(structure.coreFunctions, 2, "byte mixer functions");
        assertEquals(structure.coreBlocks, 5, "byte mixer blocks");
        assertEquals(structure.coreOperations, 47, "byte mixer operations");
        assertEquals(structure.directCallSites, 1, "byte mixer calls");
        assertEquals(
          structure.maximumBlockLiveValues,
          18,
          "byte mixer liveness",
        );
        assertEquals(structure.maximumCallDepth, 1, "byte mixer call depth");
        break;
      case "38-widening-dot-simd":
        assertEquals(structure.coreFunctions, 2, "widening dot functions");
        assertEquals(structure.coreBlocks, 2, "widening dot blocks");
        assertEquals(
          structure.coreOperations,
          42,
          "widening dot operations",
        );
        assertEquals(structure.directCallSites, 1, "widening dot calls");
        assertEquals(
          structure.maximumBlockLiveValues,
          16,
          "widening dot liveness",
        );
        assertEquals(
          structure.maximumCallDepth,
          1,
          "widening dot call depth",
        );
        break;
      case "39-relaxed-simd":
        assertEquals(structure.coreFunctions, 1, "relaxed SIMD functions");
        assertEquals(structure.coreBlocks, 1, "relaxed SIMD blocks");
        assertEquals(
          structure.coreOperations,
          61,
          "relaxed SIMD operations",
        );
        assertEquals(structure.directCallSites, 0, "relaxed SIMD calls");
        assertEquals(
          structure.maximumBlockLiveValues,
          18,
          "relaxed SIMD liveness",
        );
        assertEquals(
          structure.maximumCallDepth,
          0,
          "relaxed SIMD call depth",
        );
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

function countOperationsOutsideRun(core: CoreModule): number {
  return core.functions
    .filter((function_) => function_.name !== "run")
    .reduce(
      (count, function_) =>
        count + function_.blocks.reduce(
          (functionCount, block) => functionCount + block.operations.length,
          0,
        ),
      0,
    );
}

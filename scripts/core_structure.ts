import type { CoreModule, CoreValueId } from "../src/core.ts";

export type CoreStructure = {
  readonly coreFunctions: number;
  readonly reachableCoreFunctions: number;
  readonly deadCoreFunctions: number;
  readonly coreBlocks: number;
  readonly coreOperations: number;
  readonly directCallSites: number;
  readonly maximumCalleeReferences: number;
  readonly partialScalarOperations: number;
  readonly maximumBlockLiveValues: number;
  readonly maximumCallDepth: number | null;
  readonly recursiveCallGraph: boolean;
};

export function measureCoreStructure(core: CoreModule): CoreStructure {
  const reachableFunctions = new Set<number>();
  const pendingFunctions = [core.entryFunction as number];
  while (pendingFunctions.length > 0) {
    const functionId = pendingFunctions.pop()!;
    if (reachableFunctions.has(functionId)) continue;
    reachableFunctions.add(functionId);
    const function_ = core.functions[functionId];
    if (function_ === undefined) {
      throw new Error(`Core reachability lost function ${functionId}`);
    }
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (
          operation.kind === "call.direct" ||
          operation.kind === "closure.make"
        ) {
          pendingFunctions.push(operation.functionId);
        }
      }
    }
  }

  let coreBlocks = 0;
  let coreOperations = 0;
  let directCallSites = 0;
  let partialScalarOperations = 0;
  let maximumBlockLiveValues = 0;
  const calleeReferences = new Map<number, number>();
  const directCallTargets = core.functions.map(() => [] as number[]);
  for (const function_ of core.functions) {
    coreBlocks += function_.blocks.length;
    for (const block of function_.blocks) {
      coreOperations += block.operations.length;
      const liveValues = new Set<CoreValueId>();
      switch (block.terminator.kind) {
        case "branch":
          block.terminator.arguments.forEach((value) => liveValues.add(value));
          break;
        case "conditional_branch":
          liveValues.add(block.terminator.condition);
          block.terminator.trueArguments.forEach((value) =>
            liveValues.add(value)
          );
          block.terminator.falseArguments.forEach((value) =>
            liveValues.add(value)
          );
          break;
        case "return":
          block.terminator.values.forEach((value) => liveValues.add(value));
          break;
        case "trap":
          break;
      }
      maximumBlockLiveValues = Math.max(
        maximumBlockLiveValues,
        liveValues.size,
      );
      for (let index = block.operations.length - 1; index >= 0; index -= 1) {
        const operation = block.operations[index]!;
        liveValues.delete(operation.result);
        operation.operands.forEach((operand) => liveValues.add(operand));
        maximumBlockLiveValues = Math.max(
          maximumBlockLiveValues,
          liveValues.size,
        );
        if (operation.kind === "call.direct") {
          directCallSites += 1;
          directCallTargets[function_.id].push(operation.functionId);
          calleeReferences.set(
            operation.functionId,
            (calleeReferences.get(operation.functionId) ?? 0) + 1,
          );
        }
        if (
          operation.kind === "scalar.binary" &&
          (operation.operator === "/" || operation.operator === "%")
        ) {
          partialScalarOperations += 1;
        }
      }
    }
  }

  const callStates = new Uint8Array(core.functions.length);
  const callDepths = new Uint32Array(core.functions.length);
  let recursiveCallGraph = false;
  const measureCallDepth = (functionId: number): number => {
    if (callStates[functionId] === 1) {
      recursiveCallGraph = true;
      return 0;
    }
    if (callStates[functionId] === 2) return callDepths[functionId];
    callStates[functionId] = 1;
    let depth = 0;
    for (const target of directCallTargets[functionId]) {
      if (core.functions[target] === undefined) {
        throw new Error(
          `Core call-depth analysis lost function ${target} called by ${functionId}`,
        );
      }
      depth = Math.max(depth, 1 + measureCallDepth(target));
    }
    callStates[functionId] = 2;
    callDepths[functionId] = depth;
    return depth;
  };
  let maximumCallDepth = 0;
  for (const function_ of core.functions) {
    maximumCallDepth = Math.max(
      maximumCallDepth,
      measureCallDepth(function_.id),
    );
  }

  return {
    coreFunctions: core.functions.length,
    reachableCoreFunctions: reachableFunctions.size,
    deadCoreFunctions: core.functions.length - reachableFunctions.size,
    coreBlocks,
    coreOperations,
    directCallSites,
    maximumCalleeReferences: Math.max(0, ...calleeReferences.values()),
    partialScalarOperations,
    maximumBlockLiveValues,
    maximumCallDepth: recursiveCallGraph ? null : maximumCallDepth,
    recursiveCallGraph,
  };
}

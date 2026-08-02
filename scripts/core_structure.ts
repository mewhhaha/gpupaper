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
  };
}

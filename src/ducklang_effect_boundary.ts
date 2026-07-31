import type { CoreFunctionId, DucklangCoreModule } from "./ducklang_core.ts";
import type { TypedDucklangModule } from "./ducklang_types.ts";

type ReachableHostOperation = {
  readonly effectName: string;
  readonly operationName: string;
  readonly functionName: string;
  readonly span: {
    readonly file: string;
    readonly start: number;
    readonly end: number;
  };
};

export function closeDucklangEffectBoundary(
  module: TypedDucklangModule,
  core: DucklangCoreModule,
): TypedDucklangModule {
  const reachableOperations = reachableHostOperations(core);
  for (const required of module.requiredEffects) {
    const key = effectKey(required);
    if (reachableOperations.has(key)) continue;
    throw new TypeError(
      `${module.file}: main effect row requires ${key}, but no reachable Core host call implements it`,
    );
  }
  const requiredOperations = new Set(module.requiredEffects.map(effectKey));
  for (const [key, reachable] of reachableOperations) {
    if (requiredOperations.has(key)) continue;
    throw new TypeError(
      `${module.file}:${reachable.span.start}: reachable Core host call ${key} is absent from the inferred main effect row (Core function ${reachable.functionName})`,
    );
  }
  return module;
}

function reachableHostOperations(
  core: DucklangCoreModule,
): ReadonlyMap<string, ReachableHostOperation> {
  const operations = new Map<string, ReachableHostOperation>();
  const visited = new Set<CoreFunctionId>();
  const pending = [core.entryFunction];
  const indirectSignatures = new Set<number>();
  const closureFunctions = new Map<number, Set<CoreFunctionId>>();

  while (pending.length > 0) {
    const functionId = pending.pop();
    if (functionId === undefined || visited.has(functionId)) continue;
    const function_ = core.functions[functionId];
    if (function_ === undefined) {
      throw new RangeError(
        `${core.file}: effect boundary reached missing Core function ${functionId}`,
      );
    }
    visited.add(functionId);
    for (const block of function_.blocks) {
      for (const operation of block.operations) {
        if (operation.kind === "host.call") {
          operations.set(effectKey(operation), {
            effectName: operation.effectName,
            operationName: operation.operationName,
            functionName: function_.name,
            span: operation.span,
          });
          continue;
        }
        if (operation.kind === "call.direct") {
          pending.push(operation.functionId);
          continue;
        }
        if (operation.kind === "closure.make") {
          const signature = core.functions[operation.functionId]?.signature;
          if (signature === undefined) {
            throw new RangeError(
              `${core.file}: effect boundary reached missing closure function ${operation.functionId}`,
            );
          }
          const candidates = closureFunctions.get(signature) ??
            new Set<CoreFunctionId>();
          candidates.add(operation.functionId);
          closureFunctions.set(signature, candidates);
          if (indirectSignatures.has(signature)) {
            pending.push(operation.functionId);
          }
          continue;
        }
        if (operation.kind === "call.indirect") {
          indirectSignatures.add(operation.signature);
          pending.push(
            ...(closureFunctions.get(operation.signature) ?? []),
          );
        }
      }
    }
  }

  return new Map(
    [...operations].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function effectKey(
  effect: {
    readonly effectName: string;
    readonly operationName: string;
  },
): string {
  return `${effect.effectName}.${effect.operationName}`;
}

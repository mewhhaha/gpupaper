export type EffectCapability = {
  readonly id: number;
  readonly name: string;
};

export type EffectOperation = {
  readonly capability: EffectCapability;
  readonly name: string;
};

export type EffectRow = {
  readonly operations: readonly EffectOperation[];
};

export type ControlFlowLinearity = "linear" | "affine";

export type CapturedEffectResource = {
  readonly name: string;
  readonly discardable: boolean;
};

export type EffectComputation<Value> =
  | {
    readonly kind: "return";
    readonly value: Value;
    readonly effects: EffectRow;
  }
  | {
    readonly kind: "perform";
    readonly operation: EffectOperation;
    readonly arguments: readonly unknown[];
    readonly continuation: (value: unknown) => EffectComputation<Value>;
    readonly capturedResources: readonly CapturedEffectResource[];
    readonly effects: EffectRow;
  };

export type EffectHandler<Result, Answer> = {
  readonly capability: EffectCapability;
  readonly effects: EffectRow;
  readonly onReturn: (result: Result) => EffectComputation<Answer>;
  readonly operations: ReadonlyMap<
    string,
    {
      readonly linearity: ControlFlowLinearity;
      readonly evaluate: (
        operands: readonly unknown[],
        resume: (value: unknown) => EffectComputation<Answer>,
      ) => EffectComputation<Answer>;
    }
  >;
};

export function effectCapability(id: number, name: string): EffectCapability {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new TypeError(`effect capability ${name} has invalid ID ${id}`);
  }
  if (name.length === 0) throw new TypeError("effect capability has no name");
  return { id, name };
}

export function effectOperation(
  capability: EffectCapability,
  name: string,
): EffectOperation {
  if (name.length === 0) {
    throw new TypeError(
      `effect capability ${capability.name} has an empty operation`,
    );
  }
  return { capability, name };
}

export function effectRow(
  operations: readonly EffectOperation[],
): EffectRow {
  const canonical = new Map<string, EffectOperation>();
  for (const operation of operations) {
    canonical.set(effectOperationKey(operation), operation);
  }
  return {
    operations: [...canonical.values()].toSorted(compareEffectOperations),
  };
}

export function emptyEffectRow(): EffectRow {
  return effectRow([]);
}

export function unionEffectRows(
  ...rows: readonly EffectRow[]
): EffectRow {
  return effectRow(rows.flatMap((row) => row.operations));
}

export function removeEffectCapability(
  row: EffectRow,
  capability: EffectCapability,
): EffectRow {
  return effectRow(
    row.operations.filter((operation) =>
      operation.capability.id !== capability.id
    ),
  );
}

export function returnEffect<Value>(
  value: Value,
): EffectComputation<Value> {
  return { kind: "return", value, effects: emptyEffectRow() };
}

export function performEffect<Result>(
  operation: EffectOperation,
  arguments_: readonly unknown[] = [],
  capturedResources: readonly CapturedEffectResource[] = [],
): EffectComputation<Result> {
  return {
    kind: "perform",
    operation,
    arguments: arguments_,
    continuation: (value) => returnEffect(value as Result),
    capturedResources,
    effects: effectRow([operation]),
  };
}

export function bindEffect<Input, Output>(
  computation: EffectComputation<Input>,
  continuation: (value: Input) => EffectComputation<Output>,
  continuationEffects: EffectRow,
): EffectComputation<Output> {
  if (computation.kind === "return") return continuation(computation.value);
  return {
    ...computation,
    continuation: (value) =>
      bindEffect(
        computation.continuation(value),
        continuation,
        continuationEffects,
      ),
    effects: unionEffectRows(computation.effects, continuationEffects),
  };
}

export function handleEffect<Result, Answer>(
  computation: EffectComputation<Result>,
  handler: EffectHandler<Result, Answer>,
): EffectComputation<Answer> {
  if (computation.kind === "return") {
    return handler.onReturn(computation.value);
  }
  if (computation.operation.capability.id !== handler.capability.id) {
    return {
      ...computation,
      continuation: (value) =>
        handleEffect(computation.continuation(value), handler),
      effects: unionEffectRows(
        removeEffectCapability(computation.effects, handler.capability),
        handler.effects,
      ),
    };
  }

  const clause = handler.operations.get(computation.operation.name);
  if (clause === undefined) {
    throw new TypeError(
      `effect handler ${handler.capability.name} has no operation ${computation.operation.name}`,
    );
  }
  let resumeCount = 0;
  const resume = (value: unknown): EffectComputation<Answer> => {
    resumeCount += 1;
    if (resumeCount > 1) {
      throw new TypeError(
        `effect handler ${handler.capability.name}.${computation.operation.name} resumed more than once`,
      );
    }
    return handleEffect(computation.continuation(value), handler);
  };
  const answer = clause.evaluate(computation.arguments, resume);
  if (clause.linearity === "linear" && resumeCount !== 1) {
    throw new TypeError(
      `effect handler ${handler.capability.name}.${computation.operation.name} must resume exactly once`,
    );
  }
  if (
    resumeCount === 0 &&
    computation.capturedResources.some((resource) => !resource.discardable)
  ) {
    const resources = computation.capturedResources
      .filter((resource) => !resource.discardable)
      .map((resource) => resource.name)
      .join(", ");
    throw new TypeError(
      `effect handler ${handler.capability.name}.${computation.operation.name} discards continuation owning ${resources}`,
    );
  }
  return {
    ...answer,
    effects: unionEffectRows(
      removeEffectCapability(computation.effects, handler.capability),
      handler.effects,
      answer.effects,
    ),
  };
}

export function runClosedEffect<Value>(
  computation: EffectComputation<Value>,
): Value {
  if (computation.kind === "return") return computation.value;
  throw new TypeError(
    `closed effect computation performed unhandled ${computation.operation.capability.name}.${computation.operation.name}`,
  );
}

function effectOperationKey(operation: EffectOperation): string {
  return `${operation.capability.id}\u0000${operation.name}`;
}

function compareEffectOperations(
  left: EffectOperation,
  right: EffectOperation,
): number {
  return left.capability.id - right.capability.id ||
    left.name.localeCompare(right.name);
}

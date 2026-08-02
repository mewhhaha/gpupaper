export type BlotRuntimeSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

export type BlotRuntimeOwnership = "plain" | "owned" | "borrowed";

export type BlotRuntimeType =
  | {
    readonly kind:
      | "unit"
      | "integer-32"
      | "signed-integer-64"
      | "float-32"
      | "float-64"
      | "boolean"
      | "text";
  }
  | {
    readonly kind: "vector" | "mask";
    readonly element: "float-32";
    readonly lanes: 4;
  }
  | {
    readonly kind: "store";
    readonly elementType: number;
  }
  | {
    readonly kind: "product";
    readonly name: string;
    readonly fields: readonly {
      readonly name: string;
      readonly type: number;
    }[];
  }
  | {
    readonly kind: "sum";
    readonly name: string;
    readonly cases: readonly {
      readonly name: string;
      readonly payloadType: number;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly representationType: number;
  }
  | {
    readonly kind: "function";
    readonly signature: number;
  };

export type BlotRuntimeSignature = {
  readonly parameters: readonly number[];
  readonly result: number;
  readonly effects: readonly string[];
};

type BlotRuntimeOperationBase = {
  readonly result: number;
  readonly type: number;
  readonly operands: readonly number[];
  readonly ownership: BlotRuntimeOwnership;
  readonly span: BlotRuntimeSpan;
};

export type BlotRuntimeOperation =
  & BlotRuntimeOperationBase
  & (
    | {
      readonly kind: "constant";
      readonly value: bigint | number | boolean | string | null;
    }
    | {
      readonly kind: "scalar";
      readonly operator:
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "remainder"
        | "equal"
        | "not-equal"
        | "less-than"
        | "less-than-or-equal"
        | "greater-than"
        | "greater-than-or-equal";
    }
    | {
      readonly kind: "convert";
      readonly conversion: string;
    }
    | {
      readonly kind:
        | "text.append"
        | "text.length"
        | "text.from-i64"
        | "text.compare"
        | "text.contains";
    }
    | {
      readonly kind: "vector";
      readonly operator:
        | "make"
        | "splat"
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "extract"
        | "replace"
        | "equal"
        | "not-equal"
        | "less-than"
        | "less-than-or-equal"
        | "greater-than"
        | "greater-than-or-equal"
        | "select";
      readonly lane?: 0 | 1 | 2 | 3;
    }
    | {
      readonly kind: "product.make";
    }
    | {
      readonly kind: "product.project";
      readonly field: number;
    }
    | {
      readonly kind: "sum.make";
      readonly case: number;
    }
    | {
      readonly kind: "sum.tag";
    }
    | {
      readonly kind: "sum.payload";
      readonly case: number;
    }
    | {
      readonly kind: "store.empty";
    }
    | {
      readonly kind: "store.new";
    }
    | {
      readonly kind: "store.length";
    }
    | {
      readonly kind: "store.read";
    }
    | {
      readonly kind: "store.write" | "store.grow";
      readonly update: "persistent" | "owned-reuse";
    }
    | {
      readonly kind: "call.direct";
      readonly function: number;
    }
    | {
      readonly kind: "closure.make";
      readonly function: number;
    }
    | {
      readonly kind: "call.indirect";
      readonly signature: number;
    }
    | {
      readonly kind: "host.call";
      readonly capability: string;
      readonly operation: string;
    }
    | {
      readonly kind:
        | "seal.wrap"
        | "seal.unwrap"
        | "resource.move"
        | "resource.borrow"
        | "resource.freeze"
        | "resource.drop";
    }
  );

export type BlotRuntimeTerminator =
  | {
    readonly kind: "branch";
    readonly target: number;
    readonly arguments: readonly number[];
    readonly span: BlotRuntimeSpan;
  }
  | {
    readonly kind: "conditional";
    readonly condition: number;
    readonly consequent: number;
    readonly consequentArguments: readonly number[];
    readonly alternate: number;
    readonly alternateArguments: readonly number[];
    readonly likely?: "consequent" | "alternate";
    readonly span: BlotRuntimeSpan;
  }
  | {
    readonly kind: "return";
    readonly value: number;
    readonly span: BlotRuntimeSpan;
  }
  | {
    readonly kind: "trap";
    readonly message: string;
    readonly span: BlotRuntimeSpan;
  };

export type BlotRuntimeBlock = {
  readonly id: number;
  readonly parameters: readonly {
    readonly value: number;
    readonly type: number;
    readonly ownership: BlotRuntimeOwnership;
    readonly span: BlotRuntimeSpan;
  }[];
  readonly operations: readonly BlotRuntimeOperation[];
  readonly terminator: BlotRuntimeTerminator;
};

export type BlotRuntimeFunction = {
  readonly id: number;
  readonly name: string;
  readonly signature: number;
  readonly entryBlock: number;
  readonly blocks: readonly BlotRuntimeBlock[];
  readonly span: BlotRuntimeSpan;
};

export type BlotRuntimeCapability = {
  readonly name: string;
  readonly operations: readonly {
    readonly name: string;
    readonly signature: number;
  }[];
};

export type BlotRuntimeExport =
  | {
    readonly sourceName: string;
    readonly phase: "runtime";
    readonly wasmName: string;
    readonly function: number;
    readonly signature: number;
    readonly ownership: "owned";
  }
  | {
    readonly sourceName: string;
    readonly phase: "comptime";
  };

export type BlotRuntimeModule = {
  readonly format: "blot-runtime-hir";
  readonly schemaVersion: 1;
  readonly source: string;
  readonly types: readonly BlotRuntimeType[];
  readonly signatures: readonly BlotRuntimeSignature[];
  readonly functions: readonly BlotRuntimeFunction[];
  readonly capabilities: readonly BlotRuntimeCapability[];
  readonly exports: readonly BlotRuntimeExport[];
};

declare const validatedBlotRuntimeModule: unique symbol;

export type ValidatedBlotRuntimeModule = BlotRuntimeModule & {
  readonly [validatedBlotRuntimeModule]: true;
};

type BlotRuntimeValueDefinition = {
  readonly type: number;
  readonly block: number;
  readonly operation: number;
};

export function validateBlotRuntimeModule(
  module: BlotRuntimeModule,
): ValidatedBlotRuntimeModule {
  if (module.format !== "blot-runtime-hir" || module.schemaVersion !== 1) {
    throw new TypeError(
      `Blot Runtime HIR requires format blot-runtime-hir schema 1; received ${module.format} schema ${module.schemaVersion}`,
    );
  }
  if (module.types.length === 0) {
    throw new TypeError(`${module.source}: Blot Runtime HIR has no types`);
  }
  module.types.forEach((type, typeId) => validateType(module, type, typeId));
  module.signatures.forEach((signature, signatureId) => {
    signature.parameters.forEach((type, parameter) =>
      requireType(
        module,
        type,
        `signature ${signatureId} parameter ${parameter}`,
      )
    );
    requireType(module, signature.result, `signature ${signatureId} result`);
    requireUniqueNames(
      signature.effects,
      `${module.source}: signature ${signatureId} effects`,
    );
  });
  const capabilityOperations = new Map<string, number>();
  requireUniqueNames(
    module.capabilities.map((capability) => capability.name),
    `${module.source}: capabilities`,
  );
  for (const capability of module.capabilities) {
    requireUniqueNames(
      capability.operations.map((operation) => operation.name),
      `${module.source}: capability ${capability.name} operations`,
    );
    for (const operation of capability.operations) {
      requireSignature(
        module,
        operation.signature,
        `capability ${capability.name}.${operation.name}`,
      );
      capabilityOperations.set(
        `${capability.name}\u0000${operation.name}`,
        operation.signature,
      );
    }
  }
  module.functions.forEach((function_, functionId) => {
    if (function_.id !== functionId) {
      throw new TypeError(
        `${module.source}: function table index ${functionId} contains ID ${function_.id}`,
      );
    }
    validateFunction(module, function_, capabilityOperations);
  });
  validateEffectClosure(module);
  requireUniqueNames(
    module.exports.map((exported) => exported.sourceName),
    `${module.source}: source exports`,
  );
  requireUniqueNames(
    module.exports.flatMap((exported) =>
      exported.phase === "runtime" ? [exported.wasmName] : []
    ),
    `${module.source}: Wasm exports`,
  );
  for (const exported of module.exports) {
    if (exported.phase === "comptime") continue;
    const function_ = requireFunction(
      module,
      exported.function,
      `export ${exported.sourceName}`,
    );
    requireSignature(
      module,
      exported.signature,
      `export ${exported.sourceName}`,
    );
    if (function_.signature !== exported.signature) {
      throw new TypeError(
        `${module.source}: export ${exported.sourceName} declares signature ${exported.signature} but function ${function_.name} has signature ${function_.signature}`,
      );
    }
  }
  return module as ValidatedBlotRuntimeModule;
}

function validateType(
  module: BlotRuntimeModule,
  type: BlotRuntimeType,
  typeId: number,
): void {
  if (type.kind === "store") {
    requireType(module, type.elementType, `store type ${typeId} element`);
    return;
  }
  if (type.kind === "product") {
    requireUniqueNames(
      type.fields.map((field) => field.name),
      `${module.source}: product type ${type.name} fields`,
    );
    type.fields.forEach((field, fieldIndex) =>
      requireType(
        module,
        field.type,
        `product type ${type.name} field ${fieldIndex}`,
      )
    );
    return;
  }
  if (type.kind === "sum") {
    if (type.cases.length === 0) {
      throw new TypeError(
        `${module.source}: sum type ${type.name} has no cases`,
      );
    }
    requireUniqueNames(
      type.cases.map((case_) => case_.name),
      `${module.source}: sum type ${type.name} cases`,
    );
    type.cases.forEach((case_, caseIndex) =>
      requireType(
        module,
        case_.payloadType,
        `sum type ${type.name} case ${caseIndex}`,
      )
    );
    return;
  }
  if (type.kind === "sealed") {
    requireType(
      module,
      type.representationType,
      `sealed type ${type.name} representation`,
    );
    return;
  }
  if (type.kind === "function") {
    requireSignature(module, type.signature, `function type ${typeId}`);
  }
}

function validateFunction(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  capabilityOperations: ReadonlyMap<string, number>,
): void {
  const signature = requireSignature(
    module,
    function_.signature,
    `function ${function_.name}`,
  );
  if (function_.blocks.length === 0) {
    throw new TypeError(
      `${module.source}: function ${function_.name} has no blocks`,
    );
  }
  if (
    function_.entryBlock < 0 || function_.entryBlock >= function_.blocks.length
  ) {
    throw new TypeError(
      `${module.source}: function ${function_.name} entry block ${function_.entryBlock} is outside ${function_.blocks.length} blocks`,
    );
  }
  const entry = function_.blocks[function_.entryBlock];
  if (
    entry.parameters.length !== signature.parameters.length ||
    entry.parameters.some((parameter, index) =>
      parameter.type !== signature.parameters[index]
    )
  ) {
    throw new TypeError(
      `${module.source}: function ${function_.name} entry parameters disagree with signature ${function_.signature}`,
    );
  }
  const values = new Map<number, BlotRuntimeValueDefinition>();
  for (const [blockIndex, block] of function_.blocks.entries()) {
    if (block.id !== blockIndex) {
      throw new TypeError(
        `${module.source}: function ${function_.name} block table index ${blockIndex} contains ID ${block.id}`,
      );
    }
    for (const parameter of block.parameters) {
      requireType(
        module,
        parameter.type,
        `block ${function_.name}:${block.id} parameter`,
      );
      defineValue(
        module,
        function_,
        values,
        parameter.value,
        parameter.type,
        block.id,
        -1,
      );
    }
    for (const [operationIndex, operation] of block.operations.entries()) {
      requireType(
        module,
        operation.type,
        `operation ${function_.name}:${operation.result}`,
      );
      defineValue(
        module,
        function_,
        values,
        operation.result,
        operation.type,
        block.id,
        operationIndex,
      );
    }
  }
  const predecessors = function_.blocks.map(() => new Set<number>());
  for (const block of function_.blocks) {
    recordPredecessors(module, function_, block, predecessors);
  }
  const dominators = calculateDominators(function_, predecessors);
  for (const block of function_.blocks) {
    for (const [operationIndex, operation] of block.operations.entries()) {
      for (const operand of operation.operands) {
        requireDominatingValue(
          module,
          function_,
          values,
          dominators,
          operand,
          block.id,
          operationIndex,
        );
      }
      validateOperation(module, function_, operation, capabilityOperations);
    }
    for (const operand of terminatorValues(block.terminator)) {
      requireDominatingValue(
        module,
        function_,
        values,
        dominators,
        operand,
        block.id,
        block.operations.length,
      );
    }
    validateTerminator(module, function_, block, values, signature.result);
  }
}

function recordPredecessors(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  block: BlotRuntimeBlock,
  predecessors: readonly Set<number>[],
): void {
  const terminator = block.terminator;
  const targets = terminator.kind === "branch"
    ? [terminator.target]
    : terminator.kind === "conditional"
    ? [terminator.consequent, terminator.alternate]
    : [];
  for (const target of targets) {
    if (function_.blocks[target] === undefined) {
      throw new TypeError(
        `${module.source}: function ${function_.name} block ${block.id} targets absent block ${target}`,
      );
    }
    predecessors[target].add(block.id);
  }
}

function calculateDominators(
  function_: BlotRuntimeFunction,
  predecessors: readonly ReadonlySet<number>[],
): readonly ReadonlySet<number>[] {
  const allBlocks = new Set(function_.blocks.map((block) => block.id));
  const dominators = function_.blocks.map((block) =>
    block.id === function_.entryBlock ? new Set([block.id]) : new Set(allBlocks)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of function_.blocks) {
      if (block.id === function_.entryBlock) continue;
      const incoming = [...predecessors[block.id]];
      const intersection = incoming.length === 0
        ? new Set<number>()
        : new Set(dominators[incoming[0]]);
      for (const predecessor of incoming.slice(1)) {
        for (const candidate of intersection) {
          if (!dominators[predecessor].has(candidate)) {
            intersection.delete(candidate);
          }
        }
      }
      intersection.add(block.id);
      if (!setsEqual(intersection, dominators[block.id])) {
        dominators[block.id] = intersection;
        changed = true;
      }
    }
  }
  return dominators;
}

function requireDominatingValue(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
  dominators: readonly ReadonlySet<number>[],
  value: number,
  useBlock: number,
  useOperation: number,
): void {
  const definition = values.get(value);
  if (definition === undefined) {
    throw new TypeError(
      `${module.source}: function ${function_.name} uses undefined value ${value}`,
    );
  }
  if (
    definition.block === useBlock && definition.operation < useOperation
  ) {
    return;
  }
  if (
    definition.block !== useBlock && dominators[useBlock].has(definition.block)
  ) {
    return;
  }
  throw new TypeError(
    `${module.source}: value ${value} does not dominate its use in ${function_.name}:${useBlock}`,
  );
}

function terminatorValues(
  terminator: BlotRuntimeTerminator,
): readonly number[] {
  if (terminator.kind === "return") return [terminator.value];
  if (terminator.kind === "branch") return terminator.arguments;
  if (terminator.kind === "trap") return [];
  return [
    terminator.condition,
    ...terminator.consequentArguments,
    ...terminator.alternateArguments,
  ];
}

function setsEqual<Value>(
  left: ReadonlySet<Value>,
  right: ReadonlySet<Value>,
): boolean {
  return left.size === right.size &&
    [...left].every((value) => right.has(value));
}

function validateOperation(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  operation: BlotRuntimeOperation,
  capabilityOperations: ReadonlyMap<string, number>,
): void {
  if (operation.kind === "call.direct" || operation.kind === "closure.make") {
    requireFunction(
      module,
      operation.function,
      `${operation.kind} ${function_.name}:${operation.result}`,
    );
  }
  if (operation.kind === "call.indirect") {
    requireSignature(
      module,
      operation.signature,
      `indirect call ${function_.name}:${operation.result}`,
    );
  }
  if (operation.kind === "host.call") {
    const signature = capabilityOperations.get(
      `${operation.capability}\u0000${operation.operation}`,
    );
    if (signature === undefined) {
      throw new TypeError(
        `${module.source}: host call ${operation.capability}.${operation.operation} is not declared`,
      );
    }
    const requiredEffect = operation.capability;
    const functionEffects = module.signatures[function_.signature].effects;
    if (!functionEffects.includes(requiredEffect)) {
      throw new TypeError(
        `${module.source}: function ${function_.name} calls ${operation.capability}.${operation.operation} outside capability ${requiredEffect} in its effect row`,
      );
    }
  }
  if (
    (operation.kind === "store.write" || operation.kind === "store.grow") &&
    operation.update === "owned-reuse" && operation.ownership !== "owned"
  ) {
    throw new TypeError(
      `${module.source}: ${operation.kind} ${function_.name}:${operation.result} claims owned reuse with ${operation.ownership} ownership`,
    );
  }
}

function validateEffectClosure(
  module: BlotRuntimeModule,
): void {
  const declaredCapabilities = new Set(
    module.capabilities.map((capability) => capability.name),
  );
  module.signatures.forEach((signature, signatureId) => {
    for (const effect of signature.effects) {
      if (!declaredCapabilities.has(effect)) {
        throw new TypeError(
          `${module.source}: signature ${signatureId} names undeclared effect ${effect}`,
        );
      }
    }
  });
  const observed = module.functions.map(() => new Set<string>());
  const directCalls = module.functions.map(() => new Set<number>());
  for (const function_ of module.functions) {
    const reachable = reachableBlocks(function_);
    for (const block of function_.blocks) {
      if (!reachable.has(block.id)) continue;
      for (const operation of block.operations) {
        if (operation.kind === "host.call") {
          observed[function_.id].add(
            operation.capability,
          );
        } else if (operation.kind === "call.direct") {
          directCalls[function_.id].add(operation.function);
        } else if (operation.kind === "call.indirect") {
          module.signatures[operation.signature].effects.forEach((effect) =>
            observed[function_.id].add(effect)
          );
        }
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const function_ of module.functions) {
      for (const callee of directCalls[function_.id]) {
        for (const effect of observed[callee]) {
          if (observed[function_.id].has(effect)) continue;
          observed[function_.id].add(effect);
          changed = true;
        }
      }
    }
  }
  for (const function_ of module.functions) {
    const declared = new Set(module.signatures[function_.signature].effects);
    if (setsEqual(declared, observed[function_.id])) continue;
    throw new TypeError(
      `${module.source}: function ${function_.name} effect row [${
        [...declared].sort().join(", ")
      }] differs from reachable effects [${
        [...observed[function_.id]].sort().join(", ")
      }]`,
    );
  }
}

function reachableBlocks(function_: BlotRuntimeFunction): ReadonlySet<number> {
  const reachable = new Set<number>();
  const pending = [function_.entryBlock];
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (reachable.has(block)) continue;
    reachable.add(block);
    const terminator = function_.blocks[block].terminator;
    if (terminator.kind === "branch") pending.push(terminator.target);
    if (terminator.kind === "conditional") {
      pending.push(terminator.consequent, terminator.alternate);
    }
  }
  return reachable;
}

function validateTerminator(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  block: BlotRuntimeBlock,
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
  resultType: number,
): void {
  const terminator = block.terminator;
  if (terminator.kind === "return") {
    const definition = values.get(terminator.value);
    if (definition === undefined) {
      throw new TypeError(
        `${module.source}: return ${function_.name}:${block.id} uses undefined value ${terminator.value}`,
      );
    }
    if (definition.type !== resultType) {
      throw new TypeError(
        `${module.source}: return ${function_.name}:${block.id} has type ${definition.type}; signature requires ${resultType}`,
      );
    }
    return;
  }
  if (terminator.kind === "trap") return;
  if (terminator.kind === "conditional") {
    const conditionType = values.get(terminator.condition)?.type;
    if (module.types[conditionType ?? -1]?.kind !== "boolean") {
      throw new TypeError(
        `${module.source}: conditional ${function_.name}:${block.id} requires boolean value; received ${terminator.condition} of type ${conditionType}`,
      );
    }
    validateEdge(
      module,
      function_,
      terminator.consequent,
      terminator.consequentArguments,
      values,
      `${block.id} consequent`,
    );
    validateEdge(
      module,
      function_,
      terminator.alternate,
      terminator.alternateArguments,
      values,
      `${block.id} alternate`,
    );
    return;
  }
  validateEdge(
    module,
    function_,
    terminator.target,
    terminator.arguments,
    values,
    `${block.id} branch`,
  );
}

function validateEdge(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  target: number,
  arguments_: readonly number[],
  values: ReadonlyMap<number, BlotRuntimeValueDefinition>,
  location: string,
): void {
  const targetBlock = function_.blocks[target];
  if (targetBlock === undefined) {
    throw new TypeError(
      `${module.source}: ${function_.name}:${location} targets absent block ${target}`,
    );
  }
  if (arguments_.length !== targetBlock.parameters.length) {
    throw new TypeError(
      `${module.source}: ${function_.name}:${location} passes ${arguments_.length} values to ${targetBlock.parameters.length} block parameters`,
    );
  }
  arguments_.forEach((argument, index) => {
    const type = values.get(argument)?.type;
    const expected = targetBlock.parameters[index].type;
    if (type !== expected) {
      throw new TypeError(
        `${module.source}: ${function_.name}:${location} argument ${index} has type ${type}; target requires ${expected}`,
      );
    }
  });
}

function defineValue(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
  values: Map<number, BlotRuntimeValueDefinition>,
  value: number,
  type: number,
  block: number,
  operation: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `${module.source}: function ${function_.name} defines invalid value ID ${value}`,
    );
  }
  if (values.has(value)) {
    throw new TypeError(
      `${module.source}: function ${function_.name} defines value ${value} more than once`,
    );
  }
  values.set(value, { type, block, operation });
}

function requireType(
  module: BlotRuntimeModule,
  type: number,
  location: string,
): BlotRuntimeType {
  if (!Number.isSafeInteger(type) || type < 0 || type >= module.types.length) {
    throw new TypeError(
      `${module.source}: ${location} uses type ${type}; ${module.types.length} types are defined`,
    );
  }
  return module.types[type];
}

function requireSignature(
  module: BlotRuntimeModule,
  signature: number,
  location: string,
): BlotRuntimeSignature {
  if (
    !Number.isSafeInteger(signature) || signature < 0 ||
    signature >= module.signatures.length
  ) {
    throw new TypeError(
      `${module.source}: ${location} uses signature ${signature}; ${module.signatures.length} signatures are defined`,
    );
  }
  return module.signatures[signature];
}

function requireFunction(
  module: BlotRuntimeModule,
  functionId: number,
  location: string,
): BlotRuntimeFunction {
  if (
    !Number.isSafeInteger(functionId) || functionId < 0 ||
    functionId >= module.functions.length
  ) {
    throw new TypeError(
      `${module.source}: ${location} uses function ${functionId}; ${module.functions.length} functions are defined`,
    );
  }
  return module.functions[functionId];
}

function requireUniqueNames(names: readonly string[], location: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (name.length === 0) {
      throw new TypeError(`${location} contains an empty name`);
    }
    if (seen.has(name)) {
      throw new TypeError(`${location} repeats ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
}

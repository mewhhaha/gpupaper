import { PrimitiveId } from "./ducklang_primitives.ts";
import { visitDucklangExpressionChildren } from "./ducklang_closures.ts";
import type { DucklangSymbol } from "./ducklang_resolution.ts";
import type {
  DucklangBinaryOperator,
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";
import { formatDucklangType } from "./ducklang_types.ts";
import type { SourceSpan } from "./syntax.ts";
import type { Type } from "./types.ts";

declare const coreTypeIdBrand: unique symbol;
declare const coreSignatureIdBrand: unique symbol;
declare const coreFunctionIdBrand: unique symbol;
declare const coreBlockIdBrand: unique symbol;
declare const coreValueIdBrand: unique symbol;

export type CoreTypeId = number & { readonly [coreTypeIdBrand]: true };
export type CoreSignatureId = number & {
  readonly [coreSignatureIdBrand]: true;
};
export type CoreFunctionId = number & { readonly [coreFunctionIdBrand]: true };
export type CoreBlockId = number & { readonly [coreBlockIdBrand]: true };
export type CoreValueId = number & { readonly [coreValueIdBrand]: true };

export type DucklangCoreType =
  | {
    readonly kind: "scalar";
    readonly scalar: "i32" | "i64" | "f32" | "f64" | "f32x4" | "unit";
  }
  | {
    readonly kind: "buffer";
    readonly buffer: "text" | "bytes";
  }
  | {
    readonly kind: "product";
    readonly fields: readonly CoreTypeId[];
  }
  | {
    readonly kind: "sum";
    readonly cases: readonly CoreTypeId[];
  }
  | {
    readonly kind: "function";
    readonly signature: CoreSignatureId;
  };

export type DucklangCoreSignature = {
  readonly parameters: readonly CoreTypeId[];
  readonly result: CoreTypeId;
};

type CoreOperationBase = {
  readonly result: CoreValueId;
  readonly type: CoreTypeId;
  readonly operands: readonly CoreValueId[];
  readonly span: SourceSpan;
};

export type DucklangCoreOperation =
  | (CoreOperationBase & {
    readonly kind: "constant";
    readonly value: number | bigint | boolean | string | undefined;
  })
  | (CoreOperationBase & {
    readonly kind: "scalar.binary";
    readonly operator: DucklangBinaryOperator;
  })
  | (CoreOperationBase & {
    readonly kind: "primitive";
    readonly primitiveId: PrimitiveId;
  })
  | (CoreOperationBase & {
    readonly kind: "product.make";
  })
  | (CoreOperationBase & {
    readonly kind: "product.project";
    readonly index: number;
  })
  | (CoreOperationBase & {
    readonly kind: "product.update";
    readonly indices: readonly number[];
  })
  | (CoreOperationBase & {
    readonly kind: "product.index";
  })
  | (CoreOperationBase & {
    readonly kind: "product.index_update";
  })
  | (CoreOperationBase & {
    readonly kind: "product.select";
  })
  | (CoreOperationBase & {
    readonly kind: "sum.make";
    readonly caseIndex: number;
  })
  | (CoreOperationBase & {
    readonly kind: "sum.tag";
  })
  | (CoreOperationBase & {
    readonly kind: "sum.payload";
    readonly caseIndex: number;
  })
  | (CoreOperationBase & {
    readonly kind: "call.direct";
    readonly functionId: CoreFunctionId;
  })
  | (CoreOperationBase & {
    readonly kind: "closure.make";
    readonly functionId: CoreFunctionId;
  })
  | (CoreOperationBase & {
    readonly kind: "call.indirect";
    readonly signature: CoreSignatureId;
  })
  | (CoreOperationBase & {
    readonly kind: "host.call";
    readonly effectName: string;
    readonly operationName: string;
  })
  | (CoreOperationBase & {
    readonly kind:
      | "resource.borrow"
      | "resource.freeze"
      | "region.enter"
      | "region.exit";
  });

type DucklangCoreOperationWithoutResult = DucklangCoreOperation extends
  infer Operation
  ? Operation extends DucklangCoreOperation ? Omit<Operation, "result">
  : never
  : never;

export type DucklangCoreTerminator =
  | {
    readonly kind: "branch";
    readonly target: CoreBlockId;
    readonly arguments: readonly CoreValueId[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "conditional_branch";
    readonly condition: CoreValueId;
    readonly trueTarget: CoreBlockId;
    readonly trueArguments: readonly CoreValueId[];
    readonly falseTarget: CoreBlockId;
    readonly falseArguments: readonly CoreValueId[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "return";
    readonly values: readonly CoreValueId[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "trap";
    readonly span: SourceSpan;
  };

export type DucklangCoreBlock = {
  readonly id: CoreBlockId;
  readonly parameters: readonly {
    readonly value: CoreValueId;
    readonly type: CoreTypeId;
    readonly span: SourceSpan;
  }[];
  readonly operations: readonly DucklangCoreOperation[];
  readonly terminator: DucklangCoreTerminator;
};

export type DucklangCoreFunction = {
  readonly id: CoreFunctionId;
  readonly name: string;
  readonly sourceSymbolId: number | undefined;
  readonly signature: CoreSignatureId;
  readonly entryBlock: CoreBlockId;
  readonly blocks: readonly DucklangCoreBlock[];
  readonly span: SourceSpan;
};

export type DucklangCoreModule = {
  readonly schemaVersion: 1;
  readonly file: string;
  readonly types: readonly DucklangCoreType[];
  readonly signatures: readonly DucklangCoreSignature[];
  readonly functions: readonly DucklangCoreFunction[];
  readonly entryFunction: CoreFunctionId;
};

type MutableCoreBlock = {
  readonly id: CoreBlockId;
  readonly parameters: {
    readonly value: CoreValueId;
    readonly type: CoreTypeId;
    readonly span: SourceSpan;
  }[];
  readonly operations: DucklangCoreOperation[];
  terminator: DucklangCoreTerminator | undefined;
};

type LoweredExpression =
  | {
    readonly terminated: false;
    readonly block: MutableCoreBlock;
    readonly value: CoreValueId;
  }
  | {
    readonly terminated: true;
    readonly block: MutableCoreBlock;
  };

type CoreFunctionCapture = {
  readonly symbol: DucklangSymbol;
  readonly type: Type;
};

type CoreFunctionSource = {
  readonly id: CoreFunctionId;
  readonly name: string;
  readonly sourceSymbolId: number | undefined;
  readonly expression: Extract<
    TypedDucklangExpression,
    { readonly kind: "function" }
  >;
  readonly captures: readonly CoreFunctionCapture[];
};

export function lowerDucklangToCore(
  module: TypedDucklangModule,
): DucklangCoreModule {
  const functionPlan = planCoreFunctions(module);
  const mainFunctionId = functionPlan.sources.length as CoreFunctionId;
  const signatures: DucklangCoreSignature[] = [];
  const signatureIds = new Map<string, CoreSignatureId>();
  const signature = (
    parameters: readonly Type[],
    result: Type,
    span: SourceSpan,
  ): CoreSignatureId => {
    const resolved = {
      parameters: parameters.map((type) => types.require(type, span)),
      result: types.require(result, span),
    };
    const key = JSON.stringify(resolved);
    const existing = signatureIds.get(key);
    if (existing !== undefined) return existing;
    const id = signatures.length as CoreSignatureId;
    signatures.push(resolved);
    signatureIds.set(key, id);
    return id;
  };
  const types = new CoreTypeRegistry(module, signature);
  const functionSignatures = new Map<number, CoreSignatureId>();
  for (const source of functionPlan.sources) {
    const parameterTypes = source.expression.parameters.map((parameter) =>
      requireSymbolType(module, parameter)
    );
    parameterTypes.push(...source.captures.map((capture) => capture.type));
    functionSignatures.set(
      source.id,
      signature(
        parameterTypes,
        source.expression.body.type,
        source.expression.span,
      ),
    );
  }
  const mainSignature = signature([], module.result.type, module.result.span);
  // Module-level value bindings are not Core functions, so `main` lowers as a
  // block that binds them before the module result. Without this, any reference
  // to one reported "Core lowering has no runtime value for <name>".
  const valueBindings = module.bindings.filter((binding) =>
    binding.value.kind !== "function"
  );
  const mainBody: TypedDucklangExpression = valueBindings.length === 0
    ? module.result
    : {
      kind: "block",
      steps: valueBindings.map((binding) => ({
        kind: "binding" as const,
        binding,
      })),
      result: module.result,
      type: module.result.type,
      span: module.result.span,
    };
  const functions = functionPlan.sources.map((source) =>
    new CoreFunctionLowerer(
      module,
      types,
      functionPlan,
      functionSignatures,
    ).lower(
      source.id,
      source.name,
      source.sourceSymbolId,
      functionSignatures.get(source.id)!,
      source.expression.parameters,
      source.captures,
      source.expression.body,
      source.expression.span,
    )
  );
  functions.push(
    new CoreFunctionLowerer(
      module,
      types,
      functionPlan,
      functionSignatures,
    ).lower(
      mainFunctionId,
      "main",
      undefined,
      mainSignature,
      [],
      [],
      mainBody,
      module.result.span,
    ),
  );
  const core = canonicalizeDucklangCoreTypes({
    schemaVersion: 1,
    file: module.file,
    types: types.finish(),
    signatures,
    functions,
    entryFunction: mainFunctionId,
  });
  validateDucklangCore(core);
  return core;
}

type CoreFunctionPlan = {
  readonly sources: readonly CoreFunctionSource[];
  readonly byExpression: ReadonlyMap<
    Extract<TypedDucklangExpression, { readonly kind: "function" }>,
    CoreFunctionSource
  >;
  readonly bySymbol: ReadonlyMap<number, CoreFunctionSource>;
};

function planCoreFunctions(module: TypedDucklangModule): CoreFunctionPlan {
  const symbolsByExpression = new Map<
    Extract<TypedDucklangExpression, { readonly kind: "function" }>,
    DucklangSymbol
  >();
  for (const binding of module.bindings) {
    if (binding.value.kind === "function") {
      symbolsByExpression.set(binding.value, binding.symbol);
    }
    collectFunctionBindingSymbols(binding.value, symbolsByExpression);
  }
  collectFunctionBindingSymbols(module.result, symbolsByExpression);

  const expressions: Extract<
    TypedDucklangExpression,
    { readonly kind: "function" }
  >[] = [];
  const collectedExpressions = new Set<TypedDucklangExpression>();
  const collect = (expression: TypedDucklangExpression): void => {
    if (collectedExpressions.has(expression)) return;
    collectedExpressions.add(expression);
    if (expression.kind === "function") expressions.push(expression);
    visitDucklangExpressionChildren(expression, collect);
  };
  for (const binding of module.bindings) collect(binding.value);
  collect(module.result);

  const functionIdsByExpression = new Map(
    expressions.map((expression, index) => [
      expression,
      index as CoreFunctionId,
    ]),
  );
  const functionIdsBySymbol = new Map<number, CoreFunctionId>();
  for (const [expression, symbol] of symbolsByExpression) {
    const id = functionIdsByExpression.get(expression);
    if (id !== undefined) functionIdsBySymbol.set(symbol.id, id);
  }

  const states = expressions.map((expression, index) => {
    const sourceSymbol = symbolsByExpression.get(expression);
    const defined = collectCoreFunctionDefinitions(expression, sourceSymbol);
    const captures = new Map<number, CoreFunctionCapture>();
    const dependencies = new Set<CoreFunctionId>();
    const visit = (candidate: TypedDucklangExpression): void => {
      if (candidate !== expression && candidate.kind === "function") {
        dependencies.add(functionIdsByExpression.get(candidate)!);
        return;
      }
      if (
        candidate.kind === "call" &&
        candidate.callee.kind === "reference"
      ) {
        const callee = functionIdsBySymbol.get(candidate.callee.symbol.id);
        if (callee !== undefined && callee !== index) dependencies.add(callee);
      }
      if (
        candidate.kind === "reference" &&
        !defined.has(candidate.symbol.id) &&
        !functionIdsBySymbol.has(candidate.symbol.id)
      ) {
        captures.set(candidate.symbol.id, {
          symbol: candidate.symbol,
          type: candidate.type,
        });
        return;
      }
      visitDucklangExpressionChildren(candidate, visit);
    };
    visit(expression.body);
    return { expression, sourceSymbol, defined, captures, dependencies };
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const state of states) {
      for (const dependencyId of state.dependencies) {
        for (const capture of states[dependencyId].captures.values()) {
          if (
            state.defined.has(capture.symbol.id) ||
            state.captures.has(capture.symbol.id)
          ) {
            continue;
          }
          state.captures.set(capture.symbol.id, capture);
          changed = true;
        }
      }
    }
  }

  const sources = states.map((state, index): CoreFunctionSource => ({
    id: index as CoreFunctionId,
    name: state.sourceSymbol?.text ??
      `$closure_${state.expression.span.start}_${index}`,
    sourceSymbolId: state.sourceSymbol?.id,
    expression: state.expression,
    captures: [...state.captures.values()],
  }));
  return {
    sources,
    byExpression: new Map(
      sources.map((source) => [source.expression, source]),
    ),
    bySymbol: new Map(
      sources.flatMap((source) =>
        source.sourceSymbolId === undefined
          ? []
          : [[source.sourceSymbolId, source] as const]
      ),
    ),
  };
}

function collectFunctionBindingSymbols(
  expression: TypedDucklangExpression,
  symbols: Map<
    Extract<TypedDucklangExpression, { readonly kind: "function" }>,
    DucklangSymbol
  >,
): void {
  if (expression.kind === "block") {
    for (const step of expression.steps) {
      if (
        step.kind === "binding" && step.binding.value.kind === "function"
      ) {
        symbols.set(step.binding.value, step.binding.symbol);
      }
    }
  }
  visitDucklangExpressionChildren(
    expression,
    (child) => collectFunctionBindingSymbols(child, symbols),
  );
}

function collectCoreFunctionDefinitions(
  expression: Extract<
    TypedDucklangExpression,
    { readonly kind: "function" }
  >,
  sourceSymbol: DucklangSymbol | undefined,
): ReadonlySet<number> {
  const definitions = new Set(
    expression.parameters.map((parameter) => parameter.id),
  );
  if (sourceSymbol !== undefined) definitions.add(sourceSymbol.id);
  const visit = (candidate: TypedDucklangExpression): void => {
    if (candidate.kind === "ifUnion" && candidate.payloadSymbol !== undefined) {
      definitions.add(candidate.payloadSymbol.id);
    }
    if (candidate.kind === "block") {
      for (const step of candidate.steps) {
        if (step.kind === "binding") definitions.add(step.binding.symbol.id);
      }
    }
    visitDucklangExpressionChildren(candidate, visit);
  };
  visit(expression.body);
  return definitions;
}

/**
 * Merges structurally identical Core types onto one `CoreTypeId`.
 *
 * The registry interns by source type spelling, so two spellings of the same
 * Core structure take two IDs: `Int` and `I32` both resolve to `scalar i32`, and
 * two nominally distinct structs with the same field types both resolve to the
 * same product. Core types are structural by design, and the validator compares
 * edge argument types by ID, so leaving duplicates in place would let it reject
 * two values of the same type as differently typed. Nominal distinctness is
 * settled before Core by qualifyDucklangTypeCollisions.
 *
 * Merging one pair can make another pair identical, because a product's key is
 * built from its field IDs, so this runs to a fixpoint.
 */
export function canonicalizeDucklangCoreTypes(
  module: DucklangCoreModule,
): DucklangCoreModule {
  let types = module.types;
  let mapping = types.map((_, index) => index as CoreTypeId);
  // Duplicates stay in the table until the final renumbering, so a round is
  // never the identity. Progress is measured by the number of distinct
  // structures, which can only fall, so the loop is bounded by the table size
  // and stops as soon as a round merges nothing new.
  let previousDistinct = Number.POSITIVE_INFINITY;
  for (let round = 0; round <= types.length; round += 1) {
    const canonical = new Map<string, CoreTypeId>();
    const representatives = types.map((entry, index) => {
      const key = JSON.stringify(entry);
      const existing = canonical.get(key);
      if (existing !== undefined) return existing;
      canonical.set(key, index as CoreTypeId);
      return index as CoreTypeId;
    });
    if (canonical.size >= previousDistinct) break;
    previousDistinct = canonical.size;
    types = types.map((entry) => remapCoreType(entry, representatives));
    mapping = mapping.map((id) => representatives[id]);
  }
  // Dense renumbering keeps `types[id]` addressable after the merge.
  const surviving = [...new Set(mapping)].sort((left, right) => left - right);
  const dense = new Map(
    surviving.map((id, index) => [id, index as CoreTypeId]),
  );
  const finalMapping = mapping.map((id) => dense.get(id)!);
  const remap = (id: CoreTypeId): CoreTypeId => finalMapping[id];
  return {
    ...module,
    types: surviving.map((id) => remapCoreType(types[id], finalMapping)),
    signatures: module.signatures.map((signature) => ({
      parameters: signature.parameters.map(remap),
      result: remap(signature.result),
    })),
    functions: module.functions.map((function_) => ({
      ...function_,
      blocks: function_.blocks.map((block) => ({
        ...block,
        parameters: block.parameters.map((parameter) => ({
          ...parameter,
          type: remap(parameter.type),
        })),
        operations: block.operations.map((operation) => ({
          ...operation,
          type: remap(operation.type),
        })),
      })),
    })),
  };
}

function remapCoreType(
  entry: DucklangCoreType,
  mapping: readonly CoreTypeId[],
): DucklangCoreType {
  if (entry.kind === "product") {
    return { kind: "product", fields: entry.fields.map((id) => mapping[id]) };
  }
  if (entry.kind === "sum") {
    return { kind: "sum", cases: entry.cases.map((id) => mapping[id]) };
  }
  return entry;
}

class CoreTypeRegistry {
  readonly #module: TypedDucklangModule;
  readonly #signature: (
    parameters: readonly Type[],
    result: Type,
    span: SourceSpan,
  ) => CoreSignatureId;
  readonly #types: DucklangCoreType[] = [];
  readonly #typeIds = new Map<string, CoreTypeId>();

  constructor(
    module: TypedDucklangModule,
    signature: (
      parameters: readonly Type[],
      result: Type,
      span: SourceSpan,
    ) => CoreSignatureId,
  ) {
    this.#module = module;
    this.#signature = signature;
  }

  require(type: Type, span: SourceSpan): CoreTypeId {
    if (type.kind === "variable") {
      throw new TypeError(
        `${span.file}:${span.start}: unresolved ${
          formatDucklangType(type)
        } reached monomorphic Core`,
      );
    }
    const key = formatDucklangType(type);
    const existing = this.#typeIds.get(key);
    if (existing !== undefined) return existing;
    const id = this.#types.length as CoreTypeId;
    this.#typeIds.set(key, id);
    this.#types.push({ kind: "product", fields: [] });
    this.#types[id] = this.#resolve(type, span);
    return id;
  }

  finish(): readonly DucklangCoreType[] {
    return this.#types;
  }

  functionSignature(type: Type, span: SourceSpan): CoreSignatureId {
    const coreType = this.#types[this.require(type, span)];
    if (coreType.kind === "function") return coreType.signature;
    throw new TypeError(
      `${span.file}:${span.start}: indirect Core call has non-function type ${
        formatDucklangType(type)
      }`,
    );
  }

  #resolve(
    type: Exclude<Type, { readonly kind: "variable" }>,
    span: SourceSpan,
  ) {
    if (type.kind === "function") {
      const result = functionResultType(type);
      return {
        kind: "function" as const,
        signature: this.#signature(
          functionParameterTypes(type),
          result,
          span,
        ),
      };
    }
    const scalar = {
      i32: "i32",
      i64: "i64",
      f32: "f32",
      f64: "f64",
      f32x4: "f32x4",
      bool: "i32",
      char: "i32",
      unit: "unit",
      Int: "i32",
      I32: "i32",
      I64: "i64",
      F32: "f32",
      F64: "f64",
      Bool: "i32",
      Char: "i32",
      Unit: "unit",
    }[type.name] as DucklangCoreType extends infer _
      ? "i32" | "i64" | "f32" | "f64" | "f32x4" | "unit" | undefined
      : never;
    if (scalar !== undefined) return { kind: "scalar" as const, scalar };
    if (type.name === "text" || type.name === "Text") {
      return { kind: "buffer" as const, buffer: "text" as const };
    }
    if (type.name === "bytes" || type.name === "Bytes") {
      return { kind: "buffer" as const, buffer: "bytes" as const };
    }
    const union = this.#module.unionTypes.find((candidate) =>
      candidate.name === type.name
    );
    if (union !== undefined) {
      const substitutions = new Map(
        union.parameters.map((parameter, index) => [
          parameter,
          type.arguments[index],
        ]),
      );
      return {
        kind: "sum" as const,
        cases: union.cases.map((unionCase) =>
          this.require(
            sourceType(unionCase.payloadType, substitutions),
            unionCase.span,
          )
        ),
      };
    }
    const product = this.#module.structTypes.find((candidate) =>
      candidate.name === type.name
    );
    if (product !== undefined) {
      const substitutions = new Map(
        product.parameters.map((parameter, index) => [
          parameter,
          type.arguments[index],
        ]),
      );
      return {
        kind: "product" as const,
        fields: product.fields.map((field) =>
          this.require(sourceType(field.type, substitutions), field.span)
        ),
      };
    }
    return {
      kind: "product" as const,
      fields: type.arguments.map((argument) => this.require(argument, span)),
    };
  }
}

class CoreFunctionLowerer {
  readonly #module: TypedDucklangModule;
  readonly #types: CoreTypeRegistry;
  readonly #functionPlan: CoreFunctionPlan;
  readonly #functionSignatures: ReadonlyMap<number, CoreSignatureId>;
  readonly #blocks: MutableCoreBlock[] = [];
  #nextValue = 0;

  constructor(
    module: TypedDucklangModule,
    types: CoreTypeRegistry,
    functionPlan: CoreFunctionPlan,
    functionSignatures: ReadonlyMap<number, CoreSignatureId>,
  ) {
    this.#module = module;
    this.#types = types;
    this.#functionPlan = functionPlan;
    this.#functionSignatures = functionSignatures;
  }

  lower(
    id: CoreFunctionId,
    name: string,
    sourceSymbolId: number | undefined,
    signature: CoreSignatureId,
    parameters: readonly DucklangSymbol[],
    captures: readonly CoreFunctionCapture[],
    body: TypedDucklangExpression,
    span: SourceSpan,
  ): DucklangCoreFunction {
    const entry = this.#block(
      [
        ...parameters.map((parameter) => ({
          type: this.#types.require(
            requireSymbolType(this.#module, parameter),
            parameter.span,
          ),
          span: parameter.span,
        })),
        ...captures.map((capture) => ({
          type: this.#types.require(capture.type, capture.symbol.span),
          span: capture.symbol.span,
        })),
      ],
    );
    const environment = new Map(
      [
        ...parameters.map((parameter, index) =>
          [parameter.id, entry.parameters[index].value] as const
        ),
        ...captures.map((capture, index) =>
          [
            capture.symbol.id,
            entry.parameters[parameters.length + index].value,
          ] as const
        ),
      ],
    );
    const lowered = this.#expression(body, entry, environment);
    if (!lowered.terminated) {
      this.#terminate(lowered.block, {
        kind: "return",
        values: [lowered.value],
        span: body.span,
      });
    }
    return {
      id,
      name,
      sourceSymbolId,
      signature,
      entryBlock: entry.id,
      blocks: this.#blocks.map((block) => {
        if (block.terminator === undefined) {
          throw new Error(
            `${span.file}:${span.start}: Core block ${block.id} in ${name} has no terminator`,
          );
        }
        return { ...block, terminator: block.terminator };
      }),
      span,
    };
  }

  #expression(
    expression: TypedDucklangExpression,
    block: MutableCoreBlock,
    environment: Map<number, CoreValueId>,
  ): LoweredExpression {
    switch (expression.kind) {
      case "integer":
      case "integer64":
      case "float32":
      case "float64":
      case "boolean":
      case "string":
        return this.#operation(block, {
          kind: "constant",
          value: expression.value,
          type: this.#types.require(expression.type, expression.span),
          operands: [],
          span: expression.span,
        });
      case "unit":
        return this.#operation(block, {
          kind: "constant",
          value: undefined,
          type: this.#types.require(expression.type, expression.span),
          operands: [],
          span: expression.span,
        });
      case "reference": {
        const value = environment.get(expression.symbol.id);
        if (value !== undefined) return { terminated: false, block, value };
        const source = this.#functionPlan.bySymbol.get(expression.symbol.id);
        if (source !== undefined) {
          return this.#closure(
            source,
            expression.type,
            block,
            environment,
            expression.span,
          );
        }
        throw new ReferenceError(
          `${expression.span.file}:${expression.span.start}: Core lowering has no runtime value for ${expression.symbol.text}#${expression.symbol.id}`,
        );
      }
      case "binary":
        return this.#operands(
          [expression.left, expression.right],
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: "scalar.binary",
              operator: expression.operator,
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            }),
        );
      case "hostCall":
        return this.#operands(
          expression.arguments,
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: "host.call",
              effectName: expression.effectName,
              operationName: expression.operationName,
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            }),
        );
      case "call": {
        if (expression.callee.kind === "primitive") {
          if (expression.callee.primitiveId === PrimitiveId.panic) {
            return this.#operands(
              expression.arguments,
              block,
              environment,
              (current) => {
                this.#terminate(current, {
                  kind: "trap",
                  span: expression.span,
                });
                return { terminated: true, block: current };
              },
            );
          }
          return this.#operands(
            expression.arguments,
            block,
            environment,
            (current, operands) =>
              this.#operation(current, {
                kind: "primitive",
                primitiveId: expression.callee.kind === "primitive"
                  ? expression.callee.primitiveId
                  : PrimitiveId.panic,
                type: this.#types.require(expression.type, expression.span),
                operands,
                span: expression.span,
              }),
          );
        }
        const directSource = expression.callee.kind === "reference"
          ? this.#functionPlan.bySymbol.get(expression.callee.symbol.id)
          : expression.callee.kind === "function"
          ? this.#functionPlan.byExpression.get(expression.callee)
          : undefined;
        if (directSource !== undefined) {
          return this.#operands(
            expression.arguments,
            block,
            environment,
            (current, operands) => {
              const captures = this.#captureValues(
                directSource,
                environment,
                expression.span,
              );
              return this.#operation(current, {
                kind: "call.direct",
                functionId: directSource.id,
                type: this.#types.require(expression.type, expression.span),
                operands: [...operands, ...captures],
                span: expression.span,
              });
            },
          );
        }
        return this.#operands(
          [expression.callee, ...expression.arguments],
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: "call.indirect",
              signature: this.#types.functionSignature(
                expression.callee.type,
                expression.callee.span,
              ),
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            }),
        );
      }
      case "product":
        return this.#operands(
          expression.values,
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: "product.make",
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            }),
        );
      case "project":
        return this.#singleOperand(
          expression.product,
          block,
          environment,
          (current, operand) =>
            this.#operation(current, {
              kind: "product.project",
              index: expression.index,
              type: this.#types.require(expression.type, expression.span),
              operands: [operand],
              span: expression.span,
            }),
        );
      case "recordUpdate":
        return this.#operands(
          [
            expression.product,
            ...expression.fields.map((field) => field.value),
          ],
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: "product.update",
              indices: expression.fields.map((field) => field.index),
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            }),
        );
      case "index":
        return this.#operands(
          [expression.collection, expression.index],
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: isBufferType(expression.collection.type)
                ? "primitive"
                : "product.index",
              ...(isBufferType(expression.collection.type)
                ? { primitiveId: PrimitiveId.bufferGet }
                : {}),
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            } as DucklangCoreOperation),
        );
      case "indexUpdate":
        return this.#operands(
          [expression.product, expression.index, expression.value],
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: isBufferType(expression.product.type)
                ? "primitive"
                : "product.index_update",
              ...(isBufferType(expression.product.type)
                ? { primitiveId: PrimitiveId.bufferSet }
                : {}),
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            } as DucklangCoreOperation),
        );
      case "selectProductElement":
        return this.#operands(
          [...expression.values, expression.index],
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: "product.select",
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            }),
        );
      case "textAppend":
        return this.#operands(
          [expression.left, expression.right],
          block,
          environment,
          (current, operands) =>
            this.#operation(current, {
              kind: "primitive",
              primitiveId: PrimitiveId.bufferAppend,
              type: this.#types.require(expression.type, expression.span),
              operands,
              span: expression.span,
            }),
        );
      case "unionCase": {
        const declaration = this.#module.unionTypes.find((candidate) =>
          candidate.name === expression.unionName
        );
        const caseIndex =
          declaration?.cases.findIndex((candidate) =>
            candidate.name === expression.caseName
          ) ?? -1;
        if (caseIndex < 0) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Core lowering has no case ${expression.unionName}.${expression.caseName}`,
          );
        }
        return this.#singleOperand(
          expression.value,
          block,
          environment,
          (current, operand) =>
            this.#operation(current, {
              kind: "sum.make",
              caseIndex,
              type: this.#types.require(expression.type, expression.span),
              operands: [operand],
              span: expression.span,
            }),
        );
      }
      case "if":
        return this.#ifExpression(expression, block, environment);
      case "ifUnion":
        return this.#ifUnionExpression(expression, block, environment);
      case "block":
        return this.#blockExpression(expression, block, environment);
      case "ownership":
        return this.#singleOperand(
          expression.expression,
          block,
          environment,
          (current, operand) =>
            this.#operation(current, {
              kind: expression.operation === "borrow"
                ? "resource.borrow"
                : "resource.freeze",
              type: this.#types.require(expression.type, expression.span),
              operands: [operand],
              span: expression.span,
            }),
        );
      case "scratch": {
        const entered = this.#operation(block, {
          kind: "region.enter",
          type: this.#types.require(
            { kind: "constructor", name: "unit", arguments: [] },
            expression.span,
          ),
          operands: [],
          span: expression.span,
        });
        const body = this.#expression(
          expression.body,
          entered.block,
          environment,
        );
        if (body.terminated) return body;
        this.#operation(body.block, {
          kind: "region.exit",
          type: this.#types.require(
            { kind: "constructor", name: "unit", arguments: [] },
            expression.span,
          ),
          operands: [entered.value],
          span: expression.span,
        });
        return body;
      }
      case "return": {
        const returned = this.#expression(
          expression.expression,
          block,
          environment,
        );
        if (returned.terminated) return returned;
        this.#terminate(returned.block, {
          kind: "return",
          values: [returned.value],
          span: expression.span,
        });
        return { terminated: true, block: returned.block };
      }
      case "function": {
        const source = this.#functionPlan.byExpression.get(expression);
        if (source === undefined) {
          throw new Error(
            `${expression.span.file}:${expression.span.start}: Core closure has no planned function`,
          );
        }
        return this.#closure(
          source,
          expression.type,
          block,
          environment,
          expression.span,
        );
      }
      case "primitive":
      case "intrinsic":
      case "optionDo":
      case "comptime":
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: compile-time ${expression.kind} reached monomorphic Core`,
        );
    }
  }

  #blockExpression(
    expression: Extract<TypedDucklangExpression, { readonly kind: "block" }>,
    block: MutableCoreBlock,
    outerEnvironment: Map<number, CoreValueId>,
  ): LoweredExpression {
    const environment = new Map(outerEnvironment);
    let current = block;
    for (const step of expression.steps) {
      if (step.kind === "expression") {
        const lowered = this.#expression(
          step.expression,
          current,
          environment,
        );
        if (lowered.terminated) return lowered;
        current = lowered.block;
        continue;
      }
      const lowered = this.#expression(
        step.binding.value,
        current,
        environment,
      );
      if (lowered.terminated) return lowered;
      environment.set(step.binding.symbol.id, lowered.value);
      current = lowered.block;
    }
    return this.#expression(expression.result, current, environment);
  }

  #ifExpression(
    expression: Extract<TypedDucklangExpression, { readonly kind: "if" }>,
    block: MutableCoreBlock,
    environment: Map<number, CoreValueId>,
  ): LoweredExpression {
    const condition = this.#expression(
      expression.condition,
      block,
      environment,
    );
    if (condition.terminated) return condition;
    const consequence = this.#block([]);
    const alternative = this.#block([]);
    const join = this.#block([{
      type: this.#types.require(expression.type, expression.span),
      span: expression.span,
    }]);
    this.#terminate(condition.block, {
      kind: "conditional_branch",
      condition: condition.value,
      trueTarget: consequence.id,
      trueArguments: [],
      falseTarget: alternative.id,
      falseArguments: [],
      span: expression.span,
    });
    const loweredConsequence = this.#expression(
      expression.consequence,
      consequence,
      new Map(environment),
    );
    const loweredAlternative = this.#expression(
      expression.alternative,
      alternative,
      new Map(environment),
    );
    let reachesJoin = false;
    if (!loweredConsequence.terminated) {
      this.#terminate(loweredConsequence.block, {
        kind: "branch",
        target: join.id,
        arguments: [loweredConsequence.value],
        span: expression.consequence.span,
      });
      reachesJoin = true;
    }
    if (!loweredAlternative.terminated) {
      this.#terminate(loweredAlternative.block, {
        kind: "branch",
        target: join.id,
        arguments: [loweredAlternative.value],
        span: expression.alternative.span,
      });
      reachesJoin = true;
    }
    if (!reachesJoin) {
      this.#terminate(join, { kind: "trap", span: expression.span });
      return { terminated: true, block: join };
    }
    return { terminated: false, block: join, value: join.parameters[0].value };
  }

  #ifUnionExpression(
    expression: Extract<TypedDucklangExpression, { readonly kind: "ifUnion" }>,
    block: MutableCoreBlock,
    environment: Map<number, CoreValueId>,
  ): LoweredExpression {
    const value = this.#expression(expression.value, block, environment);
    if (value.terminated) return value;
    const declaration = this.#module.unionTypes.find((candidate) =>
      candidate.name === expression.unionName
    );
    const caseIndex =
      declaration?.cases.findIndex((candidate) =>
        candidate.name === expression.caseName
      ) ?? -1;
    if (caseIndex < 0) {
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: Core lowering has no case ${expression.unionName}.${expression.caseName}`,
      );
    }
    const tag = this.#operation(value.block, {
      kind: "sum.tag",
      type: this.#types.require(
        { kind: "constructor", name: "i32", arguments: [] },
        expression.span,
      ),
      operands: [value.value],
      span: expression.span,
    });
    const expectedTag = this.#operation(tag.block, {
      kind: "constant",
      value: caseIndex,
      type: this.#types.require(
        { kind: "constructor", name: "i32", arguments: [] },
        expression.span,
      ),
      operands: [],
      span: expression.span,
    });
    const matches = this.#operation(expectedTag.block, {
      kind: "scalar.binary",
      operator: "==",
      type: this.#types.require(
        { kind: "constructor", name: "bool", arguments: [] },
        expression.span,
      ),
      operands: [tag.value, expectedTag.value],
      span: expression.span,
    });
    const consequence = this.#block([]);
    const alternative = this.#block([]);
    const join = this.#block([{
      type: this.#types.require(expression.type, expression.span),
      span: expression.span,
    }]);
    this.#terminate(matches.block, {
      kind: "conditional_branch",
      condition: matches.value,
      trueTarget: consequence.id,
      trueArguments: [],
      falseTarget: alternative.id,
      falseArguments: [],
      span: expression.span,
    });
    const consequenceEnvironment = new Map(environment);
    if (expression.payloadSymbol !== undefined) {
      const payload = this.#operation(consequence, {
        kind: "sum.payload",
        caseIndex,
        type: this.#types.require(
          requireSymbolType(this.#module, expression.payloadSymbol),
          expression.payloadSymbol.span,
        ),
        operands: [value.value],
        span: expression.span,
      });
      consequenceEnvironment.set(expression.payloadSymbol.id, payload.value);
    }
    const loweredConsequence = this.#expression(
      expression.consequence,
      consequence,
      consequenceEnvironment,
    );
    const loweredAlternative = this.#expression(
      expression.alternative,
      alternative,
      new Map(environment),
    );
    let reachesJoin = false;
    if (!loweredConsequence.terminated) {
      this.#terminate(loweredConsequence.block, {
        kind: "branch",
        target: join.id,
        arguments: [loweredConsequence.value],
        span: expression.consequence.span,
      });
      reachesJoin = true;
    }
    if (!loweredAlternative.terminated) {
      this.#terminate(loweredAlternative.block, {
        kind: "branch",
        target: join.id,
        arguments: [loweredAlternative.value],
        span: expression.alternative.span,
      });
      reachesJoin = true;
    }
    if (!reachesJoin) {
      this.#terminate(join, { kind: "trap", span: expression.span });
      return { terminated: true, block: join };
    }
    return { terminated: false, block: join, value: join.parameters[0].value };
  }

  #closure(
    source: CoreFunctionSource,
    type: Type,
    block: MutableCoreBlock,
    environment: ReadonlyMap<number, CoreValueId>,
    span: SourceSpan,
  ): LoweredExpression {
    return this.#operation(block, {
      kind: "closure.make",
      functionId: source.id,
      type: this.#types.require(type, span),
      operands: this.#captureValues(source, environment, span),
      span,
    });
  }

  #captureValues(
    source: CoreFunctionSource,
    environment: ReadonlyMap<number, CoreValueId>,
    span: SourceSpan,
  ): readonly CoreValueId[] {
    return source.captures.map((capture) => {
      const value = environment.get(capture.symbol.id);
      if (value !== undefined) return value;
      throw new ReferenceError(
        `${span.file}:${span.start}: Core closure ${source.name} cannot capture ${capture.symbol.text}#${capture.symbol.id} because it has no runtime value`,
      );
    });
  }

  #operands(
    expressions: readonly TypedDucklangExpression[],
    block: MutableCoreBlock,
    environment: Map<number, CoreValueId>,
    emit: (
      block: MutableCoreBlock,
      operands: readonly CoreValueId[],
    ) => LoweredExpression,
  ): LoweredExpression {
    const operands: CoreValueId[] = [];
    let current = block;
    for (const expression of expressions) {
      const lowered = this.#expression(expression, current, environment);
      if (lowered.terminated) return lowered;
      operands.push(lowered.value);
      current = lowered.block;
    }
    return emit(current, operands);
  }

  #singleOperand(
    expression: TypedDucklangExpression,
    block: MutableCoreBlock,
    environment: Map<number, CoreValueId>,
    emit: (
      block: MutableCoreBlock,
      operand: CoreValueId,
    ) => LoweredExpression,
  ): LoweredExpression {
    return this.#operands(
      [expression],
      block,
      environment,
      (current, operands) => emit(current, operands[0]),
    );
  }

  #operation(
    block: MutableCoreBlock,
    operation: DucklangCoreOperationWithoutResult,
  ): Extract<LoweredExpression, { readonly terminated: false }> {
    if (block.terminator !== undefined) {
      throw new Error(
        `${operation.span.file}:${operation.span.start}: cannot append ${operation.kind} after Core block ${block.id} terminator`,
      );
    }
    const result = this.#nextValue++ as CoreValueId;
    block.operations.push({ ...operation, result } as DucklangCoreOperation);
    return { terminated: false, block, value: result };
  }

  #block(
    parameters: readonly {
      readonly type: CoreTypeId;
      readonly span: SourceSpan;
    }[],
  ): MutableCoreBlock {
    const block: MutableCoreBlock = {
      id: this.#blocks.length as CoreBlockId,
      parameters: parameters.map((parameter) => ({
        ...parameter,
        value: this.#nextValue++ as CoreValueId,
      })),
      operations: [],
      terminator: undefined,
    };
    this.#blocks.push(block);
    return block;
  }

  #terminate(
    block: MutableCoreBlock,
    terminator: DucklangCoreTerminator,
  ): void {
    if (block.terminator !== undefined) {
      throw new Error(
        `${terminator.span.file}:${terminator.span.start}: Core block ${block.id} already has a terminator`,
      );
    }
    block.terminator = terminator;
  }
}

export function validateDucklangCore(module: DucklangCoreModule): void {
  requireIndex(module.entryFunction, module.functions.length, "entry function");
  for (const [functionIndex, function_] of module.functions.entries()) {
    if (function_.id !== functionIndex) {
      throw new TypeError(
        `Core function table index ${functionIndex} contains ID ${function_.id}`,
      );
    }
    requireIndex(function_.signature, module.signatures.length, "signature");
    requireIndex(function_.entryBlock, function_.blocks.length, "entry block");
    const signature = module.signatures[function_.signature];
    const entryParameters = function_.blocks[function_.entryBlock].parameters;
    requireCoreTypes(
      `function ${function_.name} entry`,
      entryParameters.map((parameter) => parameter.type),
      signature.parameters,
    );
    const definitions = new Map<
      CoreValueId,
      { readonly block: CoreBlockId; readonly operation: number }
    >();
    for (const [blockIndex, block] of function_.blocks.entries()) {
      if (block.id !== blockIndex) {
        throw new TypeError(
          `Core function ${function_.name} block table index ${blockIndex} contains ID ${block.id}`,
        );
      }
      for (const parameter of block.parameters) {
        requireIndex(
          parameter.type,
          module.types.length,
          "block parameter type",
        );
        defineCoreValue(definitions, parameter.value, block.id, -1, function_);
      }
      for (const [operationIndex, operation] of block.operations.entries()) {
        requireIndex(operation.type, module.types.length, "operation type");
        defineCoreValue(
          definitions,
          operation.result,
          block.id,
          operationIndex,
          function_,
        );
        if (
          operation.kind === "call.direct" ||
          operation.kind === "closure.make"
        ) {
          requireIndex(
            operation.functionId,
            module.functions.length,
            operation.kind === "call.direct"
              ? "direct callee"
              : "closure function",
          );
        }
        if (operation.kind === "call.indirect") {
          requireIndex(
            operation.signature,
            module.signatures.length,
            "indirect signature",
          );
        }
      }
    }
    const predecessors = function_.blocks.map(() => new Set<CoreBlockId>());
    for (const block of function_.blocks) {
      validateTerminatorEdges(function_, block, definitions, predecessors);
    }
    const dominators = calculateDominators(function_, predecessors);
    for (const block of function_.blocks) {
      for (const [operationIndex, operation] of block.operations.entries()) {
        for (const operand of operation.operands) {
          requireDominatingValue(
            function_,
            definitions,
            dominators,
            operand,
            block.id,
            operationIndex,
          );
        }
        validateCoreCallOperation(module, function_, operation);
      }
      for (const operand of terminatorValues(block.terminator)) {
        requireDominatingValue(
          function_,
          definitions,
          dominators,
          operand,
          block.id,
          block.operations.length,
        );
      }
      validateCoreTerminator(module, function_, block);
    }
  }
}

function validateCoreCallOperation(
  module: DucklangCoreModule,
  function_: DucklangCoreFunction,
  operation: DucklangCoreOperation,
): void {
  if (operation.kind === "call.direct") {
    const callee = module.functions[operation.functionId];
    const signature = module.signatures[callee.signature];
    requireCoreTypes(
      `direct call ${function_.name} -> ${callee.name}`,
      operation.operands.map((operand) => coreValueType(function_, operand)),
      signature.parameters,
    );
    if (operation.type !== signature.result) {
      throw new TypeError(
        `Core direct call ${function_.name} -> ${callee.name} has result type ${operation.type}; signature returns ${signature.result}`,
      );
    }
    return;
  }
  if (operation.kind === "closure.make") {
    const target = module.functions[operation.functionId];
    const codeSignature = module.signatures[target.signature];
    const closureType = module.types[operation.type];
    if (closureType.kind !== "function") {
      throw new TypeError(
        `Core closure ${function_.name}:${operation.result} has non-function type ${operation.type}`,
      );
    }
    const closureSignature = module.signatures[closureType.signature];
    if (
      codeSignature.parameters.length <
        closureSignature.parameters.length
    ) {
      throw new TypeError(
        `Core closure ${target.name} exposes ${closureSignature.parameters.length} parameters but its code accepts ${codeSignature.parameters.length}`,
      );
    }
    requireCoreTypes(
      `closure ${target.name} parameters`,
      codeSignature.parameters.slice(0, closureSignature.parameters.length),
      closureSignature.parameters,
    );
    requireCoreTypes(
      `closure ${target.name} captures`,
      operation.operands.map((operand) => coreValueType(function_, operand)),
      codeSignature.parameters.slice(closureSignature.parameters.length),
    );
    if (codeSignature.result !== closureSignature.result) {
      throw new TypeError(
        `Core closure ${target.name} returns ${codeSignature.result}; closure signature returns ${closureSignature.result}`,
      );
    }
    return;
  }
  if (operation.kind !== "call.indirect") return;
  if (operation.operands.length === 0) {
    throw new TypeError(
      `Core indirect call ${function_.name}:${operation.result} has no closure operand`,
    );
  }
  const closureType = module.types[
    coreValueType(function_, operation.operands[0])
  ];
  if (
    closureType.kind !== "function" ||
    closureType.signature !== operation.signature
  ) {
    throw new TypeError(
      `Core indirect call ${function_.name}:${operation.result} signature ${operation.signature} disagrees with its closure type`,
    );
  }
  const signature = module.signatures[operation.signature];
  requireCoreTypes(
    `indirect call ${function_.name}:${operation.result}`,
    operation.operands.slice(1).map((operand) =>
      coreValueType(function_, operand)
    ),
    signature.parameters,
  );
  if (operation.type !== signature.result) {
    throw new TypeError(
      `Core indirect call ${function_.name}:${operation.result} has result type ${operation.type}; signature returns ${signature.result}`,
    );
  }
}

function validateCoreTerminator(
  module: DucklangCoreModule,
  function_: DucklangCoreFunction,
  block: DucklangCoreBlock,
): void {
  if (block.terminator.kind === "conditional_branch") {
    const conditionType = module.types[
      coreValueType(function_, block.terminator.condition)
    ];
    if (conditionType.kind !== "scalar" || conditionType.scalar !== "i32") {
      throw new TypeError(
        `Core conditional ${function_.name}:${block.id} has non-i32 condition`,
      );
    }
    return;
  }
  if (block.terminator.kind !== "return") return;
  const signature = module.signatures[function_.signature];
  requireCoreTypes(
    `return ${function_.name}:${block.id}`,
    block.terminator.values.map((value) => coreValueType(function_, value)),
    [signature.result],
  );
}

function requireCoreTypes(
  subject: string,
  actual: readonly CoreTypeId[],
  expected: readonly CoreTypeId[],
): void {
  if (actual.length !== expected.length) {
    throw new TypeError(
      `Core ${subject} supplies ${actual.length} values for ${expected.length} types`,
    );
  }
  for (const [index, type] of actual.entries()) {
    if (type === expected[index]) continue;
    throw new TypeError(
      `Core ${subject} value ${index} has type ${type}; expected ${
        expected[index]
      }`,
    );
  }
}

function validateTerminatorEdges(
  function_: DucklangCoreFunction,
  block: DucklangCoreBlock,
  definitions: ReadonlyMap<CoreValueId, unknown>,
  predecessors: Set<CoreBlockId>[],
): void {
  const edge = (
    target: CoreBlockId,
    arguments_: readonly CoreValueId[],
  ): void => {
    requireIndex(target, function_.blocks.length, "branch target");
    const parameters = function_.blocks[target].parameters;
    if (arguments_.length !== parameters.length) {
      throw new TypeError(
        `Core edge ${function_.name}:${block.id} -> ${target} supplies ${arguments_.length} arguments for ${parameters.length} parameters`,
      );
    }
    for (const [index, argument] of arguments_.entries()) {
      const definition = definitions.get(argument) as
        | { readonly block: CoreBlockId; readonly operation: number }
        | undefined;
      if (definition === undefined) {
        throw new TypeError(
          `Core edge ${function_.name}:${block.id} uses undefined value ${argument}`,
        );
      }
      const argumentType = coreValueType(function_, argument);
      if (argumentType !== parameters[index].type) {
        throw new TypeError(
          `Core edge ${function_.name}:${block.id} argument ${index} has type ${argumentType}; target ${target} expects ${
            parameters[index].type
          }`,
        );
      }
    }
    predecessors[target].add(block.id);
  };
  if (block.terminator.kind === "branch") {
    edge(block.terminator.target, block.terminator.arguments);
  } else if (block.terminator.kind === "conditional_branch") {
    edge(
      block.terminator.trueTarget,
      block.terminator.trueArguments,
    );
    edge(
      block.terminator.falseTarget,
      block.terminator.falseArguments,
    );
  }
}

function calculateDominators(
  function_: DucklangCoreFunction,
  predecessors: readonly ReadonlySet<CoreBlockId>[],
): readonly ReadonlySet<CoreBlockId>[] {
  const all = new Set(function_.blocks.map((block) => block.id));
  const dominators = function_.blocks.map((block) =>
    block.id === function_.entryBlock ? new Set([block.id]) : new Set(all)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of function_.blocks) {
      if (block.id === function_.entryBlock) continue;
      const incoming = [...predecessors[block.id]];
      const next = incoming.length === 0 ? new Set([block.id]) : new Set(
        [...dominators[incoming[0]]].filter((candidate) =>
          incoming.slice(1).every((predecessor) =>
            dominators[predecessor].has(candidate)
          )
        ),
      );
      next.add(block.id);
      if (
        next.size !== dominators[block.id].size ||
        [...next].some((candidate) => !dominators[block.id].has(candidate))
      ) {
        dominators[block.id] = next;
        changed = true;
      }
    }
  }
  return dominators;
}

function requireDominatingValue(
  function_: DucklangCoreFunction,
  definitions: ReadonlyMap<
    CoreValueId,
    { readonly block: CoreBlockId; readonly operation: number }
  >,
  dominators: readonly ReadonlySet<CoreBlockId>[],
  value: CoreValueId,
  useBlock: CoreBlockId,
  useOperation: number,
): void {
  const definition = definitions.get(value);
  if (definition === undefined) {
    throw new TypeError(
      `Core function ${function_.name} uses undefined value ${value}`,
    );
  }
  if (definition.block === useBlock) {
    if (definition.operation >= useOperation) {
      throw new TypeError(
        `Core function ${function_.name} value ${value} is used before its definition in block ${useBlock}`,
      );
    }
    return;
  }
  if (!dominators[useBlock].has(definition.block)) {
    throw new TypeError(
      `Core function ${function_.name} value ${value} from block ${definition.block} does not dominate block ${useBlock}`,
    );
  }
}

function defineCoreValue(
  definitions: Map<
    CoreValueId,
    { readonly block: CoreBlockId; readonly operation: number }
  >,
  value: CoreValueId,
  block: CoreBlockId,
  operation: number,
  function_: DucklangCoreFunction,
): void {
  const previous = definitions.get(value);
  if (previous !== undefined) {
    throw new TypeError(
      `Core function ${function_.name} defines value ${value} in blocks ${previous.block} and ${block}`,
    );
  }
  definitions.set(value, { block, operation });
}

function coreValueType(
  function_: DucklangCoreFunction,
  value: CoreValueId,
): CoreTypeId {
  for (const block of function_.blocks) {
    const parameter = block.parameters.find((candidate) =>
      candidate.value === value
    );
    if (parameter !== undefined) return parameter.type;
    const operation = block.operations.find((candidate) =>
      candidate.result === value
    );
    if (operation !== undefined) return operation.type;
  }
  throw new TypeError(
    `Core function ${function_.name} has no type for value ${value}`,
  );
}

function terminatorValues(
  terminator: DucklangCoreTerminator,
): readonly CoreValueId[] {
  if (terminator.kind === "branch") return terminator.arguments;
  if (terminator.kind === "conditional_branch") {
    return [
      terminator.condition,
      ...terminator.trueArguments,
      ...terminator.falseArguments,
    ];
  }
  return terminator.kind === "return" ? terminator.values : [];
}

function requireIndex(index: number, length: number, subject: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new RangeError(
      `Core ${subject} ${index} is outside table length ${length}`,
    );
  }
}

function requireSymbolType(
  module: TypedDucklangModule,
  symbol: DucklangSymbol,
): Type {
  const type = module.symbolTypes.get(symbol.id);
  if (type !== undefined) return type;
  throw new Error(
    `${symbol.span.file}:${symbol.span.start}: missing type for ${symbol.text}#${symbol.id}`,
  );
}

function functionParameterTypes(type: Type): readonly Type[] {
  const parameters: Type[] = [];
  let current = type;
  while (current.kind === "function") {
    parameters.push(current.parameter);
    current = current.result;
  }
  return parameters;
}

function functionResultType(type: Type): Type {
  let current = type;
  while (current.kind === "function") current = current.result;
  return current;
}

function sourceType(
  reference: {
    readonly name: string;
    readonly arguments: readonly {
      readonly name: string;
      readonly arguments: readonly unknown[];
    }[];
  },
  substitutions: ReadonlyMap<string, Type | undefined>,
): Type {
  const substituted = substitutions.get(reference.name);
  if (substituted !== undefined && reference.arguments.length === 0) {
    return substituted;
  }
  return {
    kind: "constructor",
    name: normalizeTypeName(reference.name),
    arguments: reference.arguments.map((argument) =>
      sourceType(
        argument as Parameters<typeof sourceType>[0],
        substitutions,
      )
    ),
  };
}

function normalizeTypeName(name: string): string {
  return {
    Int: "i32",
    I32: "i32",
    I64: "i64",
    F32: "f32",
    F64: "f64",
    Bool: "bool",
    Char: "char",
    Text: "text",
    Bytes: "bytes",
    Unit: "unit",
  }[name] ?? name;
}

function isBufferType(type: Type): boolean {
  return type.kind === "constructor" &&
    (type.name === "text" || type.name === "Text" ||
      type.name === "bytes" || type.name === "Bytes");
}

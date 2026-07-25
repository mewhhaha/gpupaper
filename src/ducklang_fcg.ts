import type { FcgFunction, FcgOperation, WasmArtifact } from "./fcg.ts";
import { flattenFcgModule, inflateFlatFcgPackage } from "./flat_fcg.ts";
import { type FlatFcgRewriteProposal, rewriteFlatFcg } from "./fcg_rewrite.ts";
import {
  ducklangRuntimeImportModule,
  primitiveDescriptor,
  PrimitiveId,
  type PrimitiveId as PrimitiveIdType,
  primitiveRuntimeImportName,
} from "./ducklang_primitives.ts";
import {
  managedBytesMakeImportName,
  managedProductIndexImportName,
  managedProductIndexUpdateImportName,
  managedProductMakeImportName,
  managedProductProjectImportName,
  managedProductUpdateImportName,
  managedSumMakeImportName,
  managedSumPayloadImportName,
  managedSumTagImportName,
} from "./ducklang_managed_layout.ts";
import type { SourceSpan } from "./syntax.ts";
import type { Type } from "./types.ts";
import {
  type DucklangBinaryOperator,
  formatDucklangType,
  type TypedDucklangBinding,
  type TypedDucklangExpression,
  type TypedDucklangModule,
} from "./ducklang_types.ts";
import {
  emitWasmPlanOnCpu,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./wasm.ts";

type DucklangFcgInstruction =
  | {
    readonly kind: "constant";
    readonly value: number | bigint;
    readonly valueType: WasmScalarTypeName;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "localGet";
    readonly local: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "globalGet";
    readonly global: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "globalSet";
    readonly global: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "localSet";
    readonly local: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "call";
    readonly functionIndex: number;
    readonly functionName: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "return";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "drop";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "trap";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: DucklangBinaryOperator;
    readonly valueType: WasmScalarTypeName;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "numericPrimitive";
    readonly primitiveId: PrimitiveIdType;
    readonly valueType: WasmScalarTypeName;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "integerConversion";
    readonly primitiveId:
      | typeof PrimitiveId.i32WrapI64
      | typeof PrimitiveId.i64ExtendI32Signed
      | typeof PrimitiveId.i64ExtendI32Unsigned;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionPack";
    readonly tag: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionMatch";
    readonly unionLocal: number;
    readonly tag: number;
    readonly payloadLocal: number | undefined;
    readonly resultType: WasmScalarTypeName;
    readonly consequence: readonly DucklangFcgInstruction[];
    readonly alternative: readonly DucklangFcgInstruction[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly resultType: WasmScalarTypeName;
    readonly consequence: readonly DucklangFcgInstruction[];
    readonly alternative: readonly DucklangFcgInstruction[];
    readonly span: SourceSpan;
  };

type WasmScalarTypeName = "i32" | "i64" | "f32" | "f64";

type DucklangFcgFunction = {
  readonly name: string;
  readonly parameterNames: readonly string[];
  readonly localCount: number;
  readonly instructions: readonly DucklangFcgInstruction[];
};

type FunctionShape = {
  readonly index: number;
  readonly name: string;
  readonly parameterCount: number;
  readonly parameterTypes: readonly number[];
  readonly resultType: number;
  readonly binding: TypedDucklangBinding | undefined;
};

type HostFunctionShape = {
  readonly index: number;
  readonly name: string;
};

type RuntimePrimitiveShape = {
  readonly index: number;
  readonly name: string;
};

type ManagedAggregateShape = RuntimePrimitiveShape;

export type DucklangWasmArtifact = WasmArtifact & {
  readonly textLiterals: readonly string[];
};

export const ducklangTextLiteralsSectionName = "ducklang.text_literals";

export function lowerDucklangToFcgAndWasm(
  module: TypedDucklangModule,
): DucklangWasmArtifact {
  const builder = new WasmModuleBuilder();
  const shapes = new Map<number, FunctionShape>();
  const orderedShapes: FunctionShape[] = [];
  const unionNames = new Set(
    module.unionTypes.map((declaration) => declaration.name),
  );
  const unionTags = new Map(
    module.unionTypes.flatMap((declaration) =>
      declaration.cases.map((unionCase, tag) =>
        [
          `${declaration.name}.${unionCase.name}`,
          tag,
        ] as const
      )
    ),
  );
  const runtimePrimitives = new Map<PrimitiveIdType, RuntimePrimitiveShape>();
  for (const use of collectRuntimePrimitiveUses(module)) {
    if (runtimePrimitives.has(use.primitiveId)) continue;
    const parameterTypes = use.arguments.map((argument) =>
      wasmValueType(module.file, argument.span, argument.type, unionNames)
    );
    const resultType = wasmValueType(
      module.file,
      use.span,
      use.resultType,
      unionNames,
    );
    const typeIndex = builder.addFunctionType(parameterTypes, [resultType]);
    const name = primitiveRuntimeImportName(use.primitiveId);
    const index = builder.addFunctionImport(
      ducklangRuntimeImportModule,
      name,
      typeIndex,
    );
    runtimePrimitives.set(use.primitiveId, { index, name });
  }
  const managedAggregates = new Map<string, ManagedAggregateShape>();
  for (const use of collectManagedAggregateUses(module)) {
    if (managedAggregates.has(use.name)) continue;
    const parameterTypes = use.arguments.map((argument) =>
      wasmValueType(module.file, argument.span, argument.type, unionNames)
    );
    const resultType = wasmValueType(
      module.file,
      use.span,
      use.resultType,
      unionNames,
    );
    const typeIndex = builder.addFunctionType(parameterTypes, [resultType]);
    const index = builder.addFunctionImport(
      ducklangRuntimeImportModule,
      use.name,
      typeIndex,
    );
    managedAggregates.set(use.name, { index, name: use.name });
  }
  const hostFunctions = new Map<string, HostFunctionShape>();
  const textLiterals = collectTextLiterals(module);
  const textHandles = new Map(
    textLiterals.map((literal, index) => [literal, index + 1]),
  );
  for (const call of collectHostCalls(module)) {
    const key = hostFunctionKey(call.effectName, call.operationName);
    if (hostFunctions.has(key)) continue;
    const parameterTypes = call.arguments.map((argument) =>
      wasmValueType(module.file, argument.span, argument.type, unionNames)
    );
    const resultType = wasmValueType(
      module.file,
      call.span,
      call.type,
      unionNames,
    );
    const typeIndex = builder.addFunctionType(parameterTypes, [resultType]);
    const moduleName = call.effectName[0].toLowerCase() +
      call.effectName.slice(1);
    const index = builder.addFunctionImport(
      moduleName,
      call.operationName,
      typeIndex,
    );
    hostFunctions.set(key, {
      index,
      name: `${moduleName}.${call.operationName}`,
    });
  }
  const importedFunctionCount = runtimePrimitives.size +
    managedAggregates.size + hostFunctions.size;

  for (const binding of module.bindings) {
    const parameterCount = binding.value.kind === "function"
      ? binding.value.parameters.length
      : 0;
    const parameterTypes = binding.value.kind === "function"
      ? binding.value.parameters.map((parameter) => {
        const type = module.symbolTypes.get(parameter.id);
        if (type === undefined) {
          throw new Error(
            `${module.file}:${parameter.span.start}: missing type for Ducklang parameter ${parameter.text}#${parameter.id}`,
          );
        }
        try {
          return wasmValueType(module.file, parameter.span, type, unionNames);
        } catch (cause) {
          throw new TypeError(
            `${module.file}:${parameter.span.start}: Ducklang function ${binding.symbol.text} parameter ${parameter.text} has no Wasm representation: ${
              formatDucklangType(type)
            }`,
            { cause },
          );
        }
      })
      : [];
    const resultType = wasmValueType(
      module.file,
      binding.span,
      binding.value.kind === "function"
        ? binding.value.body.type
        : binding.type,
      unionNames,
    );
    const shape = {
      index: importedFunctionCount + orderedShapes.length,
      name: `${binding.symbol.text}__duck${binding.symbol.id}`,
      parameterCount,
      parameterTypes,
      resultType,
      binding,
    } satisfies FunctionShape;
    shapes.set(binding.symbol.id, shape);
    orderedShapes.push(shape);
  }
  const mainShape = {
    index: importedFunctionCount + orderedShapes.length,
    name: "main",
    parameterCount: 0,
    parameterTypes: [],
    resultType: wasmValueType(
      module.file,
      module.result.span,
      module.resultType,
      unionNames,
    ),
    binding: undefined,
  } satisfies FunctionShape;
  orderedShapes.push(mainShape);

  const typeIndices = orderedShapes.map((shape) =>
    builder.addFunctionType(
      shape.parameterTypes,
      [shape.resultType],
    )
  );
  // A module-level binding is emitted as a zero-argument function that each
  // reference calls, so its value is recomputed per read. For a binding that
  // performs an effect that re-performs the effect, which is a miscompile rather
  // than merely wasteful. Locals cannot fix it, because the readers are separate
  // functions with their own local space, so each effectful binding gets a mutable
  // global that `main` computes once in a prologue.
  const effectGlobals = new Map<number, number>();
  const effectPrologue: {
    readonly binding: TypedDucklangBinding;
    readonly global: number;
  }[] = [];
  for (const binding of module.bindings) {
    if (binding.value.kind === "function") continue;
    const calls: Extract<
      TypedDucklangExpression,
      { readonly kind: "hostCall" }
    >[] = [];
    visitHostCalls(binding.value, calls);
    if (calls.length === 0) continue;
    const global = builder.addMutableGlobal(
      wasmValueType(module.file, binding.span, binding.type, unionNames),
    );
    effectGlobals.set(binding.symbol.id, global);
    effectPrologue.push({ binding, global });
  }
  const analyzedFunctions = orderedShapes.map((shape) => {
    const expression = shape.binding?.value ?? module.result;
    const parameters = expression.kind === "function"
      ? expression.parameters
      : [];
    const body = expression.kind === "function" ? expression.body : expression;
    const compiler = new DucklangFcgCompiler(
      module.file,
      shapes,
      runtimePrimitives,
      managedAggregates,
      hostFunctions,
      module.symbolTypes,
      parameters,
      unionNames,
      unionTags,
      textHandles,
      effectGlobals,
    );
    // The owning shape's body is the effect performance itself and cannot
    // reference the binding, so no special case is needed here.
    //
    // `main` gets a prologue that performs each effect once and stores it, so
    // every later read is a global.get of an already-computed value.
    const compiled = shape.binding === undefined && effectPrologue.length > 0
      ? compiler.compileWithPrologue(body, effectPrologue)
      : compiler.compile(body);
    return { shape, parameters, compiled };
  });
  const analyzedFcg = {
    functions: analyzedFunctions.map(({ shape, parameters, compiled }) =>
      publicFunction({
        name: shape.name,
        parameterNames: parameters.map((parameter) => parameter.text),
        localCount: compiled.localCount,
        instructions: compiled.instructions,
      })
    ),
    constructorTags: new Map<string, number>(),
  };
  const rewrite = rewriteFlatFcg(flattenFcgModule(analyzedFcg));
  const acceptedRewrites = acceptedDucklangRewritesByFunction(
    analyzedFcg.functions,
    rewrite.accepted,
  );
  const loweredFunctions: DucklangFcgFunction[] = [];
  for (
    const [functionIndex, { shape, parameters, compiled }] of analyzedFunctions
      .entries()
  ) {
    const instructions = optimizeDucklangInstructions(
      compiled.instructions,
      acceptedRewrites.get(functionIndex) ?? new Set(),
    );
    const emittedFunctionIndex = builder.addFunction(
      typeIndices[shape.index - importedFunctionCount],
      compiled.localTypes,
      emitInstructions(instructions),
    );
    if (emittedFunctionIndex !== shape.index) {
      throw new Error(
        `internal error: Ducklang function ${shape.name} expected index ${shape.index}; received ${emittedFunctionIndex}`,
      );
    }
    loweredFunctions.push({
      name: shape.name,
      parameterNames: parameters.map((parameter) => parameter.text),
      localCount: compiled.localCount,
      instructions,
    });
  }

  builder.exportFunction("main", mainShape.index);
  if (textLiterals.length > 0) {
    builder.addCustomSection(
      ducklangTextLiteralsSectionName,
      new TextEncoder().encode(JSON.stringify(textLiterals)),
    );
  }
  const wasmPlan = builder.finishPlan();
  const wasm = emitWasmPlanOnCpu(wasmPlan);
  try {
    new WebAssembly.Module(
      new Uint8Array(wasm).buffer as ArrayBuffer,
    );
  } catch (cause) {
    throw new Error(
      `internal error: emitted Ducklang WebAssembly did not validate: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  const fcg = {
    functions: loweredFunctions.map(publicFunction),
    constructorTags: new Map<string, number>(),
  };
  const rewrittenFcg = inflateFlatFcgPackage(rewrite.package);
  if (
    JSON.stringify(fcg.functions) !== JSON.stringify(rewrittenFcg.functions)
  ) {
    throw new Error(
      "internal error: accepted Ducklang FCG rewrites did not match Wasm lowering",
    );
  }
  return {
    fcg,
    flatFcg: rewrite.package,
    wasmPlan,
    wasm,
    textLiterals,
  };
}

function collectTextLiterals(module: TypedDucklangModule): readonly string[] {
  const literals = new Set<string>();
  const pending: unknown[] = [
    ...module.bindings.map((binding) => binding.value),
    module.result,
  ];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    if (node.kind === "string" && typeof node.value === "string") {
      literals.add(node.value);
      continue;
    }
    pending.push(...Object.values(node));
  }
  return [...literals].sort();
}

type RuntimePrimitiveUse = {
  readonly primitiveId: PrimitiveIdType;
  readonly arguments: readonly TypedDucklangExpression[];
  readonly resultType: Type;
  readonly span: SourceSpan;
};

function collectRuntimePrimitiveUses(
  module: TypedDucklangModule,
): readonly RuntimePrimitiveUse[] {
  const uses: RuntimePrimitiveUse[] = [];
  const pending: unknown[] = [
    ...module.bindings.map((binding) => binding.value),
    module.result,
  ];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    const expression = value as Partial<TypedDucklangExpression>;
    if (
      expression.kind === "call" &&
      expression.callee?.kind === "primitive" &&
      isManagedRuntimePrimitive(expression.callee.primitiveId)
    ) {
      uses.push({
        primitiveId: expression.callee.primitiveId,
        arguments: expression.arguments ?? [],
        resultType: expression.type as Type,
        span: expression.span as SourceSpan,
      });
    } else if (
      expression.kind === "call" &&
      expression.callee?.kind === "primitive" &&
      expression.callee.primitiveId === PrimitiveId.bytesGenerate &&
      expression.arguments?.[0]?.kind === "integer" &&
      expression.arguments[0].value > 512
    ) {
      const length = expression.arguments[0];
      const zero: TypedDucklangExpression = {
        kind: "integer",
        value: 0,
        type: length.type,
        span: expression.span as SourceSpan,
      };
      uses.push(
        {
          primitiveId: PrimitiveId.bytesFill,
          arguments: [length, zero],
          resultType: expression.type as Type,
          span: expression.span as SourceSpan,
        },
        {
          primitiveId: PrimitiveId.bufferSet,
          arguments: [
            expression as TypedDucklangExpression,
            length,
            zero,
          ],
          resultType: expression.type as Type,
          span: expression.span as SourceSpan,
        },
      );
    } else if (
      expression.kind === "textAppend" &&
      expression.left !== undefined && expression.right !== undefined
    ) {
      uses.push({
        primitiveId: PrimitiveId.bufferAppend,
        arguments: [expression.left, expression.right],
        resultType: expression.type as Type,
        span: expression.span as SourceSpan,
      });
    } else if (
      expression.kind === "binary" &&
      (expression.operator === "==" || expression.operator === "!=") &&
      expression.left !== undefined && expression.right !== undefined &&
      expression.left.type.kind === "constructor" &&
      expression.left.type.name === "text"
    ) {
      uses.push({
        primitiveId: PrimitiveId.bufferEqual,
        arguments: [expression.left, expression.right],
        resultType: expression.type as Type,
        span: expression.span as SourceSpan,
      });
    } else if (
      expression.kind === "index" &&
      expression.collection !== undefined && expression.index !== undefined &&
      isBufferType(expression.collection.type)
    ) {
      uses.push({
        primitiveId: PrimitiveId.bufferGet,
        arguments: [expression.collection, expression.index],
        resultType: expression.type as Type,
        span: expression.span as SourceSpan,
      });
    } else if (
      expression.kind === "indexUpdate" &&
      expression.product !== undefined && expression.index !== undefined &&
      expression.value !== undefined &&
      isBufferType(expression.product.type)
    ) {
      uses.push({
        primitiveId: PrimitiveId.bufferSet,
        arguments: [
          expression.product,
          expression.index,
          expression.value,
        ],
        resultType: expression.type as Type,
        span: expression.span as SourceSpan,
      });
    }
    pending.push(...Object.values(value));
  }
  return uses;
}

function isManagedRuntimePrimitive(primitiveId: PrimitiveIdType): boolean {
  return primitiveId === PrimitiveId.bufferLength ||
    primitiveId === PrimitiveId.bufferGet ||
    primitiveId === PrimitiveId.bufferSlice ||
    primitiveId === PrimitiveId.bufferAppend ||
    primitiveId === PrimitiveId.bufferSet ||
    primitiveId === PrimitiveId.bytesFill ||
    primitiveId === PrimitiveId.bufferEqual ||
    primitiveId === PrimitiveId.utf8Encode ||
    primitiveId === PrimitiveId.utf8Decode;
}

function isIntegerConversion(
  primitiveId: PrimitiveIdType,
): primitiveId is
  | typeof PrimitiveId.i32WrapI64
  | typeof PrimitiveId.i64ExtendI32Signed
  | typeof PrimitiveId.i64ExtendI32Unsigned {
  return primitiveId === PrimitiveId.i32WrapI64 ||
    primitiveId === PrimitiveId.i64ExtendI32Signed ||
    primitiveId === PrimitiveId.i64ExtendI32Unsigned;
}

function isWasmNumericPrimitive(primitiveId: PrimitiveIdType): boolean {
  return primitiveId === PrimitiveId.bitAnd ||
    primitiveId === PrimitiveId.bitOr ||
    primitiveId === PrimitiveId.bitXor ||
    primitiveId === PrimitiveId.shiftLeft ||
    primitiveId === PrimitiveId.shiftRightUnsigned ||
    primitiveId === PrimitiveId.f32SquareRoot ||
    primitiveId === PrimitiveId.f32FromI32 ||
    primitiveId === PrimitiveId.i32FromF32 ||
    primitiveId === PrimitiveId.f64FromI32 ||
    primitiveId === PrimitiveId.i32FromF64;
}

type ManagedAggregateUse = {
  readonly name: string;
  readonly arguments: readonly TypedDucklangExpression[];
  readonly resultType: Type;
  readonly span: SourceSpan;
};

function collectManagedAggregateUses(
  module: TypedDucklangModule,
): readonly ManagedAggregateUse[] {
  const uses: ManagedAggregateUse[] = [];
  const unionTags = new Map(
    module.unionTypes.flatMap((declaration) =>
      declaration.cases.map((unionCase, tag) =>
        [`${declaration.name}.${unionCase.name}`, tag] as const
      )
    ),
  );
  const i32Type: Type = {
    kind: "constructor",
    name: "i32",
    arguments: [],
  };
  const pending: unknown[] = [
    ...module.bindings.map((binding) => binding.value),
    module.result,
  ];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    const expression = value as TypedDucklangExpression;
    switch (expression.kind) {
      case "call":
        if (
          expression.callee.kind === "primitive" &&
          expression.callee.primitiveId === PrimitiveId.bytesGenerate &&
          expression.arguments[0]?.kind === "integer" &&
          expression.arguments[0].value <= 512 &&
          (expression.arguments[1]?.kind === "function" ||
            expression.arguments[1]?.kind === "reference")
        ) {
          const length = expression.arguments[0].value;
          uses.push({
            name: managedBytesMakeImportName(length),
            arguments: Array.from(
              { length },
              () => expression.arguments[0],
            ),
            resultType: expression.type,
            span: expression.span,
          });
        }
        break;
      case "unionCase": {
        const tag = unionTags.get(
          `${expression.unionName}.${expression.caseName}`,
        );
        if (tag === undefined) {
          throw new TypeError(
            `${module.file}:${expression.span.start}: Ducklang union constructor ${expression.unionName}.${expression.caseName} has no layout tag`,
          );
        }
        uses.push({
          name: managedSumMakeImportName(tag),
          arguments: [expression.value],
          resultType: expression.type,
          span: expression.span,
        });
        break;
      }
      case "ifUnion": {
        uses.push({
          name: managedSumTagImportName,
          arguments: [expression.value],
          resultType: i32Type,
          span: expression.span,
        });
        if (expression.payloadSymbol !== undefined) {
          const payloadType = module.symbolTypes.get(
            expression.payloadSymbol.id,
          );
          if (payloadType === undefined) {
            throw new Error(
              `${module.file}:${expression.span.start}: missing type for Ducklang union payload ${expression.payloadSymbol.text}#${expression.payloadSymbol.id}`,
            );
          }
          uses.push({
            name: managedSumPayloadImportName(
              isI64(payloadType) ? "i64" : "i32",
            ),
            arguments: [expression.value],
            resultType: payloadType,
            span: expression.span,
          });
        }
        break;
      }
      case "product":
        uses.push({
          name: managedProductMakeImportName(expression.values.length),
          arguments: expression.values,
          resultType: expression.type,
          span: expression.span,
        });
        break;
      case "project":
        uses.push({
          name: managedProductProjectImportName(expression.index),
          arguments: [expression.product],
          resultType: expression.type,
          span: expression.span,
        });
        break;
      case "recordUpdate":
        uses.push({
          name: managedProductUpdateImportName(
            expression.fields.map((field) => field.index),
          ),
          arguments: [
            expression.product,
            ...expression.fields.map((field) => field.value),
          ],
          resultType: expression.type,
          span: expression.span,
        });
        break;
      case "indexUpdate":
        if (!isBufferType(expression.product.type)) {
          uses.push({
            name: managedProductIndexUpdateImportName,
            arguments: [
              expression.product,
              expression.index,
              expression.value,
            ],
            resultType: expression.type,
            span: expression.span,
          });
        }
        break;
      case "index":
        if (!isBufferType(expression.collection.type)) {
          uses.push({
            name: managedProductIndexImportName,
            arguments: [expression.collection, expression.index],
            resultType: expression.type,
            span: expression.span,
          });
        }
        break;
    }
    pending.push(...Object.values(value));
  }
  return uses;
}

function collectHostCalls(
  module: TypedDucklangModule,
): readonly Extract<TypedDucklangExpression, { readonly kind: "hostCall" }>[] {
  const calls: Extract<
    TypedDucklangExpression,
    { readonly kind: "hostCall" }
  >[] = [];
  for (const binding of module.bindings) {
    visitHostCalls(binding.value, calls);
  }
  visitHostCalls(module.result, calls);
  return calls;
}

function visitHostCalls(
  expression: TypedDucklangExpression,
  calls: Extract<
    TypedDucklangExpression,
    { readonly kind: "hostCall" }
  >[],
): void {
  if (expression.kind === "hostCall") {
    calls.push(expression);
    for (const argument of expression.arguments) {
      visitHostCalls(argument, calls);
    }
    return;
  }
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "float32":
    case "float64":
    case "boolean":
    case "unit":
    case "string":
    case "intrinsic":
    case "reference":
      return;
    case "optionDo":
      visitHostCalls(expression.option, calls);
      return;
    case "unionCase":
      visitHostCalls(expression.value, calls);
      return;
    case "product":
      for (const value of expression.values) visitHostCalls(value, calls);
      return;
    case "project":
      visitHostCalls(expression.product, calls);
      return;
    case "recordUpdate":
      visitHostCalls(expression.product, calls);
      for (const field of expression.fields) {
        visitHostCalls(field.value, calls);
      }
      return;
    case "function":
      visitHostCalls(expression.body, calls);
      return;
    case "call":
      visitHostCalls(expression.callee, calls);
      for (const argument of expression.arguments) {
        visitHostCalls(argument, calls);
      }
      return;
    case "index":
      visitHostCalls(expression.collection, calls);
      visitHostCalls(expression.index, calls);
      return;
    case "selectProductElement":
      for (const value of expression.values) visitHostCalls(value, calls);
      visitHostCalls(expression.index, calls);
      return;
    case "indexUpdate":
      visitHostCalls(expression.product, calls);
      visitHostCalls(expression.index, calls);
      visitHostCalls(expression.value, calls);
      return;
    case "textAppend":
    case "binary":
      visitHostCalls(expression.left, calls);
      visitHostCalls(expression.right, calls);
      return;
    case "ownership":
    case "return":
    case "comptime":
      visitHostCalls(expression.expression, calls);
      return;
    case "scratch":
      visitHostCalls(expression.body, calls);
      return;
    case "if":
      visitHostCalls(expression.condition, calls);
      visitHostCalls(expression.consequence, calls);
      visitHostCalls(expression.alternative, calls);
      return;
    case "ifUnion":
      visitHostCalls(expression.value, calls);
      visitHostCalls(expression.consequence, calls);
      visitHostCalls(expression.alternative, calls);
      return;
    case "block":
      for (const step of expression.steps) {
        visitHostCalls(
          step.kind === "binding" ? step.binding.value : step.expression,
          calls,
        );
      }
      visitHostCalls(expression.result, calls);
      return;
  }
}

function hostFunctionKey(effectName: string, operationName: string): string {
  return `${effectName}\u0000${operationName}`;
}

class DucklangFcgCompiler {
  readonly #file: string;
  readonly #shapes: ReadonlyMap<number, FunctionShape>;
  readonly #runtimePrimitives: ReadonlyMap<
    PrimitiveIdType,
    RuntimePrimitiveShape
  >;
  readonly #managedAggregates: ReadonlyMap<string, ManagedAggregateShape>;
  readonly #hostFunctions: ReadonlyMap<string, HostFunctionShape>;
  readonly #symbolTypes: ReadonlyMap<number, Type>;
  readonly #unionNames: ReadonlySet<string>;
  readonly #unionTags: ReadonlyMap<string, number>;
  readonly #textHandles: ReadonlyMap<string, number>;
  readonly #effectGlobals: ReadonlyMap<number, number>;
  readonly #locals = new Map<number, number>();
  readonly #localTypes: number[] = [];
  #nextLocal: number;

  constructor(
    file: string,
    shapes: ReadonlyMap<number, FunctionShape>,
    runtimePrimitives: ReadonlyMap<PrimitiveIdType, RuntimePrimitiveShape>,
    managedAggregates: ReadonlyMap<string, ManagedAggregateShape>,
    hostFunctions: ReadonlyMap<string, HostFunctionShape>,
    symbolTypes: ReadonlyMap<number, Type>,
    parameters: readonly { readonly id: number }[],
    unionNames: ReadonlySet<string>,
    unionTags: ReadonlyMap<string, number>,
    textHandles: ReadonlyMap<string, number>,
    effectGlobals: ReadonlyMap<number, number> = new Map(),
  ) {
    this.#file = file;
    this.#shapes = shapes;
    this.#runtimePrimitives = runtimePrimitives;
    this.#managedAggregates = managedAggregates;
    this.#hostFunctions = hostFunctions;
    this.#symbolTypes = symbolTypes;
    this.#unionNames = unionNames;
    this.#unionTags = unionTags;
    this.#textHandles = textHandles;
    this.#effectGlobals = effectGlobals;
    parameters.forEach((parameter, index) =>
      this.#locals.set(parameter.id, index)
    );
    this.#nextLocal = parameters.length;
  }

  /**
   * Compiles a body after performing each effectful module-level binding once and
   * storing it in its global. Used for `main` only.
   */
  compileWithPrologue(
    body: TypedDucklangExpression,
    prologue: readonly {
      readonly binding: TypedDucklangBinding;
      readonly global: number;
    }[],
  ): {
    readonly instructions: readonly DucklangFcgInstruction[];
    readonly localCount: number;
    readonly localTypes: readonly number[];
  } {
    const instructions: DucklangFcgInstruction[] = [];
    for (const entry of prologue) {
      instructions.push(...this.#compileExpression(entry.binding.value));
      instructions.push({
        kind: "globalSet",
        global: entry.global,
        span: entry.binding.span,
      });
    }
    const compiled = this.compile(body);
    return {
      ...compiled,
      instructions: [...instructions, ...compiled.instructions],
    };
  }

  compile(expression: TypedDucklangExpression): {
    readonly instructions: readonly DucklangFcgInstruction[];
    readonly localCount: number;
    readonly localTypes: readonly number[];
  } {
    const parameterCount = this.#nextLocal;
    const instructions = this.#compileExpression(expression);
    return {
      instructions,
      localCount: this.#nextLocal - parameterCount,
      localTypes: this.#localTypes,
    };
  }

  #compileExpression(
    expression: TypedDucklangExpression,
  ): readonly DucklangFcgInstruction[] {
    switch (expression.kind) {
      case "integer":
        return [{
          kind: "constant",
          value: expression.value,
          valueType: "i32",
          span: expression.span,
        }];
      case "integer64":
        return [{
          kind: "constant",
          value: expression.value,
          valueType: "i64",
          span: expression.span,
        }];
      case "float32":
        return [{
          kind: "constant",
          value: expression.value,
          valueType: "f32",
          span: expression.span,
        }];
      case "float64":
        return [{
          kind: "constant",
          value: expression.value,
          valueType: "f64",
          span: expression.span,
        }];
      case "boolean":
        return [{
          kind: "constant",
          value: expression.value ? 1 : 0,
          valueType: "i32",
          span: expression.span,
        }];
      case "unit":
        return [{
          kind: "constant",
          value: 0,
          valueType: "i32",
          span: expression.span,
        }];
      case "string": {
        const handle = this.#textHandles.get(expression.value);
        if (handle === undefined) {
          throw new Error(
            `${this.#file}:${expression.span.start}: missing Ducklang text handle for ${
              JSON.stringify(expression.value)
            }`,
          );
        }
        return [{
          kind: "constant",
          value: handle,
          valueType: "i32",
          span: expression.span,
        }];
      }
      case "intrinsic":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang intrinsic ${expression.modulePath}.${expression.exportName} reached FCG without intrinsic lowering`,
        );
      case "primitive":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang primitive ${
            primitiveDescriptor(expression.primitiveId).name
          } reached FCG without primitive lowering`,
        );
      case "hostCall": {
        const shape = this.#hostFunctions.get(
          hostFunctionKey(expression.effectName, expression.operationName),
        );
        if (shape === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang FCG has no host operation ${expression.effectName}.${expression.operationName}`,
          );
        }
        return [
          ...expression.arguments.flatMap((argument) =>
            this.#compileExpression(argument)
          ),
          {
            kind: "call",
            functionIndex: shape.index,
            functionName: shape.name,
            span: expression.span,
          },
        ];
      }
      case "optionDo":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: dynamic Ducklang do requires handler lowering`,
        );
      case "unionCase": {
        const tag = this.#unionTags.get(
          `${expression.unionName}.${expression.caseName}`,
        );
        if (tag === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang union constructor ${expression.unionName}.${expression.caseName} has no layout tag`,
          );
        }
        return this.#compileManagedAggregateCall(
          managedSumMakeImportName(tag),
          [expression.value],
          expression.span,
        );
      }
      case "product":
        return this.#compileManagedAggregateCall(
          managedProductMakeImportName(expression.values.length),
          expression.values,
          expression.span,
        );
      case "project":
        return this.#compileManagedAggregateCall(
          managedProductProjectImportName(expression.index),
          [expression.product],
          expression.span,
        );
      case "recordUpdate":
        return this.#compileManagedAggregateCall(
          managedProductUpdateImportName(
            expression.fields.map((field) => field.index),
          ),
          [
            expression.product,
            ...expression.fields.map((field) => field.value),
          ],
          expression.span,
        );
      case "indexUpdate":
        return isBufferType(expression.product.type)
          ? this.#compileRuntimePrimitiveCall(
            PrimitiveId.bufferSet,
            [expression.product, expression.index, expression.value],
            expression.span,
          )
          : this.#compileManagedAggregateCall(
            managedProductIndexUpdateImportName,
            [expression.product, expression.index, expression.value],
            expression.span,
          );
      case "reference": {
        const local = this.#locals.get(expression.symbol.id);
        if (local !== undefined) {
          return [{ kind: "localGet", local, span: expression.span }];
        }
        // An effectful module-level binding lives in a global that a prologue
        // computed once. Falling through to the shape call would re-perform its
        // effect at every read, and every function reads it from the same global.
        const global = this.#effectGlobals.get(expression.symbol.id);
        if (global !== undefined) {
          return [{ kind: "globalGet", global, span: expression.span }];
        }
        const shape = this.#shapes.get(expression.symbol.id);
        if (shape === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang FCG has no definition for ${expression.symbol.text}#${expression.symbol.id}`,
          );
        }
        if (shape.parameterCount !== 0) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: first-class Ducklang function ${expression.symbol.text} requires closure conversion`,
          );
        }
        return [{
          kind: "call",
          functionIndex: shape.index,
          functionName: shape.name,
          span: expression.span,
        }];
      }
      case "function":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: nested Ducklang function requires closure conversion`,
        );
      case "call": {
        if (
          expression.callee.kind === "primitive" &&
          expression.callee.primitiveId === PrimitiveId.panic &&
          expression.arguments.length === 0
        ) {
          return [{ kind: "trap", span: expression.span }];
        }
        if (
          expression.callee.kind === "primitive" &&
          expression.callee.primitiveId === PrimitiveId.bytesGenerate
        ) {
          return this.#compileStaticBytesGenerate(expression);
        }
        if (
          expression.callee.kind === "primitive" &&
          isIntegerConversion(expression.callee.primitiveId)
        ) {
          return [
            ...expression.arguments.flatMap((argument) =>
              this.#compileExpression(argument)
            ),
            {
              kind: "integerConversion",
              primitiveId: expression.callee.primitiveId,
              span: expression.span,
            },
          ];
        }
        if (
          expression.callee.kind === "primitive" &&
          isWasmNumericPrimitive(expression.callee.primitiveId)
        ) {
          return [
            ...expression.arguments.flatMap((argument) =>
              this.#compileExpression(argument)
            ),
            {
              kind: "numericPrimitive",
              primitiveId: expression.callee.primitiveId,
              valueType: wasmScalarTypeName(
                this.#file,
                expression.span,
                expression.arguments[0]?.type ?? expression.type,
                this.#unionNames,
              ),
              span: expression.span,
            },
          ];
        }
        if (expression.callee.kind === "primitive") {
          const shape = this.#runtimePrimitives.get(
            expression.callee.primitiveId,
          );
          if (shape === undefined) {
            throw new TypeError(
              `${this.#file}:${expression.span.start}: Ducklang primitive ${
                primitiveDescriptor(expression.callee.primitiveId).name
              } has no runtime lowering`,
            );
          }
          return [
            ...expression.arguments.flatMap((argument) =>
              this.#compileExpression(argument)
            ),
            {
              kind: "call",
              functionIndex: shape.index,
              functionName: shape.name,
              span: expression.span,
            },
          ];
        }
        if (expression.callee.kind !== "reference") {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang FCG supports direct calls only; received ${expression.callee.kind}`,
          );
        }
        const shape = this.#shapes.get(expression.callee.symbol.id);
        if (shape === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: unknown Ducklang callee ${expression.callee.symbol.text}#${expression.callee.symbol.id}`,
          );
        }
        if (shape.parameterCount !== expression.arguments.length) {
          const parameterNames = shape.binding?.value.kind === "function"
            ? shape.binding.value.parameters.map((parameter) => parameter.text)
              .join(", ")
            : "";
          throw new TypeError(
            `${this.#file}:${expression.span.start}: ${expression.callee.symbol.text} expects ${shape.parameterCount} arguments (${parameterNames}); received ${expression.arguments.length} (${
              expression.arguments.map((argument) =>
                formatDucklangType(argument.type)
              ).join(", ")
            })`,
          );
        }
        return [
          ...expression.arguments.flatMap((argument) =>
            this.#compileExpression(argument)
          ),
          {
            kind: "call",
            functionIndex: shape.index,
            functionName: shape.name,
            span: expression.span,
          },
        ];
      }
      case "index":
        return isBufferType(expression.collection.type)
          ? this.#compileRuntimePrimitiveCall(
            PrimitiveId.bufferGet,
            [expression.collection, expression.index],
            expression.span,
          )
          : this.#compileManagedAggregateCall(
            managedProductIndexImportName,
            [expression.collection, expression.index],
            expression.span,
          );
      case "selectProductElement": {
        const indexLocal = this.#allocateLocal(wasmType.i32);
        const resultType = wasmScalarTypeName(
          this.#file,
          expression.span,
          expression.type,
          this.#unionNames,
        );
        const compileSelection = (
          fieldIndex: number,
        ): readonly DucklangFcgInstruction[] => {
          const value = expression.values[fieldIndex];
          if (value === undefined) {
            return [{ kind: "trap", span: expression.span }];
          }
          return [
            { kind: "localGet", local: indexLocal, span: expression.span },
            {
              kind: "constant",
              value: fieldIndex,
              valueType: "i32",
              span: expression.span,
            },
            {
              kind: "binary",
              operator: "==",
              valueType: "i32",
              span: expression.span,
            },
            {
              kind: "if",
              resultType,
              consequence: this.#compileExpression(value),
              alternative: compileSelection(fieldIndex + 1),
              span: expression.span,
            },
          ];
        };
        return [
          ...this.#compileExpression(expression.index),
          { kind: "localSet", local: indexLocal, span: expression.span },
          ...compileSelection(0),
        ];
      }
      case "textAppend":
        return [
          ...this.#compileExpression(expression.left),
          ...this.#compileExpression(expression.right),
          {
            kind: "call",
            functionIndex: this.#requireRuntimePrimitive(
              PrimitiveId.bufferAppend,
              expression.span,
            ).index,
            functionName: primitiveRuntimeImportName(PrimitiveId.bufferAppend),
            span: expression.span,
          },
        ];
      case "binary":
        if (
          (expression.operator === "==" || expression.operator === "!=") &&
          expression.left.type.kind === "constructor" &&
          expression.left.type.name === "text"
        ) {
          return [
            ...this.#compileExpression(expression.left),
            ...this.#compileExpression(expression.right),
            {
              kind: "call",
              functionIndex: this.#requireRuntimePrimitive(
                PrimitiveId.bufferEqual,
                expression.span,
              ).index,
              functionName: primitiveRuntimeImportName(
                PrimitiveId.bufferEqual,
              ),
              span: expression.span,
            },
            ...(expression.operator === "==" ? [] : [
              {
                kind: "constant" as const,
                value: 0,
                valueType: "i32" as const,
                span: expression.span,
              },
              {
                kind: "binary" as const,
                operator: "==" as const,
                valueType: "i32" as const,
                span: expression.span,
              },
            ]),
          ];
        }
        return [
          ...this.#compileExpression(expression.left),
          ...this.#compileExpression(expression.right),
          {
            kind: "binary",
            operator: expression.operator,
            valueType: wasmScalarTypeName(
              this.#file,
              expression.left.span,
              expression.left.type,
              this.#unionNames,
            ),
            span: expression.span,
          },
        ];
      case "ownership":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang ${expression.operation} reached FCG without ownership lowering`,
        );
      case "return":
        return [
          ...this.#compileExpression(expression.expression),
          { kind: "return", span: expression.span },
        ];
      case "if":
        return [
          ...this.#compileExpression(expression.condition),
          {
            kind: "if",
            resultType: wasmScalarTypeName(
              this.#file,
              expression.span,
              expression.type,
              this.#unionNames,
            ),
            consequence: this.#compileExpression(expression.consequence),
            alternative: this.#compileExpression(expression.alternative),
            span: expression.span,
          },
        ];
      case "ifUnion": {
        const tag = this.#unionTags.get(
          `${expression.unionName}.${expression.caseName}`,
        );
        if (tag === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang union pattern ${expression.unionName}.${expression.caseName} has no layout tag`,
          );
        }
        const unionLocal = this.#allocateLocal(wasmType.i32);
        const payloadLocal = expression.payloadSymbol === undefined
          ? undefined
          : this.#allocateLocal(
            wasmValueType(
              this.#file,
              expression.payloadSymbol.span,
              this.#requireSymbolType(expression.payloadSymbol),
              this.#unionNames,
            ),
          );
        if (
          payloadLocal !== undefined && expression.payloadSymbol !== undefined
        ) {
          this.#locals.set(expression.payloadSymbol.id, payloadLocal);
        }
        const consequence = [
          ...(payloadLocal === undefined ||
              expression.payloadSymbol === undefined
            ? []
            : [
              {
                kind: "localGet",
                local: unionLocal,
                span: expression.value.span,
              } as const,
              {
                kind: "call",
                functionIndex: this.#requireManagedAggregate(
                  managedSumPayloadImportName(
                    isI64(this.#requireSymbolType(expression.payloadSymbol))
                      ? "i64"
                      : "i32",
                  ),
                  expression.span,
                ).index,
                functionName: managedSumPayloadImportName(
                  isI64(this.#requireSymbolType(expression.payloadSymbol))
                    ? "i64"
                    : "i32",
                ),
                span: expression.span,
              } as const,
              {
                kind: "localSet",
                local: payloadLocal,
                span: expression.span,
              } as const,
            ]),
          ...this.#compileExpression(expression.consequence),
        ];
        if (expression.payloadSymbol !== undefined) {
          this.#locals.delete(expression.payloadSymbol.id);
        }
        return [
          ...this.#compileExpression(expression.value),
          { kind: "localSet", local: unionLocal, span: expression.value.span },
          { kind: "localGet", local: unionLocal, span: expression.value.span },
          {
            kind: "call",
            functionIndex: this.#requireManagedAggregate(
              managedSumTagImportName,
              expression.span,
            ).index,
            functionName: managedSumTagImportName,
            span: expression.span,
          },
          {
            kind: "constant",
            value: tag,
            valueType: "i32",
            span: expression.span,
          },
          {
            kind: "binary",
            operator: "==",
            valueType: "i32",
            span: expression.span,
          },
          {
            kind: "if",
            resultType: wasmScalarTypeName(
              this.#file,
              expression.span,
              expression.type,
              this.#unionNames,
            ),
            consequence,
            alternative: this.#compileExpression(expression.alternative),
            span: expression.span,
          },
        ];
      }
      case "block": {
        const previousLocals = new Map(this.#locals);
        const instructions: DucklangFcgInstruction[] = [];
        for (const step of expression.steps) {
          if (step.kind === "expression") {
            instructions.push(...this.#compileExpression(step.expression));
            instructions.push({ kind: "drop", span: step.expression.span });
            continue;
          }
          const binding = step.binding;
          if (binding.value.kind === "function") {
            throw new TypeError(
              `${this.#file}:${binding.span.start}: local Ducklang function ${binding.symbol.text} requires closure conversion`,
            );
          }
          instructions.push(...this.#compileExpression(binding.value));
          const local = this.#allocateLocal(
            wasmValueType(
              this.#file,
              binding.span,
              binding.type,
              this.#unionNames,
            ),
          );
          this.#locals.set(binding.symbol.id, local);
          instructions.push({ kind: "localSet", local, span: binding.span });
        }
        instructions.push(...this.#compileExpression(expression.result));
        this.#locals.clear();
        for (const [symbol, local] of previousLocals) {
          this.#locals.set(symbol, local);
        }
        return instructions;
      }
      case "comptime":
        throw new Error(
          `${this.#file}:${expression.span.start}: Ducklang comptime reached FCG without evaluation`,
        );
      case "scratch":
        throw new Error(
          `${this.#file}:${expression.span.start}: Ducklang scratch region reached FCG without region lowering`,
        );
    }
  }

  #requireRuntimePrimitive(
    primitiveId: PrimitiveIdType,
    span: SourceSpan,
  ): RuntimePrimitiveShape {
    const shape = this.#runtimePrimitives.get(primitiveId);
    if (shape !== undefined) return shape;
    throw new Error(
      `${this.#file}:${span.start}: missing runtime lowering for Ducklang primitive ${
        primitiveDescriptor(primitiveId).name
      }`,
    );
  }

  #compileRuntimePrimitiveCall(
    primitiveId: PrimitiveIdType,
    arguments_: readonly TypedDucklangExpression[],
    span: SourceSpan,
  ): readonly DucklangFcgInstruction[] {
    const shape = this.#requireRuntimePrimitive(primitiveId, span);
    return [
      ...arguments_.flatMap((argument) => this.#compileExpression(argument)),
      {
        kind: "call",
        functionIndex: shape.index,
        functionName: shape.name,
        span,
      },
    ];
  }

  #compileManagedAggregateCall(
    name: string,
    arguments_: readonly TypedDucklangExpression[],
    span: SourceSpan,
  ): readonly DucklangFcgInstruction[] {
    const shape = this.#requireManagedAggregate(name, span);
    return [
      ...arguments_.flatMap((argument) => this.#compileExpression(argument)),
      {
        kind: "call",
        functionIndex: shape.index,
        functionName: shape.name,
        span,
      },
    ];
  }

  #compileStaticBytesGenerate(
    expression: Extract<TypedDucklangExpression, { readonly kind: "call" }>,
  ): readonly DucklangFcgInstruction[] {
    const length = expression.arguments[0];
    const generator = expression.arguments[1];
    if (length?.kind !== "integer") {
      throw new TypeError(
        `${this.#file}:${expression.span.start}: dynamic Ducklang bytes.generate length is ${
          length?.kind ?? "missing"
        }; expected a specialized integer`,
      );
    }
    if (length.value < 0 || length.value > 65_536) {
      throw new RangeError(
        `${this.#file}:${length.span.start}: static Ducklang bytes.generate length ${length.value} is outside 0..65536`,
      );
    }
    let restoreGeneratorParameter = (): void => {};
    let compileGeneratedByte: (
      index: number,
    ) => readonly DucklangFcgInstruction[];
    if (generator?.kind === "function" && generator.parameters.length === 1) {
      const parameter = generator.parameters[0];
      const previousLocal = this.#locals.get(parameter.id);
      const parameterLocal = this.#allocateLocal(wasmType.i32);
      this.#locals.set(parameter.id, parameterLocal);
      restoreGeneratorParameter = () => {
        if (previousLocal === undefined) this.#locals.delete(parameter.id);
        else this.#locals.set(parameter.id, previousLocal);
      };
      compileGeneratedByte = (index) => [
        {
          kind: "constant",
          value: index,
          valueType: "i32",
          span: expression.span,
        },
        { kind: "localSet", local: parameterLocal, span: expression.span },
        ...this.#compileExpression(generator.body),
      ];
    } else if (generator?.kind === "reference") {
      const generatorShape = this.#shapes.get(generator.symbol.id);
      if (generatorShape === undefined || generatorShape.parameterCount !== 1) {
        throw new TypeError(
          `${this.#file}:${generator.span.start}: bytes.generate requires a direct single-argument generator`,
        );
      }
      compileGeneratedByte = (index) => [
        {
          kind: "constant",
          value: index,
          valueType: "i32",
          span: expression.span,
        },
        {
          kind: "call",
          functionIndex: generatorShape.index,
          functionName: generatorShape.name,
          span: generator.span,
        },
      ];
    } else {
      throw new TypeError(
        `${this.#file}:${expression.span.start}: dynamic Ducklang bytes.generate generator is ${
          generator?.kind ?? "missing"
        }; expected a direct function`,
      );
    }

    const instructions: DucklangFcgInstruction[] = [];
    if (length.value <= 512) {
      for (let index = 0; index < length.value; index += 1) {
        instructions.push(...compileGeneratedByte(index));
      }
      const shape = this.#requireManagedAggregate(
        managedBytesMakeImportName(length.value),
        expression.span,
      );
      instructions.push({
        kind: "call",
        functionIndex: shape.index,
        functionName: shape.name,
        span: expression.span,
      });
    } else {
      const bufferLocal = this.#allocateLocal(wasmType.i32);
      const fillShape = this.#requireRuntimePrimitive(
        PrimitiveId.bytesFill,
        expression.span,
      );
      const setShape = this.#requireRuntimePrimitive(
        PrimitiveId.bufferSet,
        expression.span,
      );
      instructions.push(
        {
          kind: "constant",
          value: length.value,
          valueType: "i32",
          span: expression.span,
        },
        {
          kind: "constant",
          value: 0,
          valueType: "i32",
          span: expression.span,
        },
        {
          kind: "call",
          functionIndex: fillShape.index,
          functionName: fillShape.name,
          span: expression.span,
        },
        { kind: "localSet", local: bufferLocal, span: expression.span },
      );
      for (let index = 0; index < length.value; index += 1) {
        instructions.push(
          { kind: "localGet", local: bufferLocal, span: expression.span },
          {
            kind: "constant",
            value: index,
            valueType: "i32",
            span: expression.span,
          },
          ...compileGeneratedByte(index),
          {
            kind: "call",
            functionIndex: setShape.index,
            functionName: setShape.name,
            span: expression.span,
          },
          { kind: "localSet", local: bufferLocal, span: expression.span },
        );
      }
      instructions.push({
        kind: "localGet",
        local: bufferLocal,
        span: expression.span,
      });
    }
    restoreGeneratorParameter();
    return instructions;
  }

  #requireManagedAggregate(
    name: string,
    span: SourceSpan,
  ): ManagedAggregateShape {
    const shape = this.#managedAggregates.get(name);
    if (shape !== undefined) return shape;
    throw new Error(
      `${this.#file}:${span.start}: missing managed Ducklang aggregate operation ${name}`,
    );
  }

  #requireSymbolType(
    symbol: {
      readonly id: number;
      readonly text: string;
      readonly span: SourceSpan;
    },
  ): Type {
    const type = this.#symbolTypes.get(symbol.id);
    if (type !== undefined) return type;
    throw new Error(
      `${this.#file}:${symbol.span.start}: missing type for Ducklang symbol ${symbol.text}#${symbol.id}`,
    );
  }

  #allocateLocal(type: number): number {
    const local = this.#nextLocal;
    this.#nextLocal += 1;
    this.#localTypes.push(type);
    return local;
  }
}

function acceptedDucklangRewritesByFunction(
  functions: readonly FcgFunction[],
  accepted: readonly FlatFcgRewriteProposal[],
): ReadonlyMap<number, ReadonlySet<string>> {
  const acceptedByFunction = new Map<number, Set<string>>();
  const operationStarts: number[] = [];
  let operationStart = 0;
  for (const function_ of functions) {
    operationStarts.push(operationStart);
    operationStart += function_.operations.length;
  }
  for (const proposal of accepted) {
    const relativeOperationIndex = proposal.operationStart -
      operationStarts[proposal.functionIndex] + proposal.operationCount - 1;
    const operation =
      functions[proposal.functionIndex].operations[relativeOperationIndex];
    const rewrites = acceptedByFunction.get(proposal.functionIndex) ??
      new Set<string>();
    rewrites.add(`${proposal.rule}:${operation.sourceStart}`);
    acceptedByFunction.set(proposal.functionIndex, rewrites);
  }
  return acceptedByFunction;
}

function optimizeDucklangInstructions(
  instructions: readonly DucklangFcgInstruction[],
  acceptedRewrites: ReadonlySet<string>,
): readonly DucklangFcgInstruction[] {
  const nestedOptimized = instructions.map((instruction) => {
    if (instruction.kind !== "if" && instruction.kind !== "unionMatch") {
      return instruction;
    }
    return {
      ...instruction,
      consequence: optimizeDucklangInstructions(
        instruction.consequence,
        acceptedRewrites,
      ),
      alternative: optimizeDucklangInstructions(
        instruction.alternative,
        acceptedRewrites,
      ),
    };
  });
  const optimized: DucklangFcgInstruction[] = [];
  for (let index = 0; index < nestedOptimized.length; index += 1) {
    const instruction = nestedOptimized[index];
    const next = nestedOptimized[index + 1];
    if (
      instruction.kind === "constant" && next?.kind === "binary" &&
      ((next.operator === "+" &&
        (instruction.value === 0 || instruction.value === 0n) &&
        acceptedRewrites.has(`addZero:${next.span.start}`)) ||
        (next.operator === "*" &&
          (instruction.value === 1 || instruction.value === 1n) &&
          acceptedRewrites.has(`multiplyOne:${next.span.start}`)))
    ) {
      index += 1;
      continue;
    }
    if (
      instruction.kind === "localGet" && next?.kind === "localSet" &&
      instruction.local === next.local &&
      acceptedRewrites.has(`selfLocalAssignment:${next.span.start}`)
    ) {
      index += 1;
      continue;
    }
    optimized.push(instruction);
  }
  return optimized;
}

function emitInstructions(
  instructions: readonly DucklangFcgInstruction[],
): readonly WasmInstruction[] {
  return instructions.flatMap((instruction): readonly WasmInstruction[] => {
    switch (instruction.kind) {
      case "constant":
        if (instruction.valueType === "i64") {
          return wasmInstruction.i64Constant(instruction.value as bigint);
        }
        if (instruction.valueType === "f32") {
          return wasmInstruction.f32Constant(instruction.value as number);
        }
        if (instruction.valueType === "f64") {
          return wasmInstruction.f64Constant(instruction.value as number);
        }
        return wasmInstruction.i32Constant(instruction.value as number);
      case "localGet":
        return wasmInstruction.localGet(instruction.local);
      case "localSet":
        return wasmInstruction.localSet(instruction.local);
      case "globalGet":
        return wasmInstruction.globalGet(instruction.global);
      case "globalSet":
        return wasmInstruction.globalSet(instruction.global);
      case "call":
        return wasmInstruction.call(instruction.functionIndex);
      case "return":
        return wasmInstruction.return;
      case "drop":
        return wasmInstruction.drop;
      case "trap":
        return wasmInstruction.unreachable;
      case "binary":
        if (instruction.valueType === "f32") {
          const operation: Partial<
            Record<DucklangBinaryOperator, readonly WasmInstruction[]>
          > = {
            "+": wasmInstruction.f32Add,
            "-": wasmInstruction.f32Subtract,
            "*": wasmInstruction.f32Multiply,
            "/": wasmInstruction.f32Divide,
            "==": wasmInstruction.f32Equal,
            "!=": wasmInstruction.f32NotEqual,
            "<": wasmInstruction.f32LessThan,
            "<=": wasmInstruction.f32LessThanOrEqual,
            ">": wasmInstruction.f32GreaterThan,
            ">=": wasmInstruction.f32GreaterThanOrEqual,
          };
          const emitted = operation[instruction.operator];
          if (emitted !== undefined) return emitted;
          throw new TypeError(
            `${instruction.span.file}:${instruction.span.start}: Ducklang operator ${instruction.operator} has no f32 Wasm instruction`,
          );
        }
        if (instruction.valueType === "f64") {
          const operation: Partial<
            Record<DucklangBinaryOperator, readonly WasmInstruction[]>
          > = {
            "+": wasmInstruction.f64Add,
            "-": wasmInstruction.f64Subtract,
            "*": wasmInstruction.f64Multiply,
            "/": wasmInstruction.f64Divide,
            "==": wasmInstruction.f64Equal,
            "!=": wasmInstruction.f64NotEqual,
            "<": wasmInstruction.f64LessThan,
            "<=": wasmInstruction.f64LessThanOrEqual,
            ">": wasmInstruction.f64GreaterThan,
            ">=": wasmInstruction.f64GreaterThanOrEqual,
          };
          const emitted = operation[instruction.operator];
          if (emitted !== undefined) return emitted;
          throw new TypeError(
            `${instruction.span.file}:${instruction.span.start}: Ducklang operator ${instruction.operator} has no f64 Wasm instruction`,
          );
        }
        if (instruction.valueType === "i64") {
          return {
            "+": wasmInstruction.i64Add,
            "-": wasmInstruction.i64Subtract,
            "*": wasmInstruction.i64Multiply,
            "/": wasmInstruction.i64DivideSigned,
            "%": wasmInstruction.i64RemainderSigned,
            "==": wasmInstruction.i64Equal,
            "!=": wasmInstruction.i64NotEqual,
            "<": wasmInstruction.i64LessThanSigned,
            "<=": wasmInstruction.i64LessThanOrEqualSigned,
            ">": wasmInstruction.i64GreaterThanSigned,
            ">=": wasmInstruction.i64GreaterThanOrEqualSigned,
            "&&": wasmInstruction.i32And,
            "||": wasmInstruction.i32Or,
          }[instruction.operator];
        }
        return {
          "+": wasmInstruction.i32Add,
          "-": wasmInstruction.i32Subtract,
          "*": wasmInstruction.i32Multiply,
          "/": wasmInstruction.i32DivideSigned,
          "%": wasmInstruction.i32RemainderSigned,
          "==": wasmInstruction.i32Equal,
          "!=": wasmInstruction.i32NotEqual,
          "<": wasmInstruction.i32LessThanSigned,
          "<=": wasmInstruction.i32LessThanOrEqualSigned,
          ">": wasmInstruction.i32GreaterThanSigned,
          ">=": wasmInstruction.i32GreaterThanOrEqualSigned,
          "&&": wasmInstruction.i32And,
          "||": wasmInstruction.i32Or,
        }[instruction.operator];
      case "numericPrimitive":
        return emitNumericPrimitive(instruction);
      case "integerConversion":
        return {
          [PrimitiveId.i32WrapI64]: wasmInstruction.i32WrapI64,
          [PrimitiveId.i64ExtendI32Signed]: wasmInstruction.i64ExtendI32Signed,
          [PrimitiveId.i64ExtendI32Unsigned]:
            wasmInstruction.i64ExtendI32Unsigned,
        }[instruction.primitiveId];
      case "unionPack":
        return [
          ...wasmInstruction.i64ExtendI32Unsigned,
          ...wasmInstruction.i64Constant(BigInt(instruction.tag) << 32n),
          ...wasmInstruction.i64Or,
        ];
      case "unionMatch":
        return [
          ...wasmInstruction.localGet(instruction.unionLocal),
          ...wasmInstruction.i64Constant(32n),
          ...wasmInstruction.i64ShiftRightUnsigned,
          ...wasmInstruction.i32WrapI64,
          ...wasmInstruction.i32Constant(instruction.tag),
          ...wasmInstruction.i32Equal,
          ...(instruction.resultType === "i64"
            ? wasmInstruction.ifI64
            : instruction.resultType === "f32"
            ? wasmInstruction.ifF32
            : instruction.resultType === "f64"
            ? wasmInstruction.ifF64
            : wasmInstruction.ifI32),
          ...(instruction.payloadLocal === undefined ? [] : [
            ...wasmInstruction.localGet(instruction.unionLocal),
            ...wasmInstruction.i32WrapI64,
            ...wasmInstruction.localSet(instruction.payloadLocal),
          ]),
          ...emitInstructions(instruction.consequence),
          ...wasmInstruction.else,
          ...emitInstructions(instruction.alternative),
          ...wasmInstruction.end,
        ];
      case "if":
        return [
          ...(instruction.resultType === "i64"
            ? wasmInstruction.ifI64
            : instruction.resultType === "f32"
            ? wasmInstruction.ifF32
            : instruction.resultType === "f64"
            ? wasmInstruction.ifF64
            : wasmInstruction.ifI32),
          ...emitInstructions(instruction.consequence),
          ...wasmInstruction.else,
          ...emitInstructions(instruction.alternative),
          ...wasmInstruction.end,
        ];
    }
  });
}

function emitNumericPrimitive(
  instruction: Extract<
    DucklangFcgInstruction,
    { readonly kind: "numericPrimitive" }
  >,
): readonly WasmInstruction[] {
  if (instruction.primitiveId === PrimitiveId.bitAnd) {
    return instruction.valueType === "i64"
      ? wasmInstruction.i64And
      : wasmInstruction.i32And;
  }
  if (instruction.primitiveId === PrimitiveId.bitOr) {
    return instruction.valueType === "i64"
      ? wasmInstruction.i64Or
      : wasmInstruction.i32Or;
  }
  if (instruction.primitiveId === PrimitiveId.bitXor) {
    return instruction.valueType === "i64"
      ? wasmInstruction.i64Xor
      : wasmInstruction.i32Xor;
  }
  if (instruction.primitiveId === PrimitiveId.shiftLeft) {
    return instruction.valueType === "i64"
      ? wasmInstruction.i64ShiftLeft
      : wasmInstruction.i32ShiftLeft;
  }
  if (instruction.primitiveId === PrimitiveId.shiftRightUnsigned) {
    return instruction.valueType === "i64"
      ? wasmInstruction.i64ShiftRightUnsigned
      : wasmInstruction.i32ShiftRightUnsigned;
  }
  if (instruction.primitiveId === PrimitiveId.f32SquareRoot) {
    return wasmInstruction.f32SquareRoot;
  }
  if (instruction.primitiveId === PrimitiveId.f32FromI32) {
    return wasmInstruction.f32ConvertI32Signed;
  }
  if (instruction.primitiveId === PrimitiveId.i32FromF32) {
    return wasmInstruction.i32TruncateF32Signed;
  }
  if (instruction.primitiveId === PrimitiveId.f64FromI32) {
    return wasmInstruction.f64ConvertI32Signed;
  }
  if (instruction.primitiveId === PrimitiveId.i32FromF64) {
    return wasmInstruction.i32TruncateF64Signed;
  }
  throw new TypeError(
    `${instruction.span.file}:${instruction.span.start}: Ducklang numeric primitive ${
      primitiveDescriptor(instruction.primitiveId).name
    } has no Wasm instruction`,
  );
}

function publicFunction(function_: DucklangFcgFunction): FcgFunction {
  const regions = { nextRegionId: 1 };
  return {
    name: function_.name,
    parameters: function_.parameterNames,
    localCount: function_.localCount,
    operations: publicOperations(function_.instructions, 0, regions),
  };
}

function publicOperations(
  instructions: readonly DucklangFcgInstruction[],
  regionId: number,
  regions: { nextRegionId: number },
): readonly FcgOperation[] {
  return instructions.flatMap((instruction): readonly FcgOperation[] => {
    const sourceStart = instruction.span.start;
    const operation = (
      opcode: string,
      operands: readonly (number | string)[],
    ): FcgOperation => ({ opcode, operands, sourceStart, regionId });
    const nestedRegion = (): number => {
      const nestedRegionId = regions.nextRegionId;
      regions.nextRegionId += 1;
      return nestedRegionId;
    };
    switch (instruction.kind) {
      case "constant":
        return [
          operation(
            instruction.valueType === "i32"
              ? "const"
              : `${instruction.valueType}.const`,
            [
              typeof instruction.value === "bigint"
                ? instruction.value.toString()
                : instruction.valueType === "f32" ||
                    instruction.valueType === "f64"
                ? instruction.value.toString()
                : instruction.value,
            ],
          ),
        ];
      case "localGet":
        return [operation("local.get", [instruction.local])];
      case "localSet":
        return [operation("local.set", [instruction.local])];
      case "globalGet":
        return [operation("global.get", [instruction.global])];
      case "globalSet":
        return [operation("global.set", [instruction.global])];
      case "call":
        return [operation("call", [instruction.functionName])];
      case "return":
        return [operation("return", [])];
      case "drop":
        return [operation("drop", [])];
      case "trap":
        return [operation("trap", [])];
      case "binary":
        return [
          operation(`${instruction.valueType}.${instruction.operator}`, []),
        ];
      case "numericPrimitive":
      case "integerConversion":
        return [
          operation(
            primitiveDescriptor(instruction.primitiveId).lowering,
            [],
          ),
        ];
      case "unionPack":
        return [operation("union.pack", [instruction.tag])];
      case "unionMatch": {
        const consequenceRegionId = nestedRegion();
        const alternativeRegionId = nestedRegion();
        return [
          operation("union.match", [instruction.tag]),
          ...publicOperations(
            instruction.consequence,
            consequenceRegionId,
            regions,
          ),
          ...publicOperations(
            instruction.alternative,
            alternativeRegionId,
            regions,
          ),
        ];
      }
      case "if": {
        const consequenceRegionId = nestedRegion();
        const alternativeRegionId = nestedRegion();
        return [
          operation("if", []),
          ...publicOperations(
            instruction.consequence,
            consequenceRegionId,
            regions,
          ),
          ...publicOperations(
            instruction.alternative,
            alternativeRegionId,
            regions,
          ),
        ];
      }
    }
  });
}

function wasmValueType(
  file: string,
  span: SourceSpan,
  type: Type,
  unionNames: ReadonlySet<string>,
): number {
  if (type.kind === "constructor" && type.arguments.length === 0) {
    if (type.name === "i64") return wasmType.i64;
    if (type.name === "f32") return wasmType.f32;
    if (type.name === "f64") return wasmType.f64;
    if (
      type.name === "i32" || type.name === "bool" || type.name === "unit" ||
      type.name === "text" || type.name === "bytes" || type.name === "Init"
    ) {
      return wasmType.i32;
    }
  }
  if (type.kind === "constructor" && unionNames.has(type.name)) {
    return wasmType.i32;
  }
  if (type.kind === "constructor") return wasmType.i32;
  throw new TypeError(
    `${file}:${span.start}: Ducklang Wasm backend cannot represent ${
      formatDucklangType(type)
    }`,
  );
}

function wasmScalarTypeName(
  file: string,
  span: SourceSpan,
  type: Type,
  unionNames: ReadonlySet<string>,
): WasmScalarTypeName {
  const wasmTypeId = wasmValueType(file, span, type, unionNames);
  if (wasmTypeId === wasmType.i64) return "i64";
  if (wasmTypeId === wasmType.f32) return "f32";
  if (wasmTypeId === wasmType.f64) return "f64";
  return "i32";
}

function isBufferType(type: Type): boolean {
  return type.kind === "constructor" &&
    (type.name === "text" || type.name === "bytes");
}

function isI64(type: Type): boolean {
  return type.kind === "constructor" && type.name === "i64" &&
    type.arguments.length === 0;
}

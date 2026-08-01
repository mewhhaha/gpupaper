import {
  type CoreBlockId,
  type CoreFunctionId,
  type CoreSignatureId,
  type CoreTypeId,
  type CoreValueId,
  type DucklangCoreBlock,
  type DucklangCoreFunction,
  type DucklangCoreModule,
  type DucklangCoreOperation,
  type DucklangCoreTerminator,
  type DucklangCoreType,
  validateDucklangCore,
} from "./ducklang_core.ts";
import {
  type DucklangCoreLayout,
  planDucklangCoreLayouts,
} from "./ducklang_layout.ts";
import type { PrimitiveId } from "./ducklang_primitives.ts";
import type { DucklangBinaryOperator } from "./ducklang_types.ts";
import type { SourceSpan } from "./syntax.ts";

export const flatDucklangCoreSchemaVersion = 2 as const;

export type FlatDucklangCore = {
  readonly schemaVersion: typeof flatDucklangCoreSchemaVersion;
  readonly entryFunctionId: number;
  readonly moduleFileId: number;

  readonly stringBytes: Uint8Array;
  readonly stringStarts: Uint32Array;
  readonly stringLengths: Uint32Array;

  readonly sourceLocationFileIds: Uint32Array;
  readonly sourceLocationStarts: Uint32Array;
  readonly sourceLocationEnds: Uint32Array;

  readonly typeKinds: Uint32Array;
  readonly typePayloadStarts: Uint32Array;
  readonly typePayloadCounts: Uint32Array;
  readonly typeAuxiliaries: Uint32Array;
  readonly typePayloads: Uint32Array;

  readonly signatureParameterStarts: Uint32Array;
  readonly signatureParameterCounts: Uint32Array;
  readonly signatureResultTypeIds: Uint32Array;
  readonly signatureParameterTypeIds: Uint32Array;

  readonly functionNameIds: Uint32Array;
  readonly functionSourceSymbolIds: Uint32Array;
  readonly functionSignatureIds: Uint32Array;
  readonly functionEntryBlockIds: Uint32Array;
  readonly functionBlockStarts: Uint32Array;
  readonly functionBlockCounts: Uint32Array;
  readonly functionSourceLocationIds: Uint32Array;

  readonly blockFunctionIds: Uint32Array;
  readonly blockLocalIds: Uint32Array;
  readonly blockParameterStarts: Uint32Array;
  readonly blockParameterCounts: Uint32Array;
  readonly blockOperationStarts: Uint32Array;
  readonly blockOperationCounts: Uint32Array;
  readonly blockTerminatorIds: Uint32Array;

  readonly blockParameterValueIds: Uint32Array;
  readonly blockParameterTypeIds: Uint32Array;
  readonly blockParameterSourceLocationIds: Uint32Array;

  readonly valueFunctionIds: Uint32Array;
  readonly valueLocalIds: Uint32Array;
  readonly valueTypeIds: Uint32Array;
  readonly valueDefinitionKinds: Uint32Array;
  readonly valueDefinitionIds: Uint32Array;

  readonly operationBlockIds: Uint32Array;
  readonly operationKinds: Uint32Array;
  readonly operationResultValueIds: Uint32Array;
  readonly operationTypeIds: Uint32Array;
  readonly operationOperandStarts: Uint32Array;
  readonly operationOperandCounts: Uint32Array;
  readonly operationAttributeStarts: Uint32Array;
  readonly operationAttributeCounts: Uint32Array;
  readonly operationSourceLocationIds: Uint32Array;
  readonly operandValueIds: Uint32Array;
  readonly attributeKinds: Uint32Array;
  readonly attributeLowWords: Uint32Array;
  readonly attributeHighWords: Uint32Array;

  readonly terminatorBlockIds: Uint32Array;
  readonly terminatorKinds: Uint32Array;
  readonly terminatorConditionValueIds: Uint32Array;
  readonly terminatorEdgeStarts: Uint32Array;
  readonly terminatorEdgeCounts: Uint32Array;
  readonly terminatorReturnStarts: Uint32Array;
  readonly terminatorReturnCounts: Uint32Array;
  readonly terminatorSourceLocationIds: Uint32Array;
  readonly returnValueIds: Uint32Array;

  readonly edgeTargetBlockIds: Uint32Array;
  readonly edgeArgumentStarts: Uint32Array;
  readonly edgeArgumentCounts: Uint32Array;
  readonly edgeSourceLocationIds: Uint32Array;
  readonly edgeArgumentValueIds: Uint32Array;

  readonly layoutKinds: Uint32Array;
  readonly layoutSizes: Uint32Array;
  readonly layoutAlignments: Uint32Array;
  readonly layoutComponentStarts: Uint32Array;
  readonly layoutComponentCounts: Uint32Array;
  readonly layoutTagOffsets: Uint32Array;
  readonly layoutTagSizes: Uint32Array;
  readonly layoutPayloadOffsets: Uint32Array;
  readonly layoutComponentIds: Uint32Array;
  readonly layoutComponentOffsets: Uint32Array;
  readonly typeLayoutIds: Uint32Array;
};

const trustedFlatDucklangCore = Symbol("trustedFlatDucklangCore");

export type TrustedFlatDucklangCore = {
  readonly package: FlatDucklangCore;
  readonly provenance: "construction" | "validation";
  readonly [trustedFlatDucklangCore]: true;
};

const absent = 0xffff_ffff;
const parameterDefinition = 0;
const operationDefinition = 1;

const typeKinds = [
  "scalar",
  "vector",
  "mask",
  "buffer",
  "product",
  "sum",
  "function",
] as const;
const scalarKinds = ["i32", "i64", "f32", "f64", "unit"] as const;
const vectorElementKinds = ["i32", "i64", "f32", "f64"] as const;
const bufferKinds = ["text", "bytes"] as const;
const operationKinds = [
  "constant",
  "scalar.binary",
  "primitive",
  "vector.shuffle",
  "product.make",
  "product.project",
  "product.update",
  "product.index",
  "product.index_update",
  "product.select",
  "sum.make",
  "sum.tag",
  "sum.payload",
  "call.direct",
  "closure.make",
  "call.indirect",
  "host.call",
  "resource.move",
  "resource.borrow",
  "resource.freeze",
  "resource.drop",
  "region.enter",
  "region.allocate",
  "region.exit",
] as const;
const binaryOperators: readonly DucklangBinaryOperator[] = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
];
const terminatorKinds = [
  "branch",
  "conditional_branch",
  "return",
  "trap",
] as const;
const layoutKinds = ["scalar", "handle", "product", "sum"] as const;
const attributeKinds = [
  "unsigned",
  "number",
  "bigint",
  "boolean",
  "string",
  "undefined",
] as const;

type AttributeKind = typeof attributeKinds[number];

export const FlatDucklangCoreKind = {
  type: {
    scalar: 0,
  },
  scalar: {
    i32: 0,
    i64: 1,
  },
  operation: {
    constant: 0,
    scalarBinary: 1,
  },
  attribute: {
    unsigned: 0,
    number: 1,
  },
  valueDefinition: {
    parameter: parameterDefinition,
    operation: operationDefinition,
  },
  binaryOperator: {
    add: 0,
    multiply: 2,
  },
} as const;

export function flattenDucklangCore(
  module: DucklangCoreModule,
): FlatDucklangCore {
  validateDucklangCore(module);
  const layouts = planDucklangCoreLayouts(module);
  const strings = collectStrings(module);
  const encodedStrings = encodeStrings(strings);
  const stringIds = new Map(strings.map((value, index) => [value, index]));

  const sourceLocations = collectSourceLocations(module);
  const sourceLocationIds = new Map(
    sourceLocations.map((span, index) => [sourceLocationKey(span), index]),
  );
  const sourceId = (span: SourceSpan): number => {
    const id = sourceLocationIds.get(sourceLocationKey(span));
    if (id !== undefined) return id;
    throw new Error(
      `${span.file}:${span.start}: source location was not collected`,
    );
  };

  const functionBlockStarts: number[] = [];
  const functionBlockCounts: number[] = [];
  let blockCount = 0;
  for (const function_ of module.functions) {
    functionBlockStarts.push(blockCount);
    functionBlockCounts.push(function_.blocks.length);
    blockCount += function_.blocks.length;
  }
  const globalBlockId = (functionId: number, localBlockId: number): number =>
    functionBlockStarts[functionId] + localBlockId;

  const blockParameterStarts: number[] = [];
  const blockParameterCounts: number[] = [];
  const blockOperationStarts: number[] = [];
  const blockOperationCounts: number[] = [];
  let parameterCount = 0;
  let operationCount = 0;
  for (const function_ of module.functions) {
    for (const block of function_.blocks) {
      blockParameterStarts.push(parameterCount);
      blockParameterCounts.push(block.parameters.length);
      parameterCount += block.parameters.length;
      blockOperationStarts.push(operationCount);
      blockOperationCounts.push(block.operations.length);
      operationCount += block.operations.length;
    }
  }

  const valueIds = new Map<string, number>();
  const valueFunctionIds: number[] = [];
  const valueLocalIds: number[] = [];
  const valueTypeIds: number[] = [];
  const valueDefinitionKinds: number[] = [];
  const valueDefinitionIds: number[] = [];
  const registerValue = (
    functionId: number,
    localValueId: number,
    typeId: number,
    definitionKind: number,
    definitionId: number,
  ): number => {
    const key = valueKey(functionId, localValueId);
    if (valueIds.has(key)) {
      throw new TypeError(
        `Core function ${functionId} defines local value ${localValueId} twice`,
      );
    }
    const id = valueFunctionIds.length;
    valueIds.set(key, id);
    valueFunctionIds.push(functionId);
    valueLocalIds.push(localValueId);
    valueTypeIds.push(typeId);
    valueDefinitionKinds.push(definitionKind);
    valueDefinitionIds.push(definitionId);
    return id;
  };
  for (const [functionId, function_] of module.functions.entries()) {
    for (const block of function_.blocks) {
      const flatBlockId = globalBlockId(functionId, block.id);
      const parameterStart = blockParameterStarts[flatBlockId];
      for (const [index, parameter] of block.parameters.entries()) {
        registerValue(
          functionId,
          parameter.value,
          parameter.type,
          parameterDefinition,
          parameterStart + index,
        );
      }
      const operationStart = blockOperationStarts[flatBlockId];
      for (const [index, operation] of block.operations.entries()) {
        registerValue(
          functionId,
          operation.result,
          operation.type,
          operationDefinition,
          operationStart + index,
        );
      }
    }
  }
  const globalValueId = (functionId: number, localValueId: number): number => {
    const id = valueIds.get(valueKey(functionId, localValueId));
    if (id !== undefined) return id;
    throw new TypeError(
      `Core function ${functionId} references undefined local value ${localValueId}`,
    );
  };

  const typePayloads: number[] = [];
  const typePayloadStarts: number[] = [];
  const typePayloadCounts: number[] = [];
  const typeAuxiliaries: number[] = [];
  for (const type of module.types) {
    typePayloadStarts.push(typePayloads.length);
    if (type.kind === "product") typePayloads.push(...type.fields);
    if (type.kind === "sum") typePayloads.push(...type.cases);
    typePayloadCounts.push(
      type.kind === "product"
        ? type.fields.length
        : type.kind === "sum"
        ? type.cases.length
        : 0,
    );
    typeAuxiliaries.push(typeAuxiliary(type));
  }

  const signatureParameterTypeIds: number[] = [];
  const signatureParameterStarts: number[] = [];
  const signatureParameterCounts: number[] = [];
  for (const signature of module.signatures) {
    signatureParameterStarts.push(signatureParameterTypeIds.length);
    signatureParameterCounts.push(signature.parameters.length);
    signatureParameterTypeIds.push(...signature.parameters);
  }

  const blockParameterValueIds: number[] = [];
  const blockParameterTypeIds: number[] = [];
  const blockParameterSourceLocationIds: number[] = [];
  const blockFunctionIds: number[] = [];
  const blockLocalIds: number[] = [];
  const blockTerminatorIds: number[] = [];
  const operationBlockIds: number[] = [];
  const operationKindIds: number[] = [];
  const operationResultValueIds: number[] = [];
  const operationTypeIds: number[] = [];
  const operationOperandStarts: number[] = [];
  const operationOperandCounts: number[] = [];
  const operationAttributeStarts: number[] = [];
  const operationAttributeCounts: number[] = [];
  const operationSourceLocationIds: number[] = [];
  const operandValueIds: number[] = [];
  const attributeKindIds: number[] = [];
  const attributeLowWords: number[] = [];
  const attributeHighWords: number[] = [];
  const terminatorBlockIds: number[] = [];
  const terminatorKindIds: number[] = [];
  const terminatorConditionValueIds: number[] = [];
  const terminatorEdgeStarts: number[] = [];
  const terminatorEdgeCounts: number[] = [];
  const terminatorReturnStarts: number[] = [];
  const terminatorReturnCounts: number[] = [];
  const terminatorSourceLocationIds: number[] = [];
  const returnValueIds: number[] = [];
  const edgeTargetBlockIds: number[] = [];
  const edgeArgumentStarts: number[] = [];
  const edgeArgumentCounts: number[] = [];
  const edgeSourceLocationIds: number[] = [];
  const edgeArgumentValueIds: number[] = [];

  const pushAttribute = (
    kind: AttributeKind,
    lowWord: number,
    highWord = 0,
  ): void => {
    attributeKindIds.push(requiredKindId(attributeKinds, kind, "attribute"));
    attributeLowWords.push(lowWord >>> 0);
    attributeHighWords.push(highWord >>> 0);
  };
  const pushUnsigned = (value: number): void =>
    pushAttribute("unsigned", unsignedWord(value, "Core attribute"));
  const pushString = (value: string): void =>
    pushAttribute("string", requiredStringId(stringIds, value));

  for (const [functionId, function_] of module.functions.entries()) {
    for (const block of function_.blocks) {
      const flatBlockId = globalBlockId(functionId, block.id);
      blockFunctionIds.push(functionId);
      blockLocalIds.push(block.id);
      blockTerminatorIds.push(terminatorKindIds.length);
      for (const parameter of block.parameters) {
        blockParameterValueIds.push(
          globalValueId(functionId, parameter.value),
        );
        blockParameterTypeIds.push(parameter.type);
        blockParameterSourceLocationIds.push(sourceId(parameter.span));
      }
      for (const operation of block.operations) {
        operationBlockIds.push(flatBlockId);
        operationKindIds.push(
          requiredKindId(operationKinds, operation.kind, "operation"),
        );
        operationResultValueIds.push(
          globalValueId(functionId, operation.result),
        );
        operationTypeIds.push(operation.type);
        operationOperandStarts.push(operandValueIds.length);
        operationOperandCounts.push(operation.operands.length);
        operandValueIds.push(
          ...operation.operands.map((value) =>
            globalValueId(functionId, value)
          ),
        );
        operationAttributeStarts.push(attributeKindIds.length);
        appendOperationAttributes(
          operation,
          pushAttribute,
          pushUnsigned,
          pushString,
        );
        operationAttributeCounts.push(
          attributeKindIds.length -
            operationAttributeStarts.at(-1)!,
        );
        operationSourceLocationIds.push(sourceId(operation.span));
      }

      const terminator = block.terminator;
      terminatorBlockIds.push(flatBlockId);
      terminatorKindIds.push(
        requiredKindId(terminatorKinds, terminator.kind, "terminator"),
      );
      terminatorConditionValueIds.push(
        terminator.kind === "conditional_branch"
          ? globalValueId(functionId, terminator.condition)
          : absent,
      );
      terminatorEdgeStarts.push(edgeTargetBlockIds.length);
      const edges = terminatorEdges(terminator);
      terminatorEdgeCounts.push(edges.length);
      for (const edge of edges) {
        edgeTargetBlockIds.push(
          globalBlockId(functionId, edge.target),
        );
        edgeArgumentStarts.push(edgeArgumentValueIds.length);
        edgeArgumentCounts.push(edge.arguments.length);
        edgeArgumentValueIds.push(
          ...edge.arguments.map((value) => globalValueId(functionId, value)),
        );
        edgeSourceLocationIds.push(sourceId(terminator.span));
      }
      terminatorReturnStarts.push(returnValueIds.length);
      const returned = terminator.kind === "return" ? terminator.values : [];
      terminatorReturnCounts.push(returned.length);
      returnValueIds.push(
        ...returned.map((value) => globalValueId(functionId, value)),
      );
      terminatorSourceLocationIds.push(sourceId(terminator.span));
    }
  }

  const flatLayouts = flattenLayouts(layouts.layouts);
  return {
    schemaVersion: flatDucklangCoreSchemaVersion,
    entryFunctionId: module.entryFunction,
    moduleFileId: requiredStringId(stringIds, module.file),
    stringBytes: encodedStrings.bytes,
    stringStarts: new Uint32Array(encodedStrings.starts),
    stringLengths: new Uint32Array(encodedStrings.lengths),
    sourceLocationFileIds: new Uint32Array(
      sourceLocations.map((span) => requiredStringId(stringIds, span.file)),
    ),
    sourceLocationStarts: new Uint32Array(
      sourceLocations.map((span) =>
        unsignedWord(span.start, "source location start")
      ),
    ),
    sourceLocationEnds: new Uint32Array(
      sourceLocations.map((span) =>
        unsignedWord(span.end, "source location end")
      ),
    ),
    typeKinds: new Uint32Array(
      module.types.map((type) => requiredKindId(typeKinds, type.kind, "type")),
    ),
    typePayloadStarts: new Uint32Array(typePayloadStarts),
    typePayloadCounts: new Uint32Array(typePayloadCounts),
    typeAuxiliaries: new Uint32Array(typeAuxiliaries),
    typePayloads: new Uint32Array(typePayloads),
    signatureParameterStarts: new Uint32Array(signatureParameterStarts),
    signatureParameterCounts: new Uint32Array(signatureParameterCounts),
    signatureResultTypeIds: new Uint32Array(
      module.signatures.map((signature) => signature.result),
    ),
    signatureParameterTypeIds: new Uint32Array(signatureParameterTypeIds),
    functionNameIds: new Uint32Array(
      module.functions.map((function_) =>
        requiredStringId(stringIds, function_.name)
      ),
    ),
    functionSourceSymbolIds: new Uint32Array(
      module.functions.map((function_) =>
        function_.sourceSymbolId === undefined
          ? absent
          : unsignedWord(function_.sourceSymbolId, "source symbol ID")
      ),
    ),
    functionSignatureIds: new Uint32Array(
      module.functions.map((function_) => function_.signature),
    ),
    functionEntryBlockIds: new Uint32Array(
      module.functions.map((function_, functionId) =>
        globalBlockId(functionId, function_.entryBlock)
      ),
    ),
    functionBlockStarts: new Uint32Array(functionBlockStarts),
    functionBlockCounts: new Uint32Array(functionBlockCounts),
    functionSourceLocationIds: new Uint32Array(
      module.functions.map((function_) => sourceId(function_.span)),
    ),
    blockFunctionIds: new Uint32Array(blockFunctionIds),
    blockLocalIds: new Uint32Array(blockLocalIds),
    blockParameterStarts: new Uint32Array(blockParameterStarts),
    blockParameterCounts: new Uint32Array(blockParameterCounts),
    blockOperationStarts: new Uint32Array(blockOperationStarts),
    blockOperationCounts: new Uint32Array(blockOperationCounts),
    blockTerminatorIds: new Uint32Array(blockTerminatorIds),
    blockParameterValueIds: new Uint32Array(blockParameterValueIds),
    blockParameterTypeIds: new Uint32Array(blockParameterTypeIds),
    blockParameterSourceLocationIds: new Uint32Array(
      blockParameterSourceLocationIds,
    ),
    valueFunctionIds: new Uint32Array(valueFunctionIds),
    valueLocalIds: new Uint32Array(valueLocalIds),
    valueTypeIds: new Uint32Array(valueTypeIds),
    valueDefinitionKinds: new Uint32Array(valueDefinitionKinds),
    valueDefinitionIds: new Uint32Array(valueDefinitionIds),
    operationBlockIds: new Uint32Array(operationBlockIds),
    operationKinds: new Uint32Array(operationKindIds),
    operationResultValueIds: new Uint32Array(operationResultValueIds),
    operationTypeIds: new Uint32Array(operationTypeIds),
    operationOperandStarts: new Uint32Array(operationOperandStarts),
    operationOperandCounts: new Uint32Array(operationOperandCounts),
    operationAttributeStarts: new Uint32Array(operationAttributeStarts),
    operationAttributeCounts: new Uint32Array(operationAttributeCounts),
    operationSourceLocationIds: new Uint32Array(operationSourceLocationIds),
    operandValueIds: new Uint32Array(operandValueIds),
    attributeKinds: new Uint32Array(attributeKindIds),
    attributeLowWords: new Uint32Array(attributeLowWords),
    attributeHighWords: new Uint32Array(attributeHighWords),
    terminatorBlockIds: new Uint32Array(terminatorBlockIds),
    terminatorKinds: new Uint32Array(terminatorKindIds),
    terminatorConditionValueIds: new Uint32Array(
      terminatorConditionValueIds,
    ),
    terminatorEdgeStarts: new Uint32Array(terminatorEdgeStarts),
    terminatorEdgeCounts: new Uint32Array(terminatorEdgeCounts),
    terminatorReturnStarts: new Uint32Array(terminatorReturnStarts),
    terminatorReturnCounts: new Uint32Array(terminatorReturnCounts),
    terminatorSourceLocationIds: new Uint32Array(
      terminatorSourceLocationIds,
    ),
    returnValueIds: new Uint32Array(returnValueIds),
    edgeTargetBlockIds: new Uint32Array(edgeTargetBlockIds),
    edgeArgumentStarts: new Uint32Array(edgeArgumentStarts),
    edgeArgumentCounts: new Uint32Array(edgeArgumentCounts),
    edgeSourceLocationIds: new Uint32Array(edgeSourceLocationIds),
    edgeArgumentValueIds: new Uint32Array(edgeArgumentValueIds),
    ...flatLayouts,
    typeLayoutIds: new Uint32Array(layouts.typeLayouts),
  };
}

export function flattenTrustedDucklangCore(
  module: DucklangCoreModule,
): TrustedFlatDucklangCore {
  return {
    package: flattenDucklangCore(module),
    provenance: "construction",
    [trustedFlatDucklangCore]: true,
  };
}

export function inflateFlatDucklangCore(
  package_: FlatDucklangCore,
): DucklangCoreModule {
  const tables = validateFlatStructure(package_);
  const module = inflateValidatedFlatCore(package_, tables);
  validateDucklangCore(module);
  validateLayouts(package_, module);
  return module;
}

export function validateFlatDucklangCore(
  package_: FlatDucklangCore,
): TrustedFlatDucklangCore {
  inflateFlatDucklangCore(package_);
  return {
    package: package_,
    provenance: "validation",
    [trustedFlatDucklangCore]: true,
  };
}

type ValidatedTables = {
  readonly strings: readonly string[];
  readonly sourceLocations: readonly SourceSpan[];
};

function validateFlatStructure(
  package_: FlatDucklangCore,
): ValidatedTables {
  if (package_.schemaVersion !== flatDucklangCoreSchemaVersion) {
    throw new TypeError(
      `flat Ducklang Core schema version must be ${flatDucklangCoreSchemaVersion}; received ${package_.schemaVersion}`,
    );
  }
  equalLengths(
    "string",
    package_.stringStarts,
    package_.stringLengths,
  );
  equalLengths(
    "source location",
    package_.sourceLocationFileIds,
    package_.sourceLocationStarts,
    package_.sourceLocationEnds,
  );
  equalLengths(
    "type",
    package_.typeKinds,
    package_.typePayloadStarts,
    package_.typePayloadCounts,
    package_.typeAuxiliaries,
  );
  equalLengths(
    "signature",
    package_.signatureParameterStarts,
    package_.signatureParameterCounts,
    package_.signatureResultTypeIds,
  );
  equalLengths(
    "function",
    package_.functionNameIds,
    package_.functionSourceSymbolIds,
    package_.functionSignatureIds,
    package_.functionEntryBlockIds,
    package_.functionBlockStarts,
    package_.functionBlockCounts,
    package_.functionSourceLocationIds,
  );
  equalLengths(
    "block",
    package_.blockFunctionIds,
    package_.blockLocalIds,
    package_.blockParameterStarts,
    package_.blockParameterCounts,
    package_.blockOperationStarts,
    package_.blockOperationCounts,
    package_.blockTerminatorIds,
  );
  equalLengths(
    "block parameter",
    package_.blockParameterValueIds,
    package_.blockParameterTypeIds,
    package_.blockParameterSourceLocationIds,
  );
  equalLengths(
    "value",
    package_.valueFunctionIds,
    package_.valueLocalIds,
    package_.valueTypeIds,
    package_.valueDefinitionKinds,
    package_.valueDefinitionIds,
  );
  equalLengths(
    "operation",
    package_.operationBlockIds,
    package_.operationKinds,
    package_.operationResultValueIds,
    package_.operationTypeIds,
    package_.operationOperandStarts,
    package_.operationOperandCounts,
    package_.operationAttributeStarts,
    package_.operationAttributeCounts,
    package_.operationSourceLocationIds,
  );
  equalLengths(
    "attribute",
    package_.attributeKinds,
    package_.attributeLowWords,
    package_.attributeHighWords,
  );
  equalLengths(
    "terminator",
    package_.terminatorBlockIds,
    package_.terminatorKinds,
    package_.terminatorConditionValueIds,
    package_.terminatorEdgeStarts,
    package_.terminatorEdgeCounts,
    package_.terminatorReturnStarts,
    package_.terminatorReturnCounts,
    package_.terminatorSourceLocationIds,
  );
  equalLengths(
    "edge",
    package_.edgeTargetBlockIds,
    package_.edgeArgumentStarts,
    package_.edgeArgumentCounts,
    package_.edgeSourceLocationIds,
  );
  equalLengths(
    "layout",
    package_.layoutKinds,
    package_.layoutSizes,
    package_.layoutAlignments,
    package_.layoutComponentStarts,
    package_.layoutComponentCounts,
    package_.layoutTagOffsets,
    package_.layoutTagSizes,
    package_.layoutPayloadOffsets,
  );
  equalLengths(
    "layout component",
    package_.layoutComponentIds,
    package_.layoutComponentOffsets,
  );

  const strings = decodeStrings(package_);
  requireIndex(package_.moduleFileId, strings.length, "module file string");
  const sourceLocations = Array.from(
    package_.sourceLocationFileIds,
    (fileId, index) => {
      requireIndex(fileId, strings.length, `source location ${index} file`);
      const start = package_.sourceLocationStarts[index];
      const end = package_.sourceLocationEnds[index];
      if (start > end) {
        throw new RangeError(
          `flat Ducklang Core source location ${index} starts at ${start} after end ${end}`,
        );
      }
      return { file: strings[fileId], start, end };
    },
  );

  contiguousRanges(
    "type payload",
    package_.typePayloadStarts,
    package_.typePayloadCounts,
    package_.typePayloads.length,
  );
  contiguousRanges(
    "signature parameter",
    package_.signatureParameterStarts,
    package_.signatureParameterCounts,
    package_.signatureParameterTypeIds.length,
  );
  contiguousRanges(
    "function block",
    package_.functionBlockStarts,
    package_.functionBlockCounts,
    package_.blockFunctionIds.length,
  );
  contiguousRanges(
    "block parameter",
    package_.blockParameterStarts,
    package_.blockParameterCounts,
    package_.blockParameterValueIds.length,
  );
  contiguousRanges(
    "block operation",
    package_.blockOperationStarts,
    package_.blockOperationCounts,
    package_.operationKinds.length,
  );
  contiguousRanges(
    "operation operand",
    package_.operationOperandStarts,
    package_.operationOperandCounts,
    package_.operandValueIds.length,
  );
  contiguousRanges(
    "operation attribute",
    package_.operationAttributeStarts,
    package_.operationAttributeCounts,
    package_.attributeKinds.length,
  );
  contiguousRanges(
    "terminator edge",
    package_.terminatorEdgeStarts,
    package_.terminatorEdgeCounts,
    package_.edgeTargetBlockIds.length,
  );
  contiguousRanges(
    "terminator return",
    package_.terminatorReturnStarts,
    package_.terminatorReturnCounts,
    package_.returnValueIds.length,
  );
  contiguousRanges(
    "edge argument",
    package_.edgeArgumentStarts,
    package_.edgeArgumentCounts,
    package_.edgeArgumentValueIds.length,
  );
  contiguousRanges(
    "layout component",
    package_.layoutComponentStarts,
    package_.layoutComponentCounts,
    package_.layoutComponentIds.length,
  );

  requireIndex(
    package_.entryFunctionId,
    package_.functionNameIds.length,
    "entry function",
  );
  validateIds(package_.functionNameIds, strings.length, "function name");
  validateIds(
    package_.functionSignatureIds,
    package_.signatureResultTypeIds.length,
    "function signature",
  );
  validateIds(
    package_.functionSourceLocationIds,
    sourceLocations.length,
    "function source location",
  );
  validateIds(
    package_.signatureResultTypeIds,
    package_.typeKinds.length,
    "signature result type",
  );
  validateIds(
    package_.signatureParameterTypeIds,
    package_.typeKinds.length,
    "signature parameter type",
  );
  validateIds(package_.typePayloads, package_.typeKinds.length, "type payload");
  validateIds(
    package_.blockParameterTypeIds,
    package_.typeKinds.length,
    "block parameter type",
  );
  validateIds(
    package_.blockParameterSourceLocationIds,
    sourceLocations.length,
    "block parameter source location",
  );
  validateIds(
    package_.valueFunctionIds,
    package_.functionNameIds.length,
    "value function",
  );
  validateIds(package_.valueTypeIds, package_.typeKinds.length, "value type");
  validateIds(
    package_.operationBlockIds,
    package_.blockFunctionIds.length,
    "operation block",
  );
  validateIds(package_.operationKinds, operationKinds.length, "operation kind");
  validateIds(
    package_.operationResultValueIds,
    package_.valueLocalIds.length,
    "operation result",
  );
  validateIds(
    package_.operationTypeIds,
    package_.typeKinds.length,
    "operation type",
  );
  validateIds(
    package_.operationSourceLocationIds,
    sourceLocations.length,
    "operation source location",
  );
  validateIds(
    package_.operandValueIds,
    package_.valueLocalIds.length,
    "operand value",
  );
  validateIds(package_.attributeKinds, attributeKinds.length, "attribute kind");
  validateIds(
    package_.terminatorBlockIds,
    package_.blockFunctionIds.length,
    "terminator block",
  );
  validateIds(
    package_.terminatorKinds,
    terminatorKinds.length,
    "terminator kind",
  );
  validateIds(
    package_.terminatorSourceLocationIds,
    sourceLocations.length,
    "terminator source location",
  );
  validateIds(
    package_.returnValueIds,
    package_.valueLocalIds.length,
    "return value",
  );
  validateIds(
    package_.edgeTargetBlockIds,
    package_.blockFunctionIds.length,
    "edge target",
  );
  validateIds(
    package_.edgeSourceLocationIds,
    sourceLocations.length,
    "edge source location",
  );
  validateIds(
    package_.edgeArgumentValueIds,
    package_.valueLocalIds.length,
    "edge argument",
  );
  validateIds(package_.layoutKinds, layoutKinds.length, "layout kind");
  validateIds(
    package_.layoutComponentIds,
    package_.layoutKinds.length,
    "layout component",
  );
  validateIds(
    package_.typeLayoutIds,
    package_.layoutKinds.length,
    "type layout",
  );
  if (package_.typeLayoutIds.length !== package_.typeKinds.length) {
    throw new TypeError(
      `flat Ducklang Core type layout columns must have equal lengths; received ${package_.typeLayoutIds.length} and ${package_.typeKinds.length}`,
    );
  }

  for (const [typeId, kindId] of package_.typeKinds.entries()) {
    requireIndex(kindId, typeKinds.length, `type ${typeId} kind`);
    const kind = typeKinds[kindId];
    const count = package_.typePayloadCounts[typeId];
    const auxiliary = package_.typeAuxiliaries[typeId];
    if (
      (kind === "scalar" && auxiliary >= scalarKinds.length) ||
      ((kind === "vector" || kind === "mask") &&
        !validVectorAuxiliary(auxiliary)) ||
      (kind === "buffer" && auxiliary >= bufferKinds.length) ||
      (kind === "function" &&
        auxiliary >= package_.signatureResultTypeIds.length)
    ) {
      throw new RangeError(
        `flat Ducklang Core type ${typeId} has invalid ${kind} auxiliary ${auxiliary}`,
      );
    }
    const expectedCount = kind === "product" || kind === "sum" ? count : 0;
    if (count !== expectedCount) {
      throw new TypeError(
        `flat Ducklang Core ${kind} type ${typeId} cannot have ${count} payloads`,
      );
    }
  }

  for (
    const [functionId, blockStart] of package_.functionBlockStarts.entries()
  ) {
    const blockLength = package_.functionBlockCounts[functionId];
    const entry = package_.functionEntryBlockIds[functionId];
    if (entry < blockStart || entry >= blockStart + blockLength) {
      throw new RangeError(
        `flat Ducklang Core function ${functionId} entry block ${entry} is outside its range ${blockStart}..${
          blockStart + blockLength
        }`,
      );
    }
    for (
      let blockId = blockStart;
      blockId < blockStart + blockLength;
      blockId += 1
    ) {
      if (
        package_.blockFunctionIds[blockId] !== functionId ||
        package_.blockLocalIds[blockId] !== blockId - blockStart
      ) {
        throw new TypeError(
          `flat Ducklang Core block ${blockId} disagrees with function ${functionId} source order`,
        );
      }
    }
  }
  if (package_.blockTerminatorIds.length !== package_.terminatorKinds.length) {
    throw new TypeError(
      `flat Ducklang Core requires one terminator per block; received ${package_.blockTerminatorIds.length} blocks and ${package_.terminatorKinds.length} terminators`,
    );
  }
  for (const [blockId, terminatorId] of package_.blockTerminatorIds.entries()) {
    if (
      terminatorId !== blockId ||
      package_.terminatorBlockIds[terminatorId] !== blockId
    ) {
      throw new TypeError(
        `flat Ducklang Core block ${blockId} does not own terminator ${terminatorId}`,
      );
    }
  }

  const valueByLocal = new Set<string>();
  for (let valueId = 0; valueId < package_.valueLocalIds.length; valueId += 1) {
    const functionId = package_.valueFunctionIds[valueId];
    const localId = package_.valueLocalIds[valueId];
    const key = valueKey(functionId, localId);
    if (valueByLocal.has(key)) {
      throw new TypeError(
        `flat Ducklang Core function ${functionId} repeats local value ${localId}`,
      );
    }
    valueByLocal.add(key);
    const definitionKind = package_.valueDefinitionKinds[valueId];
    const definitionId = package_.valueDefinitionIds[valueId];
    if (definitionKind === parameterDefinition) {
      requireIndex(
        definitionId,
        package_.blockParameterValueIds.length,
        `value ${valueId} parameter definition`,
      );
      if (package_.blockParameterValueIds[definitionId] !== valueId) {
        throw new TypeError(
          `flat Ducklang Core value ${valueId} parameter definition ${definitionId} points elsewhere`,
        );
      }
    } else if (definitionKind === operationDefinition) {
      requireIndex(
        definitionId,
        package_.operationResultValueIds.length,
        `value ${valueId} operation definition`,
      );
      if (package_.operationResultValueIds[definitionId] !== valueId) {
        throw new TypeError(
          `flat Ducklang Core value ${valueId} operation definition ${definitionId} points elsewhere`,
        );
      }
    } else {
      throw new TypeError(
        `flat Ducklang Core value ${valueId} has unknown definition kind ${definitionKind}`,
      );
    }
  }

  for (
    let blockId = 0;
    blockId < package_.blockFunctionIds.length;
    blockId += 1
  ) {
    const functionId = package_.blockFunctionIds[blockId];
    const parameterStart = package_.blockParameterStarts[blockId];
    const parameterCount = package_.blockParameterCounts[blockId];
    for (
      let index = parameterStart;
      index < parameterStart + parameterCount;
      index += 1
    ) {
      requireValueFunction(
        package_,
        package_.blockParameterValueIds[index],
        functionId,
        `block ${blockId} parameter`,
      );
    }
    const operationStart = package_.blockOperationStarts[blockId];
    const operationLength = package_.blockOperationCounts[blockId];
    for (
      let operationId = operationStart;
      operationId < operationStart + operationLength;
      operationId += 1
    ) {
      if (package_.operationBlockIds[operationId] !== blockId) {
        throw new TypeError(
          `flat Ducklang Core operation ${operationId} belongs to block ${
            package_.operationBlockIds[operationId]
          }; expected ${blockId}`,
        );
      }
      requireValueFunction(
        package_,
        package_.operationResultValueIds[operationId],
        functionId,
        `operation ${operationId} result`,
      );
      const operandStart = package_.operationOperandStarts[operationId];
      const operandCount = package_.operationOperandCounts[operationId];
      for (
        let index = operandStart;
        index < operandStart + operandCount;
        index += 1
      ) {
        requireValueFunction(
          package_,
          package_.operandValueIds[index],
          functionId,
          `operation ${operationId} operand`,
        );
      }
    }
    const terminatorId = package_.blockTerminatorIds[blockId];
    const condition = package_.terminatorConditionValueIds[terminatorId];
    if (condition !== absent) {
      requireValueFunction(
        package_,
        condition,
        functionId,
        `terminator ${terminatorId} condition`,
      );
    }
    const returnStart = package_.terminatorReturnStarts[terminatorId];
    const returnCount = package_.terminatorReturnCounts[terminatorId];
    for (
      let index = returnStart;
      index < returnStart + returnCount;
      index += 1
    ) {
      requireValueFunction(
        package_,
        package_.returnValueIds[index],
        functionId,
        `terminator ${terminatorId} return`,
      );
    }
    const edgeStart = package_.terminatorEdgeStarts[terminatorId];
    const edgeCount = package_.terminatorEdgeCounts[terminatorId];
    for (let edgeId = edgeStart; edgeId < edgeStart + edgeCount; edgeId += 1) {
      const target = package_.edgeTargetBlockIds[edgeId];
      if (package_.blockFunctionIds[target] !== functionId) {
        throw new TypeError(
          `flat Ducklang Core edge ${edgeId} crosses function ${functionId} to ${
            package_.blockFunctionIds[target]
          }`,
        );
      }
      const argumentStart = package_.edgeArgumentStarts[edgeId];
      const argumentCount = package_.edgeArgumentCounts[edgeId];
      for (
        let index = argumentStart;
        index < argumentStart + argumentCount;
        index += 1
      ) {
        requireValueFunction(
          package_,
          package_.edgeArgumentValueIds[index],
          functionId,
          `edge ${edgeId} argument`,
        );
      }
    }
  }
  for (const [attributeId, kindId] of package_.attributeKinds.entries()) {
    if (
      attributeKinds[kindId] === "string" &&
      package_.attributeLowWords[attributeId] >= strings.length
    ) {
      throw new RangeError(
        `flat Ducklang Core attribute ${attributeId} uses string ID ${
          package_.attributeLowWords[attributeId]
        }; package contains ${strings.length} strings`,
      );
    }
  }
  return { strings, sourceLocations };
}

function validVectorAuxiliary(auxiliary: number): boolean {
  const element = vectorElementKinds[auxiliary & 0xff];
  if (element === undefined) return false;
  const lanes = auxiliary >>> 8;
  return lanes * (element === "i64" || element === "f64" ? 64 : 32) === 128;
}

function vectorLaneCount(auxiliary: number): 2 | 4 {
  if (!validVectorAuxiliary(auxiliary)) {
    throw new RangeError(
      `invalid flat Ducklang Core vector auxiliary ${auxiliary}`,
    );
  }
  return (auxiliary >>> 8) as 2 | 4;
}

function inflateValidatedFlatCore(
  package_: FlatDucklangCore,
  tables: ValidatedTables,
): DucklangCoreModule {
  const typeEntries = Array.from(
    package_.typeKinds,
    (kindId, typeId): DucklangCoreType => {
      const payloadStart = package_.typePayloadStarts[typeId];
      const payloadCount = package_.typePayloadCounts[typeId];
      const payloads = Array.from(
        package_.typePayloads.subarray(
          payloadStart,
          payloadStart + payloadCount,
        ),
        (id) => id as CoreTypeId,
      );
      switch (typeKinds[kindId]) {
        case "scalar":
          return {
            kind: "scalar",
            scalar: scalarKinds[package_.typeAuxiliaries[typeId]],
          };
        case "vector":
        case "mask": {
          const auxiliary = package_.typeAuxiliaries[typeId];
          return {
            kind: typeKinds[kindId],
            lanes: vectorLaneCount(auxiliary),
            element: vectorElementKinds[auxiliary & 0xff],
          };
        }
        case "buffer":
          return {
            kind: "buffer",
            buffer: bufferKinds[package_.typeAuxiliaries[typeId]],
          };
        case "product":
          return { kind: "product", fields: payloads };
        case "sum":
          return { kind: "sum", cases: payloads };
        case "function":
          return {
            kind: "function",
            signature: package_.typeAuxiliaries[
              typeId
            ] as CoreSignatureId,
          };
      }
    },
  );
  const signatures = Array.from(
    package_.signatureResultTypeIds,
    (result, signatureId) => {
      const start = package_.signatureParameterStarts[signatureId];
      const count = package_.signatureParameterCounts[signatureId];
      return {
        parameters: Array.from(
          package_.signatureParameterTypeIds.subarray(start, start + count),
          (id) => id as CoreTypeId,
        ),
        result: result as CoreTypeId,
      };
    },
  );

  const localValue = (valueId: number): CoreValueId =>
    package_.valueLocalIds[valueId] as CoreValueId;
  const span = (sourceLocationId: number): SourceSpan =>
    tables.sourceLocations[sourceLocationId];

  const functions = Array.from(
    package_.functionNameIds,
    (nameId, functionId): DucklangCoreFunction => {
      const blockStart = package_.functionBlockStarts[functionId];
      const blockCount = package_.functionBlockCounts[functionId];
      const blocks = Array.from(
        { length: blockCount },
        (_, relativeBlockId): DucklangCoreBlock => {
          const blockId = blockStart + relativeBlockId;
          const parameterStart = package_.blockParameterStarts[blockId];
          const parameterCount = package_.blockParameterCounts[blockId];
          const operationStart = package_.blockOperationStarts[blockId];
          const operationCount = package_.blockOperationCounts[blockId];
          const terminatorId = package_.blockTerminatorIds[blockId];
          return {
            id: relativeBlockId as CoreBlockId,
            parameters: Array.from(
              { length: parameterCount },
              (_, index) => {
                const parameterId = parameterStart + index;
                return {
                  value: localValue(
                    package_.blockParameterValueIds[parameterId],
                  ),
                  type: package_.blockParameterTypeIds[
                    parameterId
                  ] as CoreTypeId,
                  span: span(
                    package_.blockParameterSourceLocationIds[parameterId],
                  ),
                };
              },
            ),
            operations: Array.from(
              { length: operationCount },
              (_, index) =>
                inflateOperation(
                  package_,
                  operationStart + index,
                  tables,
                ),
            ),
            terminator: inflateTerminator(
              package_,
              terminatorId,
              blockStart,
              tables,
            ),
          };
        },
      );
      const entryBlock = package_.functionEntryBlockIds[functionId] -
        blockStart;
      const sourceSymbolId = package_.functionSourceSymbolIds[functionId];
      return {
        id: functionId as CoreFunctionId,
        name: tables.strings[nameId],
        sourceSymbolId: sourceSymbolId === absent ? undefined : sourceSymbolId,
        signature: package_.functionSignatureIds[
          functionId
        ] as CoreSignatureId,
        entryBlock: entryBlock as CoreBlockId,
        blocks,
        span: span(package_.functionSourceLocationIds[functionId]),
      };
    },
  );
  return {
    schemaVersion: 1,
    file: tables.strings[package_.moduleFileId],
    types: typeEntries,
    signatures,
    functions,
    entryFunction: package_.entryFunctionId as CoreFunctionId,
  };
}

function inflateOperation(
  package_: FlatDucklangCore,
  operationId: number,
  tables: ValidatedTables,
): DucklangCoreOperation {
  const kind = operationKinds[package_.operationKinds[operationId]];
  const operandStart = package_.operationOperandStarts[operationId];
  const operandCount = package_.operationOperandCounts[operationId];
  const operands = Array.from(
    package_.operandValueIds.subarray(
      operandStart,
      operandStart + operandCount,
    ),
    (valueId) => package_.valueLocalIds[valueId] as CoreValueId,
  );
  const attributeStart = package_.operationAttributeStarts[operationId];
  const attributeCount = package_.operationAttributeCounts[operationId];
  const attributes = Array.from(
    { length: attributeCount },
    (_, index) =>
      decodeAttribute(package_, attributeStart + index, tables.strings),
  );
  const base = {
    result: package_.valueLocalIds[
      package_.operationResultValueIds[operationId]
    ] as CoreValueId,
    type: package_.operationTypeIds[operationId] as CoreTypeId,
    operands,
    span: tables.sourceLocations[
      package_.operationSourceLocationIds[operationId]
    ],
  };
  switch (kind) {
    case "constant":
      requireAttributeCount(kind, attributes, 1);
      return { ...base, kind, value: attributes[0] as never };
    case "scalar.binary":
      requireAttributeCount(kind, attributes, 1);
      if (
        typeof attributes[0] !== "number" ||
        binaryOperators[attributes[0]] === undefined
      ) {
        throw new TypeError(
          `flat Ducklang Core scalar.binary has unknown operator ${
            attributes[0]
          }`,
        );
      }
      return {
        ...base,
        kind,
        operator: binaryOperators[attributes[0] as number],
      };
    case "primitive":
      requireAttributeCount(kind, attributes, 1);
      return { ...base, kind, primitiveId: attributes[0] as PrimitiveId };
    case "vector.shuffle":
      return { ...base, kind, lanes: attributes as number[] };
    case "product.project":
      requireAttributeCount(kind, attributes, 1);
      return { ...base, kind, index: attributes[0] as number };
    case "product.update":
      return { ...base, kind, indices: attributes as number[] };
    case "sum.make":
    case "sum.payload":
      requireAttributeCount(kind, attributes, 1);
      return { ...base, kind, caseIndex: attributes[0] as number };
    case "call.direct":
    case "closure.make":
      requireAttributeCount(kind, attributes, 1);
      return {
        ...base,
        kind,
        functionId: attributes[0] as CoreFunctionId,
      };
    case "call.indirect":
      requireAttributeCount(kind, attributes, 1);
      return {
        ...base,
        kind,
        signature: attributes[0] as CoreSignatureId,
      };
    case "host.call":
      requireAttributeCount(kind, attributes, 2);
      return {
        ...base,
        kind,
        effectName: attributes[0] as string,
        operationName: attributes[1] as string,
      };
    case "product.make":
    case "product.index":
    case "product.index_update":
    case "product.select":
    case "sum.tag":
    case "resource.move":
    case "resource.borrow":
    case "resource.freeze":
    case "resource.drop":
    case "region.enter":
    case "region.allocate":
    case "region.exit":
      requireAttributeCount(kind, attributes, 0);
      return { ...base, kind };
  }
}

function inflateTerminator(
  package_: FlatDucklangCore,
  terminatorId: number,
  functionBlockStart: number,
  tables: ValidatedTables,
): DucklangCoreTerminator {
  const kind = terminatorKinds[package_.terminatorKinds[terminatorId]];
  const edgeStart = package_.terminatorEdgeStarts[terminatorId];
  const edgeCount = package_.terminatorEdgeCounts[terminatorId];
  const edges = Array.from({ length: edgeCount }, (_, index) => {
    const edgeId = edgeStart + index;
    const argumentStart = package_.edgeArgumentStarts[edgeId];
    const argumentCount = package_.edgeArgumentCounts[edgeId];
    return {
      target: (package_.edgeTargetBlockIds[edgeId] -
        functionBlockStart) as CoreBlockId,
      arguments: Array.from(
        package_.edgeArgumentValueIds.subarray(
          argumentStart,
          argumentStart + argumentCount,
        ),
        (valueId) => package_.valueLocalIds[valueId] as CoreValueId,
      ),
    };
  });
  const span = tables.sourceLocations[
    package_.terminatorSourceLocationIds[terminatorId]
  ];
  if (kind === "branch") {
    if (edges.length !== 1) {
      throw new TypeError(
        `flat Ducklang Core branch terminator ${terminatorId} has ${edges.length} edges`,
      );
    }
    return { kind, ...edges[0], span };
  }
  if (kind === "conditional_branch") {
    if (edges.length !== 2) {
      throw new TypeError(
        `flat Ducklang Core conditional terminator ${terminatorId} has ${edges.length} edges`,
      );
    }
    const condition = package_.terminatorConditionValueIds[terminatorId];
    if (condition === absent) {
      throw new TypeError(
        `flat Ducklang Core conditional terminator ${terminatorId} has no condition`,
      );
    }
    return {
      kind,
      condition: package_.valueLocalIds[condition] as CoreValueId,
      trueTarget: edges[0].target,
      trueArguments: edges[0].arguments,
      falseTarget: edges[1].target,
      falseArguments: edges[1].arguments,
      span,
    };
  }
  if (kind === "return") {
    if (edges.length !== 0) {
      throw new TypeError(
        `flat Ducklang Core return terminator ${terminatorId} has ${edges.length} edges`,
      );
    }
    const start = package_.terminatorReturnStarts[terminatorId];
    const count = package_.terminatorReturnCounts[terminatorId];
    return {
      kind,
      values: Array.from(
        package_.returnValueIds.subarray(start, start + count),
        (valueId) => package_.valueLocalIds[valueId] as CoreValueId,
      ),
      span,
    };
  }
  if (edges.length !== 0) {
    throw new TypeError(
      `flat Ducklang Core trap terminator ${terminatorId} has ${edges.length} edges`,
    );
  }
  return { kind, span };
}

function appendOperationAttributes(
  operation: DucklangCoreOperation,
  pushAttribute: (
    kind: AttributeKind,
    lowWord: number,
    highWord?: number,
  ) => void,
  pushUnsigned: (value: number) => void,
  pushString: (value: string) => void,
): void {
  switch (operation.kind) {
    case "constant":
      appendConstantAttribute(operation.value, pushAttribute, pushString);
      return;
    case "scalar.binary":
      pushUnsigned(
        requiredKindId(binaryOperators, operation.operator, "binary operator"),
      );
      return;
    case "primitive":
      pushUnsigned(operation.primitiveId);
      return;
    case "vector.shuffle":
      operation.lanes.forEach(pushUnsigned);
      return;
    case "product.project":
      pushUnsigned(operation.index);
      return;
    case "product.update":
      operation.indices.forEach(pushUnsigned);
      return;
    case "sum.make":
    case "sum.payload":
      pushUnsigned(operation.caseIndex);
      return;
    case "call.direct":
    case "closure.make":
      pushUnsigned(operation.functionId);
      return;
    case "call.indirect":
      pushUnsigned(operation.signature);
      return;
    case "host.call":
      pushString(operation.effectName);
      pushString(operation.operationName);
      return;
    case "product.make":
    case "product.index":
    case "product.index_update":
    case "product.select":
    case "sum.tag":
    case "resource.move":
    case "resource.borrow":
    case "resource.freeze":
    case "resource.drop":
    case "region.enter":
    case "region.allocate":
    case "region.exit":
      return;
  }
}

function appendConstantAttribute(
  value: Extract<DucklangCoreOperation, { readonly kind: "constant" }>["value"],
  pushAttribute: (
    kind: AttributeKind,
    lowWord: number,
    highWord?: number,
  ) => void,
  pushString: (value: string) => void,
): void {
  if (value === undefined) {
    pushAttribute("undefined", 0);
    return;
  }
  if (typeof value === "string") {
    pushString(value);
    return;
  }
  if (typeof value === "boolean") {
    pushAttribute("boolean", value ? 1 : 0);
    return;
  }
  if (typeof value === "bigint") {
    const bits = BigInt.asUintN(64, value);
    pushAttribute(
      "bigint",
      Number(bits & 0xffff_ffffn),
      Number(bits >> 32n),
    );
    return;
  }
  const words = numberWords(value);
  pushAttribute("number", words.low, words.high);
}

function decodeAttribute(
  package_: FlatDucklangCore,
  attributeId: number,
  strings: readonly string[],
): number | bigint | boolean | string | undefined {
  const low = package_.attributeLowWords[attributeId];
  const high = package_.attributeHighWords[attributeId];
  switch (attributeKinds[package_.attributeKinds[attributeId]]) {
    case "unsigned":
      return low;
    case "number":
      return wordsNumber(low, high);
    case "bigint":
      return BigInt.asIntN(64, (BigInt(high) << 32n) | BigInt(low));
    case "boolean":
      if (low > 1) {
        throw new TypeError(
          `flat Ducklang Core boolean attribute ${attributeId} has word ${low}`,
        );
      }
      return low === 1;
    case "string":
      return strings[low];
    case "undefined":
      return undefined;
  }
}

function terminatorEdges(
  terminator: DucklangCoreTerminator,
): readonly {
  readonly target: CoreBlockId;
  readonly arguments: readonly CoreValueId[];
}[] {
  if (terminator.kind === "branch") {
    return [{ target: terminator.target, arguments: terminator.arguments }];
  }
  if (terminator.kind === "conditional_branch") {
    return [
      {
        target: terminator.trueTarget,
        arguments: terminator.trueArguments,
      },
      {
        target: terminator.falseTarget,
        arguments: terminator.falseArguments,
      },
    ];
  }
  return [];
}

function collectStrings(module: DucklangCoreModule): readonly string[] {
  const strings = new Set<string>([module.file]);
  const addSpan = (span: SourceSpan): void => {
    strings.add(span.file);
  };
  for (const function_ of module.functions) {
    strings.add(function_.name);
    addSpan(function_.span);
    for (const block of function_.blocks) {
      block.parameters.forEach((parameter) => addSpan(parameter.span));
      for (const operation of block.operations) {
        addSpan(operation.span);
        if (
          operation.kind === "constant" &&
          typeof operation.value === "string"
        ) {
          strings.add(operation.value);
        } else if (operation.kind === "host.call") {
          strings.add(operation.effectName);
          strings.add(operation.operationName);
        }
      }
      addSpan(block.terminator.span);
    }
  }
  return [...strings].sort(compareStrings);
}

function collectSourceLocations(
  module: DucklangCoreModule,
): readonly SourceSpan[] {
  const locations: SourceSpan[] = [];
  const keys = new Set<string>();
  const add = (span: SourceSpan): void => {
    const key = sourceLocationKey(span);
    if (keys.has(key)) return;
    keys.add(key);
    locations.push(span);
  };
  for (const function_ of module.functions) {
    add(function_.span);
    for (const block of function_.blocks) {
      block.parameters.forEach((parameter) => add(parameter.span));
      block.operations.forEach((operation) => add(operation.span));
      add(block.terminator.span);
    }
  }
  return locations;
}

function sourceLocationKey(span: SourceSpan): string {
  return `${span.file}\u0000${span.start}\u0000${span.end}`;
}

function valueKey(functionId: number, localValueId: number): string {
  return `${functionId}:${localValueId}`;
}

function typeAuxiliary(type: DucklangCoreType): number {
  if (type.kind === "scalar") {
    return requiredKindId(scalarKinds, type.scalar, "scalar");
  }
  if (type.kind === "vector" || type.kind === "mask") {
    return (type.lanes << 8) |
      requiredKindId(vectorElementKinds, type.element, "vector element");
  }
  if (type.kind === "buffer") {
    return requiredKindId(bufferKinds, type.buffer, "buffer");
  }
  return type.kind === "function" ? type.signature : 0;
}

function flattenLayouts(
  layouts: readonly DucklangCoreLayout[],
): Pick<
  FlatDucklangCore,
  | "layoutKinds"
  | "layoutSizes"
  | "layoutAlignments"
  | "layoutComponentStarts"
  | "layoutComponentCounts"
  | "layoutTagOffsets"
  | "layoutTagSizes"
  | "layoutPayloadOffsets"
  | "layoutComponentIds"
  | "layoutComponentOffsets"
> {
  const componentIds: number[] = [];
  const componentOffsets: number[] = [];
  const componentStarts: number[] = [];
  const componentCounts: number[] = [];
  for (const layout of layouts) {
    componentStarts.push(componentIds.length);
    const components = layout.kind === "product"
      ? layout.fields
      : layout.kind === "sum"
      ? layout.cases
      : [];
    componentCounts.push(components.length);
    componentIds.push(...components);
    componentOffsets.push(
      ...(layout.kind === "product" ? layout.offsets : components.map(() => 0)),
    );
  }
  return {
    layoutKinds: new Uint32Array(
      layouts.map((layout) =>
        requiredKindId(layoutKinds, layout.kind, "layout")
      ),
    ),
    layoutSizes: new Uint32Array(layouts.map((layout) => layout.size)),
    layoutAlignments: new Uint32Array(
      layouts.map((layout) => layout.alignment),
    ),
    layoutComponentStarts: new Uint32Array(componentStarts),
    layoutComponentCounts: new Uint32Array(componentCounts),
    layoutTagOffsets: new Uint32Array(
      layouts.map((layout) => layout.kind === "sum" ? layout.tagOffset : 0),
    ),
    layoutTagSizes: new Uint32Array(
      layouts.map((layout) => layout.kind === "sum" ? layout.tagSize : 0),
    ),
    layoutPayloadOffsets: new Uint32Array(
      layouts.map((layout) => layout.kind === "sum" ? layout.payloadOffset : 0),
    ),
    layoutComponentIds: new Uint32Array(componentIds),
    layoutComponentOffsets: new Uint32Array(componentOffsets),
  };
}

function validateLayouts(
  package_: FlatDucklangCore,
  module: DucklangCoreModule,
): void {
  const expectedPlan = planDucklangCoreLayouts(module);
  const expected = flattenLayouts(expectedPlan.layouts);
  const columns: (keyof typeof expected)[] = [
    "layoutKinds",
    "layoutSizes",
    "layoutAlignments",
    "layoutComponentStarts",
    "layoutComponentCounts",
    "layoutTagOffsets",
    "layoutTagSizes",
    "layoutPayloadOffsets",
    "layoutComponentIds",
    "layoutComponentOffsets",
  ];
  for (const column of columns) {
    requireEqualWords(
      `layout ${column}`,
      package_[column],
      expected[column],
    );
  }
  requireEqualWords(
    "type layouts",
    package_.typeLayoutIds,
    new Uint32Array(expectedPlan.typeLayouts),
  );
}

function requireAttributeCount(
  operation: string,
  attributes: readonly unknown[],
  expected: number,
): void {
  if (attributes.length !== expected) {
    throw new TypeError(
      `flat Ducklang Core ${operation} has ${attributes.length} attributes; expected ${expected}`,
    );
  }
}

function requireValueFunction(
  package_: FlatDucklangCore,
  valueId: number,
  functionId: number,
  subject: string,
): void {
  requireIndex(valueId, package_.valueFunctionIds.length, `${subject} value`);
  if (package_.valueFunctionIds[valueId] !== functionId) {
    throw new TypeError(
      `flat Ducklang Core ${subject} uses value ${valueId} from function ${
        package_.valueFunctionIds[valueId]
      }; expected ${functionId}`,
    );
  }
}

function decodeStrings(package_: FlatDucklangCore): readonly string[] {
  contiguousRanges(
    "string",
    package_.stringStarts,
    package_.stringLengths,
    package_.stringBytes.length,
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const strings = Array.from(package_.stringStarts, (start, index) => {
    const end = start + package_.stringLengths[index];
    try {
      return decoder.decode(package_.stringBytes.subarray(start, end));
    } catch (cause) {
      throw new TypeError(
        `flat Ducklang Core string ${index} is not valid UTF-8`,
        { cause },
      );
    }
  });
  for (let index = 1; index < strings.length; index += 1) {
    if (compareStrings(strings[index - 1], strings[index]) >= 0) {
      throw new TypeError(
        `flat Ducklang Core strings must be strictly ordered at ${index}`,
      );
    }
  }
  return strings;
}

function encodeStrings(strings: readonly string[]): {
  readonly bytes: Uint8Array;
  readonly starts: readonly number[];
  readonly lengths: readonly number[];
} {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  const starts: number[] = [];
  const lengths: number[] = [];
  for (const string of strings) {
    const encoded = encoder.encode(string);
    starts.push(bytes.length);
    lengths.push(encoded.length);
    bytes.push(...encoded);
  }
  return { bytes: new Uint8Array(bytes), starts, lengths };
}

function numberWords(value: number): {
  readonly low: number;
  readonly high: number;
} {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, true);
  return {
    low: view.getUint32(0, true),
    high: view.getUint32(4, true),
  };
}

function wordsNumber(low: number, high: number): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, low, true);
  view.setUint32(4, high, true);
  return view.getFloat64(0, true);
}

function equalLengths(
  subject: string,
  ...columns: readonly ArrayLike<unknown>[]
): void {
  const lengths = columns.map((column) => column.length);
  if (lengths.every((length) => length === lengths[0])) return;
  throw new TypeError(
    `flat Ducklang Core ${subject} columns must have equal lengths; received ${
      lengths.join(", ")
    }`,
  );
}

function contiguousRanges(
  subject: string,
  starts: Uint32Array,
  counts: Uint32Array,
  total: number,
): void {
  let expected = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const count = counts[index];
    if (start !== expected) {
      throw new RangeError(
        `flat Ducklang Core ${subject} ${index} starts at ${start}; expected contiguous start ${expected}`,
      );
    }
    if (count > total - start) {
      throw new RangeError(
        `flat Ducklang Core ${subject} ${index} range ${start}..${
          start + count
        } exceeds length ${total}`,
      );
    }
    expected += count;
  }
  if (expected !== total) {
    throw new RangeError(
      `flat Ducklang Core ${subject} ranges cover ${expected}; column has ${total}`,
    );
  }
}

function validateIds(
  ids: Uint32Array,
  length: number,
  subject: string,
): void {
  for (const [index, id] of ids.entries()) {
    requireIndex(id, length, `${subject} ${index}`);
  }
}

function requireIndex(index: number, length: number, subject: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new RangeError(
      `flat Ducklang Core ${subject} ${index} is outside table length ${length}`,
    );
  }
}

function unsignedWord(value: number, subject: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(
      `${subject} must fit a u32 word; received ${value}`,
    );
  }
  return value;
}

function requiredKindId<T extends string>(
  kinds: readonly T[],
  kind: string,
  subject: string,
): number {
  const id = kinds.indexOf(kind as T);
  if (id >= 0) return id;
  throw new TypeError(`unknown Ducklang Core ${subject} kind ${kind}`);
}

function requiredStringId(
  ids: ReadonlyMap<string, number>,
  value: string,
): number {
  const id = ids.get(value);
  if (id !== undefined) return id;
  throw new Error(`flat Ducklang Core string was not interned: ${value}`);
}

function requireEqualWords(
  subject: string,
  actual: Uint32Array,
  expected: Uint32Array,
): void {
  if (
    actual.length === expected.length &&
    actual.every((word, index) => word === expected[index])
  ) {
    return;
  }
  throw new TypeError(`flat Ducklang Core ${subject} disagrees with Core`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

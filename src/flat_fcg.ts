import type { FcgModule, FcgOperation } from "./fcg.ts";

export const flatFcgSchemaVersion = 2 as const;

export type FlatFcgPackage = {
  readonly schemaVersion: typeof flatFcgSchemaVersion;
  readonly stringBytes: Uint8Array;
  readonly stringStarts: Uint32Array;
  readonly stringLengths: Uint32Array;
  readonly functionNameIds: Uint32Array;
  readonly functionParameterStarts: Uint32Array;
  readonly functionParameterCounts: Uint32Array;
  readonly functionLocalCounts: Uint32Array;
  readonly functionOperationStarts: Uint32Array;
  readonly functionOperationCounts: Uint32Array;
  readonly parameterNameIds: Uint32Array;
  readonly operationOpcodeIds: Uint32Array;
  readonly operationOperandStarts: Uint32Array;
  readonly operationOperandCounts: Uint32Array;
  readonly operationSourceStarts: Uint32Array;
  readonly operationRegionIds: Uint32Array;
  readonly operandKinds: Uint32Array;
  readonly operandWords: Uint32Array;
  readonly constructorNameIds: Uint32Array;
  readonly constructorTags: Uint32Array;
};

const signedOperand = 0;
const unsignedOperand = 1;
const stringOperand = 2;
const maximumUnsignedWord = 0xffff_ffff;
const minimumSignedWord = -0x8000_0000;

export function flattenFcgModule(module: FcgModule): FlatFcgPackage {
  const strings = new Set<string>();
  for (const function_ of module.functions) {
    strings.add(function_.name);
    function_.parameters.forEach((parameter) => strings.add(parameter));
    for (const operation of function_.operations) {
      strings.add(operation.opcode);
      operation.operands.forEach((operand) => {
        if (typeof operand === "string") strings.add(operand);
      });
    }
  }
  for (const name of module.constructorTags.keys()) strings.add(name);

  const orderedStrings = [...strings].sort();
  const stringIds = new Map(
    orderedStrings.map((value, index) => [value, index]),
  );
  const encoder = new TextEncoder();
  const encodedStrings = orderedStrings.map((value) => encoder.encode(value));
  const stringStarts: number[] = [];
  const stringLengths: number[] = [];
  const stringBytes: number[] = [];
  for (const encoded of encodedStrings) {
    stringStarts.push(stringBytes.length);
    stringLengths.push(encoded.length);
    stringBytes.push(...encoded);
  }

  const functionNameIds: number[] = [];
  const functionParameterStarts: number[] = [];
  const functionParameterCounts: number[] = [];
  const functionLocalCounts: number[] = [];
  const functionOperationStarts: number[] = [];
  const functionOperationCounts: number[] = [];
  const parameterNameIds: number[] = [];
  const operationOpcodeIds: number[] = [];
  const operationOperandStarts: number[] = [];
  const operationOperandCounts: number[] = [];
  const operationSourceStarts: number[] = [];
  const operationRegionIds: number[] = [];
  const operandKinds: number[] = [];
  const operandWords: number[] = [];

  for (const function_ of module.functions) {
    functionNameIds.push(requiredStringId(stringIds, function_.name));
    functionParameterStarts.push(parameterNameIds.length);
    functionParameterCounts.push(function_.parameters.length);
    functionLocalCounts.push(unsignedWord(function_.localCount, "local count"));
    functionOperationStarts.push(operationOpcodeIds.length);
    functionOperationCounts.push(function_.operations.length);
    for (const parameter of function_.parameters) {
      parameterNameIds.push(requiredStringId(stringIds, parameter));
    }
    for (const operation of function_.operations) {
      operationOpcodeIds.push(requiredStringId(stringIds, operation.opcode));
      operationOperandStarts.push(operandKinds.length);
      operationOperandCounts.push(operation.operands.length);
      operationSourceStarts.push(
        unsignedWord(operation.sourceStart, "operation source start"),
      );
      operationRegionIds.push(
        unsignedWord(operation.regionId, "operation region ID"),
      );
      for (const operand of operation.operands) {
        if (typeof operand === "string") {
          operandKinds.push(stringOperand);
          operandWords.push(requiredStringId(stringIds, operand));
          continue;
        }
        if (
          !Number.isSafeInteger(operand) || operand < minimumSignedWord ||
          operand > maximumUnsignedWord
        ) {
          throw new RangeError(
            `FCG operand must fit an i32 or u32 word; received ${operand}`,
          );
        }
        operandKinds.push(operand < 0 ? signedOperand : unsignedOperand);
        operandWords.push(operand >>> 0);
      }
    }
  }

  const orderedConstructors = [...module.constructorTags].sort(
    ([left], [right]) => compareStrings(left, right),
  );
  return {
    schemaVersion: flatFcgSchemaVersion,
    stringBytes: new Uint8Array(stringBytes),
    stringStarts: new Uint32Array(stringStarts),
    stringLengths: new Uint32Array(stringLengths),
    functionNameIds: new Uint32Array(functionNameIds),
    functionParameterStarts: new Uint32Array(functionParameterStarts),
    functionParameterCounts: new Uint32Array(functionParameterCounts),
    functionLocalCounts: new Uint32Array(functionLocalCounts),
    functionOperationStarts: new Uint32Array(functionOperationStarts),
    functionOperationCounts: new Uint32Array(functionOperationCounts),
    parameterNameIds: new Uint32Array(parameterNameIds),
    operationOpcodeIds: new Uint32Array(operationOpcodeIds),
    operationOperandStarts: new Uint32Array(operationOperandStarts),
    operationOperandCounts: new Uint32Array(operationOperandCounts),
    operationSourceStarts: new Uint32Array(operationSourceStarts),
    operationRegionIds: new Uint32Array(operationRegionIds),
    operandKinds: new Uint32Array(operandKinds),
    operandWords: new Uint32Array(operandWords),
    constructorNameIds: new Uint32Array(
      orderedConstructors.map(([name]) => requiredStringId(stringIds, name)),
    ),
    constructorTags: new Uint32Array(
      orderedConstructors.map(([, tag]) =>
        unsignedWord(tag, "constructor tag")
      ),
    ),
  };
}

export function inflateFlatFcgPackage(package_: FlatFcgPackage): FcgModule {
  const strings = validateFlatFcgPackage(package_);
  const functions = Array.from(
    package_.functionNameIds,
    (nameId, functionIndex) => {
      const operationStart = package_.functionOperationStarts[functionIndex];
      const operationCount = package_.functionOperationCounts[functionIndex];
      const parameterStart = package_.functionParameterStarts[functionIndex];
      const parameterCount = package_.functionParameterCounts[functionIndex];
      return {
        name: strings[nameId],
        parameters: Array.from(
          package_.parameterNameIds.subarray(
            parameterStart,
            parameterStart + parameterCount,
          ),
          (parameterNameId) => strings[parameterNameId],
        ),
        localCount: package_.functionLocalCounts[functionIndex],
        operations: Array.from(
          { length: operationCount },
          (_, relativeOperationIndex): FcgOperation => {
            const operationIndex = operationStart + relativeOperationIndex;
            const operandStart =
              package_.operationOperandStarts[operationIndex];
            const operandCount =
              package_.operationOperandCounts[operationIndex];
            return {
              opcode: strings[package_.operationOpcodeIds[operationIndex]],
              operands: Array.from(
                { length: operandCount },
                (_, relativeOperandIndex) => {
                  const operandIndex = operandStart + relativeOperandIndex;
                  const word = package_.operandWords[operandIndex];
                  const kind = package_.operandKinds[operandIndex];
                  if (kind === stringOperand) return strings[word];
                  return kind === signedOperand ? word | 0 : word;
                },
              ),
              sourceStart: package_.operationSourceStarts[operationIndex],
              regionId: package_.operationRegionIds[operationIndex],
            };
          },
        ),
      };
    },
  );
  const constructorTags = new Map(
    Array.from(package_.constructorNameIds, (nameId, index) => [
      strings[nameId],
      package_.constructorTags[index],
    ]),
  );
  return { functions, constructorTags };
}

export function validateFlatFcgPackage(
  package_: FlatFcgPackage,
): readonly string[] {
  if (package_.schemaVersion !== flatFcgSchemaVersion) {
    throw new TypeError(
      `flat FCG schema version must be ${flatFcgSchemaVersion}; received ${package_.schemaVersion}`,
    );
  }
  requireEqualLengths(
    "string range",
    package_.stringStarts,
    package_.stringLengths,
  );
  requireEqualLengths(
    "function",
    package_.functionNameIds,
    package_.functionParameterStarts,
    package_.functionParameterCounts,
    package_.functionLocalCounts,
    package_.functionOperationStarts,
    package_.functionOperationCounts,
  );
  requireEqualLengths(
    "operation",
    package_.operationOpcodeIds,
    package_.operationOperandStarts,
    package_.operationOperandCounts,
    package_.operationSourceStarts,
    package_.operationRegionIds,
  );
  requireEqualLengths(
    "operand",
    package_.operandKinds,
    package_.operandWords,
  );
  requireEqualLengths(
    "constructor",
    package_.constructorNameIds,
    package_.constructorTags,
  );

  let expectedStringStart = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const strings = Array.from(
    package_.stringStarts,
    (start, stringIndex) => {
      const length = package_.stringLengths[stringIndex];
      requireContiguousRange(
        "string",
        stringIndex,
        start,
        length,
        expectedStringStart,
        package_.stringBytes.length,
      );
      expectedStringStart += length;
      try {
        return decoder.decode(
          package_.stringBytes.subarray(start, start + length),
        );
      } catch (error) {
        throw new TypeError(
          `flat FCG string ${stringIndex} is not valid UTF-8: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );
  if (expectedStringStart !== package_.stringBytes.length) {
    throw new RangeError(
      `flat FCG string ranges cover ${expectedStringStart} bytes; package contains ${package_.stringBytes.length}`,
    );
  }
  for (let index = 1; index < strings.length; index += 1) {
    if (compareStrings(strings[index - 1], strings[index]) >= 0) {
      throw new TypeError(
        `flat FCG strings must be strictly ordered; string ${index - 1} is ${
          JSON.stringify(strings[index - 1])
        } and string ${index} is ${JSON.stringify(strings[index])}`,
      );
    }
  }

  validateStringIds("function name", package_.functionNameIds, strings.length);
  validateStringIds(
    "parameter name",
    package_.parameterNameIds,
    strings.length,
  );
  validateStringIds(
    "operation opcode",
    package_.operationOpcodeIds,
    strings.length,
  );
  validateStringIds(
    "constructor name",
    package_.constructorNameIds,
    strings.length,
  );
  validateContiguousRanges(
    "function parameter",
    package_.functionParameterStarts,
    package_.functionParameterCounts,
    package_.parameterNameIds.length,
  );
  validateContiguousRanges(
    "function operation",
    package_.functionOperationStarts,
    package_.functionOperationCounts,
    package_.operationOpcodeIds.length,
  );
  validateContiguousRanges(
    "operation operand",
    package_.operationOperandStarts,
    package_.operationOperandCounts,
    package_.operandKinds.length,
  );
  for (const [operandIndex, kind] of package_.operandKinds.entries()) {
    if (
      kind !== signedOperand && kind !== unsignedOperand &&
      kind !== stringOperand
    ) {
      throw new TypeError(
        `flat FCG operand ${operandIndex} has unknown kind ${kind}`,
      );
    }
    if (
      kind === stringOperand &&
      package_.operandWords[operandIndex] >= strings.length
    ) {
      throw new RangeError(
        `flat FCG operand ${operandIndex} uses string ID ${
          package_.operandWords[operandIndex]
        }; package contains ${strings.length} strings`,
      );
    }
  }
  for (let index = 1; index < package_.constructorNameIds.length; index += 1) {
    const previous = strings[package_.constructorNameIds[index - 1]];
    const current = strings[package_.constructorNameIds[index]];
    if (compareStrings(previous, current) >= 0) {
      throw new TypeError(
        `flat FCG constructors must be strictly ordered; constructor ${
          index - 1
        } is ${JSON.stringify(previous)} and constructor ${index} is ${
          JSON.stringify(current)
        }`,
      );
    }
  }
  return strings;
}

function requiredStringId(
  stringIds: ReadonlyMap<string, number>,
  value: string,
): number {
  const id = stringIds.get(value);
  if (id === undefined) {
    throw new Error(`internal error: flat FCG string table omitted ${value}`);
  }
  return id;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unsignedWord(value: number, subject: string): number {
  if (
    !Number.isSafeInteger(value) || value < 0 || value > maximumUnsignedWord
  ) {
    throw new RangeError(
      `FCG ${subject} must fit a u32 word; received ${value}`,
    );
  }
  return value;
}

function requireEqualLengths(
  subject: string,
  first: ArrayLike<unknown>,
  ...remaining: readonly ArrayLike<unknown>[]
): void {
  for (const column of remaining) {
    if (column.length !== first.length) {
      throw new RangeError(
        `flat FCG ${subject} columns must have equal lengths; received ${first.length} and ${column.length}`,
      );
    }
  }
}

function validateStringIds(
  subject: string,
  ids: Uint32Array,
  stringCount: number,
): void {
  for (const [index, id] of ids.entries()) {
    if (id >= stringCount) {
      throw new RangeError(
        `flat FCG ${subject} ${index} uses string ID ${id}; package contains ${stringCount} strings`,
      );
    }
  }
}

function validateContiguousRanges(
  subject: string,
  starts: Uint32Array,
  counts: Uint32Array,
  valueCount: number,
): void {
  let expectedStart = 0;
  for (const [index, start] of starts.entries()) {
    const count = counts[index];
    requireContiguousRange(
      subject,
      index,
      start,
      count,
      expectedStart,
      valueCount,
    );
    expectedStart += count;
  }
  if (expectedStart !== valueCount) {
    throw new RangeError(
      `flat FCG ${subject} ranges cover ${expectedStart} values; column contains ${valueCount}`,
    );
  }
}

function requireContiguousRange(
  subject: string,
  index: number,
  start: number,
  count: number,
  expectedStart: number,
  valueCount: number,
): void {
  if (start !== expectedStart) {
    throw new RangeError(
      `flat FCG ${subject} ${index} starts at ${start}; expected contiguous start ${expectedStart}`,
    );
  }
  if (start + count > valueCount) {
    throw new RangeError(
      `flat FCG ${subject} ${index} range [${start}, ${
        start + count
      }) exceeds column length ${valueCount}`,
    );
  }
}

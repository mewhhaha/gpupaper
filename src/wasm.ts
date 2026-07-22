export class WasmModuleBuilder {
  readonly #types: number[][] = [];
  readonly #imports: number[][] = [];
  readonly #functions: number[] = [];
  readonly #exports: number[][] = [];
  readonly #codes: number[][] = [];

  addFunctionType(
    parameters: readonly number[],
    results: readonly number[],
  ): number {
    const index = this.#types.length;
    this.#types.push([
      0x60,
      ...encodeVector(parameters),
      ...encodeVector(results),
    ]);
    return index;
  }

  addFunctionImport(
    moduleName: string,
    fieldName: string,
    typeIndex: number,
  ): number {
    if (this.#functions.length !== 0) {
      throw new Error(
        `function import ${moduleName}.${fieldName} must be declared before defined functions`,
      );
    }
    const index = this.#imports.length;
    this.#imports.push([
      ...encodeName(moduleName),
      ...encodeName(fieldName),
      0x00,
      ...encodeUnsigned(typeIndex),
    ]);
    return index;
  }

  addFunction(
    typeIndex: number,
    locals: readonly number[],
    instructions: readonly number[],
  ): number {
    const functionIndex = this.#imports.length + this.#functions.length;
    this.#functions.push(typeIndex);
    const localGroups = locals.map((type) => [0x01, type]).flat();
    const body = [
      ...encodeUnsigned(locals.length),
      ...localGroups,
      ...instructions,
      0x0b,
    ];
    this.#codes.push([...encodeUnsigned(body.length), ...body]);
    return functionIndex;
  }

  exportFunction(name: string, functionIndex: number): void {
    this.#exports.push([
      ...encodeName(name),
      0x00,
      ...encodeUnsigned(functionIndex),
    ]);
  }

  finish(): Uint8Array {
    const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    if (this.#types.length > 0) {
      bytes.push(...section(1, encodeEntries(this.#types)));
    }
    if (this.#imports.length > 0) {
      bytes.push(...section(2, encodeEntries(this.#imports)));
    }
    if (this.#functions.length > 0) {
      bytes.push(
        ...section(3, encodeEntries(this.#functions.map(encodeUnsigned))),
      );
    }
    if (this.#exports.length > 0) {
      bytes.push(...section(7, encodeEntries(this.#exports)));
    }
    if (this.#codes.length > 0) {
      bytes.push(...section(10, encodeEntries(this.#codes)));
    }
    return new Uint8Array(bytes);
  }
}

export const wasmType = {
  i32: 0x7f,
} as const;

export const wasmInstruction = {
  localGet(index: number): number[] {
    return [0x20, ...encodeUnsigned(index)];
  },
  localSet(index: number): number[] {
    return [0x21, ...encodeUnsigned(index)];
  },
  call(index: number): number[] {
    return [0x10, ...encodeUnsigned(index)];
  },
  i32Constant(value: number): number[] {
    return [0x41, ...encodeSigned(value)];
  },
  i32Add: [0x6a],
  i32Subtract: [0x6b],
  i32Multiply: [0x6c],
  i32Equal: [0x46],
  i32LessThanSigned: [0x48],
  i32GreaterThanSigned: [0x4a],
  i32And: [0x71],
  i32ShiftLeft: [0x74],
  i32ShiftRightSigned: [0x75],
  ifI32: [0x04, 0x7f],
  ifVoid: [0x04, 0x40],
  else: [0x05],
  end: [0x0b],
  unreachable: [0x00],
} as const;

export function encodeUnsigned(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `unsigned LEB128 value must be a non-negative safe integer; received ${value}`,
    );
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

export function encodeSigned(value: number): number[] {
  if (
    !Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff
  ) {
    throw new RangeError(`signed LEB128 value must fit i32; received ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value | 0;
  while (true) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    const signSet = (byte & 0x40) !== 0;
    const finished = (remaining === 0 && !signSet) ||
      (remaining === -1 && signSet);
    bytes.push(finished ? byte : byte | 0x80);
    if (finished) return bytes;
  }
}

function encodeEntries(entries: readonly (readonly number[])[]): number[] {
  return [...encodeUnsigned(entries.length), ...entries.flat()];
}

function encodeVector(values: readonly number[]): number[] {
  return [...encodeUnsigned(values.length), ...values];
}

function encodeName(name: string): number[] {
  const bytes = new TextEncoder().encode(name);
  return [...encodeUnsigned(bytes.length), ...bytes];
}

function section(id: number, contents: readonly number[]): number[] {
  return [id, ...encodeUnsigned(contents.length), ...contents];
}

export type WasmAtom =
  | { readonly kind: "byte"; readonly value: number }
  | { readonly kind: "unsigned"; readonly value: number }
  | { readonly kind: "signed32"; readonly value: number }
  | { readonly kind: "signed64"; readonly value: bigint }
  | {
    readonly kind: "length";
    readonly rangeStart: number;
    readonly rangeCount: number;
    readonly dependencyLevel: number;
  };

export type WasmInstruction = Exclude<WasmAtom, { readonly kind: "length" }>;

export type WasmBinaryPlan = {
  readonly atoms: readonly WasmAtom[];
  readonly maximumDependencyLevel: number;
};

type WasmNode =
  | WasmInstruction
  | { readonly kind: "sized"; readonly contents: readonly WasmNode[] };

export class WasmModuleBuilder {
  readonly #types: WasmNode[][] = [];
  readonly #imports: WasmNode[][] = [];
  readonly #functions: number[] = [];
  readonly #exports: WasmNode[][] = [];
  readonly #exportNames = new Set<string>();
  readonly #codes: WasmNode[][] = [];
  readonly #customSections: {
    readonly name: string;
    readonly contents: Uint8Array;
  }[] = [];

  addFunctionType(
    parameters: readonly number[],
    results: readonly number[],
  ): number {
    const index = this.#types.length;
    this.#types.push([
      byte(0x60),
      ...vector(parameters.map(byte)),
      ...vector(results.map(byte)),
    ]);
    return index;
  }

  addFunctionImport(
    moduleName: string,
    fieldName: string,
    typeIndex: number,
  ): number {
    if (!Number.isSafeInteger(typeIndex) || !this.#types[typeIndex]) {
      throw new RangeError(
        `function import ${moduleName}.${fieldName} uses type index ${typeIndex}; ${this.#types.length} types are defined`,
      );
    }
    if (this.#functions.length !== 0) {
      throw new Error(
        `function import ${moduleName}.${fieldName} must be declared before defined functions`,
      );
    }
    const index = this.#imports.length;
    this.#imports.push([
      ...name(moduleName),
      ...name(fieldName),
      byte(0x00),
      unsigned(typeIndex),
    ]);
    return index;
  }

  addFunction(
    typeIndex: number,
    locals: readonly number[],
    instructions: readonly WasmInstruction[],
  ): number {
    if (!Number.isSafeInteger(typeIndex) || !this.#types[typeIndex]) {
      throw new RangeError(
        `function uses type index ${typeIndex}; ${this.#types.length} types are defined`,
      );
    }
    const functionIndex = this.#imports.length + this.#functions.length;
    this.#functions.push(typeIndex);
    const body: WasmNode[] = [
      unsigned(locals.length),
      ...locals.flatMap((type) => [unsigned(1), byte(type)]),
      ...instructions,
      byte(0x0b),
    ];
    this.#codes.push([{ kind: "sized", contents: body }]);
    return functionIndex;
  }

  exportFunction(name_: string, functionIndex: number): void {
    const functionCount = this.#imports.length + this.#functions.length;
    if (
      !Number.isSafeInteger(functionIndex) || functionIndex < 0 ||
      functionIndex >= functionCount
    ) {
      throw new RangeError(
        `export ${name_} uses function index ${functionIndex}; ${functionCount} functions are defined`,
      );
    }
    if (this.#exportNames.has(name_)) {
      throw new Error(`duplicate Wasm export ${name_}`);
    }
    this.#exportNames.add(name_);
    this.#exports.push([
      ...name(name_),
      byte(0x00),
      unsigned(functionIndex),
    ]);
  }

  addCustomSection(name_: string, contents: Uint8Array): void {
    if (name_.length === 0) {
      throw new TypeError("Wasm custom section name must not be empty");
    }
    this.#customSections.push({ name: name_, contents: contents.slice() });
  }

  finishPlan(): WasmBinaryPlan {
    const module: WasmNode[] = [
      ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00].map(byte),
    ];
    if (this.#types.length > 0) {
      module.push(...section(1, this.#types));
    }
    if (this.#imports.length > 0) {
      module.push(...section(2, this.#imports));
    }
    if (this.#functions.length > 0) {
      module.push(
        ...section(3, this.#functions.map((index) => [unsigned(index)])),
      );
    }
    if (this.#exports.length > 0) {
      module.push(...section(7, this.#exports));
    }
    if (this.#codes.length > 0) {
      module.push(...section(10, this.#codes));
    }
    for (const customSection of this.#customSections) {
      module.push(
        byte(0),
        {
          kind: "sized",
          contents: [
            ...name(customSection.name),
            ...Array.from(customSection.contents, byte),
          ],
        },
      );
    }
    return flattenNodes(module);
  }

  finish(): Uint8Array {
    return emitWasmPlanOnCpu(this.finishPlan());
  }
}

export function emitWasmPlanOnCpu(plan: WasmBinaryPlan): Uint8Array {
  validateWasmBinaryPlan(plan);
  const encoded = new Array<readonly number[]>(plan.atoms.length);
  for (let level = 0; level <= plan.maximumDependencyLevel; level += 1) {
    for (const [atomIndex, atom] of plan.atoms.entries()) {
      if (atom.kind === "length") {
        if (atom.dependencyLevel !== level) continue;
        let byteLength = 0;
        for (
          let dependencyIndex = atom.rangeStart;
          dependencyIndex < atom.rangeStart + atom.rangeCount;
          dependencyIndex += 1
        ) {
          const dependency = encoded[dependencyIndex];
          if (dependency === undefined) {
            throw new Error(
              `Wasm length atom ${atomIndex} at level ${level} depends on unresolved atom ${dependencyIndex}`,
            );
          }
          byteLength += dependency.length;
        }
        encoded[atomIndex] = encodeUnsigned(byteLength);
        continue;
      }
      if (level !== 0) continue;
      encoded[atomIndex] = atom.kind === "byte"
        ? [atom.value]
        : atom.kind === "unsigned"
        ? encodeUnsigned(atom.value)
        : atom.kind === "signed32"
        ? encodeSigned(atom.value)
        : encodeSigned64(atom.value);
    }
  }
  const byteLength = encoded.reduce((total, atom, atomIndex) => {
    if (atom === undefined) {
      throw new Error(`Wasm atom ${atomIndex} was not resolved`);
    }
    const next = total + atom.length;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(
        `Wasm plan byte length overflowed at atom ${atomIndex}; partial length ${total}, atom length ${atom.length}`,
      );
    }
    return next;
  }, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const atom of encoded) {
    bytes.set(atom, offset);
    offset += atom.length;
  }
  return bytes;
}

export function validateWasmBinaryPlan(plan: WasmBinaryPlan): void {
  if (plan.atoms.length === 0) {
    throw new TypeError("Wasm binary plan must contain at least one atom");
  }
  if (
    !Number.isSafeInteger(plan.maximumDependencyLevel) ||
    plan.maximumDependencyLevel < 0
  ) {
    throw new RangeError(
      `Wasm plan maximum dependency level must be a non-negative integer; received ${plan.maximumDependencyLevel}`,
    );
  }
  let maximumDependencyLevel = 0;
  for (const [atomIndex, atom] of plan.atoms.entries()) {
    if (atom.kind === "byte") {
      if (
        !Number.isSafeInteger(atom.value) || atom.value < 0 ||
        atom.value > 0xff
      ) {
        throw new RangeError(
          `Wasm byte atom ${atomIndex} must fit u8; received ${atom.value}`,
        );
      }
      continue;
    }
    if (atom.kind === "unsigned") {
      if (
        !Number.isSafeInteger(atom.value) || atom.value < 0 ||
        atom.value > 0xffff_ffff
      ) {
        throw new RangeError(
          `Wasm unsigned atom ${atomIndex} must fit u32; received ${atom.value}`,
        );
      }
      continue;
    }
    if (atom.kind === "signed32") {
      requireSigned32(atom.value);
      continue;
    }
    if (atom.kind === "signed64") {
      requireSigned64(atom.value);
      continue;
    }
    const rangeEnd = atom.rangeStart + atom.rangeCount;
    if (
      !Number.isSafeInteger(atom.rangeStart) || atom.rangeStart < 0 ||
      !Number.isSafeInteger(atom.rangeCount) || atom.rangeCount < 0 ||
      !Number.isSafeInteger(rangeEnd) || rangeEnd > plan.atoms.length
    ) {
      throw new RangeError(
        `Wasm length atom ${atomIndex} range [${atom.rangeStart}, ${rangeEnd}) is outside ${plan.atoms.length} atoms`,
      );
    }
    if (
      !Number.isSafeInteger(atom.dependencyLevel) ||
      atom.dependencyLevel < 1
    ) {
      throw new RangeError(
        `Wasm length atom ${atomIndex} dependency level must be positive; received ${atom.dependencyLevel}`,
      );
    }
    for (
      let dependencyIndex = atom.rangeStart;
      dependencyIndex < rangeEnd;
      dependencyIndex += 1
    ) {
      const dependency = plan.atoms[dependencyIndex];
      const dependencyLevel = dependency.kind === "length"
        ? dependency.dependencyLevel
        : 0;
      if (dependencyLevel >= atom.dependencyLevel) {
        throw new RangeError(
          `Wasm length atom ${atomIndex} at level ${atom.dependencyLevel} depends on atom ${dependencyIndex} at level ${dependencyLevel}`,
        );
      }
    }
    maximumDependencyLevel = Math.max(
      maximumDependencyLevel,
      atom.dependencyLevel,
    );
  }
  if (maximumDependencyLevel !== plan.maximumDependencyLevel) {
    throw new RangeError(
      `Wasm plan declares maximum dependency level ${plan.maximumDependencyLevel}; atoms require ${maximumDependencyLevel}`,
    );
  }
}

export const wasmType = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
} as const;

const instruction = (opcode: number): readonly WasmInstruction[] => [
  byte(opcode),
];

export const wasmInstruction = {
  localGet(index: number): readonly WasmInstruction[] {
    return [byte(0x20), unsigned(index)];
  },
  localSet(index: number): readonly WasmInstruction[] {
    return [byte(0x21), unsigned(index)];
  },
  call(index: number): readonly WasmInstruction[] {
    return [byte(0x10), unsigned(index)];
  },
  return: instruction(0x0f),
  drop: instruction(0x1a),
  i32Constant(value: number): readonly WasmInstruction[] {
    requireSigned32(value);
    return [byte(0x41), { kind: "signed32", value }];
  },
  i64Constant(value: bigint): readonly WasmInstruction[] {
    requireSigned64(value);
    return [byte(0x42), { kind: "signed64", value }];
  },
  f32Constant(value: number): readonly WasmInstruction[] {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    return [byte(0x43), ...Array.from(bytes, byte)];
  },
  f64Constant(value: number): readonly WasmInstruction[] {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return [byte(0x44), ...Array.from(bytes, byte)];
  },
  i32Add: instruction(0x6a),
  i32Subtract: instruction(0x6b),
  i32Multiply: instruction(0x6c),
  i32DivideSigned: instruction(0x6d),
  i32RemainderSigned: instruction(0x6f),
  i32Equal: instruction(0x46),
  i32NotEqual: instruction(0x47),
  i32LessThanSigned: instruction(0x48),
  i32GreaterThanSigned: instruction(0x4a),
  i32LessThanOrEqualSigned: instruction(0x4c),
  i32GreaterThanOrEqualSigned: instruction(0x4e),
  i32And: instruction(0x71),
  i32Or: instruction(0x72),
  i32Xor: instruction(0x73),
  i32ShiftLeft: instruction(0x74),
  i32ShiftRightSigned: instruction(0x75),
  i32ShiftRightUnsigned: instruction(0x76),
  i64Add: instruction(0x7c),
  i64Subtract: instruction(0x7d),
  i64Multiply: instruction(0x7e),
  i64DivideSigned: instruction(0x7f),
  i64RemainderSigned: instruction(0x81),
  i64Equal: instruction(0x51),
  i64NotEqual: instruction(0x52),
  i64LessThanSigned: instruction(0x53),
  i64GreaterThanSigned: instruction(0x55),
  i64LessThanOrEqualSigned: instruction(0x57),
  i64GreaterThanOrEqualSigned: instruction(0x59),
  i64And: instruction(0x83),
  i64Or: instruction(0x84),
  i64Xor: instruction(0x85),
  i64ShiftLeft: instruction(0x86),
  i64ShiftRightUnsigned: instruction(0x88),
  f32Equal: instruction(0x5b),
  f32NotEqual: instruction(0x5c),
  f32LessThan: instruction(0x5d),
  f32GreaterThan: instruction(0x5e),
  f32LessThanOrEqual: instruction(0x5f),
  f32GreaterThanOrEqual: instruction(0x60),
  f64Equal: instruction(0x61),
  f64NotEqual: instruction(0x62),
  f64LessThan: instruction(0x63),
  f64GreaterThan: instruction(0x64),
  f64LessThanOrEqual: instruction(0x65),
  f64GreaterThanOrEqual: instruction(0x66),
  f32SquareRoot: instruction(0x91),
  f32Add: instruction(0x92),
  f32Subtract: instruction(0x93),
  f32Multiply: instruction(0x94),
  f32Divide: instruction(0x95),
  f64SquareRoot: instruction(0x9f),
  f64Add: instruction(0xa0),
  f64Subtract: instruction(0xa1),
  f64Multiply: instruction(0xa2),
  f64Divide: instruction(0xa3),
  i32TruncateF32Signed: instruction(0xa8),
  i32TruncateF64Signed: instruction(0xaa),
  i32WrapI64: instruction(0xa7),
  i64ExtendI32Signed: instruction(0xac),
  i64ExtendI32Unsigned: instruction(0xad),
  f32ConvertI32Signed: instruction(0xb2),
  f64ConvertI32Signed: instruction(0xb7),
  ifI32: [byte(0x04), byte(0x7f)],
  ifI64: [byte(0x04), byte(0x7e)],
  ifF32: [byte(0x04), byte(0x7d)],
  ifF64: [byte(0x04), byte(0x7c)],
  ifVoid: [byte(0x04), byte(0x40)],
  else: instruction(0x05),
  end: instruction(0x0b),
  unreachable: instruction(0x00),
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
    let encodedByte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) encodedByte |= 0x80;
    bytes.push(encodedByte);
  } while (remaining !== 0);
  return bytes;
}

export function encodeSigned(value: number): number[] {
  requireSigned32(value);
  const bytes: number[] = [];
  let remaining = value | 0;
  while (true) {
    const encodedByte = remaining & 0x7f;
    remaining >>= 7;
    const signSet = (encodedByte & 0x40) !== 0;
    const finished = (remaining === 0 && !signSet) ||
      (remaining === -1 && signSet);
    bytes.push(finished ? encodedByte : encodedByte | 0x80);
    if (finished) return bytes;
  }
}

export function encodeSigned64(value: bigint): number[] {
  requireSigned64(value);
  const bytes: number[] = [];
  let remaining = value;
  while (true) {
    const encodedByte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    const signSet = (encodedByte & 0x40) !== 0;
    const finished = (remaining === 0n && !signSet) ||
      (remaining === -1n && signSet);
    bytes.push(finished ? encodedByte : encodedByte | 0x80);
    if (finished) return bytes;
  }
}

function byte(value: number): WasmInstruction {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`Wasm byte must fit u8; received ${value}`);
  }
  return { kind: "byte", value };
}

function unsigned(value: number): WasmInstruction {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`Wasm unsigned value must fit u32; received ${value}`);
  }
  return { kind: "unsigned", value };
}

function vector(values: readonly WasmNode[]): readonly WasmNode[] {
  return [unsigned(values.length), ...values];
}

function name(value: string): readonly WasmNode[] {
  const bytes = new TextEncoder().encode(value);
  return [unsigned(bytes.length), ...Array.from(bytes, byte)];
}

function section(
  id: number,
  entries: readonly (readonly WasmNode[])[],
): readonly WasmNode[] {
  return [
    byte(id),
    {
      kind: "sized",
      contents: [
        unsigned(entries.length),
        ...entries.flat(),
      ],
    },
  ];
}

function flattenNodes(nodes: readonly WasmNode[]): WasmBinaryPlan {
  const atoms: WasmAtom[] = [];
  let maximumDependencyLevel = 0;
  const append = (node: WasmNode): number => {
    if (node.kind !== "sized") {
      atoms.push(node);
      return 0;
    }
    const atomIndex = atoms.length;
    atoms.push({
      kind: "length",
      rangeStart: 0,
      rangeCount: 0,
      dependencyLevel: 0,
    });
    const rangeStart = atoms.length;
    let childLevel = 0;
    for (const child of node.contents) {
      childLevel = Math.max(childLevel, append(child));
    }
    const dependencyLevel = childLevel + 1;
    atoms[atomIndex] = {
      kind: "length",
      rangeStart,
      rangeCount: atoms.length - rangeStart,
      dependencyLevel,
    };
    maximumDependencyLevel = Math.max(
      maximumDependencyLevel,
      dependencyLevel,
    );
    return dependencyLevel;
  };
  for (const node of nodes) append(node);
  return { atoms, maximumDependencyLevel };
}

function requireSigned32(value: number): void {
  if (
    !Number.isSafeInteger(value) || value < -0x8000_0000 ||
    value > 0x7fff_ffff
  ) {
    throw new RangeError(`signed LEB128 value must fit i32; received ${value}`);
  }
}

function requireSigned64(value: bigint): void {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) {
    throw new RangeError(`signed LEB128 value must fit i64; received ${value}`);
  }
}

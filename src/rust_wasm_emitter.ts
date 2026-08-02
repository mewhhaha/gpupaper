import type { WasmAtom, WasmBinaryPlan } from "./wasm.ts";

export type RustWasmEmitterInitializationTimings = {
  readonly totalMilliseconds: number;
  readonly moduleReadMilliseconds: number;
  readonly moduleCompilationMilliseconds: number;
  readonly instantiationMilliseconds: number;
};

export type RustWasmPlanPreparationTimings = {
  readonly totalMilliseconds: number;
  readonly serializationMilliseconds: number;
  readonly copyValidationAndEncodingMilliseconds: number;
  readonly inputBytes: number;
};

export type RustWasmEmissionTimings = {
  readonly totalMilliseconds: number;
  readonly rustExecutionMilliseconds: number;
  readonly ownedOutputCopyMilliseconds: number;
};

export type RustWasmEmission = {
  readonly bytes: Uint8Array;
  readonly timings: RustWasmEmissionTimings;
};

export type RustWasmColdEmission = RustWasmEmission & {
  readonly preparationTimings: RustWasmPlanPreparationTimings;
};

export type RustWasmEmitterInitialization = {
  readonly emitter: RustWasmEmitter;
  readonly timings: RustWasmEmitterInitializationTimings;
  readonly moduleBytes: number;
};

type RustWasmExports = {
  readonly memory: WebAssembly.Memory;
  readonly abi_version: () => number;
  readonly input_resize: (wordCount: number) => number;
  readonly prepare_plan: (
    atomCount: number,
    declaredMaximumLevel: number,
  ) => number;
  readonly emit_plan: (handle: number) => number;
  readonly release_plan: (handle: number) => number;
  readonly output_ptr: () => number;
  readonly output_len: () => number;
  readonly last_error_ptr: () => number;
  readonly last_error_len: () => number;
};

const atomWordCount = 4;
const atomRecordBytes = atomWordCount * Uint32Array.BYTES_PER_ELEMENT;
const errorHandle = 0xffff_ffff;
const hostIsLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const emitterModuleUrl = new URL(
  "./generated/rust_wasm_emitter.wasm",
  import.meta.url,
);
let sharedEmitterInitialization:
  | Promise<RustWasmEmitterInitialization>
  | undefined;

export class RustWasmEmitter {
  readonly #exports: RustWasmExports;

  constructor(exports: RustWasmExports) {
    this.#exports = exports;
  }

  prepare(plan: WasmBinaryPlan): RustWasmResidentPlan {
    const totalStart = performance.now();
    const serializationStart = performance.now();
    const columns = serializeWasmPlan(plan);
    const serializationMilliseconds = performance.now() - serializationStart;
    const copyStart = performance.now();
    const inputPointer = this.#exports.input_resize(columns.length) >>> 0;
    writeInputWords(this.#exports.memory, inputPointer, columns);
    const handle = this.#exports.prepare_plan(
      plan.atoms.length,
      plan.maximumDependencyLevel,
    ) >>> 0;
    if (handle === errorHandle) throw this.#error("plan preparation");
    const copyValidationAndEncodingMilliseconds = performance.now() -
      copyStart;
    return new RustWasmResidentPlan(this, handle, {
      totalMilliseconds: performance.now() - totalStart,
      serializationMilliseconds,
      copyValidationAndEncodingMilliseconds,
      inputBytes: columns.byteLength,
    });
  }

  emit(plan: WasmBinaryPlan): RustWasmColdEmission {
    const resident = this.prepare(plan);
    try {
      return {
        ...resident.emit(),
        preparationTimings: resident.preparationTimings,
      };
    } finally {
      resident.release();
    }
  }

  emitHandle(handle: number): RustWasmEmission {
    const totalStart = performance.now();
    const executionStart = performance.now();
    if (this.#exports.emit_plan(handle) !== 0) {
      throw this.#error(`emission for handle ${handle}`);
    }
    const rustExecutionMilliseconds = performance.now() - executionStart;
    const copyStart = performance.now();
    const output = requireMemoryRange(
      this.#exports.memory,
      this.#exports.output_ptr() >>> 0,
      this.#exports.output_len() >>> 0,
      "Rust/Wasm output",
    ).slice();
    const ownedOutputCopyMilliseconds = performance.now() - copyStart;
    return {
      bytes: output,
      timings: {
        totalMilliseconds: performance.now() - totalStart,
        rustExecutionMilliseconds,
        ownedOutputCopyMilliseconds,
      },
    };
  }

  releaseHandle(handle: number): void {
    if (this.#exports.release_plan(handle) !== 0) {
      throw this.#error(`release for handle ${handle}`);
    }
  }

  #error(operation: string): Error {
    const message = new TextDecoder().decode(requireMemoryRange(
      this.#exports.memory,
      this.#exports.last_error_ptr() >>> 0,
      this.#exports.last_error_len() >>> 0,
      "Rust/Wasm error",
    ));
    return new Error(
      `Rust/Wasm emitter ${operation} failed: ${
        message || "unknown module error"
      }`,
    );
  }
}

export class RustWasmResidentPlan {
  readonly preparationTimings: RustWasmPlanPreparationTimings;
  readonly #emitter: RustWasmEmitter;
  readonly #handle: number;
  #released = false;

  constructor(
    emitter: RustWasmEmitter,
    handle: number,
    preparationTimings: RustWasmPlanPreparationTimings,
  ) {
    this.#emitter = emitter;
    this.#handle = handle;
    this.preparationTimings = preparationTimings;
  }

  get released(): boolean {
    return this.#released;
  }

  emit(): RustWasmEmission {
    if (this.#released) {
      throw new Error("Rust/Wasm resident plan cannot emit after release");
    }
    return this.#emitter.emitHandle(this.#handle);
  }

  release(): void {
    if (this.#released) {
      throw new Error("Rust/Wasm resident plan has already been released");
    }
    this.#emitter.releaseHandle(this.#handle);
    this.#released = true;
  }
}

export async function createRustWasmEmitter(): Promise<
  RustWasmEmitterInitialization
> {
  const totalStart = performance.now();
  const readStart = performance.now();
  const bytes = await Deno.readFile(emitterModuleUrl);
  const moduleReadMilliseconds = performance.now() - readStart;
  const compilationStart = performance.now();
  const module = await WebAssembly.compile(bytes as BufferSource);
  const moduleCompilationMilliseconds = performance.now() - compilationStart;
  const instantiationStart = performance.now();
  const instance = await WebAssembly.instantiate(module);
  const instantiationMilliseconds = performance.now() - instantiationStart;
  const exports = requireRustWasmExports(instance.exports);
  const abiVersion = exports.abi_version() >>> 0;
  if (abiVersion !== 2) {
    throw new Error(`Rust/Wasm emitter ABI must be 2; received ${abiVersion}`);
  }
  return {
    emitter: new RustWasmEmitter(exports),
    timings: {
      totalMilliseconds: performance.now() - totalStart,
      moduleReadMilliseconds,
      moduleCompilationMilliseconds,
      instantiationMilliseconds,
    },
    moduleBytes: bytes.byteLength,
  };
}

export async function emitWasmPlanOnRustWasm(
  plan: WasmBinaryPlan,
): Promise<RustWasmColdEmission> {
  if (sharedEmitterInitialization === undefined) {
    const initialization = createRustWasmEmitter();
    sharedEmitterInitialization = initialization;
    void initialization.catch(() => {
      if (sharedEmitterInitialization === initialization) {
        sharedEmitterInitialization = undefined;
      }
    });
  }
  const { emitter } = await sharedEmitterInitialization;
  return emitter.emit(plan);
}

function serializeWasmPlan(plan: WasmBinaryPlan): Uint32Array {
  if (plan.atoms.length === 0) {
    throw new TypeError("Rust/Wasm plan must contain at least one atom");
  }
  if (plan.atoms.length > 0xffff_ffff) {
    throw new RangeError(
      `Rust/Wasm plan has ${plan.atoms.length} atoms; maximum is 4294967295`,
    );
  }
  requireUnsignedWord(
    plan.maximumDependencyLevel,
    "Rust/Wasm maximum dependency level",
  );
  const byteLength = plan.atoms.length * atomRecordBytes;
  if (!Number.isSafeInteger(byteLength) || byteLength > 0xffff_ffff) {
    throw new RangeError(
      `Rust/Wasm plan has ${byteLength} column bytes for ${plan.atoms.length} atoms; the memory32 ABI maximum is 4294967295`,
    );
  }
  const words = new Uint32Array(plan.atoms.length * atomWordCount);
  for (const [atomIndex, atom] of plan.atoms.entries()) {
    serializeAtom(words, plan.atoms.length, atom, atomIndex);
  }
  return words;
}

function serializeAtom(
  words: Uint32Array,
  atomCount: number,
  atom: WasmAtom,
  atomIndex: number,
): void {
  const firstOffset = atomCount + atomIndex;
  const secondOffset = atomCount * 2 + atomIndex;
  const thirdOffset = atomCount * 3 + atomIndex;
  if (atom.kind === "byte") {
    if (
      !Number.isSafeInteger(atom.value) || atom.value < 0 || atom.value > 0xff
    ) {
      throw new RangeError(
        `Rust/Wasm byte atom ${atomIndex} must fit u8; received ${atom.value}`,
      );
    }
    words[atomIndex] = 0;
    words[firstOffset] = atom.value;
    return;
  }
  if (atom.kind === "unsigned") {
    requireUnsignedWord(atom.value, `Rust/Wasm unsigned atom ${atomIndex}`);
    words[atomIndex] = 1;
    words[firstOffset] = atom.value;
    return;
  }
  if (atom.kind === "signed32") {
    if (
      !Number.isSafeInteger(atom.value) || atom.value < -0x8000_0000 ||
      atom.value > 0x7fff_ffff
    ) {
      throw new RangeError(
        `Rust/Wasm signed32 atom ${atomIndex} must fit i32; received ${atom.value}`,
      );
    }
    words[atomIndex] = 2;
    words[firstOffset] = atom.value >>> 0;
    return;
  }
  if (atom.kind === "signed64") {
    if (BigInt.asIntN(64, atom.value) !== atom.value) {
      throw new RangeError(
        `Rust/Wasm signed64 atom ${atomIndex} must fit i64; received ${atom.value}`,
      );
    }
    const bits = BigInt.asUintN(64, atom.value);
    words[atomIndex] = 3;
    words[firstOffset] = Number(bits & 0xffff_ffffn);
    words[secondOffset] = Number(bits >> 32n);
    return;
  }
  requireUnsignedWord(
    atom.rangeStart,
    `Rust/Wasm length atom ${atomIndex} range start`,
  );
  requireUnsignedWord(
    atom.rangeCount,
    `Rust/Wasm length atom ${atomIndex} range count`,
  );
  requireUnsignedWord(
    atom.dependencyLevel,
    `Rust/Wasm length atom ${atomIndex} dependency level`,
  );
  words[atomIndex] = 4;
  words[firstOffset] = atom.rangeStart;
  words[secondOffset] = atom.rangeCount;
  words[thirdOffset] = atom.dependencyLevel;
}

function writeInputWords(
  memory: WebAssembly.Memory,
  pointer: number,
  words: Uint32Array,
): void {
  const input = requireMemoryRange(
    memory,
    pointer,
    words.byteLength,
    "Rust/Wasm input",
  );
  if (hostIsLittleEndian) {
    new Uint32Array(input.buffer, input.byteOffset, words.length).set(words);
    return;
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (const [wordIndex, word] of words.entries()) {
    view.setUint32(wordIndex * Uint32Array.BYTES_PER_ELEMENT, word, true);
  }
}

function requireUnsignedWord(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${subject} must fit u32; received ${value}`);
  }
}

function requireMemoryRange(
  memory: WebAssembly.Memory,
  pointer: number,
  byteLength: number,
  subject: string,
): Uint8Array {
  const end = pointer + byteLength;
  if (
    !Number.isSafeInteger(pointer) || pointer < 0 ||
    !Number.isSafeInteger(byteLength) || byteLength < 0 ||
    !Number.isSafeInteger(end) || end > memory.buffer.byteLength
  ) {
    throw new RangeError(
      `${subject} range [${pointer}, ${end}) is outside ${memory.buffer.byteLength} bytes`,
    );
  }
  return new Uint8Array(memory.buffer, pointer, byteLength);
}

function requireRustWasmExports(
  exports: WebAssembly.Exports,
): RustWasmExports {
  const requiredFunctions = [
    "abi_version",
    "input_resize",
    "prepare_plan",
    "emit_plan",
    "release_plan",
    "output_ptr",
    "output_len",
    "last_error_ptr",
    "last_error_len",
  ] as const;
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new TypeError("Rust/Wasm emitter does not export linear memory");
  }
  for (const name of requiredFunctions) {
    if (typeof exports[name] !== "function") {
      throw new TypeError(`Rust/Wasm emitter does not export function ${name}`);
    }
  }
  return exports as unknown as RustWasmExports;
}

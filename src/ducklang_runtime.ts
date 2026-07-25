import type {
  DucklangAbiEffectOperation,
  DucklangAbiValueType,
  DucklangManagedAbi,
} from "./ducklang_abi.ts";
import {
  ducklangRuntimeImportModule,
  PrimitiveId,
  primitiveRuntimeImportName,
} from "./ducklang_primitives.ts";

export type DucklangRuntimeValue =
  | number
  | bigint
  | boolean
  | string
  | undefined
  | Uint8Array
  | DucklangRuntimeList
  | DucklangRuntimeRecord;

export interface DucklangRuntimeList
  extends ReadonlyArray<DucklangRuntimeValue> {}

export interface DucklangRuntimeRecord {
  readonly [field: string]: DucklangRuntimeValue;
}

export type DucklangHostOperation = (
  ...arguments_: readonly DucklangRuntimeValue[]
) => DucklangRuntimeValue;

export type DucklangHostEffects = Readonly<
  Record<string, Readonly<Record<string, DucklangHostOperation>>>
>;

export type DucklangManagedProgram = {
  readonly wasm: Uint8Array;
  readonly abi: DucklangManagedAbi;
};

export type DucklangRuntimeHeap = {
  readonly texts: Map<number, string>;
  readonly bytes: Map<number, Uint8Array>;
  readonly products: Map<number, readonly (number | bigint)[]>;
  readonly sums: Map<
    number,
    { readonly tag: number; readonly payload: number | bigint }
  >;
  readonly allocateHandle: () => number;
};

export function createDucklangRuntimeHeap(
  textLiterals: readonly string[] = [],
): DucklangRuntimeHeap {
  const texts = new Map<number, string>(
    textLiterals.map((value, index) => [index + 1, value]),
  );
  let nextHandle = textLiterals.length + 1;
  return {
    texts,
    bytes: new Map(),
    products: new Map(),
    sums: new Map(),
    allocateHandle: () => {
      const handle = nextHandle;
      nextHandle += 1;
      return handle;
    },
  };
}

export async function runDucklangManaged(
  program: DucklangManagedProgram,
  init: DucklangHostEffects,
): Promise<Readonly<Record<string, DucklangRuntimeValue>>> {
  const heap = createDucklangRuntimeHeap(program.abi.textLiterals);
  const imports: WebAssembly.Imports = {};
  imports[ducklangRuntimeImportModule] = createDucklangRuntimeImports(heap);
  const requirements = new Map(
    [
      ...program.abi.requirements.module,
      ...Object.values(program.abi.requirements.functions).flat(),
    ].map((requirement) => [
      `${requirement.effectName}.${requirement.operationName}`,
      requirement,
    ]),
  );
  for (const requirement of requirements.values()) {
    const initField = program.abi.init.find((field) =>
      field.effectName === requirement.effectName
    );
    if (initField === undefined) {
      throw new TypeError(
        `Ducklang ABI effect ${requirement.effectName}.${requirement.operationName} has no Init capability`,
      );
    }
    const effectObject = init[initField.fieldName];
    if (effectObject === undefined) {
      throw new TypeError(
        `Ducklang runtime requires Init field ${initField.fieldName} for effect ${requirement.effectName}`,
      );
    }
    const hostOperation = effectObject[requirement.operationName];
    if (hostOperation === undefined) {
      throw new TypeError(
        `Ducklang runtime Init field ${initField.fieldName} does not provide ${requirement.effectName}.${requirement.operationName}`,
      );
    }
    const operation = findOperation(program.abi, requirement);
    const moduleName = requirement.effectName[0].toLowerCase() +
      requirement.effectName.slice(1);
    const namespace = imports[moduleName] ?? {};
    namespace[requirement.operationName] = (...rawArguments: unknown[]) => {
      const arguments_ = operation.parameters.map((type, index) =>
        decodeWasmValue(
          rawArguments[index],
          type,
          program.abi,
          heap,
          `${requirement.effectName}.${requirement.operationName} argument ${
            index + 1
          }`,
        )
      );
      let result: DucklangRuntimeValue;
      try {
        result = hostOperation.apply(effectObject, arguments_);
      } catch (cause) {
        throw new Error(
          `Ducklang host operation ${requirement.effectName}.${requirement.operationName} threw`,
          { cause },
        );
      }
      if (isPromiseLike(result)) {
        throw new TypeError(
          `Ducklang host operation ${requirement.effectName}.${requirement.operationName} must return synchronously`,
        );
      }
      return encodeWasmValue(
        result,
        operation.result,
        program.abi,
        heap,
        `${requirement.effectName}.${requirement.operationName}`,
      );
    };
    imports[moduleName] = namespace;
  }

  const module = await WebAssembly.compile(
    new Uint8Array(program.wasm).buffer as ArrayBuffer,
  );
  const instance = await WebAssembly.instantiate(module, imports);
  const main = instance.exports.main;
  if (!(main instanceof Function)) {
    throw new Error("managed Ducklang module has no main export");
  }
  const rawResult = main();
  if (program.abi.exports.length === 0) return {};
  const exported = program.abi.exports[0];
  if (exported === undefined) {
    throw new Error("managed Ducklang ABI lost its declared export");
  }
  return {
    [exported.name]: decodeWasmValue(
      rawResult,
      exported.type,
      program.abi,
      heap,
      `Ducklang export ${exported.name}`,
    ),
  };
}

export function createDucklangRuntimeImports(
  heap: DucklangRuntimeHeap,
): Record<string, CallableFunction> {
  const { texts, bytes, products, sums, allocateHandle } = heap;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const requireHandle = (
    rawHandle: number,
  ): { readonly kind: "text"; readonly value: string } | {
    readonly kind: "bytes";
    readonly value: Uint8Array;
  } => {
    const text = texts.get(rawHandle);
    if (text !== undefined) return { kind: "text", value: text };
    const byteBuffer = bytes.get(rawHandle);
    if (byteBuffer !== undefined) return { kind: "bytes", value: byteBuffer };
    throw new RangeError(
      `Ducklang buffer primitive uses unknown handle ${rawHandle}`,
    );
  };
  const requireRange = (
    start: number,
    end: number,
    length: number,
  ): void => {
    if (start >= 0 && end >= start && end <= length) return;
    throw new RangeError(
      `Ducklang buffer range ${start}..${end} is outside length ${length}`,
    );
  };
  const bufferRuntime: Record<string, CallableFunction> = {
    [primitiveRuntimeImportName(PrimitiveId.bufferLength)]: (
      handle: number,
    ) => {
      const buffer = requireHandle(handle);
      return buffer.kind === "text"
        ? encoder.encode(buffer.value).length
        : buffer.value.length;
    },
    [primitiveRuntimeImportName(PrimitiveId.bufferGet)]: (
      handle: number,
      index: number,
    ) => {
      const buffer = requireHandle(handle);
      const values = buffer.kind === "text"
        ? encoder.encode(buffer.value)
        : buffer.value;
      requireRange(index, index + 1, values.length);
      return values[index];
    },
    [primitiveRuntimeImportName(PrimitiveId.bufferSet)]: (
      handle: number,
      index: number,
      value: number,
    ) => {
      const buffer = requireHandle(handle);
      if (buffer.kind !== "bytes") {
        throw new TypeError("Ducklang buffer set requires Bytes");
      }
      requireRange(index, index + 1, buffer.value.length);
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(
          `Ducklang byte value ${value} is outside 0..255`,
        );
      }
      const resultHandle = allocateHandle();
      const result = buffer.value.slice();
      result[index] = value;
      bytes.set(resultHandle, result);
      return resultHandle;
    },
    [primitiveRuntimeImportName(PrimitiveId.bytesFill)]: (
      length: number,
      value: number,
    ) => {
      if (
        !Number.isInteger(length) || length < 0 || length > 16_777_216
      ) {
        throw new RangeError(
          `Ducklang Bytes length ${length} is outside 0..16777216`,
        );
      }
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(
          `Ducklang byte value ${value} is outside 0..255`,
        );
      }
      const resultHandle = allocateHandle();
      bytes.set(resultHandle, new Uint8Array(length).fill(value));
      return resultHandle;
    },
    [primitiveRuntimeImportName(PrimitiveId.bufferSlice)]: (
      handle: number,
      start: number,
      end: number,
    ) => {
      const buffer = requireHandle(handle);
      const values = buffer.kind === "text"
        ? encoder.encode(buffer.value)
        : buffer.value;
      requireRange(start, end, values.length);
      const resultHandle = allocateHandle();
      const slice = values.slice(start, end);
      if (buffer.kind === "bytes") {
        bytes.set(resultHandle, slice);
        return resultHandle;
      }
      try {
        texts.set(resultHandle, decoder.decode(slice));
      } catch (cause) {
        throw new TypeError(
          `Ducklang Text slice ${start}..${end} splits a UTF-8 sequence`,
          { cause },
        );
      }
      return resultHandle;
    },
    [primitiveRuntimeImportName(PrimitiveId.bufferAppend)]: (
      leftHandle: number,
      rightHandle: number,
    ) => {
      const left = requireHandle(leftHandle);
      const right = requireHandle(rightHandle);
      if (left.kind !== right.kind) {
        throw new TypeError(
          `Ducklang buffer append cannot combine ${left.kind} with ${right.kind}`,
        );
      }
      const resultHandle = allocateHandle();
      if (left.kind === "text" && right.kind === "text") {
        texts.set(resultHandle, left.value + right.value);
      } else if (left.kind === "bytes" && right.kind === "bytes") {
        const result = new Uint8Array(left.value.length + right.value.length);
        result.set(left.value);
        result.set(right.value, left.value.length);
        bytes.set(resultHandle, result);
      }
      return resultHandle;
    },
    [primitiveRuntimeImportName(PrimitiveId.bufferEqual)]: (
      leftHandle: number,
      rightHandle: number,
    ) => {
      const left = requireHandle(leftHandle);
      const right = requireHandle(rightHandle);
      if (left.kind !== right.kind) return 0;
      if (left.kind === "text" && right.kind === "text") {
        return Number(left.value === right.value);
      }
      if (left.kind !== "bytes" || right.kind !== "bytes") return 0;
      return Number(
        left.value.length === right.value.length &&
          left.value.every((value, index) => value === right.value[index]),
      );
    },
    [primitiveRuntimeImportName(PrimitiveId.utf8Encode)]: (
      handle: number,
    ) => {
      const text = requireHandle(handle);
      if (text.kind !== "text") {
        throw new TypeError("Ducklang UTF-8 encode requires Text");
      }
      const resultHandle = allocateHandle();
      bytes.set(resultHandle, encoder.encode(text.value));
      return resultHandle;
    },
    [primitiveRuntimeImportName(PrimitiveId.utf8Decode)]: (
      handle: number,
    ) => {
      const byteBuffer = requireHandle(handle);
      if (byteBuffer.kind !== "bytes") {
        throw new TypeError("Ducklang UTF-8 decode requires Bytes");
      }
      const resultHandle = allocateHandle();
      try {
        texts.set(resultHandle, decoder.decode(byteBuffer.value));
      } catch (cause) {
        throw new TypeError("Ducklang UTF-8 decode received invalid bytes", {
          cause,
        });
      }
      return resultHandle;
    },
  };
  const requireProduct = (handle: number): readonly (number | bigint)[] => {
    const product = products.get(handle);
    if (product !== undefined) return product;
    throw new RangeError(
      `Ducklang aggregate operation uses unknown handle ${handle}`,
    );
  };
  return new Proxy(bufferRuntime, {
    get(runtime, property): CallableFunction | undefined {
      if (typeof property !== "string") return undefined;
      const existing = runtime[property];
      if (existing !== undefined) return existing;
      const make = /^product_make_(\d+)$/.exec(property);
      if (make !== null) {
        const arity = Number(make[1]);
        return (...values: readonly (number | bigint)[]) => {
          if (values.length !== arity) {
            throw new TypeError(
              `Ducklang product constructor expects ${arity} fields; received ${values.length}`,
            );
          }
          const handle = allocateHandle();
          products.set(handle, values);
          return handle;
        };
      }
      const project = /^product_project_(\d+)$/.exec(property);
      if (project !== null) {
        const index = Number(project[1]);
        return (handle: number) => {
          const product = requireProduct(handle);
          const value = product[index];
          if (value !== undefined) return value;
          throw new RangeError(
            `Ducklang product projection ${index} is outside arity ${product.length}`,
          );
        };
      }
      const update = /^product_update_(\d+(?:_\d+)*)$/.exec(property);
      if (update !== null) {
        const indices = update[1].split("_").map(Number);
        return (
          handle: number,
          ...values: readonly (number | bigint)[]
        ) => {
          if (values.length !== indices.length) {
            throw new TypeError(
              `Ducklang product update expects ${indices.length} values; received ${values.length}`,
            );
          }
          const product = [...requireProduct(handle)];
          indices.forEach((index, valueIndex) => {
            if (product[index] === undefined) {
              throw new RangeError(
                `Ducklang product update ${index} is outside arity ${product.length}`,
              );
            }
            product[index] = values[valueIndex];
          });
          const resultHandle = allocateHandle();
          products.set(resultHandle, product);
          return resultHandle;
        };
      }
      if (property === "product_index") {
        return (handle: number, index: number) => {
          const product = requireProduct(handle);
          const value = product[index];
          if (value !== undefined) return value;
          throw new RangeError(
            `Ducklang product index ${index} is outside arity ${product.length}`,
          );
        };
      }
      if (property === "product_index_update") {
        return (handle: number, index: number, value: number | bigint) => {
          const product = [...requireProduct(handle)];
          if (product[index] === undefined) {
            throw new RangeError(
              `Ducklang product update ${index} is outside arity ${product.length}`,
            );
          }
          product[index] = value;
          const resultHandle = allocateHandle();
          products.set(resultHandle, product);
          return resultHandle;
        };
      }
      const bytesMake = /^bytes_make_(\d+)$/.exec(property);
      if (bytesMake !== null) {
        const length = Number(bytesMake[1]);
        return (...values: readonly number[]) => {
          if (values.length !== length) {
            throw new TypeError(
              `Ducklang Bytes constructor expects ${length} values; received ${values.length}`,
            );
          }
          const result = new Uint8Array(length);
          values.forEach((value, index) => {
            if (!Number.isInteger(value) || value < 0 || value > 255) {
              throw new RangeError(
                `Ducklang Bytes value ${value} at index ${index} is outside 0..255`,
              );
            }
            result[index] = value;
          });
          const handle = allocateHandle();
          bytes.set(handle, result);
          return handle;
        };
      }
      const sumMake = /^sum_make_(\d+)$/.exec(property);
      if (sumMake !== null) {
        const tag = Number(sumMake[1]);
        return (payload: number | bigint) => {
          const handle = allocateHandle();
          sums.set(handle, { tag, payload });
          return handle;
        };
      }
      if (property === "sum_tag") {
        return (handle: number) => {
          const sum = sums.get(handle);
          if (sum !== undefined) return sum.tag;
          throw new RangeError(
            `Ducklang sum tag operation uses unknown handle ${handle}`,
          );
        };
      }
      if (property === "sum_payload_i32") {
        return (handle: number) => {
          const sum = sums.get(handle);
          if (sum === undefined) {
            throw new RangeError(
              `Ducklang sum payload operation uses unknown handle ${handle}`,
            );
          }
          if (typeof sum.payload === "number") return sum.payload;
          throw new TypeError("Ducklang sum payload is not an i32 value");
        };
      }
      if (property === "sum_payload_i64") {
        return (handle: number) => {
          const sum = sums.get(handle);
          if (sum === undefined) {
            throw new RangeError(
              `Ducklang sum payload operation uses unknown handle ${handle}`,
            );
          }
          if (typeof sum.payload === "bigint") return sum.payload;
          throw new TypeError("Ducklang sum payload is not an i64 value");
        };
      }
      return undefined;
    },
  });
}

function findOperation(
  abi: DucklangManagedAbi,
  reference: { readonly effectName: string; readonly operationName: string },
): DucklangAbiEffectOperation {
  const operation = abi.effects.find((effect) =>
    effect.name === reference.effectName
  )?.operations.find((candidate) => candidate.name === reference.operationName);
  if (operation !== undefined) return operation;
  throw new TypeError(
    `Ducklang ABI requirement references undeclared operation ${reference.effectName}.${reference.operationName}`,
  );
}

function decodeWasmValue(
  value: unknown,
  type: DucklangAbiValueType,
  abi: DucklangManagedAbi,
  heap: DucklangRuntimeHeap,
  subject: string,
  typeArguments: ReadonlyMap<string, DucklangAbiValueType> = new Map(),
): DucklangRuntimeValue {
  if (typeof type === "object") {
    const parameter = typeArguments.get(type.name);
    if (parameter !== undefined && type.arguments.length === 0) {
      return decodeWasmValue(
        value,
        parameter,
        abi,
        heap,
        subject,
        typeArguments,
      );
    }
    const layout = findLayout(abi, type, subject);
    const layoutArguments = new Map(
      layout.parameters.map((parameterName, index) => [
        parameterName,
        type.arguments[index],
      ]),
    );
    if (layout.kind === "alias") {
      return decodeWasmValue(
        value,
        layout.target,
        abi,
        heap,
        subject,
        layoutArguments,
      );
    }
    const handle = requireI32Handle(value, subject);
    if (layout.kind === "product") {
      const fields = heap.products.get(handle);
      if (fields === undefined) {
        throw new RangeError(
          `${subject} uses unknown product handle ${handle}`,
        );
      }
      if (fields.length !== layout.fields.length) {
        throw new TypeError(
          `${subject} product ${layout.name} has ${fields.length} fields; ABI requires ${layout.fields.length}`,
        );
      }
      return Object.fromEntries(
        layout.fields.map((field, index) => [
          field.name,
          decodeWasmValue(
            fields[index],
            field.type,
            abi,
            heap,
            `${subject}.${field.name}`,
            layoutArguments,
          ),
        ]),
      );
    }
    const sum = heap.sums.get(handle);
    if (sum === undefined) {
      throw new RangeError(`${subject} uses unknown sum handle ${handle}`);
    }
    const unionCase = layout.cases[sum.tag];
    if (unionCase === undefined) {
      throw new RangeError(
        `${subject} sum ${layout.name} uses tag ${sum.tag}; ABI declares ${layout.cases.length} cases`,
      );
    }
    return {
      case: unionCase.name,
      value: decodeWasmValue(
        sum.payload,
        unionCase.payload,
        abi,
        heap,
        `${subject}.${unionCase.name}`,
        layoutArguments,
      ),
    };
  }
  if (type === "unit") return undefined;
  if (type === "i64") {
    if (typeof value === "bigint") return value;
    throw new TypeError(
      `${subject} must be an i64 BigInt; received ${typeof value}`,
    );
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${subject} must be an i32; received ${typeof value}`);
  }
  if (type === "i32") return value;
  if (type === "bool") return value !== 0;
  if (type === "text") {
    const text = heap.texts.get(value);
    if (text !== undefined) return text;
    throw new RangeError(`${subject} uses unknown Text handle ${value}`);
  }
  const bytes = heap.bytes.get(value);
  if (bytes !== undefined) return bytes.slice();
  throw new RangeError(`${subject} uses unknown Bytes handle ${value}`);
}

function encodeWasmValue(
  value: DucklangRuntimeValue,
  type: DucklangAbiValueType,
  abi: DucklangManagedAbi,
  heap: DucklangRuntimeHeap,
  subject: string,
  typeArguments: ReadonlyMap<string, DucklangAbiValueType> = new Map(),
): number | bigint {
  if (typeof type === "object") {
    const parameter = typeArguments.get(type.name);
    if (parameter !== undefined && type.arguments.length === 0) {
      return encodeWasmValue(
        value,
        parameter,
        abi,
        heap,
        subject,
        typeArguments,
      );
    }
    const layout = findLayout(abi, type, subject);
    const layoutArguments = new Map(
      layout.parameters.map((parameterName, index) => [
        parameterName,
        type.arguments[index],
      ]),
    );
    if (layout.kind === "alias") {
      return encodeWasmValue(
        value,
        layout.target,
        abi,
        heap,
        subject,
        layoutArguments,
      );
    }
    if (layout.kind === "product") {
      const fields = productFields(value, layout, subject);
      const encoded = layout.fields.map((field, index) =>
        encodeWasmValue(
          fields[index],
          field.type,
          abi,
          heap,
          `${subject}.${field.name}`,
          layoutArguments,
        )
      );
      const handle = heap.allocateHandle();
      heap.products.set(handle, encoded);
      return handle;
    }
    if (!isRuntimeRecord(value) || typeof value.case !== "string") {
      throw new TypeError(
        `${subject} must return ${layout.name} as { case, value }`,
      );
    }
    const tag = layout.cases.findIndex((candidate) =>
      candidate.name === value.case
    );
    const unionCase = layout.cases[tag];
    if (unionCase === undefined) {
      throw new TypeError(
        `${subject} returned unknown ${layout.name} case ${String(value.case)}`,
      );
    }
    const payload = encodeWasmValue(
      value.value,
      unionCase.payload,
      abi,
      heap,
      `${subject}.${unionCase.name}`,
      layoutArguments,
    );
    const handle = heap.allocateHandle();
    heap.sums.set(handle, { tag, payload });
    return handle;
  }
  if (type === "text") {
    if (typeof value !== "string") {
      throw new TypeError(
        `${subject} must return Text; received ${runtimeValueKind(value)}`,
      );
    }
    const handle = heap.allocateHandle();
    heap.texts.set(handle, value);
    return handle;
  }
  if (type === "bytes") {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(
        `${subject} must return Bytes; received ${runtimeValueKind(value)}`,
      );
    }
    const handle = heap.allocateHandle();
    heap.bytes.set(handle, value.slice());
    return handle;
  }
  if (type === "unit") {
    if (value === undefined) return 0;
    throw new TypeError(
      `${subject} must return Unit; received ${typeof value}`,
    );
  }
  if (type === "bool") {
    if (typeof value === "boolean") return value ? 1 : 0;
    throw new TypeError(
      `${subject} must return Bool; received ${typeof value}`,
    );
  }
  if (type === "i64") {
    if (typeof value === "bigint") return value;
    throw new TypeError(`${subject} must return I64; received ${typeof value}`);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${subject} must return I32; received ${typeof value}`);
  }
  if (value < -2_147_483_648 || value > 2_147_483_647) {
    throw new RangeError(
      `${subject} returned I32 value outside its signed range: ${value}`,
    );
  }
  return value;
}

function findLayout(
  abi: DucklangManagedAbi,
  type: Extract<DucklangAbiValueType, { readonly kind: "named" }>,
  subject: string,
): DucklangManagedAbi["layouts"][number] {
  const candidates = abi.layouts.filter((layout) =>
    layout.name === type.name &&
    layout.parameters.length === type.arguments.length
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new TypeError(
      `${subject} references unknown ABI layout ${type.name}/${type.arguments.length}`,
    );
  }
  throw new TypeError(
    `${subject} references ambiguous ABI layout ${type.name}/${type.arguments.length}`,
  );
}

function productFields(
  value: DucklangRuntimeValue,
  layout: Extract<
    DucklangManagedAbi["layouts"][number],
    { readonly kind: "product" }
  >,
  subject: string,
): readonly DucklangRuntimeValue[] {
  if (Array.isArray(value)) {
    if (value.length === layout.fields.length) return value;
    throw new TypeError(
      `${subject} returned ${value.length} positional fields for ${layout.name}; expected ${layout.fields.length}`,
    );
  }
  if (!isRuntimeRecord(value)) {
    throw new TypeError(
      `${subject} must return ${layout.name} as an object or positional array`,
    );
  }
  return layout.fields.map((field) => {
    if (field.name in value) return value[field.name];
    throw new TypeError(
      `${subject} returned ${layout.name} without field ${field.name}`,
    );
  });
}

function isRuntimeRecord(
  value: DucklangRuntimeValue,
): value is Readonly<Record<string, DucklangRuntimeValue>> {
  return typeof value === "object" && value !== null &&
    !(value instanceof Uint8Array) && !Array.isArray(value);
}

function requireI32Handle(value: unknown, subject: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new TypeError(
    `${subject} must be an i32 handle; received ${typeof value}`,
  );
}

function runtimeValueKind(value: DucklangRuntimeValue): string {
  if (value instanceof Uint8Array) return "Bytes";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value &&
    typeof value.then === "function";
}

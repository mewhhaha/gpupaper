import { PrimitiveId, primitiveRuntimeImportName } from "./core_primitives.ts";
import { storeRuntimeImport } from "./store_runtime.ts";

export type { CoreBinaryOperator } from "./core.ts";
export { coreRuntimeImportModule, PrimitiveId } from "./core_primitives.ts";

export type RuntimeHeap = {
  readonly texts: Map<number, string>;
  readonly bytes: Map<number, Uint8Array>;
  readonly products: Map<number, readonly (number | bigint)[]>;
  readonly sums: Map<
    number,
    { readonly tag: number; readonly payload: number | bigint }
  >;
  readonly stores: Map<number, (number | bigint)[]>;
  readonly allocateHandle: () => number;
};

export function createRuntimeHeap(
  textLiterals: readonly string[] = [],
): RuntimeHeap {
  const texts = new Map<number, string>(
    textLiterals.map((value, index) => [index + 1, value]),
  );
  let nextHandle = textLiterals.length + 1;
  return {
    texts,
    bytes: new Map(),
    products: new Map(),
    sums: new Map(),
    stores: new Map(),
    allocateHandle: () => {
      const handle = nextHandle;
      nextHandle += 1;
      return handle;
    },
  };
}

export function createRuntimeImports(
  heap: RuntimeHeap,
): Record<string, CallableFunction> {
  const { texts, bytes, products, sums, stores, allocateHandle } = heap;
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
      `Core buffer primitive uses unknown handle ${rawHandle}`,
    );
  };
  const requireRange = (
    start: number,
    end: number,
    length: number,
  ): void => {
    if (start >= 0 && end >= start && end <= length) return;
    throw new RangeError(
      `Core buffer range ${start}..${end} is outside length ${length}`,
    );
  };
  const bufferRuntime: Record<string, CallableFunction> = {
    [primitiveRuntimeImportName(PrimitiveId.textCodePointLength)]: (
      handle: number,
    ) => {
      const text = requireHandle(handle);
      if (text.kind !== "text") {
        throw new TypeError("text length requires Text");
      }
      return BigInt([...text.value].length);
    },
    [primitiveRuntimeImportName(PrimitiveId.textFromI64)]: (value: bigint) => {
      const handle = allocateHandle();
      texts.set(handle, value.toString());
      return handle;
    },
    [primitiveRuntimeImportName(PrimitiveId.textCompare)]: (
      leftHandle: number,
      rightHandle: number,
    ) => {
      const left = requireHandle(leftHandle);
      const right = requireHandle(rightHandle);
      if (left.kind !== "text" || right.kind !== "text") {
        throw new TypeError("text comparison requires Text operands");
      }
      return compareUnicodeScalars(left.value, right.value);
    },
    [primitiveRuntimeImportName(PrimitiveId.textContains)]: (
      textHandle: number,
      queryHandle: number,
    ) => {
      const text = requireHandle(textHandle);
      const query = requireHandle(queryHandle);
      if (text.kind !== "text" || query.kind !== "text") {
        throw new TypeError("text containment requires Text operands");
      }
      return Number(text.value.includes(query.value));
    },
    [storeRuntimeImport.empty]: () => {
      const handle = allocateHandle();
      stores.set(handle, []);
      return handle;
    },
    [storeRuntimeImport.new]: (
      rawLength: bigint,
      initial: number | bigint,
    ) => {
      const length = storeLength(rawLength);
      const handle = allocateHandle();
      stores.set(handle, Array<number | bigint>(length).fill(initial));
      return handle;
    },
    [storeRuntimeImport.length]: (handle: number) =>
      BigInt(requireStore(stores, handle).length),
    [storeRuntimeImport.read]: (
      handle: number,
      rawIndex: bigint,
    ) => {
      const store = requireStore(stores, handle);
      const index = storeIndex(rawIndex, store.length);
      return store[index];
    },
    [storeRuntimeImport.writePersistent]: (
      handle: number,
      rawIndex: bigint,
      value: number | bigint,
    ) => {
      const source = requireStore(stores, handle);
      const index = storeIndex(rawIndex, source.length);
      const result = source.slice();
      result[index] = value;
      const resultHandle = allocateHandle();
      stores.set(resultHandle, result);
      return resultHandle;
    },
    [storeRuntimeImport.writeOwned]: (
      handle: number,
      rawIndex: bigint,
      value: number | bigint,
    ) => {
      const store = requireStore(stores, handle);
      store[storeIndex(rawIndex, store.length)] = value;
      return handle;
    },
    [storeRuntimeImport.growPersistent]: (
      handle: number,
      rawLength: bigint,
      initial: number | bigint,
    ) => {
      const source = requireStore(stores, handle);
      const result = growStore(source, rawLength, initial);
      const resultHandle = allocateHandle();
      stores.set(resultHandle, result);
      return resultHandle;
    },
    [storeRuntimeImport.growOwned]: (
      handle: number,
      rawLength: bigint,
      initial: number | bigint,
    ) => {
      const store = requireStore(stores, handle);
      const length = storeLength(rawLength);
      if (length < store.length) store.length = length;
      while (store.length < length) store.push(initial);
      return handle;
    },
    [primitiveRuntimeImportName(PrimitiveId.bufferLength)]: (
      handle: number,
    ) => {
      const product = products.get(handle);
      if (product !== undefined) return product.length;
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
        throw new TypeError("Core buffer set requires Bytes");
      }
      requireRange(index, index + 1, buffer.value.length);
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(
          `Core byte value ${value} is outside 0..255`,
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
          `Core Bytes length ${length} is outside 0..16777216`,
        );
      }
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(
          `Core byte value ${value} is outside 0..255`,
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
          `Core Text slice ${start}..${end} splits a UTF-8 sequence`,
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
          `Core buffer append cannot combine ${left.kind} with ${right.kind}`,
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
        throw new TypeError("Core UTF-8 encode requires Text");
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
        throw new TypeError("Core UTF-8 decode requires Bytes");
      }
      const resultHandle = allocateHandle();
      try {
        texts.set(resultHandle, decoder.decode(byteBuffer.value));
      } catch (cause) {
        throw new TypeError("Core UTF-8 decode received invalid bytes", {
          cause,
        });
      }
      return resultHandle;
    },
    [primitiveRuntimeImportName(PrimitiveId.f32Format)]: (
      value: number,
      fractionalDigits: number,
    ) => {
      if (
        !Number.isInteger(fractionalDigits) ||
        fractionalDigits < 0 || fractionalDigits > 100
      ) {
        throw new RangeError(
          `Core F32 fractional digit count ${fractionalDigits} is outside 0..100`,
        );
      }
      const resultHandle = allocateHandle();
      texts.set(resultHandle, Math.fround(value).toFixed(fractionalDigits));
      return resultHandle;
    },
  };
  const requireProduct = (handle: number): readonly (number | bigint)[] => {
    const product = products.get(handle);
    if (product !== undefined) return product;
    throw new RangeError(
      `Core aggregate operation uses unknown handle ${handle}`,
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
              `Core product constructor expects ${arity} fields; received ${values.length}`,
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
            `Core product projection ${index} is outside arity ${product.length}`,
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
              `Core product update expects ${indices.length} values; received ${values.length}`,
            );
          }
          const product = [...requireProduct(handle)];
          indices.forEach((index, valueIndex) => {
            if (product[index] === undefined) {
              throw new RangeError(
                `Core product update ${index} is outside arity ${product.length}`,
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
            `Core product index ${index} is outside arity ${product.length}`,
          );
        };
      }
      if (property === "product_index_update") {
        return (handle: number, index: number, value: number | bigint) => {
          const product = [...requireProduct(handle)];
          if (product[index] === undefined) {
            throw new RangeError(
              `Core product update ${index} is outside arity ${product.length}`,
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
              `Core Bytes constructor expects ${length} values; received ${values.length}`,
            );
          }
          const result = new Uint8Array(length);
          values.forEach((value, index) => {
            if (!Number.isInteger(value) || value < 0 || value > 255) {
              throw new RangeError(
                `Core Bytes value ${value} at index ${index} is outside 0..255`,
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
            `Core sum tag operation uses unknown handle ${handle}`,
          );
        };
      }
      if (property === "sum_payload_i32") {
        return (handle: number) => {
          const sum = sums.get(handle);
          if (sum === undefined) {
            throw new RangeError(
              `Core sum payload operation uses unknown handle ${handle}`,
            );
          }
          if (typeof sum.payload === "number") return sum.payload;
          throw new TypeError("Core sum payload is not an i32 value");
        };
      }
      if (property === "sum_payload_i64") {
        return (handle: number) => {
          const sum = sums.get(handle);
          if (sum === undefined) {
            throw new RangeError(
              `Core sum payload operation uses unknown handle ${handle}`,
            );
          }
          if (typeof sum.payload === "bigint") return sum.payload;
          throw new TypeError("Core sum payload is not an i64 value");
        };
      }
      if (
        property === "sum_payload_f32" ||
        property === "sum_payload_f64"
      ) {
        return (handle: number) => {
          const sum = sums.get(handle);
          if (sum === undefined) {
            throw new RangeError(
              `Core sum payload operation uses unknown handle ${handle}`,
            );
          }
          if (typeof sum.payload === "number") return sum.payload;
          throw new TypeError(
            `Core sum payload is not a ${property.slice(-3)} value`,
          );
        };
      }
      return undefined;
    },
  });
}

const maximumCoreStoreLength = 16_777_216;

function requireStore(
  stores: ReadonlyMap<number, (number | bigint)[]>,
  handle: number,
): (number | bigint)[] {
  const store = stores.get(handle);
  if (store !== undefined) return store;
  throw new RangeError(
    `Core Store operation uses unknown handle ${handle}`,
  );
}

function storeLength(rawLength: bigint): number {
  if (rawLength < 0n || rawLength > BigInt(maximumCoreStoreLength)) {
    throw new RangeError(
      `Core Store length ${rawLength} is outside 0..${maximumCoreStoreLength}`,
    );
  }
  return Number(rawLength);
}

function storeIndex(rawIndex: bigint, length: number): number {
  if (rawIndex < 0n || rawIndex >= BigInt(length)) {
    throw new RangeError(
      `Core Store index ${rawIndex} is outside length ${length}`,
    );
  }
  return Number(rawIndex);
}

function growStore(
  source: readonly (number | bigint)[],
  rawLength: bigint,
  initial: number | bigint,
): (number | bigint)[] {
  const length = storeLength(rawLength);
  const result = source.slice(0, length);
  while (result.length < length) result.push(initial);
  return result;
}

function compareUnicodeScalars(left: string, right: string): -1 | 0 | 1 {
  const leftScalars = [...left];
  const rightScalars = [...right];
  const sharedLength = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftScalar = leftScalars[index].codePointAt(0)!;
    const rightScalar = rightScalars[index].codePointAt(0)!;
    if (leftScalar < rightScalar) return -1;
    if (leftScalar > rightScalar) return 1;
  }
  if (leftScalars.length < rightScalars.length) return -1;
  return leftScalars.length === rightScalars.length ? 0 : 1;
}

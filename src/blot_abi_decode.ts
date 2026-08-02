import { type BlotAbiType, flattenedAbiType } from "./blot_runtime_abi.ts";
import type { BlotRuntimeModule } from "./blot_runtime_hir.ts";

export type BlotCanonicalValue =
  | bigint
  | number
  | boolean
  | string
  | null
  | readonly BlotCanonicalValue[]
  | { readonly case: string; readonly payload: BlotCanonicalValue | null };

export function decodeBlotAbiResult(
  type: BlotAbiType,
  value: unknown,
  memoryExport: WebAssembly.ExportValue | undefined,
): BlotCanonicalValue {
  if (flattenedAbiType(type).length > 1) {
    if (
      typeof value !== "number" || !(memoryExport instanceof WebAssembly.Memory)
    ) {
      throw new TypeError(
        `indirect ${type.kind} result omitted memory pointer`,
      );
    }
    return readMemoryValue(type, value, memoryExport);
  }
  return directValue(type, value);
}

export function normalizeGpufuckValue(
  type: BlotAbiType,
  value: unknown,
  module?: BlotRuntimeModule,
  runtimeTypeId?: number,
): BlotCanonicalValue {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new TypeError(`gpufuck omitted structured ${type.kind} result`);
  }
  if (
    type.kind === "signed-integer-64" || type.kind === "float-32" ||
    type.kind === "float-64" || type.kind === "boolean" || type.kind === "text"
  ) {
    if (!("value" in value)) {
      throw new TypeError(`gpufuck omitted ${type.kind} value`);
    }
    return value.value as bigint | number | boolean | string;
  }
  if (type.kind === "unit") return null;
  if (type.kind === "array") {
    if (!("values" in value) || !Array.isArray(value.values)) {
      throw new TypeError("gpufuck omitted array values");
    }
    const runtimeType = module?.types[runtimeTypeId ?? -1];
    const elementType = runtimeType?.kind === "store"
      ? runtimeType.elementType
      : undefined;
    return value.values.map((entry) =>
      normalizeGpufuckValue(type.element, entry, module, elementType)
    );
  }
  const fields = "fields" in value && Array.isArray(value.fields)
    ? value.fields
    : [];
  if (type.kind === "sealed") {
    const runtimeType = module?.types[runtimeTypeId ?? -1];
    const representation = runtimeType?.kind === "sealed"
      ? runtimeType.representationType
      : undefined;
    return normalizeGpufuckValue(
      type.inner,
      fields[0],
      module,
      representation,
    );
  }
  if (type.kind === "record") {
    const runtimeType = module?.types[runtimeTypeId ?? -1];
    return [...type.fields].sort(byName).map((field, abiIndex) => {
      const sourceIndex = runtimeType?.kind === "product"
        ? runtimeType.fields.findIndex((candidate) =>
          candidate.name === field.name
        )
        : abiIndex;
      const sourceType = runtimeType?.kind === "product"
        ? runtimeType.fields[sourceIndex]?.type
        : undefined;
      return normalizeGpufuckValue(
        field.type,
        fields[sourceIndex],
        module,
        sourceType,
      );
    });
  }
  const name = "name" in value && typeof value.name === "string"
    ? value.name
    : "";
  const case_ = type.cases.find((candidate) =>
    name === candidate.name || name.endsWith(`_${candidate.name}`)
  );
  if (case_ === undefined) {
    throw new TypeError(`gpufuck variant ${name} has no ABI case`);
  }
  return {
    case: case_.name,
    payload: case_.payload === undefined
      ? null
      : normalizeGpufuckValue(case_.payload, fields[0], module),
  };
}

export function equalBlotCanonicalValues(
  left: BlotCanonicalValue,
  right: BlotCanonicalValue,
): boolean {
  if (typeof left !== "object" || left === null) return Object.is(left, right);
  if (typeof right !== "object" || right === null) return false;
  if (isCanonicalArray(left)) {
    return isCanonicalArray(right) && left.length === right.length &&
      left.every((entry, index) =>
        equalBlotCanonicalValues(entry, right[index])
      );
  }
  if (isCanonicalArray(right)) return false;
  return left.case === right.case &&
    (left.payload === null ? right.payload === null : right.payload !== null &&
      equalBlotCanonicalValues(left.payload, right.payload));
}

function isCanonicalArray(
  value: BlotCanonicalValue,
): value is readonly BlotCanonicalValue[] {
  return Array.isArray(value);
}

function directValue(type: BlotAbiType, value: unknown): BlotCanonicalValue {
  if (type.kind === "unit") return null;
  if (type.kind === "signed-integer-64") return value as bigint;
  if (type.kind === "float-32" || type.kind === "float-64") {
    return value as number;
  }
  if (type.kind === "boolean") return value !== 0;
  if (type.kind === "sealed") return directValue(type.inner, value);
  if (type.kind === "record") {
    const field = type.fields.find((candidate) =>
      flattenedAbiType(candidate.type).length > 0
    );
    return field === undefined ? [] : [directValue(field.type, value)];
  }
  if (type.kind === "variant" && typeof value === "number") {
    const cases = [...type.cases].sort(byName);
    return { case: cases[value]?.name ?? `<${value}>`, payload: null };
  }
  throw new TypeError(`direct decoder does not admit ${type.kind}`);
}

function readMemoryValue(
  type: BlotAbiType,
  pointer: number,
  memory: WebAssembly.Memory,
): BlotCanonicalValue {
  const view = new DataView(memory.buffer);
  if (type.kind === "unit") return null;
  if (type.kind === "signed-integer-64") return view.getBigInt64(pointer, true);
  if (type.kind === "float-32") return view.getFloat32(pointer, true);
  if (type.kind === "float-64") return view.getFloat64(pointer, true);
  if (type.kind === "boolean") return view.getUint8(pointer) !== 0;
  if (type.kind === "text") {
    const bytes = view.getUint32(pointer, true);
    const length = view.getUint32(pointer + 4, true);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(memory.buffer, bytes, length),
    );
  }
  if (type.kind === "array") {
    const elements = view.getUint32(pointer, true);
    const length = view.getUint32(pointer + 4, true);
    const layout = memoryLayout(type.element);
    return Array.from(
      { length },
      (_, index) =>
        readMemoryValue(type.element, elements + index * layout.size, memory),
    );
  }
  if (type.kind === "sealed") {
    return readMemoryValue(type.inner, pointer, memory);
  }
  if (type.kind === "record") {
    return recordLayout(type).map((field) =>
      readMemoryValue(field.type, pointer + field.offset, memory)
    );
  }
  const layout = variantLayout(type);
  const tag = layout.discriminantSize === 1
    ? view.getUint8(pointer)
    : layout.discriminantSize === 2
    ? view.getUint16(pointer, true)
    : view.getUint32(pointer, true);
  const case_ = [...type.cases].sort(byName)[tag];
  if (case_ === undefined) throw new RangeError(`invalid variant tag ${tag}`);
  return {
    case: case_.name,
    payload: case_.payload === undefined
      ? null
      : readMemoryValue(case_.payload, pointer + layout.payloadOffset, memory),
  };
}

function memoryLayout(type: BlotAbiType): { alignment: number; size: number } {
  if (type.kind === "unit") return { alignment: 1, size: 0 };
  if (type.kind === "boolean") return { alignment: 1, size: 1 };
  if (type.kind === "float-32") return { alignment: 4, size: 4 };
  if (type.kind === "signed-integer-64" || type.kind === "float-64") {
    return { alignment: 8, size: 8 };
  }
  if (type.kind === "text" || type.kind === "array") {
    return { alignment: 4, size: 8 };
  }
  if (type.kind === "sealed") return memoryLayout(type.inner);
  if (type.kind === "record") {
    const fields = recordLayout(type);
    const alignment = fields.reduce(
      (maximum, field) => Math.max(maximum, memoryLayout(field.type).alignment),
      1,
    );
    const end = fields.reduce(
      (maximum, field) =>
        Math.max(maximum, field.offset + memoryLayout(field.type).size),
      0,
    );
    return { alignment, size: alignTo(end, alignment) };
  }
  const variant = variantLayout(type);
  return { alignment: variant.alignment, size: variant.size };
}

function recordLayout(type: Extract<BlotAbiType, { kind: "record" }>) {
  let offset = 0;
  return [...type.fields].sort(byName).map((field) => {
    const layout = memoryLayout(field.type);
    offset = alignTo(offset, layout.alignment);
    const placed = { ...field, offset };
    offset += layout.size;
    return placed;
  });
}

function variantLayout(type: Extract<BlotAbiType, { kind: "variant" }>) {
  const discriminantSize = type.cases.length <= 256
    ? 1
    : type.cases.length <= 65_536
    ? 2
    : 4;
  let payloadAlignment = 1;
  let payloadSize = 0;
  for (const case_ of type.cases) {
    if (case_.payload === undefined) continue;
    const layout = memoryLayout(case_.payload);
    payloadAlignment = Math.max(payloadAlignment, layout.alignment);
    payloadSize = Math.max(payloadSize, layout.size);
  }
  const alignment = Math.max(discriminantSize, payloadAlignment);
  const payloadOffset = alignTo(discriminantSize, payloadAlignment);
  return {
    discriminantSize,
    payloadOffset,
    alignment,
    size: alignTo(payloadOffset + payloadSize, alignment),
  };
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function byName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

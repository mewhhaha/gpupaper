export function contentIdentity(value: unknown): string {
  return encodeIdentity(value, new Set());
}

function encodeIdentity(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${value}`;
  }
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value === "string") return `string:${value.length}:${value}`;
  if (typeof value !== "object") {
    throw new TypeError(`cannot identify ${typeof value} content`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("cannot identify cyclic content");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `array:${value.length}:[${
        value.map((element) => encodeIdentity(element, ancestors)).join(",")
      }]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .map(([key, entryValue]) =>
          [
            encodeIdentity(key, ancestors),
            encodeIdentity(entryValue, ancestors),
          ] as const
        )
        .sort(([left], [right]) => left.localeCompare(right));
      return `map:${entries.length}:{${
        entries.map(([key, entryValue]) => `${key}=>${entryValue}`).join(",")
      }}`;
    }
    if (value instanceof Set) {
      const entries = [...value]
        .map((entry) => encodeIdentity(entry, ancestors))
        .sort();
      return `set:${entries.length}:{${entries.join(",")}}`;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      return `bytes:${bytes.byteLength}:${
        [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
      }`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `object:${keys.length}:{${
      keys.map((key) =>
        `${encodeIdentity(key, ancestors)}=${
          encodeIdentity(record[key], ancestors)
        }`
      ).join(",")
    }}`;
  } finally {
    ancestors.delete(value);
  }
}

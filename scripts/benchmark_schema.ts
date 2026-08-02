export type BenchmarkValidity =
  | { readonly status: "admissible" }
  | { readonly status: "diagnostic" | "refused"; readonly reason: string };

export function requireBenchmarkRecord(record: unknown): asserts record is {
  readonly schemaVersion: number;
  readonly validity: BenchmarkValidity;
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly repositories: Readonly<Record<string, unknown>>;
  readonly environmentAtStart: Readonly<Record<string, unknown>>;
  readonly environmentAtEnd: Readonly<Record<string, unknown>>;
} {
  if (!isRecord(record)) {
    throw new TypeError("benchmark result is not an object");
  }
  if (!Number.isSafeInteger(record.schemaVersion)) {
    throw new TypeError(
      `benchmark schemaVersion is ${String(record.schemaVersion)}`,
    );
  }
  if (!isRecord(record.validity)) {
    throw new TypeError("benchmark result has no validity record");
  }
  const status = record.validity.status;
  if (
    status !== "admissible" && status !== "diagnostic" && status !== "refused"
  ) {
    throw new TypeError(`benchmark validity status is ${String(status)}`);
  }
  if (status !== "admissible" && typeof record.validity.reason !== "string") {
    throw new TypeError(`${status} benchmark result has no reason`);
  }
  for (
    const field of [
      "runtime",
      "repositories",
      "environmentAtStart",
      "environmentAtEnd",
    ] as const
  ) {
    if (!isRecord(record[field])) {
      throw new TypeError(`benchmark result has no ${field} record`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

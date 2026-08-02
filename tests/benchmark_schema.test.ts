import { requireBenchmarkRecord } from "../scripts/benchmark_schema.ts";

Deno.test("benchmark schema accepts a complete admissible result", () => {
  requireBenchmarkRecord({
    schemaVersion: 1,
    validity: { status: "admissible" },
    runtime: {},
    repositories: {},
    environmentAtStart: {},
    environmentAtEnd: {},
  });
});

Deno.test("benchmark schema rejects diagnostics without a reason", () => {
  let rejected = false;
  try {
    requireBenchmarkRecord({
      schemaVersion: 1,
      validity: { status: "diagnostic" },
      runtime: {},
      repositories: {},
      environmentAtStart: {},
      environmentAtEnd: {},
    });
  } catch (error) {
    rejected = error instanceof TypeError;
  }
  if (!rejected) throw new Error("reasonless diagnostic was accepted");
});

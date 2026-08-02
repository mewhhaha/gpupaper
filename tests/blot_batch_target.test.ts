import { buildGpupaperBatch } from "../../blot/src/backend/gpupaper.ts";

Deno.test("Blot gpupaper batches admitted modules around a local source failure", async () => {
  const paths = [
    new URL("../../blot/examples/minimal.blot", import.meta.url).pathname,
    new URL(
      "../../blot/examples/rejected/syntax/if_expression_without_else.blot",
      import.meta.url,
    ).pathname,
    new URL("../../blot/examples/arithmetic.blot", import.meta.url).pathname,
  ];
  const outcomes = await buildGpupaperBatch(paths);

  assertEquals(
    outcomes.map((outcome) => outcome.status).join(","),
    "built,failed,built",
  );
  for (const [ordinal, outcome] of outcomes.entries()) {
    assertEquals(outcome.path, paths[ordinal]);
    if (outcome.status === "failed") continue;
    assertEquals(WebAssembly.validate(Uint8Array.from(outcome.wasm)), true);
  }
  if (outcomes[0].status !== "built" || outcomes[2].status !== "built") {
    throw new Error("admitted Blot modules did not survive the batch");
  }
  assertEquals(outcomes[0].wasm.buffer === outcomes[2].wasm.buffer, false);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}; received ${String(actual)}`);
  }
}

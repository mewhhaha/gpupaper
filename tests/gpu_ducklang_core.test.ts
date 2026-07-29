import { rewriteFlatDucklangCore } from "../src/ducklang_core_rewrite.ts";
import { lowerDucklangToCore } from "../src/ducklang_core.ts";
import { flattenDucklangCore } from "../src/flat_ducklang_core.ts";
import { runDucklangCoreGpuPass } from "../src/gpu_ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("WebGPU validates and proposes the same Core rewrites as the CPU", async () => {
  const snapshot = await flat(
    "let value = 21\nlet first = value + 0\nfirst * 1\n",
  );
  const expected = rewriteFlatDucklangCore(snapshot);

  const result = await runDucklangCoreGpuPass(snapshot);

  if (result.status === "unavailable") return;
  if (result.status !== "completed") {
    throw new Error(`GPU rejected accepted Core: ${result.reason}`);
  }
  assertEquals(result.proposals, expected.proposals);
  assertEquals(result.accepted, expected.accepted);
  assertEquals(columns(result.package), columns(expected.package));
  assertEquals(
    result.validationRecordCount > snapshot.operationKinds.length,
    true,
  );
});

Deno.test("WebGPU and CPU both reject an out-of-range Core type", async () => {
  const snapshot = await flat("42\n");
  const operationTypeIds = snapshot.operationTypeIds.slice();
  operationTypeIds[0] = snapshot.typeKinds.length + 7;

  const result = await runDucklangCoreGpuPass({
    ...snapshot,
    operationTypeIds,
  });

  if (result.status === "unavailable") return;
  assertEquals(result.status, "invalid");
  if (result.status === "invalid") {
    assertEquals(/operation type/.test(result.reason), true);
  }
});

async function flat(source: string) {
  return flattenDucklangCore(
    lowerDucklangToCore(
      inferDucklangModule(
        resolveDucklangModule(
          await parseDucklangModule("gpu_core.duck", source),
        ),
      ),
    ),
  );
}

function columns(package_: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(package_)
      .filter((entry): entry is [string, Uint8Array | Uint32Array] =>
        entry[1] instanceof Uint8Array || entry[1] instanceof Uint32Array
      )
      .map(([name, values]) => [name, [...values]])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}; received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

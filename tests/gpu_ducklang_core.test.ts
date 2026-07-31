import { rewriteFlatDucklangCore } from "../src/ducklang_core_rewrite.ts";
import { lowerDucklangToCore } from "../src/ducklang_core.ts";
import { flattenDucklangCore } from "../src/flat_ducklang_core.ts";
import { runDucklangCoreGpuPass } from "../src/gpu_ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("WebGPU proposes the same Core rewrites as the CPU", async () => {
  const snapshot = await flat(
    `let value = 21
let first = value + 0
let integer_result = first * 1
let unmatched = integer_result + 2
let float_value = 2.0f32
let float_result = float_value * 1.0f32
unmatched - 2
`,
  );
  const expected = rewriteFlatDucklangCore(snapshot);

  const result = await runDucklangCoreGpuPass(snapshot);

  if (result.status === "unavailable") return;
  if (result.status !== "completed") {
    throw new Error(`GPU rejected accepted Core: ${result.reason}`);
  }
  assertEquals(result.backend, "gpu");
  assertEquals(result.inputProvenance, "validation");
  assertEquals(result.proposals, expected.proposals);
  assertEquals(result.proposals.length, 2);
  assertEquals(result.accepted, expected.accepted);
  assertEquals(result.rewriteCandidateCount, 2);
  assertEquals(result.candidateDescriptorBytes, 160);
  assertEquals(result.logicalDeviceBufferBytes, 196);
  assertEquals(result.rewriteDispatchedInvocationCount, 64);
  assertEquals(result.logicalBatchSize, 1);
  assertEquals(result.physicalPayloadBatchSize, 1);
  assertEquals(columns(result.package), columns(expected.package));
});

Deno.test("CPU Core boundary rejects an out-of-range type before GPU work", async () => {
  const snapshot = await flat("42\n");
  const operationTypeIds = snapshot.operationTypeIds.slice();
  operationTypeIds[0] = snapshot.typeKinds.length + 7;

  const result = await runDucklangCoreGpuPass({
    ...snapshot,
    operationTypeIds,
  });

  assertEquals(result.status, "invalid");
  if (result.status === "invalid") {
    assertEquals(/operation type/.test(result.reason), true);
  }
});

Deno.test("empty Core rewrite frontier completes without WebGPU work", async () => {
  const snapshot = await flat("42\n");

  const result = await runDucklangCoreGpuPass(snapshot);

  if (result.status !== "completed") {
    throw new Error(`Core identity pass failed: ${result.reason}`);
  }
  if (result.package !== snapshot) {
    throw new Error("empty Core rewrite frontier replaced its snapshot");
  }
  assertEquals(result.backend, "identity");
  assertEquals(result.inputProvenance, "validation");
  assertEquals(result.rewriteCandidateCount, 0);
  assertEquals(result.candidateDescriptorBytes, 0);
  assertEquals(result.logicalDeviceBufferBytes, 0);
  assertEquals(result.rewriteDispatchedInvocationCount, 0);
  assertEquals(result.proposals, []);
  assertEquals(result.accepted, []);
  assertEquals(result.initializationMilliseconds, 0);
  assertEquals(result.gpuMilliseconds, 0);
  assertEquals(result.transferMilliseconds, 0);
  assertEquals(result.commitMilliseconds, 0);
  assertEquals(result.submissionBatchSize, 0);
  assertEquals(result.logicalBatchSize, 1);
  assertEquals(result.physicalPayloadBatchSize, 0);
});

Deno.test("throughput batch discards every empty Core rewrite frontier", async () => {
  const snapshots = await Promise.all([flat("42\n"), flat("7\n")]);

  const results = await Promise.all(
    snapshots.map((snapshot) =>
      runDucklangCoreGpuPass(snapshot, { scheduling: "throughput" })
    ),
  );

  for (const result of results) {
    if (result.status !== "completed") {
      throw new Error(`Core identity batch failed: ${result.reason}`);
    }
    assertEquals(result.backend, "identity");
    assertEquals(result.logicalBatchSize, 2);
    assertEquals(result.physicalPayloadBatchSize, 0);
    assertEquals(result.submissionBatchSize, 0);
    assertEquals(result.gpuMilliseconds, 0);
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

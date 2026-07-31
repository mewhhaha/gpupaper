import { compileModuleSource } from "../src/compiler.ts";
import { lowerDucklangToCore } from "../src/ducklang_core.ts";
import { flattenDucklangCore } from "../src/flat_ducklang_core.ts";
import { runDucklangCoreGpuPass } from "../src/gpu_ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("concurrent compilations remain isolated after a failed GPU job", async () => {
  const duckSource = `let value = 41
value + 1
`;
  const haskellSource = "main = 40 + 2\n";
  const [duckBaseline, haskellBaseline] = await Promise.all([
    compileModuleSource("baseline.duck", duckSource),
    compileModuleSource("baseline.hs", haskellSource),
  ]);
  if (
    duckBaseline.gpuWasmResult?.status !== "completed" ||
    haskellBaseline.gpuWasmResult?.status !== "completed"
  ) {
    return;
  }

  const parsed = await parseDucklangModule("invalid.duck", duckSource);
  const validCore = flattenDucklangCore(
    lowerDucklangToCore(
      inferDucklangModule(resolveDucklangModule(parsed)),
    ),
  );
  const operationTypeIds = validCore.operationTypeIds.slice();
  operationTypeIds[0] = validCore.typeKinds.length + 1;
  const invalidCoreJob = runDucklangCoreGpuPass({
    ...validCore,
    operationTypeIds,
  });

  const concurrentCompilations = Array.from(
    { length: 8 },
    (_, index) =>
      index % 2 === 0
        ? compileModuleSource(`concurrent_${index}.duck`, duckSource, {
          gpuMode: "required",
        })
        : compileModuleSource(`concurrent_${index}.hs`, haskellSource, {
          gpuMode: "required",
        }),
  );
  const [invalidCore, ...artifacts] = await Promise.all([
    invalidCoreJob,
    ...concurrentCompilations,
  ]);

  assertEquals(invalidCore.status, "invalid");
  for (const [index, artifact] of artifacts.entries()) {
    const expected = index % 2 === 0 ? duckBaseline.wasm : haskellBaseline.wasm;
    assertEquals([...artifact.wasm], [...expected]);
    assertEquals(artifact.gpuWasmResult?.status, "completed");
  }
  const duckArtifacts = artifacts.filter((artifact) =>
    artifact.language === "ducklang"
  );
  if (
    Math.max(
      ...duckArtifacts.map((artifact) =>
        artifact.profile.work.gpuCorePayloadBatchSize
      ),
    ) < 2
  ) {
    throw new Error(
      "concurrent Ducklang Core payloads were not packed together",
    );
  }
  if (
    Math.max(
      ...duckArtifacts.map((artifact) =>
        artifact.profile.work.gpuWasmPayloadBatchSize
      ),
    ) < 2
  ) {
    throw new Error(
      "concurrent Ducklang Wasm payloads were not packed together",
    );
  }

  const recovered = await compileModuleSource(
    "recovered.duck",
    duckSource,
    { gpuMode: "required" },
  );
  assertEquals([...recovered.wasm], [...duckBaseline.wasm]);
  assertEquals(recovered.gpuCoreResult?.status, "completed");
  assertEquals(recovered.gpuWasmResult?.status, "completed");
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}; received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

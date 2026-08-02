import { prepareGpupaperHir } from "../../blot/src/backend/compile.ts";
import { validateBlotRuntimeModule } from "../src/blot_runtime_hir.ts";
import { compileBlotRuntimeModule } from "../src/blot_runtime_target.ts";

const root = new URL("../../blot/examples/", import.meta.url);
const files: string[] = [];
for await (const entry of Deno.readDir(root)) {
  if (entry.isFile && entry.name.endsWith(".blot")) files.push(entry.name);
}
files.sort();

const results = [];
for (const file of files) {
  const path = new URL(file, root).pathname;
  const started = performance.now();
  try {
    const hir = await prepareGpupaperHir(path);
    const prepared = performance.now();
    const validatedModule = validateBlotRuntimeModule(hir);
    const validationFinished = performance.now();
    const artifact = compileBlotRuntimeModule(validatedModule);
    const compiled = performance.now();
    results.push({
      file,
      status: "ok",
      prepare_ms: prepared - started,
      validate_ms: validationFinished - prepared,
      target_ms: compiled - validationFinished,
      wasm_bytes: artifact.wasm?.byteLength ?? null,
    });
  } catch (error) {
    results.push({
      file,
      status: "error",
      total_ms: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const passed = results.filter((result) => result.status === "ok");
console.log(JSON.stringify(
  {
    corpus: "../blot/examples/*.blot",
    files: results.length,
    compiled: passed.length,
    rejected: results.length - passed.length,
    wasm_bytes: passed.reduce(
      (sum, result) =>
        sum + ("wasm_bytes" in result ? result.wasm_bytes ?? 0 : 0),
      0,
    ),
    results,
  },
  null,
  2,
));

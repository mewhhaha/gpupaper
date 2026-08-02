import { checkFile } from "../../blot/src/check/mod.ts";
import { load } from "../../blot/src/load.ts";
import { stageModule } from "../../blot/src/stage.ts";

const root = new URL("../../blot/examples/", import.meta.url);
const results = [];
for await (const entry of Deno.readDir(root)) {
  if (!entry.isFile || !entry.name.endsWith(".blot")) continue;
  const path = new URL(entry.name, root);
  const loaded = await load(path.pathname);
  const checked = await checkFile(path.pathname);
  const imports = loaded.closure.tag === "closure"
    ? loaded.closure.imports ?? new Map()
    : new Map();
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
  );
  results.push({
    file: entry.name,
    exports: staged.exports.map((exported) => ({
      sourceName: exported.sourceName,
      phase: exported.phase,
      value: exported.value?.tag ?? null,
    })),
  });
}
results.sort((left, right) => left.file.localeCompare(right.file));
console.log(JSON.stringify(results, null, 2));

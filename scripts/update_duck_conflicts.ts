import { compile, type Diagnostic, parseMetadata } from "@mewhhaha/baba";

type Resolution =
  | { readonly conflict: string; readonly prefer: "shift" }
  | {
    readonly conflict: string;
    readonly prefer: "reduce";
    readonly reduce: string;
  };

const [grammarPath, metadataPath] = Deno.args;
if (grammarPath === undefined || metadataPath === undefined) {
  throw new Error(
    "usage: deno run --allow-read --allow-write scripts/update_duck_conflicts.ts GRAMMAR METADATA",
  );
}

const grammar = await Deno.readTextFile(grammarPath);
const initial = compile(grammar, {
  targets: ["wasm"],
  wasm: { parserStateLimit: 100_000 },
});
const resolutions = new Map<string, Resolution>();
addConflictResolutions(initial.diagnostics, resolutions);

while (true) {
  const metadata = parseMetadata(metadataSource(resolutions));
  const result = compile(grammar, {
    targets: ["wasm"],
    metadata,
    wasm: { parserStateLimit: 100_000 },
  });
  let changed = false;
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.code !== "RUNTIME_PARSER_CONFLICT_METADATA") continue;
    const stale = diagnostic.message.match(/c_[0-9a-f]+/)?.[0];
    if (stale !== undefined && resolutions.delete(stale)) changed = true;
  }
  const previousSize = resolutions.size;
  addConflictResolutions(result.diagnostics, resolutions);
  if (resolutions.size !== previousSize) changed = true;
  if (!changed) break;
}

await Deno.writeTextFile(metadataPath, metadataSource(resolutions));

function addConflictResolutions(
  diagnostics: readonly Diagnostic[],
  resolutions: Map<string, Resolution>,
): void {
  for (const diagnostic of diagnostics) {
    const conflict = diagnostic.message.match(
      /Conflict ID: (c_[0-9a-f]+)/,
    )?.[1];
    if (conflict === undefined || resolutions.has(conflict)) continue;

    if (diagnostic.code === "RUNTIME_PARSER_SHIFT_REDUCE_CONFLICT") {
      resolutions.set(conflict, { conflict, prefer: "shift" });
      continue;
    }
    if (diagnostic.code !== "RUNTIME_PARSER_REDUCE_REDUCE_CONFLICT") continue;

    const reductions = [...diagnostic.message.matchAll(
      /Reduction interpretation:\n[ ]{2}([^\n]+)/g,
    )].map((match) => match[1]);
    resolutions.set(conflict, {
      conflict,
      prefer: "reduce",
      reduce: preferredReduction(conflict, reductions),
    });
  }
}

function metadataSource(resolutions: ReadonlyMap<string, Resolution>): string {
  const metadata = {
    version: 2,
    parser: {
      resolutions: [...resolutions.values()].sort((left, right) =>
        left.conflict.localeCompare(right.conflict)
      ),
    },
  };
  return JSON.stringify(metadata, null, 2) + "\n";
}

function preferredReduction(
  conflict: string,
  reductions: readonly string[],
): string {
  const preferredRules = [
    "array_expression",
    "index_assignment",
    "block",
    "field_block",
    "shorthand_field",
    "field_definition",
    "binding_statement",
  ];
  for (const rule of preferredRules) {
    const reduction = reductions.find((candidate) =>
      candidate.startsWith(`${rule} =`)
    );
    if (reduction !== undefined) return reduction;
  }
  throw new Error(
    `Duck conflict ${conflict} has no reviewed reduction: ${
      reductions.join(" | ")
    }`,
  );
}

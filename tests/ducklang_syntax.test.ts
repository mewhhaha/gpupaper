import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";

const parserWasmUrl = new URL(
  "../grammar/generated/parser.wasm",
  import.meta.url,
);
const parserPlanUrl = new URL(
  "../grammar/generated/parser.plan",
  import.meta.url,
);
const corpusUrl = new URL("../examples/binned/", import.meta.url);

Deno.test("Baba generated Wasm accepts every Ducklang source file", async () => {
  const parser = createParser({
    bytes: await Deno.readFile(parserWasmUrl),
    plan: await Deno.readFile(parserPlanUrl),
  });

  try {
    const sources = await collectDuckSources(corpusUrl);
    assertEquals(sources.length, 118, "vendored Duck source count");

    const failures: string[] = [];
    for (const sourceUrl of sources) {
      const source = await Deno.readTextFile(sourceUrl);
      const result = parser.parse(source, { maxTraceActions: 10_000_000 });
      if (result.ok) continue;

      const diagnostics = result.diagnostics.map((diagnostic) => {
        const start = diagnostic.span.start;
        const excerpt = source.slice(Math.max(0, start - 24), start + 32)
          .replaceAll("\n", "\\n");
        const lexed = parser.lex(source);
        const nearbyTokens: string[] = [];
        for (let index = 0; index < lexed.tokenTape.length; index++) {
          const token = lexed.tokenTape.token(index);
          if (token === undefined || token.channel === "trivia") continue;
          if (token.span.end < start - 24 || token.span.start > start + 32) {
            continue;
          }
          const kind = token.type === "named" ? token.kind : token.type;
          nearbyTokens.push(`${kind}:${JSON.stringify(token.text)}`);
        }
        return `${diagnostic.code} at ${start}: ${diagnostic.message}; near ${excerpt}; tokens ${
          nearbyTokens.join(" ")
        }; details ${JSON.stringify(diagnostic)}`;
      }).join("; ");
      failures.push(`${sourceUrl.pathname}: ${diagnostics}`);
    }
    if (failures.length > 0) {
      throw new Error(
        `Baba rejected ${failures.length} Ducklang sources:\n${
          failures.join("\n")
        }`,
      );
    }
  } finally {
    parser.dispose();
  }
});

async function collectDuckSources(directory: URL): Promise<URL[]> {
  const sources: URL[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const child = new URL(
      entry.name + (entry.isDirectory ? "/" : ""),
      directory,
    );
    if (entry.isDirectory) {
      sources.push(...await collectDuckSources(child));
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".duck")) sources.push(child);
  }
  return sources.sort((left, right) =>
    left.pathname.localeCompare(right.pathname)
  );
}

function assertEquals(actual: number, expected: number, subject: string): void {
  if (actual !== expected) {
    throw new Error(`${subject}: expected ${expected}, received ${actual}`);
  }
}

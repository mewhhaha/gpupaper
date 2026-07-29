import { parseDucklangModule } from "../src/ducklang_parser.ts";

const corpusUrl = new URL("../examples/binned/", import.meta.url);
const liveTargetUrl = new URL("../examples/binned/live/", import.meta.url);

Deno.test("Ducklang frontend parses every vendored source file", async () => {
  const sources = (await collectDuckSources(corpusUrl)).filter((source) =>
    !source.pathname.startsWith(liveTargetUrl.pathname)
  );
  assertEquals(sources.length, 121, "vendored Duck source count");

  const failures: string[] = [];
  for (const sourceUrl of sources) {
    try {
      await parseDucklangModule(
        sourceUrl.pathname,
        await Deno.readTextFile(sourceUrl),
      );
    } catch (error) {
      failures.push(
        `${sourceUrl.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Ducklang rejected ${failures.length} vendored sources:\n${
        failures.join("\n")
      }`,
    );
  }
});

Deno.test("Ducklang frontend parses every frozen live Binned target", async () => {
  const sources = await collectDuckSources(liveTargetUrl);
  assertEquals(sources.length, 35, "frozen live Duck source count");

  const failures: string[] = [];
  for (const sourceUrl of sources) {
    try {
      await parseDucklangModule(
        sourceUrl.pathname,
        await Deno.readTextFile(sourceUrl),
      );
    } catch (error) {
      failures.push(
        `${sourceUrl.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Ducklang rejected ${failures.length} frozen live sources:\n${
        failures.join("\n")
      }`,
    );
  }
});

Deno.test("assignment-valued conditionals remain one expression", async () => {
  const module = await parseDucklangModule(
    "conditional_assignment.duck",
    `let result = 0
result = if true {
  41
} else {
  result
}
result
`,
  );
  const assignment = module.statements[1];
  if (assignment?.kind !== "assignment") {
    throw new Error(
      `expected conditional assignment, received ${assignment?.kind}`,
    );
  }
  if (assignment.value.kind !== "if") {
    throw new Error(
      `expected assignment-valued if, received ${assignment.value.kind}`,
    );
  }
  if (module.statements.length !== 3) {
    throw new Error(
      `expected three statements, received ${module.statements.length}`,
    );
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

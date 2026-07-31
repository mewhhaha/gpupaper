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

Deno.test("Ducklang syntax retains explicit handlers and handled computations", async () => {
  const module = await parseDucklangModule(
    "explicit_effect_syntax.duck",
    `effect Counter {
  get: () => I32
}

let run = () => Counter.get()
let counter = Counter {
  get: (!resume) => !resume(40),
  return: value => value,
}
try run() with counter
`,
  );
  const counter = module.statements.find((statement) =>
    statement.kind === "binding" && statement.name.text === "counter"
  );
  const result = module.statements.at(-1);

  const counterKind = counter?.kind === "binding"
    ? counter.value.kind
    : undefined;
  if (counterKind !== "effectHandler") {
    throw new Error(`expected effectHandler, received ${counterKind}`);
  }
  const resultKind = result?.kind === "expression"
    ? result.expression.kind
    : undefined;
  if (resultKind !== "handle") {
    throw new Error(`expected handle, received ${resultKind}`);
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

Deno.test("mixed boolean and comparison operators use language precedence", async () => {
  const module = await parseDucklangModule(
    "mixed_precedence.duck",
    `let output = ""
let segment_start = 0
let index = 1
let pending_space = output != "" || segment_start < index
pending_space
`,
  );
  const binding = module.statements[3];
  if (binding?.kind !== "binding") {
    throw new Error(`expected binding, received ${binding?.kind}`);
  }
  assertBinaryShape(binding.value, "||", "!=", "<");
});

Deno.test("explicit parentheses override binary operator precedence", async () => {
  const module = await parseDucklangModule(
    "parenthesized_precedence.duck",
    `let grouped = (true || false) == true
grouped
`,
  );
  const binding = module.statements[0];
  if (binding?.kind !== "binding") {
    throw new Error(`expected binding, received ${binding?.kind}`);
  }
  assertBinaryShape(binding.value, "==", "||", undefined);
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

function assertBinaryShape(
  expression: import("../src/ducklang_ast.ts").DucklangExpression,
  operator: string,
  leftOperator: string | undefined,
  rightOperator: string | undefined,
): void {
  if (expression.kind !== "binary" || expression.operator !== operator) {
    throw new Error(
      `expected ${operator} expression, received ${
        expression.kind === "binary" ? expression.operator : expression.kind
      }`,
    );
  }
  const actualLeft = expression.left.kind === "binary"
    ? expression.left.operator
    : undefined;
  const actualRight = expression.right.kind === "binary"
    ? expression.right.operator
    : undefined;
  if (actualLeft !== leftOperator || actualRight !== rightOperator) {
    throw new Error(
      `expected ${String(leftOperator)} ${operator} ${
        String(rightOperator)
      }, received ${String(actualLeft)} ${operator} ${String(actualRight)}`,
    );
  }
}

function assertEquals(actual: number, expected: number, subject: string): void {
  if (actual !== expected) {
    throw new Error(`${subject}: expected ${expected}, received ${actual}`);
  }
}

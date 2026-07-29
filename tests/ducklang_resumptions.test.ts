import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Affine use of resumptions.
 *
 * A handler clause declares its resumption linear, as `(!resume)`, but elaboration
 * substitutes it away and inlines each call as its argument, so resolution never
 * saw the `!`. A clause could therefore resume twice: the two calls were simply
 * inlined side by side and the program ran, which is not a continuation being
 * invoked twice but its body duplicated.
 *
 * Ordinary linear parameters were never affected. `(!value) => value + value` is
 * rejected, and an unused one is rejected too, so the gap was specific to
 * resumptions.
 *
 * Resuming zero times stays allowed, which is the affine half of the roadmap's
 * "affine or linear": a clause may answer without resuming.
 */

const program = (clauseBody: string) =>
  `effect Counter {
  get: () => I32
}

let run: () -> <Counter> I32 = () => {
  value <- Counter.get()
  value + 2
}

let counter = {
  let count = 40
  Counter {
    get: (!resume) => ${clauseBody},
    return: value => value,
  }
}

try run() with counter
`;

Deno.test("Ducklang allows a handler clause to resume once", async () => {
  const artifact = await compile(program("!resume(count)"));
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    artifact.core.functions.some((function_) =>
      function_.blocks.some((block) =>
        block.operations.some((operation) =>
          operation.kind === "host.call" &&
          operation.effectName === "Counter"
        )
      )
    ),
    false,
  );
});

Deno.test("Ducklang allows a handler clause to answer without resuming", async () => {
  assertEquals(await run(program("count")), 42);
});

Deno.test("Ducklang rejects a handler clause that resumes twice", async () => {
  await assertRejects(
    program("!resume(count) + !resume(count)"),
    /handler clause get resumes 2 times; a resumption may be used at most once/,
  );
});

Deno.test("Ducklang enforces linearity on ordinary parameters too", async () => {
  // The neighbouring discipline the resumption rule restores, kept alongside it so
  // a regression in either is visible here.
  await assertRejects(
    "let twice = (!value) => value + value\nlet !token = 20\ntwice(!token)\n",
    /linear Ducklang value value was already consumed/,
  );
  await assertRejects(
    "let ignore = (!value) => 42\nlet !token = 1\nignore(!token)\n",
    /linear Ducklang value value was not consumed/,
  );
  assertEquals(
    await run(
      "let once = (!value) => value + 1\nlet !token = 41\nonce(!token)\n",
    ),
    42,
  );
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compile(source);
  return await runMain(artifact.wasm);
}

function compile(source: string) {
  return compileModuleSource("resume.duck", source, { gpuMode: "off" });
}

async function assertRejects(
  source: string,
  expected: RegExp,
): Promise<void> {
  let message = "";
  try {
    await compileModuleSource("resume.duck", source, { gpuMode: "off" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === "") throw new Error("expected a rejection");
  if (!expected.test(message)) {
    throw new Error(
      `expected ${expected}, received ${JSON.stringify(message)}`,
    );
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

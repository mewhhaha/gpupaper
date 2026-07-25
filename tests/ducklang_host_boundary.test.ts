import { compileModuleSource } from "../src/compiler.ts";
import { runDucklangManaged } from "../src/ducklang_runtime.ts";

/**
 * Module-boundary effects as typed host calls, and the reservation of
 * asynchronous effects.
 *
 * A declared effect operation that no source handler resolves becomes a host call.
 * The point of this test is that the boundary is *typed*: the accepting case alone
 * would pass against a boundary that accepted anything, so each rejection is a
 * separate case.
 */

const head = `module (!init: Init) where

declare effect Host {
  send: (Text) => I32
  count: () => I32
}

declare Init { host: Host }
`;

Deno.test("Ducklang lowers an unresolved effect to a host call", async () => {
  const artifact = await compileModuleSource(
    "host.duck",
    `${head}\nlet message: Text = "a" <> "b"\nresult <- Host.send(message)\nreturn { .result = result }\n`,
    { gpuMode: "off" },
  );
  const result = await runDucklangManaged(artifact, {
    host: { send: () => 7, count: () => 3 },
  });

  assertEquals(result, { result: 7 });
});

Deno.test("Ducklang types host call arguments at the boundary", async () => {
  await assertRejects(
    `${head}\nresult <- Host.send(42)\nreturn { .result = result }\n`,
    /cannot unify Ducklang text with i32/,
  );
});

Deno.test("Ducklang checks host call arity at the boundary", async () => {
  await assertRejects(
    `${head}\nresult <- Host.count(1)\nreturn { .result = result }\n`,
    /Ducklang effect operation Host\.count expects 0 arguments; received 1/,
  );
});

Deno.test("Ducklang rejects an undeclared host operation", async () => {
  await assertRejects(
    `${head}\nresult <- Host.missing()\nreturn { .result = result }\n`,
    /unknown Ducklang effect operation Host\.missing/,
  );
});

/**
 * Asynchronous effects stay reserved until a portable task/poll contract exists.
 *
 * There is no async surface to reserve accidentally: the grammar has no `async` or
 * `await`, and no effect declaration can be marked asynchronous. This asserts the
 * absence, so adding one becomes a deliberate change that fails here first.
 */
Deno.test("Ducklang has no asynchronous effect surface", async () => {
  await assertRejects(
    `${head}\nlet f = async () => 1\nf()\n`,
    /Unexpected token|unknown Ducklang name async/,
  );
  await assertRejects(
    "declare effect Host {\n  async read: () => I32\n}\n0\n",
    /Unexpected token|unknown Ducklang name async/,
  );
});

async function assertRejects(
  source: string,
  expected: RegExp,
): Promise<void> {
  let message = "";
  try {
    await compileModuleSource("host.duck", source, { gpuMode: "off" });
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

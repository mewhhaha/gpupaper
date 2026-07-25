import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Path-sensitive linear consumption.
 *
 * Linear use was counted once per reference across the whole module, so a value
 * consumed once in each arm of an `if` counted twice and was rejected even though
 * only one arm runs. The roadmap's rule is that mutually exclusive branches may
 * each consume an incoming linear value once.
 *
 * Both directions are pinned. The accepting cases would fail under global
 * counting; the rejecting cases would pass under a merge that forgot a branch's
 * consumption, which is the mistake a fix like this invites.
 */

const consume = "let consume = (!value) => value + 1\n";

Deno.test("Ducklang if arms may each consume the same linear value", async () => {
  assertEquals(
    await run(
      `${consume}let flag = 1\nlet !token = 41\nif flag == 1 {\n  consume(!token)\n} else {\n  consume(!token)\n}\n`,
    ),
    42,
  );
});

Deno.test("Ducklang match arms may each consume the same linear value", async () => {
  assertEquals(
    await run(
      `type Result = | \`Ok Int | \`Err Text\n${consume}let !token = 41\nlet r: Result = \`Ok (1)\nif let \`Ok v = r {\n  consume(!token)\n} else {\n  consume(!token)\n}\n`,
    ),
    42,
  );
});

Deno.test("Ducklang still rejects two consumptions on one path", async () => {
  await assertRejects(
    `${consume}let !token = 41\nconsume(!token) + consume(!token)\n`,
    /linear Ducklang value token was already consumed/,
  );
});

Deno.test("Ducklang still rejects a consumption after every arm consumed it", async () => {
  // Both arms consume, so the join agrees and the value is consumed afterwards.
  // This is the case that fails if a fix forgets to carry consumption out of a
  // branch.
  await assertRejects(
    `${consume}let flag = 1\nlet !token = 41\nlet first = if flag == 1 {\n  consume(!token)\n} else {\n  consume(!token)\n}\nfirst + consume(!token)\n`,
    /linear Ducklang value token was already consumed/,
  );
});

Deno.test("Ducklang rejects a join whose arms disagree about consumption", async () => {
  // One arm consumes and the other does not, so the state after the join would
  // depend on which arm ran, which a linear obligation forbids.
  await assertRejects(
    `${consume}let flag = 1\nlet !token = 41\nlet first = if flag == 1 {\n  consume(!token)\n} else {\n  0\n}\nfirst\n`,
    /linear Ducklang value token is consumed on some paths but not branch/,
  );
});

Deno.test("Ducklang still rejects two consumptions inside one arm", async () => {
  await assertRejects(
    `${consume}let flag = 1\nlet !token = 41\nif flag == 1 {\n  consume(!token) + consume(!token)\n} else {\n  0\n}\n`,
    /linear Ducklang value token was already consumed/,
  );
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("linear.duck", source, {
    gpuMode: "off",
  });
  return await runMain(artifact.wasm);
}

async function assertRejects(
  source: string,
  expected: RegExp,
): Promise<void> {
  let message = "";
  try {
    await compileModuleSource("linear.duck", source, { gpuMode: "off" });
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

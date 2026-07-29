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

/**
 * Borrow hazards.
 *
 * The validator already refuses to freeze a borrowed owner, because that changes
 * the owner's state while a borrow observes it. Mutating a borrowed owner changes
 * its contents under the borrow, which is the same hazard and a stronger one, and
 * was permitted.
 */
Deno.test("Ducklang rejects mutating a borrowed value", async () => {
  await assertRejects(
    'let message: Bytes = @Utf8.encode("ab")\nlet view = &message\nmessage[0] = 65\n@len(view)\n',
    /cannot mutate borrowed Ducklang value message/,
  );
});

Deno.test("Ducklang still rejects freezing a borrowed value", async () => {
  // The neighbouring rule this one was modelled on, kept so both stay together.
  await assertRejects(
    'let message: Text = "a" <> "b"\nlet view = &message\nlet frozen = freeze message\n@len(view) + @len(frozen)\n',
    /Cannot freeze borrowed owner message/,
  );
});

Deno.test("Ducklang still allows reading through a borrow", async () => {
  // The accepting side, so the new rule cannot pass by refusing all borrows.
  assertEquals(
    await run(
      'let message: Text = "a" <> "b"\nlet view = &message\n@len(view)\n',
    ),
    2,
  );
});

Deno.test("Ducklang still allows two shared borrows of one owner", async () => {
  assertEquals(
    await run(
      'let message: Text = "a" <> "b"\nlet a = &message\nlet b = &message\n@len(a) + @len(b)\n',
    ),
    4,
  );
});

Deno.test("Ducklang rejects moving an owner while it is borrowed", async () => {
  await assertRejects(
    'let consume = (!value) => @len(value)\nlet message: Text = "a" <> "b"\nlet view = &message\nconsume(!message)\n@len(view)\n',
    /cannot move borrowed Ducklang value message/,
  );
});

Deno.test("Ducklang rejects reading a value after it is moved", async () => {
  await assertRejects(
    'let consume = (!value) => @len(value)\nlet message: Text = "a" <> "b"\nconsume(!message)\n@len(message)\n',
    /moved Ducklang value message cannot be used/,
  );
});

Deno.test("Ducklang negates a call to a reusable function", async () => {
  assertEquals(
    await run(
      "let is_zero = value => value == 0\nif !is_zero(1) { 42 } else { 0 }\n",
    ),
    42,
  );
});

/**
 * Scratch region escapes.
 *
 * The rule existed and the corpus tested it, but it only asked whether the scratch
 * block's result was *itself* an allocation. Every indirection slipped past:
 * binding the allocation and returning the name escaped, and so did returning it
 * inside an aggregate. Both hand out a pointer into a region that is about to go
 * away.
 *
 * Freezing is the sanctioned way out, which is how
 * examples/showcases/05_linear_host_session.duck exports a scratch allocation, so
 * that case is pinned alongside the rejections.
 */
Deno.test("Ducklang rejects a scratch allocation returned directly", async () => {
  await assertRejects(
    'let escaped = scratch {\n  "a" <> "b"\n}\n@len(escaped)\n',
    /allocated value cannot leave scratch region/,
  );
});

Deno.test("Ducklang rejects a scratch allocation returned through a binding", async () => {
  await assertRejects(
    'let escaped = scratch {\n  let inner = "a" <> "b"\n  inner\n}\n@len(escaped)\n',
    /allocated value cannot leave scratch region/,
  );
});

Deno.test("Ducklang rejects a scratch allocation returned inside an aggregate", async () => {
  await assertRejects(
    'let escaped = scratch {\n  ("a" <> "b", 1)\n}\n1\n',
    /allocated value cannot leave scratch region/,
  );
});

Deno.test("Ducklang allows a frozen scratch allocation to leave", async () => {
  // Freezing detaches the value from the region's lifetime. Without this the rule
  // would reject the corpus session example.
  assertEquals(
    await run(
      'let message = scratch {\n  let temporary: Text = "hel" <> "lo"\n  freeze temporary\n}\n@len(message)\n',
    ),
    5,
  );
});

Deno.test("Ducklang allows a scratch block returning a scalar", async () => {
  assertEquals(
    await run(
      "let value = scratch {\n  let inner = 1 + 2\n  inner\n}\nvalue\n",
    ),
    3,
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

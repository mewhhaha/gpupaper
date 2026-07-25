import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * A loop whose value is taken must supply one on every exit.
 *
 * Mixing a valued `break` with a bare one used to be accepted, and the bare path
 * fabricated an `i32` zero. A loop yielding 7 on its valued exit returned 0
 * through the bare one, and a `Text`-yielding loop passed that zero on as a
 * buffer handle, failing at runtime with "unknown handle 0" rather than being
 * diagnosed. Both are silent-wrong-answer shapes, so they are rejected now.
 *
 * The check runs before static loop expansion. Placed after it, a
 * constant-conditioned loop was already folded to the fabricated zero and there
 * was nothing left to object to; the static case below is what catches that
 * ordering mistake.
 */

Deno.test("Ducklang rejects a loop that mixes valued and bare breaks", async () => {
  await assertRejects(
    // Runtime-unknown condition, so the loop survives to lowering intact.
    "let pick = flag => loop {\n  if flag == 1 {\n    break 7\n  }\n\n  break\n}\npick(0)\n",
    /Ducklang loop mixes a valued break with a bare break/,
  );
});

Deno.test("Ducklang rejects mixed breaks even when the loop folds statically", async () => {
  await assertRejects(
    // A literal condition lets static expansion fold the loop away. This case
    // returned 0 before the check moved ahead of that pass.
    "let flag = 0\nlet result = loop {\n  if flag == 1 {\n    break 7\n  }\n\n  break\n}\nresult\n",
    /Ducklang loop mixes a valued break with a bare break/,
  );
});

Deno.test("Ducklang rejects a bare break reached from a Text-valued loop", async () => {
  await assertRejects(
    'let pick = flag => loop {\n  if flag == 1 {\n    break "hello"\n  }\n\n  break\n}\npick(0)\n',
    /Ducklang loop mixes a valued break with a bare break/,
  );
});

Deno.test("Ducklang still accepts a loop whose every exit is valued", async () => {
  // The corpus shape from examples/loops/09_loop_expression_syntax.duck: two
  // valued breaks and no bare one. The rejection must not catch this.
  const source =
    "let flag = 1\nlet result = loop {\n  if flag == 1 {\n    break 42\n  }\n\n  break 0\n}\nresult\n";
  const artifact = await compileModuleSource("valued.duck", source, {
    gpuMode: "off",
  });

  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang still accepts a bare break in a statement loop", async () => {
  // A `for` statement is not used for its value, so a bare break is the normal
  // spelling and must keep working. Mirrors examples/loops/04_break.duck.
  const source =
    "let total = 27\n\nfor value in 0..10 {\n  if value == 6 {\n    break\n  }\n\n  total = total + value\n}\n\ntotal\n";
  const artifact = await compileModuleSource("statement.duck", source, {
    gpuMode: "off",
  });

  // 27 + 0 + 1 + 2 + 3 + 4 + 5 = 42, stopping before 6.
  assertEquals(await runMain(artifact.wasm), 42);
});

async function assertRejects(
  source: string,
  expected: RegExp,
): Promise<void> {
  let message = "";
  try {
    await compileModuleSource("loop_exits.duck", source, { gpuMode: "off" });
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

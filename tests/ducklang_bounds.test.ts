import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Out-of-bounds traps for buffer and aggregate indexing.
 *
 * The corpus contract already asserts that the two out-of-bounds fixtures fail,
 * but it accepts any thrown error, so it cannot tell a bounds trap from an
 * unrelated failure. These cases pin the behavior from both sides: the same
 * program with an in-bounds index must return a value, and only the
 * out-of-bounds index may trap. Without the in-bounds half, a program that
 * always failed would satisfy the contract.
 */

const textIndex =
  `module (!init: Init) where\n\nconst { get } = import "duck:prelude/runtime" ()\n\ndeclare effect Input {\n  index: () => I32\n}\n\ndeclare Init { input: Input }\n\nindex <- Input.index()\nlet result: I32 = get("abc", index)\nreturn { .result = result }\n`;

const structIndex =
  `module (!init: Init) where\n\nconst { struct } = import "duck:prelude" ()\n\ndeclare effect Input {\n  index: () => I32\n}\n\ndeclare Init { input: Input }\n\ntype Pair = struct { .first = Int, .second = Int }\n\nlet pair: Pair = [20, 22]\nindex <- Input.index()\nlet result: I32 = pair[index]\nreturn { .result = result }\n`;

Deno.test("Ducklang buffer indexing traps only outside its bounds", async () => {
  const wasm = await compile("text_bounds.duck", textIndex);

  // "abc" has three code units, so 0 and 2 are in bounds.
  assertEquals(
    typeof await runMain(wasm, { input: { index: 0 } }),
    "number",
  );
  assertEquals(
    typeof await runMain(wasm, { input: { index: 2 } }),
    "number",
  );
  await assertTraps(wasm, 3);
  await assertTraps(wasm, 99);
});

Deno.test("Ducklang aggregate indexing traps only outside its bounds", async () => {
  const wasm = await compile("struct_bounds.duck", structIndex);

  assertEquals(await runMain(wasm, { input: { index: 0 } }), 20);
  assertEquals(await runMain(wasm, { input: { index: 1 } }), 22);
  await assertTraps(wasm, 2);
  await assertTraps(wasm, 7);
});

Deno.test("Ducklang out-of-bounds traps repeat for the same input", async () => {
  const wasm = await compile("struct_bounds.duck", structIndex);
  const first = await trapName(wasm, 2);
  const second = await trapName(wasm, 2);

  assertEquals(first, second);
  // In-bounds behavior is stable too, so the trap is about the index and not
  // about the module being re-instantiated.
  assertEquals(
    await runMain(wasm, { input: { index: 1 } }),
    await runMain(wasm, { input: { index: 1 } }),
  );
});

async function compile(name: string, source: string): Promise<Uint8Array> {
  const artifact = await compileModuleSource(
    name as `${string}.duck`,
    source,
    { gpuMode: "off" },
  );
  return artifact.wasm;
}

async function assertTraps(wasm: Uint8Array, index: number): Promise<void> {
  try {
    const result = await runMain(wasm, { input: { index: index } });
    throw new Error(`index ${index} returned ${result} instead of trapping`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/instead of trapping/.test(message)) throw error;
    // A bounds violation must surface as a Wasm trap, not as a host error.
    if (!/unreachable|out of bounds|memory access/i.test(message)) {
      throw new Error(
        `index ${index} failed without a trap: ${JSON.stringify(message)}`,
      );
    }
  }
}

async function trapName(wasm: Uint8Array, index: number): Promise<string> {
  try {
    await runMain(wasm, { input: { index: index } });
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : "?";
  }
  throw new Error(`index ${index} did not trap`);
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

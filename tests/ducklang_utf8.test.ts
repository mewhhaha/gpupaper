import { compileModuleSource, runMain } from "../src/compiler.ts";
import { evaluateDucklangConst } from "../src/ducklang_const.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * UTF-8 encode and decode, and that both stages validate.
 *
 * The round trip alone would pass against a decoder that never checked anything,
 * since encoding only ever produces valid bytes. So invalid input is constructed by
 * mutating an encoded buffer, and both a lone continuation byte and a truncated
 * multi-byte sequence are required to be rejected.
 *
 * `@len` on Text is a byte count, not a character count: "żółw" is four characters
 * and seven bytes, and reports 7. That is consistent with Text being byte-indexed,
 * which the out-of-bounds tests rely on too.
 */

Deno.test("Ducklang round-trips UTF-8 at runtime", async () => {
  assertEquals(
    await run('let bytes = @Utf8.encode("hi")\n@len(@Utf8.decode(bytes))\n'),
    2,
  );
  // Multi-byte input, so the round trip covers more than ASCII.
  assertEquals(
    await run('let bytes = @Utf8.encode("żółw")\n@len(@Utf8.decode(bytes))\n'),
    7,
  );
});

Deno.test("Ducklang rejects a lone continuation byte at runtime", async () => {
  // 0x80 is a continuation byte with no lead byte, so never valid UTF-8.
  await assertRejects(
    'let bytes = @Utf8.encode("a")\nbytes[0] = 128\n@len(@Utf8.decode(bytes))\n',
    /Ducklang UTF-8 decode received invalid bytes/,
  );
});

Deno.test("Ducklang rejects a truncated sequence at runtime", async () => {
  // 0xC5 opens a two-byte sequence that a one-byte buffer cannot complete.
  await assertRejects(
    'let bytes = @Utf8.encode("a")\nbytes[0] = 197\n@len(@Utf8.decode(bytes))\n',
    /Ducklang UTF-8 decode received invalid bytes/,
  );
});

Deno.test("Ducklang round-trips UTF-8 at compile time", async () => {
  const typed = inferDucklangModule(
    resolveDucklangModule(
      await parseDucklangModule(
        "utf8.duck",
        'comptime @Utf8.decode(@Utf8.encode("żółw"))\n',
      ),
    ),
  );

  // The same content, so the compile-time path is not a different codec.
  assertEquals(evaluateDucklangConst(typed.result, { fuel: 10_000 }), {
    kind: "scalar",
    scalar: { kind: "text", value: "żółw" },
  });
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compileModuleSource("utf8.duck", source, {
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
    const artifact = await compileModuleSource("utf8.duck", source, {
      gpuMode: "off",
    });
    await runMain(artifact.wasm);
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

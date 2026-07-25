import { compileModuleSource, runMain } from "../src/compiler.ts";

/**
 * Values are stackified into postfix order, locals are assigned where bindings need them,
 * and each branch carries a computed block signature rather than the void form.
 *
 * The block signature is checked at the byte level because that is the only place it
 * survives: the emitter picks `ifI32`/`ifI64`/`ifF32`/`ifF64` per branch type while writing
 * bytes, and the public FcgModule operation drops `resultType` entirely, so inspecting the
 * graph would find nothing and prove nothing.
 *
 * Scanning for opcode 0x04 is safe here only because the program is fixed and tiny. The
 * scan is filtered to 0x04 bytes followed by a block type, and the count is asserted to be
 * exactly one, so a future change that introduces a second candidate fails loudly instead
 * of silently checking the wrong byte. (In this module the other bare 0x04 is the length
 * prefix of the export name "main".)
 *
 * The non-i32 arms cannot be reached from source: Ducklang has no float literals and no
 * return-type annotation on the arrow form, so `1.5` is a parse error. They are reached by
 * larger programs instead, and mutation testing located which: disabling the i64 arm alone
 * fails tests/ducklang_corpus_contract.test.ts, and disabling both float arms alone fails
 * the raytracer in tests/ducklang_managed.test.ts. Forcing every branch to i32 fails both.
 * So all four arms are load-bearing, and this file pins the one reachable from source
 * directly plus two other typed shapes end to end.
 */

const blockTypes = new Set([0x40, 0x7f, 0x7e, 0x7d, 0x7c]);

Deno.test("Ducklang gives a value branch a typed block signature", async () => {
  const artifact = await compileModuleSource(
    "branch.duck",
    "let pick = flag => if flag { 40 } else { 2 }\npick(true) + 2\n",
    { gpuMode: "off" },
  );

  // The condition is a parameter, so the branch survives to the binary instead of folding.
  assertEquals(await runMain(artifact.wasm), 42);

  const bytes = [...new Uint8Array(artifact.wasm)];
  const signatures: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0x04 && blockTypes.has(bytes[index + 1])) {
      signatures.push(bytes[index + 1]);
    }
  }

  assertEquals(signatures.length, 1);
  // 0x7f is i32; 0x40 is the void form this branch must not have been given.
  assertEquals(signatures[0], 0x7f);
});

Deno.test("Ducklang branch signatures satisfy the engine's validator", async () => {
  // A block signature that disagreed with what the branches leave on the stack is
  // exactly what WebAssembly.validate rejects, so validation is the check that the
  // computed signature is right and not merely present.
  const sources: readonly (readonly [string, string, number])[] = [
    [
      "union.duck",
      "type Option = | `Some I32 | `None Unit\n" +
      "let pick = flag => if flag { `Some (40) } else { `None () }\n" +
      "let out = pick(true)\n" +
      "if let `Some value = out { value + 2 } else { 0 }\n",
      42,
    ],
    [
      "nested.duck",
      "let sign = n => if n == 0 { 40 } else { if n > 0 { 1 } else { 2 } }\n" +
      "sign(0) + sign(7) + 1\n",
      42,
    ],
  ];

  for (const [file, source, expected] of sources) {
    const artifact = await compileModuleSource(file, source, {
      gpuMode: "off",
    });

    assertEquals(await runMain(artifact.wasm), expected);
    assertEquals(
      WebAssembly.validate(new Uint8Array(artifact.wasm).buffer as ArrayBuffer),
      true,
    );
  }
});

Deno.test("Ducklang assigns locals where bindings need them", async () => {
  const withBindings = await compileModuleSource(
    "locals.duck",
    "let f = x => {\n  let a = x + 1\n  let b = a + 1\n  a + b\n}\nf(19)\n",
    { gpuMode: "off" },
  );

  // a = 20, b = 21.
  assertEquals(await runMain(withBindings.wasm), 41);
  assertEquals(named(withBindings, "f__duck").localCount, 2);

  const withoutBindings = await compileModuleSource(
    "nolocals.duck",
    "let g = x => x + x\ng(21)\n",
    { gpuMode: "off" },
  );

  assertEquals(await runMain(withoutBindings.wasm), 42);
  // Parameters are not locals here, so a function that binds nothing declares none
  // rather than reserving slots it never reads.
  assertEquals(named(withoutBindings, "g__duck").localCount, 0);
});

Deno.test("Ducklang stackifies expressions into postfix order", async () => {
  const artifact = await compileModuleSource(
    "postfix.duck",
    "let f = x => {\n  let a = x + 1\n  let b = a + 1\n  a + b\n}\nf(19)\n",
    { gpuMode: "off" },
  );

  const f = named(artifact, "f__duck");

  // Each operator follows the operands it consumes, and the expression tree is gone:
  // what is left is one flat sequence for a stack machine to run.
  assertEquals(f.operations.map((operation) => operation.opcode), [
    "local.get",
    "const",
    "i32.+",
    "local.set",
    "local.get",
    "const",
    "i32.+",
    "local.set",
    "local.get",
    "local.get",
    "i32.+",
  ]);

  // Operands are immediates, never nested operations, which is what makes the sequence
  // flat rather than a tree wearing a list's shape.
  for (const operation of f.operations) {
    for (const operand of operation.operands) {
      assertEquals(typeof operand, "number");
    }
  }
});

function named(
  artifact: {
    readonly fcg: {
      readonly functions: readonly {
        readonly name: string;
        readonly localCount: number;
        readonly operations: readonly {
          readonly opcode: string;
          readonly operands: readonly unknown[];
        }[];
      }[];
    };
  },
  prefix: string,
) {
  const found = artifact.fcg.functions.find((candidate) =>
    candidate.name.startsWith(prefix)
  );
  if (found === undefined) {
    throw new Error(
      `no function starting with ${prefix}; found ${
        artifact.fcg.functions.map((candidate) => candidate.name).join(", ")
      }`,
    );
  }
  return found;
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

import { compileModuleSource } from "../src/compiler.ts";
import { runDucklangManaged } from "../src/ducklang_runtime.ts";

/**
 * An effect binding must perform its effect once.
 *
 * THESE TESTS FAIL ON PURPOSE. They record a confirmed silent miscompile and must
 * not be made green by weakening the assertions.
 *
 * `value <- Input.read()` is a binding, so the effect runs once and every use of
 * `value` sees that one result. Today the effect is re-performed at each use: two
 * uses call the host twice, three uses three times, and because successive calls
 * can return different values, `value + value` is not even twice `value`.
 *
 * Localized: the frontend is not at fault. Counting `hostCall` nodes after every
 * elaboration stage gives 1 throughout, from parsing through source tests, type
 * qualification, export lowering, ownership, handlers, derivations, extensions,
 * static loops, control flow, resolution, inference, and closure specialization.
 * The duplication therefore happens in FCG lowering or Wasm emission, in
 * `lowerDucklangToFcgAndWasm`.
 *
 * This also explains the dynamic range step defect recorded in TASKS.md: a step
 * bound with `<-` is re-performed, which is why `0..bound by step` ran with the
 * second value.
 */

const head = `module (!init: Init) where

declare effect Input {
  read: () => I32
}

declare Init { input: Input }
`;

Deno.test("Ducklang effect bindings perform their effect once per binding", async () => {
  const artifact = await compile(
    `${head}\nvalue <- Input.read()\nlet total = value + value\nreturn { .result = total }\n`,
  );
  let calls = 0;
  const result = await runDucklangManaged(artifact, {
    input: {
      read: () => {
        calls += 1;
        return 1;
      },
    },
  });

  assertEquals(result, { result: 2 });
  // One binding, one performance, however many times the value is read.
  assertEquals(calls, 1);
});

Deno.test("Ducklang effect bindings keep one value across uses", async () => {
  const artifact = await compile(
    `${head}\nvalue <- Input.read()\nlet total = value + value\nreturn { .result = total }\n`,
  );
  // Successive calls differ, so re-performing is distinguishable from binding.
  const values = [1, 100];
  let calls = 0;
  const result = await runDucklangManaged(artifact, {
    input: {
      read: () => {
        const next = values[Math.min(calls, values.length - 1)];
        calls += 1;
        return next;
      },
    },
  });

  // Bound once, both uses see 1, so 1 + 1. Re-performed gives 1 + 100 = 101.
  assertEquals(result, { result: 2 });
});

Deno.test("Ducklang effect performances do not scale with use count", async () => {
  const artifact = await compile(
    `${head}\nvalue <- Input.read()\nlet total = value + value + value\nreturn { .result = total }\n`,
  );
  let calls = 0;
  await runDucklangManaged(artifact, {
    input: {
      read: () => {
        calls += 1;
        return 1;
      },
    },
  });

  // Three uses currently mean three host calls.
  assertEquals(calls, 1);
});

function compile(source: string) {
  return compileModuleSource("effect_binding.duck", source, {
    gpuMode: "off",
  });
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

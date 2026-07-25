import { compileModuleSource, runMain } from "../src/compiler.ts";
import { expandDucklangIncludes } from "../src/ducklang_module_graph.ts";

/**
 * Compile-time-only bindings and values must not survive into the backend.
 *
 * Two things are asserted, because either alone is weak. A binding used only at
 * compile time is gone from the typed module entirely, and no `comptime` node
 * remains anywhere in it, so every staged expression was evaluated rather than
 * carried along. The programs are also run, so erasure cannot pass by deleting
 * something the answer needed.
 *
 * Note what is deliberately not asserted: that no binding carries the compile-time
 * stage. That stage records the declaration kind, so a `const` read at runtime keeps
 * it and must survive as a runtime definition. The editor has 17 such bindings and
 * `escape_character` alone is read four times, so requiring the stage to be absent
 * would demand erasing values the program needs.
 */

const programs: readonly (readonly [string, string, number])[] = [
  [
    "a const folded into a comptime result",
    "const base = 40\nlet total = comptime (base + 2)\ntotal\n",
    42,
  ],
  [
    "a chain of compile-time-only consts",
    "const scale = 2\nconst step = comptime (scale * 3)\nlet total = comptime (step + 36)\ntotal\n",
    42,
  ],
  [
    "a const read at runtime",
    "const base = 40\nlet total = base + 2\ntotal\n",
    42,
  ],
];

for (const [description, source, expected] of programs) {
  Deno.test(`Ducklang erases compile-time bindings for ${description}`, async () => {
    const artifact = await compileModuleSource("erasure.duck", source, {
      gpuMode: "off",
    });

    assertEquals(await runMain(artifact.wasm), expected);
    // Only `total` is read afterwards, so every other binding in these programs is
    // compile-time only and must be gone.
    assertEquals(
      artifact.inferred.bindings.map((binding) => binding.symbol.text),
      ["total"],
    );
    assertEquals(comptimeNodes(artifact.inferred), 0);
  });
}

Deno.test("Ducklang erases compile-time bindings in the frozen targets", async () => {
  // The synthetic cases are small enough to erase by accident. These are not.
  for (
    const [target, host] of [
      [
        "examples/binned/live/case-studies/editor/editor.duck",
        "examples/binned/live/case-studies/editor/host.duck",
      ],
      [
        "examples/binned/live/case-studies/grep/grep.duck",
        "examples/binned/live/case-studies/grep/host.duck",
      ],
    ]
  ) {
    const file = await Deno.realPath(target);
    const artifact = await compileModuleSource(
      file as `${string}.duck`,
      await expandDucklangIncludes(file, await Deno.readTextFile(file)),
      { gpuMode: "off", hostInterface: await Deno.realPath(host) },
    );

    assertEquals(comptimeNodes(artifact.inferred), 0);
    // A non-trivial module, so zero residual nodes cannot pass by the module being
    // empty. Bindings that survive are read at runtime, which is why the stage
    // itself is not asserted.
    assertEquals(artifact.inferred.bindings.length > 5, true);
  }
});

function comptimeNodes(value: unknown): number {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    if (node.kind === "comptime") count += 1;
    pending.push(...Object.values(node));
  }
  return count;
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

import { compileModuleSource } from "../src/compiler.ts";

/**
 * A diagnostic names the file the span came from, not the file being compiled.
 *
 * Linking splices a dependency's statements into the importer, and those statements
 * keep their original spans. Resolution used to build every message from its own
 * `#file` paired with the offending statement's offset, so an error inside a
 * dependency was reported against the importer at an offset that belonged to the
 * dependency. The result pointed at whatever text happened to sit at that offset in
 * the wrong file.
 *
 * This was not hypothetical. Compiling the live `prelude.duck` blamed
 * `prelude.duck:1247`, which is an import statement, for a loop that is actually at
 * offset 1247 of `prelude_types.duck`; and an error reported against
 * `prelude_functional.duck` turned out to be in `prelude_runtime.duck`. Two of the
 * five prelude modules named the wrong file, which is exactly the kind of thing that
 * sends the next person to the wrong place.
 *
 * The fixture's app is short enough that the dependency's offset lands inside it, so
 * the wrong answer is a plausible-looking location rather than an obvious overflow.
 * That is what makes asserting the file name worthwhile.
 */

Deno.test("Ducklang blames the dependency a spliced error came from", async () => {
  const path = "tests/fixtures/span_dependency_app.duck";
  let message = "";
  try {
    await compileModuleSource(path, await Deno.readTextFile(path), {
      gpuMode: "off",
    });
  } catch (error) {
    message = (error as Error).message;
  }

  // The undefined name is in the dependency, so that is the file named.
  assertEquals(/span_dependency_module\.duck:/.test(message), true);
  assertEquals(/unknown Ducklang name missing_name/.test(message), true);
  // And the importer is not blamed for it. Before this, the message read
  // "span_dependency_app.duck:64", an offset that belongs to the dependency.
  assertEquals(/span_dependency_app\.duck:/.test(message), false);
});

Deno.test("Ducklang still names the file for an error in the module itself", async () => {
  // The fix must not have traded one misattribution for another: a single-file
  // error still names that file.
  let message = "";
  try {
    await compileModuleSource(
      "solo.duck",
      "let f = x => x + absent_name\nf(1)\n",
      { gpuMode: "off" },
    );
  } catch (error) {
    message = (error as Error).message;
  }

  assertEquals(/solo\.duck:/.test(message), true);
  assertEquals(/unknown Ducklang name absent_name/.test(message), true);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

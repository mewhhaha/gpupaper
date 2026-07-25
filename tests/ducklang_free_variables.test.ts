import { ducklangFunctionFreeVariables } from "../src/ducklang_closures.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * Free variables of every runtime function, including nested ones.
 *
 * Module-scope symbols are excluded on purpose: they are addressable from any function
 * without being captured, so a closure environment never has to carry one. What the
 * analysis reports is exactly what an environment would need to hold, which is why a
 * function reading only module-level bindings has none.
 *
 * Each case names the expected symbols rather than counting them, because a count
 * passes just as well when the analysis reports the wrong symbol.
 */

Deno.test("Ducklang reports no free variables for a self-contained function", async () => {
  const analysis = await analyse("let add = (a, b) => a + b\nadd(20, 22)\n");
  const add = byParameters(analysis, ["a", "b"]);

  assertEquals(names(add.freeVariables), []);
});

Deno.test("Ducklang reports an enclosing parameter as free", async () => {
  const analysis = await analyse(
    "let outer = base => {\n  let inner = value => base + value\n  inner\n}\nouter\n",
  );
  const inner = byParameters(analysis, ["value"]);
  const outer = byParameters(analysis, ["base"]);

  // `inner` reads `base`, which belongs to `outer`, so it is a capture.
  assertEquals(names(inner.freeVariables), ["base"]);
  // `outer` declares `base` itself, so it captures nothing.
  assertEquals(names(outer.freeVariables), []);
});

Deno.test("Ducklang does not report a module binding as free", async () => {
  const analysis = await analyse(
    "const base = 40\nlet add = value => base + value\nadd(2)\n",
  );
  const add = byParameters(analysis, ["value"]);

  // `base` is module scope, addressable without an environment.
  assertEquals(names(add.freeVariables), []);
});

Deno.test("Ducklang reports a local binding as free when a nested function reads it", async () => {
  const analysis = await analyse(
    "let outer = () => {\n  let local = 40\n  let inner = value => local + value\n  inner\n}\nouter\n",
  );
  const inner = byParameters(analysis, ["value"]);

  assertEquals(names(inner.freeVariables), ["local"]);
});

Deno.test("Ducklang analyses every function, including nested ones", async () => {
  const analysis = await analyse(
    "let outer = base => {\n  let middle = mid => {\n    let inner = value => base + mid + value\n    inner\n  }\n  middle\n}\nouter\n",
  );

  // Three functions, and the innermost captures from both enclosing scopes.
  assertEquals(analysis.length, 3);
  const inner = byParameters(analysis, ["value"]);
  assertEquals([...names(inner.freeVariables)].sort(), ["base", "mid"]);
});

async function analyse(source: string) {
  const typed = inferDucklangModule(
    resolveDucklangModule(await parseDucklangModule("free.duck", source)),
  );
  return ducklangFunctionFreeVariables(typed);
}

function byParameters(
  analysis: readonly {
    readonly parameters: readonly { readonly text: string }[];
    readonly freeVariables: readonly { readonly text: string }[];
  }[],
  parameters: readonly string[],
) {
  const found = analysis.find((entry) =>
    JSON.stringify(entry.parameters.map((p) => p.text)) ===
      JSON.stringify(parameters)
  );
  if (found === undefined) {
    throw new Error(
      `no function with parameters ${parameters.join(", ")}; found ${
        analysis.map((entry) =>
          `(${entry.parameters.map((p) => p.text).join(",")})`
        )
          .join(" ")
      }`,
    );
  }
  return found;
}

function names(
  symbols: readonly { readonly text: string }[],
): readonly string[] {
  return symbols.map((symbol) => symbol.text);
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

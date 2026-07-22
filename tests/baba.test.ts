import { generate, type GeneratedBundle } from "@mewhhaha/baba";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";

const grammarUrl = new URL(
  "./fixtures/duck_contextual.baba",
  import.meta.url,
);

Deno.test("Baba 6 Wasm parser handles Duck contextual whitespace", async () => {
  const grammar = await Deno.readTextFile(grammarUrl);
  const bundle = generate(grammar, { name: "duck_contextual" });
  const wasm = binaryFile(bundle, "wasm/parser.wasm");
  const plan = binaryFile(bundle, "wasm/parser.plan");
  const parser = createParser({ bytes: wasm, plan });

  try {
    assertParses(parser.parse("app:f x if y z").ok, "function application");
    assertParses(parser.parse("app:f if y").ok, "application stop keyword");
    assertParses(parser.parse("type:Option Value").ok, "type application");
    assertParses(parser.parse("break:break 42").ok, "break value");
    assertParses(parser.parse("break:break   ").ok, "break terminator");
    assertParses(parser.parse("ext:first\nsecond").ok, "extension terminator");
  } finally {
    parser.dispose();
  }
});

Deno.test("Baba 6 generates a valid standalone Wasm parser", async () => {
  const grammar = await Deno.readTextFile(grammarUrl);
  const bundle = generate(grammar, { name: "duck_contextual" });
  const wasm = binaryFile(bundle, "wasm/parser.wasm");
  const copiedBytes = new Uint8Array(wasm);

  if (!WebAssembly.validate(copiedBytes.buffer)) {
    throw new Error("Baba generated an invalid Duck parser Wasm module");
  }
});

function binaryFile(bundle: GeneratedBundle, path: string): Uint8Array {
  const file = bundle.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`Baba bundle is missing ${path}`);
  }
  if (file.encoding !== "binary") {
    throw new Error(`Baba bundle ${path} is ${file.encoding}; expected binary`);
  }
  return file.content;
}

function assertParses(parsed: boolean, construct: string): void {
  if (!parsed) {
    throw new Error(`Baba failed to parse Duck ${construct}`);
  }
}

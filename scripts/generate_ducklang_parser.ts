import { generate, type GeneratedBundle, parseMetadata } from "@mewhhaha/baba";

const [grammarPath, metadataPath, outputDirectory] = Deno.args;
if (
  grammarPath === undefined || metadataPath === undefined ||
  outputDirectory === undefined
) {
  throw new Error(
    "usage: deno run --allow-read --allow-write scripts/generate_ducklang_parser.ts GRAMMAR METADATA OUTPUT_DIRECTORY",
  );
}

const grammar = await Deno.readTextFile(grammarPath);
const metadata = parseMetadata(await Deno.readTextFile(metadataPath));
const bundle = generate(grammar, {
  name: "ducklang",
  metadata,
  wasm: { parserStateLimit: 100_000 },
});

await Deno.mkdir(outputDirectory, { recursive: true });
await Deno.writeFile(
  `${outputDirectory}/parser.wasm`,
  binaryFile(bundle, "wasm/parser.wasm"),
);
await Deno.writeFile(
  `${outputDirectory}/parser.plan`,
  binaryFile(bundle, "wasm/parser.plan"),
);

function binaryFile(bundle: GeneratedBundle, path: string): Uint8Array {
  const file = bundle.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`Baba bundle is missing ${path}`);
  if (file.encoding !== "binary") {
    throw new Error(`Baba bundle ${path} is ${file.encoding}; expected binary`);
  }
  return file.content;
}

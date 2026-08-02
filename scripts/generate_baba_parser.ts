import { generate, type GeneratedBundle, parseMetadata } from "@mewhhaha/baba";

const [languageName, grammarPath, metadataPath, outputDirectory] = Deno.args;
if (
  languageName === undefined || grammarPath === undefined ||
  metadataPath === undefined ||
  outputDirectory === undefined
) {
  throw new Error(
    "usage: deno run --allow-read --allow-write scripts/generate_baba_parser.ts LANGUAGE GRAMMAR METADATA OUTPUT_DIRECTORY",
  );
}

const grammar = await Deno.readTextFile(grammarPath);
const metadata = parseMetadata(await Deno.readTextFile(metadataPath));
const bundle = generate(grammar, {
  name: languageName,
  metadata,
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

const manifest = new URL(
  "../rust-wasm-emitter/Cargo.toml",
  import.meta.url,
).pathname;
const crate = new URL("../rust-wasm-emitter/", import.meta.url).pathname;
const source =
  `${crate}target/wasm32-unknown-unknown/release/gpupaper_rust_wasm_emitter.wasm`;
const destination = new URL(
  "../src/generated/rust_wasm_emitter.wasm",
  import.meta.url,
).pathname;
const verifyOnly = Deno.args.includes("--check");

const build = await new Deno.Command("cargo", {
  args: [
    "build",
    "--manifest-path",
    manifest,
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--locked",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!build.success) {
  throw new Error(`Rust/Wasm emitter build exited ${build.code}`);
}

const builtBytes = await Deno.readFile(source);
if (verifyOnly) {
  const checkedInBytes = await Deno.readFile(destination);
  if (!equalBytes(builtBytes, checkedInBytes)) {
    throw new Error(
      `Rust/Wasm emitter artifact ${destination} differs from the release build; run deno task rust-wasm:build`,
    );
  }
} else {
  await Deno.mkdir(new URL("../src/generated/", import.meta.url), {
    recursive: true,
  });
  await Deno.writeFile(destination, builtBytes);
}
const bytes = verifyOnly ? builtBytes : await Deno.readFile(destination);
const module = await WebAssembly.compile(bytes as BufferSource);
const actualExports = WebAssembly.Module.exports(module).map((entry) =>
  entry.name
);
const requiredExports = [
  "memory",
  "abi_version",
  "input_resize",
  "prepare_plan",
  "emit_plan",
  "release_plan",
  "output_ptr",
  "output_len",
  "last_error_ptr",
  "last_error_len",
];
for (const required of requiredExports) {
  if (!actualExports.includes(required)) {
    throw new Error(
      `Rust/Wasm emitter omitted export ${JSON.stringify(required)}; found ${
        actualExports.join(", ")
      }`,
    );
  }
}
const instance = await WebAssembly.instantiate(module);
const abiVersion = (instance.exports.abi_version as () => number)() >>> 0;
if (abiVersion !== 2) {
  throw new Error(
    `Rust/Wasm emitter ABI must be 2; built artifact exports ${abiVersion}`,
  );
}
console.log(JSON.stringify({
  status: "completed",
  destination,
  wasmBytes: bytes.byteLength,
  abiVersion,
  exports: actualExports,
  verified: verifyOnly,
}));

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

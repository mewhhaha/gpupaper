import { isCompetingCompilerCommand } from "../scripts/benchmark_environment.ts";

Deno.test("compiler load detection covers native and runtime compilers", () => {
  const competing = [
    "/toolchains/bin/cargo build --release",
    "/toolchains/bin/rustc --crate-name compiler",
    "/home/user/.deno/bin/deno test tests/compiler.test.ts",
    "node benchmark.mjs",
    "node server.mjs",
  ];
  for (const command of competing) {
    if (isCompetingCompilerCommand(command)) continue;
    throw new Error(`compiler load detection missed ${command}`);
  }
});

Deno.test("compiler load detection ignores unrelated applications", () => {
  const unrelated = [
    "/opt/browser/browser --renderer",
    "/usr/bin/python documentation_test_generator.py",
  ];
  for (const command of unrelated) {
    if (!isCompetingCompilerCommand(command)) continue;
    throw new Error(`compiler load detection rejected ${command}`);
  }
});

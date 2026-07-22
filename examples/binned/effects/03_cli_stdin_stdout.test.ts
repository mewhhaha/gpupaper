import { assert_equals, assert_includes } from "../../src/assert.ts";
import { DuckRunner, Source } from "../../src/frontend.ts";
import {
  dry_run_stdin,
  type Init,
  main,
  mock_runner,
} from "./03_cli_stdin_stdout.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const source_url = new URL("./03_cli_stdin_stdout.duck", import.meta.url);

Deno.test("CLI artifact exposes Stdin and Stdout effects", () => {
  const artifact = Source.artifact_file(source_url.href);

  assert_equals(Object.keys(artifact.abi.effects), ["Stdin", "Stdout"]);
  assert_equals(artifact.abi.init, {
    name: "Init",
    fields: [
      {
        name: "stdin",
        type: { tag: "resource", effect: "Stdin" },
        import: "__duck_init_stdin",
      },
      {
        name: "stdout",
        type: { tag: "resource", effect: "Stdout" },
        import: "__duck_init_stdout",
      },
    ],
  });
  assert_equals(artifact.abi.requirements.module, [
    { effect: "Stdin", operation: "read_line" },
    { effect: "Stdout", operation: "write_line" },
  ]);
  assert_equals(artifact.abi.requirements.functions, {
    echo: {
      effects: [
        { effect: "Stdin", operation: "read_line" },
        { effect: "Stdout", operation: "write_line" },
      ],
    },
  });
  assert_includes(
    artifact.wat,
    '(import "duck_effect" "Stdin.read_line"',
  );
  assert_includes(
    artifact.wat,
    '(import "duck_effect" "Stdout.write_line"',
  );
});

Deno.test("CLI main uses the supplied effect runner", async () => {
  let reads = 0;
  const stdout: string[] = [];
  const init: Init = {
    stdin: {
      read_line(): string {
        reads += 1;
        return "host stdin";
      },
    },
    stdout: {
      write_line(value): undefined {
        if (typeof value !== "string") {
          throw new Error("Expected Text");
        }

        stdout.push(value);
        return undefined;
      },
    },
  };

  const runner = DuckRunner(init);
  const result = await main(runner);

  assert_equals(result, {
    exports: { result: "host stdin" },
  });
  assert_equals(reads, 1);
  assert_equals(stdout, ["host stdin"]);
});

Deno.test("CLI mock runner captures stdout", async () => {
  const runner = mock_runner();
  const result = await main(runner);

  assert_equals(result, {
    exports: { result: dry_run_stdin },
  });
  assert_equals(runner.stdout, [dry_run_stdin]);
});

Deno.test("CLI runner bridges Deno stdin and stdout", async () => {
  const runner = new URL("./03_cli_stdin_stdout.ts", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run=wat2wasm",
      runner.pathname,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(encoder.encode("Zażółć 🦀\n"));
  await writer.close();
  const output = await command.output();

  assert_equals(output.success, true);
  assert_equals(decoder.decode(output.stdout), "Zażółć 🦀\n");
  assert_equals(decoder.decode(output.stderr), "");
});

Deno.test("CLI --dry-run selects the mock runner", async () => {
  const runner = new URL("./03_cli_stdin_stdout.ts", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run=wat2wasm",
      runner.pathname,
      "--dry-run",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();

  assert_equals(output.success, true);
  assert_equals(decoder.decode(output.stdout), "");
  assert_equals(
    decoder.decode(output.stderr),
    "[dry-run stdout] " + dry_run_stdin + "\n",
  );
});

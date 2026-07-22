import {
  type DuckEffectObject,
  DuckHost,
  type DuckHostHandler,
  DuckRunner,
  type DuckValue,
  Source,
} from "../../src/frontend.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const source_url = new URL("./03_cli_stdin_stdout.duck", import.meta.url);

export const dry_run_stdin = "dry-run stdin";

export type Init = {
  [name: string]: DuckEffectObject;
  stdin: { read_line: DuckHostHandler };
  stdout: { write_line: DuckHostHandler };
};

export type MainResult = {
  exports: { result: string };
};

export type EffectRunner = DuckRunner;

export type MockEffectRunner = DuckRunner & {
  stdout: string[];
};

export async function main(runner: EffectRunner): Promise<MainResult> {
  const artifact = Source.artifact_file(source_url.href);
  const wasm = await wasm_from_wat(artifact.wat);
  const program = await DuckHost.instantiate(wasm, artifact.abi);

  try {
    const value = runner.run(program);
    return {
      exports: decode_exports(value),
    };
  } finally {
    program.dispose();
  }
}

export function live_runner(): EffectRunner {
  const init: Init = {
    stdin: {
      read_line(): string {
        return read_host_line();
      },
    },
    stdout: {
      write_line(value: DuckValue): undefined {
        const line = expect_text(value, "Stdout.write_line");
        write_all(Deno.stdout, encoder.encode(line + "\n"));
        return undefined;
      },
    },
  };

  return DuckRunner(init);
}

export function mock_runner(): MockEffectRunner {
  const stdout: string[] = [];
  const init: Init = {
    stdin: {
      read_line(): string {
        return dry_run_stdin;
      },
    },
    stdout: {
      write_line(value: DuckValue): undefined {
        stdout.push(expect_text(value, "mock Stdout.write_line"));
        return undefined;
      },
    },
  };

  const runner = DuckRunner(init);
  return {
    run: runner.run,
    stdout,
  };
}

function decode_exports(value: DuckValue): { result: string } {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("CLI module must return a one-slot product");
  }

  const result = value[0];
  return { result: expect_text(result, "CLI result") };
}

function expect_text(value: DuckValue | undefined, name: string): string {
  if (typeof value !== "string") {
    throw new Error(name + " must be Text");
  }

  return value;
}

function read_host_line(): string {
  const bytes: number[] = [];
  const buffer = new Uint8Array(1);

  while (true) {
    const count = Deno.stdin.readSync(buffer);

    if (count === null) {
      break;
    }

    if (count === 0) {
      continue;
    }

    const byte = buffer[0];

    if (byte === undefined) {
      throw new Error("Deno stdin reported a byte without writing it");
    }

    if (byte === 10) {
      const last = bytes[bytes.length - 1];

      if (last === 13) {
        bytes.pop();
      }

      break;
    }

    bytes.push(byte);
  }

  return decoder.decode(Uint8Array.from(bytes));
}

function write_all(
  writer: { writeSync: (data: Uint8Array) => number },
  bytes: Uint8Array,
): void {
  let offset = 0;

  while (offset < bytes.length) {
    const count = writer.writeSync(bytes.subarray(offset));

    if (count === 0) {
      throw new Error("Host output stopped before the line was written");
    }

    offset += count;
  }
}

async function wasm_from_wat(wat: string): Promise<Uint8Array> {
  const command = new Deno.Command("wat2wasm", {
    args: ["-o", "-", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = command.stdin.getWriter();
  await writer.write(encoder.encode(wat));
  await writer.close();
  const output = await command.output();

  if (!output.success) {
    throw new Error(
      "wat2wasm failed:\n" + decoder.decode(output.stderr) + "\n" + wat,
    );
  }

  return output.stdout;
}

if (import.meta.main) {
  let dry_run = false;

  for (const arg of Deno.args) {
    if (arg === "--dry-run") {
      dry_run = true;
      continue;
    }

    throw new Error(
      "Usage: deno run --allow-read --allow-run=wat2wasm " +
        "examples/effects/03_cli_stdin_stdout.ts [--dry-run]",
    );
  }

  if (dry_run) {
    const runner = mock_runner();
    await main(runner);

    for (const line of runner.stdout) {
      write_all(
        Deno.stderr,
        encoder.encode("[dry-run stdout] " + line + "\n"),
      );
    }
  } else {
    await main(live_runner());
  }
}

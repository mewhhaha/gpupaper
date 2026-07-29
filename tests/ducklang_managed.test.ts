import {
  compileModuleSource,
  type DucklangCompilationArtifact,
} from "../src/compiler.ts";
import { runDucklangManaged } from "../src/ducklang_runtime.ts";

const effectsDirectory = new URL(
  "../examples/binned/effects/",
  import.meta.url,
);

Deno.test("inferred and annotated Ducklang effect rows execute through the managed ABI", async () => {
  for (
    const filename of ["01_inferred_io.duck", "02_annotated_effect_row.duck"]
  ) {
    const artifact = await compileManagedFixture(filename);
    const printed: string[] = [];
    const result = await runDucklangManaged(artifact, {
      io: {
        read: () => "host text",
        print: (value) => {
          if (typeof value !== "string") {
            throw new TypeError(
              `Io.print expected Text; received ${typeof value}`,
            );
          }
          printed.push(value);
          return undefined;
        },
      },
    });
    assertEquals(result, { result: "host text" });
    assertEquals(printed, ["host text"]);
  }
});

Deno.test("the Ducklang CLI fixture exposes and satisfies its effect contract", async () => {
  const artifact = await compileManagedFixture("03_cli_stdin_stdout.duck");
  assertEquals(artifact.abi.init, [
    { fieldName: "stdin", effectName: "Stdin" },
    { fieldName: "stdout", effectName: "Stdout" },
  ]);
  assertEquals(artifact.abi.requirements.module, [
    { effectName: "Stdin", operationName: "read_line" },
    { effectName: "Stdout", operationName: "write_line" },
  ]);
  assertEquals(artifact.abi.requirements.functions.echo, [
    { effectName: "Stdin", operationName: "read_line" },
    { effectName: "Stdout", operationName: "write_line" },
  ]);

  const stdout: string[] = [];
  const result = await runDucklangManaged(artifact, {
    stdin: { read_line: () => "Zażółć 🦀" },
    stdout: {
      write_line: (value) => {
        if (typeof value !== "string") {
          throw new TypeError(
            `Stdout.write_line expected Text; received ${typeof value}`,
          );
        }
        stdout.push(value);
        return undefined;
      },
    },
  });
  assertEquals(result, { result: "Zażółć 🦀" });
  assertEquals(stdout, ["Zażółć 🦀"]);
});

Deno.test("a host interface supplies a narrowed multi-file Ducklang effect module", async () => {
  const hostInterface = new URL("multi_file/host.duck", effectsDirectory);
  const artifact = await compileManagedFixture("multi_file/main.duck", {
    hostInterface: hostInterface.pathname,
  });
  const printed: string[] = [];
  const result = await runDucklangManaged(artifact, {
    io: {
      print: (value) => {
        if (typeof value !== "string") {
          throw new TypeError(
            `Io.print expected Text; received ${typeof value}`,
          );
        }
        printed.push(value);
        return undefined;
      },
    },
  });
  assertEquals(result, {});
  assertEquals(printed, ["hello from Duck"]);
  assertEquals(artifact.abi.textLiterals, ["hello from Duck"]);
  assertEquals(artifact.abi.requirements.module, [
    { effectName: "Io", operationName: "print" },
  ]);
});

Deno.test("a Ducklang host interface accepts supporting type declarations", async () => {
  const hostInterface = new URL(
    "fixtures/declaration_host_interface.duck",
    import.meta.url,
  );
  const artifact = await compileModuleSource(
    "declaration_host_consumer.duck",
    `module (!init: Init) where
result <- Input.read()
return { .result = result }
`,
    {
      gpuMode: "off",
      hostInterface: hostInterface.pathname,
    },
  );

  assertEquals(
    await runDucklangManaged(artifact, {
      input: { read: () => 42 },
    }),
    { result: 42 },
  );
});

Deno.test("the managed Ducklang runtime rejects a missing effect method", async () => {
  const artifact = await compileManagedFixture("03_cli_stdin_stdout.duck");
  await assertRejects(
    () =>
      runDucklangManaged(artifact, {
        stdin: { read_line: () => "unused" },
        stdout: {},
      }),
    /Init field stdout does not provide Stdout\.write_line/,
  );
});

Deno.test("Ducklang rejects ambiguous Init capabilities for one effect", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "ambiguous_init.duck",
        `module (!init: Init) where
declare effect Input { read: () => I32 }
declare Init { primary: Input secondary: Input }
result <- Input.read()
return { .result = result }
`,
        { gpuMode: "off" },
      ),
    /Init fields primary and secondary both grant effect Input/,
  );
});

Deno.test("the managed Ducklang runtime rejects host integers outside i32", async () => {
  const artifact = await compileModuleSource(
    "wide_host_integer.duck",
    `module (!init: Init) where
declare effect Input { read: () => I32 }
declare Init { input: Input }
result <- Input.read()
return { .result = result }
`,
    { gpuMode: "off" },
  );
  await assertRejects(
    () =>
      runDucklangManaged(artifact, {
        input: { read: () => 2_147_483_648 },
      }),
    /Input\.read returned I32 value outside its signed range: 2147483648/,
  );
});

Deno.test("Ducklang host interfaces reject executable source", async () => {
  const executableInterface = new URL(
    "fixtures/executable_host_interface.duck",
    import.meta.url,
  );
  await assertRejects(
    () =>
      compileModuleSource(
        "host_interface_consumer.duck",
        "42\n",
        {
          gpuMode: "off",
          hostInterface: executableInterface.pathname,
        },
      ),
    /host interface must contain declarations only; found binding/,
  );
});

Deno.test("the managed runtime identifies a throwing Ducklang host operation", async () => {
  const artifact = await compileManagedFixture("03_cli_stdin_stdout.duck");
  await assertRejects(
    () =>
      runDucklangManaged(artifact, {
        stdin: { read_line: () => "host text" },
        stdout: {
          write_line: () => {
            throw new Error("closed output");
          },
        },
      }),
    /Ducklang host operation Stdout\.write_line threw/,
  );
});

Deno.test("the managed ABI round-trips products, sums, and bytes", async () => {
  const artifact = await compileModuleSource(
    "aggregate_abi.duck",
    `module (!init: Init) where
type Mode = | \`Run I32 | \`Stop Unit
type Packet = struct {
  .contents = Bytes,
  .mode = Mode,
}
declare effect Exchange {
  roundtrip: (Packet) => Packet
}
declare Init { exchange: Exchange }
let contents = Bytes.generate(3, index => 40 + index)
let packet = Packet.new { .contents = contents, .mode = \`Run 2 }
response <- Exchange.roundtrip(packet)
return { .result = response.contents }
`,
    { gpuMode: "off" },
  );
  let receivedPacket: unknown;
  const result = await runDucklangManaged(artifact, {
    exchange: {
      roundtrip: (packet) => {
        receivedPacket = packet;
        return packet;
      },
    },
  });

  const packet = receivedPacket as {
    readonly contents: Uint8Array;
    readonly mode: { readonly case: string; readonly value: number };
  };
  assertEquals([...packet.contents], [40, 41, 42]);
  assertEquals(packet.mode, { case: "Run", value: 2 });
  assertEquals([...(result.result as Uint8Array)], [40, 41, 42]);
});

Deno.test("managed Text equality compares contents from distinct allocations", async () => {
  const artifact = await compileModuleSource(
    "managed_text_equality.duck",
    `module (!init: Init) where
declare effect Input { read: () => Text }
declare Init { input: Input }
value <- Input.read()
let result = if value == "same contents" { 42 } else { 0 }
return { .result = result }
`,
    { gpuMode: "off" },
  );

  assertEquals(
    await runDucklangManaged(artifact, {
      input: { read: () => "same contents" },
    }),
    { result: 42 },
  );
});

Deno.test("the frozen Editor executes a finite terminal session", async () => {
  const editorUrl = new URL(
    "../examples/binned/live/case-studies/editor/editor.duck",
    import.meta.url,
  );
  const hostUrl = new URL(
    "../examples/binned/live/case-studies/editor/host.duck",
    import.meta.url,
  );
  const artifact = await compileModuleSource(
    editorUrl.pathname as `${string}.duck`,
    await Deno.readTextFile(editorUrl),
    { gpuMode: "off", hostInterface: hostUrl.pathname },
  );
  const frames: Uint8Array[] = [];
  const result = await runDucklangManaged(artifact, {
    terminal: {
      load: () => new Uint8Array(),
      columns: () => 80,
      rows: () => 24,
      write: (frame) => {
        if (!(frame instanceof Uint8Array)) {
          throw new TypeError(
            `Terminal.write expected Bytes; received ${typeof frame}`,
          );
        }
        frames.push(frame);
        return undefined;
      },
      read: () => ({ case: "End", value: undefined }),
      save: () => ({ case: "Ok", value: undefined }),
    },
  });

  assertEquals(result, { code: 0 });
  assertEquals(frames.length, 1);
  assertEquals(frames[0]?.length, 126);
  assertEquals(
    artifact.abi.requirements.module.some((requirement) =>
      requirement.effectName === "Terminal" &&
      requirement.operationName === "save"
    ),
    true,
  );
});

Deno.test("the frozen Codex executes a completed model turn", async () => {
  const codexUrl = new URL(
    "../examples/binned/live/case-studies/codex/codex.duck",
    import.meta.url,
  );
  const hostUrl = new URL(
    "../examples/binned/live/case-studies/codex/host.duck",
    import.meta.url,
  );
  const artifact = await compileModuleSource(
    codexUrl.pathname as `${string}.duck`,
    await Deno.readTextFile(codexUrl),
    { gpuMode: "off", hostInterface: hostUrl.pathname },
  );
  const events: string[] = [];
  const result = await runDucklangManaged(artifact, {
    input: { prompt: () => "hello" },
    model: {
      start: () => ({ case: "Started", value: undefined }),
      next: () => '{"type":"response.completed"}',
      submit: () => ({ case: "Started", value: undefined }),
    },
    tool: { run: () => "" },
    approval: {
      request: () => ({ case: "Denied", value: "not requested" }),
    },
    events: {
      message: () => undefined,
      tool_started: () => undefined,
      tool_finished: () => undefined,
      tool_denied: () => undefined,
      failed: (message) => {
        events.push(`failed:${String(message)}`);
        return undefined;
      },
      completed: () => {
        events.push("completed");
        return undefined;
      },
    },
  });

  assertEquals(result, { tool_count: 0 });
  assertEquals(events, ["completed"]);
});

Deno.test("the frozen grep scans a streamed file and returns success", async () => {
  const grepUrl = new URL(
    "../examples/binned/live/case-studies/grep/grep.duck",
    import.meta.url,
  );
  const hostUrl = new URL(
    "../examples/binned/live/case-studies/grep/host.duck",
    import.meta.url,
  );
  const artifact = await compileModuleSource(
    grepUrl.pathname as `${string}.duck`,
    await Deno.readTextFile(grepUrl),
    { gpuMode: "off", hostInterface: hostUrl.pathname },
  );
  let readCount = 0;
  const output: Uint8Array[] = [];
  const result = await runDucklangManaged(artifact, {
    process: {
      arg_count: () => 2,
      arg: (index) => index === 0 ? "needle" : "file.txt",
    },
    file_reader: {
      open: () => ({ case: "Ok", value: undefined }),
      read: () =>
        readCount++ === 0
          ? {
            case: "Chunk",
            value: new TextEncoder().encode("needle\n"),
          }
          : { case: "Eof", value: undefined },
      close: () => undefined,
    },
    stdout: {
      write: (bytes) => {
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError(
            `Stdout.write expected Bytes; received ${typeof bytes}`,
          );
        }
        output.push(bytes);
        return { case: "Ok", value: undefined };
      },
    },
  });

  assertEquals(result, { code: 0 });
  assertEquals(
    output.map((bytes) => new TextDecoder().decode(bytes)),
    ["needle\n"],
  );
});

Deno.test("the frozen tar accepts an empty archive", async () => {
  const tarUrl = new URL(
    "../examples/binned/live/case-studies/tar/tar.duck",
    import.meta.url,
  );
  const hostUrl = new URL(
    "../examples/binned/live/case-studies/tar/host.duck",
    import.meta.url,
  );
  const artifact = await compileModuleSource(
    tarUrl.pathname as `${string}.duck`,
    await Deno.readTextFile(tarUrl),
    { gpuMode: "off", hostInterface: hostUrl.pathname },
  );
  const result = await runDucklangManaged(artifact, {
    archive: {
      read: () => ({
        case: "Bytes",
        value: new Uint8Array(1024),
      }),
    },
  });

  assertEquals(result, {
    result: {
      case: "Ok",
      value: {
        entry_count: 0,
        file_count: 0,
        directory_count: 0,
        other_count: 0,
        total_size: 0,
        names: new Uint8Array(),
      },
    },
  });
});

Deno.test("the frozen wav emits a complete RIFF buffer", async () => {
  const wavUrl = new URL(
    "../examples/binned/live/case-studies/wav/wav.duck",
    import.meta.url,
  );
  const artifact = await compileModuleSource(
    wavUrl.pathname as `${string}.duck`,
    await Deno.readTextFile(wavUrl),
    { gpuMode: "off" },
  );
  const result = await runDucklangManaged(artifact, {});
  const wav = result.wav;
  if (!(wav instanceof Uint8Array)) {
    throw new TypeError(`wav export expected Bytes; received ${typeof wav}`);
  }

  assertEquals(wav.length, 16_044);
  assertEquals([...wav.slice(0, 16)], [
    82,
    73,
    70,
    70,
    164,
    62,
    0,
    0,
    87,
    65,
    86,
    69,
    102,
    109,
    116,
    32,
  ]);
});

Deno.test("the frozen raytracer emits the expected PPM header and first pixel", async () => {
  const raytracerUrl = new URL(
    "../examples/binned/live/case-studies/raytracer/raytracer.duck",
    import.meta.url,
  );
  const artifact = await compileModuleSource(
    raytracerUrl.pathname as `${string}.duck`,
    await Deno.readTextFile(raytracerUrl),
    { gpuMode: "off" },
  );
  const result = await runDucklangManaged(artifact, {});
  const ppm = result.ppm;
  if (!(ppm instanceof Uint8Array)) {
    throw new TypeError(`ppm export expected Bytes; received ${typeof ppm}`);
  }

  assertEquals(ppm.length, 1_933);
  assertEquals([...ppm.slice(0, 16)], [
    80,
    54,
    10,
    51,
    50,
    32,
    50,
    48,
    10,
    50,
    53,
    53,
    10,
    88,
    144,
    233,
  ]);
});

async function compileManagedFixture(
  filename: string,
  options: { readonly hostInterface?: string } = {},
): Promise<DucklangCompilationArtifact> {
  const sourceUrl = new URL(filename, effectsDirectory);
  return await compileModuleSource(
    sourceUrl.pathname as `${string}.duck`,
    await Deno.readTextFile(sourceUrl),
    { gpuMode: "off", ...options },
  );
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (expected.test(message)) return;
    throw new Error(
      `expected ${expected}, received ${JSON.stringify(message)}`,
    );
  }
  throw new Error(`expected rejection matching ${expected}`);
}

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

import { analyzeDucklangEffects } from "../src/ducklang_effects.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import {
  formatDucklangType,
  inferDucklangModule,
} from "../src/ducklang_types.ts";

Deno.test("Ducklang row polymorphism forwards a callback effect", async () => {
  const module = await resolve(
    `effect Input {
  read: () => I32
}

let apply: [I32 -> <e> I32, I32] -> <e> I32 =
  (callback, value) => callback(value)

let read: I32 -> <Input.read> I32 = ignored => {
  value <- Input.read()
  value
}

apply(read, 0)
`,
  );
  const analysis = analyzeDucklangEffects(module);
  const apply = module.bindings.find((binding) =>
    binding.symbol.text === "apply"
  );
  if (apply === undefined) throw new Error("missing apply binding");

  assertEquals(analysis.bindingEffects.get(apply.symbol.id), {
    operations: [],
    parameterEffects: [0],
  });
  assertEquals(
    analysis.moduleEffects.map((effect) =>
      `${effect.effectName}.${effect.operationName}`
    ),
    ["Input.read"],
  );
  const typed = inferDucklangModule(module);
  const typedApply = typed.bindings.find((binding) =>
    binding.symbol.text === "apply"
  );
  assertEquals(
    typedApply === undefined ? undefined : formatDucklangType(typedApply.type),
    "(i32 -> i32 ! <ρ0>) -> i32 -> i32 ! <ρ0>",
  );
  assertEquals(
    typed.result.kind === "call" ? typed.result.effects?.operations : undefined,
    ["Input.read"],
  );
  assertEquals(
    typed.result.kind === "call"
      ? typed.result.effects?.parameterEffects
      : undefined,
    [],
  );
});

Deno.test("Ducklang infers and instantiates an anonymous callback row", async () => {
  const typed = inferDucklangModule(
    await resolve(
      `effect Input {
  read: () => I32
}

let apply = (callback, value) => callback(value)

let read: I32 -> <Input.read> I32 = ignored => {
  value <- Input.read()
  value
}

apply(read, 0)
`,
    ),
  );
  const apply = typed.bindings.find((binding) =>
    binding.symbol.text === "apply"
  );

  assertEquals(
    apply === undefined ? undefined : formatDucklangType(apply.type),
    "(i32 -> i32 ! <ρ0>) -> i32 -> i32 ! <ρ0>",
  );
  assertEquals(
    typed.result.kind === "call" ? typed.result.effects?.operations : undefined,
    ["Input.read"],
  );
});

Deno.test("Ducklang retains a closed latent row in the callable type", async () => {
  const typed = inferDucklangModule(
    await resolve(
      `effect Input {
  read: () => I32
}

let read_after: I32 -> <Input.read> I32 = value => {
  read <- Input.read()
  value + read
}

read_after(1)
`,
    ),
  );
  const readAfter = typed.bindings.find((binding) =>
    binding.symbol.text === "read_after"
  );

  assertEquals(
    readAfter === undefined ? undefined : formatDucklangType(readAfter.type),
    "i32 -> i32 ! <Input.read>",
  );
  assertEquals(
    typed.result.kind === "call" ? typed.result.effects?.operations : undefined,
    ["Input.read"],
  );
});

Deno.test("Ducklang instantiates one open callback row independently at each call", async () => {
  const typed = inferDucklangModule(
    await resolve(
      `effect Input {
  read: () => I32
}

let apply: [I32 -> <e> I32, I32] -> <e> I32 =
  (callback, value) => callback(value)

let read: I32 -> <Input.read> I32 = ignored => {
  value <- Input.read()
  value
}

effectful <- apply(read, 0)
pure <- apply(value => value + 1, 41)
effectful + pure
`,
    ),
  );
  const calls = typed.bindings.flatMap((binding) =>
    binding.value.kind === "call" ? [binding.value] : []
  );

  assertEquals(calls[0]?.effects?.operations, ["Input.read"]);
  assertEquals(calls[1]?.effects?.operations, []);
});

Deno.test("Ducklang rejects a pure wrapper around an effectful callback", async () => {
  await assertRejects(
    `let apply: [I32 -> <e> I32, I32] -> I32 =
  (callback, value) => callback(value)

apply(value => value, 42)
`,
    /function apply exceeds its declared effect row with effects from parameter callback/,
  );
});

Deno.test("Ducklang rejects a row variable without a callback binder", async () => {
  await assertRejects(
    `let identity: I32 -> <e> I32 = value => value
identity(42)
`,
    /unbound Ducklang effect row variable e/,
  );
});

async function resolve(source: string) {
  return resolveDucklangModule(
    await parseDucklangModule("effects.duck", source),
  );
}

async function assertRejects(
  source: string,
  expected: RegExp,
): Promise<void> {
  let message = "";
  try {
    analyzeDucklangEffects(await resolve(source));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === "") throw new Error("expected a rejection");
  if (!expected.test(message)) {
    throw new Error(
      `expected ${expected}, received ${JSON.stringify(message)}`,
    );
  }
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

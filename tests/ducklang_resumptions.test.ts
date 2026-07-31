import { compileModuleSource, runMain } from "../src/compiler.ts";

const program = (clauseBody: string) =>
  `effect Counter {
  get: () => I32
}

let run: () -> <Counter> I32 = () => {
  value <- Counter.get()
  value + 2
}

let counter = {
  let count = 40
  Counter {
    get: (!resume) => ${clauseBody},
    return: value => value,
  }
}

try run() with counter
`;

Deno.test("Ducklang allows a handler clause to resume once", async () => {
  const artifact = await compile(program("!resume(count)"));
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    artifact.core.functions.some((function_) =>
      function_.blocks.some((block) =>
        block.operations.some((operation) =>
          operation.kind === "host.call" &&
          operation.effectName === "Counter"
        )
      )
    ),
    false,
  );
  assertEquals(artifact.profile.work.directStatePassingRegionCount, 1);
  assertEquals(artifact.profile.work.directStatePassingFunctionCount, 1);
  assertEquals(artifact.profile.work.cpsTransformedRegionCount, 0);
  assertEquals(artifact.profile.work.cpsTransformedFunctionCount, 0);
  assertEquals(artifact.profile.work.handledPerformanceCount, 1);
  assertEquals(artifact.profile.work.continuationCaptureCount, 0);
  assertEquals(artifact.profile.work.capabilityOperandCount, 2);
  assertEquals(artifact.profile.work.rootCapabilityCount, 0);
  assertEquals(artifact.effectHir.effectHirVersion, 1);
  assertEquals(artifact.effectHir.result.kind, "handle");
  const handler = artifact.effectHir.bindings.find((binding) =>
    binding.symbol.text === "counter"
  );
  const handlerValue = handler?.value.kind === "block"
    ? handler.value.result
    : handler?.value;
  if (
    handlerValue?.kind !== "effectHandler" ||
    handlerValue.fields[0]?.value.kind !== "function"
  ) {
    throw new Error("expected typed Counter.get handler clause");
  }
  if (!handlerValue.capabilityId.endsWith(":Counter")) {
    throw new Error(
      `expected Counter capability identity, received ${handlerValue.capabilityId}`,
    );
  }
  assertEquals(handlerValue.fields[0].value.body.kind, "resume");
  assertEquals(handlerValue.clauseEffects.operations, []);
  if (artifact.effectHir.result.kind !== "handle") {
    throw new Error("expected typed Counter handle");
  }
  assertEquals(artifact.effectHir.result.forwardedEffects.operations, []);
  assertEquals(artifact.effectHir.result.clauseEffects.operations, []);
  assertEquals(artifact.effectHir.result.controlFlow, [{
    operationName: "get",
    multiplicity: "affine",
    capturedLinearSymbols: [],
  }]);
});

Deno.test("Ducklang allows a handler clause to answer without resuming", async () => {
  const artifact = await compile(program("count"));
  assertEquals(await runMain(artifact.wasm), 40);
  assertEquals(artifact.profile.work.directStatePassingRegionCount, 0);
  assertEquals(artifact.profile.work.cpsTransformedRegionCount, 1);
  assertEquals(artifact.profile.work.cpsTransformedFunctionCount, 1);
});

Deno.test("Ducklang handler types retain impure clause effects", async () => {
  const source = `effect Counter {
  get: () => I32
}

effect Audit {
  write: (I32) => Unit
}

let run: () -> <Counter> I32 = () => {
  value <- Counter.get()
  value
}

let counter = Counter {
  get: (!resume) => {
    _ <- Audit.write(40)
    !resume(40)
  },
  return: value => value,
}

try run() with counter
`;
  const artifact = await compile(source);
  if (artifact.effectHir.result.kind !== "handle") {
    throw new Error("expected typed Counter handle");
  }
  assertEquals(
    artifact.effectHir.result.clauseEffects.operations,
    ["Audit.write"],
  );
  assertEquals(artifact.effectHir.result.effects.operations, ["Audit.write"]);
});

Deno.test("Ducklang abort preserves effects completed before the performance", async () => {
  const source = `effect Counter {
  add: (I32) => Unit
  get: () => I32
}

let run: () -> <Counter> I32 = () => {
  _ <- Counter.add(2)
  value <- Counter.get()
  value + 100
}

let counter = {
  let count = 0
  Counter {
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    get: (!resume) => count,
    return: value => value,
  }
}

try run() with counter
`;
  assertEquals(await run(source), 2);
});

Deno.test("Ducklang selects handler instances by lexical identity", async () => {
  const source = (selected: string) =>
    `effect Counter {
  get: () => I32
}

let run: () -> <Counter> I32 = () => {
  value <- Counter.get()
  value + 2
}

let first = Counter {
  get: (!resume) => !resume(40),
  return: value => value,
}

let second = Counter {
  get: (!resume) => !resume(20),
  return: value => value,
}

try run() with ${selected}
`;
  assertEquals(await run(source("first")), 42);
  assertEquals(await run(source("second")), 22);
});

Deno.test("Ducklang composes defaults by declared order", async () => {
  const source = `effect Base {
  read: () => I32
}

effect Bonus {
  read: () => I32
}

const bonus = () => Bonus {
  read: (!resume) => !resume(10),
  return: value => value + 2,
}

extend Bonus {
  .order = _ => 20
}

const base = () => Base {
  read: (!resume) => !resume(10),
  return: value => value * 2,
}

extend Base {
  .order = _ => 10
}

let calculate: () -> <Base :| Bonus> I32 = () => {
  baseValue <- Base.read()
  bonusValue <- Bonus.read()
  baseValue + bonusValue
}

try calculate()
`;
  assertEquals(await run(source), 42);
});

Deno.test("Ducklang directly composes answer-type-changing handlers", async () => {
  const source = `effect First {
  read: () => I32
}

effect Second {
  read: () => I32
}

let run: () -> <First :| Second> I32 = () => {
  first <- First.read()
  second <- Second.read()
  first + second
}

let first = First {
  read: (!resume) => !resume(1),
  return: value => value > 0,
}

let second = Second {
  read: (!resume) => !resume(2),
  return: value => if value { 1 } else { 0 },
}

try {
  try run() with first
} with second
`;
  assertEquals(await run(source), 1);
});

Deno.test("Ducklang rejects a handler clause that resumes twice", async () => {
  await assertRejects(
    program("!resume(count) + !resume(count)"),
    /handler clause get resumes 2 times; a resumption may be used at most once/,
  );
});

Deno.test("Ducklang rejects one resumption executed by a repeating loop", async () => {
  await assertRejects(
    program(`{
      for index in 0..2 {
        !resume(count)
      }
      count
    }`),
    /handler clause get may resume more than once/,
  );
});

Deno.test("Ducklang accepts one resumption on either exclusive branch", async () => {
  const artifact = await compile(
    program("if count == 40 { !resume(count) } else { !resume(0) }"),
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.profile.work.directStatePassingRegionCount, 0);
  assertEquals(artifact.profile.work.cpsTransformedRegionCount, 1);
});

Deno.test("Ducklang gives every handler clause one answer type", async () => {
  await assertRejects(
    program("count").replace(
      "return: value => value",
      "return: value => true",
    ),
    /cannot unify Ducklang (?:i32 with bool|bool with i32)/,
  );
});

Deno.test("Ducklang requires one clause for every handled operation", async () => {
  const source = program("!resume(count)")
    .replace(
      "  get: () => I32",
      "  get: () => I32\n  reset: () => Unit",
    )
    .replace(
      "    get: (!resume) => !resume(count),",
      "    reset: (!resume) => !resume(()),",
    );
  await assertRejects(
    source,
    /handler Counter requires clauses get, reset, return; missing get; unexpected none/,
  );
});

Deno.test("Ducklang requires resumption when the continuation owns a linear value", async () => {
  const source = (clause: string) =>
    `effect Gate {
  pass: () => Unit
}

let consume = (!value) => !value

let run: () -> <Gate> I32 = () => {
  let !token = 41
  _ <- Gate.pass()
  consume(!token) + 1
}

let gate = Gate {
  pass: (!resume) => ${clause},
  return: value => value,
}

try run() with gate
`;
  await assertRejects(
    source("0"),
    /handler clause pass must resume because its continuation captures linear token/,
  );
  const artifact = await compile(source("!resume(())"));
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.profile.work.directStatePassingRegionCount, 1);
  assertEquals(artifact.profile.work.continuationCaptureCount, 0);
  if (artifact.effectHir.result.kind !== "handle") {
    throw new Error("expected typed Gate handle");
  }
  assertEquals(artifact.effectHir.result.controlFlow, [{
    operationName: "pass",
    multiplicity: "linear",
    capturedLinearSymbols: ["token"],
  }]);
});

Deno.test("Ducklang enforces linearity on ordinary parameters too", async () => {
  // The neighbouring discipline the resumption rule restores, kept alongside it so
  // a regression in either is visible here.
  await assertRejects(
    "let twice = (!value) => value + value\nlet !token = 20\ntwice(!token)\n",
    /linear Ducklang value value was already consumed/,
  );
  await assertRejects(
    "let ignore = (!value) => 42\nlet !token = 1\nignore(!token)\n",
    /linear Ducklang value value was not consumed/,
  );
  assertEquals(
    await run(
      "let once = (!value) => value + 1\nlet !token = 41\nonce(!token)\n",
    ),
    42,
  );
});

async function run(source: string): Promise<number | bigint> {
  const artifact = await compile(source);
  return await runMain(artifact.wasm);
}

function compile(source: string) {
  return compileModuleSource("resume.duck", source, { gpuMode: "off" });
}

async function assertRejects(
  source: string,
  expected: RegExp,
): Promise<void> {
  let message = "";
  try {
    await compileModuleSource("resume.duck", source, { gpuMode: "off" });
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

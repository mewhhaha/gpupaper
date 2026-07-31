import {
  bindEffect,
  effectCapability,
  type EffectComputation,
  effectOperation,
  effectRow,
  emptyEffectRow,
  handleEffect,
  performEffect,
  returnEffect,
  runClosedEffect,
} from "../src/ducklang_effect_ir.ts";

const counter = effectCapability(0, "Counter");
const otherCounter = effectCapability(1, "Counter");
const get = effectOperation(counter, "get");

Deno.test("an affine handler may answer without running the continuation", () => {
  const computation = bindEffect(
    performEffect<number>(get),
    (value) => returnEffect(value + 2),
    emptyEffectRow(),
  );
  const handled = handleEffect<number, number>(computation, {
    capability: counter,
    effects: emptyEffectRow(),
    onReturn: (value) => returnEffect(value),
    operations: new Map([[
      "get",
      {
        linearity: "affine",
        evaluate: () => returnEffect(40),
      },
    ]]),
  });

  assertEquals(runClosedEffect(handled), 40);
});

Deno.test("resuming supplies a value to the captured continuation", () => {
  const computation = bindEffect(
    performEffect<number>(get),
    (value) => returnEffect(value + 2),
    emptyEffectRow(),
  );
  const handled = handleEffect<number, number>(computation, {
    capability: counter,
    effects: emptyEffectRow(),
    onReturn: (value) => returnEffect(value),
    operations: new Map([[
      "get",
      {
        linearity: "linear",
        evaluate: (_arguments, resume) => resume(40),
      },
    ]]),
  });

  assertEquals(runClosedEffect(handled), 42);
});

Deno.test("a one-shot handler rejects a second resumption", () => {
  const computation = performEffect<number>(get);
  assertThrows(
    () =>
      handleEffect<number, number>(computation, {
        capability: counter,
        effects: emptyEffectRow(),
        onReturn: (value) => returnEffect(value),
        operations: new Map([[
          "get",
          {
            linearity: "affine",
            evaluate: (_arguments, resume) => {
              resume(1);
              return resume(2);
            },
          },
        ]]),
      }),
    /resumed more than once/,
  );
});

Deno.test("lexical capability identity prevents accidental handling", () => {
  const otherGet = effectOperation(otherCounter, "get");
  const computation = performEffect<number>(otherGet);
  const handled = handleEffect<number, number>(computation, {
    capability: counter,
    effects: emptyEffectRow(),
    onReturn: (value) => returnEffect(value),
    operations: new Map([[
      "get",
      {
        linearity: "affine",
        evaluate: () => returnEffect(40),
      },
    ]]),
  });

  assertThrows(
    () => runClosedEffect(handled),
    /unhandled Counter\.get/,
  );
});

Deno.test("discarding a continuation requires discardable captures", () => {
  const computation = performEffect<number>(get, [], [{
    name: "session",
    discardable: false,
  }]);
  assertThrows(
    () =>
      handleEffect<number, number>(computation, {
        capability: counter,
        effects: emptyEffectRow(),
        onReturn: (value) => returnEffect(value),
        operations: new Map([[
          "get",
          {
            linearity: "affine",
            evaluate: () => returnEffect(40),
          },
        ]]),
      }),
    /discards continuation owning session/,
  );
});

Deno.test("effect rows are canonical and handlers remove only their capability", () => {
  const otherGet = effectOperation(otherCounter, "get");
  const computation: EffectComputation<number> = {
    ...performEffect<number>(get),
    effects: effectRow([otherGet, get, otherGet]),
  };
  const handled = handleEffect<number, number>(computation, {
    capability: counter,
    effects: emptyEffectRow(),
    onReturn: (value) => returnEffect(value),
    operations: new Map([[
      "get",
      {
        linearity: "affine",
        evaluate: () => returnEffect(40),
      },
    ]]),
  });

  assertEquals(
    handled.effects.operations.map((operation) => operation.capability.id),
    [otherCounter.id],
  );
});

function assertThrows(operation: () => unknown, expected: RegExp): void {
  let message = "";
  try {
    operation();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
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

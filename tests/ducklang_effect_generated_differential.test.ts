import { compileModuleSource, runMain } from "../src/compiler.ts";
import {
  bindEffect,
  effectCapability,
  type EffectComputation,
  type EffectHandler,
  effectOperation,
  emptyEffectRow,
  handleEffect,
  performEffect,
  returnEffect,
  runClosedEffect,
} from "../src/ducklang_effect_ir.ts";

type GeneratedHandlerCase = {
  readonly performedValue: number;
  readonly continuationIncrement: number;
  readonly returnIncrement: number;
  readonly resumes: boolean;
};

Deno.test("generated handlers agree with the reference calculus", async () => {
  for (const generated of generatedHandlerCases()) {
    const expected = evaluateReference(generated);
    const artifact = await compileModuleSource(
      "generated_effect.duck",
      generatedSource(generated),
      { gpuMode: "off" },
    );
    const actual = await runMain(artifact.wasm);
    if (actual !== expected) {
      throw new Error(
        `generated handler ${
          JSON.stringify(generated)
        } expected ${expected}; received ${actual}`,
      );
    }
  }
});

Deno.test("generated stateful handlers agree with the reference calculus", async () => {
  for (let seed = 0; seed < 8; seed += 1) {
    const generated = {
      initialValue: seed,
      addedValue: (seed * 7 + 3) % 13,
      continuationIncrement: seed % 5,
      returnIncrement: (seed * 3 + 1) % 7,
      resumesGet: seed % 3 !== 0,
    };
    const expected = evaluateStatefulReference(generated);
    const artifact = await compileModuleSource(
      "generated_state_effect.duck",
      generatedStatefulSource(generated),
      { gpuMode: "off" },
    );
    const actual = await runMain(artifact.wasm);
    if (actual !== expected) {
      throw new Error(
        `generated stateful handler ${
          JSON.stringify(generated)
        } expected ${expected}; received ${actual}`,
      );
    }
  }
});

function generatedHandlerCases(): readonly GeneratedHandlerCase[] {
  const cases: GeneratedHandlerCase[] = [];
  for (let seed = 0; seed < 16; seed += 1) {
    cases.push({
      performedValue: (seed * 17 + 3) % 47,
      continuationIncrement: (seed * 5 + 1) % 11,
      returnIncrement: (seed * 7 + 2) % 13,
      resumes: seed % 3 !== 0,
    });
  }
  return cases;
}

function evaluateReference(generated: GeneratedHandlerCase): number {
  const counter = effectCapability(0, "Counter");
  const get = effectOperation(counter, "get");
  const computation = bindEffect(
    performEffect<number>(get),
    (value) => returnEffect(value + generated.continuationIncrement),
    emptyEffectRow(),
  );
  const handler: EffectHandler<number, number> = {
    capability: counter,
    effects: emptyEffectRow(),
    onReturn: (value) => returnEffect(value + generated.returnIncrement),
    operations: new Map([
      [
        "get",
        {
          linearity: "affine",
          evaluate: (_operands, resume) =>
            generated.resumes
              ? resume(generated.performedValue)
              : returnEffect(generated.performedValue),
        },
      ],
    ]),
  };
  return runClosedEffect(
    handleEffect(
      computation as EffectComputation<number>,
      handler,
    ),
  );
}

function generatedSource(generated: GeneratedHandlerCase): string {
  const clause = generated.resumes
    ? `!resume(${generated.performedValue})`
    : `${generated.performedValue}`;
  return `effect Counter {
  get: () => I32
}

let run: () -> <Counter> I32 = () => {
  value <- Counter.get()
  value + ${generated.continuationIncrement}
}

let counter = Counter {
  get: (!resume) => ${clause},
  return: value => value + ${generated.returnIncrement},
}

try run() with counter
`;
}

type GeneratedStatefulCase = {
  readonly initialValue: number;
  readonly addedValue: number;
  readonly continuationIncrement: number;
  readonly returnIncrement: number;
  readonly resumesGet: boolean;
};

function evaluateStatefulReference(
  generated: GeneratedStatefulCase,
): number {
  const counter = effectCapability(0, "Counter");
  const add = effectOperation(counter, "add");
  const get = effectOperation(counter, "get");
  const computation = bindEffect(
    performEffect<void>(add, [generated.addedValue]),
    () =>
      bindEffect(
        performEffect<number>(get),
        (value) => returnEffect(value + generated.continuationIncrement),
        emptyEffectRow(),
      ),
    emptyEffectRow(),
  );
  let count = generated.initialValue;
  const handler: EffectHandler<number, number> = {
    capability: counter,
    effects: emptyEffectRow(),
    onReturn: (value) => returnEffect(value + generated.returnIncrement),
    operations: new Map([
      [
        "add",
        {
          linearity: "affine",
          evaluate: (operands, resume) => {
            count += operands[0] as number;
            return resume(undefined);
          },
        },
      ],
      [
        "get",
        {
          linearity: "affine",
          evaluate: (_operands, resume) =>
            generated.resumesGet ? resume(count) : returnEffect(count),
        },
      ],
    ]),
  };
  return runClosedEffect(handleEffect(computation, handler));
}

function generatedStatefulSource(
  generated: GeneratedStatefulCase,
): string {
  const getClause = generated.resumesGet ? "!resume(count)" : "count";
  return `effect Counter {
  add: (I32) => Unit
  get: () => I32
}

let run: () -> <Counter> I32 = () => {
  _ <- Counter.add(${generated.addedValue})
  value <- Counter.get()
  value + ${generated.continuationIncrement}
}

let counter = {
  let count = ${generated.initialValue}
  Counter {
    add: (amount, !resume) => {
      count = count + amount
      !resume(())
    },
    get: (!resume) => ${getClause},
    return: value => value + ${generated.returnIncrement},
  }
}

try run() with counter
`;
}

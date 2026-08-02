import {
  compileComptimeExpression,
  evaluateBytecodeOnCpu,
  evaluateBytecodeOnGpu,
} from "../src/comptime.ts";
import { proposeDucklangCoreRewrites } from "../src/ducklang_core_rewrite.ts";
import { lowerDucklangToCore } from "../src/ducklang_core.ts";
import {
  FlatDucklangCoreKind,
  flattenDucklangCore,
} from "../src/flat_ducklang_core.ts";
import { runDucklangCoreGpuPass } from "../src/gpu_ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";
import { unionPairsOnGpu } from "../src/gpu_solver.ts";
import { emitWasmPlanOnGpu } from "../src/gpu_wasm.ts";
import { parseModule } from "../src/parser.ts";
import { createRustWasmEmitter } from "../src/rust_wasm_emitter.ts";
import {
  emitWasmPlanOnCpu,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "../src/wasm.ts";

const generatedSeeds = [
  0x1020_3040,
  0x3141_5926,
  0x5eed_c0de,
  0x89ab_cdef,
  0xc001_d00d,
  0xffff_ffc5,
] as const;

Deno.test("generated union batches match a deterministic CPU partition", async () => {
  for (const seed of generatedSeeds) {
    await withSeed(seed, async (random) => {
      const termCount = 24;
      const pairs = Array.from({ length: 48 }, () =>
        [
          random.integer(termCount),
          random.integer(termCount),
        ] as [number, number]);
      const expected = cpuRepresentatives(termCount, pairs);

      const actual = await unionPairsOnGpu(termCount, pairs);

      if (actual !== undefined) assertEquals(actual, expected);
    });
  }
});

Deno.test("generated compile-time bytecode matches independently evaluated arithmetic", async () => {
  const programs = generatedSeeds.map((seed) =>
    withSeedSync(seed, (random) => {
      const generated = arithmeticExpression(random, 4);
      const module = parseModule(
        `generated_${seed}.hs`,
        `main = comptime (${generated.source})\n`,
      );
      const declaration = module.declarations.find((candidate) =>
        candidate.kind === "value"
      );
      if (
        declaration?.kind !== "value" ||
        declaration.expression.kind !== "comptime"
      ) {
        throw new Error("generated source did not contain comptime");
      }
      return {
        seed,
        expected: generated.value,
        program: compileComptimeExpression(
          declaration.expression.expression,
        ),
      };
    })
  );

  const cpu = evaluateBytecodeOnCpu(programs.map((entry) => entry.program));
  if (cpu.status !== "completed") {
    throw new Error("generated CPU comptime batch did not complete");
  }
  assertEquals(
    cpu.values,
    programs.map((entry) => ({ kind: "integer", value: entry.expected })),
  );

  const gpu = await evaluateBytecodeOnGpu(
    programs.map((entry) => entry.program),
  );
  if (gpu.status === "completed") assertEquals(gpu.values, cpu.values);
});

Deno.test("generated noncanonical Core identities match on CPU and GPU without touching floats", async () => {
  for (const seed of generatedSeeds) {
    await withSeed(seed, async (random) => {
      const base = random.integer(2_000);
      const source = `let base = ${base}
let sum = base + 17
let product = sum * 19
let float_value = ${random.integer(10) + 1}.0f32
let float_identity = float_value * 1.0f32
product
`;
      const parsed = await parseDucklangModule(
        `generated_${seed}.duck`,
        source,
      );
      const constructed = flattenDucklangCore(
        lowerDucklangToCore(
          inferDucklangModule(resolveDucklangModule(parsed)),
        ),
      );
      const snapshot = replaceNumberAttributes(constructed, [[17, 0], [19, 1]]);
      const expected = proposeDucklangCoreRewrites(snapshot);
      assertEquals(
        expected.map((proposal) => proposal.rule),
        ["addZero", "multiplyOne"],
      );

      const gpu = await runDucklangCoreGpuPass(snapshot);
      if (gpu.status === "completed") {
        assertEquals(gpu.proposals, expected);
      } else if (gpu.status === "invalid") {
        throw new Error(`GPU rejected generated valid Core: ${gpu.reason}`);
      }
    });
  }
});

function replaceNumberAttributes(
  snapshot: ReturnType<typeof flattenDucklangCore>,
  replacements: readonly (readonly [number, number])[],
): ReturnType<typeof flattenDucklangCore> {
  const attributeLowWords = snapshot.attributeLowWords.slice();
  const attributeHighWords = snapshot.attributeHighWords.slice();
  for (const [from, to] of replacements) {
    const fromWords = numberWords(from);
    const toWords = numberWords(to);
    const attributeId = [...snapshot.attributeKinds].findIndex((kind, index) =>
      kind === FlatDucklangCoreKind.attribute.number &&
      snapshot.attributeLowWords[index] === fromWords.low &&
      snapshot.attributeHighWords[index] === fromWords.high
    );
    if (attributeId < 0) {
      throw new Error(`generated Core has no numeric constant ${from}`);
    }
    attributeLowWords[attributeId] = toWords.low;
    attributeHighWords[attributeId] = toWords.high;
  }
  return { ...snapshot, attributeLowWords, attributeHighWords };
}

function numberWords(
  value: number,
): { readonly low: number; readonly high: number } {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, true);
  return { low: view.getUint32(0, true), high: view.getUint32(4, true) };
}

Deno.test("generated Wasm plans emit valid byte-identical modules", async () => {
  const { emitter: rustWasmEmitter } = await createRustWasmEmitter();
  for (const seed of generatedSeeds) {
    await withSeed(seed, async (random) => {
      const builder = new WasmModuleBuilder();
      const type = builder.addFunctionType([], [wasmType.i32]);
      const functionCount = random.integer(8) + 1;
      for (let index = 0; index < functionCount; index += 1) {
        builder.addFunction(type, [], [
          ...wasmInstruction.i32Constant(random.integer(4_096) - 2_048),
        ]);
      }
      builder.exportFunction("main", 0);
      const plan = builder.finishPlan();
      const expected = emitWasmPlanOnCpu(plan);
      assertEquals(
        WebAssembly.validate(
          new Uint8Array(expected).buffer as ArrayBuffer,
        ),
        true,
      );

      const gpu = await emitWasmPlanOnGpu(plan);
      if (gpu.status === "completed") assertEquals(gpu.bytes, expected);
      assertEquals(rustWasmEmitter.emit(plan).bytes, expected);
    });
  }
});

type RandomSource = {
  readonly integer: (exclusiveLimit: number) => number;
};

function randomSource(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    integer(exclusiveLimit: number): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % exclusiveLimit;
    },
  };
}

async function withSeed(
  seed: number,
  action: (random: RandomSource) => Promise<void>,
): Promise<void> {
  try {
    await action(randomSource(seed));
  } catch (cause) {
    throw new Error(`generated GPU differential seed 0x${seed.toString(16)}`, {
      cause,
    });
  }
}

function withSeedSync<T>(
  seed: number,
  action: (random: RandomSource) => T,
): T {
  try {
    return action(randomSource(seed));
  } catch (cause) {
    throw new Error(`generated GPU differential seed 0x${seed.toString(16)}`, {
      cause,
    });
  }
}

function cpuRepresentatives(
  termCount: number,
  pairs: readonly (readonly [number, number])[],
): readonly number[] {
  const parents = Array.from({ length: termCount }, (_, index) => index);
  const root = (term: number): number => {
    let current = term;
    while (parents[current] !== current) current = parents[current];
    return current;
  };
  for (const [left, right] of pairs) {
    const leftRoot = root(left);
    const rightRoot = root(right);
    parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  }
  return parents.map((_, index) => root(index));
}

function arithmeticExpression(
  random: RandomSource,
  depth: number,
): { readonly source: string; readonly value: number } {
  if (depth === 0) {
    const value = random.integer(6);
    return { source: String(value), value };
  }
  const left = arithmeticExpression(random, depth - 1);
  const right = arithmeticExpression(random, depth - 1);
  const operator = ["+", "-", "*"][random.integer(3)];
  const value = operator === "+"
    ? left.value + right.value
    : operator === "-"
    ? left.value - right.value
    : left.value * right.value;
  return {
    source: `(${left.source} ${operator} ${right.source})`,
    value,
  };
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}; received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

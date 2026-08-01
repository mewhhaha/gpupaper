import {
  commitTrustedDucklangCoreRewrites,
  proposeDucklangCoreRewrites,
  rebuildFlatDucklangCore,
  resolveDucklangCoreRewriteConflicts,
  rewriteFlatDucklangCore,
} from "../src/ducklang_core_rewrite.ts";
import { lowerDucklangToCore } from "../src/ducklang_core.ts";
import {
  FlatDucklangCoreKind,
  flattenDucklangCore,
  inflateFlatDucklangCore,
  validateFlatDucklangCore,
} from "../src/flat_ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("Core rewrites match identity constants through value definitions", async () => {
  const snapshot = await flat(
    `let value = 42
let zero = 17
let intervening = 7
value + zero
`,
    [[17, 0]],
  );

  const proposals = proposeDucklangCoreRewrites(snapshot);

  assertEquals(proposals.map((proposal) => proposal.rule), ["addZero"]);
  const proposal = proposals[0];
  assertEquals(
    proposal.operationId -
        snapshot.valueDefinitionIds[proposal.replacementValueId] >
      1,
    true,
  );
});

Deno.test("Core rewrites rebuild a new valid snapshot and preserve the original", async () => {
  const snapshot = await flat(
    "let value = 21\nlet first = value + 17\nfirst * 19\n",
    [[17, 0], [19, 1]],
  );
  const before = columns(snapshot);

  const rewritten = rewriteFlatDucklangCore(snapshot);

  assertEquals(columns(snapshot), before);
  assertEquals(rewritten.accepted.length, 2);
  assertEquals(
    rewritten.package.operationKinds.length,
    snapshot.operationKinds.length - 2,
  );
  inflateFlatDucklangCore(rewritten.package);
});

Deno.test("Core identity rewrites preserve observable floating-point values", async () => {
  const snapshot = await flat(
    `let zero = 0.0f32
let one = 1.0f32
let value = 2.0f32
let sum = value + zero
sum * one
`,
  );

  const proposals = proposeDucklangCoreRewrites(snapshot);

  assertEquals(proposals, []);
});

Deno.test("Core rewrite without an accepted proposal preserves snapshot identity", async () => {
  const snapshot = await flat(
    `let left = 20
let right = 22
left + right
`,
  );

  const rewritten = rewriteFlatDucklangCore(snapshot);

  assertEquals(rewritten.proposals, []);
  assertEquals(rewritten.accepted, []);
  assertEquals(rewritten.package === snapshot, true);
  assertEquals(rebuildFlatDucklangCore(snapshot, []) === snapshot, true);
  assertEquals(
    commitTrustedDucklangCoreRewrites(
      validateFlatDucklangCore(snapshot),
      [],
    ).package === snapshot,
    true,
  );
});

Deno.test("Core commit rejects a structurally valid false rewrite", async () => {
  const snapshot = await flat(
    "let value = 42\nlet zero = 17\nvalue + zero\n",
    [[17, 0]],
  );
  const proposal = proposeDucklangCoreRewrites(snapshot)[0];
  const operandStart = snapshot.operationOperandStarts[proposal.operationId];
  const falseReplacement = snapshot.operandValueIds[operandStart + 1];

  assertThrows(
    () =>
      resolveDucklangCoreRewriteConflicts(snapshot, [{
        ...proposal,
        replacementValueId: falseReplacement,
      }]),
    /does not match the validated snapshot/,
  );
});

async function flat(
  source: string,
  replacements: readonly (readonly [number, number])[] = [],
) {
  const parsed = await parseDucklangModule("rewrite_core.duck", source);
  const snapshot = flattenDucklangCore(
    lowerDucklangToCore(
      inferDucklangModule(resolveDucklangModule(parsed)),
    ),
  );
  if (replacements.length === 0) return snapshot;
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
      throw new Error(`fixture has no numeric Core constant ${from}`);
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

function columns(package_: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(package_)
      .filter((entry): entry is [string, Uint8Array | Uint32Array] =>
        entry[1] instanceof Uint8Array || entry[1] instanceof Uint32Array
      )
      .map(([name, values]) => [name, [...values]])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
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

function assertThrows(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected action to throw ${pattern}`);
}

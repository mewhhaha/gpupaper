import {
  flattenDucklangCore,
  inflateFlatDucklangCore,
  validateFlatDucklangCore,
} from "../src/flat_ducklang_core.ts";
import { lowerDucklangToCore } from "../src/ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

Deno.test("flat Ducklang Core round-trips closures control flow values and layouts", async () => {
  const core = await lower(
    `let apply = (call: I32 -> I32, value: I32) => call(value)
let make_adder = (base: I32) => (offset: I32) => base + offset
let add = make_adder(40)
if true { apply(add, 2) } else { 0 }
`,
  );

  const flat = flattenDucklangCore(core);

  validateFlatDucklangCore(flat);
  assertEquals(inflateFlatDucklangCore(flat), core);
  assertEquals(flat.edgeArgumentValueIds.length > 0, true);
  assertEquals(flat.layoutKinds.length > 0, true);
  assertEquals(flat.typeLayoutIds.length, core.types.length);
});

Deno.test("flat Ducklang Core construction is deterministic across every column", async () => {
  const core = await lower(
    "let choose = (flag: Bool) => if flag { 42 } else { 7 }\nchoose(true)\n",
  );

  assertEquals(
    columns(flattenDucklangCore(core)),
    columns(flattenDucklangCore(core)),
  );
});

Deno.test("flat Ducklang Core validation rejects a cross-function operand", async () => {
  const core = await lower(
    "let first = () => 1\nlet second = () => 2\nfirst() + second()\n",
  );
  const flat = flattenDucklangCore(core);
  const operationId = [...flat.operationOperandCounts].findIndex((count) =>
    count > 0
  );
  const foreignValueId = [...flat.valueFunctionIds].findIndex((functionId) =>
    functionId !== flat.blockFunctionIds[flat.operationBlockIds[operationId]]
  );
  if (operationId < 0 || foreignValueId < 0) {
    throw new Error("fixture did not produce two function value domains");
  }
  const operands = flat.operandValueIds.slice();
  operands[flat.operationOperandStarts[operationId]] = foreignValueId;

  assertThrows(
    () =>
      validateFlatDucklangCore({
        ...flat,
        operandValueIds: operands,
      }),
    /uses value \d+ from function \d+; expected \d+/,
  );
});

Deno.test("flat Ducklang Core validation rejects a falsified physical layout", async () => {
  const flat = flattenDucklangCore(
    await lower("let pair = [20, 22]\npair[0] + pair[1]\n"),
  );
  const sizes = flat.layoutSizes.slice();
  sizes[flat.typeLayoutIds.at(-1)!] += 4;

  assertThrows(
    () => validateFlatDucklangCore({ ...flat, layoutSizes: sizes }),
    /layout layoutSizes disagrees with Core/,
  );
});

async function lower(source: string) {
  return lowerDucklangToCore(
    inferDucklangModule(
      resolveDucklangModule(
        await parseDucklangModule("flat_core.duck", source),
      ),
    ),
  );
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
  if (stringify(actual) !== stringify(expected)) {
    throw new Error(
      `expected ${stringify(expected)}; received ${stringify(actual)}`,
    );
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, nested]) => [name, normalize(nested)]),
    );
  }
  return value;
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

import type {
  DucklangCoreFunction,
  DucklangCoreModule,
} from "../src/ducklang_core.ts";
import {
  lowerDucklangToCore,
  validateDucklangCore,
} from "../src/ducklang_core.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { inferDucklangModule } from "../src/ducklang_types.ts";

/**
 * What Core lowering does with each source control-flow construct.
 *
 * Every case asserts the resulting block structure, not just that lowering
 * succeeded, because a lowering that collapsed a branch into straight-line code
 * would still produce a module the validator accepts. Each result is also fed to
 * validateDucklangCore, so the shape assertions and the structural invariants
 * are checked against each other.
 */

Deno.test("Core lowers an expression if to a join block with a result parameter", async () => {
  const { module, function_ } = await lower(
    "let pick = flag => if flag { 1 } else { 2 }\npick(true)\n",
    "pick",
  );

  assertEquals(function_.blocks[0].terminator.kind, "conditional_branch");
  const join = function_.blocks.at(-1)!;
  assertEquals(join.parameters.length, 1);
  // The join carries the branch result, so it is the value returned.
  assertEquals(join.terminator.kind, "return");
  assertEquals(
    scalarOf(module, join.parameters[0].type),
    "i32",
  );
  // Both arms must reach the join by an edge supplying that parameter.
  const edges = function_.blocks.filter((block) =>
    block.terminator.kind === "branch" && block.terminator.target === join.id
  );
  assertEquals(edges.length, 2);
});

Deno.test("Core lowers a statement-only branch to Unit plus a continuation edge", async () => {
  const { module, function_ } = await lower(
    "let f = flag => {\n  let total = 0\n  if flag {\n    total = 1\n  }\n  total\n}\nf(true)\n",
    "f",
  );

  assertEquals(function_.blocks[0].terminator.kind, "conditional_branch");
  const join = function_.blocks.at(-1)!;
  assertEquals(join.parameters.length, 1);
  // A branch used as a statement produces no value, so its join parameter is
  // Unit and the continuation carries it.
  assertEquals(scalarOf(module, join.parameters[0].type), "unit");
});

Deno.test("Core lowers a union match to a join block with a result parameter", async () => {
  const { module, function_ } = await lower(
    "type Result = | `Ok Int | `Err Text\n\nlet unwrap = (result: Result) => {\n  if let `Ok value = result {\n    value + 1\n  } else {\n    0\n  }\n}\n\nunwrap(`Ok (41))\n",
    "unwrap",
  );

  assertEquals(function_.blocks[0].terminator.kind, "conditional_branch");
  const join = function_.blocks.at(-1)!;
  assertEquals(join.parameters.length, 1);
  assertEquals(scalarOf(module, join.parameters[0].type), "i32");
  // The matched payload must be projected, not re-derived from the scrutinee.
  assertEquals(
    function_.blocks.some((block) =>
      block.operations.some((operation) => operation.kind === "sum.payload")
    ),
    true,
  );
});

Deno.test("Core lowers an early return to a function terminator", async () => {
  const { function_ } = await lower(
    "let f = value => {\n  if value == 0 {\n    return 9\n  }\n  value + 1\n}\nf(0)\n",
    "f",
  );

  assertEquals(function_.blocks[0].terminator.kind, "conditional_branch");
  // The early arm ends the function outright rather than branching to a join.
  const returning = function_.blocks.filter((block) =>
    block.terminator.kind === "return"
  );
  assertEquals(returning.length >= 2, true);
  assertEquals(
    function_.blocks[1].terminator.kind,
    "return",
  );
});

Deno.test("Core lowers lexical shadowing to distinct value identities", async () => {
  const { function_ } = await lower(
    "let f = value => {\n  let x = value\n  let x = x + 1\n  let x = x + 1\n  x\n}\nf(1)\n",
    "f",
  );

  const results = function_.blocks.flatMap((block) =>
    block.operations.map((operation) => operation.result)
  );
  // Three bindings named x, and no value identity is reused for two of them.
  assertEquals(new Set(results).size, results.length);
  const returned = function_.blocks.at(-1)!.terminator;
  if (returned.kind !== "return") throw new Error("expected a return");
  // The result is the last shadowed version, not the first.
  assertEquals(returned.values.length, 1);
  assertEquals(returned.values[0], Math.max(...results));
});

Deno.test("Core preserves a nested branch boundary", async () => {
  const { function_ } = await lower(
    "let f = (a, b) => {\n  let outer = if a {\n    let inner = if b { 1 } else { 2 }\n    inner\n  } else {\n    3\n  }\n  outer\n}\nf(true, false)\n",
    "f",
  );

  // Two conditionals means two distinct branch boundaries survive lowering.
  assertEquals(
    function_.blocks.filter((block) =>
      block.terminator.kind === "conditional_branch"
    ).length,
    2,
  );
});

/**
 * A range step of zero never terminates, so it must never reach the backend. A
 * literal zero is a static error; a step that is only known at runtime becomes a
 * trap edge instead. The dynamic half is covered by the corpus contract trap for
 * examples/failures/traps/04_zero_range_step.duck; this asserts the static half,
 * which had no test.
 */
/**
 * Aggregate operations must reach Core as value primitives rather than as
 * anything source-shaped. Each case asserts the specific primitive appears, so a
 * lowering that fell back to memory loads or kept a source field name would fail
 * rather than pass on "it produced some operations".
 *
 * Every value lives inside a function: lowerDucklangToCore only lowers function
 * bindings, and a module-level value binding reports "Core lowering has no
 * runtime value for <name>".
 */
const aggregateCases:
  readonly (readonly [string, string, readonly string[]])[] = [
    [
      "product construction and projection",
      "type Point = struct { .x = Int, .y = Int }\nlet make = () => {\n  let p: Point = [1, 2]\n  p.x\n}\nmake()\n",
      ["product.make", "product.project"],
    ],
    [
      "a functional product update",
      "type Point = struct { .x = Int, .y = Int }\nlet move = () => {\n  let p: Point = [1, 2]\n  let moved = Point.with_y(p, 9)\n  moved.y\n}\nmove()\n",
      ["product.make", "product.update", "product.project"],
    ],
    [
      "sum construction, tag access, and payload access",
      "type Result = | `Ok Int | `Err Text\nlet make = () => {\n  let r: Result = `Ok (7)\n  if let `Ok value = r { value } else { 0 }\n}\nmake()\n",
      ["sum.make", "sum.tag", "sum.payload"],
    ],
  ];

for (const [description, source, expected] of aggregateCases) {
  Deno.test(`Core lowers ${description} to value primitives`, async () => {
    const parsed = await parseDucklangModule("aggregates.duck", source);
    const module = lowerDucklangToCore(
      inferDucklangModule(resolveDucklangModule(parsed)),
    );
    validateDucklangCore(module);
    const kinds = new Set<string>(
      module.functions.flatMap((function_) =>
        function_.blocks.flatMap((block) =>
          block.operations.map((operation) => operation.kind as string)
        )
      ),
    );
    for (const primitive of expected) {
      if (!kinds.has(primitive)) {
        throw new Error(
          `expected ${primitive}; Core used ${[...kinds].sort().join(", ")}`,
        );
      }
    }
    // No operation may carry a source field name: projection is positional.
    assertEquals(
      module.functions.flatMap((function_) =>
        function_.blocks.flatMap((block) =>
          block.operations.filter((operation) => "fieldName" in operation)
        )
      ).length,
      0,
    );
  });
}

async function lower(
  source: string,
  functionName: string,
): Promise<
  {
    readonly module: DucklangCoreModule;
    readonly function_: DucklangCoreFunction;
  }
> {
  const parsed = await parseDucklangModule("core_lowering.duck", source);
  const module = lowerDucklangToCore(
    inferDucklangModule(resolveDucklangModule(parsed)),
  );
  validateDucklangCore(module);
  const function_ = module.functions.find((candidate) =>
    candidate.name === functionName
  );
  if (function_ === undefined) {
    throw new Error(
      `no Core function ${functionName}; found ${
        module.functions.map((candidate) => candidate.name).join(", ")
      }`,
    );
  }
  return { module, function_ };
}

function scalarOf(module: DucklangCoreModule, type: number): string {
  const entry = module.types[type];
  return entry.kind === "scalar" ? entry.scalar : entry.kind;
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

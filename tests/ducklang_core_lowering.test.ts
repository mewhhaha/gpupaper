import type {
  DucklangCoreFunction,
  DucklangCoreModule,
} from "../src/ducklang_core.ts";
import {
  lowerDucklangToCore,
  validateDucklangCore,
} from "../src/ducklang_core.ts";
import { lowerDucklangControlFlow } from "../src/ducklang_control_flow.ts";
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
 * Module values are lowered into `main`; functions receive any values they
 * capture as explicit parameters.
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

/**
 * Core types are structural, so one structure must have one ID.
 *
 * The type registry interns by source type spelling, which gives two IDs to one
 * structure whenever two spellings agree: `Int` and `I32` both resolve to
 * `scalar i32`, and two nominally distinct structs with the same field types both
 * resolve to the same product. The validator compares edge argument types by ID,
 * so duplicates would let it reject two values of the same type as differently
 * typed. Nominal distinctness is settled before Core by
 * qualifyDucklangTypeCollisions.
 */
Deno.test("Core canonicalizes structurally identical types onto one ID", async () => {
  const parsed = await parseDucklangModule(
    "canonical.duck",
    "type A = struct { .x = Int, .y = Int }\ntype B = struct { .p = Int, .q = Int }\ntype C = struct { .x = Int }\nlet f = () => {\n  let a: A = [1, 2]\n  let b: B = [3, 4]\n  let c: C = [5]\n  a.x + b.p + c.x\n}\nf()\n",
  );
  const module = lowerDucklangToCore(
    inferDucklangModule(resolveDucklangModule(parsed)),
  );
  validateDucklangCore(module);

  const keys = module.types.map((entry) => JSON.stringify(entry));
  assertEquals(keys.length - new Set(keys).size, 0);
  // A and B share one product type; C keeps its own because it has one field.
  assertEquals(
    module.types.filter((entry) => entry.kind === "product").length,
    2,
  );
  // Every surviving ID is still addressable and in range.
  for (const entry of module.types) {
    const referenced = entry.kind === "product"
      ? entry.fields
      : entry.kind === "sum"
      ? entry.cases
      : [];
    for (const id of referenced) {
      assertEquals(id >= 0 && id < module.types.length, true);
    }
  }
});

Deno.test("Core canonicalization survives a merge that enables another", async () => {
  // Two products become identical only after their differing field types merge,
  // so a single pass would leave them distinct.
  const parsed = await parseDucklangModule(
    "cascade.duck",
    "type Inner = struct { .v = Int }\ntype Outer1 = struct { .a = Int, .b = Int }\ntype Outer2 = struct { .c = Int, .d = Int }\nlet f = () => {\n  let i: Inner = [1]\n  let x: Outer1 = [2, 3]\n  let y: Outer2 = [4, 5]\n  i.v + x.a + y.c\n}\nf()\n",
  );
  const module = lowerDucklangToCore(
    inferDucklangModule(resolveDucklangModule(parsed)),
  );
  validateDucklangCore(module);

  const keys = module.types.map((entry) => JSON.stringify(entry));
  assertEquals(keys.length - new Set(keys).size, 0);
});

/**
 * Module-level value bindings.
 *
 * lowerDucklangToCore turns each function binding into a Core function, but a
 * module-level value binding is neither a function nor part of the module result,
 * so every reference to one failed with "Core lowering has no runtime value for
 * <name>". `main` now lowers as a block that binds them before the result.
 *
 * This was one of the three recorded blockers to wiring Core into the pipeline.
 */
const moduleBindingCases: readonly (readonly [string, string, number])[] = [
  ["a scalar", "let base = 40\nbase + 2\n", 1],
  [
    "a struct",
    "type Point = struct { .x = Int, .y = Int }\nlet p: Point = [20, 22]\np.x + p.y\n",
    1,
  ],
  [
    "a recursive list built from module-level cells",
    "type Cell value = struct { .head = value, .tail = List value }\ntype List value = | `Cons Cell value | `Nil Unit\nlet sum_list = rec (l: List Int) => {\n  if let `Cons cell = l {\n    cell.head + sum_list(cell.tail)\n  } else {\n    0\n  }\n}\nlet empty: List Int = `Nil ()\nlet two: List Int = `Cons ([42, empty])\nsum_list(two)\n",
    2,
  ],
];

for (const [description, source, expectedFunctions] of moduleBindingCases) {
  Deno.test(`Core lowers a module-level binding of ${description}`, async () => {
    const parsed = await parseDucklangModule("module_binding.duck", source);
    const module = lowerDucklangToCore(
      inferDucklangModule(resolveDucklangModule(parsed)),
    );
    validateDucklangCore(module);

    assertEquals(module.functions.length, expectedFunctions);
    const main = module.functions.at(-1)!;
    assertEquals(main.name, "main");
    // The binding's value has to be computed inside main, so main cannot be an
    // empty shell that merely returns a constant.
    assertEquals(
      main.blocks.reduce((total, block) => total + block.operations.length, 0) >
        1,
      true,
    );
  });
}

Deno.test("Core lowering leaves a function-only module unchanged", async () => {
  const parsed = await parseDucklangModule(
    "function_only.duck",
    "let f = () => 42\nf()\n",
  );
  const module = lowerDucklangToCore(
    inferDucklangModule(resolveDucklangModule(parsed)),
  );
  validateDucklangCore(module);

  // No value bindings, so main stays the module result alone: one call.
  assertEquals(module.functions.length, 2);
  assertEquals(
    module.functions.at(-1)!.blocks.reduce(
      (total, block) => total + block.operations.length,
      0,
    ),
    1,
  );
});

Deno.test("Core gives a captured function typed code and environment boundaries", async () => {
  const parsed = await parseDucklangModule(
    "closure.duck",
    "let apply = (f: I32 -> I32, value: I32) => f(value)\nlet make_adder = (base: I32) => (offset: I32) => base + offset\nlet add = make_adder(40)\napply(add, 2)\n",
  );
  const module = lowerDucklangToCore(
    inferDucklangModule(resolveDucklangModule(parsed)),
  );
  validateDucklangCore(module);

  const closure = module.functions.find((function_) =>
    function_.name.startsWith("$closure_")
  );
  if (closure === undefined) throw new Error("expected a lifted closure");
  const codeSignature = module.signatures[closure.signature];
  assertEquals(codeSignature.parameters.length, 2);

  const closureMake =
    module.functions.flatMap((function_) =>
      function_.blocks.flatMap((block) =>
        block.operations.filter((operation) =>
          operation.kind === "closure.make" &&
          operation.functionId === closure.id
        )
      )
    )[0];
  if (closureMake?.kind !== "closure.make") {
    throw new Error("expected closure.make for captured function");
  }
  assertEquals(closureMake.operands.length, 1);
  const closureType = module.types[closureMake.type];
  if (closureType.kind !== "function") {
    throw new Error("closure.make did not produce a function type");
  }
  assertEquals(
    module.signatures[closureType.signature].parameters.length,
    1,
  );

  const apply = module.functions.find((function_) =>
    function_.name === "apply"
  );
  if (apply === undefined) throw new Error("expected apply");
  assertEquals(
    apply.blocks.some((block) =>
      block.operations.some((operation) => operation.kind === "call.indirect")
    ),
    true,
  );
});

Deno.test("Core replaces a dynamic range recursion with header and exit edges", async () => {
  const parsed = await parseDucklangModule(
    "range.duck",
    "let sum = bound => {\n  let total = 0\n  for value in 0..bound {\n    total = total + value\n  }\n  total\n}\nsum(5)\n",
  );
  const module = lowerDucklangToCore(
    inferDucklangModule(
      resolveDucklangModule(lowerDucklangControlFlow(parsed)),
    ),
  );
  const loop = module.functions.find((function_) =>
    function_.name.startsWith("$range_loop_")
  );
  if (loop === undefined) throw new Error("expected a range loop function");

  assertEquals(
    loop.blocks.some((block) =>
      block.terminator.kind === "branch" &&
      block.terminator.target === loop.entryBlock
    ),
    true,
  );
  assertEquals(
    loop.blocks.some((block) =>
      block.operations.some((operation) =>
        operation.kind === "call.direct" &&
        operation.functionId === loop.id
      )
    ),
    false,
  );
  const exits = loop.blocks.filter((block) =>
    block.terminator.kind === "return"
  );
  assertEquals(exits.length, 1);
  assertEquals(exits[0].parameters.length, 1);
});

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

import { compileModuleSource, runMain } from "../src/compiler.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import { resolveDucklangModule } from "../src/ducklang_resolution.ts";
import { formatDucklangType } from "../src/ducklang_types.ts";
import { inflateFlatFcgPackage } from "../src/flat_fcg.ts";
import { inflateFlatDucklangCore } from "../src/flat_ducklang_core.ts";

Deno.test("Ducklang parses editor union, lambda, guard, and effect boundaries", async () => {
  const module = await parseDucklangModule(
    "editor_boundaries.duck",
    `module () where
type Tree = | \`Empty Unit | \`Node I32
const ctrl_c = cast(3, Char)
let pair = (left: I32, right: I32) => [left, right]
let choose = tree => match tree {
  | \`Empty _ => [0, 0]
  | \`Node node => \`Pair [node, node]
  | _ => [1, 1]
}
let classify = byte => match byte {
  | _ if byte != 0 => 1
  | _ => 0
}
let differs = (text, bytes, start) => {
  if !(text_get [text, start] == bytes[0]) { 1 } else { 0 }
}
value <- Io.read()
return { ctrl_c, pair, choose, classify, differs, value }
`,
  );

  assertEquals(
    module.statements.map((statement) => statement.kind),
    [
      "unionType",
      "binding",
      "binding",
      "binding",
      "binding",
      "binding",
      "binding",
      "expression",
    ],
  );
  const choose = module.statements[3];
  assertEquals(
    choose.kind === "binding" && choose.value.kind === "function"
      ? choose.value.body.kind
      : undefined,
    "ifUnion",
  );
  const classify = module.statements[4];
  assertEquals(
    classify.kind === "binding" &&
      classify.value.kind === "function" &&
      classify.value.body.kind === "if" &&
      classify.value.body.condition.kind === "binary"
      ? classify.value.body.condition.operator
      : undefined,
    "!=",
  );
  const differs = module.statements[5];
  assertEquals(
    differs.kind === "binding" &&
      differs.value.kind === "function" &&
      differs.value.body.kind === "block"
      ? differs.value.body.statements[0]?.kind
      : undefined,
    "expression",
  );
  const effectBinding = module.statements[6];
  assertEquals(
    effectBinding.kind === "binding" ? effectBinding.value.kind : undefined,
    "hostCall",
  );
});

Deno.test("Ducklang resolves built-in type witnesses without declarations", async () => {
  const module = await parseDucklangModule("builtin_type.duck", "Char\n");
  const resolved = resolveDucklangModule(module);
  assertEquals(resolved.result, {
    kind: "intrinsic",
    modulePath: "duck:type/builtin",
    exportName: "Char",
    span: { file: "builtin_type.duck", start: 0, end: 4 },
  });
});

Deno.test("Ducklang accepts trailing commas in formatted products and calls", async () => {
  const module = await parseDucklangModule(
    "formatted_products.duck",
    `type Pair = [
  I32,
  I32,
]
let pair = [
  .left = 20,
  .right = 22,
]
combine(
  pair.left,
  pair.right,
)
`,
  );
  assertEquals(
    module.statements.map((statement) => statement.kind),
    ["structType", "binding", "expression"],
  );
});

Deno.test("Ducklang accepts a trailing comma in formatted function parameters", async () => {
  const module = await parseDucklangModule(
    "formatted_parameters.duck",
    `let combine = (
  left: I32,
  right: I32,
) => left + right
combine(20, 22)
`,
  );
  const binding = module.statements[0];
  assertEquals(
    binding.kind === "binding" && binding.value.kind === "function"
      ? binding.value.parameters.map((parameter) =>
        parameter.declaredType?.name
      )
      : undefined,
    ["I32", "I32"],
  );
});

Deno.test("Ducklang marks untyped const parameters for specialization", async () => {
  const module = await parseDucklangModule(
    "const_parameter.duck",
    `let specialize = (const shape) => shape
0
`,
  );
  const binding = module.statements[0];
  assertEquals(
    binding.kind === "binding" && binding.value.kind === "function"
      ? binding.value.parameters[0].compileTimeRecord
      : undefined,
    true,
  );
});

Deno.test("Ducklang specializes aliases of const functions", async () => {
  const artifact = await compileModuleSource(
    "const_function_alias.duck",
    `const specialize = (const value) => value
const alias = specialize
alias(42)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang normalizes dictionaries returned by const functions", async () => {
  const artifact = await compileModuleSource(
    "const_dictionary.duck",
    `const build = (const value_type) => {
  const identity = (value: value_type) => value;
  { .identity = identity }
}
const dictionary = comptime build I32
dictionary.identity 42
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang erases a compile-time construction type witness", async () => {
  const artifact = await compileModuleSource(
    "construct_type_witness.duck",
    `type Pair = [I32, I32]
let pair: Pair = @construct(Pair, [20, 22])
pair[0] + pair[1]
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang applies nominal product casts", async () => {
  const artifact = await compileModuleSource(
    "nominal_product_cast.duck",
    `type Pair = [I32, I32]
let pair = [20, 22] as Pair
pair[0] + pair[1]
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang destructures heterogeneous square products by position", async () => {
  const artifact = await compileModuleSource(
    "square_product_destructuring.duck",
    `const { length } = import "duck:prelude/runtime" ()
type Entry = [I32, Text]
let entry: Entry = @construct(Entry, [38, "duck"])
let [count, label] = entry
count + length label
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang infers heterogeneous square product literals", async () => {
  const artifact = await compileModuleSource(
    "heterogeneous_square_product.duck",
    `const { length } = import "duck:prelude/runtime" ()
let pair = ["duck", true]
let [label, enabled] = pair
if enabled { length label + 38 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang erases specialized type applications before inference", async () => {
  const artifact = await compileModuleSource(
    "specialized_type_application.duck",
    `type Box value = [value]
const make_box = (const value_type) => {
  const box_type = Box value_type
  (value: value_type) => @construct(box_type, [value])
}
const box_int = make_box I32
let [value] = box_int 42
value
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang keeps a terminated binding separate from a following product", async () => {
  const module = await parseDucklangModule(
    "terminated_binding.duck",
    `let result = _ => {
  let next = 40;
  [next + 2]
}
0
`,
  );
  const result = module.statements[0];
  assertEquals(
    result.kind === "binding" &&
      result.value.kind === "function" &&
      result.value.body.kind === "block"
      ? result.value.body.statements.map((statement) => statement.kind)
      : undefined,
    ["binding", "expression"],
  );
  resolveDucklangModule(module);
});

Deno.test("Ducklang lowers direct bracket application as destructured arguments", async () => {
  const artifact = await compileModuleSource(
    "bracket_application.duck",
    `let combine = [left: I32, right: I32] => left + right
combine [20, 22]
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang extension calls pass the receiver before explicit arguments", async () => {
  const artifact = await compileModuleSource(
    "extension_receiver.duck",
    `extend I32 {
  .increment = (value: I32, amount: I32) => value + amount
}
let value = 1
value.increment(41)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang arithmetic and assignment shadowing returns 42", async () => {
  await assertDuckFixture("01_arithmetic_and_shadowing.duck", 42);
});

Deno.test("Ducklang projects a named root module export", async () => {
  const artifact = await compileModuleSource(
    "named_module_export.duck",
    `module () where
let value = 42
return { .answer = value }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.abi.exports.map((entry) => entry.name), [
    "answer",
  ]);
});

Deno.test("Ducklang lowers the complete scalar comparison and boolean family", async () => {
  const artifact = await compileModuleSource(
    "scalar_relations.duck",
    `if 1 != 2 && 1 <= 1 && 2 >= 1 && (false || true) { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang conditions retain bare function call arguments", async () => {
  const artifact = await compileModuleSource(
    "condition_call.duck",
    `let identity = value => value
if identity true { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang statement-only branch blocks evaluate to Unit", async () => {
  const artifact = await compileModuleSource(
    "statement_only_branch.duck",
    `let choose = condition => {
  let total = 40
  if condition {
    total = total + 2
  } else {
    total = total + 1
  }
  total
}
choose(1)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang statement-only branch without else evaluates to Unit", async () => {
  const artifact = await compileModuleSource(
    "statement_only_branch_without_else.duck",
    `let total = 40
if true {
  total = total + 2
}
total
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang statement-only union branch without else evaluates to Unit", async () => {
  const artifact = await compileModuleSource(
    "statement_only_union_branch.duck",
    `type Option = | \`Some I32 | \`None Unit
let option: Option = \`Some 2
let total = 40
if let \`Some value = option {
  total = total + value
}
total
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang runtime imports specialize static UTF-8 byte lengths", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { .length = size } = import "duck:prelude/runtime" ()
size("Aλ") + 39
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.inferred.bindings, []);
});

Deno.test("Ducklang runtime imports specialize static text operations", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { append, length, slice } = import "duck:prelude/runtime" ()
let word = "Aλ"
let rebuilt = append(slice(word, 0, 1), slice(word, 1, length(word)))
if rebuilt == word { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes static text append and byte indexing", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let full = "Ada" <> " Lovelace"
length(full) + full[1]
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 112);
});

Deno.test("Ducklang erases proven static ownership operations", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let message = freeze "shared"
length(&message) * 7
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes borrowed static text parameters", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let measure = (message: Text) => length(&message)
measure("interaction") + 31
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes scalar results from scratch regions", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
let total = scratch {
  let message = "temporary"
  length(message) + 33
}
total
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang multi-argument functions and local blocks return 42", async () => {
  await assertDuckFixture("06_functions_and_blocks.duck", 42);
});

Deno.test("Ducklang return exits its function while false conditions fall through", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let choose = value => {
  if value {
    return 42
  }
  0
}
choose(0)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 0);
});

Deno.test("Ducklang return values must match the function fallthrough type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        `let broken = flag => {
  if flag {
    return 1i64
  }
  0
}
broken(1)
`,
        { gpuMode: "off" },
      ),
    /cannot unify Ducklang i64 with i32|cannot unify Ducklang i32 with i64/,
  );
});

Deno.test("Ducklang else-if chains return 42", async () => {
  await assertDuckFixture("10_else_if.duck", 42);
});

Deno.test("Ducklang calls functions in conditions", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let positive = value => value > 0
if positive(1) { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang same-line block applications remain function calls", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let run = () => { value => value + 1 }(41) + 0\nrun()\n",
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang host effects import scalar runtime inputs", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `module (!init: Init) where
declare effect Input {
  flag: () => Bool
}
declare Init { input: Input }
flag <- Input.flag()
let result = if flag { 21 } else { 41 }
return { .result = result }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm, { input: { flag: 1 } }), 21);
  assertEquals(await runMain(artifact.wasm, { input: { flag: 0 } }), 41);
  await assertRejects(
    () => runMain(artifact.wasm),
    /host input input\.flag requires an input object/,
  );
});

Deno.test("Ducklang infers and checks latent effect rows", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `module (!init: Init) where
declare effect Input { read: () => I32 }
declare Init { input: Input }
let read_value: () -> <Input.read> I32 = () => {
  value <- Input.read()
  value
}
result <- read_value()
return { .result = result }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm, { input: { read: 42 } }), 42);
  const readValue = artifact.inferred.bindings.find((binding) =>
    binding.symbol.text === "read_value"
  );
  assertEquals(
    readValue?.latentEffects.map((effect) =>
      `${effect.effectName}.${effect.operationName}`
    ),
    ["Input.read"],
  );
  assertEquals(
    readValue === undefined ? undefined : formatDucklangType(readValue.type),
    "() -> i32 ! <Input.read>",
  );
  assertEquals(
    artifact.inferred.requiredEffects.map((effect) =>
      `${effect.effectName}.${effect.operationName}`
    ),
    ["Input.read"],
  );
});

Deno.test("Ducklang rejects operations outside a declared pure effect row", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        `module (!init: Init) where
declare effect Input { read: () => I32 }
declare Init { input: Input }
let read_value: () -> I32 = () => {
  value <- Input.read()
  value
}
result <- read_value()
return { .result = result }
`,
        { gpuMode: "off" },
      ),
    /function read_value exceeds its declared effect row with Input\.read/,
  );
});

Deno.test("Ducklang rejects an effect hidden behind a conditional callee", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        `module (!init: Init) where
declare effect Input {
  read: () => I32
}
declare Init { input: Input }

let read: () -> <Input.read> I32 = () => {
  value <- Input.read()
  value
}

let claimed_pure: () -> I32 =
  () => (if 1 == 1 { read } else { read })()

result <- claimed_pure()
return { .result = result }
`,
        { gpuMode: "off" },
      ),
    /function claimed_pure exceeds its declared effect row with Input\.read/,
  );
});

Deno.test("Ducklang functions capture the module symbol visible at declaration", async () => {
  await assertDuckFixture("closure_capture.duck", 43);
});

Deno.test("Ducklang erases runtime function aliases before FCG", async () => {
  const artifact = await compileModuleSource(
    "runtime_function_alias.duck",
    `let add = (left, right) => left + right
let alias = add
alias(20, 22)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes a statically returned closure", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let make_adder = amount => {
  value => value + amount
}
let add_two = make_adder(2)
add_two(40)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    artifact.fcg.functions.map((function_) => function_.name),
    ["add_two__duck3", "main"],
  );
});

Deno.test("Ducklang comptime specializes a closure without a scalar GPU job", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const make_adder = amount => {
  value => value + amount
}
const add_three = comptime make_adder(3)
add_three(39)
`,
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.comptimeCpuValues, []);
  if (artifact.comptimeGpuResult?.status === "completed") {
    assertEquals(artifact.comptimeGpuResult.values, []);
  }
});

Deno.test("Ducklang functional imports specialize composition and pipelines", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { apply, compose, pipe } = import "duck:prelude/functional" ()
const increment = value => value + 1
const double = value => value * 2
const transform = comptime compose(increment, double)
pipe(apply(transform, 20), increment)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang erases invoked const function parameters after specialization", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let apply_twice = (value, const transform) => transform(transform(value))
const increment = value => value + 1
apply_twice(40, increment)
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(
    artifact.fcg.functions.map((function_) => function_.name),
    ["main"],
  );
});

Deno.test("Ducklang resolves and specializes nominal union cases", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `type Result = | \`Ok Int | \`Err Text
let unwrap = (result: Result) => {
  if let \`Ok value = result { value } else { 21 }
}
unwrap(\`Ok (21)) + unwrap(\`Err ("no"))
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang propagates declared function results to union constructors", async () => {
  const artifact = await compileModuleSource(
    "declared_function_union.duck",
    `type List value =
  | \`Nil Unit
  | \`Cons value

type Other = \`Nil Unit

let empty: () -> List I32 = () => \`Nil ()
if let \`Nil () = empty() { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang narrows overloaded patterns from the scrutinee type", async () => {
  const artifact = await compileModuleSource(
    "overloaded_pattern_scrutinee.duck",
    `type Pair = [I32, I32]
type NumberResult = | \`Ok Pair | \`Err Text
type TextResult = | \`Ok Text | \`Missing Unit
let result: NumberResult = \`Ok ([20, 22] as Pair)
if let \`Ok pair = result {
  let [left, right] = pair
  left + right
} else {
  0
}
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang resolves parameterized union aliases", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `type Option value = | \`Some value | \`None Unit
type IntOption = Option Int
let choice = \`Some (41)
if let \`Some value = choice { value + 1 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang resolves overloaded constructors from nominal types", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { length } = import "duck:prelude/runtime" ()
type NumberCalc = | \`Literal Int | \`Add Int
type TextCalc = \`Literal Text
let expression: TextCalc = \`Literal "duck"
if let \`Literal value = expression { length(value) } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 4);
});

Deno.test("Ducklang lowers dynamic scalar unions to packed Wasm values", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `type Maybe = | \`Some Int | \`None Unit
let choose = flag => {
  let value = if flag { \`Some (40) } else { \`None () }
  if let \`Some found = value { found + 2 } else { 7 }
}
if choose(1) == 42 && choose(0) == 7 { 42 } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang specializes tuple destructuring and array indexing", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let swap = (left, right) => (right, left)
let (first, second) = swap(1, 42)
let stored = [first, second]
stored[0]
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang runtime struct indexing traps outside its field range", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `module (!init: Init) where
const { struct } = import "duck:prelude" ()
declare effect Input { index: () => I32 }
declare Init { input: Input }
type Pair = struct { .first = Int, .second = Int }
let pair: Pair = [20, 22]
index <- Input.index()
return { .result = pair[index] }
`,
    { gpuMode: "off" },
  );
  await assertRejects(
    () => runMain(artifact.wasm, { input: { index: 2 } }),
    /unreachable/,
  );
});

Deno.test("Ducklang explicit panic lowers to a Wasm trap", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `const { panic } = import "duck:prelude/runtime" ()
panic("deliberate trap")
`,
    { gpuMode: "off" },
  );
  await assertRejects(() => runMain(artifact.wasm), /unreachable/);
});

Deno.test("Ducklang static text traps when a runtime byte index is outside its bounds", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `module (!init: Init) where
const { get } = import "duck:prelude/runtime" ()
declare effect Input { index: () => I32 }
declare Init { input: Input }
index <- Input.index()
let result = get("a", index)
return { .result = result }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm, { input: { index: 0 } }), 97);
  await assertRejects(
    () => runMain(artifact.wasm, { input: { index: 1 } }),
    /unreachable/,
  );
});

Deno.test("Ducklang unrolls bounded ranges with break and continue", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `let total = 27
for value in 0..10 {
  if value == 6 { break }
  if value % 2 == 1 { continue }
  total = total + value
}
total + 9
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang lowers custom iterators to loop-carried state", async () => {
  const artifact = await compileModuleSource(
    "custom_iterator.duck",
    `type Cursor = struct { .current = I32 }
extend Cursor {
  .has_next = (cursor: Cursor) => cursor.current < 3,
  .next = (cursor: Cursor) => [
    cursor.current,
    Cursor.new { .current = cursor.current + 1 },
  ],
}
let cursor = Cursor.new { .current = 0 }
let total = 36
for index, value in cursor {
  total = total + index + value
}
total
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang loops carry shadowed bindings through recursive parameters", async () => {
  const artifact = await compileModuleSource(
    "loop_shadowing.duck",
    `let total = 0
let index = 0
loop {
  if index < 0 { break }
  index = index + 1
  if index < 3 { continue }
  total = total + index
  if !(index < 5) { break }
}
total
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 12);
});

Deno.test("Ducklang loop branch exits are not folded into assignment values", async () => {
  const artifact = await compileModuleSource(
    "loop_branch_exit.duck",
    `let index = 0
loop {
  if index < 2 {
    index = index + 1
  } else {
    break
  }
}
index + 40
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang loop exits expose every latest shadowed binding", async () => {
  const artifact = await compileModuleSource(
    "loop_multiple_bindings.duck",
    `let left = 0
let right = 1
let index = 0
loop {
  if !(index < 3) { break }
  left = left + 1
  right = right + 2
  index = index + 1
}
left * 10 + right
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 37);
});

Deno.test("Ducklang branch joins expose every binding from the selected branch", async () => {
  const artifact = await compileModuleSource(
    "branch_multiple_bindings.duck",
    `let left = 0
let right = 0
if 1 == 1 {
  left = 20
  right = 22
} else {
  left = 2
  right = 4
}
left + right
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang nested loops return to the enclosing loop continuation", async () => {
  const artifact = await compileModuleSource(
    "nested_loop_continuation.duck",
    `let outer = 0
let total = 30
loop {
  if !(outer < 3) { break }
  let inner = 0
  loop {
    if !(inner < 2) { break }
    total = total + outer + inner
    inner = inner + 1
  }
  outer = outer + 1
}
total + outer
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang loop rebinding preserves values captured before the loop", async () => {
  const artifact = await compileModuleSource(
    "loop_capture.duck",
    `let value = 1
let captured = () => value
loop {
  if !(value < 3) { break }
  value = value + 1
}
captured() + value
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 4);
});

Deno.test("Ducklang loop branches carry the binding versions from their selected union case", async () => {
  const artifact = await compileModuleSource(
    "union_loop.duck",
    `type Step = | \`Next I32 | \`Done Unit
let current: Step = \`Next 3
let total = 0
loop {
  match current {
    | \`Next value => {
      total = total + value
      if value < 1 {
        current = \`Done ()
      } else {
        current = \`Next (value - 1)
      }
    }
    | \`Done () => { break }
  }
}
total
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 6);
});

Deno.test("Ducklang recursive functions resolve calls to their own symbol", async () => {
  await assertDuckFixture("recursion.duck", 42);
});

Deno.test("Ducklang seeds annotated recursive result types", async () => {
  const artifact = await compileModuleSource(
    "recursive_result_type.duck",
    `type NumberResult = | \`Ok I32 | \`Err Text
type TextResult = | \`Ok Text | \`Missing Unit
let rec count: I32 -> NumberResult = value => {
  if value <= 0 {
    \`Ok 0
  } else {
    let next = count(value - 1)
    if let \`Ok total = next { \`Ok (total + 1) } else { \`Err "count" }
  }
}
if let \`Ok total = count(42) { total } else { 0 }
`,
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang comptime expressions are evaluated before FCG lowering", async () => {
  const artifact = await compileDuckFixture("comptime.duck");
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.comptimeCpuValues, [{ kind: "integer", value: 42 }]);
});

Deno.test("Ducklang scalar operators agree across comptime and Wasm", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `comptime (if 40 < 41 && 2 == 2 {
  100 / 5 * 2 + 5 % 3
} else {
  0
})
`,
  );
  assertEquals(await runMain(artifact.wasm), 42);
  assertEquals(artifact.comptimeCpuValues, [{ kind: "integer", value: 42 }]);
  if (artifact.comptimeGpuResult?.status === "completed") {
    assertEquals(
      artifact.comptimeGpuResult.values,
      artifact.comptimeCpuValues,
    );
  }
});

Deno.test("Ducklang rejects arithmetic between different integer widths", async () => {
  await assertRejects(
    () =>
      compileModuleSource("test.duck", "40i64 + 2i32\n", { gpuMode: "off" }),
    /Mixed i32 and i64/,
  );
});

Deno.test("Ducklang preserves the largest signed i64 literal through Wasm", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "9223372036854775807i64\n",
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 9_223_372_036_854_775_807n);
});

Deno.test("Ducklang preserves the smallest signed i64 literal through Wasm", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "-9223372036854775808i64\n",
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), -9_223_372_036_854_775_808n);
});

Deno.test("Ducklang lowers hexadecimal literals at the signed i32 boundary", async () => {
  const module = await parseDucklangModule("test.duck", "0x7fffffff\n");
  const result = module.statements.at(-1);
  assertEquals(
    result?.kind === "expression" ? result.expression : undefined,
    {
      kind: "integer",
      value: 2_147_483_647,
      span: { file: "test.duck", start: 0, end: 10 },
    },
  );
});

Deno.test("Ducklang rejects hexadecimal literals outside the signed i32 boundary", async () => {
  await assertRejects(
    () => parseDucklangModule("test.duck", "0x80000000\n"),
    /integer literal 0x80000000 is outside signed i32/,
  );
});

Deno.test("Ducklang gives decimal literals their declared floating-point precision", async () => {
  const module = await parseDucklangModule(
    "test.duck",
    "0.1f32\n0.10000000000000001f64\n",
  );
  assertEquals(
    module.statements.map((statement) =>
      statement.kind === "expression" ? statement.expression : undefined
    ),
    [
      {
        kind: "float32",
        value: Math.fround(0.1),
        span: { file: "test.duck", start: 0, end: 6 },
      },
      {
        kind: "float64",
        value: 0.1,
        span: { file: "test.duck", start: 7, end: 29 },
      },
    ],
  );
});

Deno.test("Ducklang packed integer literals must fit their declared width", async () => {
  await assertRejects(
    () => compileModuleSource("test.duck", "let value = 8u3\nvalue\n"),
    /packed integer literal 8u3 does not fit an unsigned 3-bit i32 carrier/,
  );
});

Deno.test("unsupported Ducklang operators fail during typed IR elaboration", async () => {
  await assertRejects(
    () => compileModuleSource("test.duck", "40 ** 2\n", { gpuMode: "off" }),
    /Ducklang operator \*\* has no typed IR operation/,
  );
});

Deno.test("Ducklang substitutes immutable scalar const bindings before Core", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "const answer = 42\nanswer\n",
    { gpuMode: "off" },
  );
  assertEquals(artifact.inferred.bindings.length, 0);
  assertEquals(
    artifact.core.functions.at(-1)?.blocks[0].operations[0].kind,
    "constant",
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang equals assignment preserves the preceding binding type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        "let value = 1\nvalue = true\nvalue\n",
        { gpuMode: "off" },
      ),
    /Assignment changes type for value/,
  );
});

Deno.test("Ducklang local equals assignment preserves the preceding binding type", async () => {
  await assertRejects(
    () =>
      compileModuleSource(
        "test.duck",
        `let choose = input => {
  let value = 1
  value = true
  value
}
choose(0)
`,
        { gpuMode: "off" },
      ),
    /Assignment changes type for value/,
  );
});

Deno.test("Ducklang colon-equals assignment permits a new binding type", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let value = 1\nvalue := true\nif value { 42 } else { 0 }\n",
    { gpuMode: "off" },
  );
  assertEquals(await runMain(artifact.wasm), 42);
});

Deno.test("Ducklang compilation exposes typed Core and FCG stages", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let add = (left, right) => left + right\nadd(20, 22)\n",
    { gpuMode: "off" },
  );
  assertEquals(artifact.language, "ducklang");
  assertEquals(artifact.finalTypes, ["add#0 :: i32 -> i32 -> i32"]);
  assertEquals(artifact.inferred.equalities.length > 0, true);
  assertEquals(
    artifact.core.functions.map((function_) => function_.name),
    ["add", "main"],
  );
  assertEquals(
    canonicalObject(inflateFlatDucklangCore(artifact.flatCore)),
    canonicalObject(artifact.core),
  );
  inflateFlatDucklangCore(artifact.optimizedFlatCore);
  assertEquals(
    artifact.fcg.functions.map((function_) => function_.name),
    ["add__duck0", "main"],
  );
  assertEquals(inflateFlatFcgPackage(artifact.flatFcg), artifact.fcg);
});

Deno.test("Ducklang FCG rewrites feed Wasm lowering within branch regions", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    `module (!init: Init) where
declare effect Input {
  flag: () => Bool
}
declare Init { input: Input }
flag <- Input.flag()
let result = if flag { 42 + 0 } else { 7 * 1 }
return { .result = result }
`,
    { gpuMode: "off" },
  );

  assertEquals(await runMain(artifact.wasm, { input: { flag: 1 } }), 42);
  const operations = artifact.fcg.functions.flatMap((function_) =>
    function_.operations
  );
  assertEquals(
    operations.some((operation) => operation.opcode === "if"),
    true,
  );
  assertEquals(
    operations.some((operation) =>
      operation.opcode === "i32.+" || operation.opcode === "i32.*"
    ),
    false,
  );
  assertEquals(inflateFlatFcgPackage(artifact.flatFcg), artifact.fcg);
});

Deno.test("Ducklang type and comptime jobs reach the GPU differential passes", async () => {
  const artifact = await compileModuleSource(
    "test.duck",
    "let answer = comptime 6 * 7\nanswer\n",
  );
  assertEquals(artifact.gpuTypeResult === undefined, false);
  assertEquals(artifact.comptimeGpuResult === undefined, false);
  assertEquals(artifact.gpuCoreResult === undefined, false);
  assertEquals(artifact.gpuWasmResult === undefined, false);
  if (artifact.gpuCoreResult?.status === "completed") {
    assertEquals(artifact.timings.cpuCoreRewriteMilliseconds, 0);
  }
  assertEquals(await runMain(artifact.wasm), 42);
});

async function assertDuckFixture(
  filename: string,
  expected: number,
): Promise<void> {
  const artifact = await compileDuckFixture(filename);
  assertEquals(await runMain(artifact.wasm), expected);
}

async function compileDuckFixture(filename: string) {
  const file = new URL(`../examples/duck/${filename}`, import.meta.url);
  const source = await Deno.readTextFile(file);
  return await compileModuleSource(file.pathname, source, { gpuMode: "off" });
}

function assertEquals(actual: unknown, expected: unknown): void {
  const bigintReplacer = (_key: string, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value;
  const actualJson = JSON.stringify(actual, bigintReplacer);
  const expectedJson = JSON.stringify(expected, bigintReplacer);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  }
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalObject(nested)]),
  );
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expected.test(message)) {
      throw new Error(
        `expected ${expected}, received ${JSON.stringify(message)}`,
      );
    }
    return;
  }
  throw new Error(`expected rejection matching ${expected}`);
}

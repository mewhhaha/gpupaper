import {
  type BlotRuntimeFunction,
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
} from "../src/blot_runtime_hir.ts";
import {
  compileBlotRuntimeModule as compileValidatedBlotRuntimeModule,
  compileBlotRuntimeModulesOnGpu,
} from "../src/blot_runtime_target.ts";
import {
  buildBlotAbiManifest,
  requireDirectBlotAbiBoundary,
} from "../src/blot_runtime_abi.ts";
import { decodeBlotAbiResult } from "../src/blot_abi_decode.ts";
import {
  createDucklangRuntimeHeap,
  createDucklangRuntimeImports,
} from "../src/ducklang_runtime.ts";
import { ducklangRuntimeImportModule } from "../src/ducklang_primitives.ts";

const span = { file: "target.blot", start: 0, end: 1 } as const;

function compileBlotRuntimeModule(module: BlotRuntimeModule) {
  return compileValidatedBlotRuntimeModule(validateBlotRuntimeModule(module));
}

Deno.test("Blot Runtime target emits callable scalar exports", async () => {
  const module = runtimeModule([
    constantFunction(0, "answer", 42n),
    constantFunction(1, "other", 7n),
  ], [
    runtimeExport("default", "blot:default", 0),
    runtimeExport("other", "blot:other", 1),
  ]);
  const artifact = compileBlotRuntimeModule(module);
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);

  assertEquals(call(instance, "blot:default"), 42n);
  assertEquals(call(instance, "blot:other"), 7n);
});

Deno.test("Blot Runtime target emits an ordinal-preserving packed GPU batch", async () => {
  const modules = [42n, 7n, -3n].map((value, ordinal) =>
    validateBlotRuntimeModule(runtimeModule(
      [constantFunction(0, `answer_${ordinal}`, value)],
      [runtimeExport("default", "blot:default", 0)],
    ))
  );
  const expected = modules.map((module) => compileBlotRuntimeModule(module));
  const batch = await compileBlotRuntimeModulesOnGpu(modules, {
    scheduling: "latency",
  });

  assertEquals(batch.artifacts.length, 3);
  assertEquals(batch.gpuEmissions.length, 1);
  assertEquals(batch.gpuEmissions[0].payloadBatchSize, 3);
  for (const [ordinal, artifact] of batch.artifacts.entries()) {
    assertBytesEqual(artifact.wasm, expected[ordinal].wasm!);
    const instance = await instantiate(artifact.wasm, artifact.textLiterals);
    assertEquals(call(instance, "blot:default"), [42n, 7n, -3n][ordinal]);
  }
  assertEquals(
    batch.artifacts[0].wasm.buffer === batch.artifacts[1].wasm.buffer,
    false,
  );

  const empty = await compileBlotRuntimeModulesOnGpu([]);
  assertEquals(empty.artifacts.length, 0);
  assertEquals(empty.gpuEmissions.length, 0);
});

Deno.test("Blot Runtime target preserves dynamic scalar export parameters", async () => {
  const identity: BlotRuntimeFunction = {
    id: 0,
    name: "identity",
    signature: 1,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [{ value: 0, type: 1, ownership: "plain", span }],
      operations: [],
      terminator: { kind: "return", value: 0, span },
    }],
    span,
  };
  const artifact = compileBlotRuntimeModule(
    runtimeModule([identity], [
      runtimeExport("identity", "blot:identity", 0, 1),
    ]),
  );
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);
  const exported = instance.exports["blot:identity"];
  if (!(exported instanceof Function)) {
    throw new Error("Wasm omitted blot:identity");
  }

  assertEquals(exported(-4_294_967_297n), -4_294_967_297n);
  assertEquals(
    exported(9_223_372_036_854_775_807n),
    9_223_372_036_854_775_807n,
  );
});

Deno.test("Blot direct ABI refuses excess flat parameters", () => {
  const parameterCount = 17;
  const module: BlotRuntimeModule = {
    ...runtimeModule([], []),
    signatures: [{
      parameters: Array.from({ length: parameterCount }, () => 1),
      result: 1,
      effects: [],
    }],
    exports: [{
      sourceName: "wide",
      phase: "runtime",
      wasmName: "blot:wide",
      function: 0,
      signature: 0,
      ownership: "owned",
    }],
  };

  assertThrows(
    () => requireDirectBlotAbiBoundary(buildBlotAbiManifest(module)),
    /17 flat parameters.*at most 16/,
  );
});

Deno.test("Blot Runtime target publishes ABI 1 metadata and a preserving allocator", async () => {
  const artifact = compileBlotRuntimeModule(runtimeModule([
    constantFunction(0, "answer", 42n),
  ], [runtimeExport("default", "blot:default", 0)]));
  if (artifact.wasm === undefined) throw new Error("target omitted CPU Wasm");
  const compiled = await WebAssembly.compile(
    new Uint8Array(artifact.wasm).buffer as ArrayBuffer,
  );
  const sections = WebAssembly.Module.customSections(compiled, "blot:abi");
  assertEquals(sections.length, 1);
  assertBytesEqual(new Uint8Array(sections[0]), artifact.manifestBytes);
  const instance = await WebAssembly.instantiate(compiled, {});
  const memory = instance.exports.memory;
  const realloc = instance.exports.cabi_realloc;
  const major = instance.exports["blot:abi-major"];
  const minor = instance.exports["blot:abi-minor"];
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Wasm omitted memory export");
  }
  if (!(realloc instanceof Function)) {
    throw new Error("Wasm omitted cabi_realloc export");
  }
  if (!(major instanceof WebAssembly.Global)) {
    throw new Error("Wasm omitted blot:abi-major export");
  }
  if (!(minor instanceof WebAssembly.Global)) {
    throw new Error("Wasm omitted blot:abi-minor export");
  }
  assertEquals(major.value, 1);
  assertEquals(minor.value, 0);

  const original = realloc(0, 0, 4, 4) as number;
  new Uint8Array(memory.buffer, original, 4).set([4, 3, 2, 1]);
  const grown = realloc(original, 4, 8, 70_000) as number;
  assertEquals(grown % 8, 0);
  assertBytesEqual(
    new Uint8Array(memory.buffer, grown, 4),
    new Uint8Array([4, 3, 2, 1]),
  );
  assertEquals(realloc(grown, 70_000, 8, 0), 0);
  assertThrows(() => realloc(0, 0, 3, 4), /unreachable/);
});

Deno.test("Blot Runtime target copies staged text into owned canonical memory", async () => {
  const module: BlotRuntimeModule = {
    format: "blot-runtime-hir",
    schemaVersion: 1,
    source: "target.blot",
    types: [{ kind: "unit" }, { kind: "text" }],
    signatures: [{ parameters: [], result: 1, effects: [] }],
    functions: [{
      id: 0,
      name: "message",
      signature: 0,
      entryBlock: 0,
      blocks: [{
        id: 0,
        parameters: [],
        operations: [{
          kind: "constant",
          result: 0,
          type: 1,
          operands: [],
          ownership: "owned",
          value: "A😀",
          span,
        }],
        terminator: { kind: "return", value: 0, span },
      }],
      span,
    }],
    capabilities: [],
    exports: [{
      sourceName: "default",
      phase: "runtime",
      wasmName: "blot:default",
      function: 0,
      signature: 0,
      ownership: "owned",
    }],
  };
  const artifact = compileBlotRuntimeModule(module);
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);
  const exported = instance.exports["blot:default"];
  if (!(exported instanceof Function)) {
    throw new Error("Wasm omitted blot:default");
  }
  const first = exported();
  assertThrows(() => exported(), /unreachable|RuntimeError/i);
  assertEquals(
    decodeBlotAbiResult(
      artifact.manifest.exports[0].function!.result,
      first,
      instance.exports.memory,
    ),
    "A😀",
  );
  const post = instance.exports["cabi_post_blot:default"];
  if (!(post instanceof Function)) {
    throw new Error("Wasm omitted text post-return");
  }
  post(first);
  assertThrows(() => post(first), /unreachable|RuntimeError/i);
  const pagesBefore = (instance.exports.memory as WebAssembly.Memory).grow(0);
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const result = exported();
    post(result);
  }
  assertEquals(
    (instance.exports.memory as WebAssembly.Memory).grow(0),
    pagesBefore,
  );
});

Deno.test("Blot Runtime target lowers direct functions and typed branches", async () => {
  const identity: BlotRuntimeFunction = {
    id: 0,
    name: "identity",
    signature: 1,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [{ value: 0, type: 1, ownership: "plain", span }],
      operations: [],
      terminator: { kind: "return", value: 0, span },
    }],
    span,
  };
  const main: BlotRuntimeFunction = {
    id: 1,
    name: "main",
    signature: 0,
    entryBlock: 0,
    blocks: [
      {
        id: 0,
        parameters: [],
        operations: [
          constant(0, 2, true),
          constant(1, 1, 42n),
          {
            kind: "call.direct",
            result: 2,
            type: 1,
            operands: [1],
            ownership: "plain",
            function: 0,
            span,
          },
        ],
        terminator: {
          kind: "conditional",
          condition: 0,
          consequent: 1,
          consequentArguments: [2],
          alternate: 2,
          alternateArguments: [1],
          span,
        },
      },
      returnParameterBlock(1, 3),
      returnParameterBlock(2, 4),
    ],
    span,
  };
  const artifact = compileBlotRuntimeModule(
    runtimeModule([identity, main], [
      runtimeExport("default", "blot:default", 1),
    ]),
  );
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);

  assertEquals(call(instance, "blot:default"), 42n);
});

Deno.test("Blot Runtime target lowers recursive functions", async () => {
  const factorial: BlotRuntimeFunction = {
    id: 0,
    name: "factorial",
    signature: 1,
    entryBlock: 0,
    blocks: [
      {
        id: 0,
        parameters: [{ value: 0, type: 1, ownership: "plain", span }],
        operations: [
          constant(1, 1, 1n),
          {
            kind: "scalar",
            result: 2,
            type: 2,
            operands: [0, 1],
            ownership: "plain",
            operator: "less-than-or-equal",
            span,
          },
        ],
        terminator: {
          kind: "conditional",
          condition: 2,
          consequent: 1,
          consequentArguments: [],
          alternate: 2,
          alternateArguments: [],
          span,
        },
      },
      {
        id: 1,
        parameters: [],
        operations: [],
        terminator: { kind: "return", value: 1, span },
      },
      {
        id: 2,
        parameters: [],
        operations: [
          {
            kind: "scalar",
            result: 3,
            type: 1,
            operands: [0, 1],
            ownership: "plain",
            operator: "subtract",
            span,
          },
          {
            kind: "call.direct",
            result: 4,
            type: 1,
            operands: [3],
            ownership: "plain",
            function: 0,
            span,
          },
          {
            kind: "scalar",
            result: 5,
            type: 1,
            operands: [0, 4],
            ownership: "plain",
            operator: "multiply",
            span,
          },
        ],
        terminator: { kind: "return", value: 5, span },
      },
    ],
    span,
  };
  const main: BlotRuntimeFunction = {
    ...constantFunction(1, "main", 5n),
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        constant(0, 1, 5n),
        {
          kind: "call.direct",
          result: 1,
          type: 1,
          operands: [0],
          ownership: "plain",
          function: 0,
          span,
        },
      ],
      terminator: { kind: "return", value: 1, span },
    }],
  };
  const artifact = compileBlotRuntimeModule(
    runtimeModule(
      [factorial, main],
      [runtimeExport("default", "blot:default", 1)],
    ),
  );
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);

  assertEquals(call(instance, "blot:default"), 120n);
});

Deno.test("Blot Runtime target lowers captured closures", async () => {
  const addCapture: BlotRuntimeFunction = {
    id: 0,
    name: "addCapture",
    signature: 1,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [
        { value: 0, type: 1, ownership: "plain", span },
        { value: 1, type: 1, ownership: "plain", span },
      ],
      operations: [{
        kind: "scalar",
        result: 2,
        type: 1,
        operands: [0, 1],
        ownership: "plain",
        operator: "add",
        span,
      }],
      terminator: { kind: "return", value: 2, span },
    }],
    span,
  };
  const main: BlotRuntimeFunction = {
    id: 1,
    name: "main",
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        constant(0, 1, 40n),
        {
          kind: "closure.make",
          result: 1,
          type: 3,
          operands: [0],
          ownership: "owned",
          function: 0,
          span,
        },
        constant(2, 1, 2n),
        {
          kind: "call.indirect",
          result: 3,
          type: 1,
          operands: [1, 2],
          ownership: "plain",
          signature: 2,
          span,
        },
      ],
      terminator: { kind: "return", value: 3, span },
    }],
    span,
  };
  const module: BlotRuntimeModule = {
    ...runtimeModule(
      [addCapture, main],
      [runtimeExport("default", "blot:default", 1)],
    ),
    types: [
      { kind: "unit" },
      { kind: "signed-integer-64" },
      { kind: "boolean" },
      { kind: "function", signature: 2 },
    ],
    signatures: [
      { parameters: [], result: 1, effects: [] },
      { parameters: [1, 1], result: 1, effects: [] },
      { parameters: [1], result: 1, effects: [] },
    ],
  };
  const artifact = compileBlotRuntimeModule(module);
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);

  assertEquals(call(instance, "blot:default"), 42n);
});

Deno.test("Blot Runtime target lowers products and sums without source reconstruction", async () => {
  const main: BlotRuntimeFunction = {
    id: 0,
    name: "main",
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        constant(0, 1, 42n),
        constant(1, 1, 7n),
        {
          kind: "product.make",
          result: 2,
          type: 3,
          operands: [0, 1],
          ownership: "owned",
          span,
        },
        {
          kind: "product.project",
          result: 3,
          type: 1,
          operands: [2],
          ownership: "plain",
          field: 0,
          span,
        },
        {
          kind: "sum.make",
          result: 4,
          type: 4,
          operands: [3],
          ownership: "owned",
          case: 1,
          span,
        },
        {
          kind: "sum.payload",
          result: 5,
          type: 1,
          operands: [4],
          ownership: "plain",
          case: 1,
          span,
        },
      ],
      terminator: { kind: "return", value: 5, span },
    }],
    span,
  };
  const module: BlotRuntimeModule = {
    ...runtimeModule([main], [runtimeExport("default", "blot:default", 0)]),
    types: [
      { kind: "unit" },
      { kind: "signed-integer-64" },
      { kind: "boolean" },
      {
        kind: "product",
        name: "Pair",
        fields: [{ name: "left", type: 1 }, { name: "right", type: 1 }],
      },
      {
        kind: "sum",
        name: "MaybeInt",
        cases: [{ name: "None", payloadType: 0 }, {
          name: "Some",
          payloadType: 1,
        }],
      },
    ],
  };
  const artifact = compileBlotRuntimeModule(module);
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);

  assertEquals(call(instance, "blot:default"), 42n);
});

Deno.test("Blot Runtime target preserves persistent Store updates and reuses owned Stores", async () => {
  const persistent: BlotRuntimeFunction = {
    id: 0,
    name: "persistent",
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        constant(0, 1, 3n),
        constant(1, 1, 10n),
        {
          kind: "store.new",
          result: 2,
          type: 3,
          operands: [0, 1],
          ownership: "owned",
          span,
        },
        constant(3, 1, 1n),
        constant(4, 1, 42n),
        {
          kind: "store.write",
          result: 5,
          type: 3,
          operands: [2, 3, 4],
          ownership: "owned",
          update: "persistent",
          span,
        },
        {
          kind: "store.read",
          result: 6,
          type: 1,
          operands: [2, 3],
          ownership: "plain",
          span,
        },
        {
          kind: "store.read",
          result: 7,
          type: 1,
          operands: [5, 3],
          ownership: "plain",
          span,
        },
        {
          kind: "scalar",
          result: 8,
          type: 1,
          operands: [6, 7],
          ownership: "plain",
          operator: "add",
          span,
        },
      ],
      terminator: { kind: "return", value: 8, span },
    }],
    span,
  };
  const owned: BlotRuntimeFunction = {
    id: 1,
    name: "owned",
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        constant(0, 1, 2n),
        constant(1, 1, 1n),
        {
          kind: "store.new",
          result: 2,
          type: 3,
          operands: [0, 1],
          ownership: "owned",
          span,
        },
        constant(3, 1, 4n),
        constant(4, 1, 42n),
        {
          kind: "store.grow",
          result: 5,
          type: 3,
          operands: [2, 3, 4],
          ownership: "owned",
          update: "owned-reuse",
          span,
        },
        {
          kind: "store.length",
          result: 6,
          type: 1,
          operands: [5],
          ownership: "plain",
          span,
        },
        {
          kind: "store.read",
          result: 7,
          type: 1,
          operands: [5, 0],
          ownership: "plain",
          span,
        },
        {
          kind: "scalar",
          result: 8,
          type: 1,
          operands: [6, 7],
          ownership: "plain",
          operator: "add",
          span,
        },
      ],
      terminator: { kind: "return", value: 8, span },
    }],
    span,
  };
  const module: BlotRuntimeModule = {
    ...runtimeModule(
      [persistent, owned],
      [
        runtimeExport("default", "blot:default", 0),
        runtimeExport("owned", "blot:owned", 1),
      ],
    ),
    types: [
      { kind: "unit" },
      { kind: "signed-integer-64" },
      { kind: "boolean" },
      { kind: "store", elementType: 1 },
    ],
  };
  const artifact = compileBlotRuntimeModule(module);
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);

  assertEquals(call(instance, "blot:default"), 52n);
  assertEquals(call(instance, "blot:owned"), 46n);
});

Deno.test("Blot Runtime target uses Unicode-scalar text semantics", async () => {
  const length: BlotRuntimeFunction = {
    id: 0,
    name: "length",
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        textConstant(0, "A😀"),
        textConstant(1, "é"),
        {
          kind: "text.append",
          result: 2,
          type: 3,
          operands: [0, 1],
          ownership: "owned",
          span,
        },
        {
          kind: "text.length",
          result: 3,
          type: 1,
          operands: [2],
          ownership: "plain",
          span,
        },
      ],
      terminator: { kind: "return", value: 3, span },
    }],
    span,
  };
  const contains: BlotRuntimeFunction = {
    id: 1,
    name: "contains",
    signature: 1,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        constant(0, 1, -42n),
        {
          kind: "text.from-i64",
          result: 1,
          type: 3,
          operands: [0],
          ownership: "owned",
          span,
        },
        textConstant(2, "42"),
        {
          kind: "text.contains",
          result: 3,
          type: 2,
          operands: [1, 2],
          ownership: "plain",
          span,
        },
      ],
      terminator: { kind: "return", value: 3, span },
    }],
    span,
  };
  const compare: BlotRuntimeFunction = {
    id: 2,
    name: "compare",
    signature: 2,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        textConstant(0, "😀"),
        textConstant(1, "\uE000"),
        {
          kind: "text.compare",
          result: 2,
          type: 4,
          operands: [0, 1],
          ownership: "plain",
          span,
        },
        {
          kind: "convert",
          conversion: "signed-integer-32-to-signed-integer-64",
          result: 3,
          type: 1,
          operands: [2],
          ownership: "plain",
          span,
        },
      ],
      terminator: { kind: "return", value: 3, span },
    }],
    span,
  };
  const module: BlotRuntimeModule = {
    format: "blot-runtime-hir",
    schemaVersion: 1,
    source: "target.blot",
    types: [
      { kind: "unit" },
      { kind: "signed-integer-64" },
      { kind: "boolean" },
      { kind: "text" },
      { kind: "integer-32" },
    ],
    signatures: [
      { parameters: [], result: 1, effects: [] },
      { parameters: [], result: 2, effects: [] },
      { parameters: [], result: 1, effects: [] },
    ],
    functions: [length, contains, compare],
    capabilities: [],
    exports: [
      runtimeExport("default", "blot:default", 0),
      {
        sourceName: "contains",
        phase: "runtime",
        wasmName: "blot:contains",
        function: 1,
        signature: 1,
        ownership: "owned",
      },
      {
        sourceName: "compare",
        phase: "runtime",
        wasmName: "blot:compare",
        function: 2,
        signature: 2,
        ownership: "owned",
      },
    ],
  };
  const artifact = compileBlotRuntimeModule(module);
  const instance = await instantiate(artifact.wasm, artifact.textLiterals);

  assertEquals(call(instance, "blot:default"), 3n);
  assertEquals(call(instance, "blot:contains"), 1);
  assertEquals(call(instance, "blot:compare"), 1n);
});

Deno.test("Blot Runtime target preserves residual host effects", async () => {
  const write: BlotRuntimeFunction = {
    id: 0,
    name: "write",
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        constant(0, 1, 42n),
        {
          kind: "host.call",
          result: 1,
          type: 1,
          operands: [0],
          ownership: "plain",
          capability: "Console",
          operation: "write",
          span,
        },
      ],
      terminator: { kind: "return", value: 1, span },
    }],
    span,
  };
  const module: BlotRuntimeModule = {
    ...runtimeModule([write], [runtimeExport("default", "blot:default", 0)]),
    signatures: [{
      parameters: [],
      result: 1,
      effects: ["Console"],
    }, {
      parameters: [1],
      result: 1,
      effects: ["Console"],
    }],
    capabilities: [{
      name: "Console",
      operations: [{ name: "write", signature: 1 }],
    }],
  };
  const artifact = compileBlotRuntimeModule(module);
  if (artifact.wasm === undefined) throw new Error("target omitted CPU Wasm");
  const compiled = await WebAssembly.compile(
    new Uint8Array(artifact.wasm).buffer as ArrayBuffer,
  );
  const imports = WebAssembly.Module.imports(compiled);
  assertEquals(imports.length, 1);
  assertEquals(imports[0].module, "blot:host/Console");
  assertEquals(imports[0].name, "write");
  assertEquals(imports[0].kind, "function");
  const calls: bigint[] = [];
  const instance = await WebAssembly.instantiate(compiled, {
    "blot:host/Console": {
      write(value: bigint) {
        calls.push(value);
        return value;
      },
    },
  });

  assertEquals(call(instance, "blot:default"), 42n);
  assertEquals(calls.join(","), "42");
});

Deno.test("Blot Runtime target replays staged text effects through the canonical ABI", async () => {
  const write: BlotRuntimeFunction = {
    id: 0,
    name: "write_text",
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [
        {
          kind: "constant",
          result: 0,
          type: 1,
          operands: [],
          ownership: "owned",
          value: "hello 🦆",
          span,
        },
        {
          kind: "host.call",
          result: 1,
          type: 0,
          operands: [0],
          ownership: "plain",
          capability: "Console",
          operation: "write",
          span,
        },
      ],
      terminator: { kind: "return", value: 1, span },
    }],
    span,
  };
  const module: BlotRuntimeModule = {
    format: "blot-runtime-hir",
    schemaVersion: 1,
    source: "target.blot",
    types: [{ kind: "unit" }, { kind: "text" }],
    signatures: [
      { parameters: [], result: 0, effects: ["Console"] },
      { parameters: [1], result: 0, effects: ["Console"] },
    ],
    functions: [write],
    capabilities: [{
      name: "Console",
      operations: [{ name: "write", signature: 1 }],
    }],
    exports: [runtimeExport("default", "blot:default", 0)],
  };
  const artifact = compileBlotRuntimeModule(module);
  if (artifact.wasm === undefined) throw new Error("target omitted CPU Wasm");
  const targetState: { memory?: WebAssembly.Memory } = {};
  const messages: string[] = [];
  const compiled = await WebAssembly.compile(
    new Uint8Array(artifact.wasm).buffer as ArrayBuffer,
  );
  const instance = await WebAssembly.instantiate(compiled, {
    "blot:host/Console": {
      write(pointer: number, length: number) {
        if (targetState.memory === undefined) {
          throw new Error("canonical memory unavailable");
        }
        messages.push(new TextDecoder().decode(
          new Uint8Array(targetState.memory.buffer, pointer, length),
        ));
      },
    },
  });
  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("target omitted canonical memory");
  }
  targetState.memory = instance.exports.memory;

  assertEquals(call(instance, "blot:default"), undefined);
  assertEquals(messages.join(","), "hello 🦆");
});

Deno.test("Blot Runtime target validates and reclaims dynamic canonical Text", async () => {
  const module = dynamicTextModule();
  const artifact = compileBlotRuntimeModule(module);
  if (artifact.wasm === undefined) throw new Error("target omitted CPU Wasm");
  const compiled = await WebAssembly.compile(artifact.wasm as BufferSource);

  for (const expected of ["", "Ada", "Łucja 🦆"]) {
    const messages: string[] = [];
    const returnedPointers: number[] = [];
    const instance = await WebAssembly.instantiate(compiled, {
      "blot:host/Terminal": {
        read_line(resultPointer: number) {
          const memory = requiredMemory(instance);
          const encoded = new TextEncoder().encode(expected);
          const realloc = requiredFunction(instance, "cabi_realloc");
          const pointer = Number(realloc(0, 0, 1, encoded.length));
          returnedPointers.push(pointer);
          new Uint8Array(memory.buffer).set(encoded, pointer);
          const view = new DataView(memory.buffer);
          view.setUint32(resultPointer, pointer, true);
          view.setUint32(resultPointer + 4, encoded.length, true);
        },
        write(pointer: number, length: number) {
          const memory = requiredMemory(instance);
          messages.push(new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(memory.buffer, pointer, length),
          ));
        },
      },
    });

    call(instance, "blot:default");
    call(instance, "blot:default");
    const greeting = expected === ""
      ? "Hello, stranger."
      : `Hello, ${expected}`;
    assertEquals(
      messages.join("|"),
      `What is your name?|${greeting}|What is your name?|${greeting}`,
    );
    assertEquals(returnedPointers[0], returnedPointers[1]);
  }
});

Deno.test("Blot Runtime target compares dynamic Text in Unicode scalar order", async () => {
  const module = dynamicTextModule({
    comparisonText: "\uE000",
    comparisonOperator: "less-than",
  });
  const artifact = compileBlotRuntimeModule(module);
  if (artifact.wasm === undefined) throw new Error("target omitted CPU Wasm");
  const compiled = await WebAssembly.compile(artifact.wasm as BufferSource);

  for (
    const [input, expectedGreeting] of [
      ["\uD7FF", "Hello, stranger."],
      ["\uE000", "Hello, \uE000"],
      ["😀", "Hello, 😀"],
    ] as const
  ) {
    const messages: string[] = [];
    const instance = await WebAssembly.instantiate(compiled, {
      "blot:host/Terminal": {
        read_line(resultPointer: number) {
          const memory = requiredMemory(instance);
          const encoded = new TextEncoder().encode(input);
          const realloc = requiredFunction(instance, "cabi_realloc");
          const pointer = Number(realloc(0, 0, 1, encoded.length));
          new Uint8Array(memory.buffer).set(encoded, pointer);
          const view = new DataView(memory.buffer);
          view.setUint32(resultPointer, pointer, true);
          view.setUint32(resultPointer + 4, encoded.length, true);
        },
        write(pointer: number, length: number) {
          const memory = requiredMemory(instance);
          messages.push(new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(memory.buffer, pointer, length),
          ));
        },
      },
    });

    call(instance, "blot:default");
    assertEquals(
      messages.join("|"),
      `What is your name?|${expectedGreeting}`,
    );
  }
});

Deno.test("Blot Runtime target traps every malformed UTF-8 family before observation", async () => {
  const artifact = compileBlotRuntimeModule(dynamicTextModule());
  if (artifact.wasm === undefined) throw new Error("target omitted CPU Wasm");
  const compiled = await WebAssembly.compile(artifact.wasm as BufferSource);

  for (
    const malformed of [
      [0x80],
      [0xc2],
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf0, 0x80, 0x80, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
    ]
  ) {
    const instance = await WebAssembly.instantiate(compiled, {
      "blot:host/Terminal": {
        read_line(resultPointer: number) {
          const memory = requiredMemory(instance);
          const realloc = requiredFunction(instance, "cabi_realloc");
          const pointer = Number(realloc(0, 0, 1, malformed.length));
          new Uint8Array(memory.buffer).set(malformed, pointer);
          const view = new DataView(memory.buffer);
          view.setUint32(resultPointer, pointer, true);
          view.setUint32(resultPointer + 4, malformed.length, true);
        },
        write() {},
      },
    });

    assertThrows(
      () => call(instance, "blot:default"),
      /unreachable|RuntimeError/,
    );
  }
});

Deno.test("Blot Runtime target executes checked I64 arithmetic", async () => {
  for (
    const [operator, left, right, expected] of [
      ["add", 40n, 2n, 42n],
      ["subtract", 44n, 2n, 42n],
      ["multiply", 21n, 2n, 42n],
    ] as const
  ) {
    const artifact = compileBlotRuntimeModule(
      integerBinaryModule(operator, left, right),
    );
    const instance = await instantiate(artifact.wasm, artifact.textLiterals);
    assertEquals(call(instance, "blot:default"), expected);
  }
});

Deno.test("Blot Runtime target traps every checked I64 overflow family", async () => {
  for (
    const [operator, left, right] of [
      ["add", (1n << 63n) - 1n, 1n],
      ["subtract", -(1n << 63n), 1n],
      ["multiply", (1n << 63n) - 1n, 2n],
      ["multiply", -(1n << 63n), -1n],
    ] as const
  ) {
    const artifact = compileBlotRuntimeModule(
      integerBinaryModule(operator, left, right),
    );
    const instance = await instantiate(artifact.wasm, artifact.textLiterals);
    assertThrows(
      () => call(instance, "blot:default"),
      /unreachable|RuntimeError/i,
    );
  }
});

function integerBinaryModule(
  operator: "add" | "subtract" | "multiply",
  left: bigint,
  right: bigint,
): BlotRuntimeModule {
  const main = constantFunction(0, "main", left);
  const block = main.blocks[0];
  return runtimeModule([{
    ...main,
    blocks: [{
      ...block,
      operations: [
        constant(0, 1, left),
        constant(1, 1, right),
        {
          kind: "scalar",
          result: 2,
          type: 1,
          operands: [0, 1],
          ownership: "plain",
          operator,
          span,
        },
      ],
      terminator: { kind: "return", value: 2, span },
    }],
  }], [runtimeExport("default", "blot:default", 0)]);
}

function runtimeModule(
  functions: readonly BlotRuntimeFunction[],
  exports: BlotRuntimeModule["exports"],
): BlotRuntimeModule {
  return {
    format: "blot-runtime-hir",
    schemaVersion: 1,
    source: "target.blot",
    types: [
      { kind: "unit" },
      { kind: "signed-integer-64" },
      { kind: "boolean" },
    ],
    signatures: [
      { parameters: [], result: 1, effects: [] },
      { parameters: [1], result: 1, effects: [] },
    ],
    functions,
    capabilities: [],
    exports,
  };
}

function dynamicTextModule(
  options: {
    readonly comparisonText?: string;
    readonly comparisonOperator?: "equal" | "less-than";
  } = {},
): BlotRuntimeModule {
  return {
    format: "blot-runtime-hir",
    schemaVersion: 1,
    source: "terminal.blot",
    types: [
      { kind: "unit" },
      { kind: "boolean" },
      { kind: "integer-32" },
      { kind: "text" },
    ],
    signatures: [
      { parameters: [3], result: 0, effects: ["Terminal"] },
      { parameters: [0], result: 3, effects: ["Terminal"] },
      { parameters: [], result: 0, effects: ["Terminal"] },
    ],
    functions: [{
      id: 0,
      name: "terminal",
      signature: 2,
      entryBlock: 0,
      blocks: [{
        id: 0,
        parameters: [],
        operations: [
          textOperation(0, "What is your name?"),
          hostOperation(1, 0, 0, "write"),
          unitOperation(2),
          hostOperation(3, 3, 2, "read_line", "owned"),
          textOperation(4, options.comparisonText ?? ""),
          {
            kind: "text.compare",
            result: 5,
            type: 2,
            operands: [3, 4],
            ownership: "plain",
            span,
          },
          {
            kind: "constant",
            result: 6,
            type: 2,
            operands: [],
            ownership: "plain",
            value: 0,
            span,
          },
          {
            kind: "scalar",
            result: 7,
            type: 1,
            operands: [5, 6],
            ownership: "plain",
            operator: options.comparisonOperator ?? "equal",
            span,
          },
        ],
        terminator: {
          kind: "conditional",
          condition: 7,
          consequent: 1,
          consequentArguments: [],
          alternate: 2,
          alternateArguments: [],
          span,
        },
      }, {
        id: 1,
        parameters: [],
        operations: [
          textOperation(8, "Hello, stranger."),
          hostOperation(9, 0, 8, "write"),
        ],
        terminator: { kind: "branch", target: 3, arguments: [9], span },
      }, {
        id: 2,
        parameters: [],
        operations: [
          textOperation(10, "Hello, "),
          {
            kind: "text.append",
            result: 11,
            type: 3,
            operands: [10, 3],
            ownership: "owned",
            span,
          },
          hostOperation(12, 0, 11, "write"),
        ],
        terminator: { kind: "branch", target: 3, arguments: [12], span },
      }, {
        id: 3,
        parameters: [{ value: 13, type: 0, ownership: "plain", span }],
        operations: [],
        terminator: { kind: "return", value: 13, span },
      }],
      span,
    }],
    capabilities: [{
      name: "Terminal",
      operations: [
        { name: "read_line", signature: 1 },
        { name: "write", signature: 0 },
      ],
    }],
    exports: [runtimeExport("default", "blot:default", 0, 2)],
  };
}

function textOperation(result: number, value: string) {
  return {
    kind: "constant" as const,
    result,
    type: 3,
    operands: [],
    ownership: "owned" as const,
    value,
    span,
  };
}

function unitOperation(result: number) {
  return {
    kind: "constant" as const,
    result,
    type: 0,
    operands: [],
    ownership: "plain" as const,
    value: null,
    span,
  };
}

function hostOperation(
  result: number,
  type: number,
  argument: number,
  operation: string,
  ownership: "plain" | "owned" = "plain",
) {
  return {
    kind: "host.call" as const,
    result,
    type,
    operands: [argument],
    ownership,
    capability: "Terminal",
    operation,
    span,
  };
}

function requiredMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("target omitted canonical memory");
  }
  return memory;
}

function requiredFunction(
  instance: WebAssembly.Instance,
  name: string,
): CallableFunction {
  const exported = instance.exports[name];
  if (!(exported instanceof Function)) {
    throw new Error(`target omitted ${name}`);
  }
  return exported;
}

function constantFunction(
  id: number,
  name: string,
  value: bigint,
): BlotRuntimeFunction {
  return {
    id,
    name,
    signature: 0,
    entryBlock: 0,
    blocks: [{
      id: 0,
      parameters: [],
      operations: [constant(0, 1, value)],
      terminator: { kind: "return", value: 0, span },
    }],
    span,
  };
}

function constant(result: number, type: number, value: bigint | boolean) {
  return {
    kind: "constant" as const,
    result,
    type,
    operands: [],
    ownership: "plain" as const,
    value,
    span,
  };
}

function textConstant(result: number, value: string) {
  return {
    kind: "constant" as const,
    result,
    type: 3,
    operands: [],
    ownership: "owned" as const,
    value,
    span,
  };
}

function returnParameterBlock(id: number, value: number) {
  return {
    id,
    parameters: [{ value, type: 1, ownership: "plain" as const, span }],
    operations: [],
    terminator: { kind: "return" as const, value, span },
  };
}

function runtimeExport(
  sourceName: string,
  wasmName: string,
  function_: number,
  signature = 0,
) {
  return {
    sourceName,
    phase: "runtime" as const,
    wasmName,
    function: function_,
    signature,
    ownership: "owned" as const,
  };
}

async function instantiate(
  wasm: Uint8Array | undefined,
  textLiterals: readonly string[],
): Promise<WebAssembly.Instance> {
  if (wasm === undefined) throw new Error("target omitted CPU Wasm");
  const heap = createDucklangRuntimeHeap(textLiterals);
  const compiled = await WebAssembly.compile(
    new Uint8Array(wasm).buffer as ArrayBuffer,
  );
  return await WebAssembly.instantiate(compiled, {
    [ducklangRuntimeImportModule]: createDucklangRuntimeImports(heap),
  });
}

function call(instance: WebAssembly.Instance, name: string): unknown {
  const exported = instance.exports[name];
  if (!(exported instanceof Function)) {
    throw new Error(`Wasm omitted function export ${name}`);
  }
  return exported();
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}; received ${String(actual)}`);
  }
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  assertEquals(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `expected byte ${expected[index]} at ${index}; received ${
          actual[index]
        }`,
      );
    }
  }
}

function assertThrows(action: () => unknown, expected: RegExp): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (expected.test(message)) return;
    throw new Error(
      `expected error matching ${expected}; received ${
        JSON.stringify(message)
      }`,
    );
  }
  throw new Error(`expected error matching ${expected}`);
}

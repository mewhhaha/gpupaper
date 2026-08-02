import type {
  RuleCursor,
  TokenCursor,
} from "@mewhhaha/baba/runtime/generated-wasm";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import type {
  CoreBlock,
  CoreBlockId,
  CoreFunction,
  CoreFunctionId,
  CoreModule,
  CoreOperation,
  CoreSignatureId,
  CoreTerminator,
  CoreTypeId,
  CoreValueId,
} from "../../src/core.ts";
import { validateCore } from "../../src/core.ts";
import { lowerCoreToWasm } from "../../src/core_wasm.ts";
import { createRustWasmEmitter } from "../../src/rust_wasm_emitter.ts";
import type { WasmBinaryPlan } from "../../src/wasm.ts";

const parserWasmUrl = new URL(
  "../../grammar/zero-generated/parser.wasm",
  import.meta.url,
);
const parserPlanUrl = new URL(
  "../../grammar/zero-generated/parser.plan",
  import.meta.url,
);
const minimumI32 = -2_147_483_648;
const maximumI32 = 2_147_483_647;
const i32 = 0 as CoreTypeId;

type SourceSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

type ZeroProgram = {
  readonly file: string;
  readonly functions: readonly ZeroFunction[];
};

type ZeroFunction = {
  readonly exported: boolean;
  readonly name: string;
  readonly parameters: readonly ZeroBinding[];
  readonly body: ZeroExpression;
  readonly span: SourceSpan;
};

type ZeroBinding = {
  readonly name: string;
  readonly span: SourceSpan;
};

type ZeroBinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">=";

type ZeroExpression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "variable";
    readonly name: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: ZeroBinaryOperator;
    readonly left: ZeroExpression;
    readonly right: ZeroExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "let";
    readonly binding: ZeroBinding;
    readonly value: ZeroExpression;
    readonly body: ZeroExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: ZeroExpression;
    readonly consequent: ZeroExpression;
    readonly alternate: ZeroExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "call";
    readonly functionName: string;
    readonly arguments: readonly ZeroExpression[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "repeat";
    readonly count: ZeroExpression;
    readonly initial: ZeroExpression;
    readonly binding: ZeroBinding;
    readonly body: ZeroExpression;
    readonly span: SourceSpan;
  };

export type ZeroCompilationTimings = {
  readonly parserInitializationMilliseconds: number;
  readonly parsingMilliseconds: number;
  readonly coreLoweringMilliseconds: number;
  readonly wasmPlanningMilliseconds: number;
  readonly emitterInitializationMilliseconds: number;
  readonly wasmEmissionMilliseconds: number;
  readonly totalMilliseconds: number;
};

export type ZeroCompilation = {
  readonly core: CoreModule;
  readonly wasmPlan: WasmBinaryPlan;
  readonly wasm: Uint8Array;
  readonly timings: ZeroCompilationTimings;
};

type ParsedZeroProgram = {
  readonly program: ZeroProgram;
  readonly parserInitializationMilliseconds: number;
  readonly parsingMilliseconds: number;
};

type ZeroFunctionDescription = {
  readonly id: CoreFunctionId;
  readonly signature: CoreSignatureId;
  readonly arity: number;
};

type BuildingBlock = {
  readonly id: CoreBlockId;
  readonly parameters: readonly {
    readonly value: CoreValueId;
    readonly type: CoreTypeId;
    readonly span: SourceSpan;
  }[];
  readonly operations: CoreOperation[];
  terminator: CoreTerminator | undefined;
};

type LoweredExpression = {
  readonly block: BuildingBlock;
  readonly value: CoreValueId;
};

type CoreOperationWithoutResult = CoreOperation extends infer Operation
  ? Operation extends CoreOperation ? Omit<Operation, "result"> : never
  : never;

type ZeroParser = ReturnType<typeof createParser>;
let parserPromise: Promise<ZeroParser> | undefined;

export async function compileZeroSource(
  file: string,
  source: string,
): Promise<ZeroCompilation> {
  const totalStart = performance.now();
  const parsed = await parseZeroProgram(file, source);

  const coreStart = performance.now();
  const core = lowerZeroProgramToCore(parsed.program);
  validateCore(core);
  const coreLoweringMilliseconds = performance.now() - coreStart;

  const planningStart = performance.now();
  const lowered = lowerCoreToWasm(core, {
    emission: "planOnly",
    target: "wasm-scalar",
    exports: parsed.program.functions.flatMap((function_, index) =>
      function_.exported
        ? [{
          name: function_.name,
          functionId: index as CoreFunctionId,
        }]
        : []
    ),
  });
  const wasmPlanningMilliseconds = performance.now() - planningStart;

  const emitterInitialization = await createRustWasmEmitter();
  const emissionStart = performance.now();
  const emitted = emitterInitialization.emitter.emit(lowered.wasmPlan);
  const wasmEmissionMilliseconds = performance.now() - emissionStart;
  if (!WebAssembly.validate(Uint8Array.from(emitted.bytes))) {
    throw new Error(`${file}: Rust/WebAssembly emitter produced invalid Wasm`);
  }

  return {
    core,
    wasmPlan: lowered.wasmPlan,
    wasm: emitted.bytes,
    timings: {
      parserInitializationMilliseconds: parsed.parserInitializationMilliseconds,
      parsingMilliseconds: parsed.parsingMilliseconds,
      coreLoweringMilliseconds,
      wasmPlanningMilliseconds,
      emitterInitializationMilliseconds:
        emitterInitialization.timings.totalMilliseconds,
      wasmEmissionMilliseconds,
      totalMilliseconds: performance.now() - totalStart,
    },
  };
}

export function lowerZeroProgramToCore(program: ZeroProgram): CoreModule {
  if (program.functions.length === 0) {
    throw new TypeError(`${program.file}: Zero program has no functions`);
  }
  const entryFunction = program.functions.findIndex((function_) =>
    function_.exported
  );
  if (entryFunction < 0) {
    throw new TypeError(
      `${program.file}: Zero program has no exported functions`,
    );
  }
  const descriptions = new Map<string, ZeroFunctionDescription>();
  for (const [index, function_] of program.functions.entries()) {
    if (descriptions.has(function_.name)) {
      throw semanticError(
        function_.span,
        `duplicate function ${function_.name}`,
      );
    }
    descriptions.set(function_.name, {
      id: index as CoreFunctionId,
      signature: index as CoreSignatureId,
      arity: function_.parameters.length,
    });
  }

  const functions = program.functions.map((function_, index) => {
    const description = descriptions.get(function_.name);
    if (description === undefined) {
      throw new Error(`${program.file}: function table lost ${function_.name}`);
    }
    return new ZeroCoreFunctionBuilder(
      function_,
      index as CoreFunctionId,
      description.signature,
      descriptions,
    ).lower();
  });
  return {
    schemaVersion: 1,
    file: program.file,
    types: [{ kind: "scalar", scalar: "i32" }],
    signatures: program.functions.map((function_) => ({
      parameters: function_.parameters.map(() => i32),
      result: i32,
    })),
    functions,
    entryFunction: entryFunction as CoreFunctionId,
  };
}

class ZeroCoreFunctionBuilder {
  readonly #blocks: BuildingBlock[] = [];
  readonly #function: ZeroFunction;
  readonly #id: CoreFunctionId;
  readonly #signature: CoreSignatureId;
  readonly #functions: ReadonlyMap<string, ZeroFunctionDescription>;
  #nextValue = 0;

  constructor(
    function_: ZeroFunction,
    id: CoreFunctionId,
    signature: CoreSignatureId,
    functions: ReadonlyMap<string, ZeroFunctionDescription>,
  ) {
    this.#function = function_;
    this.#id = id;
    this.#signature = signature;
    this.#functions = functions;
  }

  lower(): CoreFunction {
    const parameterNames = new Set<string>();
    const entry = this.#createBlock(
      this.#function.parameters.map((parameter) => {
        if (parameterNames.has(parameter.name)) {
          throw semanticError(
            parameter.span,
            `duplicate parameter ${parameter.name}`,
          );
        }
        parameterNames.add(parameter.name);
        return parameter.span;
      }),
    );
    const environment = new Map(
      this.#function.parameters.map((parameter, index) => [
        parameter.name,
        entry.parameters[index]!.value,
      ]),
    );
    const body = this.#lowerExpression(this.#function.body, entry, environment);
    this.#terminate(body.block, {
      kind: "return",
      values: [body.value],
      span: this.#function.body.span,
    });
    return {
      id: this.#id,
      name: this.#function.name,
      sourceSymbolId: undefined,
      signature: this.#signature,
      entryBlock: entry.id,
      blocks: this.#blocks.map((block): CoreBlock => {
        if (block.terminator === undefined) {
          throw new Error(
            `${this.#function.span.file}: Zero block ${block.id} has no terminator`,
          );
        }
        return {
          id: block.id,
          parameters: block.parameters,
          operations: block.operations,
          terminator: block.terminator,
        };
      }),
      span: this.#function.span,
    };
  }

  #lowerExpression(
    expression: ZeroExpression,
    block: BuildingBlock,
    environment: ReadonlyMap<string, CoreValueId>,
  ): LoweredExpression {
    switch (expression.kind) {
      case "integer":
        return {
          block,
          value: this.#emit(block, {
            kind: "constant",
            type: i32,
            operands: [],
            value: expression.value,
            span: expression.span,
          }),
        };
      case "variable": {
        const value = environment.get(expression.name);
        if (value === undefined) {
          throw semanticError(
            expression.span,
            `unbound variable ${expression.name}`,
          );
        }
        return { block, value };
      }
      case "binary": {
        const left = this.#lowerExpression(expression.left, block, environment);
        const right = this.#lowerExpression(
          expression.right,
          left.block,
          environment,
        );
        return {
          block: right.block,
          value: this.#emit(right.block, {
            kind: "scalar.binary",
            type: i32,
            operands: [left.value, right.value],
            operator: expression.operator,
            span: expression.span,
          }),
        };
      }
      case "let": {
        const value = this.#lowerExpression(
          expression.value,
          block,
          environment,
        );
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(expression.binding.name, value.value);
        return this.#lowerExpression(
          expression.body,
          value.block,
          bodyEnvironment,
        );
      }
      case "call": {
        const target = this.#functions.get(expression.functionName);
        if (target === undefined) {
          throw semanticError(
            expression.span,
            `unknown function ${expression.functionName}`,
          );
        }
        if (expression.arguments.length !== target.arity) {
          throw semanticError(
            expression.span,
            `function ${expression.functionName} expects ${target.arity} arguments; received ${expression.arguments.length}`,
          );
        }
        let currentBlock = block;
        const operands: CoreValueId[] = [];
        for (const argument of expression.arguments) {
          const lowered = this.#lowerExpression(
            argument,
            currentBlock,
            environment,
          );
          currentBlock = lowered.block;
          operands.push(lowered.value);
        }
        return {
          block: currentBlock,
          value: this.#emit(currentBlock, {
            kind: "call.direct",
            type: i32,
            operands,
            functionId: target.id,
            span: expression.span,
          }),
        };
      }
      case "if":
        return this.#lowerConditional(expression, block, environment);
      case "repeat":
        return this.#lowerRepeat(expression, block, environment);
    }
  }

  #lowerConditional(
    expression: Extract<ZeroExpression, { readonly kind: "if" }>,
    block: BuildingBlock,
    environment: ReadonlyMap<string, CoreValueId>,
  ): LoweredExpression {
    const condition = this.#lowerExpression(
      expression.condition,
      block,
      environment,
    );
    const consequentBlock = this.#createBlock([]);
    const alternateBlock = this.#createBlock([]);
    const joinBlock = this.#createBlock([expression.span]);
    this.#terminate(condition.block, {
      kind: "conditional_branch",
      condition: condition.value,
      trueTarget: consequentBlock.id,
      trueArguments: [],
      falseTarget: alternateBlock.id,
      falseArguments: [],
      span: expression.condition.span,
    });

    const consequent = this.#lowerExpression(
      expression.consequent,
      consequentBlock,
      environment,
    );
    this.#terminate(consequent.block, {
      kind: "branch",
      target: joinBlock.id,
      arguments: [consequent.value],
      span: expression.consequent.span,
    });
    const alternate = this.#lowerExpression(
      expression.alternate,
      alternateBlock,
      environment,
    );
    this.#terminate(alternate.block, {
      kind: "branch",
      target: joinBlock.id,
      arguments: [alternate.value],
      span: expression.alternate.span,
    });
    return { block: joinBlock, value: joinBlock.parameters[0]!.value };
  }

  #lowerRepeat(
    expression: Extract<ZeroExpression, { readonly kind: "repeat" }>,
    block: BuildingBlock,
    environment: ReadonlyMap<string, CoreValueId>,
  ): LoweredExpression {
    const count = this.#lowerExpression(expression.count, block, environment);
    const initial = this.#lowerExpression(
      expression.initial,
      count.block,
      environment,
    );
    const header = this.#createBlock([expression.count.span, expression.span]);
    const bodyBlock = this.#createBlock([]);
    const exit = this.#createBlock([expression.span]);
    this.#terminate(initial.block, {
      kind: "branch",
      target: header.id,
      arguments: [count.value, initial.value],
      span: expression.span,
    });

    const [remaining, state] = header.parameters;
    const zero = this.#emit(header, {
      kind: "constant",
      type: i32,
      operands: [],
      value: 0,
      span: expression.count.span,
    });
    const hasNext = this.#emit(header, {
      kind: "scalar.binary",
      type: i32,
      operands: [remaining!.value, zero],
      operator: ">",
      span: expression.count.span,
    });
    this.#terminate(header, {
      kind: "conditional_branch",
      condition: hasNext,
      trueTarget: bodyBlock.id,
      trueArguments: [],
      falseTarget: exit.id,
      falseArguments: [state!.value],
      span: expression.span,
    });

    const bodyEnvironment = new Map(environment);
    bodyEnvironment.set(expression.binding.name, state!.value);
    const body = this.#lowerExpression(
      expression.body,
      bodyBlock,
      bodyEnvironment,
    );
    const one = this.#emit(body.block, {
      kind: "constant",
      type: i32,
      operands: [],
      value: 1,
      span: expression.count.span,
    });
    const nextRemaining = this.#emit(body.block, {
      kind: "scalar.binary",
      type: i32,
      operands: [remaining!.value, one],
      operator: "-",
      span: expression.count.span,
    });
    this.#terminate(body.block, {
      kind: "branch",
      target: header.id,
      arguments: [nextRemaining, body.value],
      span: expression.body.span,
    });
    return { block: exit, value: exit.parameters[0]!.value };
  }

  #createBlock(parameterSpans: readonly SourceSpan[]): BuildingBlock {
    const block: BuildingBlock = {
      id: this.#blocks.length as CoreBlockId,
      parameters: parameterSpans.map((span) => ({
        value: this.#nextValue++ as CoreValueId,
        type: i32,
        span,
      })),
      operations: [],
      terminator: undefined,
    };
    this.#blocks.push(block);
    return block;
  }

  #emit(
    block: BuildingBlock,
    operation: CoreOperationWithoutResult,
  ): CoreValueId {
    if (block.terminator !== undefined) {
      throw new Error(
        `${this.#function.span.file}: cannot emit after block ${block.id} terminator`,
      );
    }
    const result = this.#nextValue++ as CoreValueId;
    block.operations.push({ ...operation, result } as CoreOperation);
    return result;
  }

  #terminate(block: BuildingBlock, terminator: CoreTerminator): void {
    if (block.terminator !== undefined) {
      throw new Error(
        `${this.#function.span.file}: block ${block.id} already has a terminator`,
      );
    }
    block.terminator = terminator;
  }
}

async function parseZeroProgram(
  file: string,
  source: string,
): Promise<ParsedZeroProgram> {
  const parserInitializationStart = performance.now();
  const parser = await getZeroParser();
  const parserInitializationMilliseconds = performance.now() -
    parserInitializationStart;
  const parsingStart = performance.now();
  const parsed = parser.parse(source, { preserveTrivia: false });
  if (!parsed.ok) {
    const diagnostic = parsed.diagnostics[0];
    throw new SyntaxError(
      `${file}:${diagnostic.span.start}: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
  const functions = ruleFieldArray(parsed.cursor, "functions").map((node) =>
    parseZeroFunction(file, node)
  );
  return {
    program: { file, functions },
    parserInitializationMilliseconds,
    parsingMilliseconds: performance.now() - parsingStart,
  };
}

async function getZeroParser(): Promise<ZeroParser> {
  parserPromise ??= Promise.all([
    Deno.readFile(parserWasmUrl),
    Deno.readFile(parserPlanUrl),
  ]).then(([bytes, plan]) => createParser({ bytes, plan }));
  return await parserPromise;
}

function parseZeroFunction(file: string, node: RuleCursor): ZeroFunction {
  const name = requiredToken(node, "name");
  const parameters = optionalRuleField(node, "parameters");
  return {
    exported: optionalRuleField(node, "visibility") !== undefined,
    name: name.text,
    parameters: parameters === undefined ? [] : [
      requiredToken(parameters, "head"),
      ...ruleFieldArray(parameters, "tail").map((tail) =>
        requiredToken(tail, "value")
      ),
    ].map((token) => ({ name: token.text, span: sourceSpan(file, token) })),
    body: parseZeroExpression(file, requiredRuleField(node, "body")),
    span: sourceSpan(file, node),
  };
}

function parseZeroExpression(file: string, node: RuleCursor): ZeroExpression {
  switch (node.name) {
    case "expr":
    case "primary":
      return parseZeroExpression(file, childRule(node));
    case "let_expr": {
      const name = requiredToken(node, "name");
      return {
        kind: "let",
        binding: { name: name.text, span: sourceSpan(file, name) },
        value: parseZeroExpression(file, requiredRuleField(node, "value")),
        body: parseZeroExpression(file, requiredRuleField(node, "body")),
        span: sourceSpan(file, node),
      };
    }
    case "if_expr":
      return {
        kind: "if",
        condition: parseZeroExpression(
          file,
          requiredRuleField(node, "condition"),
        ),
        consequent: parseZeroExpression(
          file,
          requiredRuleField(node, "consequent"),
        ),
        alternate: parseZeroExpression(
          file,
          requiredRuleField(node, "alternate"),
        ),
        span: sourceSpan(file, node),
      };
    case "repeat_expr": {
      const name = requiredToken(node, "name");
      return {
        kind: "repeat",
        count: parseZeroExpression(file, requiredRuleField(node, "count")),
        initial: parseZeroExpression(file, requiredRuleField(node, "initial")),
        binding: { name: name.text, span: sourceSpan(file, name) },
        body: parseZeroExpression(file, requiredRuleField(node, "body")),
        span: sourceSpan(file, node),
      };
    }
    case "comparison":
      return foldBinary(file, node, comparisonOperator);
    case "additive":
      return foldBinary(file, node, additiveOperator);
    case "multiplicative":
      return foldBinary(file, node, multiplicativeOperator);
    case "call": {
      const callee = parseZeroExpression(
        file,
        requiredRuleField(node, "callee"),
      );
      const arguments_ = optionalRuleField(node, "arguments");
      if (arguments_ === undefined) return callee;
      if (callee.kind !== "variable") {
        throw semanticError(callee.span, "call target must be a function name");
      }
      const values = optionalRuleField(arguments_, "values");
      return {
        kind: "call",
        functionName: callee.name,
        arguments: values === undefined ? [] : [
          parseZeroExpression(file, requiredRuleField(values, "head")),
          ...ruleFieldArray(values, "tail").map((tail) =>
            parseZeroExpression(file, requiredRuleField(tail, "value"))
          ),
        ],
        span: sourceSpan(file, node),
      };
    }
    case "integer": {
      const token = requiredToken(node, "value");
      const value = Number(token.text);
      if (
        !Number.isSafeInteger(value) || value < minimumI32 || value > maximumI32
      ) {
        throw semanticError(
          sourceSpan(file, token),
          `integer literal ${token.text} is outside signed i32`,
        );
      }
      return { kind: "integer", value, span: sourceSpan(file, node) };
    }
    case "variable": {
      const name = requiredToken(node, "name");
      return {
        kind: "variable",
        name: name.text,
        span: sourceSpan(file, node),
      };
    }
    case "group":
      return parseZeroExpression(file, requiredRuleField(node, "body"));
    default:
      throw new Error(
        `${file}:${node.span.start}: unsupported Zero syntax ${node.name}`,
      );
  }
}

function foldBinary(
  file: string,
  node: RuleCursor,
  operator: (name: string, span: SourceSpan) => ZeroBinaryOperator,
): ZeroExpression {
  let expression = parseZeroExpression(file, requiredRuleField(node, "left"));
  for (const tail of ruleFieldArray(node, "rest")) {
    const operation = childRule(requiredRuleField(tail, "op"));
    const right = parseZeroExpression(file, requiredRuleField(tail, "right"));
    expression = {
      kind: "binary",
      operator: operator(operation.name, sourceSpan(file, operation)),
      left: expression,
      right,
      span: {
        file,
        start: expression.span.start,
        end: right.span.end,
      },
    };
  }
  return expression;
}

function comparisonOperator(
  name: string,
  span: SourceSpan,
): ZeroBinaryOperator {
  const operators: Readonly<Record<string, ZeroBinaryOperator>> = {
    eq: "==",
    ne: "!=",
    lt: "<",
    le: "<=",
    gt: ">",
    ge: ">=",
  };
  return requiredOperator(operators, name, span);
}

function additiveOperator(name: string, span: SourceSpan): ZeroBinaryOperator {
  return requiredOperator({ plus: "+", minus: "-" }, name, span);
}

function multiplicativeOperator(
  name: string,
  span: SourceSpan,
): ZeroBinaryOperator {
  return requiredOperator(
    { star: "*", slash: "/", remainder: "%" },
    name,
    span,
  );
}

function requiredOperator(
  operators: Readonly<Record<string, ZeroBinaryOperator>>,
  name: string,
  span: SourceSpan,
): ZeroBinaryOperator {
  const operator = operators[name];
  if (operator === undefined) {
    throw semanticError(span, `unknown binary operator ${name}`);
  }
  return operator;
}

function requiredRuleField(node: RuleCursor, name: string): RuleCursor {
  const value = node.field(name);
  if (!isRuleCursor(value)) {
    throw new Error(`expected rule field ${name} on ${node.name}`);
  }
  return value;
}

function optionalRuleField(
  node: RuleCursor,
  name: string,
): RuleCursor | undefined {
  const value = node.field(name);
  if (value === null || value === undefined) return undefined;
  if (!isRuleCursor(value)) {
    throw new Error(`expected optional rule field ${name} on ${node.name}`);
  }
  return value;
}

function ruleFieldArray(node: RuleCursor, name: string): readonly RuleCursor[] {
  return node.fieldArray(name).map((value) => {
    if (!isRuleCursor(value)) {
      throw new Error(`expected rule array field ${name} on ${node.name}`);
    }
    return value;
  });
}

function requiredToken(node: RuleCursor, name: string): TokenCursor {
  const value = node.field(name);
  if (!isTokenCursor(value)) {
    throw new Error(`expected token field ${name} on ${node.name}`);
  }
  return value;
}

function childRule(node: RuleCursor): RuleCursor {
  const child = node.children().find(isRuleCursor);
  if (child === undefined) {
    throw new Error(`expected child rule on ${node.name}`);
  }
  return child;
}

function isRuleCursor(value: unknown): value is RuleCursor {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && "type" in value && value.type === "rule";
}

function isTokenCursor(value: unknown): value is TokenCursor {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && "type" in value && value.type === "token";
}

function sourceSpan(
  file: string,
  cursor: RuleCursor | TokenCursor,
): SourceSpan {
  return { file, start: cursor.span.start, end: cursor.span.end };
}

function semanticError(span: SourceSpan, message: string): TypeError {
  return new TypeError(`${span.file}:${span.start}: ${message}`);
}

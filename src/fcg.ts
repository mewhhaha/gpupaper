import type {
  Expression,
  Module,
  Pattern,
  SourceSpan,
  ValueDeclaration,
} from "./syntax.ts";
import type { InferredModule } from "./types.ts";
import {
  type FlatFcgPackage,
  flattenFcgModule,
  inflateFlatFcgPackage,
} from "./flat_fcg.ts";
import { type FlatFcgRewriteProposal, rewriteFlatFcg } from "./fcg_rewrite.ts";
import {
  emitWasmPlanOnCpu,
  type WasmBinaryPlan,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./wasm.ts";

export type FcgOperation = {
  readonly opcode: string;
  readonly operands: readonly (number | string)[];
  readonly sourceStart: number;
  readonly regionId: number;
};

export type FcgFunction = {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly localCount: number;
  readonly operations: readonly FcgOperation[];
};

export type FcgModule = {
  readonly functions: readonly FcgFunction[];
  readonly constructorTags: ReadonlyMap<string, number>;
};

export type WasmArtifact = {
  readonly fcg: FcgModule;
  readonly flatFcg: FlatFcgPackage;
  readonly wasmPlan: WasmBinaryPlan;
  readonly wasm: Uint8Array;
};

type FunctionShape = {
  readonly typeIndex: number;
  readonly functionIndex: number;
  readonly parameterCount: number;
  readonly declaration: ValueDeclaration;
};
type ConstructorShape = { readonly tag: number; readonly fieldCount: number };
type PrimitiveShape = { readonly operation: "integerEquality" };

export function lowerToFcgAndWasm(inferred: InferredModule): WasmArtifact {
  const builder = new WasmModuleBuilder();
  const valueDeclarations = inferred.declarations.map((typed) =>
    typed.declaration
  );
  const functionShapes = new Map<string, FunctionShape>();
  for (const [functionIndex, declaration] of valueDeclarations.entries()) {
    const typeIndex = builder.addFunctionType(
      new Array(declaration.parameters.length).fill(wasmType.i32),
      [wasmType.i32],
    );
    functionShapes.set(declaration.name.text, {
      typeIndex,
      functionIndex,
      parameterCount: declaration.parameters.length,
      declaration,
    });
  }
  const constructorShapes = collectConstructorShapes(inferred.module);
  const primitiveShapes = collectPrimitiveShapes(inferred.module);
  const analyzedFunctions = valueDeclarations.map((declaration) => {
    const compiler = new FunctionCompiler(
      declaration,
      functionShapes,
      constructorShapes,
      primitiveShapes,
    );
    return compiler.compile();
  });
  const constructorTags = new Map(
    [...constructorShapes].map(([name, shape]) => [name, shape.tag]),
  );
  const analyzedFcg = {
    functions: valueDeclarations.map((declaration, functionIndex) => ({
      name: declaration.name.text,
      parameters: declaration.parameters.map((parameter) => parameter.text),
      localCount: analyzedFunctions[functionIndex].localCount,
      operations: analyzedFunctions[functionIndex].operations,
    })),
    constructorTags,
  };
  const rewrite = rewriteFlatFcg(flattenFcgModule(analyzedFcg));
  const acceptedRewrites = acceptedRewritesByFunction(
    analyzedFcg,
    rewrite.accepted,
  );
  const loweredFunctions: FcgFunction[] = [];
  for (const declaration of valueDeclarations) {
    const shape = functionShapes.get(declaration.name.text)!;
    const functionRewrites = acceptedRewrites.get(shape.functionIndex);
    const compiled = functionRewrites === undefined
      ? analyzedFunctions[shape.functionIndex]
      : new FunctionCompiler(
        declaration,
        functionShapes,
        constructorShapes,
        primitiveShapes,
        functionRewrites,
      ).compile();
    const functionIndex = builder.addFunction(
      shape.typeIndex,
      new Array(compiled.localCount).fill(wasmType.i32),
      compiled.instructions,
    );
    if (functionIndex !== shape.functionIndex) {
      throw new Error(
        `internal error: function index for ${declaration.name.text} changed from ${shape.functionIndex} to ${functionIndex}`,
      );
    }
    loweredFunctions.push({
      name: declaration.name.text,
      parameters: declaration.parameters.map((parameter) => parameter.text),
      localCount: compiled.localCount,
      operations: compiled.operations,
    });
  }

  const mainShape = functionShapes.get("main");
  if (mainShape === undefined) {
    throw new TypeError(
      `${inferred.module.file}: module has no main declaration`,
    );
  }
  if (mainShape.parameterCount !== 0) {
    throw new TypeError(
      `${mainShape.declaration.span.file}:${mainShape.declaration.span.start}: main must have no parameters`,
    );
  }
  builder.exportFunction("main", mainShape.functionIndex);
  const wasmPlan = builder.finishPlan();
  const wasm = emitWasmPlanOnCpu(wasmPlan);
  if (!WebAssembly.validate(new Uint8Array(wasm).buffer as ArrayBuffer)) {
    throw new Error("internal error: emitted WebAssembly did not validate");
  }
  const fcg = { functions: loweredFunctions, constructorTags };
  const rewrittenFcg = inflateFlatFcgPackage(rewrite.package);
  if (
    JSON.stringify(fcg.functions) !== JSON.stringify(rewrittenFcg.functions)
  ) {
    throw new Error(
      "internal error: accepted FCG rewrites did not match Wasm lowering",
    );
  }
  return { fcg, flatFcg: rewrite.package, wasmPlan, wasm };
}

class FunctionCompiler {
  readonly #declaration: ValueDeclaration;
  readonly #functionShapes: ReadonlyMap<string, FunctionShape>;
  readonly #constructors: ReadonlyMap<string, ConstructorShape>;
  readonly #primitives: ReadonlyMap<string, PrimitiveShape>;
  readonly #acceptedRewrites: ReadonlySet<string>;
  readonly #locals = new Map<string, number>();
  readonly #operations: FcgOperation[] = [];
  #currentRegionId = 0;
  #nextRegionId = 1;
  #nextLocal: number;

  constructor(
    declaration: ValueDeclaration,
    functionShapes: ReadonlyMap<string, FunctionShape>,
    constructors: ReadonlyMap<string, ConstructorShape>,
    primitives: ReadonlyMap<string, PrimitiveShape>,
    acceptedRewrites: ReadonlySet<string> = new Set(),
  ) {
    this.#declaration = declaration;
    this.#functionShapes = functionShapes;
    this.#constructors = constructors;
    this.#primitives = primitives;
    this.#acceptedRewrites = acceptedRewrites;
    declaration.parameters.forEach((parameter, index) =>
      this.#locals.set(parameter.text, index)
    );
    this.#nextLocal = declaration.parameters.length;
  }

  compile(): {
    readonly instructions: readonly WasmInstruction[];
    readonly operations: readonly FcgOperation[];
    readonly localCount: number;
  } {
    const instructions = this.#compileExpression(this.#declaration.expression);
    return {
      instructions,
      operations: this.#operations,
      localCount: this.#nextLocal - this.#declaration.parameters.length,
    };
  }

  #compileExpression(expression: Expression): readonly WasmInstruction[] {
    switch (expression.kind) {
      case "integer":
        this.#record("const", [expression.value], expression.span);
        return wasmInstruction.i32Constant(expression.value);
      case "boolean":
        this.#record("const", [expression.value ? 1 : 0], expression.span);
        return wasmInstruction.i32Constant(expression.value ? 1 : 0);
      case "variable": {
        const local = this.#locals.get(expression.name.text);
        if (local !== undefined) {
          this.#record("local.get", [local], expression.span);
          return wasmInstruction.localGet(local);
        }
        const constructor = this.#constructors.get(expression.name.text);
        if (constructor !== undefined && constructor.fieldCount === 0) {
          this.#record("constructor", [constructor.tag], expression.span);
          return wasmInstruction.i32Constant(constructor.tag);
        }
        const shape = this.#functionShapes.get(expression.name.text);
        if (shape !== undefined && shape.parameterCount === 0) {
          return this.#compileDirectCall(shape, [], expression.span);
        }
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: Wasm lowering cannot use ${expression.name.text} as a first-class value`,
        );
      }
      case "binary": {
        const arithmeticRewrite = expression.operator === "+" &&
            expression.right.kind === "integer" &&
            expression.right.value === 0
          ? "addZero"
          : expression.operator === "*" &&
              expression.right.kind === "integer" &&
              expression.right.value === 1
          ? "multiplyOne"
          : undefined;
        if (
          arithmeticRewrite !== undefined &&
          this.#acceptedRewrites.has(
            `${arithmeticRewrite}:${expression.span.start}`,
          )
        ) {
          return this.#compileExpression(expression.left);
        }
        const instruction = expression.operator === "+"
          ? wasmInstruction.i32Add
          : expression.operator === "-"
          ? wasmInstruction.i32Subtract
          : expression.operator === "*"
          ? wasmInstruction.i32Multiply
          : wasmInstruction.i32Equal;
        const left = this.#compileExpression(expression.left);
        const right = this.#compileExpression(expression.right);
        this.#record(`i32.${expression.operator}`, [], expression.span);
        return [...left, ...right, ...instruction];
      }
      case "if": {
        const condition = this.#compileExpression(expression.condition);
        this.#record("if", [], expression.span);
        return [
          ...condition,
          ...wasmInstruction.ifI32,
          ...this.#compileInNewRegion(expression.thenBranch),
          ...wasmInstruction.else,
          ...this.#compileInNewRegion(expression.elseBranch),
          ...wasmInstruction.end,
        ];
      }
      case "let": {
        const value = this.#compileExpression(expression.value);
        const previousLocal = this.#locals.get(expression.name.text);
        const local = this.#allocateLocal(expression.name.text);
        this.#record("local.set", [local], expression.name.span);
        const body = this.#compileExpression(expression.body);
        if (previousLocal === undefined) {
          this.#locals.delete(expression.name.text);
        } else this.#locals.set(expression.name.text, previousLocal);
        return [...value, ...wasmInstruction.localSet(local), ...body];
      }
      case "apply": {
        const application = collectApplication(expression);
        if (application.callee.kind !== "variable") {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: Wasm lowering supports direct calls only`,
          );
        }
        const constructor = this.#constructors.get(
          application.callee.name.text,
        );
        if (constructor !== undefined) {
          return this.#compileConstructor(
            constructor,
            application.arguments,
            expression.span,
          );
        }
        const primitive = this.#primitives.get(application.callee.name.text);
        if (primitive?.operation === "integerEquality") {
          if (application.arguments.length !== 2) {
            throw new TypeError(
              `${expression.span.file}:${expression.span.start}: ${application.callee.name.text} expects 2 arguments; received ${application.arguments.length}`,
            );
          }
          const [left, right] = application.arguments.map((argument) =>
            this.#compileExpression(argument)
          );
          this.#record("i32.==", [], expression.span);
          return [...left, ...right, ...wasmInstruction.i32Equal];
        }
        const shape = this.#functionShapes.get(application.callee.name.text);
        if (shape === undefined) {
          throw new TypeError(
            `${expression.span.file}:${expression.span.start}: unknown direct callee ${application.callee.name.text}`,
          );
        }
        return this.#compileDirectCall(
          shape,
          application.arguments,
          expression.span,
        );
      }
      case "case":
        return this.#compileCase(
          expression.scrutinee,
          expression.alternatives,
          expression.span,
        );
      case "comptime":
        throw new Error(
          `${expression.span.file}:${expression.span.start}: comptime expression reached Wasm lowering without evaluation`,
        );
      case "lambda":
        throw new TypeError(
          `${expression.span.file}:${expression.span.start}: nested lambdas require closure lowering and are outside this proof of concept`,
        );
    }
  }

  #compileDirectCall(
    shape: FunctionShape,
    callArguments: readonly Expression[],
    span: SourceSpan,
  ): readonly WasmInstruction[] {
    if (callArguments.length !== shape.parameterCount) {
      throw new TypeError(
        `${span.file}:${span.start}: ${shape.declaration.name.text} expects ${shape.parameterCount} arguments; received ${callArguments.length}`,
      );
    }
    const compiledArguments = callArguments.flatMap((argument) =>
      this.#compileExpression(argument)
    );
    this.#record("call", [shape.declaration.name.text], span);
    return [...compiledArguments, ...wasmInstruction.call(shape.functionIndex)];
  }

  #compileConstructor(
    constructor: ConstructorShape,
    callArguments: readonly Expression[],
    span: SourceSpan,
  ): readonly WasmInstruction[] {
    if (callArguments.length !== constructor.fieldCount) {
      throw new TypeError(
        `${span.file}:${span.start}: constructor expects ${constructor.fieldCount} fields; received ${callArguments.length}`,
      );
    }
    if (constructor.fieldCount === 0) {
      return wasmInstruction.i32Constant(constructor.tag);
    }
    const field = this.#compileExpression(callArguments[0]);
    const payloadLocal = this.#allocateLocal(`$payload${span.start}`);
    this.#record("constructor.pack", [constructor.tag], span);
    return [
      ...field,
      ...wasmInstruction.localSet(payloadLocal),
      ...wasmInstruction.localGet(payloadLocal),
      ...wasmInstruction.i32Constant(-8_388_608),
      ...wasmInstruction.i32LessThanSigned,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.unreachable,
      ...wasmInstruction.end,
      ...wasmInstruction.localGet(payloadLocal),
      ...wasmInstruction.i32Constant(8_388_607),
      ...wasmInstruction.i32GreaterThanSigned,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.unreachable,
      ...wasmInstruction.end,
      ...wasmInstruction.localGet(payloadLocal),
      ...wasmInstruction.i32Constant(8),
      ...wasmInstruction.i32ShiftLeft,
      ...wasmInstruction.i32Constant(constructor.tag),
      ...wasmInstruction.i32Add,
    ];
  }

  #compileCase(
    scrutinee: Expression,
    alternatives: readonly {
      readonly pattern: Pattern;
      readonly expression: Expression;
    }[],
    span: SourceSpan,
  ): readonly WasmInstruction[] {
    const scrutineeLocal = this.#allocateLocal(`$case${span.start}`);
    const compileAlternatives = (
      index: number,
    ): readonly WasmInstruction[] => {
      const alternative = alternatives[index];
      if (alternative === undefined) return [...wasmInstruction.unreachable];
      if (alternative.pattern.kind === "wildcard") {
        return this.#compileExpression(alternative.expression);
      }
      const condition = alternative.pattern.kind === "integer"
        ? [
          ...wasmInstruction.localGet(scrutineeLocal),
          ...wasmInstruction.i32Constant(alternative.pattern.value),
          ...wasmInstruction.i32Equal,
        ]
        : this.#compileConstructorCondition(
          scrutineeLocal,
          alternative.pattern.name.text,
          alternative.pattern.span,
        );
      const previousBindings = new Map(this.#locals);
      let branchPrefix: WasmInstruction[] = [];
      if (
        alternative.pattern.kind === "constructor" &&
        alternative.pattern.fields.length === 1
      ) {
        const fieldLocal = this.#allocateLocal(
          alternative.pattern.fields[0].text,
        );
        branchPrefix = [
          ...wasmInstruction.localGet(scrutineeLocal),
          ...wasmInstruction.i32Constant(8),
          ...wasmInstruction.i32ShiftRightSigned,
          ...wasmInstruction.localSet(fieldLocal),
        ];
      }
      const branch = [
        ...branchPrefix,
        ...this.#compileInNewRegion(alternative.expression),
      ];
      this.#locals.clear();
      for (const [name, local] of previousBindings) {
        this.#locals.set(name, local);
      }
      return [
        ...condition,
        ...wasmInstruction.ifI32,
        ...branch,
        ...wasmInstruction.else,
        ...compileAlternatives(index + 1),
        ...wasmInstruction.end,
      ];
    };
    this.#record("case", [alternatives.length], span);
    return [
      ...this.#compileExpression(scrutinee),
      ...wasmInstruction.localSet(scrutineeLocal),
      ...compileAlternatives(0),
    ];
  }

  #compileConstructorCondition(
    scrutineeLocal: number,
    name: string,
    span: SourceSpan,
  ): readonly WasmInstruction[] {
    const constructor = this.#constructors.get(name);
    if (constructor === undefined) {
      throw new TypeError(
        `${span.file}:${span.start}: unknown constructor ${name}`,
      );
    }
    return [
      ...wasmInstruction.localGet(scrutineeLocal),
      ...wasmInstruction.i32Constant(255),
      ...wasmInstruction.i32And,
      ...wasmInstruction.i32Constant(constructor.tag),
      ...wasmInstruction.i32Equal,
    ];
  }

  #allocateLocal(name: string): number {
    const local = this.#nextLocal;
    this.#nextLocal += 1;
    this.#locals.set(name, local);
    return local;
  }

  #record(
    opcode: string,
    operands: readonly (number | string)[],
    span: SourceSpan,
  ): void {
    this.#operations.push({
      opcode,
      operands,
      sourceStart: span.start,
      regionId: this.#currentRegionId,
    });
  }

  #compileInNewRegion(
    expression: Expression,
  ): readonly WasmInstruction[] {
    const parentRegionId = this.#currentRegionId;
    this.#currentRegionId = this.#nextRegionId;
    this.#nextRegionId += 1;
    const instructions = this.#compileExpression(expression);
    this.#currentRegionId = parentRegionId;
    return instructions;
  }
}

function acceptedRewritesByFunction(
  snapshot: FcgModule,
  accepted: readonly FlatFcgRewriteProposal[],
): ReadonlyMap<number, ReadonlySet<string>> {
  const acceptedByFunction = new Map<number, Set<string>>();
  const operationStarts: number[] = [];
  let operationStart = 0;
  for (const function_ of snapshot.functions) {
    operationStarts.push(operationStart);
    operationStart += function_.operations.length;
  }
  for (const proposal of accepted) {
    const relativeOperationIndex = proposal.operationStart -
      operationStarts[proposal.functionIndex] + proposal.operationCount - 1;
    const operation = snapshot.functions[proposal.functionIndex].operations[
      relativeOperationIndex
    ];
    const rewrites = acceptedByFunction.get(proposal.functionIndex) ??
      new Set<string>();
    rewrites.add(`${proposal.rule}:${operation.sourceStart}`);
    acceptedByFunction.set(proposal.functionIndex, rewrites);
  }
  return acceptedByFunction;
}

function collectPrimitiveShapes(
  module: Module,
): ReadonlyMap<string, PrimitiveShape> {
  const methodByClass = new Map(
    module.declarations.flatMap((declaration) =>
      declaration.kind === "class"
        ? [[declaration.name.text, declaration.methodName.text] as const]
        : []
    ),
  );
  const primitives = new Map<string, PrimitiveShape>();
  for (const declaration of module.declarations) {
    if (declaration.kind !== "instance") continue;
    const methodName = methodByClass.get(declaration.className.text);
    if (methodName !== undefined) {
      primitives.set(methodName, { operation: declaration.primitive });
    }
  }
  return primitives;
}

function collectConstructorShapes(
  module: Module,
): ReadonlyMap<string, ConstructorShape> {
  const constructors = new Map<string, ConstructorShape>();
  let nextTag = 0;
  for (const declaration of module.declarations) {
    if (declaration.kind !== "datatype") continue;
    for (const constructor of declaration.constructors) {
      if (constructor.fields.length > 1) {
        throw new TypeError(
          `${constructor.span.file}:${constructor.span.start}: packed ADT proof of concept supports at most one field; ${constructor.name.text} declares ${constructor.fields.length}`,
        );
      }
      if (nextTag > 255) {
        throw new TypeError(
          `${constructor.span.file}:${constructor.span.start}: packed ADT representation supports 256 constructor tags; ${constructor.name.text} would require tag ${nextTag}`,
        );
      }
      constructors.set(constructor.name.text, {
        tag: nextTag,
        fieldCount: constructor.fields.length,
      });
      nextTag += 1;
    }
  }
  return constructors;
}

function collectApplication(
  expression: Extract<Expression, { kind: "apply" }>,
): { readonly callee: Expression; readonly arguments: readonly Expression[] } {
  const callArguments: Expression[] = [];
  let callee: Expression = expression;
  while (callee.kind === "apply") {
    callArguments.unshift(callee.argument);
    callee = callee.callee;
  }
  return { callee, arguments: callArguments };
}

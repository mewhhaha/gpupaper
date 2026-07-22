import type { FcgFunction, FcgOperation, WasmArtifact } from "./fcg.ts";
import type { SourceSpan } from "./syntax.ts";
import type { Type } from "./types.ts";
import {
  type DucklangBinaryOperator,
  formatDucklangType,
  type TypedDucklangBinding,
  type TypedDucklangExpression,
  type TypedDucklangModule,
} from "./ducklang_types.ts";
import { wasmInstruction, WasmModuleBuilder, wasmType } from "./wasm.ts";

type DucklangFcgInstruction =
  | {
    readonly kind: "constant";
    readonly value: number | bigint;
    readonly valueType: "i32" | "i64";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "localGet";
    readonly local: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "localSet";
    readonly local: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "call";
    readonly functionIndex: number;
    readonly functionName: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "return";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "drop";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "trap";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: DucklangBinaryOperator;
    readonly valueType: "i32" | "i64";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionPack";
    readonly tag: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionMatch";
    readonly unionLocal: number;
    readonly tag: number;
    readonly payloadLocal: number | undefined;
    readonly resultType: "i32" | "i64";
    readonly consequence: readonly DucklangFcgInstruction[];
    readonly alternative: readonly DucklangFcgInstruction[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly resultType: "i32" | "i64";
    readonly consequence: readonly DucklangFcgInstruction[];
    readonly alternative: readonly DucklangFcgInstruction[];
    readonly span: SourceSpan;
  };

type DucklangFcgFunction = {
  readonly name: string;
  readonly parameterNames: readonly string[];
  readonly localCount: number;
  readonly instructions: readonly DucklangFcgInstruction[];
};

type FunctionShape = {
  readonly index: number;
  readonly name: string;
  readonly parameterCount: number;
  readonly parameterTypes: readonly number[];
  readonly resultType: number;
  readonly binding: TypedDucklangBinding | undefined;
};

type HostFunctionShape = {
  readonly index: number;
  readonly name: string;
};

export function lowerDucklangToFcgAndWasm(
  module: TypedDucklangModule,
): WasmArtifact {
  const builder = new WasmModuleBuilder();
  const shapes = new Map<number, FunctionShape>();
  const orderedShapes: FunctionShape[] = [];
  const unionNames = new Set(
    module.unionTypes.map((declaration) => declaration.name),
  );
  const unionTags = new Map(
    module.unionTypes.flatMap((declaration) =>
      declaration.cases.map((unionCase, tag) => [unionCase.name, tag] as const)
    ),
  );
  const hostFunctions = new Map<string, HostFunctionShape>();
  for (const call of collectHostCalls(module)) {
    const key = hostFunctionKey(call.effectName, call.operationName);
    if (hostFunctions.has(key)) continue;
    const parameterTypes = call.arguments.map((argument) =>
      wasmValueType(module.file, argument.span, argument.type, unionNames)
    );
    const resultType = wasmValueType(
      module.file,
      call.span,
      call.type,
      unionNames,
    );
    const typeIndex = builder.addFunctionType(parameterTypes, [resultType]);
    const moduleName = call.effectName[0].toLowerCase() +
      call.effectName.slice(1);
    const index = builder.addFunctionImport(
      moduleName,
      call.operationName,
      typeIndex,
    );
    hostFunctions.set(key, {
      index,
      name: `${moduleName}.${call.operationName}`,
    });
  }

  for (const binding of module.bindings) {
    const parameterCount = binding.value.kind === "function"
      ? binding.value.parameters.length
      : 0;
    const parameterTypes = binding.value.kind === "function"
      ? binding.value.parameters.map((parameter) => {
        const type = module.symbolTypes.get(parameter.id);
        if (type === undefined) {
          throw new Error(
            `${module.file}:${parameter.span.start}: missing type for Ducklang parameter ${parameter.text}#${parameter.id}`,
          );
        }
        return wasmValueType(module.file, parameter.span, type, unionNames);
      })
      : [];
    const resultType = wasmValueType(
      module.file,
      binding.span,
      binding.value.kind === "function"
        ? binding.value.body.type
        : binding.type,
      unionNames,
    );
    const shape = {
      index: hostFunctions.size + orderedShapes.length,
      name: `${binding.symbol.text}__duck${binding.symbol.id}`,
      parameterCount,
      parameterTypes,
      resultType,
      binding,
    } satisfies FunctionShape;
    shapes.set(binding.symbol.id, shape);
    orderedShapes.push(shape);
  }
  const mainShape = {
    index: hostFunctions.size + orderedShapes.length,
    name: "main",
    parameterCount: 0,
    parameterTypes: [],
    resultType: wasmValueType(
      module.file,
      module.result.span,
      module.resultType,
      unionNames,
    ),
    binding: undefined,
  } satisfies FunctionShape;
  orderedShapes.push(mainShape);

  const typeIndices = orderedShapes.map((shape) =>
    builder.addFunctionType(
      shape.parameterTypes,
      [shape.resultType],
    )
  );
  const loweredFunctions: DucklangFcgFunction[] = [];
  for (const shape of orderedShapes) {
    const expression = shape.binding?.value ?? module.result;
    const parameters = expression.kind === "function"
      ? expression.parameters
      : [];
    const body = expression.kind === "function" ? expression.body : expression;
    const compiler = new DucklangFcgCompiler(
      module.file,
      shapes,
      hostFunctions,
      parameters,
      unionNames,
      unionTags,
    );
    const compiled = compiler.compile(body);
    const functionIndex = builder.addFunction(
      typeIndices[shape.index - hostFunctions.size],
      compiled.localTypes,
      emitInstructions(compiled.instructions),
    );
    if (functionIndex !== shape.index) {
      throw new Error(
        `internal error: Ducklang function ${shape.name} expected index ${shape.index}; received ${functionIndex}`,
      );
    }
    loweredFunctions.push({
      name: shape.name,
      parameterNames: parameters.map((parameter) => parameter.text),
      localCount: compiled.localCount,
      instructions: compiled.instructions,
    });
  }

  builder.exportFunction("main", mainShape.index);
  const wasm = builder.finish();
  if (!WebAssembly.validate(new Uint8Array(wasm).buffer as ArrayBuffer)) {
    throw new Error(
      "internal error: emitted Ducklang WebAssembly did not validate",
    );
  }
  return {
    fcg: {
      functions: loweredFunctions.map(publicFunction),
      constructorTags: new Map(),
    },
    wasm,
  };
}

function collectHostCalls(
  module: TypedDucklangModule,
): readonly Extract<TypedDucklangExpression, { readonly kind: "hostCall" }>[] {
  const calls: Extract<
    TypedDucklangExpression,
    { readonly kind: "hostCall" }
  >[] = [];
  for (const binding of module.bindings) {
    visitHostCalls(binding.value, calls);
  }
  visitHostCalls(module.result, calls);
  return calls;
}

function visitHostCalls(
  expression: TypedDucklangExpression,
  calls: Extract<
    TypedDucklangExpression,
    { readonly kind: "hostCall" }
  >[],
): void {
  if (expression.kind === "hostCall") {
    calls.push(expression);
    for (const argument of expression.arguments) {
      visitHostCalls(argument, calls);
    }
    return;
  }
  switch (expression.kind) {
    case "integer":
    case "integer64":
    case "boolean":
    case "unit":
    case "string":
    case "intrinsic":
    case "reference":
      return;
    case "unionCase":
      visitHostCalls(expression.value, calls);
      return;
    case "product":
      for (const value of expression.values) visitHostCalls(value, calls);
      return;
    case "project":
      visitHostCalls(expression.product, calls);
      return;
    case "recordUpdate":
      visitHostCalls(expression.product, calls);
      for (const field of expression.fields) {
        visitHostCalls(field.value, calls);
      }
      return;
    case "function":
      visitHostCalls(expression.body, calls);
      return;
    case "call":
      visitHostCalls(expression.callee, calls);
      for (const argument of expression.arguments) {
        visitHostCalls(argument, calls);
      }
      return;
    case "index":
      visitHostCalls(expression.collection, calls);
      visitHostCalls(expression.index, calls);
      return;
    case "selectProductElement":
      for (const value of expression.values) visitHostCalls(value, calls);
      visitHostCalls(expression.index, calls);
      return;
    case "indexUpdate":
      visitHostCalls(expression.product, calls);
      visitHostCalls(expression.index, calls);
      visitHostCalls(expression.value, calls);
      return;
    case "textAppend":
    case "binary":
      visitHostCalls(expression.left, calls);
      visitHostCalls(expression.right, calls);
      return;
    case "ownership":
    case "return":
    case "comptime":
      visitHostCalls(expression.expression, calls);
      return;
    case "scratch":
      visitHostCalls(expression.body, calls);
      return;
    case "if":
      visitHostCalls(expression.condition, calls);
      visitHostCalls(expression.consequence, calls);
      visitHostCalls(expression.alternative, calls);
      return;
    case "ifUnion":
      visitHostCalls(expression.value, calls);
      visitHostCalls(expression.consequence, calls);
      visitHostCalls(expression.alternative, calls);
      return;
    case "block":
      for (const step of expression.steps) {
        visitHostCalls(
          step.kind === "binding" ? step.binding.value : step.expression,
          calls,
        );
      }
      visitHostCalls(expression.result, calls);
      return;
  }
}

function hostFunctionKey(effectName: string, operationName: string): string {
  return `${effectName}\u0000${operationName}`;
}

class DucklangFcgCompiler {
  readonly #file: string;
  readonly #shapes: ReadonlyMap<number, FunctionShape>;
  readonly #hostFunctions: ReadonlyMap<string, HostFunctionShape>;
  readonly #unionNames: ReadonlySet<string>;
  readonly #unionTags: ReadonlyMap<string, number>;
  readonly #locals = new Map<number, number>();
  readonly #localTypes: number[] = [];
  #nextLocal: number;

  constructor(
    file: string,
    shapes: ReadonlyMap<number, FunctionShape>,
    hostFunctions: ReadonlyMap<string, HostFunctionShape>,
    parameters: readonly { readonly id: number }[],
    unionNames: ReadonlySet<string>,
    unionTags: ReadonlyMap<string, number>,
  ) {
    this.#file = file;
    this.#shapes = shapes;
    this.#hostFunctions = hostFunctions;
    this.#unionNames = unionNames;
    this.#unionTags = unionTags;
    parameters.forEach((parameter, index) =>
      this.#locals.set(parameter.id, index)
    );
    this.#nextLocal = parameters.length;
  }

  compile(expression: TypedDucklangExpression): {
    readonly instructions: readonly DucklangFcgInstruction[];
    readonly localCount: number;
    readonly localTypes: readonly number[];
  } {
    const parameterCount = this.#nextLocal;
    const instructions = this.#compileExpression(expression);
    return {
      instructions,
      localCount: this.#nextLocal - parameterCount,
      localTypes: this.#localTypes,
    };
  }

  #compileExpression(
    expression: TypedDucklangExpression,
  ): readonly DucklangFcgInstruction[] {
    switch (expression.kind) {
      case "integer":
        return [{
          kind: "constant",
          value: expression.value,
          valueType: "i32",
          span: expression.span,
        }];
      case "integer64":
        return [{
          kind: "constant",
          value: expression.value,
          valueType: "i64",
          span: expression.span,
        }];
      case "boolean":
        return [{
          kind: "constant",
          value: expression.value ? 1 : 0,
          valueType: "i32",
          span: expression.span,
        }];
      case "unit":
        return [{
          kind: "constant",
          value: 0,
          valueType: "i32",
          span: expression.span,
        }];
      case "string":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang text reached FCG without data-layout lowering`,
        );
      case "intrinsic":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang intrinsic ${expression.modulePath}.${expression.exportName} reached FCG without intrinsic lowering`,
        );
      case "hostCall": {
        const shape = this.#hostFunctions.get(
          hostFunctionKey(expression.effectName, expression.operationName),
        );
        if (shape === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang FCG has no host operation ${expression.effectName}.${expression.operationName}`,
          );
        }
        return [
          ...expression.arguments.flatMap((argument) =>
            this.#compileExpression(argument)
          ),
          {
            kind: "call",
            functionIndex: shape.index,
            functionName: shape.name,
            span: expression.span,
          },
        ];
      }
      case "unionCase": {
        const tag = this.#unionTags.get(expression.caseName);
        if (tag === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang union constructor ${expression.caseName} has no layout tag`,
          );
        }
        const payloadType = wasmValueType(
          this.#file,
          expression.value.span,
          expression.value.type,
          this.#unionNames,
        );
        if (payloadType !== wasmType.i32) {
          throw new TypeError(
            `${this.#file}:${expression.value.span.start}: packed Ducklang union ${expression.caseName} requires an i32 payload`,
          );
        }
        return [
          ...this.#compileExpression(expression.value),
          { kind: "unionPack", tag, span: expression.span },
        ];
      }
      case "product":
      case "project":
      case "recordUpdate":
      case "indexUpdate":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang ${expression.kind} reached FCG without aggregate layout lowering`,
        );
      case "reference": {
        const local = this.#locals.get(expression.symbol.id);
        if (local !== undefined) {
          return [{ kind: "localGet", local, span: expression.span }];
        }
        const shape = this.#shapes.get(expression.symbol.id);
        if (shape === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang FCG has no definition for ${expression.symbol.text}#${expression.symbol.id}`,
          );
        }
        if (shape.parameterCount !== 0) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: first-class Ducklang function ${expression.symbol.text} requires closure conversion`,
          );
        }
        return [{
          kind: "call",
          functionIndex: shape.index,
          functionName: shape.name,
          span: expression.span,
        }];
      }
      case "function":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: nested Ducklang function requires closure conversion`,
        );
      case "call": {
        if (expression.callee.kind !== "reference") {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang FCG supports direct calls only`,
          );
        }
        const shape = this.#shapes.get(expression.callee.symbol.id);
        if (shape === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: unknown Ducklang callee ${expression.callee.symbol.text}#${expression.callee.symbol.id}`,
          );
        }
        if (shape.parameterCount !== expression.arguments.length) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: ${expression.callee.symbol.text} expects ${shape.parameterCount} arguments; received ${expression.arguments.length}`,
          );
        }
        return [
          ...expression.arguments.flatMap((argument) =>
            this.#compileExpression(argument)
          ),
          {
            kind: "call",
            functionIndex: shape.index,
            functionName: shape.name,
            span: expression.span,
          },
        ];
      }
      case "index":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang index reached FCG without collection lowering`,
        );
      case "selectProductElement": {
        const indexLocal = this.#allocateLocal(wasmType.i32);
        const resultType = wasmValueType(
            this.#file,
            expression.span,
            expression.type,
            this.#unionNames,
          ) === wasmType.i64
          ? "i64"
          : "i32";
        const compileSelection = (
          fieldIndex: number,
        ): readonly DucklangFcgInstruction[] => {
          const value = expression.values[fieldIndex];
          if (value === undefined) {
            return [{ kind: "trap", span: expression.span }];
          }
          return [
            { kind: "localGet", local: indexLocal, span: expression.span },
            {
              kind: "constant",
              value: fieldIndex,
              valueType: "i32",
              span: expression.span,
            },
            {
              kind: "binary",
              operator: "==",
              valueType: "i32",
              span: expression.span,
            },
            {
              kind: "if",
              resultType,
              consequence: this.#compileExpression(value),
              alternative: compileSelection(fieldIndex + 1),
              span: expression.span,
            },
          ];
        };
        return [
          ...this.#compileExpression(expression.index),
          { kind: "localSet", local: indexLocal, span: expression.span },
          ...compileSelection(0),
        ];
      }
      case "textAppend":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang text append reached FCG without data-layout lowering`,
        );
      case "binary":
        return [
          ...this.#compileExpression(expression.left),
          ...this.#compileExpression(expression.right),
          {
            kind: "binary",
            operator: expression.operator,
            valueType: isI64(expression.left.type) ? "i64" : "i32",
            span: expression.span,
          },
        ];
      case "ownership":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang ${expression.operation} reached FCG without ownership lowering`,
        );
      case "return":
        return [
          ...this.#compileExpression(expression.expression),
          { kind: "return", span: expression.span },
        ];
      case "if":
        return [
          ...this.#compileExpression(expression.condition),
          {
            kind: "if",
            resultType: wasmValueType(
                this.#file,
                expression.span,
                expression.type,
                this.#unionNames,
              ) === wasmType.i64
              ? "i64"
              : "i32",
            consequence: this.#compileExpression(expression.consequence),
            alternative: this.#compileExpression(expression.alternative),
            span: expression.span,
          },
        ];
      case "ifUnion": {
        const tag = this.#unionTags.get(expression.caseName);
        if (tag === undefined) {
          throw new TypeError(
            `${this.#file}:${expression.span.start}: Ducklang union pattern ${expression.caseName} has no layout tag`,
          );
        }
        const unionLocal = this.#allocateLocal(wasmType.i64);
        const payloadLocal = expression.payloadSymbol === undefined
          ? undefined
          : this.#allocateLocal(wasmType.i32);
        if (
          payloadLocal !== undefined && expression.payloadSymbol !== undefined
        ) {
          this.#locals.set(expression.payloadSymbol.id, payloadLocal);
        }
        const consequence = this.#compileExpression(expression.consequence);
        if (expression.payloadSymbol !== undefined) {
          this.#locals.delete(expression.payloadSymbol.id);
        }
        return [
          ...this.#compileExpression(expression.value),
          { kind: "localSet", local: unionLocal, span: expression.value.span },
          {
            kind: "unionMatch",
            unionLocal,
            tag,
            payloadLocal,
            resultType: wasmValueType(
                this.#file,
                expression.span,
                expression.type,
                this.#unionNames,
              ) === wasmType.i64
              ? "i64"
              : "i32",
            consequence,
            alternative: this.#compileExpression(expression.alternative),
            span: expression.span,
          },
        ];
      }
      case "block": {
        const previousLocals = new Map(this.#locals);
        const instructions: DucklangFcgInstruction[] = [];
        for (const step of expression.steps) {
          if (step.kind === "expression") {
            instructions.push(...this.#compileExpression(step.expression));
            instructions.push({ kind: "drop", span: step.expression.span });
            continue;
          }
          const binding = step.binding;
          if (binding.value.kind === "function") {
            throw new TypeError(
              `${this.#file}:${binding.span.start}: local Ducklang function ${binding.symbol.text} requires closure conversion`,
            );
          }
          instructions.push(...this.#compileExpression(binding.value));
          const local = this.#allocateLocal(
            wasmValueType(
              this.#file,
              binding.span,
              binding.type,
              this.#unionNames,
            ),
          );
          this.#locals.set(binding.symbol.id, local);
          instructions.push({ kind: "localSet", local, span: binding.span });
        }
        instructions.push(...this.#compileExpression(expression.result));
        this.#locals.clear();
        for (const [symbol, local] of previousLocals) {
          this.#locals.set(symbol, local);
        }
        return instructions;
      }
      case "comptime":
        throw new Error(
          `${this.#file}:${expression.span.start}: Ducklang comptime reached FCG without evaluation`,
        );
      case "scratch":
        throw new Error(
          `${this.#file}:${expression.span.start}: Ducklang scratch region reached FCG without region lowering`,
        );
    }
  }

  #allocateLocal(type: number): number {
    const local = this.#nextLocal;
    this.#nextLocal += 1;
    this.#localTypes.push(type);
    return local;
  }
}

function emitInstructions(
  instructions: readonly DucklangFcgInstruction[],
): readonly number[] {
  return instructions.flatMap((instruction): readonly number[] => {
    switch (instruction.kind) {
      case "constant":
        return instruction.valueType === "i64"
          ? wasmInstruction.i64Constant(instruction.value as bigint)
          : wasmInstruction.i32Constant(instruction.value as number);
      case "localGet":
        return wasmInstruction.localGet(instruction.local);
      case "localSet":
        return wasmInstruction.localSet(instruction.local);
      case "call":
        return wasmInstruction.call(instruction.functionIndex);
      case "return":
        return wasmInstruction.return;
      case "drop":
        return wasmInstruction.drop;
      case "trap":
        return wasmInstruction.unreachable;
      case "binary":
        if (instruction.valueType === "i64") {
          return {
            "+": wasmInstruction.i64Add,
            "-": wasmInstruction.i64Subtract,
            "*": wasmInstruction.i64Multiply,
            "/": wasmInstruction.i64DivideSigned,
            "%": wasmInstruction.i64RemainderSigned,
            "==": wasmInstruction.i64Equal,
            "<": wasmInstruction.i64LessThanSigned,
            ">": wasmInstruction.i64GreaterThanSigned,
            "&&": wasmInstruction.i32And,
          }[instruction.operator];
        }
        return {
          "+": wasmInstruction.i32Add,
          "-": wasmInstruction.i32Subtract,
          "*": wasmInstruction.i32Multiply,
          "/": wasmInstruction.i32DivideSigned,
          "%": wasmInstruction.i32RemainderSigned,
          "==": wasmInstruction.i32Equal,
          "<": wasmInstruction.i32LessThanSigned,
          ">": wasmInstruction.i32GreaterThanSigned,
          "&&": wasmInstruction.i32And,
        }[instruction.operator];
      case "unionPack":
        return [
          ...wasmInstruction.i64ExtendI32Unsigned,
          ...wasmInstruction.i64Constant(BigInt(instruction.tag) << 32n),
          ...wasmInstruction.i64Or,
        ];
      case "unionMatch":
        return [
          ...wasmInstruction.localGet(instruction.unionLocal),
          ...wasmInstruction.i64Constant(32n),
          ...wasmInstruction.i64ShiftRightUnsigned,
          ...wasmInstruction.i32WrapI64,
          ...wasmInstruction.i32Constant(instruction.tag),
          ...wasmInstruction.i32Equal,
          ...(instruction.resultType === "i64"
            ? wasmInstruction.ifI64
            : wasmInstruction.ifI32),
          ...(instruction.payloadLocal === undefined ? [] : [
            ...wasmInstruction.localGet(instruction.unionLocal),
            ...wasmInstruction.i32WrapI64,
            ...wasmInstruction.localSet(instruction.payloadLocal),
          ]),
          ...emitInstructions(instruction.consequence),
          ...wasmInstruction.else,
          ...emitInstructions(instruction.alternative),
          ...wasmInstruction.end,
        ];
      case "if":
        return [
          ...(instruction.resultType === "i64"
            ? wasmInstruction.ifI64
            : wasmInstruction.ifI32),
          ...emitInstructions(instruction.consequence),
          ...wasmInstruction.else,
          ...emitInstructions(instruction.alternative),
          ...wasmInstruction.end,
        ];
    }
  });
}

function publicFunction(function_: DucklangFcgFunction): FcgFunction {
  return {
    name: function_.name,
    parameters: function_.parameterNames,
    localCount: function_.localCount,
    operations: publicOperations(function_.instructions),
  };
}

function publicOperations(
  instructions: readonly DucklangFcgInstruction[],
): readonly FcgOperation[] {
  return instructions.flatMap((instruction): readonly FcgOperation[] => {
    const sourceStart = instruction.span.start;
    switch (instruction.kind) {
      case "constant":
        return [{
          opcode: instruction.valueType === "i64" ? "i64.const" : "const",
          operands: [
            typeof instruction.value === "bigint"
              ? instruction.value.toString()
              : instruction.value,
          ],
          sourceStart,
        }];
      case "localGet":
        return [{
          opcode: "local.get",
          operands: [instruction.local],
          sourceStart,
        }];
      case "localSet":
        return [{
          opcode: "local.set",
          operands: [instruction.local],
          sourceStart,
        }];
      case "call":
        return [{
          opcode: "call",
          operands: [instruction.functionName],
          sourceStart,
        }];
      case "return":
        return [{ opcode: "return", operands: [], sourceStart }];
      case "drop":
        return [{ opcode: "drop", operands: [], sourceStart }];
      case "trap":
        return [{ opcode: "trap", operands: [], sourceStart }];
      case "binary":
        return [{
          opcode: `${instruction.valueType}.${instruction.operator}`,
          operands: [],
          sourceStart,
        }];
      case "unionPack":
        return [{
          opcode: "union.pack",
          operands: [instruction.tag],
          sourceStart,
        }];
      case "unionMatch":
        return [
          {
            opcode: "union.match",
            operands: [instruction.tag],
            sourceStart,
          },
          ...publicOperations(instruction.consequence),
          ...publicOperations(instruction.alternative),
        ];
      case "if":
        return [
          { opcode: "if", operands: [], sourceStart },
          ...publicOperations(instruction.consequence),
          ...publicOperations(instruction.alternative),
        ];
    }
  });
}

function wasmValueType(
  file: string,
  span: SourceSpan,
  type: Type,
  unionNames: ReadonlySet<string>,
): number {
  if (type.kind === "constructor" && type.arguments.length === 0) {
    if (type.name === "i64") return wasmType.i64;
    if (type.name === "i32" || type.name === "bool" || type.name === "unit") {
      return wasmType.i32;
    }
  }
  if (type.kind === "constructor" && unionNames.has(type.name)) {
    return wasmType.i64;
  }
  throw new TypeError(
    `${file}:${span.start}: Ducklang Wasm backend cannot represent ${
      formatDucklangType(type)
    }`,
  );
}

function isI64(type: Type): boolean {
  return type.kind === "constructor" && type.name === "i64" &&
    type.arguments.length === 0;
}

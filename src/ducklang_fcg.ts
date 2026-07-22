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
    readonly kind: "binary";
    readonly operator: DucklangBinaryOperator;
    readonly valueType: "i32" | "i64";
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

export function lowerDucklangToFcgAndWasm(
  module: TypedDucklangModule,
): WasmArtifact {
  const builder = new WasmModuleBuilder();
  const shapes = new Map<number, FunctionShape>();
  const orderedShapes: FunctionShape[] = [];

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
        return wasmValueType(module.file, parameter.span, type);
      })
      : [];
    const resultType = wasmValueType(
      module.file,
      binding.span,
      binding.value.kind === "function"
        ? binding.value.body.type
        : binding.type,
    );
    const shape = {
      index: orderedShapes.length,
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
    index: orderedShapes.length,
    name: "main",
    parameterCount: 0,
    parameterTypes: [],
    resultType: wasmValueType(
      module.file,
      module.result.span,
      module.resultType,
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
    const compiler = new DucklangFcgCompiler(module.file, shapes, parameters);
    const compiled = compiler.compile(body);
    const functionIndex = builder.addFunction(
      typeIndices[shape.index],
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

class DucklangFcgCompiler {
  readonly #file: string;
  readonly #shapes: ReadonlyMap<number, FunctionShape>;
  readonly #locals = new Map<number, number>();
  readonly #localTypes: number[] = [];
  #nextLocal: number;

  constructor(
    file: string,
    shapes: ReadonlyMap<number, FunctionShape>,
    parameters: readonly { readonly id: number }[],
  ) {
    this.#file = file;
    this.#shapes = shapes;
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
      case "string":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang text reached FCG without data-layout lowering`,
        );
      case "intrinsic":
        throw new TypeError(
          `${this.#file}:${expression.span.start}: Ducklang intrinsic ${expression.modulePath}.${expression.exportName} reached FCG without intrinsic lowering`,
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
            resultType: isI64(expression.type) ? "i64" : "i32",
            consequence: this.#compileExpression(expression.consequence),
            alternative: this.#compileExpression(expression.alternative),
            span: expression.span,
          },
        ];
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
          const local = this.#nextLocal;
          this.#nextLocal += 1;
          this.#localTypes.push(
            wasmValueType(this.#file, binding.span, binding.type),
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
      case "binary":
        return [{
          opcode: `${instruction.valueType}.${instruction.operator}`,
          operands: [],
          sourceStart,
        }];
      case "if":
        return [
          { opcode: "if", operands: [], sourceStart },
          ...publicOperations(instruction.consequence),
          ...publicOperations(instruction.alternative),
        ];
    }
  });
}

function wasmValueType(file: string, span: SourceSpan, type: Type): number {
  if (type.kind === "constructor" && type.arguments.length === 0) {
    if (type.name === "i64") return wasmType.i64;
    if (type.name === "i32" || type.name === "bool") return wasmType.i32;
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

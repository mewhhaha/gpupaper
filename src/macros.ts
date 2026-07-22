import type {
  Declaration,
  Expression,
  MacroDeclaration,
  MacroInvocation,
  Module,
  Name,
  SourceSpan,
  ValueDeclaration,
} from "./syntax.ts";
import { wasmInstruction, WasmModuleBuilder, wasmType } from "./wasm.ts";

export type MacroExpansionReport = {
  readonly module: Module;
  readonly invocationCount: number;
  readonly generatedCount: number;
  readonly wasmByteCount: number;
};

export async function expandMacros(
  module: Module,
): Promise<MacroExpansionReport> {
  const macros = new Map<string, MacroDeclaration>();
  const declarations: Declaration[] = [];
  let invocationCount = 0;
  let generatedCount = 0;
  let wasmByteCount = 0;
  let nextScope = 1;

  for (const declaration of module.declarations) {
    if (declaration.kind === "macro") {
      const previous = macros.get(declaration.name.text);
      if (previous !== undefined) {
        throw new TypeError(
          `${declaration.span.file}:${declaration.span.start}: duplicate macro ${declaration.name.text}; first declared at ${previous.span.file}:${previous.span.start}`,
        );
      }
      macros.set(declaration.name.text, declaration);
      continue;
    }
    if (declaration.kind !== "macroInvocation") {
      declarations.push(declaration);
      continue;
    }
    invocationCount += 1;
    const macro = macros.get(declaration.name.text);
    if (macro === undefined) {
      throw new TypeError(
        `${declaration.span.file}:${declaration.span.start}: unknown macro ${declaration.name.text}`,
      );
    }
    const numericValue = validateMacroInvocation(macro, declaration);
    const expansionScope = nextScope;
    nextScope += 1;
    const generated: ValueDeclaration[] = [];
    const wasmBytes = compileMacroToWasm(macro);
    wasmByteCount += wasmBytes.length;
    const imports = {
      compiler: {
        emit_identity: (nameArgument: number): number => {
          const name = requireNameArgument(declaration, nameArgument);
          generated.push(
            identityDeclaration(name, declaration.span, expansionScope),
          );
          return generated.length;
        },
        emit_constant: (nameArgument: number, value: number): number => {
          const name = requireNameArgument(declaration, nameArgument);
          generated.push(constantDeclaration(name, value, declaration.span));
          return generated.length;
        },
      },
    };
    const module = await WebAssembly.compile(
      new Uint8Array(wasmBytes).buffer as ArrayBuffer,
    );
    const instance = await WebAssembly.instantiate(module, imports);
    const expand = instance.exports.expand;
    if (!(expand instanceof Function)) {
      throw new Error(
        `macro ${macro.name.text} Wasm module has no expand export`,
      );
    }
    if (macro.operation === "identity") expand(0);
    else expand(0, numericValue);
    if (generated.length !== 1) {
      throw new Error(
        `macro ${macro.name.text} generated ${generated.length} declarations; expected exactly 1`,
      );
    }
    declarations.push(...generated);
    generatedCount += generated.length;
  }
  return {
    module: { ...module, declarations },
    invocationCount,
    generatedCount,
    wasmByteCount,
  };
}

function validateMacroInvocation(
  macro: MacroDeclaration,
  invocation: MacroInvocation,
): number {
  const expectedArgumentCount = macro.operation === "identity" ? 1 : 2;
  if (invocation.arguments.length !== expectedArgumentCount) {
    throw new TypeError(
      `${invocation.span.file}:${invocation.span.start}: macro ${invocation.name.text} expects ${expectedArgumentCount} arguments; received ${invocation.arguments.length}`,
    );
  }
  requireNameArgument(invocation, 0);
  if (macro.operation === "identity") return 0;
  const value = invocation.arguments[1];
  if (typeof value !== "number") {
    throw new TypeError(
      `${invocation.span.file}:${invocation.span.start}: macro ${invocation.name.text} argument 2 must be an integer`,
    );
  }
  return value;
}

function compileMacroToWasm(macro: MacroDeclaration): Uint8Array {
  const builder = new WasmModuleBuilder();
  const parameters = macro.operation === "identity"
    ? [wasmType.i32]
    : [wasmType.i32, wasmType.i32];
  const signature = builder.addFunctionType(parameters, [wasmType.i32]);
  const importName = macro.operation === "identity"
    ? "emit_identity"
    : "emit_constant";
  const importedFunction = builder.addFunctionImport(
    "compiler",
    importName,
    signature,
  );
  const arguments_ = parameters.flatMap((_, index) =>
    wasmInstruction.localGet(index)
  );
  const functionIndex = builder.addFunction(signature, [], [
    ...arguments_,
    ...wasmInstruction.call(importedFunction),
  ]);
  builder.exportFunction("expand", functionIndex);
  return builder.finish();
}

function requireNameArgument(invocation: MacroInvocation, index: number): Name {
  const argument = invocation.arguments[index];
  if (argument === undefined || typeof argument === "number") {
    throw new TypeError(
      `${invocation.span.file}:${invocation.span.start}: macro ${invocation.name.text} argument ${
        index + 1
      } must be a name`,
    );
  }
  return argument;
}

function identityDeclaration(
  name: Name,
  origin: SourceSpan,
  scope: number,
): ValueDeclaration {
  const parameterSpan = { ...origin, start: origin.start, end: origin.start };
  const parameter: Name = {
    text: "x",
    scopes: [0, scope],
    span: parameterSpan,
  };
  const body: Expression = {
    kind: "variable",
    name: parameter,
    span: parameterSpan,
  };
  return {
    kind: "value",
    name: { ...name, scopes: [0] },
    parameters: [parameter],
    expression: body,
    generatedBy: origin,
    span: origin,
  };
}

function constantDeclaration(
  name: Name,
  value: number,
  origin: SourceSpan,
): ValueDeclaration {
  return {
    kind: "value",
    name: { ...name, scopes: [0] },
    parameters: [],
    expression: { kind: "integer", value, span: origin },
    generatedBy: origin,
    span: origin,
  };
}

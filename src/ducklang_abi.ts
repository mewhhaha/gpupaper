import type { DucklangEffectReference } from "./ducklang_ast.ts";
import {
  formatDucklangType,
  type TypedDucklangModule,
} from "./ducklang_types.ts";
import type { Type } from "./types.ts";

export type DucklangAbiValueType =
  | "i32"
  | "i64"
  | "bool"
  | "unit"
  | "text";

export type DucklangAbiEffectOperation = {
  readonly name: string;
  readonly parameters: readonly DucklangAbiValueType[];
  readonly result: DucklangAbiValueType;
};

export type DucklangAbiEffect = {
  readonly name: string;
  readonly operations: readonly DucklangAbiEffectOperation[];
};

export type DucklangAbiEffectReference = {
  readonly effectName: string;
  readonly operationName: string;
};

export type DucklangManagedAbi = {
  readonly version: 1;
  readonly effects: readonly DucklangAbiEffect[];
  readonly init: readonly {
    readonly fieldName: string;
    readonly effectName: string;
  }[];
  readonly requirements: {
    readonly module: readonly DucklangAbiEffectReference[];
    readonly functions: Readonly<
      Record<string, readonly DucklangAbiEffectReference[]>
    >;
  };
  readonly exports: readonly {
    readonly name: string;
    readonly type: DucklangAbiValueType;
  }[];
  readonly textLiterals: readonly string[];
};

export function createDucklangManagedAbi(
  module: TypedDucklangModule,
  textLiterals: readonly string[],
): DucklangManagedAbi {
  if (module.exportNames.length > 1) {
    throw new TypeError(
      `${module.file}: managed Ducklang ABI currently supports at most one scalar export; received ${
        module.exportNames.join(", ")
      }`,
    );
  }
  const functionRequirements: Record<
    string,
    readonly DucklangAbiEffectReference[]
  > = {};
  for (const binding of module.bindings) {
    if (binding.latentEffects.length === 0) continue;
    functionRequirements[binding.symbol.text] = binding.latentEffects.map(
      abiEffectReference,
    );
  }
  return {
    version: 1,
    effects: [...module.effectDeclarations].map(([name, operations]) => ({
      name,
      operations: operations.map((operation) => ({
        name: operation.name,
        parameters: operation.parameterTypes.map((type) =>
          abiTypeReference(type.name, module.file, type.span.start)
        ),
        result: abiTypeReference(
          operation.resultType.name,
          module.file,
          operation.resultType.span.start,
        ),
      })),
    })),
    init: module.initFields.map((field) => ({
      fieldName: field.name,
      effectName: field.effectName,
    })),
    requirements: {
      module: module.requiredEffects.map(abiEffectReference),
      functions: functionRequirements,
    },
    exports: module.exportNames.map((name) => ({
      name,
      type: abiType(module.resultType, module.file, module.result.span.start),
    })),
    textLiterals,
  };
}

function abiEffectReference(
  effect: DucklangEffectReference,
): DucklangAbiEffectReference {
  return {
    effectName: effect.effectName,
    operationName: effect.operationName,
  };
}

function abiTypeReference(
  name: string,
  file: string,
  sourceStart: number,
): DucklangAbiValueType {
  if (name === "Int" || name === "I32" || /^U[1-9][0-9]*$/.test(name)) {
    return "i32";
  }
  if (name === "I64") return "i64";
  if (name === "Bool") return "bool";
  if (name === "Unit") return "unit";
  if (name === "Text") return "text";
  throw new TypeError(
    `${file}:${sourceStart}: managed Ducklang ABI cannot represent ${name}`,
  );
}

function abiType(
  type: Type,
  file: string,
  sourceStart: number,
): DucklangAbiValueType {
  if (type.kind === "constructor" && type.arguments.length === 0) {
    if (type.name === "i32") return "i32";
    if (type.name === "i64") return "i64";
    if (type.name === "bool") return "bool";
    if (type.name === "unit") return "unit";
    if (type.name === "text") return "text";
  }
  throw new TypeError(
    `${file}:${sourceStart}: managed Ducklang ABI cannot export ${
      formatDucklangType(type)
    }`,
  );
}

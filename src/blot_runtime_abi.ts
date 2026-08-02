import type { BlotRuntimeModule } from "./blot_runtime_hir.ts";

export const blotAbiCustomSectionName = "blot:abi";

export type BlotAbiType =
  | { readonly kind: "unit" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "text" }
  | { readonly kind: "array"; readonly element: BlotAbiType }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly type: BlotAbiType;
    }[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly name: string;
      readonly payload?: BlotAbiType;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly inner: BlotAbiType;
  };

export type BlotAbiFunction = {
  readonly parameters: readonly BlotAbiType[];
  readonly result: BlotAbiType;
};

export type BlotAbiManifest = {
  readonly format: "blot-core-wasm";
  readonly abi: {
    readonly major: 1;
    readonly minor: 0;
    readonly memory: "memory32";
    readonly stringEncoding: "utf-8";
    readonly maximumFlatParameters: 16;
    readonly maximumFlatResults: 1;
    readonly memoryExport: "memory";
    readonly reallocExport: "cabi_realloc";
  };
  readonly source: string;
  readonly exports: readonly {
    readonly sourceName: string;
    readonly name: string | null;
    readonly phase: "runtime" | "comptime";
    readonly function: BlotAbiFunction | null;
    readonly postReturn: string | null;
    readonly effects: readonly string[];
    readonly ownership: "owned" | null;
  }[];
  readonly imports: readonly {
    readonly capability: string;
    readonly operation: string;
    readonly module: string;
    readonly name: string;
    readonly function: BlotAbiFunction;
  }[];
};

export function buildBlotAbiManifest(
  module: BlotRuntimeModule,
): BlotAbiManifest {
  const canonical = (type: number) => canonicalType(module, type, new Set());
  return {
    format: "blot-core-wasm",
    abi: {
      major: 1,
      minor: 0,
      memory: "memory32",
      stringEncoding: "utf-8",
      maximumFlatParameters: 16,
      maximumFlatResults: 1,
      memoryExport: "memory",
      reallocExport: "cabi_realloc",
    },
    source: module.source,
    exports: module.exports.map((exported) => {
      if (exported.phase === "comptime") {
        return {
          sourceName: exported.sourceName,
          name: null,
          phase: exported.phase,
          function: null,
          postReturn: null,
          effects: [],
          ownership: null,
        };
      }
      const signature = module.signatures[exported.signature];
      const function_ = {
        parameters: signature.parameters.map(canonical),
        result: canonical(signature.result),
      };
      return {
        sourceName: exported.sourceName,
        name: exported.wasmName,
        phase: exported.phase,
        function: function_,
        postReturn: flattenedAbiType(function_.result).length > 1
          ? `cabi_post_${exported.wasmName}`
          : null,
        effects: [...signature.effects].sort(),
        ownership: exported.ownership,
      };
    }),
    imports: module.capabilities.flatMap((capability) =>
      capability.operations.map((operation) => {
        const signature = module.signatures[operation.signature];
        return {
          capability: capability.name,
          operation: operation.name,
          module: `blot:host/${capability.name}`,
          name: operation.name,
          function: {
            parameters: signature.parameters.map(canonical),
            result: canonical(signature.result),
          },
        };
      })
    ),
  };
}

export function serializeBlotAbiManifest(
  manifest: BlotAbiManifest,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function flattenedAbiType(
  type: BlotAbiType,
): readonly ("i32" | "i64" | "f32" | "f64")[] {
  if (type.kind === "unit") return [];
  if (type.kind === "signed-integer-64") return ["i64"];
  if (type.kind === "float-32") return ["f32"];
  if (type.kind === "float-64") return ["f64"];
  if (type.kind === "boolean") return ["i32"];
  if (type.kind === "text" || type.kind === "array") return ["i32", "i32"];
  if (type.kind === "sealed") return flattenedAbiType(type.inner);
  if (type.kind === "record") {
    return type.fields.flatMap((field) => flattenedAbiType(field.type));
  }
  let payload: ("i32" | "i64" | "f32" | "f64")[] = [];
  for (const case_ of type.cases) {
    const casePayload = case_.payload === undefined
      ? []
      : flattenedAbiType(case_.payload);
    const joined: ("i32" | "i64" | "f32" | "f64")[] = [];
    const length = Math.max(payload.length, casePayload.length);
    for (let index = 0; index < length; index += 1) {
      const left = payload[index];
      const right = casePayload[index];
      if (left === undefined) joined.push(right ?? "i32");
      else if (right === undefined || left === right) joined.push(left);
      else if (
        (left === "i32" || left === "f32") &&
        (right === "i32" || right === "f32")
      ) joined.push("i32");
      else joined.push("i64");
    }
    payload = joined;
  }
  return ["i32", ...payload];
}

export function requireDirectBlotAbiBoundary(
  manifest: BlotAbiManifest,
): void {
  for (const exported of manifest.exports) {
    if (exported.function === null) continue;
    requireDirectParameterCount(
      exported.function,
      manifest.abi.maximumFlatParameters,
      `export ${exported.name}`,
    );
    for (const [parameter, type] of exported.function.parameters.entries()) {
      requireDirectAbiType(
        type,
        `export ${exported.name} parameter ${parameter}`,
      );
    }
    requireDirectAbiType(
      exported.function.result,
      `export ${exported.name} result`,
    );
  }
  for (const imported of manifest.imports) {
    requireDirectParameterCount(
      imported.function,
      manifest.abi.maximumFlatParameters,
      `import ${imported.module}.${imported.name}`,
    );
    for (const [parameter, type] of imported.function.parameters.entries()) {
      requireDirectAbiType(
        type,
        `import ${imported.module}.${imported.name} parameter ${parameter}`,
      );
    }
    requireDirectAbiType(
      imported.function.result,
      `import ${imported.module}.${imported.name} result`,
    );
  }
}

function requireDirectParameterCount(
  function_: BlotAbiFunction,
  maximumFlatParameters: number,
  position: string,
): void {
  const flatParameters = function_.parameters.flatMap(flattenedAbiType).length;
  if (flatParameters <= maximumFlatParameters) return;
  throw new TypeError(
    `${position} has ${flatParameters} flat parameters; gpupaper's exact Blot ABI path currently admits at most ${maximumFlatParameters}`,
  );
}

function canonicalType(
  module: BlotRuntimeModule,
  typeId: number,
  resolving: Set<number>,
): BlotAbiType {
  if (resolving.has(typeId)) {
    throw new TypeError(
      `${module.source}: ABI type ${typeId} has a recursive canonical layout`,
    );
  }
  const type = module.types[typeId];
  if (type.kind === "unit") return { kind: "unit" };
  if (type.kind === "signed-integer-64") {
    return { kind: "signed-integer-64" };
  }
  if (type.kind === "float-32") return { kind: "float-32" };
  if (type.kind === "float-64") return { kind: "float-64" };
  if (type.kind === "boolean") return { kind: "boolean" };
  if (type.kind === "text") return { kind: "text" };
  if (type.kind === "integer-32") {
    throw new TypeError(
      `${module.source}: internal integer-32 type ${typeId} cannot cross the Blot ABI`,
    );
  }
  if (type.kind === "vector" || type.kind === "mask") {
    throw new TypeError(
      `${module.source}: ${type.kind} type ${typeId} cannot cross the Blot ABI`,
    );
  }
  if (type.kind === "function") {
    throw new TypeError(
      `${module.source}: function type ${typeId} cannot cross the Blot ABI`,
    );
  }
  resolving.add(typeId);
  let canonical: BlotAbiType;
  if (type.kind === "store") {
    canonical = {
      kind: "array",
      element: canonicalType(module, type.elementType, resolving),
    };
  } else if (type.kind === "product") {
    canonical = {
      kind: "record",
      fields: [...type.fields].sort(byName).map((field) => ({
        name: field.name,
        type: canonicalType(module, field.type, resolving),
      })),
    };
  } else if (type.kind === "sum") {
    canonical = {
      kind: "variant",
      cases: [...type.cases].sort(byName).map((case_) => {
        const payload = canonicalType(module, case_.payloadType, resolving);
        return payload.kind === "unit"
          ? { name: case_.name }
          : { name: case_.name, payload };
      }),
    };
  } else if (type.kind === "sealed") {
    canonical = {
      kind: "sealed",
      name: type.name,
      inner: canonicalType(module, type.representationType, resolving),
    };
  } else {
    throw new TypeError(
      `${module.source}: type ${typeId} cannot cross the Blot ABI`,
    );
  }
  resolving.delete(typeId);
  return canonical;
}

function requireDirectAbiType(type: BlotAbiType, position: string): void {
  if (
    type.kind === "signed-integer-64" || type.kind === "float-32" ||
    type.kind === "float-64" || type.kind === "boolean"
  ) return;
  throw new TypeError(
    `${position} uses ${type.kind}; gpupaper's exact Blot ABI path currently admits only direct scalar values`,
  );
}

function byName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

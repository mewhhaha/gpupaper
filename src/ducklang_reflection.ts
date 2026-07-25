import type { Type } from "./types.ts";
import type {
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";
import { rewriteChildren } from "./ducklang_closures.ts";

/**
 * Turns `@type_of(value)` into the canonical type value for that value's type.
 *
 * This runs after inference because that is the first point where the answer exists.
 * The parser used to answer both reflection intrinsics itself, which it could only do
 * by inventing a constant: `@type_of(x)` became `x` and `@describe_type` became a
 * hardcoded size of 1, so every type reported the same size and a program could read
 * a wrong answer rather than hit a missing feature.
 *
 * The result is deliberately the same `duck:type/*` intrinsic that a bare type name
 * resolves to, so a reflected type and a written type are the same value afterwards.
 * That is what lets `@describe_type` and the existing type-pattern matching consume
 * either one without knowing which it was given, and it is why this pass produces no
 * representation of its own.
 */
export function reflectDucklangTypes(
  module: TypedDucklangModule,
): TypedDucklangModule {
  const structNames = new Map(
    module.structTypes.map((declaration) => [declaration.name, declaration]),
  );
  const rewrite = (
    expression: TypedDucklangExpression,
  ): TypedDucklangExpression => {
    const mapped = rewriteChildren(expression, rewrite);
    if (
      mapped.kind !== "call" || mapped.callee.kind !== "intrinsic" ||
      mapped.callee.modulePath !== "duck:compiler/reflect" ||
      mapped.callee.exportName !== "type_of" ||
      mapped.arguments.length !== 1
    ) {
      return mapped;
    }
    const descriptor = describeType(mapped.arguments[0].type, structNames);
    if (descriptor === undefined) return mapped;
    return {
      kind: "intrinsic",
      modulePath: descriptor.modulePath,
      exportName: descriptor.exportName,
      // The call already carries the descriptor type from inference, so reusing it
      // keeps the rewrite type-preserving rather than asserting a fresh type.
      type: mapped.type,
      span: mapped.span,
    };
  };
  return {
    ...module,
    bindings: module.bindings.map((binding) => ({
      ...binding,
      value: rewrite(binding.value),
    })),
    result: rewrite(module.result),
  };
}

function describeType(
  type: Type,
  structNames: ReadonlyMap<
    string,
    TypedDucklangModule["structTypes"][number]
  >,
): { readonly modulePath: string; readonly exportName: string } | undefined {
  if (type.kind !== "constructor") return undefined;
  const declaration = structNames.get(type.name);
  if (declaration !== undefined) {
    // Byte-for-byte the payload resolution builds for a bare struct name, so the
    // two are indistinguishable downstream.
    return {
      modulePath: "duck:type/struct",
      exportName: JSON.stringify({
        name: declaration.name,
        fields: declaration.fields.map((field) => ({
          name: field.name,
          type: field.type.name,
        })),
      }),
    };
  }
  const builtin = builtinSourceName(type.name);
  if (builtin === undefined) return undefined;
  return { modulePath: "duck:type/builtin", exportName: builtin };
}

/**
 * Inference names scalars in lower case while a source type name is capitalised, and
 * the reflected payload has to carry the source spelling so that a reflected type and
 * a written one agree.
 */
function builtinSourceName(name: string): string | undefined {
  switch (name) {
    case "i32":
      return "I32";
    case "i64":
      return "I64";
    case "f32":
      return "F32";
    case "f64":
      return "F64";
    case "bool":
      return "Bool";
    case "char":
      return "Char";
    case "text":
      return "Text";
    case "bytes":
      return "Bytes";
    case "unit":
      return "Unit";
    default:
      return undefined;
  }
}

import type { Type } from "./types.ts";
import type {
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";
import { rewriteChildren } from "./ducklang_closures.ts";
import { ducklangReflectedLayout } from "./ducklang_layout.ts";

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
      mapped.kind === "intrinsic" &&
      mapped.modulePath === "duck:type/struct"
    ) {
      return enrichStructIntrinsic(mapped, structNames);
    }
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
    // `name` and `fields[].type` keep exactly the shape resolution builds for a bare
    // struct name, so type-pattern matching keeps comparing the same strings. The
    // added `layout` is what lets a nested or generic field be answered at all: the
    // field's recorded type is a bare name like `Inner`, or a parameter name like
    // `a`, and neither can be laid out without the declaration table and the
    // argument substitution that are available here and nowhere downstream.
    const substitution = new Map(
      declaration.parameters.map((
        parameter,
        index,
      ) => [parameter, type.arguments[index]]),
    );
    return {
      modulePath: "duck:type/struct",
      exportName: JSON.stringify({
        name: declaration.name,
        fields: declaration.fields.map((field) => ({
          name: field.name,
          type: field.type.name,
        })),
        layout: resolveLayout(type, structNames, substitution, new Set()),
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

/**
 * Size and alignment for a type, resolving named struct fields and type parameters.
 *
 * `ducklangReflectedLayout` answers from a payload alone, which is enough for a struct
 * of scalars but not for one whose field is another struct or a type parameter. Those
 * need the declaration table and the argument substitution, so the layout is computed
 * here and travels in the payload rather than being recomputed downstream without the
 * context to do it.
 *
 * `visiting` breaks cycles. A struct that reaches itself has no finite layout, and the
 * Core planner rejects the same shape, so this throws rather than looping.
 */
function resolveLayout(
  type: Type,
  structNames: ReadonlyMap<
    string,
    TypedDucklangModule["structTypes"][number]
  >,
  substitution: ReadonlyMap<string, Type | undefined>,
  visiting: ReadonlySet<string>,
): { readonly size: number; readonly alignment: number } {
  if (type.kind !== "constructor") {
    throw new TypeError("Ducklang reflection needs a concrete type to lay out");
  }
  const substituted = substitution.get(type.name);
  if (substituted !== undefined) {
    return resolveLayout(substituted, structNames, new Map(), visiting);
  }
  const declaration = structNames.get(type.name);
  if (declaration === undefined) {
    return ducklangReflectedLayout({
      kind: "builtin",
      name: builtinSourceName(type.name) ?? type.name,
    });
  }
  if (visiting.has(type.name)) {
    throw new TypeError(
      `Ducklang type ${type.name} is recursive and has no direct layout`,
    );
  }
  const nested = new Set([...visiting, type.name]);
  const inner = new Map(
    declaration.parameters.map((
      parameter,
      index,
    ) => [parameter, type.arguments[index]]),
  );
  const fields = declaration.fields.map((field) =>
    resolveLayout(
      { kind: "constructor", name: field.type.name, arguments: [] },
      structNames,
      inner,
      nested,
    )
  );
  const alignment = Math.max(1, ...fields.map((field) => field.alignment));
  let size = 0;
  for (const field of fields) {
    const remainder = size % field.alignment;
    size = remainder === 0 ? size : size + (field.alignment - remainder);
    size += field.size;
  }
  const remainder = size % alignment;
  return {
    size: remainder === 0 ? size : size + (alignment - remainder),
    alignment,
  };
}

/**
 * Adds a computed layout to the intrinsic a written struct name resolves to.
 *
 * Without this, describing a written name and describing a value's type would answer
 * differently for the same struct: only the reflected path carried a layout, so a
 * nested field worked through `@type_of` and was refused through the name. Both go
 * through the same payload afterwards.
 *
 * A type whose layout cannot be computed is left alone rather than rejected here.
 * Recursive types have no direct layout but are still legitimate operands of type
 * pattern matching, which never asks for a size, so failing at this point would break
 * programs that only match on them. They are refused later, if a size is asked for.
 */
function enrichStructIntrinsic(
  intrinsic: Extract<TypedDucklangExpression, { readonly kind: "intrinsic" }>,
  structNames: ReadonlyMap<
    string,
    TypedDucklangModule["structTypes"][number]
  >,
): TypedDucklangExpression {
  const payload = JSON.parse(intrinsic.exportName) as {
    readonly name?: string;
    readonly layout?: unknown;
  };
  if (payload.name === undefined || payload.layout !== undefined) {
    return intrinsic;
  }
  const declaration = structNames.get(payload.name);
  if (declaration === undefined || declaration.parameters.length > 0) {
    // A parameterised name with no arguments applied has no layout to compute yet.
    return intrinsic;
  }
  let layout: { readonly size: number; readonly alignment: number };
  try {
    layout = resolveLayout(
      { kind: "constructor", name: payload.name, arguments: [] },
      structNames,
      new Map(),
      new Set(),
    );
  } catch {
    return intrinsic;
  }
  return {
    ...intrinsic,
    exportName: JSON.stringify({ ...payload, layout }),
  };
}

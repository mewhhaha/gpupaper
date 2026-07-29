import type { CoreTypeId, DucklangCoreModule } from "./ducklang_core.ts";

/**
 * Physical layout planning for monomorphic Core types.
 *
 * `LayoutId` is deliberately independent of `CoreTypeId`. A layout records only
 * size, alignment, and where each component sits, so several distinct semantic
 * types share one layout whenever their storage agrees: `i32` and `f32` are both
 * four bytes aligned to four, and a product of two `i32`s has the same layout as
 * a product of two `f32`s. Keeping the two identities separate is what lets a
 * later pass reason about storage without reasoning about types, and stops a
 * layout decision from silently becoming a type decision.
 *
 * Every quantity here is derived from the Core type table in index order, so the
 * result depends only on the module's contents.
 */

declare const layoutIdBrand: unique symbol;

export type LayoutId = number & { readonly [layoutIdBrand]: true };

export type DucklangCoreLayout =
  | {
    readonly kind: "scalar";
    readonly size: number;
    readonly alignment: number;
  }
  | {
    /** An opaque managed reference. Its target's bytes are not part of it. */
    readonly kind: "handle";
    readonly size: number;
    readonly alignment: number;
  }
  | {
    readonly kind: "product";
    readonly size: number;
    readonly alignment: number;
    readonly offsets: readonly number[];
    readonly fields: readonly LayoutId[];
  }
  | {
    readonly kind: "sum";
    readonly size: number;
    readonly alignment: number;
    /** Discriminant offset, always zero; payloads follow it. */
    readonly tagOffset: number;
    readonly tagSize: number;
    readonly payloadOffset: number;
    readonly cases: readonly LayoutId[];
  };

export type DucklangCoreLayoutPlan = {
  readonly layouts: readonly DucklangCoreLayout[];
  /** Layout of each `CoreTypeId`, indexed by that ID. */
  readonly typeLayouts: readonly LayoutId[];
};

const tagSize = 4;
const tagAlignment = 4;
/** A managed reference is a four-byte table index, not a linear-memory pointer. */
const handleSize = 4;
const handleAlignment = 4;

export type DucklangBufferOwnership = "owned" | "frozen";

export type DucklangBufferRepresentation =
  | {
    /** A four-byte managed table index. The runtime owns the bytes. */
    readonly kind: "handle";
    readonly size: number;
    readonly alignment: number;
  }
  | {
    /** An (offset, length) pair of `i32`s addressing linear memory. */
    readonly kind: "slice";
    readonly size: number;
    readonly alignment: number;
    readonly offsetField: number;
    readonly lengthField: number;
  };

/**
 * The chosen physical representation for a `Text` or `Bytes` value.
 *
 * An owned buffer stays a managed handle. Ownership transfer and release need a
 * runtime identity that a raw address cannot provide, and the managed table is
 * what gives the host an object to free, so an owned buffer is four bytes.
 *
 * A frozen buffer becomes a linear-memory slice: an offset and a length, eight
 * bytes aligned to four. Freezing is what makes that safe, because immutable
 * bytes can be shared and interned without a runtime owner, and a slice lets the
 * GPU path address the bytes directly instead of calling through the managed
 * table.
 *
 * `Text` and `Bytes` share a representation at each ownership state. They stay
 * distinct semantic buffer kinds, and this function is where that would change if
 * one of them ever needed different storage.
 *
 * Nothing emits the slice form yet: the backend uses managed handles throughout,
 * and replacing them is the separate roadmap item about linear-memory text.
 * Encoding the decision here keeps it a single reviewable rule rather than an
 * assumption spread across passes.
 */
export function ducklangBufferRepresentation(
  ownership: DucklangBufferOwnership,
): DucklangBufferRepresentation {
  if (ownership === "owned") {
    return {
      kind: "handle",
      size: handleSize,
      alignment: handleAlignment,
    };
  }
  return {
    kind: "slice",
    size: 8,
    alignment: 4,
    offsetField: 0,
    lengthField: 4,
  };
}

export function planDucklangCoreLayouts(
  module: DucklangCoreModule,
): DucklangCoreLayoutPlan {
  const layouts: DucklangCoreLayout[] = [];
  const interned = new Map<string, LayoutId>();
  const typeLayouts: (LayoutId | undefined)[] = module.types.map(() =>
    undefined
  );
  const recursiveTypes = findRecursiveCoreTypes(module);
  const visiting = new Set<number>();

  const intern = (layout: DucklangCoreLayout): LayoutId => {
    const key = JSON.stringify(layout);
    const existing = interned.get(key);
    if (existing !== undefined) return existing;
    const id = layouts.length as LayoutId;
    interned.set(key, id);
    layouts.push(layout);
    return id;
  };

  const layoutOf = (type: CoreTypeId): LayoutId => {
    const cached = typeLayouts[type];
    if (cached !== undefined) return cached;
    if (recursiveTypes.has(type)) {
      const id = intern({
        kind: "handle",
        size: handleSize,
        alignment: handleAlignment,
      });
      typeLayouts[type] = id;
      return id;
    }
    if (visiting.has(type)) {
      throw new Error(`non-recursive Ducklang Core type ${type} forms a cycle`);
    }
    visiting.add(type);
    const entry = module.types[type];
    if (entry === undefined) {
      throw new RangeError(
        `Ducklang Core type ${type} is outside table length ${module.types.length}`,
      );
    }
    const id = intern(computeLayout(entry, layoutOf, layouts));
    visiting.delete(type);
    typeLayouts[type] = id;
    return id;
  };

  for (let type = 0; type < module.types.length; type += 1) {
    layoutOf(type as CoreTypeId);
  }
  return {
    layouts,
    typeLayouts: typeLayouts.map((id, index) => {
      if (id === undefined) {
        throw new Error(`Ducklang Core type ${index} received no layout`);
      }
      return id;
    }),
  };
}

function findRecursiveCoreTypes(
  module: DucklangCoreModule,
): ReadonlySet<CoreTypeId> {
  const recursive = new Set<CoreTypeId>();
  for (let root = 0; root < module.types.length; root += 1) {
    const pending = [...containedTypes(module.types[root])];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const candidate = pending.pop()!;
      if (candidate === root) {
        recursive.add(root as CoreTypeId);
        break;
      }
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      const type = module.types[candidate];
      if (type !== undefined) pending.push(...containedTypes(type));
    }
  }
  return recursive;
}

function containedTypes(
  type: DucklangCoreModule["types"][number],
): readonly CoreTypeId[] {
  if (type.kind === "product") return type.fields;
  if (type.kind === "sum") return type.cases;
  return [];
}

function computeLayout(
  entry: DucklangCoreModule["types"][number],
  layoutOf: (type: CoreTypeId) => LayoutId,
  layouts: readonly DucklangCoreLayout[],
): DucklangCoreLayout {
  switch (entry.kind) {
    case "scalar":
      return { kind: "scalar", ...scalarLayout(entry.scalar) };
    case "buffer": {
      // Core carries no ownership state on a buffer type, so layout planning
      // assumes the owned representation. A frozen buffer's slice form is
      // available from ducklangBufferRepresentation and becomes reachable once
      // ownership reaches Core.
      const representation = ducklangBufferRepresentation("owned");
      return {
        kind: "handle",
        size: representation.size,
        alignment: representation.alignment,
      };
    }
    case "function":
      return {
        kind: "handle",
        size: handleSize,
        alignment: handleAlignment,
      };
    case "product": {
      const fields = entry.fields.map(layoutOf);
      const offsets: number[] = [];
      let size = 0;
      let alignment = 1;
      for (const field of fields) {
        const layout = layouts[field];
        alignment = Math.max(alignment, layout.alignment);
        size = align(size, layout.alignment);
        offsets.push(size);
        size += layout.size;
      }
      return {
        kind: "product",
        size: align(size, alignment),
        alignment,
        offsets,
        fields,
      };
    }
    case "sum": {
      const cases = entry.cases.map(layoutOf);
      let payloadSize = 0;
      let payloadAlignment = 1;
      for (const payload of cases) {
        const layout = layouts[payload];
        payloadSize = Math.max(payloadSize, layout.size);
        payloadAlignment = Math.max(payloadAlignment, layout.alignment);
      }
      const payloadOffset = align(tagSize, payloadAlignment);
      const alignment = Math.max(tagAlignment, payloadAlignment);
      return {
        kind: "sum",
        size: align(payloadOffset + payloadSize, alignment),
        alignment,
        tagOffset: 0,
        tagSize,
        payloadOffset,
        cases,
      };
    }
  }
}

function scalarLayout(
  scalar: "i32" | "i64" | "f32" | "f64" | "f32x4" | "unit",
): { readonly size: number; readonly alignment: number } {
  switch (scalar) {
    case "i32":
    case "f32":
      return { size: 4, alignment: 4 };
    case "i64":
    case "f64":
      return { size: 8, alignment: 8 };
    case "f32x4":
      return { size: 16, alignment: 16 };
    case "unit":
      // Unit occupies no storage, but alignment one keeps it usable as a field.
      return { size: 0, alignment: 1 };
  }
}

function align(offset: number, alignment: number): number {
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + (alignment - remainder);
}

/**
 * A type as reflection sees it: the payload a `duck:type/*` intrinsic carries.
 *
 * Source type names rather than Core scalars, because reflection answers questions
 * about types written in the source and never reaches Core. The names are the ones
 * resolution puts in the intrinsic's `exportName`.
 */
export type DucklangReflectedType =
  | { readonly kind: "builtin"; readonly name: string }
  | {
    readonly kind: "struct";
    readonly fields: readonly { readonly type: string }[];
  };

/**
 * Size and alignment for a reflected type, by the same rules as Core layout.
 *
 * This exists because `planDucklangCoreLayouts` computes layouts over Core types,
 * and reflection has to answer before Core exists. The scalar table and the product
 * padding rule are deliberately delegated to `scalarLayout` and `align` rather than
 * restated, so a change to how Core lays a value out cannot silently disagree with
 * what a program is told when it asks.
 */
export function ducklangReflectedLayout(
  type: DucklangReflectedType,
): { readonly size: number; readonly alignment: number } {
  if (type.kind === "builtin") return builtinScalarLayout(type.name);
  const fields = type.fields.map((field) => builtinScalarLayout(field.type));
  const alignment = Math.max(1, ...fields.map((field) => field.alignment));
  let size = 0;
  for (const field of fields) {
    size = align(size, field.alignment);
    size += field.size;
  }
  return { size: align(size, alignment), alignment };
}

function builtinScalarLayout(
  name: string,
): { readonly size: number; readonly alignment: number } {
  switch (name) {
    case "Int":
    case "I32":
    // A character is a scalar code point in a word, which is why Core maps char
    // and i32 to the same layout.
    case "Char":
    case "Bool":
      return scalarLayout("i32");
    case "I64":
      return scalarLayout("i64");
    case "F32":
      return scalarLayout("f32");
    case "F64":
      return scalarLayout("f64");
    case "Unit":
      return scalarLayout("unit");
    case "Text":
    case "Bytes":
      // Buffers are managed handles today. `ducklangBufferRepresentation` owns that
      // decision, so reflection asks it rather than assuming a width.
      return ducklangBufferRepresentation("owned");
    default:
      throw new TypeError(
        `Ducklang type ${name} has no reflected layout`,
      );
  }
}

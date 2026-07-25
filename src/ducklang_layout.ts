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

export function planDucklangCoreLayouts(
  module: DucklangCoreModule,
): DucklangCoreLayoutPlan {
  const layouts: DucklangCoreLayout[] = [];
  const interned = new Map<string, LayoutId>();
  const typeLayouts: (LayoutId | undefined)[] = module.types.map(() =>
    undefined
  );
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
    if (visiting.has(type)) {
      // A type that contains itself has no finite unboxed size. Saying so beats
      // returning a wrong size or looping.
      throw new TypeError(
        `Ducklang Core type ${type} is recursive and has no direct layout`,
      );
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

function computeLayout(
  entry: DucklangCoreModule["types"][number],
  layoutOf: (type: CoreTypeId) => LayoutId,
  layouts: readonly DucklangCoreLayout[],
): DucklangCoreLayout {
  switch (entry.kind) {
    case "scalar":
      return { kind: "scalar", ...scalarLayout(entry.scalar) };
    case "buffer":
      // Text and Bytes are distinct semantic kinds that currently share one
      // physical representation: a managed handle. Choosing a linear-memory
      // representation for them is a separate roadmap item.
      return {
        kind: "handle",
        size: handleSize,
        alignment: handleAlignment,
      };
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

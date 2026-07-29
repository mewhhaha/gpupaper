export const managedProductIndexImportName = "product_index";
export const managedProductIndexUpdateImportName = "product_index_update";
export const managedSumTagImportName = "sum_tag";

export function managedBytesMakeImportName(length: number): string {
  return `bytes_make_${length}`;
}

export function managedProductMakeImportName(arity: number): string {
  return `product_make_${arity}`;
}

export function managedProductProjectImportName(index: number): string {
  return `product_project_${index}`;
}

export function managedProductUpdateImportName(
  indices: readonly number[],
): string {
  return `product_update_${indices.join("_")}`;
}

export function managedSumMakeImportName(tag: number): string {
  return `sum_make_${tag}`;
}

export function managedSumPayloadImportName(
  valueType: "i32" | "i64" | "f32" | "f64",
): string {
  return `sum_payload_${valueType}`;
}

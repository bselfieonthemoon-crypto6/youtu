export type LocalImageOperation = "remove_background" | "region_matting" | "split_layers" | "erase_transparent" | "smart_erase";

export function isLocalImageOperation(
  operation: unknown,
): operation is LocalImageOperation {
  return operation === "remove_background" || operation === "region_matting" || operation === "split_layers" || operation === "erase_transparent" || operation === "smart_erase";
}

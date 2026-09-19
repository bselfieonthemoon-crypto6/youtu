export type LocalImageOperation = "region_matting" | "erase_transparent" | "smart_erase";

/**
 * Operations the local FeyNoBG worker performs. `split_layers` is deliberately
 * absent: layer splitting is always the semantic flow now (a framed element or
 * model-proposed element names), because the local fast split was removed.
 */
export function isLocalImageOperation(
  operation: unknown,
): operation is LocalImageOperation {
  return operation === "region_matting" || operation === "erase_transparent" || operation === "smart_erase";
}

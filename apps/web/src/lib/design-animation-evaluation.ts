import type { DesignObject } from "@loomic/shared";

/** Include ancestor visibility: hidden groups hide all their descendants. */
export function getVisibleAnimatedObjects(objects: readonly DesignObject[]) {
  const byId = new Map(objects.map(object => [object.objectId, object]));
  const hidden = new Set<string>();
  const pending = objects.filter(object => !object.visible).map(object => object.objectId);
  while (pending.length) {
    const id = pending.pop()!;
    if (hidden.has(id)) continue;
    hidden.add(id);
    const object = byId.get(id);
    if (object?.type === "group") pending.push(...object.childObjectIds);
  }
  return objects.filter(object => !hidden.has(object.objectId) && object.animation);
}

export type DesignAnimationTransform = {
  translateY: number;
  scale: number;
};

/** Pure, original-pose-relative transform shared by GIF export and previews. */
export function evaluateDesignAnimationTransform(
  animation: DesignObject["animation"],
  timeMs: number,
): DesignAnimationTransform {
  if (!animation) return { translateY: 0, scale: 1 };
  const durationMs = clamp(animation.durationMs, 500, 10_000);
  const amount = clamp(animation.amount, 1, 100);
  const phase = positiveModulo(timeMs, durationMs) / durationMs;
  if (animation.type === "float") {
    return {
      translateY: -Math.sin(phase * Math.PI * 2) * amount,
      scale: 1,
    };
  }
  const triangle = 1 - Math.abs(phase * 2 - 1);
  return { translateY: 0, scale: 1 + (amount / 100) * triangle };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

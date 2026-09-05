import type {
  DesignObject,
  DesignTemplateDetailDto,
  DesignTemplateReplacePreviewRequest,
  LoomicSceneV1,
} from "@loomic/shared";

type SmartBinding =
  DesignTemplateReplacePreviewRequest["smart_bindings"][number];

/**
 * Builds suggestions from named/role-bearing objects already in the design.
 * The server remains authoritative: these values are sent as smart bindings
 * and every proposed object/property change is returned in replace-preview.
 */
export function buildSmartTemplateBindings(
  detail: DesignTemplateDetailDto,
  scene: LoomicSceneV1,
): SmartBinding[] {
  const templateObjects = new Map(
    detail.scene.objects.map((object) => [object.objectId, object]),
  );
  const result: SmartBinding[] = [];
  for (const variable of detail.template.variables) {
    const target = templateObjects.get(variable.target.object_id);
    if (!target) continue;
    const selector = target.role
      ? { role: target.role }
      : target.name
        ? { name: target.name }
        : null;
    if (!selector) continue;
    const source = scene.objects.find(
      (candidate) =>
        compatible(variable.type, candidate) &&
        (target.role
          ? candidate.role === target.role
          : candidate.name
              ?.toLocaleLowerCase()
              .includes(target.name?.toLocaleLowerCase() ?? "")),
    );
    if (!source) continue;
    const binding = smartBinding(variable, source, selector);
    if (binding) result.push(binding);
  }
  return result;
}

function compatible(
  type: DesignTemplateDetailDto["template"]["variables"][number]["type"],
  object: DesignObject,
) {
  if (type === "text" || type === "font")
    return object.type === "text" || object.type === "textbox";
  if (type === "image") return object.type === "image";
  return "fill" in object || "stroke" in object;
}

function smartBinding(
  variable: DesignTemplateDetailDto["template"]["variables"][number],
  object: DesignObject,
  selector: { role: NonNullable<DesignObject["role"]> } | { name: string },
): SmartBinding | null {
  if (
    variable.type === "text" &&
    (object.type === "text" || object.type === "textbox")
  ) {
    return { type: "text", selector, value: object.text };
  }
  if (variable.type === "image" && object.type === "image") {
    return {
      type: "image",
      selector,
      value: {
        asset_object_id: object.assetObjectId,
        resource_id: object.resourceId ?? null,
      },
    };
  }
  if (
    variable.type === "font" &&
    (object.type === "text" || object.type === "textbox")
  ) {
    if (!object.fontFaceId) return null;
    return {
      type: "font",
      selector,
      value: {
        font_face_id: object.fontFaceId,
        font_family: object.fontFamily,
      },
    };
  }
  if (variable.type === "color") {
    const paint =
      variable.target.property === "fill" && "fill" in object
        ? object.fill
        : "stroke" in object
          ? object.stroke
          : null;
    if (!paint || paint.kind !== "solid") return null;
    return { type: "color", selector, value: paint.color };
  }
  return null;
}

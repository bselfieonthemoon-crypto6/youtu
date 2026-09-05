import {
  type DesignCommand,
  type DesignObject,
  type LoomicSceneV1,
  applyDesignCanvasUpdate,
  designCommandSchema,
  loomicSceneV1Schema,
} from "@loomic/shared";

export class DesignCommandApplyError extends Error {
  constructor(
    readonly code:
      | "object_not_found"
      | "object_version_conflict"
      | "object_already_exists"
      | "invalid_command",
    message: string,
    readonly objectId?: string,
  ) {
    super(message);
    this.name = "DesignCommandApplyError";
  }
}

const patchKeyMap: Record<string, string> = {
  z_index: "zIndex",
  asset_object_id: "assetObjectId",
  resource_id: "resourceId",
  flip_x: "flipX",
  flip_y: "flipY",
  font_face_id: "fontFaceId",
  font_family: "fontFamily",
  font_size: "fontSize",
  font_weight: "fontWeight",
  font_style: "fontStyle",
  text_align: "textAlign",
  line_height: "lineHeight",
  char_spacing: "charSpacing",
  stroke_width: "strokeWidth",
  min_width: "minWidth",
  radius_x: "radiusX",
  radius_y: "radiusY",
  arrow_start: "arrowStart",
  arrow_end: "arrowEnd",
};

export function applyDesignCommands(
  inputScene: LoomicSceneV1,
  rawCommands: readonly DesignCommand[],
): LoomicSceneV1 {
  const scene = structuredClone(loomicSceneV1Schema.parse(inputScene));
  const originalById = new Map(
    scene.objects.map((object) => [object.objectId, structuredClone(object)]),
  );

  for (const rawCommand of rawCommands) {
    const command = designCommandSchema.parse(rawCommand);
    if (command.action === "scene.replace") {
      if (rawCommands.length !== 1) {
        throw invalid("scene.replace must be the only command in a batch");
      }
      return structuredClone(command.scene);
    }

    switch (command.action) {
      case "object.add":
        assertAbsent(scene, command.object.objectId);
        scene.objects.splice(
          command.object.zIndex,
          0,
          structuredClone(command.object),
        );
        break;
      case "object.clone":
        assertVersion(
          scene,
          command.source_object_id,
          command.expected_object_version,
        );
        assertAbsent(scene, command.object.objectId);
        scene.objects.splice(
          command.object.zIndex,
          0,
          structuredClone(command.object),
        );
        break;
      case "object.update": {
        const object = assertVersion(
          scene,
          command.object_id,
          command.expected_object_version,
        );
        const patch = command.patch as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(patch)) {
          if (key === "object_type") continue;
          (object as unknown as Record<string, unknown>)[
            patchKeyMap[key] ?? key
          ] = structuredClone(value);
        }
        object.objectVersion += 1;
        if (typeof patch.z_index === "number") {
          moveObject(scene, object.objectId, patch.z_index);
        }
        break;
      }
      case "object.remove":
        assertVersion(
          scene,
          command.object_id,
          command.expected_object_version,
        );
        scene.objects = scene.objects.filter(
          (object) => object.objectId !== command.object_id,
        );
        break;
      case "object.reorder": {
        const object = assertVersion(
          scene,
          command.object_id,
          command.expected_object_version,
        );
        object.objectVersion += 1;
        moveObject(scene, object.objectId, command.to_index);
        break;
      }
      case "objects.group":
        for (const child of command.children) {
          assertVersion(scene, child.object_id, child.expected_object_version);
        }
        assertAbsent(scene, command.group.objectId);
        scene.objects.splice(
          command.group.zIndex,
          0,
          structuredClone(command.group),
        );
        break;
      case "objects.ungroup":
        assertVersion(
          scene,
          command.group_object_id,
          command.expected_object_version,
          "group",
        );
        scene.objects = scene.objects.filter(
          (object) => object.objectId !== command.group_object_id,
        );
        break;
      case "objects.align":
        applyAlignment(scene, command);
        break;
      case "objects.distribute":
        applyDistribution(scene, command);
        break;
      case "object.set_role": {
        const object = assertVersion(
          scene,
          command.object_id,
          command.expected_object_version,
        );
        object.role = command.role;
        object.objectVersion += 1;
        break;
      }
      case "canvas.update":
        {
          const updated = applyDesignCanvasUpdate(scene, command);
          scene.canvas = updated.canvas;
          scene.objects = updated.objects;
        }
        break;
    }
  }

  reindex(scene, originalById);
  return loomicSceneV1Schema.parse(scene);
}

function applyAlignment(
  scene: LoomicSceneV1,
  command: Extract<DesignCommand, { action: "objects.align" }>,
) {
  const objects = command.objects.map((reference) =>
    assertVersion(
      scene,
      reference.object_id,
      reference.expected_object_version,
    ),
  );
  const left = Math.min(...objects.map((object) => object.x));
  const right = Math.max(...objects.map((object) => object.x + object.width));
  const top = Math.min(...objects.map((object) => object.y));
  const bottom = Math.max(...objects.map((object) => object.y + object.height));

  for (const object of objects) {
    switch (command.alignment) {
      case "left":
        object.x = left;
        break;
      case "horizontal_center":
        object.x = (left + right - object.width) / 2;
        break;
      case "right":
        object.x = right - object.width;
        break;
      case "top":
        object.y = top;
        break;
      case "vertical_center":
        object.y = (top + bottom - object.height) / 2;
        break;
      case "bottom":
        object.y = bottom - object.height;
        break;
    }
    object.objectVersion += 1;
  }
}

function applyDistribution(
  scene: LoomicSceneV1,
  command: Extract<DesignCommand, { action: "objects.distribute" }>,
) {
  const objects = command.objects.map((reference) =>
    assertVersion(
      scene,
      reference.object_id,
      reference.expected_object_version,
    ),
  );
  const horizontal = command.direction === "horizontal";
  objects.sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const first = objects[0];
  const last = objects.at(-1);
  if (!first || !last)
    throw invalid("Distribution requires at least 3 objects.");
  const totalSize = objects.reduce(
    (sum, object) => sum + (horizontal ? object.width : object.height),
    0,
  );
  const span = horizontal
    ? last.x + last.width - first.x
    : last.y + last.height - first.y;
  const gap = (span - totalSize) / (objects.length - 1);
  let cursor = horizontal ? first.x : first.y;
  for (const object of objects) {
    if (horizontal) object.x = cursor;
    else object.y = cursor;
    cursor += (horizontal ? object.width : object.height) + gap;
    object.objectVersion += 1;
  }
}

function moveObject(
  scene: LoomicSceneV1,
  objectId: string,
  targetIndex: number,
) {
  if (targetIndex < 0 || targetIndex >= scene.objects.length) {
    throw invalid(`Object index ${targetIndex} is outside the scene.`);
  }
  const index = scene.objects.findIndex(
    (object) => object.objectId === objectId,
  );
  const [object] = scene.objects.splice(index, 1);
  if (!object) throw invalid(`Design object ${objectId} was not found.`);
  scene.objects.splice(targetIndex, 0, object);
}

function reindex(
  scene: LoomicSceneV1,
  originalById: ReadonlyMap<string, DesignObject>,
) {
  scene.objects.forEach((object, index) => {
    const original = originalById.get(object.objectId);
    if (
      original &&
      original.zIndex !== index &&
      object.objectVersion === original.objectVersion
    ) {
      object.objectVersion += 1;
    }
    object.zIndex = index;
  });
}

function assertAbsent(scene: LoomicSceneV1, objectId: string) {
  if (scene.objects.some((object) => object.objectId === objectId)) {
    throw new DesignCommandApplyError(
      "object_already_exists",
      `Design object ${objectId} already exists.`,
      objectId,
    );
  }
}

function assertVersion(
  scene: LoomicSceneV1,
  objectId: string,
  expectedVersion: number,
  expectedType?: DesignObject["type"],
): DesignObject {
  const object = scene.objects.find(
    (candidate) => candidate.objectId === objectId,
  );
  if (!object || (expectedType && object.type !== expectedType)) {
    throw new DesignCommandApplyError(
      "object_not_found",
      `Design object ${objectId} was not found.`,
      objectId,
    );
  }
  if (object.objectVersion !== expectedVersion) {
    throw new DesignCommandApplyError(
      "object_version_conflict",
      `Design object ${objectId} changed.`,
      objectId,
    );
  }
  return object;
}

function invalid(message: string) {
  return new DesignCommandApplyError("invalid_command", message);
}

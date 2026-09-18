import { createHash } from "node:crypto";

import {
  type DesignDocumentDto,
  type ManualCanvasImageImportRequest,
  type ManualCanvasImageScenePose,
  type NewDesignObject,
  designUuidSchema,
  loomicDesignNodeMetadataSchema,
  newDesignObjectSchema,
} from "@loomic/shared";

type CanvasElement = Record<string, unknown>;

export class ManualCanvasImageImportBuildError extends Error {
  constructor(
    readonly code:
      | "source_not_found"
      | "source_changed"
      | "source_locked"
      | "source_not_importable"
      | "board_not_found"
      | "board_changed"
      | "board_locked"
      | "board_mismatch"
      | "geometry_invalid",
    message: string,
  ) {
    super(message);
    this.name = "ManualCanvasImageImportBuildError";
  }
}

export function buildManualCanvasImageObject(input: {
  request: ManualCanvasImageImportRequest;
  design: DesignDocumentDto;
  elements: readonly unknown[];
}): NewDesignObject {
  const source = findLiveElement(input.elements, input.request.source_element_id);
  if (!source) {
    throw new ManualCanvasImageImportBuildError(
      "source_not_found",
      "The canvas image is no longer available.",
    );
  }
  assertElementVersion(
    source,
    input.request.expected_source_element_version,
    "source",
  );
  if (source.locked === true) {
    throw new ManualCanvasImageImportBuildError(
      "source_locked",
      "Unlock the canvas image before importing it.",
    );
  }
  if (source.type !== "image") {
    throw new ManualCanvasImageImportBuildError(
      "source_not_importable",
      "Only a persisted canvas image can be imported.",
    );
  }
  const sourceData = asRecord(source.customData);
  const assetObjectId = designUuidSchema.safeParse(sourceData?.assetId);
  if (!assetObjectId.success || sourceData?.isVideo === true) {
    throw new ManualCanvasImageImportBuildError(
      "source_not_importable",
      "The canvas image does not reference an importable workspace asset.",
    );
  }

  const board = findLiveElement(input.elements, input.request.board_element_id);
  if (!board) {
    throw new ManualCanvasImageImportBuildError(
      "board_not_found",
      "The target design board is no longer available.",
    );
  }
  assertElementVersion(
    board,
    input.request.expected_board_element_version,
    "board",
  );
  if (board.locked === true) {
    throw new ManualCanvasImageImportBuildError(
      "board_locked",
      "Unlock the target design board before importing an image.",
    );
  }
  const metadata = loomicDesignNodeMetadataSchema.safeParse(board.customData);
  if (!metadata.success || metadata.data.designId !== input.design.id) {
    throw new ManualCanvasImageImportBuildError(
      "board_mismatch",
      "The target canvas element is not the requested design board.",
    );
  }

  const sourcePose = readPose(
    input.request.placement.kind === "preserve" &&
      input.request.placement.scene_pose
      ? input.request.placement.scene_pose
      : source,
    "source",
  );
  const boardPose = readPose(board, "board");
  const placement =
    input.request.placement.kind === "fit"
      ? fitCenter(
          sourcePose,
          boardPose,
          input.design.width,
          input.design.height,
        )
      : mapScenePoseToDesign(sourcePose, boardPose, input.design);
  const sourceScale = Array.isArray(source.scale) ? source.scale : [];
  const opacity = Number(source.opacity ?? 100);

  return newDesignObjectSchema.parse({
    objectId: manualCanvasImageImportObjectId(input.request),
    objectVersion: 1,
    name: importName(sourceData?.title),
    type: "image",
    assetObjectId: assetObjectId.data,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    rotation: placement.rotation,
    opacity:
      Number.isFinite(opacity) && opacity >= 0 && opacity <= 100
        ? opacity / 100
        : 1,
    zIndex: input.design.scene.objects.length,
    locked: false,
    visible: true,
    fit: "fill",
    ...(sourceScale[0] === -1 ? { flipX: true } : {}),
    ...(sourceScale[1] === -1 ? { flipY: true } : {}),
    ...readNormalizedCrop(source.crop),
  });
}

/**
 * Cryptographically binds the durable object/operation identity to the whole
 * immutable import request. A reused request_id with a different source,
 * board, mode or drop pose therefore cannot replay as the old operation.
 */
export function manualCanvasImageImportObjectId(
  request: ManualCanvasImageImportRequest,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      request_id: request.request_id,
      design_id: request.design_id,
      expected_design_revision: request.expected_design_revision,
      canvas_id: request.canvas_id,
      source_element_id: request.source_element_id,
      expected_source_element_version: request.expected_source_element_version,
      board_element_id: request.board_element_id,
      expected_board_element_version: request.expected_board_element_version,
      mode: request.mode,
      placement: request.placement,
    }))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function findLiveElement(elements: readonly unknown[], id: string) {
  return elements.find((candidate): candidate is CanvasElement => {
    const element = asRecord(candidate);
    return element?.id === id && element.isDeleted !== true;
  });
}

function assertElementVersion(
  element: CanvasElement,
  expected: number,
  kind: "source" | "board",
) {
  if (element.version !== expected) {
    throw new ManualCanvasImageImportBuildError(
      kind === "source" ? "source_changed" : "board_changed",
      kind === "source"
        ? "The canvas image changed before it could be imported."
        : "The target design board changed before the import.",
    );
  }
}

function readPose(
  value: CanvasElement | ManualCanvasImageScenePose,
  kind: "source" | "board",
) {
  const pose = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
    angle: Number(value.angle ?? 0),
  };
  if (
    !Object.values(pose).every(Number.isFinite) ||
    pose.width <= 0 ||
    pose.height <= 0
  ) {
    throw new ManualCanvasImageImportBuildError(
      "geometry_invalid",
      `The ${kind} element has invalid geometry.`,
    );
  }
  return pose;
}

function fitCenter(
  source: ManualCanvasImageScenePose,
  board: ManualCanvasImageScenePose,
  designWidth: number,
  designHeight: number,
) {
  const rotation = normalizeDegrees(
    ((source.angle - board.angle) * 180) / Math.PI,
  );
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const rotatedWidth = source.width * cos + source.height * sin;
  const rotatedHeight = source.width * sin + source.height * cos;
  const scale = Math.min(
    designWidth / rotatedWidth,
    designHeight / rotatedHeight,
  );
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: (designWidth - width) / 2,
    y: (designHeight - height) / 2,
    width,
    height,
    rotation,
  };
}

function mapScenePoseToDesign(
  source: ManualCanvasImageScenePose,
  board: ManualCanvasImageScenePose,
  design: Pick<DesignDocumentDto, "width" | "height">,
) {
  const sourceCenterX = source.x + source.width / 2;
  const sourceCenterY = source.y + source.height / 2;
  const boardCenterX = board.x + board.width / 2;
  const boardCenterY = board.y + board.height / 2;
  const dx = sourceCenterX - boardCenterX;
  const dy = sourceCenterY - boardCenterY;
  const cos = Math.cos(board.angle);
  const sin = Math.sin(board.angle);
  const localCenterX = dx * cos + dy * sin + board.width / 2;
  const localCenterY = -dx * sin + dy * cos + board.height / 2;
  const scaleX = design.width / board.width;
  const scaleY = design.height / board.height;
  const width = source.width * scaleX;
  const height = source.height * scaleY;
  const centerX = localCenterX * scaleX;
  const centerY = localCenterY * scaleY;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: normalizeDegrees(((source.angle - board.angle) * 180) / Math.PI),
  };
}

function readNormalizedCrop(raw: unknown) {
  const crop = asRecord(raw);
  if (!crop) return {};
  const naturalWidth = Number(crop.naturalWidth);
  const naturalHeight = Number(crop.naturalHeight);
  const x = Number(crop.x);
  const y = Number(crop.y);
  const width = Number(crop.width);
  const height = Number(crop.height);
  if (
    ![naturalWidth, naturalHeight, x, y, width, height].every(Number.isFinite) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > naturalWidth ||
    y + height > naturalHeight
  ) {
    throw new ManualCanvasImageImportBuildError(
      "geometry_invalid",
      "The canvas image has invalid crop geometry.",
    );
  }
  return {
    crop: {
      x: x / naturalWidth,
      y: y / naturalHeight,
      width: width / naturalWidth,
      height: height / naturalHeight,
    },
  };
}

function normalizeDegrees(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function importName(value: unknown) {
  if (typeof value !== "string") return "画布图片";
  const name = value.trim();
  return name ? name.slice(0, 200) : "画布图片";
}

function asRecord(value: unknown): CanvasElement | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CanvasElement)
    : null;
}

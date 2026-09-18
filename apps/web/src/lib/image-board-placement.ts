import type { SelectedCanvasImage } from "../components/canvas/image-toolbar-types";

/** A design-board rectangle in canvas coordinates. `x` and `y` are its unrotated top-left. */
export type ImageBoardTarget = {
  elementId: string;
  designId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  locked?: boolean;
};

export type BoardPoint = { x: number; y: number };

export type ImageBoardRelation = "outside" | "center-inside" | "fully-contained";

export type BoardImagePlacement = {
  /** Image top-left in the board's local coordinate system. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Image rotation relative to the board rotation, in Excalidraw radians. */
  angle: number;
};

const EPSILON = 0.001;

function centre(rect: Pick<ImageBoardTarget | SelectedCanvasImage, "x" | "y" | "width" | "height">): BoardPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function rotate(point: BoardPoint, angle: number): BoardPoint {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

/** Converts a canvas point to coordinates whose origin is the board's top-left. */
export function canvasPointToBoardLocal(point: BoardPoint, board: ImageBoardTarget): BoardPoint {
  const boardCentre = centre(board);
  const unrotated = rotate({ x: point.x - boardCentre.x, y: point.y - boardCentre.y }, -(board.angle ?? 0));
  return { x: unrotated.x + board.width / 2, y: unrotated.y + board.height / 2 };
}

/** Returns the four visual corners of an image after its canvas rotation. */
export function getCanvasImageCorners(image: SelectedCanvasImage): BoardPoint[] {
  const imageCentre = centre(image);
  const halfWidth = image.width / 2;
  const halfHeight = image.height / 2;
  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((corner) => {
    const positioned = rotate(corner, image.angle ?? 0);
    return { x: positioned.x + imageCentre.x, y: positioned.y + imageCentre.y };
  });
}

export function boardContainsCanvasPoint(board: ImageBoardTarget, point: BoardPoint): boolean {
  const local = canvasPointToBoardLocal(point, board);
  return local.x >= -EPSILON && local.x <= board.width + EPSILON && local.y >= -EPSILON && local.y <= board.height + EPSILON;
}

/** A cheap selection test: useful for indicating the board under an image centre. */
export function boardContainsImageCenter(board: ImageBoardTarget, image: SelectedCanvasImage): boolean {
  return boardContainsCanvasPoint(board, centre(image));
}

/** Strict enough for safe adoption: every rotated image corner must be inside the board. */
export function boardFullyContainsImage(board: ImageBoardTarget, image: SelectedCanvasImage): boolean {
  return getCanvasImageCorners(image).every((point) => boardContainsCanvasPoint(board, point));
}

export function classifyImageBoardPlacement(board: ImageBoardTarget, image: SelectedCanvasImage): ImageBoardRelation {
  if (!boardContainsImageCenter(board, image)) return "outside";
  return boardFullyContainsImage(board, image) ? "fully-contained" : "center-inside";
}

/** Keeps the image at the same visual canvas position after it becomes board content. */
export function getAdoptedImagePlacement(image: SelectedCanvasImage, board: ImageBoardTarget): BoardImagePlacement {
  const localCentre = canvasPointToBoardLocal(centre(image), board);
  return {
    x: localCentre.x - image.width / 2,
    y: localCentre.y - image.height / 2,
    width: image.width,
    height: image.height,
    angle: (image.angle ?? 0) - (board.angle ?? 0),
  };
}

/**
 * Fits a rotated image inside a board, centred in board-local coordinates.
 * The source rotation is retained relative to the board, so rotation does not
 * unexpectedly change when a board itself is rotated.
 */
export function getFittedImagePlacement(image: SelectedCanvasImage, board: ImageBoardTarget): BoardImagePlacement {
  const sourceWidth = Math.max(1, image.width);
  const sourceHeight = Math.max(1, image.height);
  const angle = (image.angle ?? 0) - (board.angle ?? 0);
  const theta = angle;
  const rotatedWidth = Math.abs(sourceWidth * Math.cos(theta)) + Math.abs(sourceHeight * Math.sin(theta));
  const rotatedHeight = Math.abs(sourceWidth * Math.sin(theta)) + Math.abs(sourceHeight * Math.cos(theta));
  const scale = Math.min(board.width / rotatedWidth, board.height / rotatedHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (board.width - width) / 2, y: (board.height - height) / 2, width, height, angle };
}

export function collectImageBoardRelations(image: SelectedCanvasImage, boards: readonly ImageBoardTarget[]) {
  return boards.map((board) => ({ board, relation: classifyImageBoardPlacement(board, image) }));
}

import type { DesignObject, LoomicSceneV1 } from "@loomic/shared";
import { create, type Font } from "fontkit";
import type { AdminSupabaseClient } from "../../supabase/admin.js";

type TextObject = Extract<DesignObject, { type: "text" | "textbox" }>;
type Binary = { buffer: Buffer; mimeType: string };
const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_FONT_FACES = 32;

/** Layout controls are line boundaries, not glyphs. Preserve empty lines. */
export function splitDesignTextLines(text: string): string[] {
  return text.split(/\r\n|[\r\n\u2028\u2029]/u);
}

export class DesignFontRenderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DesignFontRenderError";
  }
}

function faceIds(scene: LoomicSceneV1) {
  return [...new Set(scene.objects.flatMap(o =>
    "fontFaceId" in o && o.fontFaceId ? [o.fontFaceId] : []))];
}

/** Font IDs are separate from image asset IDs; never resolve a font by its family name. */
export async function loadDesignFontBinaries(
  admin: AdminSupabaseClient, scene: LoomicSceneV1, workspaceId: string,
  assets: Map<string, Binary>, deadlineAt?: number,
) {
  const ids = faceIds(scene);
  if (!ids.length) return;
  if (ids.length > MAX_FONT_FACES) throw new DesignFontRenderError("design_font_budget_exceeded", "Too many font faces.");
  const result = await admin.from("font_faces")
    .select("id, asset_object_id, scope, workspace_id, status, deleted_at, allow_web_embed").in("id", ids);
  if (result.error) throw new DesignFontRenderError("design_font_read_failed", "Unable to read bound fonts.");
  let bytes = 0;
  for (const id of ids) {
    if (deadlineAt && Date.now() >= deadlineAt) throw new DesignFontRenderError("design_export_timeout", "Font loading timed out.");
    const face = result.data?.find(f => f.id === id);
    if (!face || face.deleted_at || !face.allow_web_embed || !(
      (face.scope === "platform" && face.status === "published") ||
      (face.scope === "workspace" && face.workspace_id === workspaceId)
    )) throw new DesignFontRenderError("design_font_forbidden", `Bound font ${id} is unavailable or not authorized; no substitute was used.`);
    const meta = await admin.from("asset_objects")
      .select("bucket, object_path, scope, workspace_id, byte_size, deletion_pending_at")
      .eq("id", face.asset_object_id).maybeSingle();
    const asset = meta.data;
    if (meta.error || !asset || asset.deletion_pending_at || !(
      asset.scope === "platform" || (asset.scope === "workspace" && asset.workspace_id === workspaceId)
    )) throw new DesignFontRenderError("design_font_missing", `Bound font ${id} has no accessible file.`);
    if (bytes + Number(asset.byte_size ?? 0) > MAX_FONT_BYTES) throw new DesignFontRenderError("design_font_budget_exceeded", "Font files exceed the size limit.");
    const downloaded = await admin.storage.from(asset.bucket).download(asset.object_path);
    if (downloaded.error || !downloaded.data) throw new DesignFontRenderError("design_font_missing", `Unable to download bound font ${id}.`);
    const buffer = Buffer.from(await downloaded.data.arrayBuffer());
    bytes += buffer.length;
    if (bytes > MAX_FONT_BYTES) throw new DesignFontRenderError("design_font_budget_exceeded", "Font files exceed the size limit.");
    assets.set(id, { buffer, mimeType: "application/font" });
  }
}

export function parseDesignFonts(scene: LoomicSceneV1, assets: ReadonlyMap<string, Binary>) {
  const fonts = new Map<string, Font>();
  for (const id of faceIds(scene)) {
    const binary = assets.get(id);
    if (!binary) throw new DesignFontRenderError("design_font_missing", `Bound font ${id} was not loaded; no substitute was used.`);
    try {
      const font = create(binary.buffer);
      if (!("layout" in font)) throw new Error("A font collection requires an explicit face.");
      fonts.set(id, font);
    } catch {
      throw new DesignFontRenderError("design_font_invalid", `Bound font ${id} could not be decoded; no substitute was used.`);
    }
  }
  return fonts;
}

/** Outline the actual bound glyphs. SVG/system font fallback cannot change these shapes. */
export function renderBoundText(object: TextObject, font: Font, style: string): string {
  const scale = object.fontSize / font.unitsPerEm;
  const spacing = object.fontSize * object.charSpacing / 1000;
  const measure = (text: string) => font.layout(text).advanceWidth * scale + Math.max(0, [...text].length - 1) * spacing;
  const lines: string[] = [];
  for (const paragraph of splitDesignTextLines(object.text)) {
    if (object.type !== "textbox") { lines.push(paragraph); continue; }
    // Fabric templates split by grapheme by default; retain explicit word wrapping too.
    const tokens = object.splitByGrapheme === false
      ? paragraph.match(/\S+\s*|\s+/gu) ?? []
      : [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(paragraph)].map(s => s.segment);
    let line = "";
    for (const token of tokens) {
      if (line && measure(line + token) > object.width) { lines.push(line); line = ""; }
      line += token;
    }
    lines.push(line);
  }
  const paths: string[] = [];
  for (const [index, line] of lines.entries()) {
    const run = font.layout(line);
    const width = measure(line);
    let x = object.x + (object.textAlign === "center" ? (object.width - width) / 2 : object.textAlign === "right" ? object.width - width : 0);
    // Fabric Text uses the same baseline and line-height constants in the editor.
    const y = object.y + object.fontSize * 1.13 * (1 - 0.222 + index * object.lineHeight);
    run.glyphs.forEach((glyph, i) => {
      if (glyph.id === 0) {
        const codes = (glyph.codePoints ?? []).map(code => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`).join(", ");
        throw new DesignFontRenderError("design_font_glyph_missing", `The template font does not contain a requested character (${codes || "unknown"}; object ${object.objectId}; font ${object.fontFaceId}); no substitute was used.`);
      }
      const pos = run.positions[i]!;
      paths.push(glyph.path.transform(scale, 0, 0, -scale, x + pos.xOffset * scale, y - pos.yOffset * scale).toSVG());
      x += pos.xAdvance * scale + spacing;
    });
  }
  return `<path d="${paths.join(" ")}" ${style}/>`;
}

import { describe, expect, it } from "vitest";
import { mergeCanvasElements, type CanvasElementLike } from "../src/lib/canvas-element-merge";

describe("mergeCanvasElements", () => {
  it("accepts completed pixels while keeping a newer unsaved placeholder drag", () => {
    const pending = { id: "pending-2", version: 43, x: 20, y: -500, width: 390, height: 390, customData: { type: "image-replacement", jobId: "job-2", status: "error" } };
    const image = { id: "pending-2", version: 8, type: "image", x: 0, y: 0, width: 390, height: 390, fileId: "result-2", customData: { sourceJobId: "job-2" } };
    const result = mergeCanvasElements<CanvasElementLike>([pending], [image]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "image", x: 20, y: -500, fileId: "result-2", version: 44 });
    expect(result[0]?.customData).not.toHaveProperty("status");
  });
  it("replaces a durable image-generator in place while keeping its latest drag", () => {
    const pending = {
      id: "generator-1",
      version: 17,
      type: "rectangle",
      x: 640,
      y: -80,
      width: 300,
      height: 400,
      customData: {
        type: "image-generator",
        status: "generating",
        jobId: "job-generator-1",
      },
    };
    const completed = {
      id: "generator-1",
      version: 9,
      type: "image",
      x: 10,
      y: 10,
      width: 300,
      height: 400,
      fileId: "result-generator-1",
      customData: { sourceJobId: "job-generator-1" },
    };

    expect(mergeCanvasElements<CanvasElementLike>([pending], [completed])[0]).toMatchObject({
      id: "generator-1",
      type: "image",
      fileId: "result-generator-1",
      x: 640,
      y: -80,
      version: 18,
    });
  });
  it("honors the authoritative completed split tombstone over a newer local placeholder", () => {
    const source = {
      id: "source-image",
      type: "image",
      version: 9,
      fileId: "source-file",
      customData: { sourceJobId: "original-job" },
    };
    const localPlaceholder = {
      id: "split-placeholder",
      type: "rectangle",
      version: 41,
      x: 50,
      customData: {
        type: "image-replacement",
        operation: "split-layers",
        status: "generating",
        jobId: "semantic-job",
      },
    };
    const { version: _localVersion, ...placeholderWithoutVersion } = localPlaceholder;
    const remoteTombstone = {
      ...placeholderWithoutVersion,
      isDeleted: true,
      customData: {
        ...localPlaceholder.customData,
        completedJobId: "semantic-job",
      },
    };
    const background = {
      id: "split-background",
      type: "image",
      version: 3,
      fileId: "background-file",
      customData: { sourceJobId: "semantic-job:background:0" },
    };
    const foreground = {
      id: "split-foreground",
      type: "image",
      version: 3,
      fileId: "foreground-file",
      customData: { sourceJobId: "semantic-job:element:1" },
    };

    const merged = mergeCanvasElements<CanvasElementLike>(
      [source, localPlaceholder],
      [source, remoteTombstone, background, foreground],
    );

    expect(merged).toEqual([
      source,
      expect.objectContaining({
        id: "split-placeholder",
        isDeleted: true,
        version: 42,
      }),
      background,
      foreground,
    ]);
    expect(
      mergeCanvasElements<CanvasElementLike>([merged[1]!], [remoteTombstone])[0],
    ).toMatchObject({
      isDeleted: true,
      version: 42,
      customData: { completedJobId: "semantic-job" },
    });
  });
  it("does not treat an unmarked placeholder deletion as a completed job", () => {
    const local = {
      id: "split-placeholder",
      type: "rectangle",
      version: 41,
      customData: {
        type: "image-replacement",
        operation: "split-layers",
        jobId: "semantic-job",
      },
    };
    const unmarkedRemoteDeletion = { ...local, version: 2, isDeleted: true };

    expect(mergeCanvasElements([local], [unmarkedRemoteDeletion])).toEqual([
      local,
    ]);
  });
  it("keeps a live semantic split placeholder while only part of its layer package is present", () => {
    const placeholder = {
      id: "split-placeholder",
      type: "rectangle",
      version: 41,
      customData: {
        type: "image-replacement",
        operation: "split-layers",
        status: "generating",
        jobId: "semantic-job",
      },
    };
    const partialLayer = {
      id: "split-background",
      type: "image",
      version: 3,
      fileId: "background-file",
      customData: { sourceJobId: "semantic-job:background:0" },
    };

    expect(mergeCanvasElements(
      [placeholder],
      [placeholder, partialLayer],
    )).toEqual([placeholder, partialLayer]);
  });
  const metadata = (revision: number, previewRevision = revision) => ({
    kind: 'loomic-design', schemaVersion: 1,
    designId: '10000000-0000-4000-8000-000000000001', revision, previewRevision,
    previewAssetObjectId: `20000000-0000-4000-8000-${String(previewRevision).padStart(12, '0')}`,
  });
  it.each([5, 12])('accepts fresh preview despite local geometry version %i', version => {
    const local = { id: 'board', version, x: 99, width: 500, customData: metadata(1) };
    const remote = { id: 'board', version: 5, x: 1, width: 200, customData: metadata(3) };
    expect(mergeCanvasElements([local], [remote])[0]).toMatchObject({ x: 99, width: 500, customData: metadata(3) });
  });
  it('never downgrades the document/preview due to a newer geometry version', () => {
    const local = { id: 'board', version: 5, customData: metadata(3) };
    const remote = { id: 'board', version: 8, customData: metadata(1) };
    expect(mergeCanvasElements([local], [remote])[0]).toMatchObject({ version: 9, customData: metadata(3) });
  });
  it('does not revive locally deleted design nodes', () => {
    const local = { id: 'board', version: 9, isDeleted: true, customData: metadata(1) };
    const remote = { id: 'board', version: 5, isDeleted: false, customData: metadata(3) };
    expect(mergeCanvasElements([local], [remote])[0]).toBe(local);
  });
  it("preserves unsaved local elements and appends generated remote elements", () => {
    const local = [{ id: "local", version: 1, x: 20 }];
    const remote = [{ id: "generated", version: 1, x: 200 }];

    expect(mergeCanvasElements(local, remote)).toEqual([
      { id: "local", version: 1, x: 20 },
      { id: "generated", version: 1, x: 200 },
    ]);
  });

  it("keeps the local copy when versions are equal", () => {
    const local = [{ id: "same", version: 3, x: 99 }];
    const remote = [{ id: "same", version: 3, x: 10 }];

    expect(mergeCanvasElements(local, remote)[0]?.x).toBe(99);
  });

  it("accepts a newer remote edit or deletion tombstone", () => {
    const local = [{ id: "same", version: 3, isDeleted: false }];
    const remote = [{ id: "same", version: 4, isDeleted: true }];

    expect(mergeCanvasElements(local, remote)[0]?.isDeleted).toBe(true);
  });
});

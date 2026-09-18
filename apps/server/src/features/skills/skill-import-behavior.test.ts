import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("../../security/safe-download.js", () => ({ safeDownload: mocks.download }));
import { importFromGitHub, importFromTarballUrl, parseSkillManifest, readBoundedJson } from "./skill-import-service.js";

const skillContent = "---\nname: test-design\ndescription: Design a bounded test artifact.\n---\nUse existing tools and preserve requested scope.\n";
// In-memory tar fixtures exercise the actual parser without extraction or a network call.
function tar(files: Array<{ path: string; content?: string | Buffer; type?: string }>) {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content ?? "");
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header.write(file.type ?? "0", 156, 1, "ascii");
    if (file.type === "2") header.write("../outside.md", 157, 100, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function serveArchive(files: Parameters<typeof tar>[0]) { mocks.download.mockResolvedValue({ buffer: tar(files) }); }
const archiveUrl = "https://registry.npmjs.org/test-design/-/test-design-1.0.0.tgz";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("complete package import", () => {
  it("imports the real manifest and nested text references", async () => {
    serveArchive([{ path: "package/SKILL.md", content: skillContent }, { path: "package/references/brief.md", content: "中文 brief" }]);
    const result = await importFromTarballUrl(archiveUrl);
    expect(result.manifest.name).toBe("test-design");
    expect(result.skillContent).toBe(skillContent);
    expect(result.files).toEqual([{ filePath: "references/brief.md", content: "中文 brief", mimeType: "text/markdown" }]);
  });

  it("rejects README-only npm packages without inventing an executable skill", async () => {
    serveArchive([{ path: "package/README.md", content: skillContent }, { path: "package/package.json", content: '{"name":"test-design"}' }]);
    await expect(importFromTarballUrl(archiveUrl)).rejects.toMatchObject({ code: "manifest_not_found" });
  });

  it.each([
    ["traversal", [{ path: "package/references/../outside.md", content: "x" }]],
    ["symbolic link", [{ path: "package/references/link.md", type: "2" }]],
    ["duplicate manifest", [{ path: "package/skill.md", content: skillContent }]],
    ["duplicate reference", [{ path: "package/references/a.md", content: "x" }, { path: "package/references/A.md", content: "y" }]],
    ["binary required attachment", [{ path: "package/assets/required.bin", content: Buffer.from([0x00, 0x01]) }]],
    ["invalid UTF-8 reference", [{ path: "package/references/invalid.md", content: Buffer.from([0xc3, 0x28]) }]],
    ["NUL text attachment", [{ path: "package/references/data.txt", content: Buffer.from([97, 0, 98]) }]],
  ] as const)("rejects %s without returning a partial package", async (_name, files) => {
    serveArchive([{ path: "package/SKILL.md", content: skillContent }, ...files]);
    await expect(importFromTarballUrl(archiveUrl)).rejects.toThrow();
  });

  it("refuses to guess between multiple nested skills", async () => {
    serveArchive([{ path: "package/first/SKILL.md", content: skillContent }, { path: "package/second/SKILL.md", content: skillContent }]);
    await expect(importFromTarballUrl(archiveUrl)).rejects.toMatchObject({ code: "manifest_validation_error" });
  });

  it("does not decode unrelated binary package artwork as skill text", async () => {
    serveArchive([{ path: "package/SKILL.md", content: skillContent }, { path: "package/logo.png", content: Buffer.from([0xff, 0]) }]);
    expect((await importFromTarballUrl(archiveUrl)).files).toEqual([]);
  });

  it("imports an image reference as base64 text instead of rejecting it", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    serveArchive([{ path: "package/SKILL.md", content: skillContent }, { path: "package/references/images/pic.png", content: bytes }]);
    expect((await importFromTarballUrl(archiveUrl)).files).toEqual([
      { filePath: "references/images/pic.png", content: bytes.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("enforces per-file and file-count limits on actual parsed archives", async () => {
    serveArchive([{ path: "package/SKILL.md", content: skillContent }, { path: "package/references/big.md", content: "a".repeat(2 * 1024 * 1024 + 1) }]);
    await expect(importFromTarballUrl(archiveUrl)).rejects.toMatchObject({ code: "tarball_extract_error" });
    serveArchive([{ path: "package/SKILL.md", content: skillContent }, ...Array.from({ length: 65 }, (_, i) => ({ path: `package/references/${i}.md`, content: "brief" }))]);
    await expect(importFromTarballUrl(archiveUrl)).rejects.toMatchObject({ code: "manifest_validation_error" });
  });

  it("a failed GitHub reference download rejects the entire import", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/references")
      ? [{ name: "details.md", type: "file", download_url: "https://raw.githubusercontent.com/acme/repo/main/references/details.md" }]
      : [{ name: "SKILL.md", type: "file", download_url: "https://raw.githubusercontent.com/acme/repo/main/SKILL.md" }, { name: "references", path: "references", type: "dir" }]), { status: 200 })));
    mocks.download.mockResolvedValueOnce({ buffer: Buffer.from(skillContent) }).mockRejectedValueOnce(new Error("download failed"));
    await expect(importFromGitHub("https://github.com/acme/repo")).rejects.toMatchObject({ code: "github_fetch_error" });
  });
});

describe("manifest and bounded JSON parsing", () => {
  it("rejects empty-body, cyclic metadata, oversized metadata and YAML objects", () => {
    expect(() => parseSkillManifest("---\nname: x\ndescription: y\n---\n ")).toThrow();
    expect(() => parseSkillManifest("---\nname: x\ndescription: y\nmetadata: &meta\n  self: *meta\n---\nActual content")).toThrow();
    expect(() => parseSkillManifest(`---\nname: x\ndescription: y\nmetadata:\n  value: ${"x".repeat(66000)}\n---\nActual content`)).toThrow();
    expect(() => parseSkillManifest("---\nname: x\ndescription: y\nmetadata: []\n---\nActual content")).toThrow();
    expect(() => parseSkillManifest("---\nname: !!js/function 'function() {}'\ndescription: y\n---\nActual content")).toThrow();
  });

  it("enforces remote JSON byte limits with and without Content-Length", async () => {
    await expect(readBoundedJson(new Response('{"a":1}'), 20)).resolves.toEqual({ a: 1 });
    await expect(readBoundedJson(new Response("x".repeat(100)), 20)).rejects.toThrow("size limit");
    await expect(readBoundedJson(new Response("{}", { headers: { "Content-Length": "100" } }), 20)).rejects.toThrow("size limit");
  });
});

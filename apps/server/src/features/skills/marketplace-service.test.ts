import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ importTarball: vi.fn() }));
vi.mock("./skill-import-service.js", async importOriginal => ({ ...(await importOriginal<typeof import("./skill-import-service.js")>()), importFromTarballUrl: mocks.importTarball }));
import { getMarketplaceDetail, installFromMarketplace, searchMarketplace } from "./marketplace-service.js";
import { SkillImportError } from "./skill-import-service.js";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function registryResponse(patch: Record<string, unknown> = {}) {
  return { name: "design-skill", "dist-tags": { latest: "1.2.3" },
    versions: { "1.2.3": { name: "design-skill", description: "Actual package", version: "1.2.3", dist: { tarball: "https://registry.npmjs.org/design-skill/-/design-skill-1.2.3.tgz" } } }, ...patch };
}
describe("marketplace package identity", () => {
  it("installs the exact requested package tarball", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(registryResponse())));
    const imported = { manifest: { name: "design-skill", description: "Actual instructions" }, skillContent: "body", files: [] };
    mocks.importTarball.mockResolvedValue(imported);
    expect(await installFromMarketplace("design-skill")).toEqual({ imported, packageName: "design-skill" });
    expect(mocks.importTarball).toHaveBeenCalledWith("https://registry.npmjs.org/design-skill/-/design-skill-1.2.3.tgz");
  });
  it("never falls back to another repository or synthesizes SKILL.md from README", async () => {
    const fetch = vi.fn(async () => Response.json(registryResponse()));
    vi.stubGlobal("fetch", fetch);
    mocks.importTarball.mockRejectedValue(new SkillImportError("manifest_not_found", "No SKILL.md"));
    await expect(installFromMarketplace("design-skill")).rejects.toMatchObject({ code: "install_failed" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(mocks.importTarball).toHaveBeenCalledTimes(1);
  });
  it("rejects a registry package identity mismatch before download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(registryResponse({ name: "wrong-package" }))));
    await expect(getMarketplaceDetail("design-skill")).rejects.toMatchObject({ code: "package_not_found" });
    expect(mocks.importTarball).not.toHaveBeenCalled();
  });
  it("rejects arbitrary external tarball URLs", async () => {
    const data = registryResponse();
    data.versions["1.2.3"].dist.tarball = "https://untrusted.example/skill.tgz";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
    await expect(installFromMarketplace("design-skill")).rejects.toMatchObject({ code: "install_failed" });
    expect(mocks.importTarball).not.toHaveBeenCalled();
  });
  it("does not label a popularity score as downloads or return unsafe external links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ total: 1, objects: [
      { package: { name: "design-skill", version: "1.0", links: { homepage: "javascript:alert(1)", repository: "https://github.com/test/skill" } }, score: { detail: { popularity: 0.97 } } },
    ] })));
    const result = await searchMarketplace("design");
    expect(result.skills[0]).toMatchObject({ downloads: 0, repository: "https://github.com/test/skill" });
    expect(result.skills[0]).not.toHaveProperty("homepage");
  });
});

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readImportDirectory } from "./safe-import-directory.js";

describe("server import directory boundary", () => {
  it("is disabled without an explicit root", async () => {
    await expect(readImportDirectory(undefined, ".")).rejects.toMatchObject({
      code: "directory_import_disabled",
    });
  });
  it("rejects real paths outside the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomic-import-root-"));
    const outside = await mkdtemp(join(tmpdir(), "loomic-import-outside-"));
    await expect(readImportDirectory(root, outside)).rejects.toMatchObject({
      code: "directory_outside_root",
    });
  });
  it("rejects symlinks instead of following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomic-import-root-"));
    const folder = join(root, "package");
    const linkedFolder = join(root, "linked-package");
    await mkdir(folder);
    await mkdir(linkedFolder);
    await writeFile(join(linkedFolder, "asset.txt"), "x");
    await symlink(linkedFolder, join(folder, "link"), "junction");
    await expect(readImportDirectory(root, folder)).rejects.toMatchObject({
      code: "directory_symlink",
    });
  });
});

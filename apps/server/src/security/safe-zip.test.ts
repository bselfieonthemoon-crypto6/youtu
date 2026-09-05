import { describe, expect, it } from "vitest";
import yazl from "yazl";

import { readSafeZip } from "./safe-zip.js";

async function zip(entries: Array<{ name: string; data: Buffer }>) {
  const archive = new yazl.ZipFile();
  for (const entry of entries) archive.addBuffer(entry.data, entry.name);
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("safe zip parser", () => {
  it("reads bounded regular files", async () => {
    const result = await readSafeZip(
      await zip([{ name: "assets/a.txt", data: Buffer.from("ok") }]),
    );
    expect(result).toEqual([{ path: "assets/a.txt", data: Buffer.from("ok") }]);
  });

  it("rejects zip-slip paths before extraction", async () => {
    const archive = await zip([{ name: "safe.txt", data: Buffer.from("bad") }]);
    const unsafe = Buffer.from(archive);
    let offset = unsafe.indexOf("safe.txt");
    while (offset >= 0) {
      unsafe.write("../x.txtx", offset, "ascii");
      offset += 8;
      offset = unsafe.indexOf("safe.txt", offset);
    }
    await expect(readSafeZip(unsafe)).rejects.toMatchObject({
      code: "zip_unsafe_path",
    });
  });

  it("rejects entry-count and compression-ratio bombs", async () => {
    await expect(
      readSafeZip(
        await zip([
          { name: "a", data: Buffer.from("1") },
          { name: "b", data: Buffer.from("2") },
        ]),
        { maxEntries: 1 },
      ),
    ).rejects.toMatchObject({ code: "zip_limit_exceeded" });
    await expect(
      readSafeZip(await zip([{ name: "bomb", data: Buffer.alloc(100_000) }]), {
        maxCompressionRatio: 2,
      }),
    ).rejects.toMatchObject({ code: "zip_limit_exceeded" });
  });
});

import yauzl, { type Entry, type ZipFile } from "yauzl";

export type SafeZipEntry = { path: string; data: Buffer };
export type SafeZipLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
};
const defaults: SafeZipLimits = {
  maxEntries: 500,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
  maxCompressionRatio: 100,
};

export class SafeZipError extends Error {
  constructor(
    readonly code:
      | "zip_invalid"
      | "zip_unsafe_path"
      | "zip_symlink"
      | "zip_limit_exceeded",
  ) {
    super(code);
    this.name = "SafeZipError";
  }
}

export async function readSafeZip(
  buffer: Buffer,
  overrides: Partial<SafeZipLimits> = {},
): Promise<SafeZipEntry[]> {
  const limits = { ...defaults, ...overrides };
  const zip = await openZip(buffer);
  const output: SafeZipEntry[] = [];
  let total = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      if (output.length >= limits.maxEntries)
        throw new SafeZipError("zip_limit_exceeded");
      const path = validatePath(entry.fileName);
      if (isSymlink(entry)) throw new SafeZipError("zip_symlink");
      if (path.endsWith("/")) continue;
      if (
        entry.uncompressedSize > limits.maxEntryBytes ||
        total + entry.uncompressedSize > limits.maxTotalBytes
      )
        throw new SafeZipError("zip_limit_exceeded");
      if (
        entry.uncompressedSize > 0 &&
        entry.uncompressedSize / Math.max(1, entry.compressedSize) >
          limits.maxCompressionRatio
      )
        throw new SafeZipError("zip_limit_exceeded");
      const data = await readEntry(zip, entry, limits.maxEntryBytes);
      total += data.length;
      if (total > limits.maxTotalBytes)
        throw new SafeZipError("zip_limit_exceeded");
      output.push({ path, data });
    }
    return output;
  } catch (error) {
    if (error instanceof SafeZipError) throw error;
    if (
      error instanceof Error &&
      /invalid relative path|absolute path/i.test(error.message)
    )
      throw new SafeZipError("zip_unsafe_path");
    throw new SafeZipError("zip_invalid");
  } finally {
    zip.close();
  }
}

function openZip(buffer: Buffer) {
  return new Promise<ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (error, zip) =>
        error || !zip
          ? reject(
              error &&
                /invalid relative path|absolute path/i.test(error.message)
                ? new SafeZipError("zip_unsafe_path")
                : new SafeZipError("zip_invalid"),
            )
          : resolve(zip),
    ),
  );
}
function nextEntry(zip: ZipFile) {
  return new Promise<Entry | null>((resolve, reject) => {
    const entry = (value: Entry) => {
      cleanup();
      resolve(value);
    };
    const end = () => {
      cleanup();
      resolve(null);
    };
    const error = (value: Error) => {
      cleanup();
      reject(value);
    };
    const cleanup = () => {
      zip.off("entry", entry);
      zip.off("end", end);
      zip.off("error", error);
    };
    zip.once("entry", entry);
    zip.once("end", end);
    zip.once("error", error);
    zip.readEntry();
  });
}
function readEntry(zip: ZipFile, entry: Entry, limit: number) {
  return new Promise<Buffer>((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream)
        return reject(error ?? new SafeZipError("zip_invalid"));
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit)
          stream.destroy(new SafeZipError("zip_limit_exceeded"));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    }),
  );
}
function validatePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  )
    throw new SafeZipError("zip_unsafe_path");
  return normalized;
}
function isSymlink(entry: Entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class ImportDirectoryError extends Error {
  constructor(
    readonly code:
      | "directory_import_disabled"
      | "directory_outside_root"
      | "directory_symlink"
      | "directory_limit_exceeded",
  ) {
    super(code);
    this.name = "ImportDirectoryError";
  }
}

export async function readImportDirectory(
  configuredRoot: string | undefined,
  requestedPath: string,
  limits = { maxFiles: 100, maxTotalBytes: 250 * 1024 * 1024 },
) {
  if (!configuredRoot)
    throw new ImportDirectoryError("directory_import_disabled");
  const root = await realpath(configuredRoot);
  const target = await realpath(
    isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath),
  );
  const relation = relative(root, target);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  )
    throw new ImportDirectoryError("directory_outside_root");
  const output: Array<{ path: string; data: Buffer }> = [];
  let total = 0;
  const visit = async (directory: string) => {
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new ImportDirectoryError("directory_symlink");
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stat.isFile()) continue;
      if (
        output.length >= limits.maxFiles ||
        total + stat.size > limits.maxTotalBytes
      )
        throw new ImportDirectoryError("directory_limit_exceeded");
      total += stat.size;
      output.push({
        path: relative(target, path).split(sep).join("/"),
        data: await readFile(path),
      });
    }
  };
  await visit(target);
  return output;
}

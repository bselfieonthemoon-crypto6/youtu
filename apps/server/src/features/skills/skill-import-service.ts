/**
 * Skill Import Service
 *
 * Parses and imports skills from external sources (GitHub repos, npm tarballs).
 * Skills follow the agentskills.io standard: a directory containing SKILL.md
 * (YAML frontmatter + markdown body) plus optional scripts/, references/, assets/.
 *
 * @module skill-import-service
 */

import yaml from "js-yaml";
import { Parser as TarParser } from "tar";
import { safeDownload } from "../../security/safe-download.js";
import { isSafeSkillFilePath, skillCreateRequestSchema, SKILL_PACKAGE_LIMITS } from "@loomic/shared";

const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_TARBALL_ENTRIES = 500;
const MAX_TARBALL_EXPANDED_BYTES = 20 * 1024 * 1024;

// ── Types ─────────────────────────────────────────────────────────────────

/** Parsed YAML frontmatter from SKILL.md */
export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  version?: string;
  author?: string;
  metadata?: Record<string, unknown>;
}

/** A single file included with the skill (scripts/, references/, assets/) */
export interface ImportedSkillFile {
  /** Relative path within the skill directory, e.g. "scripts/analyze.py" */
  filePath: string;
  /** Raw text content */
  content: string;
  /** Detected MIME type based on extension */
  mimeType: string;
}

/** Complete imported skill ready for persistence */
export interface ImportedSkill {
  manifest: SkillManifest;
  /** Full raw SKILL.md content (frontmatter + body) */
  skillContent: string;
  /** Associated files in scripts/, references/, assets/ */
  files: ImportedSkillFile[];
  /** Original URL the skill was imported from */
  sourceUrl: string;
}

/** Classification of an import URL */
export type ImportSourceType = "github" | "npm-tarball" | "zip" | "unknown";

// ── Error Types ───────────────────────────────────────────────────────────

export class SkillImportError extends Error {
  readonly code:
    | "manifest_not_found"
    | "manifest_parse_error"
    | "manifest_validation_error"
    | "github_fetch_error"
    | "tarball_extract_error"
    | "unsupported_source";

  constructor(code: SkillImportError["code"], message: string) {
    super(message);
    this.name = "SkillImportError";
    this.code = code;
  }
}

// ── MIME Type Detection ───────────────────────────────────────────────────

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".md": "text/markdown",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".sql": "text/x-sql",
  ".r": "text/x-r",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".swift": "text/x-swift",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".env": "text/plain",
};

/** Binary attachments cannot be silently dropped from a complete package. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
]);

function detectMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? "text/plain";
}

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Image references are imported as base64 text; other binaries are rejected. */
const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
function imageMimeFor(filePath: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION.get(filePath.slice(filePath.lastIndexOf(".")).toLowerCase());
}

// ── Frontmatter Parser ────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from SKILL.md content.
 *
 * Expects the file to start with `---` followed by YAML, then `---` to close.
 * Everything after the closing `---` is the markdown body.
 *
 * @throws SkillImportError if frontmatter is missing or invalid
 */
export function parseSkillManifest(skillMdContent: string): SkillManifest {
  if (Buffer.byteLength(skillMdContent, "utf8") > SKILL_PACKAGE_LIMITS.maxContentBytes || skillMdContent.includes("\0")) {
    throw new SkillImportError("manifest_validation_error", "SKILL.md exceeds the 256 KiB text limit or contains binary data.");
  }
  const trimmed = skillMdContent.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: missing YAML frontmatter (file must start with '---')",
    );
  }

  // Find the closing --- (skip the opening one)
  const boundary = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(trimmed);
  if (!boundary) {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: missing closing '---' for YAML frontmatter",
    );
  }

  const yamlBlock = boundary[1]!.trim();
  if (!trimmed.slice(boundary[0].length).trim()) {
    throw new SkillImportError("manifest_validation_error", "SKILL.md must contain instructions after the YAML frontmatter.");
  }
  if (!yamlBlock) {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: empty YAML frontmatter block",
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlBlock, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillImportError(
      "manifest_parse_error",
      `Invalid SKILL.md: YAML parse error - ${message}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: frontmatter must be a YAML mapping",
    );
  }

  const raw = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 200) {
    throw new SkillImportError(
      "manifest_validation_error",
      "Invalid SKILL.md frontmatter: missing required field 'name'",
    );
  }
  if (typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 2000) {
    throw new SkillImportError(
      "manifest_validation_error",
      "Invalid SKILL.md frontmatter: missing required field 'description'",
    );
  }

  const manifest: SkillManifest = {
    name: raw.name,
    description: raw.description,
  };

  // Only assign optional fields when present (exactOptionalPropertyTypes)
  for (const [field, limit] of [["license", 1000], ["version", 100], ["author", 200]] as const) {
    if (typeof raw[field] === "string" && (!raw[field].trim() || raw[field].length > limit)) {
      throw new SkillImportError("manifest_validation_error", `Skill ${field} must be non-empty and at most ${limit} characters.`);
    }
  }
  if (typeof raw.license === "string") manifest.license = raw.license;
  if (typeof raw.version === "string") manifest.version = raw.version;
  if (typeof raw.author === "string") manifest.author = raw.author;
  if (raw.metadata !== undefined && !isPlainObject(raw.metadata)) {
    throw new SkillImportError("manifest_validation_error", "Skill metadata must be a JSON object.");
  }
  if (isPlainObject(raw.metadata)) {
    try {
      const metadataJson = JSON.stringify(raw.metadata);
      if (Buffer.byteLength(metadataJson, "utf8") > 65536) throw new Error("metadata too large");
      manifest.metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    } catch {
      throw new SkillImportError("manifest_validation_error", "Skill metadata must be acyclic JSON within the 64 KiB limit.");
    }
  }

  return manifest;
}

// ── URL Type Detection ────────────────────────────────────────────────────

/**
 * Detect the import source type from a URL string.
 *
 * - GitHub: matches github.com/{owner}/{repo}
 * - npm tarball: ends with .tgz/.tar.gz, or contains registry.npmjs.org
 * - zip: ends with .zip or .skill
 * - unknown: anything else
 */
export function detectImportSource(url: string): ImportSourceType {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  // GitHub detection
  if (hostname === "github.com" || hostname === "www.github.com") {
    return "github";
  }

  // npm tarball detection
  if (hostname === "registry.npmjs.org") {
    return "npm-tarball";
  }
  if (pathname.endsWith(".tgz") || pathname.endsWith(".tar.gz")) {
    return "npm-tarball";
  }

  // ZIP detection (future support)
  if (pathname.endsWith(".zip") || pathname.endsWith(".skill")) {
    return "zip";
  }

  return "unknown";
}

// ── GitHub Importer ───────────────────────────────────────────────────────

/** Parsed components from a GitHub URL */
interface GitHubUrlInfo {
  owner: string;
  repo: string;
  /** Optional path within the repo, e.g. "skills/my-skill" */
  path: string;
  /** Branch/ref extracted from the URL, e.g. "main" */
  ref: string | null;
}

/** GitHub Contents API response item */
interface GitHubContentItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
  size: number;
}

/**
 * Parse a GitHub URL into its constituent parts.
 *
 * Supported formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/main/path/to/skill
 * - https://github.com/owner/repo/tree/branch/path
 */
function parseGitHubUrl(url: string): GitHubUrlInfo {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["github.com", "www.github.com"].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.port) {
    throw new SkillImportError("github_fetch_error", "Expected an HTTPS github.com repository URL without credentials or a custom port.");
  }
  const segments = parsed.pathname
    .split("/")
    .filter((s) => s.length > 0);

  if (segments.length < 2) {
    throw new SkillImportError(
      "github_fetch_error",
      `Invalid GitHub URL: expected github.com/{owner}/{repo}, got: ${url}`,
    );
  }

  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");
  if (![owner, repo].every(value => /^[a-zA-Z0-9_.-]+$/.test(value) && value !== "." && value !== "..")) {
    throw new SkillImportError("github_fetch_error", "Invalid GitHub owner or repository name.");
  }

  // Default: root of the repo, no specific ref
  let ref: string | null = null;
  let path = "";

  // Handle /tree/{ref}/... or /blob/{ref}/... patterns
  if (segments.length >= 4 && (segments[2] === "tree" || segments[2] === "blob")) {
    ref = segments[3]!;
    path = segments.slice(4).join("/");
  } else if (segments.length > 2) {
    // Fallback: treat remaining segments as a path
    path = segments.slice(2).join("/");
  }

  return { owner, repo, ref, path };
}

/**
 * Fetch a resource from the GitHub API with rate-limit awareness.
 *
 * @throws SkillImportError on non-2xx responses
 */
async function githubApiFetch(url: string): Promise<Response> {
  console.log(`[skill-import] GitHub API request: ${url}`);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Loomic-Skill-Importer/1.0",
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  if (!response.ok) {
    // Provide helpful messages for common error codes
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 403 && rateLimitRemaining === "0") {
      const resetTime = response.headers.get("x-ratelimit-reset");
      const resetDate = resetTime
        ? new Date(Number(resetTime) * 1000).toISOString()
        : "unknown";
      throw new SkillImportError(
        "github_fetch_error",
        `GitHub API rate limit exceeded. Resets at ${resetDate}. Consider using a GitHub token.`,
      );
    }

    if (response.status === 404) {
      throw new SkillImportError(
        "github_fetch_error",
        `GitHub repository or path not found: ${url}`,
      );
    }

    throw new SkillImportError(
      "github_fetch_error",
      `Failed to fetch GitHub repository: HTTP ${response.status} ${response.statusText}`,
    );
  }

  return response;
}

/**
 * List directory contents using the GitHub Contents API.
 */
async function listGitHubDirectory(
  owner: string,
  repo: string,
  path: string,
  ref: string | null,
): Promise<GitHubContentItem[]> {
  const encodedPath = path ? `/${encodeURIComponent(path).replace(/%2F/g, "/")}` : "";
  let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents${encodedPath}`;
  if (ref) {
    apiUrl += `?ref=${encodeURIComponent(ref)}`;
  }

  const response = await githubApiFetch(apiUrl);
  const data: unknown = await readBoundedJson(response, 2 * 1024 * 1024);

  if (!Array.isArray(data)) {
    // Single file response — wrap as array for consistent handling
    return [data as GitHubContentItem];
  }
  if (data.length > 500) throw new SkillImportError("github_fetch_error", "Skill directory exceeds 500 entries.");
  return data as GitHubContentItem[];
}

/**
 * Download a file's text content from its download_url.
 */
async function downloadGitHubFile(downloadUrl: string): Promise<string> {
  try {
    const downloaded = await safeDownload(downloadUrl, {
      kind: "text",
      maxBytes: MAX_SKILL_FILE_BYTES,
      timeoutMs: 20_000,
      maxRedirects: 1,
      allowedHosts: ["raw.githubusercontent.com", "github.com"],
      expectedMimeType: "text/plain",
      allowedMimeTypes: ["text/plain", "text/markdown"],
      headers: { "User-Agent": "Loomic-Skill-Importer/1.0" },
    });
    return decodeSkillText(downloaded.buffer);
  } catch (error) {
    throw new SkillImportError(
      "github_fetch_error",
      `Failed to download file from GitHub: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/** Download a binary image reference and base64-encode it for text storage. */
async function downloadGitHubBinary(downloadUrl: string): Promise<string> {
  try {
    const downloaded = await safeDownload(downloadUrl, {
      kind: "image",
      maxBytes: MAX_SKILL_FILE_BYTES,
      timeoutMs: 20_000,
      maxRedirects: 1,
      allowedHosts: ["raw.githubusercontent.com", "github.com"],
      allowedMimeTypes: [...IMAGE_MIME_BY_EXTENSION.values()],
      headers: { "User-Agent": "Loomic-Skill-Importer/1.0" },
    });
    return downloaded.buffer.toString("base64");
  } catch (error) {
    throw new SkillImportError(
      "github_fetch_error",
      `Failed to download image reference from GitHub: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * Recursively collect files from a GitHub directory that match
 * the allowed subdirectory pattern (scripts/, references/, assets/).
 */
async function collectGitHubFiles(
  owner: string,
  repo: string,
  basePath: string,
  ref: string | null,
  parentRelative: string,
  budget: { files: number; bytes: number; directories: number },
): Promise<ImportedSkillFile[]> {
  if (++budget.directories > 128 || parentRelative.split("/").length > 16) {
    throw new SkillImportError("github_fetch_error", "Skill directory count or depth exceeds the import limit.");
  }
  const items = await listGitHubDirectory(owner, repo, basePath, ref);
  const files: ImportedSkillFile[] = [];

  for (const item of items) {
    const relativePath = parentRelative
      ? `${parentRelative}/${item.name}`
      : item.name;

    if (item.type === "file") {
      const imageMime = imageMimeFor(item.name);
      if (!imageMime && isBinaryFile(item.name)) {
        throw new SkillImportError("unsupported_source", `Binary attachment ${relativePath} is not supported by text skill packages; no partial import was saved.`);
      }

      if (!item.download_url) {
        throw new SkillImportError("github_fetch_error", `Missing attachment download URL: ${relativePath}`);
      }
      if (!isSafeSkillFilePath(relativePath) || ++budget.files > SKILL_PACKAGE_LIMITS.maxFiles) {
        throw new SkillImportError("github_fetch_error", "Skill contains unsafe paths or more than 64 files.");
      }
      const content = imageMime
        ? await downloadGitHubBinary(item.download_url)
        : await downloadGitHubFile(item.download_url);
      budget.bytes += Buffer.byteLength(content);
      if (budget.bytes > SKILL_PACKAGE_LIMITS.maxPackageBytes) throw new SkillImportError("github_fetch_error", "Skill package exceeds 8 MiB.");
      files.push({
        filePath: relativePath,
        content,
        mimeType: imageMime ?? detectMimeType(item.name),
      });
    } else if (item.type === "dir") {
      // Recurse into subdirectories
      const nested = await collectGitHubFiles(
        owner,
        repo,
        item.path,
        ref,
        relativePath,
        budget,
      );
      files.push(...nested);
    } else {
      throw new SkillImportError("unsupported_source", "Symbolic links and submodules are not supported in skill packages.");
    }
  }

  return files;
}

/**
 * Import a skill from a GitHub repository URL.
 *
 * Supports URLs pointing to:
 * - A repo root containing SKILL.md
 * - A subdirectory within a repo containing SKILL.md
 *
 * Downloads SKILL.md and all files under scripts/, references/, assets/.
 */
export async function importFromGitHub(repoUrl: string): Promise<ImportedSkill> {
  const { owner, repo, path, ref } = parseGitHubUrl(repoUrl);
  console.log(
    `[skill-import] Importing from GitHub: ${owner}/${repo} path="${path}" ref="${ref ?? "default"}"`,
  );

  // Step 1: List the target directory contents
  const contents = await listGitHubDirectory(owner, repo, path, ref);

  // Step 2: Find SKILL.md
  const skillMdItems = contents.filter(
    (item) => item.type === "file" && item.name.toUpperCase() === "SKILL.MD",
  );
  if (skillMdItems.length > 1) throw new SkillImportError("manifest_validation_error", "Skill directory contains multiple SKILL.md files with conflicting case.");
  const skillMdItem = skillMdItems[0];

  if (!skillMdItem?.download_url) {
    throw new SkillImportError(
      "manifest_not_found",
      `SKILL.md not found in repository: ${owner}/${repo}/${path}`,
    );
  }

  const skillContent = await downloadGitHubFile(skillMdItem.download_url);
  const manifest = parseSkillManifest(skillContent);

  console.log(
    `[skill-import] Parsed manifest: name="${manifest.name}" version="${manifest.version ?? "unversioned"}"`,
  );

  // Step 3: Collect files from allowed subdirectories
  const allowedDirs = ["scripts", "references", "assets"];
  const files: ImportedSkillFile[] = [];
  const budget = { files: 0, bytes: Buffer.byteLength(skillContent), directories: 0 };

  for (const item of contents) {
    if (allowedDirs.includes(item.name.toLowerCase()) && item.type !== "dir") {
      throw new SkillImportError("unsupported_source", "Skill resource directories cannot be links or regular files.");
    }
    if (item.type !== "dir" || !allowedDirs.includes(item.name.toLowerCase())) {
      continue;
    }

    const dirFiles = await collectGitHubFiles(
      owner,
      repo,
      item.path,
      ref,
      item.name,
      budget,
    );
    files.push(...dirFiles);
  }

  console.log(
    `[skill-import] GitHub import complete: ${files.length} files collected from ${owner}/${repo}`,
  );

  return validateImportedSkill({
    manifest,
    skillContent,
    files,
    sourceUrl: repoUrl,
  });
}

// ── Tarball Importer ──────────────────────────────────────────────────────

/** In-memory file extracted from a tarball */
interface TarballEntry {
  /** Path within the tarball (after stripping the root prefix) */
  path: string;
  /** Raw bytes, decoded strictly only for the selected skill and its resources. */
  content: Buffer;
}

/**
 * Extract text files from a .tgz/.tar.gz tarball in memory.
 *
 * npm tarballs typically have a `package/` prefix on all paths;
 * this is automatically detected and stripped.
 */
async function extractTarballEntries(buffer: Buffer): Promise<TarballEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: TarballEntry[] = [];
    let rootPrefix: string | null = null;
    let entryCount = 0;
    let expandedBytes = 0;
    let failed = false;
    const seenPaths = new Set<string>();

    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      reject(new SkillImportError("tarball_extract_error", message));
    };

    const parser = new TarParser({
      strict: true,
      // Let tar auto-detect gzip compression
      onReadEntry(entry) {
        if (failed) {
          entry.resume();
          return;
        }
        const entryPath = entry.path;

        entryCount += 1;
        if (entryCount > MAX_TARBALL_ENTRIES) {
          entry.resume();
          fail("Tarball contains too many entries.");
          return;
        }
        const normalizedParts = entryPath.replace(/\\/g, "/").split("/");
        if (entryPath.startsWith("/") || /[\\:%?#\x00-\x1f]/.test(entryPath) || normalizedParts.includes("..") || normalizedParts.includes(".")) {
          entry.resume();
          fail("Tarball contains an unsafe path.");
          return;
        }

        // Skip directories
        if (entry.type === "Directory") {
          // Detect root prefix from first directory (e.g. "package/")
          if (rootPrefix === null && entryPath.endsWith("/")) {
            rootPrefix = entryPath;
          }
          entry.resume();
          return;
        }

        // Only process regular files
        if (entry.type !== "File") {
          entry.resume();
          fail("Tarball contains unsupported symbolic links or special entries.");
          return;
        }
        if (seenPaths.has(entryPath.toLowerCase())) {
          entry.resume();
          fail("Tarball contains duplicate file paths (case-insensitive).");
          return;
        }
        seenPaths.add(entryPath.toLowerCase());

        if (entry.size > MAX_SKILL_FILE_BYTES) {
          entry.resume();
          fail("Tarball entry is too large.");
          return;
        }
        expandedBytes += entry.size;
        if (expandedBytes > MAX_TARBALL_EXPANDED_BYTES) {
          entry.resume();
          fail("Tarball expands beyond the allowed size.");
          return;
        }

        // Collect the entry's data chunks
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        entry.on("end", () => {
          if (failed) return;
          const fullContent = Buffer.concat(chunks);

          // Detect root prefix from first file if we haven't seen a directory
          if (rootPrefix === null) {
            const firstSlash = entryPath.indexOf("/");
            if (firstSlash !== -1) {
              rootPrefix = entryPath.slice(0, firstSlash + 1);
            }
          }

          entries.push({
            path: entryPath,
            // Decode only after the skill root is known. Irrelevant README or
            // package artwork may be binary, but required resources must not be.
            content: fullContent,
          });
        });
      },
    });

    parser.on("error", (err: Error) => {
      reject(
        new SkillImportError(
          "tarball_extract_error",
          `Failed to extract tarball: ${err.message}`,
        ),
      );
    });

    parser.on("end", () => {
      if (failed) return;
      // Strip root prefix from all paths if one was detected
      if (rootPrefix && entries.every(entry => entry.path.startsWith(rootPrefix!))) {
        for (const entry of entries) {
          if (entry.path.startsWith(rootPrefix)) {
            entry.path = entry.path.slice(rootPrefix.length);
          }
        }
      }

      resolve(entries);
    });

    // Feed the buffer into the parser
    parser.write(buffer);
    parser.end();
  });
}

/**
 * Import a skill from a .tgz/.tar.gz URL (typically an npm tarball).
 *
 * Downloads the tarball, extracts SKILL.md, and collects files under
 * scripts/, references/, assets/.
 */
export async function importFromTarballUrl(url: string): Promise<ImportedSkill> {
  console.log(`[skill-import] Downloading tarball: ${url}`);

  let buffer: Buffer;
  try {
    const downloaded = await safeDownload(url, {
      kind: "archive",
      maxBytes: MAX_TARBALL_BYTES,
      timeoutMs: 60_000,
      maxRedirects: 2,
      allowedHosts: ["registry.npmjs.org", "codeload.github.com", "github.com"],
      expectedMimeType: "application/gzip",
      allowedMimeTypes: ["application/gzip", "application/x-gzip", "application/x-tar"],
      headers: { "User-Agent": "Loomic-Skill-Importer/1.0" },
    });
    buffer = downloaded.buffer;
  } catch (error) {
    throw new SkillImportError(
      "tarball_extract_error",
      `Failed to download tarball: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  console.log(
    `[skill-import] Tarball downloaded: ${(buffer.length / 1024).toFixed(1)} KB, extracting...`,
  );

  const entries = await extractTarballEntries(buffer);

  // Find SKILL.md (case-insensitive, at the root level after prefix stripping)
  const skillMdEntry = entries.find(
    (e) => e.path.toUpperCase() === "SKILL.MD",
  );

  const nestedManifests = entries.filter(e => /\/SKILL\.MD$/i.test(e.path));
  if (!skillMdEntry && nestedManifests.length > 1) {
    throw new SkillImportError("manifest_validation_error", "Archive contains multiple skills. Import the exact GitHub skill directory instead.");
  }
  const effectiveSkillMd = skillMdEntry ?? nestedManifests[0];
  if (!effectiveSkillMd) throw new SkillImportError("manifest_not_found", "A real SKILL.md is required. A package.json or README is not an executable skill.");
  const skillContent = decodeSkillText(effectiveSkillMd.content);
  const manifest = parseSkillManifest(skillContent);
  const packagePrefix = effectiveSkillMd.path.slice(0, -"SKILL.md".length);

  console.log(
    `[skill-import] Parsed tarball manifest: name="${manifest.name}" version="${manifest.version ?? "unversioned"}"`,
  );

  // Collect files from allowed subdirectories
  const ALLOWED_DIR_PATTERN = /^(scripts|references|assets)\//;

  const files: ImportedSkillFile[] = entries
    .filter(entry => entry.path.startsWith(packagePrefix))
    .map(entry => ({ ...entry, path: entry.path.slice(packagePrefix.length) }))
    .filter((entry) => {
      // Must be in an allowed subdirectory
      if (!ALLOWED_DIR_PATTERN.test(entry.path)) return false;
      if (!imageMimeFor(entry.path) && isBinaryFile(entry.path)) throw new SkillImportError("unsupported_source", `Binary attachment ${entry.path} is not supported; no partial import was saved.`);
      return true;
    })
    .map((entry) => {
      const imageMime = imageMimeFor(entry.path);
      return imageMime
        ? { filePath: entry.path, content: entry.content.toString("base64"), mimeType: imageMime }
        : { filePath: entry.path, content: decodeSkillText(entry.content), mimeType: detectMimeType(entry.path) };
    });

  console.log(
    `[skill-import] Tarball import complete: ${files.length} files collected from ${url}`,
  );

  return validateImportedSkill({
    manifest,
    skillContent,
    files,
    sourceUrl: url,
  });
}

// ── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Import a skill from a URL. Automatically detects the source type and
 * delegates to the appropriate importer.
 *
 * @param url GitHub repo URL or tarball URL
 * @returns Parsed skill with manifest, content, and associated files
 * @throws SkillImportError for all import failures
 *
 * @example
 * ```ts
 * const skill = await importSkillFromUrl("https://github.com/user/repo/tree/main/skills/my-skill");
 * console.log(skill.manifest.name); // "my-skill"
 * ```
 */
export async function importSkillFromUrl(url: string): Promise<ImportedSkill> {
  const source = detectImportSource(url);

  console.log(`[skill-import] Import requested: url="${url}" detected="${source}"`);

  switch (source) {
    case "github":
      return importFromGitHub(url);

    case "npm-tarball":
      return importFromTarballUrl(url);

    case "zip":
      // TODO: Implement ZIP support when needed
      throw new SkillImportError(
        "unsupported_source",
        "ZIP import is not yet supported. Use a GitHub URL or npm tarball (.tgz) instead.",
      );

    case "unknown":
      throw new SkillImportError(
        "unsupported_source",
        `Unsupported import URL format: ${url}. Supported: GitHub repos, npm tarballs (.tgz/.tar.gz)`,
      );
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSkillText(buffer: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (text.includes("\0")) throw new Error("binary NUL");
    return text;
  } catch {
    throw new SkillImportError("manifest_validation_error", "Skill instructions and attachments must be valid UTF-8 text; binary data cannot be imported as text.");
  }
}

/** Reject incomplete/unsafe imports before any persistence (including marketplace JSON). */
export function validateImportedSkill(imported: ImportedSkill): ImportedSkill {
  parseSkillManifest(imported.skillContent);
  const parsed = skillCreateRequestSchema.safeParse({ name: imported.manifest.name,
    description: imported.manifest.description, category: "custom", skillContent: imported.skillContent, files: imported.files });
  if (!parsed.success) throw new SkillImportError("manifest_validation_error", "Skill package has unsafe or duplicate paths, invalid text, or exceeds its file/size limits.");
  return imported;
}

/** Streaming byte limit applies before JSON parsing, even without Content-Length. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw new SkillImportError("github_fetch_error", "Remote JSON response exceeds its size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SkillImportError("github_fetch_error", "Remote response is empty.");
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SkillImportError("github_fetch_error", "Remote JSON response exceeds its size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}

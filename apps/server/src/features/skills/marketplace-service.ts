/**
 * npm registry discovery is not a reviewed skills catalog.
 * Install only the requested package's published tarball. Never guess a
 * different GitHub/skills.sh package when that tarball has no valid SKILL.md.
 */
import { marketplaceInstallRequestSchema } from "@loomic/shared";
import { importFromTarballUrl, readBoundedJson, SkillImportError, type ImportedSkill } from "./skill-import-service.js";

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 15_000;
export class MarketplaceError extends Error {
  constructor(public readonly code: "search_failed" | "package_not_found" | "install_failed", message: string) {
    super(message); this.name = "MarketplaceError";
  }
}
export interface MarketplaceSkill {
  packageName: string; name: string; description: string; author: string; version: string;
  downloads: number; keywords: string[]; homepage?: string; repository?: string; license?: string;
}
export interface MarketplaceSearchResult { skills: MarketplaceSkill[]; total: number }
export interface MarketplaceSkillDetail extends MarketplaceSkill { readme: string; versions: string[]; tarballUrl: string; repoUrl?: string }
async function registryJson(url: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Loomic-Marketplace/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error",
  });
  if (response.status === 404) throw new MarketplaceError("package_not_found", "Package not found in the npm registry.");
  if (!response.ok) throw new MarketplaceError("search_failed", "The npm registry request failed.");
  const result = await readBoundedJson(response, 8 * 1024 * 1024);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new MarketplaceError("search_failed", "Malformed registry response.");
  return result as Record<string, any>;
}
const asText = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const asStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
function externalLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
export async function searchMarketplace(query: string, page = 1, limit = 20): Promise<MarketplaceSearchResult> {
  if (query.length > 200 || !Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new MarketplaceError("search_failed", "Invalid registry search parameters.");
  }
  const params = new URLSearchParams({ text: ("keywords:agent-skill " + query.trim()).trim(), size: String(limit), from: String((page - 1) * limit) });
  const data = await registryJson(NPM_REGISTRY_BASE + "/-/v1/search?" + params);
  if (!Array.isArray(data.objects) || data.objects.length > 50 || typeof data.total !== "number") {
    throw new MarketplaceError("search_failed", "Malformed registry search response.");
  }
  const skills: MarketplaceSkill[] = data.objects.map((obj: any) => {
    const pkg = obj.package ?? {};
    const result: MarketplaceSkill = {
      packageName: asText(pkg.name), name: asText(pkg.name), description: asText(pkg.description),
      author: typeof pkg.author === "string" ? pkg.author : asText(pkg.author?.name, "unknown"),
      version: asText(pkg.version), downloads: 0, keywords: asStrings(pkg.keywords),
    };
    // npm popularity score is NOT a download count; unknown counts remain 0.
    const homepage = externalLink(pkg.links?.homepage); if (homepage) result.homepage = homepage;
    const repository = externalLink(pkg.links?.repository); if (repository) result.repository = repository;
    return result;
  });
  return { skills, total: data.total };
}
export async function getMarketplaceDetail(packageName: string): Promise<MarketplaceSkillDetail> {
  marketplaceInstallRequestSchema.parse({ packageName });
  const data = await registryJson(NPM_REGISTRY_BASE + "/" + encodeURIComponent(packageName));
  if (data.name !== packageName) throw new MarketplaceError("package_not_found", "Registry package identity did not match the requested name.");
  const version = asText(data["dist-tags"]?.latest);
  const latest = data.versions?.[version];
  if (!version || !latest || latest.name !== packageName) throw new MarketplaceError("package_not_found", "No matching published package version was found.");
  const tarballUrl = externalLink(latest.dist?.tarball) ?? "";
  if (tarballUrl && new URL(tarballUrl).hostname !== "registry.npmjs.org") throw new MarketplaceError("install_failed", "Package tarball must be hosted by the npm registry.");
  const result: MarketplaceSkillDetail = {
    packageName, name: packageName, description: asText(latest.description, asText(data.description)),
    author: typeof latest.author === "string" ? latest.author : asText(latest.author?.name, "unknown"),
    version, downloads: 0, keywords: asStrings(latest.keywords), readme: asText(data.readme),
    versions: Object.keys(data.versions ?? {}).slice(-1000), tarballUrl,
  };
  if (typeof latest.license === "string") result.license = latest.license;
  const homepage = externalLink(latest.homepage); if (homepage) result.homepage = homepage;
  const repository = externalLink(typeof latest.repository === "string" ? latest.repository : latest.repository?.url);
  if (repository) result.repository = repository;
  return result;
}
export async function installFromMarketplace(packageName: string): Promise<{ imported: ImportedSkill; packageName: string }> {
  const detail = await getMarketplaceDetail(packageName);
  if (!detail.tarballUrl) throw new MarketplaceError("install_failed", "The requested package has no published tarball.");
  try {
    const imported = await importFromTarballUrl(detail.tarballUrl);
    return { imported, packageName };
  } catch (error) {
    if (error instanceof SkillImportError) throw new MarketplaceError("install_failed", "The requested npm package is not a complete supported skill: " + error.message);
    throw error;
  }
}

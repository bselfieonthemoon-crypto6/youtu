import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { promptLibraryEntrySchema, promptLibrarySourceSchema, promptPreviewUrlSchema } from '../packages/shared/dist/index.js';

// Reviewed, immutable data revision. Advancing it requires reviewing licensing,
// source metadata and the resulting diff. No startup sync or browser scraping.
export const REGISTRY_REVISION = 'bc5dd581b2d910209b965b9e77f47ff48a9eddcc';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'apps/server/data/prompt-library');
const baseUrl = `https://raw.githubusercontent.com/yukkcat/image-prompts/${REGISTRY_REVISION}/dist/`;
const digest = value => createHash('sha256').update(value).digest('hex');

export function classifyPrompt(title, tags, prompt = '') {
  const primary = `${title} ${tags.join(' ')}`;
  const rules = [
    ['Logo / 品牌', /\blogo\b|品牌标志|商标|徽标|标识设计|brand identity/i],
    ['字体 / 排版', /字体|字形|排版|文字设计|typography|lettering|wordmark/i],
    ['轮播 / 社媒', /轮播|社交|小红书|朋友圈|carousel|social media|instagram|slide deck/i],
    ['海报 / 宣传', /海报|宣传|传单|广告|poster|flyer|advertis/i],
    ['产品 / 电商', /产品|商品|电商|包装|product|packaging|e-commerce|mockup/i],
    ['图片编辑', /抠图|去除背景|分层|去背景|修复|换装|换色|背景替换|remove background|retouch|image edit/i],
    ['摄影 / 人像', /人像|写真|摄影|portrait|photograph|headshot/i],
    ['插画 / 角色', /插画|角色|卡通|漫画|手绘|illustrat|character|cartoon|comic/i],
    ['空间 / 场景', /建筑|室内|场景|景观|architecture|interior|landscape/i],
  ];
  return rules.find(([, pattern]) => pattern.test(primary))?.[0]
    ?? rules.find(([, pattern]) => pattern.test(prompt.slice(0, 600)))?.[0]
    ?? '其他创意';
}

export function normalizePrompt(record, source) {
  if (!record || record.sourceId !== source.id || typeof record.id !== 'string'
      || typeof record.prompt !== 'string' || !record.prompt.trim()) {
    throw new Error(`Invalid upstream prompt in reviewed source ${source.id}`);
  }
  const tags = Array.isArray(record.tags)
    ? [...new Set(record.tags.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].slice(0, 20)
    : [];
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '未命名提示词';
  let sourceUrl = source.url;
  if (typeof record.sourceUrl === 'string' && record.sourceUrl.trim()) {
    try {
      const link = new URL(record.sourceUrl);
      if (link.protocol === 'https:' && !link.username && !link.password && !link.port
          && !link.hostname.match(/^(localhost|127\.|0\.|10\.|192\.168\.)/i)) sourceUrl = link.href;
    } catch { /* Invalid upstream links fall back to the verified source. */ }
  }
  const author = typeof record.author === 'string' ? record.author.trim() : '';
  const modelHint = typeof record.imageModel === 'string' ? record.imageModel.trim() : '';
  // Upstream referenceImageUrls are examples, sometimes inputs, sometimes
  // results. Preserve only their public URLs in a DISPLAY gallery. Never copy
  // them into user generation inputs or download the image files at import.
  const previewImageUrls = [...new Set([
    record.coverUrl,
    ...(Array.isArray(record.referenceImageUrls) ? record.referenceImageUrls : []),
  ].filter(value => typeof value === 'string' && promptPreviewUrlSchema.safeParse(value).success))].slice(0, 8);
  const requiresReference = record.imageMode === 'edit'
    || /参考图|原图|上传的?(?:图|照片)|输入图|提供的?(?:图|照片)|reference (?:image|photo)|uploaded (?:image|photo)|attached (?:image|photo)|provided (?:image|photo)/i.test(record.prompt);
  return promptLibraryEntrySchema.parse({
    id: `${source.id}-${digest(record.id).slice(0, 20)}`,
    title, prompt: record.prompt, tags, category: classifyPrompt(title, tags, record.prompt),
    sourceId: source.id, sourceUrl, ...(author ? { author } : {}),
    modelHints: modelHint ? [modelHint] : [], requiresReference,
    ...(previewImageUrls.length ? { imageUrl: previewImageUrls[0], previewImageUrls } : {}),
  });
}

async function fetchReviewedFile(relativePath) {
  if (!/^(manifest\.json|sources\/[a-z0-9-]+\.json)$/.test(relativePath)) throw new Error('Unapproved registry path');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${baseUrl}${relativePath}`, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4_000_000) throw new Error('Registry payload unavailable or too large');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 4_000_000) { await reader.cancel(); throw new Error('Registry payload too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

export function validateCatalog(catalog) {
  if (!catalog || typeof catalog.version !== 'string' || !catalog.version
      || catalog.version.length > 100 || Object.keys(catalog).some(key => !['version', 'sources', 'items'].includes(key))
      || !Array.isArray(catalog.sources) || catalog.sources.length !== 7
      || !Array.isArray(catalog.items) || !catalog.items.length || catalog.items.length > 10000
      || Buffer.byteLength(JSON.stringify(catalog), 'utf8') > 32 * 1024 * 1024) throw new Error('Invalid local catalog');
  const sources = catalog.sources.map(source => promptLibrarySourceSchema.parse(source));
  const items = catalog.items.map(item => promptLibraryEntrySchema.parse(item));
  if (new Set(items.map(item => item.category)).size > 40) throw new Error('Too many categories');
  if (new Set(sources.map(source => source.id)).size !== sources.length || new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate catalog identity');
  for (const item of items) {
    if (!sources.some(source => source.id === item.sourceId && source.status === 'available')) throw new Error('Unreviewed prompt source');
    if (item.previewImageUrls?.length && item.imageUrl !== item.previewImageUrls[0]) throw new Error('Preview cover/gallery mismatch');
    if (item.previewImageUrls && new Set(item.previewImageUrls).size !== item.previewImageUrls.length) throw new Error('Duplicate preview URL');
  }
  for (const source of sources) {
    const count = items.filter(item => item.sourceId === source.id).length;
    if (count !== source.entryCount || (source.status === 'link_only' && count !== 0)) throw new Error('Source count mismatch');
  }
  return { version: catalog.version, sources, items };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--refresh', '--check'].includes(arg)) || args.length > 1) throw new Error('Use --check (offline default) or --refresh (reviewed import)');
  if (!args.includes('--refresh')) {
    const serialized = await readFile(path.join(dataDir, 'catalog.json'), 'utf8');
    if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024 * 1024) throw new Error('Local catalog exceeds service size limit');
    const catalog = validateCatalog(JSON.parse(serialized));
    const review = JSON.parse(await readFile(path.join(dataDir, 'import-report.json'), 'utf8'));
    if (digest(JSON.stringify(catalog)) !== review.catalogSha256) throw new Error('Local catalog hash no longer matches import report');
    console.log(JSON.stringify({ valid: true, version: catalog.version, sources: catalog.sources.length, entries: catalog.items.length, networkRequests: 0 }));
    return;
  }
  const reviewedSources = JSON.parse(await readFile(path.join(root, 'scripts/prompt-library-sources.json'), 'utf8'));
  if (!Array.isArray(reviewedSources) || reviewedSources.length !== 7) throw new Error('Missing reviewed source metadata');
  const manifestBytes = await fetchReviewedFile('manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.sources.length !== 7) throw new Error('Registry schema changed; review before importing');
  const items = []; const sources = []; const sourceChecks = [];
  for (const reviewed of reviewedSources) {
    const definition = promptLibrarySourceSchema.parse({ ...reviewed, entryCount: 0 });
    const upstream = manifest.sources.find(source => source.id === definition.id);
    if (!upstream || upstream.path !== `sources/${definition.id}.json`) throw new Error(`Registry source changed: ${definition.id}`);
    if (definition.status === 'link_only') { sources.push(definition); continue; }
    const bytes = await fetchReviewedFile(upstream.path);
    if (digest(bytes) !== upstream.sha256) throw new Error(`Checksum failed: ${definition.id}`);
    const records = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(records) || records.length !== upstream.count) throw new Error(`Count failed: ${definition.id}`);
    const normalized = records.map(record => normalizePrompt(record, definition));
    items.push(...normalized);
    sources.push({ ...definition, entryCount: normalized.length });
    sourceChecks.push({ id: definition.id, count: records.length, bytes: bytes.length, sha256: upstream.sha256 });
  }
  const catalog = validateCatalog({ version: `2026-09-09-previews-${REGISTRY_REVISION.slice(0, 12)}`, sources, items });
  const report = {
    registry: 'https://github.com/yukkcat/image-prompts', registryRevision: REGISTRY_REVISION,
    generatedAt: manifest.generatedAt, manifestSha256: digest(manifestBytes), registryTotal: manifest.total,
    importedTotal: items.length, omittedSources: sources.filter(source => source.status === 'link_only').map(source => source.id),
    catalogSha256: digest(JSON.stringify(catalog)), sourceChecks,
    modifications: ['Category inference', 'Stable local identifiers', 'Model and reference labels are hints only', 'Public source image URLs retained for on-demand browser previews; no image files downloaded or stored', 'Example galleries never become generation inputs', 'Prompt text preserved without translation or rewriting'],
    entriesWithCover: items.filter(item => item.imageUrl).length,
    entriesWithGallery: items.filter(item => (item.previewImageUrls?.length ?? 0) > 1).length,
    downloadedImages: 0, generatedImages: 0, userDataUploaded: false,
  };
  // Fully validate all reviewed sources first. Failed imports never replace the
  // previous working catalog. Generated data writes, not third-party execution.
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'catalog.pending.json'), JSON.stringify(catalog, null, 2) + '\n');
  await writeFile(path.join(dataDir, 'import-report.pending.json'), JSON.stringify(report, null, 2) + '\n');
  await rename(path.join(dataDir, 'catalog.pending.json'), path.join(dataDir, 'catalog.json'));
  await rename(path.join(dataDir, 'import-report.pending.json'), path.join(dataDir, 'import-report.json'));
  console.log(JSON.stringify({ imported: items.length, sources: sourceChecks, version: catalog.version, downloadedImages: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

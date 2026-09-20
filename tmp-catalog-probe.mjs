import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile('skills/catalog.json', 'utf8'));
const base = ['schemaVersion', 'execution', 'intents', 'outputKinds', 'requiredTools', 'optionalTools', 'models', 'limitations', 'examples', 'sources'];
for (const slug of catalog.skills) {
  const manifest = JSON.parse(await readFile(`skills/${slug}/manifest.json`, 'utf8'));
  const meta = manifest.metadata.loomic;
  const allowed = [...base,
    ...('composition' in meta ? ['composition'] : []),
    ...('capabilities' in meta ? ['capabilities'] : []),
    ...('attachWorkspaceLibrary' in meta ? ['attachWorkspaceLibrary'] : []),
    ...('routing' in meta ? ['routing'] : [])];
  const unknown = Object.keys(meta).filter(key => !allowed.includes(key));
  const routingUnknown = meta.routing ? Object.keys(meta.routing).filter(key => !['keywords', 'priority'].includes(key)) : [];
  if (unknown.length || routingUnknown.length) console.log(slug, 'meta-unknown=', JSON.stringify(unknown), 'routing-unknown=', JSON.stringify(routingUnknown));
}
console.log('probe done');

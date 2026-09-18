import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrompt, normalizePrompt, validateCatalog } from './import-prompt-library.mjs';
const source = { id: 'example', url: 'https://github.com/example/prompts' };
const record = { id: 'example:1', sourceId: 'example', title: '海报样板', prompt: '用原图创建海报\n不改变产品', tags: ['海报'], author: '原作者', sourceUrl: 'https://example.com/case', imageModel: 'gpt-image-2', coverUrl: 'https://example.com/large.png', referenceImageUrls: ['https://example.com/large.png'] };
describe('reviewed prompt import', () => {
  it('preserves original prompt, author, model and safe source', () => {
    const actual = normalizePrompt(record, source);
    assert.equal(actual.prompt, record.prompt); assert.equal(actual.author, record.author);
    assert.equal(actual.sourceUrl, record.sourceUrl); assert.deepEqual(actual.modelHints, ['gpt-image-2']);
    assert.equal(actual.requiresReference, true); assert.equal(actual.category, '海报 / 宣传');
  });
  it('preserves remote preview URLs without turning examples into generation inputs', () => {
    const actual = normalizePrompt(record, source);
    assert.equal(actual.imageUrl, record.coverUrl);
    assert.deepEqual(actual.previewImageUrls, [record.coverUrl]);
    assert.equal('referenceImageUrls' in actual, false); assert.equal('inputImages' in actual, false);
  });
  it('keeps a bounded unique gallery with cover first and rejects unsafe endpoints', () => {
    const actual = normalizePrompt({ ...record, referenceImageUrls: [record.coverUrl, 'http://example.com/a', 'https://127.0.0.1/a', 'https://metadata.google.internal/a', 'https://user:pass@example.com/a', 'https://image.example.com/2.png', ...Array.from({ length: 12 }, (_, i) => `https://image.example.com/${i + 3}.png`)] }, source);
    assert.equal(actual.previewImageUrls.length, 8);
    assert.deepEqual(actual.previewImageUrls.slice(0, 2), [record.coverUrl, 'https://image.example.com/2.png']);
  });
  it('uses the first safe source example if the cover is missing and permits genuinely imageless entries', () => {
    assert.equal(normalizePrompt({ ...record, coverUrl: '', referenceImageUrls: ['https://example.com/reference.png'] }, source).imageUrl, 'https://example.com/reference.png');
    const empty = normalizePrompt({ ...record, coverUrl: '', referenceImageUrls: [] }, source);
    assert.equal(empty.imageUrl, undefined); assert.equal(empty.previewImageUrls, undefined);
  });
  it('does not infer reference inputs from an upstream results gallery', () => {
    assert.equal(normalizePrompt({ ...record, prompt: 'Create a poster' }, source).requiresReference, false);
  });
  it('produces stable identities separate from titles', () => {
    assert.equal(normalizePrompt(record, source).id, normalizePrompt({ ...record, title: 'new' }, source).id);
    assert.notEqual(normalizePrompt(record, source).id, normalizePrompt({ ...record, id: 'example:2' }, source).id);
  });
  it('rejects empty/oversized prompts and source identity mismatches without truncating them', () => {
    for (const patch of [{ prompt: ' ' }, { prompt: 'a'.repeat(24001) }, { sourceId: 'another' }]) assert.throws(() => normalizePrompt({ ...record, ...patch }, source));
  });
  it('falls back to reviewed source for credentialed or unsafe links', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com', 'https://127.0.0.1/test', 'invalid']) assert.equal(normalizePrompt({ ...record, sourceUrl: url }, source).sourceUrl, source.url);
  });
  it('classifies title/tags before incidental terms in the body', () => {
    assert.equal(classifyPrompt('Product mockup', [], 'No logos, no portraits'), '产品 / 电商');
    assert.equal(classifyPrompt('小红书轮播', []), '轮播 / 社媒');
    assert.equal(classifyPrompt('Brand logo', []), 'Logo / 品牌');
    assert.equal(classifyPrompt('Abstract', []), '其他创意');
  });
  it('rejects deployment envelopes that the serving API cannot accept', () => {
    const item = normalizePrompt(record, source);
    const sources = Array.from({ length: 7 }, (_, index) => ({ id: index ? `link-${index}` : 'example', name: 'Source', url: source.url, license: 'MIT', attribution: 'Author', note: 'Reviewed', status: index ? 'link_only' : 'available', entryCount: index ? 0 : 1 }));
    const catalog = { version: '1', items: [item], sources };
    assert.equal(validateCatalog(catalog).items.length, 1);
    assert.throws(() => validateCatalog({ ...catalog, version: 'v'.repeat(101) }));
    assert.throws(() => validateCatalog({ ...catalog, metadata: 'unknown envelope property' }));
    assert.throws(() => validateCatalog({ ...catalog, items: Array(10001).fill(item) }));
    assert.throws(() => validateCatalog({ ...catalog, items: [{ ...item, prompt: 'x'.repeat(33 * 1024 * 1024) }] }));
    assert.throws(() => validateCatalog({ ...catalog, sources: sources.map(value => value.id === 'example' ? { ...value, entryCount: 41 } : value), items: Array.from({ length: 41 }, (_, i) => ({ ...item, id: `example-${i}`, category: `category-${i}` })) }));
  });
});

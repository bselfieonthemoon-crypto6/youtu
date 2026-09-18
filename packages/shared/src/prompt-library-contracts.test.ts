import { describe, expect, it } from 'vitest';
import { promptLibraryEntrySchema, promptLibraryResponseSchema, promptLibrarySourceSchema } from './prompt-library-contracts.js';
const source = { id: 'source', name: 'Source', url: 'https://example.com/source', license: 'MIT', attribution: 'Author', status: 'available', note: 'Reviewed', entryCount: 1 };
const entry = { id: 'prompt-1', title: 'Logo', prompt: 'Create a logo', category: 'Logo / 品牌', tags: [], sourceId: 'source', sourceUrl: 'https://example.com/prompt', modelHints: ['gpt-image-2'], requiresReference: false };
describe('public prompt library contracts', () => {
  it('preserves full prompt text, author, origin and model hints', () => {
    const value = { ...entry, prompt: 'one\n\ntwo', author: 'Original author' };
    expect(promptLibraryEntrySchema.parse(value)).toEqual(value);
  });
  it.each(['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com/a', 'https://example.com\\@evil.test/a', 'https://example.com/a b'])('rejects unsafe source link %s', url => {
    expect(promptLibrarySourceSchema.safeParse({ ...source, url }).success).toBe(false);
    expect(promptLibraryEntrySchema.safeParse({ ...entry, sourceUrl: url }).success).toBe(false);
  });
  it('removes unknown private/provider fields from public entries', () => {
    expect(promptLibraryEntrySchema.parse({ ...entry, apiKey: 'private', input_images: ['private-source'], systemInstruction: 'untrusted' })).toEqual(entry);
  });
  it('bounds prompt and page sizes', () => {
    expect(promptLibraryEntrySchema.safeParse({ ...entry, prompt: 'x'.repeat(24001) }).success).toBe(false);
    expect(promptLibraryResponseSchema.safeParse({ version: '1', items: Array(49).fill(entry), total: 49, nextOffset: null, sources: [source], categories: ['Logo'] }).success).toBe(false);
  });
  it('requires explicit source availability', () => {
    expect(promptLibrarySourceSchema.safeParse({ ...source, status: 'unknown' }).success).toBe(false);
    expect(promptLibrarySourceSchema.parse({ ...source, status: 'link_only', entryCount: 0 }).status).toBe('link_only');
  });
  it('preserves a bounded remote preview gallery without generation inputs', () => {
    const value = { ...entry, imageUrl: 'https://images.example.com/cover.png', previewImageUrls: ['https://images.example.com/cover.png', 'https://images.example.com/2.png'] };
    expect(promptLibraryEntrySchema.parse(value)).toEqual(value);
    expect(promptLibraryEntrySchema.safeParse({ ...value, previewImageUrls: Array(9).fill(value.imageUrl) }).success).toBe(false);
  });
  it.each(['https://127.0.0.1/a', 'https://169.254.169.254/a', 'https://2130706433/a', 'https://0x7f.0.0.1/a', 'https://127%2e0.0.1/a', 'https://１２７.０.０.１/a', 'https://localhost./a', 'https://localhost/a', 'https://test.local/a', 'https://metadata.google.internal/a', 'data:image/png;base64,aaaa', 'file:///test.png'])('rejects non-public preview address %s', imageUrl => {
    expect(promptLibraryEntrySchema.safeParse({ ...entry, imageUrl }).success).toBe(false);
    expect(promptLibraryEntrySchema.safeParse({ ...entry, previewImageUrls: [imageUrl] }).success).toBe(false);
  });
});

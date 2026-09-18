import { describe, expect, it } from 'vitest';
import { nodeImageSubmissionRequestSchema, nodeImageSubmissionLookupSchema } from './node-image-contracts.js';

const input = { request_id: '6d52c6d1-269f-4bc0-9ab6-852a574f44cc', canvas_id: 'c1bfc5c7-7095-48e6-af86-09fcac307027',
  element_id: 'node-1', prompt: '  保留我的原文\n元旦  ', model: 'gpt-image-2', aspect_ratio: '1:1', quality: 'hd' };
describe('direct node image contracts', () => {
  it('preserves original prompt rather than rewriting it', () => {
    expect(nodeImageSubmissionRequestSchema.parse(input).prompt).toBe(input.prompt);
  });
  it.each(['input_images', 'price', 'confirmed', 'submissionRevision', 'job_id', 'target'])('rejects client-controlled extra field %s', key => {
    expect(nodeImageSubmissionRequestSchema.safeParse({ ...input, [key]: true }).success).toBe(false);
  });
  it.each([{ prompt: ' \n ' }, { prompt: 'a'.repeat(32769) }, { request_id: 'bad' }, { quality: null }, { aspect_ratio: '3:1' }])('rejects invalid submission %o', change => {
    expect(nodeImageSubmissionRequestSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
  it('requires complete scope for request recovery', () => {
    const lookup = { requestId: input.request_id, canvasId: input.canvas_id, elementId: input.element_id };
    expect(nodeImageSubmissionLookupSchema.safeParse(lookup).success).toBe(true);
    expect(nodeImageSubmissionLookupSchema.safeParse({ requestId: input.request_id }).success).toBe(false);
  });
});

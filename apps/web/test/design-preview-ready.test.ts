import { describe, expect, it } from 'vitest';
import { waitForDesignPreview } from '../src/lib/design-preview-ready';
import type { DesignDocumentDto } from '@loomic/shared';
const doc = (revision: number, preview: number, status = 'ready') => ({ revision, preview_revision: preview, preview_status: status, preview_asset_object_id: 'asset' }) as DesignDocumentDto;
describe('waitForDesignPreview', () => {
  it('waits past queue acknowledgement and stale images', async () => {
    const values = [doc(2, 1, 'queued'), doc(2, 2)];
    const result = await waitForDesignPreview(async () => values.shift()!, 2, { intervalMs: 0 });
    expect(result.preview_revision).toBe(2);
  });
  it('does not accept an older preview if another edit advances the document', async () => {
    const values = [doc(3, 2), doc(3, 3)];
    expect((await waitForDesignPreview(async () => values.shift()!, 2, { intervalMs: 0 })).preview_revision).toBe(3);
  });
  it('reports render failure and timeout rather than pretending completion', async () => {
    await expect(waitForDesignPreview(async () => doc(2, 1, 'error'), 2)).rejects.toThrow('预览生成失败');
    await expect(waitForDesignPreview(async () => doc(2, 1), 2, { timeoutMs: 0 })).rejects.toThrow('仍在生成');
  });
});

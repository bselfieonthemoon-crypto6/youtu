import { describe, it, expect, vi } from 'vitest';
const insert = vi.hoisted(() => vi.fn());
vi.mock('../canvas/canvas-element-writer.js', () => ({ insertImageElement: insert }));
import { reconcileSucceededImageJobs } from './job-canvas-finalizer.js';

describe('background canvas recovery asset lifecycle', () => {
  it.each(['deleted', 'missing', 'read_error', 'deleted_secondary_layer', 'foreign_workspace', 'live'])('respects asset lifecycle during historical recovery: %s', async state => {
    insert.mockReset();
    const job = { id: 'old-job', workspace_id: 'workspace', canvas_id: 'canvas', target_kind: 'canvas', job_type: 'image_generation',
      status: 'succeeded', session_id: null, payload: {}, result: { asset_id: 'gone', width: 1, height: 1,
        object_path: 'workspace/generated/gone.png', mime_type: 'image/png',
        ...(state === 'deleted_secondary_layer' ? { layers: [{ asset_id: 'secondary-gone' }] } : {}) } };
    insert.mockResolvedValue({ elementId: 'restored', inserted: true });
    const update = vi.fn(() => ({ eq: () => ({ eq: async () => ({ error: null }) }) }));
    const query: any = { update };
    const assets: any = { select: vi.fn(() => assets), in: vi.fn(() => assets),
      is: vi.fn(async () => ({ data: ['live', 'deleted_secondary_layer', 'foreign_workspace'].includes(state)
        ? [{ id: 'gone', workspace_id: state === 'foreign_workspace' ? 'other-workspace' : 'workspace' }]
        : [], error: state === 'read_error' ? {} : null })) };
    const admin = { rpc: vi.fn(async () => ({ data: [job], error: null })),
      from: vi.fn((table: string) => table === 'asset_objects' ? assets : query) };
    if (state === 'read_error') {
      await expect(reconcileSucceededImageJobs(admin as never)).rejects.toThrow('no canvas was modified');
    } else if (state === 'live') {
      await expect(reconcileSucceededImageJobs(admin as never)).resolves.toEqual({ checked: 1, finalized: 1, failed: 0 });
    } else {
      await expect(reconcileSucceededImageJobs(admin as never)).resolves.toEqual({ checked: 1, finalized: 0, failed: 0 });
    }
    expect(assets.is).toHaveBeenCalledWith('deletion_pending_at', null);
    if (state === 'live') {
      expect(insert).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith({ result: expect.objectContaining({ canvas_finalized_at: expect.any(String) }) });
    } else expect(insert).not.toHaveBeenCalled();
  });
});

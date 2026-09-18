import type { DesignDocumentDto } from '@loomic/shared';

/** Queue acceptance is not render completion. Poll authoritative preview state
 * so finishing an editor also works when the WebSocket notification is lost. */
export async function waitForDesignPreview(
  read: () => Promise<DesignDocumentDto>, revision: number,
  { timeoutMs = 60_000, intervalMs = 750 } = {},
): Promise<DesignDocumentDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const document = await read();
    if (document.preview_asset_object_id && document.preview_revision >= Math.max(revision, document.revision)) return document;
    if (document.preview_status === 'error') throw new Error('设计已保存，但预览生成失败。请重试完成，修改不会丢失。');
    if (Date.now() >= deadline) throw new Error('设计已保存，预览仍在生成。请稍后重试完成，修改不会丢失。');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

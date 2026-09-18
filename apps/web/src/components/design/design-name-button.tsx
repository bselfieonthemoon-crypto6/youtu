"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

export function DesignNameButton({ name, label, onRename }: {
  name: string; label?: string; onRename: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function save() {
    if (running.current) return;
    const next = draft.trim();
    if (!next || next.length > 200) { setError("请输入 1～200 个字符的画板名称。"); return; }
    running.current = true; setBusy(true); setError("");
    try { if (next !== name) await onRename(next); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "重命名失败，请重试。"); }
    finally { running.current = false; setBusy(false); }
  }
  return <>
    <button type="button" aria-label="重命名画板" title="点击修改画板名称" className="pointer-events-auto truncate text-left hover:underline"
      onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); setDraft(name); setError(""); setOpen(true); }}>{label ?? name}</button>
    {open && createPortal(<div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/20" onPointerDown={e => e.stopPropagation()}>
      <form role="dialog" aria-modal="true" aria-label="修改画板名称" className="w-80 rounded-xl border bg-background p-4 shadow-xl"
        onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape" && !busy) setOpen(false); }}>
        <label className="text-sm">画板名称<input autoFocus aria-label="画板名称" maxLength={200} disabled={busy} value={draft} onChange={e => setDraft(e.target.value)} className="mt-2 w-full rounded border bg-background p-2" /></label>
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3 flex justify-end gap-3"><button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button><button type="submit" disabled={busy}>{busy ? "保存中…" : "保存名称"}</button></div>
      </form>
    </div>, document.body)}
  </>;
}

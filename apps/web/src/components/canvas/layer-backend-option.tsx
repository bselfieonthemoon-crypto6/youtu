"use client";

import { useEffect, useRef, useState } from "react";
import { fetchLayerBackend, type LayerBackendStatus } from "../../lib/layer-backend";
import { Button } from "../ui/button";

/** A separate, explicit entry. Never switches the existing local splitter. */
export function LayerBackendOption({ accessToken, disabled = false, onRun }: {
  accessToken: string; disabled?: boolean; onRun: () => void;
}) {
  const [state, setState] = useState<{ token: string; value: LayerBackendStatus | null; loading: boolean; error: string | null }>({ token: "", value: null, loading: true, error: null });
  const [reload, setReload] = useState(0);
  const submitted = useRef(false);
  useEffect(() => {
    let canceled = false; submitted.current = false;
    setState({ token: accessToken, value: null, loading: true, error: null });
    if (!accessToken) { setState({ token: accessToken, value: null, loading: false, error: "请登录后检查专用分层服务。" }); return; }
    void fetchLayerBackend(accessToken).then((value) => { if (!canceled) setState({ token: accessToken, value, loading: false, error: null }); })
      .catch(() => { if (!canceled) setState({ token: accessToken, value: null, loading: false, error: "无法检查专用分层服务，请重试。" }); });
    return () => { canceled = true; };
  }, [accessToken, reload]);
  const matching = state.token === accessToken;
  const ready = matching && state.value?.configured === true && state.value.available === true;
  const loading = !matching || state.loading;
  return <div aria-label="专用模型分层" className="space-y-1 rounded-lg border border-border p-2 text-xs">
    <Button type="button" size="sm" variant="outline" className="w-full" disabled={disabled || loading || !ready}
      onClick={() => { if (!submitted.current && ready && !disabled) { submitted.current = true; try { onRun(); } finally { submitted.current = false; } } }}>Qwen 专用分层</Button>
    <p className="break-words text-muted-foreground">{loading ? "正在检查专用分层服务…" : state.error ?? state.value?.reason ?? "尚未配置专用分层服务。"}</p>
    {ready && <p className="text-muted-foreground">点击后将原图发送到{state.value?.remote ? "已配置的远程" : "已配置的"}专用服务，生成独立图层；不会改用本地简易拆分。外部服务或算力可能产生费用，不代表免费。</p>}
    {!loading && !ready && <button type="button" className="text-muted-foreground underline" onClick={() => setReload((count) => count + 1)}>重新检查</button>}
  </div>;
}

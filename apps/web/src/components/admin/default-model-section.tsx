"use client";

import type { ModelInfo } from "@loomic/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchModels, fetchWorkspaceSettings, updateWorkspaceSettings } from "@/lib/server-api";

/**
 * The workspace's default model, administered from the console rather than from the
 * signed-in user's own settings page.
 *
 * This project is self-hosted and the admin console is the only place model data is
 * configured, so the default model belongs here next to the channels it is drawn
 * from - a user's personal settings have no business picking it.
 *
 * Two behaviours are kept from the earlier implementation on purpose:
 *   * a saved model that is missing from the catalogue is NOT silently replaced. It
 *     stays selectable and the console says the catalogue cannot confirm it, because
 *     an absent option is not proof that the model stopped working.
 *   * a failed catalogue read blocks saving instead of writing a guess.
 */
export function DefaultModelSection({ accessToken }: { accessToken: string }) {
  const [savedModel, setSavedModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const lock = useRef(false);

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setLoadError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, catalogue] = await Promise.all([
        fetchWorkspaceSettings(accessToken),
        fetchModels(accessToken),
      ]);
      setSavedModel(settings.settings.defaultModel);
      setSelectedModel(settings.settings.defaultModel);
      setModels(catalogue.models);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "默认模型加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  const hasChanges = selectedModel !== savedModel;
  const unavailable = !loading && !loadError && selectedModel !== ""
    && !models.some((model) => model.id === selectedModel);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedModel || lock.current || loading || loadError || unavailable || !hasChanges) return;
    lock.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await updateWorkspaceSettings(accessToken, { defaultModel: selectedModel });
      setSavedModel(result.settings.defaultModel);
      setSelectedModel(result.settings.defaultModel);
      setFeedback({ type: "success", message: "默认模型已更新，新的 Agent 运行会使用它。" });
    } catch (caught) {
      setFeedback({
        type: "error",
        message: caught instanceof Error ? caught.message : "保存失败，请稍后重试。",
      });
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-default-model">
      <h3 className="text-sm font-medium">默认模型</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        工作区内所有新的 Agent 运行都会使用这个模型；可选项来自下面这些渠道里已发现的模型。
      </p>

      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground">正在加载默认模型…</p>
      ) : loadError ? (
        <div className="mt-3">
          <p className="text-sm text-destructive" data-testid="admin-default-model-error">{loadError}</p>
          <button type="button" onClick={() => void load()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
        </div>
      ) : (
        <form className="mt-3 max-w-md space-y-2" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">模型
            <select value={selectedModel} aria-label="默认模型" disabled={saving}
              onChange={event => setSelectedModel(event.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              {!models.some(model => model.id === selectedModel) && (
                <option value={selectedModel}>已保存模型（未列入目录）：{selectedModel || "—"}</option>
              )}
              {models.map(model => (
                <option key={model.id} value={model.id}>{model.name}（{model.provider}）</option>
              ))}
            </select>
          </label>

          {unavailable ? (
            <p role="alert" className="text-xs text-amber-700" data-testid="admin-default-model-unavailable">
              已保存的默认模型未列入可选目录。系统不会自动替换它——目录里没有并不能证明它已失效，
              可以保留原配置，也可以改选目录中的模型。
            </p>
          ) : null}

          {feedback ? (
            <p className={`text-sm ${feedback.type === "success" ? "text-emerald-600" : "text-destructive"}`}
              data-testid="admin-default-model-feedback">{feedback.message}</p>
          ) : null}

          <button type="submit" disabled={saving || !hasChanges || unavailable}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-50">
            {saving ? "保存中…" : "保存"}
          </button>
        </form>
      )}
    </section>
  );
}

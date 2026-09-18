"use client";

import type { ModelInfo } from "@loomic/shared";
import { useEffect, useRef, useState } from "react";

import { Button } from "./ui/button";
import { Label } from "./ui/label";

interface AgentSectionProps {
  defaultModel: string;
  onSave: (defaultModel: string) => Promise<void>;
  fetchModels: () => Promise<{ models: ModelInfo[] }>;
  canManage?: boolean;
}

export function AgentSection({
  defaultModel: initialModel,
  onSave,
  fetchModels,
  canManage = true,
}: AgentSectionProps) {
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const lock = useRef(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const hasChanges = selectedModel !== initialModel;
  const unavailable = !modelsLoading && !modelsError && !models.some((model) => model.id === selectedModel);
  useEffect(() => { setSelectedModel(initialModel); }, [initialModel]);

  useEffect(() => {
    let canceled = false;
    setModelsLoading(true); setModelsError(false);
    fetchModels()
      .then((data) => {
        if (!canceled) setModels(data.models);
      })
      .catch(() => { if (!canceled) { setModels([]); setModelsError(true); } })
      .finally(() => { if (!canceled) setModelsLoading(false); });
    return () => { canceled = true; };
  }, [fetchModels]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedModel || !canManage || lock.current || modelsLoading || modelsError || unavailable) return;

    lock.current = true;
    setSaving(true);
    setFeedback(null);

    try {
      await onSave(selectedModel);
      setFeedback({ type: "success", message: "Agent settings updated." });
    } catch {
      setFeedback({
        type: "error",
        message: "Failed to update settings. Please try again.",
      });
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Agent</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure the default AI model for your workspace.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
        <div className="space-y-2">
          <Label htmlFor="defaultModel">Default Model</Label>
          {modelsLoading ? (
            <p className="text-sm text-muted-foreground">Loading models...</p>
          ) : (
            <select
              id="defaultModel"
              value={selectedModel}
              disabled={!canManage || saving || modelsError}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {!models.some((model) => model.id === selectedModel) && <option value={selectedModel}>{modelsError ? "已保存配置" : "已保存模型（未列入目录）"}：{selectedModel}</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.provider})
                </option>
              ))}
            </select>
          )}
          {modelsError && <p role="alert" className="text-xs text-destructive">模型目录读取失败，当前配置未更改，请刷新后重试。</p>}
          {unavailable && <p role="alert" className="text-xs text-amber-700">当前默认模型未列入可选目录，系统未替换它；仅凭目录无法确认它是否失效，可保留原配置或手动选择目录中的模型。</p>}
          {!canManage && <p className="text-xs text-muted-foreground">仅工作区所有者和管理员可以修改默认模型。</p>}
          <p className="text-xs text-muted-foreground">
            This model will be used for all new agent runs in your workspace.
          </p>
        </div>

        {feedback && (
          <p
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={!canManage || saving || !hasChanges || modelsLoading || modelsError || unavailable} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>
    </div>
  );
}

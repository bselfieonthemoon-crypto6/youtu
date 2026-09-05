"use client";

import type {
  ProviderCapability,
  ProviderConfigCreateRequest,
  ProviderModelInput,
  WorkspaceProviderConfig,
} from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  createProviderConfig,
  deleteProviderConfig,
  discoverProviderModels,
  fetchProviderConfigs,
  testProviderConnection,
  updateProviderConfig,
} from "../../lib/server-api";

const CAPABILITIES: Array<{ id: ProviderCapability; label: string }> = [
  { id: "text", label: "文本" },
  { id: "vision_input", label: "图片理解" },
  { id: "image_generation", label: "图片生成" },
  { id: "video_generation", label: "视频生成" },
];

const NEW_MODEL: ProviderModelInput = {
  upstreamModelId: "",
  displayName: "",
  modality: "text",
  enabled: true,
  capabilities: ["text"],
};

export function ProviderSettingsSection({ accessToken }: { accessToken: string }) {
  const [configs, setConfigs] = useState<WorkspaceProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkspaceProviderConfig | "new" | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<Record<string, string>>({});
  const [testFeedback, setTestFeedback] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchProviderConfigs(accessToken);
      setConfigs(response.configs);
    } catch (caught) {
      setError(providerErrorMessage(caught, "供应商配置加载失败，请稍后重试。"));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  async function handleTest(config: WorkspaceProviderConfig) {
    setTestingId(config.id);
    setTestFeedback((current) => ({ ...current, [config.id]: { ok: true, text: "正在测试连接…" } }));
    try {
      const result = await testProviderConnection(accessToken, config.id);
      setTestFeedback((current) => ({ ...current, [config.id]: { ok: true, text: "连接成功" } }));
      setConfigs((current) => current.map((item) => item.id === config.id
        ? { ...item, lastTestStatus: "succeeded", lastTestedAt: result.testedAt }
        : item));
    } catch (caught) {
      setTestFeedback((current) => ({
        ...current,
        [config.id]: { ok: false, text: providerErrorMessage(caught, "连接失败，请检查地址、密钥和模型。") },
      }));
      setConfigs((current) => current.map((item) => item.id === config.id
        ? { ...item, lastTestStatus: "failed" }
        : item));
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete(config: WorkspaceProviderConfig) {
    setDeletingId(config.id);
    setDeleteFeedback((current) => ({ ...current, [config.id]: "" }));
    try {
      await deleteProviderConfig(accessToken, config.id);
      setConfigs((current) => current.filter((item) => item.id !== config.id));
      setConfirmDeleteId(null);
    } catch (caught) {
      setDeleteFeedback((current) => ({
        ...current,
        [config.id]: providerErrorMessage(caught, "删除失败，请稍后重试。"),
      }));
    } finally {
      setDeletingId(null);
    }
  }

  if (editing) {
    return (
      <ProviderForm
        accessToken={accessToken}
        initial={editing === "new" ? null : editing}
        onCancel={() => {
          setEditing(null);
          void load();
        }}
        onSaved={(config) => {
          setConfigs((current) => {
            const exists = current.some((item) => item.id === config.id);
            return exists
              ? current.map((item) => item.id === config.id ? config : item)
              : [config, ...current];
          });
          setEditing(null);
        }}
      />
    );
  }

  return (
    <section aria-labelledby="provider-settings-heading">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 id="provider-settings-heading" className="text-lg font-semibold">模型供应商</h2>
          <p className="mt-1 text-sm text-muted-foreground">管理工作区的 OpenAI 兼容接口。密钥只写入，不会再次显示。</p>
        </div>
        <button type="button" onClick={() => setEditing("new")} className="shrink-0 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background hover:opacity-90">
          新增供应商
        </button>
      </div>

      {loading ? (
        <ProviderState text="正在加载供应商配置…" />
      ) : error ? (
        <ProviderState text={error} action="重试" onAction={() => void load()} />
      ) : configs.length === 0 ? (
        <ProviderState text="尚未配置供应商。新增后可保存并测试连接。" />
      ) : (
        <div className="space-y-3">
          {configs.map((config) => {
            const feedback = testFeedback[config.id];
            const status = feedback?.text ?? testStatusLabel(config.lastTestStatus);
            const ok = feedback?.ok ?? config.lastTestStatus !== "failed";
            return (
              <article key={config.id} className="rounded-xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">{config.displayName}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${config.enabled ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                        {config.enabled ? "已启用" : "已停用"}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{config.baseUrl}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      API Key：{config.hasApiKey ? `已配置 ••••${config.lastFour}` : "未配置"} · 模型 {config.models.length} 个
                    </p>
                    <p className={`mt-2 text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`} aria-live="polite">{status}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button type="button" onClick={() => setEditing(config)} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted">编辑</button>
                    <button type="button" onClick={() => setConfirmDeleteId(config.id)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10">删除</button>
                    <button type="button" disabled={testingId === config.id} onClick={() => void handleTest(config)} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
                      {testingId === config.id ? "测试中…" : "测试连接"}
                    </button>
                  </div>
                </div>
                {confirmDeleteId === config.id && (
                  <div role="alertdialog" aria-label={`确认删除 ${config.displayName}`} className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-xs text-foreground">确定删除“{config.displayName}”吗？此操作会移除该工作区供应商配置，无法撤销。</p>
                    <div className="mt-2 flex gap-2">
                      <button type="button" disabled={deletingId === config.id} onClick={() => void handleDelete(config)} className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50">
                        {deletingId === config.id ? "删除中…" : "确认删除"}
                      </button>
                      <button type="button" disabled={deletingId === config.id} onClick={() => setConfirmDeleteId(null)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">取消</button>
                    </div>
                  </div>
                )}
                {deleteFeedback[config.id] && <p role="alert" className="mt-2 text-xs text-destructive">{deleteFeedback[config.id]}</p>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProviderForm({
  accessToken,
  initial,
  onCancel,
  onSaved,
}: {
  accessToken: string;
  initial: WorkspaceProviderConfig | null;
  onCancel: () => void;
  onSaved: (config: WorkspaceProviderConfig) => void;
}) {
  const [savedConfig, setSavedConfig] = useState(initial);
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [models, setModels] = useState<ProviderModelInput[]>(
    initial?.models.length
      ? initial.models.map(({ upstreamModelId, displayName: name, modality, enabled: modelEnabled, capabilities }) => ({
          upstreamModelId,
          displayName: name,
          modality,
          enabled: modelEnabled,
          ...(capabilities ? { capabilities: [...capabilities] } : {}),
        }))
      : [],
  );
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [modalityFilter, setModalityFilter] = useState<"all" | ProviderModelInput["modality"]>("all");

  const visibleModels = models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => {
      const matchesType = modalityFilter === "all" || model.modality === modalityFilter;
      const query = modelQuery.trim().toLowerCase();
      return matchesType && (!query || model.upstreamModelId.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query));
    });

  function updateModel(index: number, next: ProviderModelInput) {
    setModels((current) => current.map((model, modelIndex) => modelIndex === index ? next : model));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFeedback(null);
    const normalizedUrl = normalizeHttpsUrl(baseUrl);
    if (!displayName.trim()) return setFeedback("请输入供应商名称。");
    if (!normalizedUrl) return setFeedback("Base URL 必须是有效的 HTTPS 地址。");
    if (!savedConfig && !apiKey.trim()) return setFeedback("新增供应商时必须填写 API Key。");
    if (models.some((model) => !model.upstreamModelId.trim() || !model.displayName.trim())) {
      return setFeedback("请完整填写每个模型的模型 ID 和显示名称。");
    }

    setSaving(true);
    try {
      const cleanModels = models.map((model) => ({
        ...model,
        upstreamModelId: model.upstreamModelId.trim(),
        displayName: model.displayName.trim(),
      }));
      if (!savedConfig) {
        const created = await createProviderConfig(accessToken, {
          displayName: displayName.trim(),
          baseUrl: normalizedUrl,
          apiKey: apiKey.trim(),
          enabled,
          models: cleanModels,
        } satisfies ProviderConfigCreateRequest);
        setSavedConfig(created.config);
        setApiKey("");
        try {
          await testProviderConnection(accessToken, created.config.id);
          const discovered = await discoverProviderModels(accessToken, created.config.id);
          setModels(mergeDiscoveredModels(discovered.models, cleanModels));
          setFeedback(`供应商连接已保存，并获取到 ${discovered.models.length} 个模型。请选择需要启用的模型并确认类型。`);
        } catch (caught) {
          setFeedback(providerErrorMessage(caught, "供应商已保存，但自动获取模型失败；可以检查连接或继续手动添加。"));
        }
        return;
      }
      const response = await updateProviderConfig(accessToken, savedConfig.id, {
            displayName: displayName.trim(),
            baseUrl: normalizedUrl,
            enabled,
            models: cleanModels,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          });
      setApiKey("");
      onSaved(response.config);
    } catch (caught) {
      setApiKey("");
      setFeedback(providerErrorMessage(caught, "保存失败，请检查内容后重试。"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDiscoverModels() {
    if (!savedConfig) return;
    setDiscovering(true);
    setFeedback(null);
    try {
      const tested = await testProviderConnection(accessToken, savedConfig.id);
      setSavedConfig((current) => current
        ? { ...current, lastTestStatus: "succeeded", lastTestedAt: tested.testedAt }
        : current);
      const response = await discoverProviderModels(accessToken, savedConfig.id);
      setModels(mergeDiscoveredModels(response.models, models));
      setFeedback(`连接成功，已从供应商获取 ${response.models.length} 个模型，请检查类型与能力后保存。`);
    } catch (caught) {
      setFeedback(providerErrorMessage(caught, "连接或获取模型失败，请检查地址和 API Key。"));
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <section aria-labelledby="provider-form-heading">
      <h2 id="provider-form-heading" className="text-lg font-semibold">{savedConfig ? "编辑供应商" : "新增供应商"}</h2>
      <p className="mt-1 text-sm text-muted-foreground">适用于 OpenAI API 格式兼容的模型服务。</p>
      <form className="mt-5 space-y-5" onSubmit={handleSubmit}>
        <Field label="供应商名称">
          <input aria-label="供应商名称" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={inputClass} placeholder="例如：API 易" />
        </Field>
        <Field label="Base URL">
          <input aria-label="Base URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className={inputClass} placeholder="https://api.example.com/v1" inputMode="url" />
        </Field>
        <Field label="API Key">
          <input aria-label="API Key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className={inputClass} placeholder={savedConfig?.hasApiKey ? `已配置 ••••${savedConfig.lastFour}；留空则保留` : "请输入 API Key"} />
          <p className="mt-1 text-[11px] text-muted-foreground">密钥只会写入服务器，编辑页面不会回显。{savedConfig ? "留空将保留现有密钥。" : ""}</p>
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用此供应商</label>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">模型与能力</h3>
            <div className="flex gap-2">
              {savedConfig && <button type="button" disabled={discovering} onClick={() => void handleDiscoverModels()} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50">{discovering ? "获取中…" : "重新获取"}</button>}
              <button type="button" onClick={() => setModels((current) => [...current, { ...NEW_MODEL, capabilities: [...(NEW_MODEL.capabilities ?? [])] }])} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted">手动添加</button>
            </div>
          </div>
          {!savedConfig && <p className="mb-3 text-xs text-muted-foreground">首次保存时会自动验证连接并从供应商获取模型；获取到的模型默认不启用。</p>}
          {models.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2">
              <span className="text-xs text-muted-foreground">共 {models.length} 个，当前显示 {visibleModels.length} 个，已启用 {models.filter((model) => model.enabled).length} 个</span>
              <input aria-label="搜索模型" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} className="h-8 min-w-44 flex-1 rounded-md border border-input bg-background px-2 text-xs" placeholder="搜索模型 ID 或名称" />
              <select aria-label="筛选模型类型" value={modalityFilter} onChange={(event) => setModalityFilter(event.target.value as typeof modalityFilter)} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                <option value="all">全部类型</option><option value="text">文本</option><option value="image">图片</option><option value="video">视频</option>
              </select>
              <button type="button" onClick={() => setModels((current) => current.map((model, index) => visibleModels.some((item) => item.index === index) ? { ...model, enabled: true } : model))} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">启用当前筛选</button>
              <button type="button" onClick={() => setModels((current) => current.map((model, index) => visibleModels.some((item) => item.index === index) ? { ...model, enabled: false } : model))} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">停用当前筛选</button>
            </div>
          )}
          <div className="space-y-3">
            {visibleModels.map(({ model, index }) => (
              <div key={index} className="rounded-xl border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <input aria-label={`模型 ${index + 1} ID`} value={model.upstreamModelId} onChange={(event) => updateModel(index, { ...model, upstreamModelId: event.target.value })} className={inputClass} placeholder="上游模型 ID" />
                  <input aria-label={`模型 ${index + 1} 显示名称`} value={model.displayName} onChange={(event) => updateModel(index, { ...model, displayName: event.target.value })} className={inputClass} placeholder="显示名称" />
                  <select aria-label={`模型 ${index + 1} 类型`} value={model.modality} onChange={(event) => updateModel(index, { ...model, modality: event.target.value as ProviderModelInput["modality"] })} className={inputClass}>
                    <option value="text">文本</option><option value="image">图片</option><option value="video">视频</option>
                  </select>
                  <label className="flex items-center gap-2 px-1 text-xs"><input type="checkbox" checked={model.enabled} onChange={(event) => updateModel(index, { ...model, enabled: event.target.checked })} />启用模型</label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {CAPABILITIES.map((capability) => {
                    const selected = model.capabilities?.includes(capability.id) ?? false;
                    return <label key={capability.id} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px]"><input type="checkbox" checked={selected} onChange={() => updateModel(index, { ...model, capabilities: selected ? (model.capabilities ?? []).filter((item) => item !== capability.id) : [...(model.capabilities ?? []), capability.id] })} />{capability.label}</label>;
                  })}
                </div>
                {models.length > 1 && <button type="button" onClick={() => setModels((current) => current.filter((_, modelIndex) => modelIndex !== index))} className="mt-3 text-xs text-destructive hover:underline">移除此模型</button>}
              </div>
            ))}
          </div>
        </div>

        {feedback && <p role="alert" className="text-sm text-destructive">{feedback}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="rounded-md bg-foreground px-4 py-2 text-xs font-medium text-background disabled:opacity-50">{saving ? "保存中…" : savedConfig ? "保存模型" : "保存并获取模型"}</button>
          <button type="button" onClick={onCancel} className="rounded-md border border-border px-4 py-2 text-xs hover:bg-muted">取消</button>
        </div>
      </form>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm font-medium">{label}<div className="mt-1.5">{children}</div></label>;
}

function mergeDiscoveredModels(
  discovered: ProviderModelInput[],
  existingModels: ProviderModelInput[],
) {
  const existing = new Map(existingModels.map((model) => [model.upstreamModelId, model]));
  const discoveredIds = new Set(discovered.map((model) => model.upstreamModelId));
  return [
    ...discovered.map((model) => existing.get(model.upstreamModelId) ?? { ...model, enabled: false }),
    ...existingModels.filter((model) => !discoveredIds.has(model.upstreamModelId)),
  ];
}

function ProviderState({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return <div role="status" className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"><p>{text}</p>{action && onAction && <button type="button" onClick={onAction} className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted">{action}</button>}</div>;
}

const inputClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring";

function normalizeHttpsUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function testStatusLabel(status: WorkspaceProviderConfig["lastTestStatus"]) {
  if (status === "succeeded") return "上次连接测试成功";
  if (status === "failed") return "上次连接测试失败";
  return "尚未测试连接";
}

function providerErrorMessage(error: unknown, fallback: string) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "provider_forbidden") return "你没有权限管理供应商配置。";
  if (code === "provider_auth_failed") return "连接失败：API Key 无效。";
  if (code === "provider_connection_timeout") return "连接超时，请检查 Base URL。";
  if (code === "provider_redirect_not_allowed") return "连接被拒绝：Base URL 不允许跳转。";
  if (code === "provider_invalid_request" && error instanceof Error) return `配置内容无效：${error.message}`;
  if (code === "provider_conflict") return "供应商名称已存在，请更换名称。";
  return fallback;
}

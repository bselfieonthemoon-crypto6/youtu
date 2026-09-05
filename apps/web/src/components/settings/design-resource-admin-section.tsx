"use client";

import type {
  CreateDesignImportRequest,
  DesignFontFaceDto,
  DesignFontFamilyDto,
  DesignImportJobDto,
  DesignResourceCategoryDto,
  DesignResourceDto,
  DesignResourceTagDto,
  DesignTemplateDetailDto,
  DesignTemplateDto,
  DesignTemplateVariable,
  DesignTextPresetDto,
} from "@loomic/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type AdminCatalogEntityKind,
  type DesignCatalogPage,
  type DesignFontCatalogItem,
  createDesignResourceApiClient,
} from "../../lib/design-resource-api";
import { uploadFile } from "../../lib/server-api";
import { DesignTemplateVariablesDialog } from "./design-template-variables-dialog";

type Tab =
  | "resources"
  | "templates"
  | "text-presets"
  | "fonts"
  | "categories"
  | "tags"
  | "imports";
type Row =
  | DesignResourceDto
  | DesignTemplateDto
  | DesignTextPresetDto
  | DesignFontFamilyDto
  | DesignFontFaceDto
  | DesignResourceCategoryDto
  | DesignResourceTagDto;
type Status = Row["status"];

const TABS: Array<[Tab, string]> = [
  ["resources", "素材"],
  ["templates", "模板"],
  ["text-presets", "文字模板"],
  ["fonts", "字体"],
  ["categories", "分类"],
  ["tags", "标签"],
  ["imports", "批量导入"],
];

export function DesignResourceAdminSection({
  accessToken,
  workspaceId,
  directoryImportEnabled = false,
}: {
  accessToken: string;
  workspaceId: string;
  directoryImportEnabled?: boolean;
}) {
  const client = useMemo(() => createDesignResourceApiClient(), []);
  const [tab, setTab] = useState<Tab>("resources");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [fontFaces, setFontFaces] = useState<DesignFontFaceDto[]>([]);
  const [imports, setImports] = useState<DesignImportJobDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [references, setReferences] = useState<{
    title: string;
    value: Record<string, unknown>;
  } | null>(null);
  const [importDetail, setImportDetail] = useState<{
    job: DesignImportJobDto;
    items: Array<{
      source_key: string;
      status: string;
      error_message: string | null;
    }>;
  } | null>(null);
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState("");
  const [resourceKind, setResourceKind] = useState("");
  const [format, setFormat] = useState("");
  const [aspect, setAspect] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [tagId, setTagId] = useState("");
  const [deleted, setDeleted] = useState<"false" | "true" | "all">("false");
  const [categories, setCategories] = useState<DesignResourceCategoryDto[]>([]);
  const [tags, setTags] = useState<DesignResourceTagDto[]>([]);
  const [variableEditor, setVariableEditor] =
    useState<DesignTemplateDetailDto | null>(null);
  const [variableError, setVariableError] = useState<string | null>(null);

  const loadFilters = useCallback(async () => {
    try {
      const [categoryPage, tagPage] = await Promise.all([
        client.listAdminCategories(accessToken, { limit: 100 }),
        client.listAdminTags(accessToken, { limit: 100 }),
      ]);
      setCategories(categoryPage.items);
      setTags(tagPage.items);
    } catch {
      // The active catalog request still exposes its own error state.
    }
  }, [accessToken, client]);

  useEffect(() => void loadFilters(), [loadFilters]);

  const load = useCallback(
    async (nextCursor?: string, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        if (tab === "imports") {
          const page = await client.listImports(
            accessToken,
            { cursor: nextCursor, limit: 50 },
            signal,
          );
          setImports((current) =>
            nextCursor ? [...current, ...page.items] : page.items,
          );
          setCursor(page.next_cursor);
          return;
        }
        const base = {
          query: query.trim() || undefined,
          cursor: nextCursor,
          limit: 50,
          scope: (scope || undefined) as "platform" | "workspace" | undefined,
          deleted,
        };
        let page: DesignCatalogPage<Row>;
        if (tab === "resources") {
          page = await client.listAdminResources(
            accessToken,
            {
              ...base,
              kind: (resourceKind || undefined) as
                | "image"
                | "svg"
                | "illustration"
                | "icon"
                | "background"
                | "mockup"
                | undefined,
              status: (status || undefined) as Status | undefined,
              format: (format || undefined) as
                | "png"
                | "jpeg"
                | "webp"
                | "gif"
                | "svg"
                | undefined,
              aspect_ratio: (aspect || undefined) as
                | "square"
                | "portrait"
                | "landscape"
                | "wide"
                | undefined,
              category_id: categoryId || undefined,
              tag_id: tagId || undefined,
            },
            signal,
          );
        } else if (tab === "templates") {
          page = await client.listAdminTemplates(
            accessToken,
            {
              ...base,
              status: (status || undefined) as Status | undefined,
            },
            signal,
          );
        } else if (tab === "text-presets") {
          page = await client.listAdminTextPresets(accessToken, base, signal);
        } else if (tab === "fonts") {
          const [families, faces] = await Promise.all([
            client.listAdminFontFamilies(accessToken, base, signal),
            client.listAdminFontFaces(
              accessToken,
              { ...base, limit: 100 },
              signal,
            ),
          ]);
          page = {
            items: families.items.map(
              (item: DesignFontCatalogItem) => item.family,
            ),
            next_cursor: families.next_cursor,
          };
          setFontFaces(faces.items);
        } else if (tab === "categories") {
          page = await client.listAdminCategories(accessToken, base, signal);
        } else {
          page = await client.listAdminTags(accessToken, base, signal);
        }
        setRows((current) =>
          nextCursor ? [...current, ...page.items] : page.items,
        );
        setCursor(page.next_cursor);
      } catch (cause) {
        if (signal?.aborted) return;
        setRows([]);
        setImports([]);
        setError(cause instanceof Error ? cause.message : "资源目录加载失败。");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [
      accessToken,
      aspect,
      categoryId,
      client,
      format,
      deleted,
      query,
      resourceKind,
      scope,
      status,
      tab,
      tagId,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void load(undefined, controller.signal),
      250,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (
      tab !== "imports" ||
      !imports.some(
        (job) => job.status === "queued" || job.status === "running",
      )
    )
      return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [imports, load, tab]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setBusy(null);
    }
  };

  const mutateStatus = (row: Row, next: Status) =>
    run(row.id, async () => {
      if (
        !window.confirm(`确认将「${rowName(row)}」变更为${statusLabel(next)}？`)
      )
        return;
      await client.setAdminCatalogStatus(accessToken, {
        request_id: crypto.randomUUID(),
        entity_kind: entityKind(row),
        entity_id: row.id,
        expected_revision: row.revision,
        status: next,
      });
      setNotice("状态已更新。");
      await load();
    });

  const mutateDeleted = (row: Row, deleted: boolean) =>
    run(row.id, async () => {
      if (
        !window.confirm(`确认${deleted ? "删除" : "恢复"}「${rowName(row)}」？`)
      )
        return;
      await client.setAdminCatalogDeleted(
        accessToken,
        {
          request_id: crypto.randomUUID(),
          entity_kind: entityKind(row),
          entity_id: row.id,
          expected_revision: row.revision,
        },
        deleted,
      );
      setNotice(deleted ? "已删除。" : "已恢复。");
      await load();
    });

  const rename = (row: Row) =>
    run(row.id, async () => {
      const currentName = rowName(row);
      const name = window.prompt("输入新名称", currentName)?.trim();
      if (!name || name === currentName) return;
      const collection = editableCollection(row);
      if (!collection) throw new Error("当前类型不支持直接改名。");
      const identity = isResource(row)
        ? { resource_id: row.id }
        : { entity_id: row.id };
      await client.updateAdminCatalogEntry(accessToken, collection, row.id, {
        request_id: crypto.randomUUID(),
        ...identity,
        expected_revision: row.revision,
        name,
      });
      setNotice("名称已更新。");
      await load();
    });

  const showReferences = (row: Row) =>
    run(`ref:${row.id}`, async () => {
      const value = await client.getAdminReferences(
        accessToken,
        entityKind(row),
        row.id,
      );
      setReferences({ title: rowName(row), value });
    });

  const toggleFontEmbed = (face: DesignFontFaceDto) =>
    run(face.id, async () => {
      await client.updateAdminCatalogEntry(accessToken, "font-faces", face.id, {
        request_id: crypto.randomUUID(),
        entity_id: face.id,
        expected_revision: face.revision,
        allow_web_embed: !face.allow_web_embed,
      });
      setNotice(face.allow_web_embed ? "已禁止网页嵌入。" : "已允许网页嵌入。");
      await load();
    });

  const showImport = (job: DesignImportJobDto) =>
    run(job.id, async () => {
      setImportDetail(await client.getImport(accessToken, job.id, true));
    });

  const showTemplateVariables = (template: DesignTemplateDto) =>
    run(`variables:${template.id}`, async () => {
      setVariableError(null);
      setVariableEditor(await client.getTemplate(accessToken, template.id));
    });

  const saveTemplateVariables = (variables: DesignTemplateVariable[]) => {
    const detail = variableEditor;
    if (!detail) return;
    void run(`variables:${detail.template.id}`, async () => {
      try {
        await client.updateAdminTemplateVariables(
          accessToken,
          detail.template.id,
          {
            request_id: crypto.randomUUID(),
            expected_revision: detail.template.revision,
            variables,
          },
        );
        setVariableEditor(null);
        setNotice("模板变量已保存。");
        await load();
      } catch (cause) {
        setVariableError(
          cause instanceof Error ? cause.message : "模板变量保存失败。",
        );
      }
    });
  };

  return (
    <section aria-labelledby="resource-admin-title" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="resource-admin-title" className="text-lg font-semibold">
            资源目录
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            上传、审核、发布、下架和导入均写入正式资源目录。
          </p>
        </div>
        {tab !== "imports" && (
          <button
            type="button"
            className="rounded-lg bg-foreground px-3 py-2 text-sm text-background"
            onClick={() => setCreateOpen((value) => !value)}
          >
            {createOpen ? "收起创建" : "新建"}
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-1 rounded-xl bg-muted p-1">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id);
              setRows([]);
              setCreateOpen(false);
            }}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "imports" ? (
        <ImportCreateForm
          accessToken={accessToken}
          workspaceId={workspaceId}
          directoryImportEnabled={directoryImportEnabled}
          busy={busy !== null}
          onRun={run}
          onCreated={async () => {
            setNotice("导入任务已创建。");
            await load();
          }}
        />
      ) : createOpen ? (
        <CatalogCreateForm
          tab={tab}
          accessToken={accessToken}
          workspaceId={workspaceId}
          families={rows.filter(isFontFamily)}
          categories={categories}
          tags={tags}
          busy={busy !== null}
          onRun={run}
          onCreated={async () => {
            setCreateOpen(false);
            setNotice("已创建草稿。");
            await Promise.all([load(), loadFilters()]);
          }}
        />
      ) : null}

      {tab !== "imports" && (
        <CatalogFilters
          tab={tab}
          query={query}
          onQuery={setQuery}
          scope={scope}
          onScope={setScope}
          status={status}
          onStatus={setStatus}
          kind={resourceKind}
          onKind={setResourceKind}
          format={format}
          onFormat={setFormat}
          aspect={aspect}
          onAspect={setAspect}
          categoryId={categoryId}
          onCategory={setCategoryId}
          tagId={tagId}
          onTag={setTagId}
          categories={categories}
          tags={tags}
          deleted={deleted}
          onDeleted={setDeleted}
        />
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <output className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </output>
      )}

      {tab === "imports" ? (
        <ImportTable
          jobs={imports}
          busy={busy}
          onShow={showImport}
          onAction={(job, action) =>
            run(job.id, async () => {
              await client.updateImport(accessToken, job.id, action);
              await load();
            })
          }
        />
      ) : (
        <CatalogTable
          rows={rows}
          fontFaces={fontFaces}
          busy={busy}
          onStatus={mutateStatus}
          onDelete={mutateDeleted}
          onRename={rename}
          onReferences={showReferences}
          onToggleFontEmbed={toggleFontEmbed}
          onVariables={showTemplateVariables}
        />
      )}
      {loading && (
        <p className="mt-3 text-sm text-muted-foreground">正在加载…</p>
      )}
      {cursor && !loading && (
        <button
          type="button"
          className="mt-3 rounded-lg border px-3 py-2 text-sm"
          onClick={() => void load(cursor)}
        >
          加载更多
        </button>
      )}

      {references && (
        <JsonDialog
          title={`「${references.title}」的引用`}
          value={references.value}
          onClose={() => setReferences(null)}
        />
      )}
      {importDetail && (
        <ImportReportDialog
          detail={importDetail}
          onClose={() => setImportDetail(null)}
        />
      )}
      {variableEditor && (
        <DesignTemplateVariablesDialog
          detail={variableEditor}
          busy={busy === `variables:${variableEditor.template.id}`}
          error={variableError}
          onSave={saveTemplateVariables}
          onCancel={() => setVariableEditor(null)}
        />
      )}
    </section>
  );
}

function CatalogFilters(props: {
  tab: Tab;
  query: string;
  onQuery: (value: string) => void;
  scope: string;
  onScope: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
  kind: string;
  onKind: (value: string) => void;
  format: string;
  onFormat: (value: string) => void;
  aspect: string;
  onAspect: (value: string) => void;
  categoryId: string;
  onCategory: (value: string) => void;
  tagId: string;
  onTag: (value: string) => void;
  categories: DesignResourceCategoryDto[];
  tags: DesignResourceTagDto[];
  deleted: "false" | "true" | "all";
  onDeleted: (value: "false" | "true" | "all") => void;
}) {
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-3">
      <input
        aria-label="搜索资源目录"
        value={props.query}
        onChange={(event) => props.onQuery(event.currentTarget.value)}
        placeholder="搜索名称"
        className="h-10 rounded-lg border bg-background px-3 text-sm"
      />
      <FilterSelect
        label="范围"
        value={props.scope}
        onChange={props.onScope}
        options={[
          ["", "全部范围"],
          ["workspace", "工作区"],
          ["platform", "平台"],
        ]}
      />
      {(props.tab === "resources" || props.tab === "templates") && (
        <FilterSelect
          label="状态"
          value={props.status}
          onChange={props.onStatus}
          options={[
            ["", "全部状态"],
            ["draft", "草稿"],
            ["pending_review", "待审核"],
            ["published", "已发布"],
            ["rejected", "已驳回"],
            ["disabled", "已下架"],
          ]}
        />
      )}
      <FilterSelect
        label="删除状态"
        value={props.deleted}
        onChange={(value) => props.onDeleted(value as "false" | "true" | "all")}
        options={[
          ["false", "未删除"],
          ["true", "已删除"],
          ["all", "全部删除状态"],
        ]}
      />
      {props.tab === "resources" && (
        <>
          <FilterSelect
            label="类型"
            value={props.kind}
            onChange={props.onKind}
            options={[
              ["", "全部类型"],
              ["image", "图片"],
              ["svg", "SVG"],
              ["illustration", "插画"],
              ["icon", "图标"],
              ["background", "背景"],
              ["mockup", "样机"],
            ]}
          />
          <FilterSelect
            label="格式"
            value={props.format}
            onChange={props.onFormat}
            options={[
              ["", "全部格式"],
              ["png", "PNG"],
              ["jpeg", "JPEG"],
              ["webp", "WebP"],
              ["gif", "GIF"],
              ["svg", "SVG"],
            ]}
          />
          <FilterSelect
            label="宽高比"
            value={props.aspect}
            onChange={props.onAspect}
            options={[
              ["", "全部比例"],
              ["square", "方形"],
              ["portrait", "竖版"],
              ["landscape", "横版"],
              ["wide", "超宽"],
            ]}
          />
          <FilterSelect
            label="分类"
            value={props.categoryId}
            onChange={props.onCategory}
            options={[
              ["", "全部分类"],
              ...props.categories.map(
                (item) => [item.id, item.name] as [string, string],
              ),
            ]}
          />
          <FilterSelect
            label="标签"
            value={props.tagId}
            onChange={props.onTag}
            options={[
              ["", "全部标签"],
              ...props.tags.map(
                (item) => [item.id, item.name] as [string, string],
              ),
            ]}
          />
        </>
      )}
    </div>
  );
}

function CatalogTable({
  rows,
  fontFaces,
  busy,
  onStatus,
  onDelete,
  onRename,
  onReferences,
  onToggleFontEmbed,
  onVariables,
}: {
  rows: Row[];
  fontFaces: DesignFontFaceDto[];
  busy: string | null;
  onStatus: (row: Row, status: Status) => void;
  onDelete: (row: Row, deleted: boolean) => void;
  onRename: (row: Row) => void;
  onReferences: (row: Row) => void;
  onToggleFontEmbed: (face: DesignFontFaceDto) => void;
  onVariables: (template: DesignTemplateDto) => void;
}) {
  const displayRows: Row[] = [];
  for (const row of rows) {
    displayRows.push(row);
    if (isFontFamily(row))
      displayRows.push(
        ...fontFaces.filter((face) => face.family_id === row.id),
      );
  }
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2">名称</th>
            <th className="px-3 py-2">范围</th>
            <th className="px-3 py-2">类型/详情</th>
            <th className="px-3 py-2">状态</th>
            <th className="px-3 py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row) => (
            <tr key={row.id} className="border-t align-top">
              <td className="max-w-64 px-3 py-3 font-medium">
                {rowName(row)}
                {isFontFace(row) && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {row.weight} {row.style}
                  </span>
                )}
              </td>
              <td className="px-3 py-3 text-muted-foreground">
                {row.scope === "workspace" ? "工作区" : "平台"}
              </td>
              <td className="px-3 py-3 text-muted-foreground">
                {rowDescription(row)}
              </td>
              <td className="px-3 py-3">{statusLabel(row.status)}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {!isFontFace(row) && (
                    <SmallButton
                      disabled={busy === row.id}
                      onClick={() => onRename(row)}
                    >
                      编辑
                    </SmallButton>
                  )}
                  {isTemplate(row) && (
                    <SmallButton
                      disabled={busy === `variables:${row.id}`}
                      onClick={() => onVariables(row)}
                    >
                      变量
                    </SmallButton>
                  )}
                  {isFontFace(row) && (
                    <SmallButton
                      disabled={busy === row.id}
                      onClick={() => onToggleFontEmbed(row)}
                    >
                      {row.allow_web_embed ? "禁止嵌入" : "允许嵌入"}
                    </SmallButton>
                  )}
                  {nextStatuses(row.status).map(([next, label]) => (
                    <SmallButton
                      key={next}
                      disabled={busy === row.id}
                      onClick={() => onStatus(row, next)}
                    >
                      {label}
                    </SmallButton>
                  ))}
                  <SmallButton
                    disabled={busy === `ref:${row.id}`}
                    onClick={() => onReferences(row)}
                  >
                    查看引用
                  </SmallButton>
                  <SmallButton
                    danger
                    disabled={busy === row.id}
                    onClick={() => onDelete(row, row.deleted_at === null)}
                  >
                    {row.deleted_at ? "恢复" : "删除"}
                  </SmallButton>
                </div>
              </td>
            </tr>
          ))}
          {displayRows.length === 0 && (
            <tr>
              <td
                colSpan={5}
                className="px-3 py-8 text-center text-muted-foreground"
              >
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CatalogCreateForm({
  tab,
  accessToken,
  workspaceId,
  families,
  categories,
  tags,
  busy,
  onRun,
  onCreated,
}: {
  tab: Exclude<Tab, "imports">;
  accessToken: string;
  workspaceId: string;
  families: DesignFontFamilyDto[];
  categories: DesignResourceCategoryDto[];
  tags: DesignResourceTagDto[];
  busy: boolean;
  onRun: (key: string, action: () => Promise<void>) => Promise<void>;
  onCreated: () => Promise<void>;
}) {
  const client = useMemo(() => createDesignResourceApiClient(), []);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [designId, setDesignId] = useState("");
  const [text, setText] = useState("示例文字");
  const [familyId, setFamilyId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [author, setAuthor] = useState("");
  const [licenseName, setLicenseName] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [attribution, setAttribution] = useState("");
  const [usageRestrictions, setUsageRestrictions] = useState("");

  const submit = () =>
    onRun("create", async () => {
      if (!workspaceId) throw new Error("工作区信息尚未加载，请稍后重试。");
      if (!name.trim()) throw new Error("请输入名称。");
      const common = {
        request_id: crypto.randomUUID(),
        scope: "workspace" as const,
        workspace_id: workspaceId,
      };
      const readAuthorization = () =>
        validatedAttribution({
          sourceUrl,
          author,
          licenseName,
          licenseUrl,
          attribution,
          usageRestrictions,
        });
      if (tab === "resources") {
        if (!file) throw new Error("请选择素材文件。");
        const uploaded = await uploadFile(accessToken, file, workspaceId);
        await client.createAdminResource(accessToken, {
          ...common,
          kind: file.type === "image/svg+xml" ? "svg" : "image",
          name: name.trim(),
          description: null,
          asset_object_id: uploaded.asset.id,
          preview_asset_object_id: uploaded.asset.id,
          category_id: categoryId || null,
          tag_ids: tagIds,
          ...readAuthorization(),
        });
      } else if (tab === "templates") {
        if (!designId.trim()) throw new Error("请输入来源设计 ID。");
        if (!file) throw new Error("请选择模板预览图。");
        const preview = await uploadFile(accessToken, file, workspaceId);
        await client.createAdminTemplateFromDesign(accessToken, {
          ...common,
          design_id: designId.trim(),
          name: name.trim(),
          description: null,
          preview_asset_object_id: preview.asset.id,
          category_id: categoryId || null,
          tag_ids: tagIds,
          ...readAuthorization(),
        });
      } else if (tab === "text-presets") {
        if (!file) throw new Error("请选择文字模板预览图。");
        const preview = await uploadFile(accessToken, file, workspaceId);
        await client.createAdminCatalogEntry(accessToken, "text-presets", {
          ...common,
          name: name.trim(),
          style: { schemaVersion: 1, objects: [newPresetText(text)] },
          preview_asset_object_id: preview.asset.id,
          category_id: categoryId || null,
          tag_ids: tagIds,
          ...readAuthorization(),
        });
      } else if (tab === "fonts") {
        if (!familyId) {
          await client.createAdminCatalogEntry(accessToken, "font-families", {
            ...common,
            name: name.trim(),
            ...readAuthorization(),
          });
        } else {
          if (!file) throw new Error("请选择字体文件。");
          const format = file.name.toLowerCase().split(".").pop();
          if (!format || !["woff", "ttf", "otf"].includes(format))
            throw new Error(
              "字体只支持 WOFF、TTF、OTF；WOFF2 暂不支持元数据校验。",
            );
          const uploaded = await client.uploadAdminFontFile(
            accessToken,
            workspaceId,
            file,
          );
          await client.createAdminCatalogEntry(accessToken, "font-faces", {
            ...common,
            family_id: familyId,
            asset_object_id: uploaded.asset_object_id,
            style: uploaded.style,
            weight: uploaded.weight,
            format: uploaded.format,
            checksum_sha256: uploaded.checksum_sha256,
            allow_web_embed: uploaded.allow_web_embed,
          });
        }
      } else if (tab === "categories") {
        await client.createAdminCatalogEntry(accessToken, "categories", {
          ...common,
          parent_id: null,
          name: name.trim(),
          slug: slugify(name),
          sort_order: 0,
        });
      } else {
        await client.createAdminCatalogEntry(accessToken, "tags", {
          ...common,
          name: name.trim(),
          slug: slugify(name),
        });
      }
      await onCreated();
    });

  return (
    <div className="mt-4 grid gap-3 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">
        <span>名称</span>
        <input
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          className="h-10 rounded-lg border bg-background px-3"
        />
      </label>
      {tab === "templates" && (
        <label className="grid gap-1 text-sm">
          <span>来源设计 ID</span>
          <input
            value={designId}
            onChange={(event) => setDesignId(event.currentTarget.value)}
            className="h-10 rounded-lg border bg-background px-3"
          />
        </label>
      )}
      {tab === "text-presets" && (
        <label className="grid gap-1 text-sm">
          <span>示例文字</span>
          <input
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            className="h-10 rounded-lg border bg-background px-3"
          />
        </label>
      )}
      {tab === "fonts" && (
        <label className="grid gap-1 text-sm">
          <span>类型</span>
          <select
            value={familyId}
            onChange={(event) => setFamilyId(event.currentTarget.value)}
            className="h-10 rounded-lg border bg-background px-3"
          >
            <option value="">新建字体家族</option>
            {families.map((family) => (
              <option key={family.id} value={family.id}>
                向 {family.name} 添加字重
              </option>
            ))}
          </select>
        </label>
      )}
      {(tab === "resources" ||
        tab === "templates" ||
        tab === "text-presets" ||
        (tab === "fonts" && familyId)) && (
        <label className="grid gap-1 text-sm">
          <span>
            {tab === "fonts"
              ? "字体文件"
              : tab === "resources"
                ? "素材文件（同时作为预览）"
                : "预览图"}
          </span>
          <input
            type="file"
            accept={
              tab === "fonts"
                ? ".ttf,.otf,.woff,font/ttf,font/otf,font/woff"
                : undefined
            }
            onChange={(event) =>
              setFile(event.currentTarget.files?.[0] ?? null)
            }
            className="h-10 rounded-lg border bg-background px-3 py-2"
          />
        </label>
      )}
      {(tab === "resources" ||
        tab === "templates" ||
        tab === "text-presets") && (
        <>
          <FilterSelect
            label="分类"
            value={categoryId}
            onChange={setCategoryId}
            options={[
              ["", "不分类"],
              ...categories.map(
                (item) => [item.id, item.name] as [string, string],
              ),
            ]}
          />
          <label className="grid gap-1 text-sm">
            <span>标签（可多选）</span>
            <select
              multiple
              value={tagIds}
              onChange={(event) =>
                setTagIds(
                  [...event.currentTarget.selectedOptions].map(
                    (option) => option.value,
                  ),
                )
              }
              className="min-h-10 rounded-lg border bg-background px-3"
            >
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {(tab === "resources" ||
        tab === "templates" ||
        tab === "text-presets" ||
        (tab === "fonts" && !familyId)) && (
        <>
          <label className="grid gap-1 text-sm">
            <span>授权/许可证名称 *</span>
            <input
              value={licenseName}
              onChange={(event) => setLicenseName(event.currentTarget.value)}
              placeholder="例如：自有版权、CC BY 4.0"
              className="h-10 rounded-lg border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>使用限制</span>
            <input
              value={usageRestrictions}
              onChange={(event) =>
                setUsageRestrictions(event.currentTarget.value)
              }
              placeholder="填写限制，或同时填写来源与许可证 URL"
              className="h-10 rounded-lg border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>来源 URL</span>
            <input
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.currentTarget.value)}
              placeholder="https://…"
              className="h-10 rounded-lg border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>许可证 URL</span>
            <input
              value={licenseUrl}
              onChange={(event) => setLicenseUrl(event.currentTarget.value)}
              placeholder="https://…"
              className="h-10 rounded-lg border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>作者</span>
            <input
              value={author}
              onChange={(event) => setAuthor(event.currentTarget.value)}
              className="h-10 rounded-lg border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>署名说明</span>
            <input
              value={attribution}
              onChange={(event) => setAttribution(event.currentTarget.value)}
              className="h-10 rounded-lg border bg-background px-3"
            />
          </label>
        </>
      )}
      <div className="flex items-end">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="h-10 rounded-lg bg-foreground px-4 text-sm text-background disabled:opacity-50"
        >
          {busy ? "创建中…" : "创建草稿"}
        </button>
      </div>
    </div>
  );
}

function ImportCreateForm({
  accessToken,
  workspaceId,
  directoryImportEnabled,
  busy,
  onRun,
  onCreated,
}: {
  accessToken: string;
  workspaceId: string;
  directoryImportEnabled: boolean;
  busy: boolean;
  onRun: (key: string, action: () => Promise<void>) => Promise<void>;
  onCreated: () => Promise<void>;
}) {
  const client = useMemo(() => createDesignResourceApiClient(), []);
  const [mode, setMode] = useState<"package" | "inline" | "directory">(
    "package",
  );
  const [file, setFile] = useState<File | null>(null);
  const [manifestJson, setManifestJson] = useState(
    JSON.stringify({ version: 1, items: [] }, null, 2),
  );
  const [directoryPath, setDirectoryPath] = useState("");
  return (
    <div className="mt-4 grid gap-3 rounded-xl border bg-muted/20 p-4">
      <label className="grid gap-1 text-sm">
        <span>导入来源</span>
        <select
          aria-label="导入来源"
          value={mode}
          onChange={(event) =>
            setMode(event.currentTarget.value as typeof mode)
          }
          className="h-10 rounded-lg border bg-background px-3"
        >
          <option value="package">ZIP / JSON 清单包</option>
          <option value="inline">直接 JSON 混合清单</option>
          <option value="directory" disabled={!directoryImportEnabled}>
            服务器目录{directoryImportEnabled ? "" : "（未启用）"}
          </option>
        </select>
      </label>
      {mode === "package" ? (
        <label className="grid gap-1 text-sm">
          <span>ZIP/JSON 清单包</span>
          <input
            aria-label="ZIP/JSON 清单包"
            type="file"
            accept=".zip,.json,application/zip,application/json"
            onChange={(event) =>
              setFile(event.currentTarget.files?.[0] ?? null)
            }
          />
          <span className="text-xs text-muted-foreground">
            ZIP 根目录需包含 manifest.json；也可直接选择单个 JSON 清单。
          </span>
        </label>
      ) : mode === "inline" ? (
        <label className="grid gap-1 text-sm">
          <span>Manifest JSON</span>
          <textarea
            aria-label="Manifest JSON"
            value={manifestJson}
            onChange={(event) => setManifestJson(event.currentTarget.value)}
            className="min-h-48 rounded-lg border bg-background p-3 font-mono text-xs"
            spellCheck={false}
          />
        </label>
      ) : (
        <label className="grid gap-1 text-sm">
          <span>服务器目录路径</span>
          <input
            aria-label="服务器目录路径"
            value={directoryPath}
            disabled={!directoryImportEnabled}
            onChange={(event) => setDirectoryPath(event.currentTarget.value)}
            placeholder="由 LOOMIC_DESIGN_IMPORT_ROOT 限定的目录"
            className="h-10 rounded-lg border bg-background px-3 disabled:opacity-60"
          />
        </label>
      )}
      {!directoryImportEnabled && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          服务器目录导入未启用。服务端配置 LOOMIC_DESIGN_IMPORT_ROOT，并在 Web
          设置 NEXT_PUBLIC_LOOMIC_DESIGN_IMPORT_DIRECTORY_ENABLED=true 后可用。
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        className="w-fit rounded-lg bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
        onClick={() =>
          void onRun("import", async () => {
            if (!workspaceId)
              throw new Error("工作区信息尚未加载，请稍后重试。");
            const common = {
              request_id: crypto.randomUUID(),
              scope: "workspace" as const,
              workspace_id: workspaceId,
            };
            if (mode === "package") {
              if (!file) throw new Error("请选择 ZIP 或 JSON 清单包。");
              if (!/\.(?:zip|json)$/i.test(file.name))
                throw new Error("清单包仅支持 .zip 或 .json 文件。");
              await client.createImportPackage(accessToken, {
                request_id: common.request_id,
                workspace_id: workspaceId,
                file,
              });
            } else if (mode === "inline") {
              let manifest: Extract<
                CreateDesignImportRequest,
                { source_kind: "manifest_inline" }
              >["manifest"];
              try {
                manifest = JSON.parse(manifestJson) as typeof manifest;
              } catch {
                throw new Error("Manifest JSON 格式无效。");
              }
              await client.createImport(accessToken, {
                ...common,
                source_kind: "manifest_inline",
                manifest,
              });
            } else {
              if (!directoryImportEnabled)
                throw new Error("服务器目录导入未启用。");
              await client.createDirectoryImport(accessToken, {
                ...common,
                source_kind: "server_directory",
                directory_path: directoryPath,
              });
            }
            await onCreated();
          })
        }
      >
        {busy ? "提交中…" : "创建导入任务"}
      </button>
    </div>
  );
}

function ImportTable({
  jobs,
  busy,
  onShow,
  onAction,
}: {
  jobs: DesignImportJobDto[];
  busy: string | null;
  onShow: (job: DesignImportJobDto) => void;
  onAction: (job: DesignImportJobDto, action: "cancel" | "retry") => void;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="bg-muted/60">
          <tr>
            <th className="px-3 py-2">任务</th>
            <th className="px-3 py-2">来源</th>
            <th className="px-3 py-2">进度</th>
            <th className="px-3 py-2">状态</th>
            <th className="px-3 py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-t">
              <td className="px-3 py-3 font-mono text-xs">
                {job.id.slice(0, 8)}
              </td>
              <td className="px-3 py-3">{job.source_kind}</td>
              <td className="px-3 py-3">
                {job.completed_items + job.failed_items}/{job.total_items}
                （失败 {job.failed_items}）
              </td>
              <td className="px-3 py-3">{job.status}</td>
              <td className="px-3 py-2">
                <div className="flex gap-1">
                  <SmallButton
                    disabled={busy === job.id}
                    onClick={() => onShow(job)}
                  >
                    报告
                  </SmallButton>
                  {(job.status === "queued" || job.status === "running") && (
                    <SmallButton onClick={() => onAction(job, "cancel")}>
                      取消
                    </SmallButton>
                  )}
                  {(job.status === "failed" || job.status === "canceled") && (
                    <SmallButton onClick={() => onAction(job, "retry")}>
                      重试
                    </SmallButton>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {jobs.length === 0 && (
            <tr>
              <td
                colSpan={5}
                className="px-3 py-8 text-center text-muted-foreground"
              >
                暂无导入任务
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function JsonDialog({
  title,
  value,
  onClose,
}: {
  title: string;
  value: Record<string, unknown>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4">
      <dialog
        open
        className="m-0 max-h-[80vh] w-full max-w-xl overflow-auto rounded-2xl border bg-background p-5 text-foreground shadow-xl"
      >
        <h3 className="font-semibold">{title}</h3>
        <pre className="mt-3 overflow-auto rounded-lg bg-muted p-3 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-lg border px-3 py-2 text-sm"
        >
          关闭
        </button>
      </dialog>
    </div>
  );
}

function ImportReportDialog({
  detail,
  onClose,
}: {
  detail: {
    job: DesignImportJobDto;
    items: Array<{
      source_key: string;
      status: string;
      error_message: string | null;
    }>;
  };
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4">
      <dialog
        open
        className="m-0 max-h-[80vh] w-full max-w-2xl overflow-auto rounded-2xl border bg-background p-5 text-foreground shadow-xl"
      >
        <h3 className="font-semibold">导入报告</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          完成 {detail.job.completed_items}，失败 {detail.job.failed_items}
        </p>
        <div className="mt-3 divide-y rounded-lg border">
          {detail.items.map((item) => (
            <div key={item.source_key} className="p-3 text-sm">
              <span className="font-medium">{item.source_key}</span>
              <span className="ml-2 text-muted-foreground">{item.status}</span>
              {item.error_message && (
                <p className="mt-1 text-destructive">{item.error_message}</p>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-lg border px-3 py-2 text-sm"
        >
          关闭
        </button>
      </dialog>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-10 rounded-lg border bg-background px-3"
      >
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function SmallButton({
  children,
  danger = false,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs disabled:opacity-50 ${danger ? "border-destructive/40 text-destructive" : ""}`}
    >
      {children}
    </button>
  );
}

function entityKind(row: Row): AdminCatalogEntityKind {
  if (isResource(row)) return "resource";
  if (isTemplate(row)) return "template";
  if (isTextPreset(row)) return "text_preset";
  if (isFontFace(row)) return "font_face";
  if (isFontFamily(row)) return "font_family";
  if ("parent_id" in row) return "category";
  return "tag";
}

function editableCollection(row: Row) {
  const kind = entityKind(row);
  if (kind === "resource") return "resources" as const;
  if (kind === "template") return "templates" as const;
  if (kind === "text_preset") return "text-presets" as const;
  if (kind === "font_family") return "font-families" as const;
  if (kind === "category") return "categories" as const;
  if (kind === "tag") return "tags" as const;
  return null;
}

function nextStatuses(current: Status): Array<[Status, string]> {
  if (current === "draft" || current === "rejected")
    return [["pending_review", "送审"]];
  if (current === "pending_review")
    return [
      ["published", "发布"],
      ["rejected", "驳回"],
    ];
  if (current === "published") return [["disabled", "下架"]];
  return [["draft", "转草稿"]];
}

function statusLabel(status: Status) {
  return {
    draft: "草稿",
    pending_review: "待审核",
    published: "已发布",
    rejected: "已驳回",
    disabled: "已下架",
  }[status];
}

function rowDescription(row: Row) {
  if (isResource(row))
    return `${row.kind}${row.width && row.height ? ` · ${row.width}×${row.height}` : ""}`;
  if (isTemplate(row)) return `${row.width}×${row.height}`;
  if (isTextPreset(row)) return "文字模板";
  if (isFontFace(row))
    return `${row.format} · ${row.allow_web_embed ? "可网页嵌入" : "禁止网页嵌入"}`;
  if (isFontFamily(row)) return "字体家族";
  if ("parent_id" in row) return `排序 ${row.sort_order}`;
  return `#${row.slug}`;
}

function rowName(row: Row) {
  return isFontFace(row) ? row.family_name : row.name;
}

function isResource(row: Row): row is DesignResourceDto {
  return "asset_object_id" in row && "kind" in row;
}

function isTemplate(row: Row): row is DesignTemplateDto {
  return "width" in row && "height" in row && !isResource(row);
}

function isTextPreset(row: Row): row is DesignTextPresetDto {
  return (
    "style" in row && "preview_asset_object_id" in row && !("family_id" in row)
  );
}

function isFontFace(row: Row): row is DesignFontFaceDto {
  return "family_id" in row && "allow_web_embed" in row;
}

function isFontFamily(row: Row): row is DesignFontFamilyDto {
  return (
    !("asset_object_id" in row) &&
    !("width" in row) &&
    !("style" in row) &&
    !("slug" in row)
  );
}

function validatedAttribution(input: {
  sourceUrl: string;
  author: string;
  licenseName: string;
  licenseUrl: string;
  attribution: string;
  usageRestrictions: string;
}) {
  const licenseName = input.licenseName.trim();
  const sourceUrl = input.sourceUrl.trim();
  const licenseUrl = input.licenseUrl.trim();
  const usageRestrictions = input.usageRestrictions.trim();
  if (!licenseName) throw new Error("请输入授权/许可证名称。");
  if (!usageRestrictions && !(sourceUrl && licenseUrl)) {
    throw new Error("请填写使用限制，或同时填写来源 URL 与许可证 URL。");
  }
  return {
    source_url: sourceUrl || null,
    author: input.author.trim() || null,
    license_name: licenseName,
    license_url: licenseUrl || null,
    attribution: input.attribution.trim() || null,
    usage_restrictions: usageRestrictions || null,
  };
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `item-${Date.now()}`;
}

function newPresetText(text: string) {
  return {
    objectId: crypto.randomUUID(),
    objectVersion: 1,
    type: "text" as const,
    name: "文字",
    x: 0,
    y: 0,
    width: 320,
    height: 72,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    text,
    fontFamily: "Arial",
    fontSize: 48,
    fontWeight: 400,
    fontStyle: "normal" as const,
    textAlign: "left" as const,
    lineHeight: 1.2,
    charSpacing: 0,
    fill: { kind: "solid" as const, color: "#111111" },
  };
}

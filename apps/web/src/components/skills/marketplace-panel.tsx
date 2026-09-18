"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketplaceDetail, MarketplaceSkill } from "@loomic/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getMarketplaceDetail, installMarketplaceSkill, searchMarketplace } from "@/lib/server-api";
import { skillErrorMessage } from "@/lib/skills-client";

export function MarketplacePanel({ accessToken, onInstalled }: {
  accessToken: () => string | undefined; onInstalled: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<MarketplaceSkill[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const detailSequence = useRef(0);
  const selected = useRef<MarketplaceSkill | null>(null);
  const installLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; searchSequence.current += 1; detailSequence.current += 1;
  }; }, []);

  useEffect(() => {
    const sequence = ++searchSequence.current;
    const token = accessToken();
    setSearchError(null);
    if (!query.trim() || !token) {
      setSkills([]); setTotal(0); setLoading(false); setSearched(false); return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void searchMarketplace(token, query.trim()).then((result) => {
        if (sequence !== searchSequence.current || token !== accessToken()) return;
        setSkills(result.skills); setTotal(result.total); setSearched(true);
      }).catch((cause) => {
        if (sequence !== searchSequence.current || token !== accessToken()) return;
        setSearchError(skillErrorMessage(cause, "社区市场加载失败，请重试。"));
        setSkills([]); setTotal(0); setSearched(false);
      }).finally(() => { if (sequence === searchSequence.current && token === accessToken()) setLoading(false); });
    }, 300);
    return () => { clearTimeout(timer); searchSequence.current += 1; };
  }, [query, accessToken, refresh]);

  const showDetail = useCallback(async (skill: MarketplaceSkill) => {
    const token = accessToken();
    if (!token) return;
    const sequence = ++detailSequence.current;
    selected.current = skill;
    setDetail(null); setDetailError(null); setDetailLoading(true); setOpen(true);
    try {
      const result = await getMarketplaceDetail(token, skill.packageName);
      if (sequence === detailSequence.current && token === accessToken()) setDetail(result);
    } catch (cause) {
      if (sequence === detailSequence.current && token === accessToken()) setDetailError(skillErrorMessage(cause, "技能详情读取失败，请重试后再安装。"));
    } finally { if (sequence === detailSequence.current && token === accessToken()) setDetailLoading(false); }
  }, [accessToken]);

  const install = async () => {
    if (!detail || installLock.current) return;
    const token = accessToken();
    if (!token) { setDetailError("请登录后重试。"); return; }
    installLock.current = true; setInstalling(true); setDetailError(null); setNotice(null);
    try {
      await installMarketplaceSkill(token, detail.packageName);
      if (!mounted.current || token !== accessToken()) return;
      setNotice("「" + detail.name + "」已安装，模型和工具依赖请在已安装列表中检查。");
      setOpen(false); detailSequence.current += 1;
      await onInstalled();
    } catch (cause) {
      if (mounted.current && token === accessToken()) setDetailError(skillErrorMessage(cause, "安装失败，未确认成功，请重试。"));
    } finally { installLock.current = false; if (mounted.current) setInstalling(false); }
  };

  return <div className="space-y-4">
    <p className="text-xs text-muted-foreground">搜索公开社区技能包。社区条目不等于官方推荐；安装前请核对许可与来源。包内必须有 SKILL.md，不会自动安装依赖或运行脚本。</p>
    <input aria-label="搜索市场技能" placeholder="搜索社区技能…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full max-w-md rounded-lg border border-input bg-transparent px-3 text-sm" />
    {loading && <p role="status" className="text-sm text-muted-foreground">正在搜索…</p>}
    {searchError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{searchError}</p><Button size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>重试搜索</Button></div>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!loading && !searchError && !searched && <p className="py-12 text-center text-sm text-muted-foreground">输入关键词搜索社区技能。</p>}
    {!loading && searched && <p className="text-sm text-muted-foreground">{skills.length ? "找到 " + total + " 个技能" : "未找到匹配的技能"}</p>}
    <div aria-busy={loading} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{skills.map((skill) => <button key={skill.packageName} type="button" onClick={() => { void showDetail(skill); }} className="space-y-2 rounded-xl border border-border bg-card p-4 text-left hover:bg-muted/50">
      <p className="text-sm font-medium">{skill.name} <span className="text-xs text-muted-foreground">v{skill.version}</span></p><p className="line-clamp-3 text-xs text-muted-foreground">{skill.description}</p><p className="text-xs text-muted-foreground">{skill.author || "未填写作者"} · {skill.downloads} 次下载</p>
    </button>)}</div>
    <Dialog open={open} onOpenChange={(next) => { if (!installLock.current) { setOpen(next); if (!next) detailSequence.current += 1; } }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>{detail?.name ?? "社区技能详情"}</DialogTitle><DialogDescription>{detail?.description ?? "查看来源、版本及许可后再安装。"}</DialogDescription></DialogHeader>
        {detailLoading && <p role="status">正在加载详情…</p>}
        {detailError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{detailError}</p>{!detail && <Button size="sm" variant="outline" onClick={() => { if (selected.current) void showDetail(selected.current); }}>重试详情</Button>}</div>}
        {detail && <>
          <div className="space-y-2 text-xs"><p>包名：{detail.packageName} · v{detail.version}</p><p>作者：{detail.author || "未填写"}</p><p>许可证：{detail.license || "未声明，请先核对授权"}</p>
            {detail.homepage && /^https?:\/\//i.test(detail.homepage) && <p><a href={detail.homepage} target="_blank" rel="noopener noreferrer" className="underline">查看项目主页</a></p>}
            <p>以下 README 是包说明，不代表已经读取到有效技能；安装时会验证 SKILL.md 和附属文件。</p>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-secondary p-3 font-mono text-xs">{detail.readme || "未提供 README"}</pre>
          <DialogFooter><Button size="sm" disabled={installing} onClick={() => { void install(); }}>{installing ? "安装中…" : "安装技能"}</Button></DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}

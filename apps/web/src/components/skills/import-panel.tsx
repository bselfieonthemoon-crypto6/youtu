"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Link2,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { importSkillFromUrl } from "@/lib/server-api";
import { skillErrorMessage } from "@/lib/skills-client";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportPanelProps {
  accessToken: () => string | undefined;
  onImported: () => Promise<void>;
  /** Optional: switch to installed tab after successful import */
  onSwitchToInstalled?: () => void;
}

// ---------------------------------------------------------------------------
// Import states
// ---------------------------------------------------------------------------

type ImportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; skillName: string }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// ImportPanel
// ---------------------------------------------------------------------------

export function ImportPanel({
  accessToken,
  onImported,
  onSwitchToInstalled,
}: ImportPanelProps) {
  const { success, error: showError } = useToast();

  const [url, setUrl] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [importState, setImportState] = useState<ImportState>({
    status: "idle",
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleImport = useCallback(async () => {
    if (pending.current) return;
    const token = accessToken();
    if (!token) { setImportState({ status: "error", message: "请登录后重试。" }); return; }

    const trimmed = url.trim();
    if (!trimmed) return;

    // Basic URL validation
    try {
      if (new URL(trimmed).protocol !== "https:") throw new Error("HTTPS required");
    } catch {
      setImportState({ status: "error", message: "请输入有效的 HTTPS URL" });
      return;
    }

    pending.current = true;
    setImportState({ status: "loading" });

    try {
      const result = await importSkillFromUrl(token, trimmed);
      if (!mounted.current || accessToken() !== token) return;
      setImportState({ status: "success", skillName: result.skill.name });
      success(`技能 "${result.skill.name}" 导入成功`);
      await onImported();
    } catch (err) {
      if (!mounted.current || accessToken() !== token) return;
      const msg = skillErrorMessage(err, "导入失败，请确认链接中包含有效的 SKILL.md 后重试。");
      setImportState({ status: "error", message: msg });
      showError(msg);
    } finally { pending.current = false; }
  }, [accessToken, url, onImported, success, showError]);

  const handleReset = useCallback(() => {
    setUrl("");
    setImportState({ status: "idle" });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && url.trim()) {
        handleImport();
      }
    },
    [handleImport, url],
  );

  const isLoading = importState.status === "loading";
  const isSuccess = importState.status === "success";
  const isError = importState.status === "error";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-lg">
      {/* Import card */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="rounded-xl border border-border bg-card p-6"
      >
        {/* Header */}
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
            <Link2 className="size-4 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-foreground">
              从 URL 导入技能
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              支持 GitHub 仓库 URL 和 npm tarball URL
            </p>
          </div>
        </div>

        {/* Input row */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <ExternalLink className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="url"
              placeholder="https://github.com/user/repo/tree/main/skills/my-skill"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                // Clear error state when user starts typing
                if (isError) {
                  setImportState({ status: "idle" });
                }
              }}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              aria-label="技能 URL"
              className={cn(
                "h-8 w-full rounded-lg border bg-transparent pl-8 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                isError
                  ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20"
                  : "border-input",
              )}
            />
          </div>
          <Button
            size="default"
            disabled={!url.trim() || isLoading}
            onClick={handleImport}
          >
            {isLoading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                导入中...
              </>
            ) : (
              <>
                导入
                <ArrowRight className="size-3.5" />
              </>
            )}
          </Button>
        </div>

        {/* Error message */}
        {isError && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-2 text-xs text-destructive"
          >
            {importState.message}
          </motion.p>
        )}

        {/* Success state */}
        {isSuccess && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-4 flex items-center justify-between rounded-lg border border-border bg-muted/50 px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-500" />
              <span className="text-sm font-medium text-foreground">
                {importState.skillName}
              </span>
              <span className="text-xs text-muted-foreground">已导入</span>
            </div>
            <div className="flex items-center gap-2">
              {onSwitchToInstalled && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={onSwitchToInstalled}
                >
                  查看已安装
                </Button>
              )}
              <Button variant="ghost" size="xs" onClick={handleReset}>
                继续导入
              </Button>
            </div>
          </motion.div>
        )}

        {/* Hint examples */}
        <div className="mt-4 space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            支持的格式
          </p>
          <div className="space-y-1">
            <p className="font-mono text-[11px] text-muted-foreground/70">
              https://github.com/user/repo/tree/main/skills/my-skill
            </p>
            <p className="font-mono text-[11px] text-muted-foreground/70">
              https://registry.npmjs.org/package/-/package-1.0.0.tgz
            </p>
          </div>
          <p className="text-xs text-muted-foreground">包内必须包含 SKILL.md；README 不会被当作技能。导入前请核对来源、许可和操作说明，安装不代表官方审核通过。</p>
        </div>
      </motion.div>
    </div>
  );
}

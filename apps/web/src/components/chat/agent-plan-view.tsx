"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ToolBlock } from "@loomic/shared";
import { getToolConfig } from "./utils";

export type AgentPlanStep = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export type AgentPlanBlock = {
  type: "plan";
  planId: string;
  revision: number;
  steps: AgentPlanStep[];
};

export const AgentPlanView = React.memo(function AgentPlanView({
  block,
  toolsByStepId,
  onLocateTool,
}: {
  block: AgentPlanBlock;
  toolsByStepId?: ReadonlyMap<string, ToolBlock[]>;
  onLocateTool?: (toolCallId: string) => void;
}) {
  const terminal = block.steps.length > 0 && block.steps.every(
    (step) => step.status === "completed" || step.status === "failed",
  );
  const [expanded, setExpanded] = useState(!terminal);
  const wasTerminal = useRef(terminal);

  useEffect(() => {
    if (!wasTerminal.current && terminal) setExpanded(false);
    wasTerminal.current = terminal;
  }, [terminal]);

  const completed = useMemo(
    () => block.steps.filter((step) => step.status === "completed").length,
    [block.steps],
  );

  if (block.steps.length === 0) return null;

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-muted/20"
      aria-label="Agent 执行计划"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={expanded}
      >
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m6 3 5 5-5 5" />
        </svg>
        <span className="min-w-0 flex-1 text-xs font-medium text-foreground">
          执行计划
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {completed}/{block.steps.length}
        </span>
      </button>

      {expanded && (
        <ol className="space-y-2 border-t border-border/70 px-3 py-3">
          {block.steps.map((step) => {
            const linkedTools = toolsByStepId?.get(step.id) ?? [];
            return (
              <li key={step.id} className="text-xs">
                <div className="flex items-start gap-2">
                  <PlanStepIcon status={step.status} />
                  <span
                    className={`min-w-0 flex-1 leading-5 ${
                      step.status === "completed"
                        ? "text-muted-foreground line-through decoration-muted-foreground/40"
                        : step.status === "failed"
                          ? "text-red-600"
                          : step.status === "in_progress"
                            ? "font-medium text-foreground"
                            : "text-muted-foreground"
                    }`}
                  >
                    {step.title}
                  </span>
                </div>
                {linkedTools.length > 0 && (
                  <ul className="ml-5 mt-1 space-y-1" aria-label={`${step.title} 的工具执行`}>
                    {linkedTools.map((tool) => (
                      <li key={tool.toolCallId}>
                        <button
                          type="button"
                          aria-controls={getToolExecutionAnchorId(tool.toolCallId)}
                          onClick={() => onLocateTool?.(tool.toolCallId)}
                          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <ToolExecutionStatus status={tool.status} />
                          <span className="min-w-0 flex-1 truncate">
                            {getToolConfig(tool.toolName).label}
                          </span>
                          <span className="shrink-0 text-[10px]">
                            {toolStatusLabel(tool.status)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
});

export function getToolExecutionAnchorId(toolCallId: string): string {
  return `tool-execution-${encodeURIComponent(toolCallId)}`;
}

function toolStatusLabel(status: ToolBlock["status"]): string {
  switch (status) {
    case "running": return "执行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "canceled": return "已取消";
  }
}

function ToolExecutionStatus({ status }: { status: ToolBlock["status"] }) {
  const color =
    status === "completed"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "canceled"
          ? "bg-muted-foreground/50"
          : "bg-accent animate-pulse";
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}

function PlanStepIcon({ status }: { status: AgentPlanStep["status"] }) {
  if (status === "in_progress") {
    return (
      <span
        aria-label="执行中"
        className="mt-1 h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-accent/30 border-t-accent"
      />
    );
  }
  if (status === "completed") {
    return (
      <svg
        aria-label="已完成"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path d="m3 8 3 3 7-7" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg
        aria-label="失败"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path d="m4 4 8 8m0-8-8 8" />
      </svg>
    );
  }
  return (
    <span
      aria-label="待执行"
      className="mt-1 h-3 w-3 shrink-0 rounded-full border border-muted-foreground/50"
    />
  );
}

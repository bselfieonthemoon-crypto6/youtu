"use client";

import type { AgentExecutionMode } from "@loomic/shared";
import { useExecutionMode } from "../hooks/use-execution-mode";

type ExecutionModeSelectorProps = {
  compact?: boolean;
  disabled?: boolean;
};

const labels: Record<AgentExecutionMode, string> = {
  fast: "Fast",
  thinking: "Thinking",
};

export function ExecutionModeSelector({
  compact = false,
  disabled = false,
}: ExecutionModeSelectorProps) {
  const { executionMode, setExecutionMode } = useExecutionMode();

  return (
    <label className="relative inline-flex shrink-0 items-center">
      <span className="sr-only">执行模式</span>
      <select
        aria-label="执行模式"
        title={
          executionMode === "fast"
            ? "Fast：快速响应"
            : "Thinking：深入规划后执行"
        }
        value={executionMode}
        disabled={disabled}
        onChange={(event) =>
          setExecutionMode(event.target.value as AgentExecutionMode)
        }
        className={`appearance-none rounded-full border-[0.5px] border-border bg-background text-foreground outline-none transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
          compact
            ? "h-8 max-w-[92px] py-0 pl-3 pr-7 text-[11px]"
            : "h-8 py-0 pl-3 pr-7 text-xs"
        }`}
      >
        {(Object.keys(labels) as AgentExecutionMode[]).map((mode) => (
          <option key={mode} value={mode}>
            {labels[mode]}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 h-3 w-3 text-muted-foreground"
        viewBox="0 0 12 12"
        fill="none"
      >
        <path
          d="m3 4.5 3 3 3-3"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </label>
  );
}

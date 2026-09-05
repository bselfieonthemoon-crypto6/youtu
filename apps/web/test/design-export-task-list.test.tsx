// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import type { BackgroundJob } from "@loomic/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignExportTaskList } from "../src/components/design/design-export-task-list";

afterEach(cleanup);

describe("DesignExportTaskList", () => {
  it("shows real running progress and exposes cancellation", () => {
    const onCancel = vi.fn();
    const job = exportJob({ status: "running", attempt_count: 1 });
    render(
      <DesignExportTaskList
        jobs={[job]}
        onRefresh={vi.fn()}
        onCancel={onCancel}
        onRetry={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByText("PNG · 2× · 版本 4")).toBeInTheDocument();
    expect(screen.getByText("正在处理 · 尝试 1/3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledWith(job);
  });

  it("offers retry only for terminal failures", () => {
    const onRetry = vi.fn();
    const job = exportJob({
      status: "failed",
      error_code: "render_failed",
      error_message: "内存预算不足",
      failed_at: "2026-09-04T00:01:00.000Z",
    });
    render(
      <DesignExportTaskList
        jobs={[job]}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onRetry={onRetry}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("内存预算不足");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledWith(job);
    expect(
      screen.queryByRole("button", { name: "取消" }),
    ).not.toBeInTheDocument();
  });

  it("downloads only a succeeded job with a protected asset result", () => {
    const onDownload = vi.fn();
    const job = exportJob({
      status: "succeeded",
      result: {
        asset_object_id: "50000000-0000-4000-8000-000000000001",
        design_id: "10000000-0000-4000-8000-000000000001",
        revision: 4,
        format: "png",
        width: 8000,
        height: 8000,
        byte_size: 2_097_152,
        expires_at: "2026-09-11T00:00:00.000Z",
      },
      completed_at: "2026-09-04T00:01:00.000Z",
    });
    render(
      <DesignExportTaskList
        jobs={[job]}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onDownload={onDownload}
      />,
    );

    expect(screen.getByText("8000 × 8000 · 2.0 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(onDownload).toHaveBeenCalledWith(job);
  });
});

function exportJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    workspace_id: "20000000-0000-4000-8000-000000000002",
    project_id: "30000000-0000-4000-8000-000000000001",
    canvas_id: null,
    target_kind: "design",
    design_id: "10000000-0000-4000-8000-000000000001",
    session_id: null,
    thread_id: null,
    queue_name: "design_export_jobs",
    job_type: "design_export",
    status: "queued",
    payload: {
      design_id: "10000000-0000-4000-8000-000000000001",
      revision: 4,
      idempotency_key: "20000000-0000-4000-8000-000000000001",
      requested_by: "20000000-0000-4000-8000-000000000002",
      format: "png",
      multiplier: 2,
      transparent: false,
    },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: "20000000-0000-4000-8000-000000000002",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

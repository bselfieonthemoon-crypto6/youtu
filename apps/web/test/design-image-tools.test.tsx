import "@testing-library/jest-dom/vitest";

import type { BackgroundJob, DesignObject } from "@loomic/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignImageTools } from "../src/components/design/design-image-tools";

afterEach(cleanup);

describe("DesignImageTools", () => {
  it("keeps model tools disabled until exactly one image is selected", () => {
    render(
      <DesignImageTools
        selectedImage={null}
        jobs={[]}
        onRun={vi.fn()}
        onStartRegion={vi.fn()}
        onStartErase={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "去除背景" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "框选主体" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "橡皮擦除" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "图层拆分" })).toBeDisabled();
  });

  it("exposes every required entry for a selected design image", () => {
    const onRun = vi.fn();
    const onStartRegion = vi.fn();
    const onStartErase = vi.fn();
    render(
      <DesignImageTools
        selectedImage={imageObject()}
        jobs={[]}
        onRun={onRun}
        onStartRegion={onStartRegion}
        onStartErase={onStartErase}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "去除背景" }));
    fireEvent.click(screen.getByRole("button", { name: "框选主体" }));
    fireEvent.click(screen.getByRole("button", { name: "橡皮擦除" }));
    fireEvent.click(screen.getByRole("button", { name: "图层拆分" }));

    expect(onRun).toHaveBeenNthCalledWith(1, "remove_background");
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText("AI 图层拆分")).toBeInTheDocument();
    // AI splitting opens the current configuration panel; the separate
    // local entry retains the legacy split_layers callback contract.
    fireEvent.click(screen.getByRole("button", { name: "本地拆分" }));
    expect(onRun).toHaveBeenNthCalledWith(2, "split_layers");
    expect(onStartRegion).toHaveBeenCalledOnce();
    expect(onStartErase).toHaveBeenCalledOnce();
  });

  it("shows restored progress, finalization conflicts, and cancellation", () => {
    const onCancel = vi.fn();
    render(
      <DesignImageTools
        selectedImage={imageObject()}
        jobs={[
          imageJob(),
          imageJob({
            id: "10000000-0000-4000-8000-000000000099",
            status: "succeeded",
            result: {
              target_finalization: {
                status: "needs_attention",
                error_message: "源图片版本已经变化",
              },
            },
          }),
        ]}
        onRun={vi.fn()}
        onStartRegion={vi.fn()}
        onStartErase={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText(/处理中/)).toBeInTheDocument();
    expect(screen.getByText("需要处理冲突")).toBeInTheDocument();
    expect(screen.getByText("源图片版本已经变化")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消智能擦除" }));
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
    );
  });
});

function imageObject(): Extract<DesignObject, { type: "image" }> {
  return {
    objectId: "20000000-0000-4000-8000-000000000001",
    objectVersion: 1,
    type: "image",
    name: "产品图",
    role: null,
    x: 20,
    y: 30,
    width: 320,
    height: 180,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    assetObjectId: "30000000-0000-4000-8000-000000000001",
    fit: "cover",
  };
}

function imageJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    workspace_id: "40000000-0000-4000-8000-000000000001",
    project_id: "50000000-0000-4000-8000-000000000001",
    canvas_id: null,
    target_kind: "design",
    design_id: "60000000-0000-4000-8000-000000000001",
    session_id: null,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "running",
    payload: { operation: "smart_erase" },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: "70000000-0000-4000-8000-000000000001",
    created_at: "2026-09-07T00:00:00.000Z",
    updated_at: "2026-09-07T00:00:01.000Z",
    started_at: "2026-09-07T00:00:01.000Z",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  type Database,
  SKILL_WHEN_TO_USE_MAX_CHARS,
  canvasDetailSchema,
  canvasSaveResponseSchema,
  errorCodeValues,
  healthResponseSchema,
  readSkillRuntimeMetadata,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  skillRuntimeMetadataSchema,
  streamEventSchema,
} from "./index.js";
import * as sharedExports from "./index.js";

const databaseTypeSource = readFileSync(
  new URL("./supabase/database.ts", import.meta.url),
  "utf8",
);

describe("@loomic/shared contracts", () => {
  it("preserves optional send-time selection without inventing authority or defaults", () => {
    const payload = { sessionId: "session", conversationId: "conversation", prompt: "看看选中的文字", canvasId: "canvas-1" };
    expect(runCreateRequestSchema.parse(payload)).not.toHaveProperty("canvasSelection");
    expect(runCreateRequestSchema.parse({ ...payload, canvasSelection: { elementIds: [] } }).canvasSelection).toEqual({ elementIds: [] });
    const elementIds = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    expect(runCreateRequestSchema.parse({ ...payload, canvasSelection: { elementIds } }).canvasSelection).toEqual({ elementIds });
  });

  it.each([
    { elementIds: Array.from({ length: 101 }, (_, i) => `text-${i}`) },
    { elementIds: ["same", "same"] },
    { elementIds: [""] },
    { elementIds: ["x".repeat(201)] },
    { elementIds: ["text"], authorized: true },
    { elementIds: ["text"], canvasId: "foreign-canvas" },
  ])("rejects invalid or authority-bearing selection metadata: %j", canvasSelection => {
    expect(runCreateRequestSchema.safeParse({ sessionId: "session", conversationId: "conversation", prompt: "test", canvasSelection }).success).toBe(false);
  });

  it("shares the health response schema for server and web", () => {
    const parsed = healthResponseSchema.parse({
      ok: true,
      service: "loomic-server",
      version: "0.1.0",
      agentRuntime: "mastra",
      cached: false,
      checkedAt: "2026-09-21T00:00:00.000Z",
      components: {
        database: { status: "ok", detail: "write+read ok", latencyMs: 12 },
        agentRuntime: { status: "ok", detail: "mastra configured", latencyMs: 3 },
        queue: { status: "ok", detail: "4 queues empty", latencyMs: 8 },
        storage: { status: "ok", detail: "bucket reachable", latencyMs: 21 },
        worker: { status: "ok", detail: "1 online (w1)", latencyMs: 6 },
      },
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("loomic-server");
    expect(parsed.agentRuntime).toBe("mastra");
    expect(Object.keys(parsed.components).sort()).toEqual([
      "agentRuntime",
      "database",
      "queue",
      "storage",
      "worker",
    ]);
  });

  it("accepts a degraded health payload so a serving server can still report problems", () => {
    const parsed = healthResponseSchema.parse({
      ok: true,
      service: "loomic-server",
      version: "0.1.0",
      agentRuntime: "mastra",
      cached: true,
      checkedAt: "2026-09-21T00:00:00.000Z",
      components: {
        database: { status: "ok", detail: "write+read ok", latencyMs: 12 },
        agentRuntime: { status: "ok", detail: "mastra configured", latencyMs: 3 },
        queue: { status: "ok", detail: "4 queues empty", latencyMs: 8 },
        storage: { status: "failed", detail: "error:404", latencyMs: 700 },
        worker: {
          status: "degraded",
          detail: "offline: no heartbeat within 30s",
          latencyMs: 5,
        },
      },
    });

    // `ok` reports whether the stack can SERVE, not whether everything is
    // perfect, which is exactly what flips to false for a database write failure.
    expect(parsed.ok).toBe(true);
    expect(parsed.components.worker.status).toBe("degraded");
    expect(parsed.components.storage.detail).toBe("error:404");
  });

  it("refuses a health payload that omits a probed component or hides its status", () => {
    const base = {
      agentRuntime: "mastra",
      cached: false,
      checkedAt: "2026-09-21T00:00:00.000Z",
      ok: true,
      service: "loomic-server",
      version: "0.1.0",
    };
    const components = {
      agentRuntime: { status: "ok", detail: "mastra configured", latencyMs: 3 },
      database: { status: "ok", detail: "write+read ok", latencyMs: 12 },
      queue: { status: "ok", detail: "4 queues empty", latencyMs: 8 },
      storage: { status: "ok", detail: "bucket reachable", latencyMs: 21 },
      worker: { status: "ok", detail: "1 online (w1)", latencyMs: 6 },
    };

    const { storage: _omitted, ...withoutStorage } = components;
    expect(
      healthResponseSchema.safeParse({ ...base, components: withoutStorage }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({
        ...base,
        components: { ...components, database: { detail: "ok", latencyMs: 1 } },
      }).success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({
        ...base,
        components: {
          ...components,
          worker: { status: "unknown", detail: "?", latencyMs: 1 },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts canvasId as optional field", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
      canvasId: "canvas-1",
    });
    expect(result.canvasId).toBe("canvas-1");
  });

  it("succeeds without canvasId (backward compat)", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
    });
    expect(result.canvasId).toBeUndefined();
  });

  it("accepts optional attachments in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Analyze this image",
      attachments: [
        {
          assetId: "asset-123",
          url: "https://example.com/image.png",
          mimeType: "image/png",
        },
      ],
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].assetId).toBe("asset-123");
  });

  it("accepts optional image generation preference in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Generate a campaign key visual",
      imageGenerationPreference: {
        mode: "manual",
        models: [
          "google/nano-banana-2",
          "black-forest-labs/flux-kontext-pro",
        ],
      },
    });

    expect(result.imageGenerationPreference?.mode).toBe("manual");
    expect(result.imageGenerationPreference?.models).toEqual([
      "google/nano-banana-2",
      "black-forest-labs/flux-kontext-pro",
    ]);
  });

  it("accepts optional mentions in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "参考品牌资产生成一张海报",
      mentions: [
        {
          mentionType: "image-model",
          id: "google/nano-banana-2",
          label: "Nano Banana 2",
        },
        {
          mentionType: "brand-kit-asset",
          id: "brand-logo-1",
          label: "Loomic 主 Logo",
          assetType: "logo",
          fileUrl: "https://example.com/logo.png",
        },
      ],
    });

    expect(result.mentions).toHaveLength(2);
    expect(result.mentions?.[0]?.mentionType).toBe("image-model");
    expect(result.mentions?.[1]).toMatchObject({
      mentionType: "brand-kit-asset",
      assetType: "logo",
      fileUrl: "https://example.com/logo.png",
    });
  });

  it("accepts sessionId and conversationId for run creation", () => {
    const request = runCreateRequestSchema.parse({
      sessionId: "session_123",
      conversationId: "conversation_123",
      prompt: "Create a new storyboard outline",
    });

    const response = runCreateResponseSchema.parse({
      runId: "run_123",
      sessionId: request.sessionId,
      conversationId: request.conversationId,
      status: "accepted",
    });

    expect(request.sessionId).toBe("session_123");
    expect(response.status).toBe("accepted");
  });

  it("rejects run creation without a real sessionId", () => {
    expect(() =>
      runCreateRequestSchema.parse({
        conversationId: "conversation_123",
        prompt: "Create a new storyboard outline",
      }),
    ).toThrow();
  });

  it("shares a stable cancel response schema", () => {
    const parsed = runCancelResponseSchema.parse({
      runId: "run_123",
      status: "canceling",
    });

    expect(parsed.status).toBe("canceling");
  });

  it("shares the viewer bootstrap contract for GET /api/viewer", () => {
    const viewerResponseSchema = getExportedSchema("viewerResponseSchema");

    const parsed = viewerResponseSchema.parse({
      profile: {
        id: "user_123",
        email: "maker@loomic.test",
        displayName: "Loomic Maker",
        avatarUrl: "https://example.com/avatar.png",
      },
      workspace: {
        id: "workspace_123",
        name: "Loomic Maker",
        type: "personal",
        ownerUserId: "user_123",
      },
      membership: {
        workspaceId: "workspace_123",
        userId: "user_123",
        role: "owner",
      },
    });

    expect(parsed.profile.id).toBe("user_123");
    expect(parsed.workspace.ownerUserId).toBe("user_123");
    expect(parsed.membership.workspaceId).toBe("workspace_123");
  });

  it("shares project list and create contracts for GET/POST /api/projects", () => {
    const projectListResponseSchema = getExportedSchema(
      "projectListResponseSchema",
    );
    const projectCreateRequestSchema = getExportedSchema(
      "projectCreateRequestSchema",
    );
    const projectCreateResponseSchema = getExportedSchema(
      "projectCreateResponseSchema",
    );

    const createRequest = projectCreateRequestSchema.parse({
      name: "Brand System",
      description: "Primary workspace project",
    });

    const parsedList = projectListResponseSchema.parse({
      projects: [
        {
          id: "project_123",
          name: createRequest.name,
          slug: "brand-system",
          description: createRequest.description,
          workspace: {
            id: "workspace_123",
            name: "Loomic Maker",
            type: "personal",
            ownerUserId: "user_123",
          },
          primaryCanvas: {
            id: "canvas_123",
            name: "Main Canvas",
            isPrimary: true,
          },
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:00:00.000Z",
        },
      ],
    });
    const createdProject = projectCreateResponseSchema.parse({
      project: parsedList.projects[0],
    });

    expect(parsedList.projects[0].id).toBe("project_123");
    expect(parsedList.projects[0].workspace.ownerUserId).toBe("user_123");
    expect(parsedList.projects[0].primaryCanvas.id).toBe("canvas_123");
    expect(createdProject.project.primaryCanvas.isPrimary).toBe(true);
  });

  it("shares stable unauthenticated and application error payloads", () => {
    const unauthenticatedErrorResponseSchema = getExportedSchema(
      "unauthenticatedErrorResponseSchema",
    );
    const applicationErrorResponseSchema = getExportedSchema(
      "applicationErrorResponseSchema",
    );

    const unauthenticated = unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
      },
    });
    const applicationError = applicationErrorResponseSchema.parse({
      error: {
        code: "project_create_failed",
        message: "Unable to create project.",
      },
    });

    expect(unauthenticated.error.code).toBe("unauthorized");
    expect(JSON.parse(JSON.stringify(applicationError))).toEqual(
      applicationError,
    );
  });

  it("rejects an empty project name in project create requests", () => {
    const projectCreateRequestSchema = getExportedSchema(
      "projectCreateRequestSchema",
    );

    expect(() =>
      projectCreateRequestSchema.parse({
        name: "",
      }),
    ).toThrow();
  });

  it("rejects a whitespace-only project name", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("trims a valid project name", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({ name: "  My Project  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("My Project");
    }
  });

  it("trims a valid project description", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({
      name: "Test",
      description: "  Some desc  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Some desc");
    }
  });

  it("rejects a project response without primary canvas metadata", () => {
    const projectListResponseSchema = getExportedSchema(
      "projectListResponseSchema",
    );

    expect(() =>
      projectListResponseSchema.parse({
        projects: [
          {
            id: "project_123",
            name: "Brand System",
            slug: "brand-system",
            description: "Primary workspace project",
            workspace: {
              id: "workspace_123",
              name: "Loomic Maker",
              type: "personal",
              ownerUserId: "user_123",
            },
            createdAt: "2026-03-23T12:00:00.000Z",
            updatedAt: "2026-03-23T12:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid application error codes", () => {
    const applicationErrorResponseSchema = getExportedSchema(
      "applicationErrorResponseSchema",
    );

    expect(() =>
      applicationErrorResponseSchema.parse({
        error: {
          code: "database_exploded",
          message: "Unexpected failure.",
        },
      }),
    ).toThrow();
  });

  it("includes the required minimum stream event union", () => {
    const eventTypes = [
      "run.started",
      "message.delta",
      "plan.updated",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "run.canceled",
      "run.completed",
      "run.failed",
    ];

    for (const type of eventTypes) {
      expect(() => {
        switch (type) {
          case "run.started":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              sessionId: "session_123",
              conversationId: "conversation_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "message.delta":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              messageId: "message_123",
              delta: "hello",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "plan.updated":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              planId: "plan_run_123",
              revision: 1,
              steps: [
                {
                  id: "step_1",
                  title: "Inspect the canvas",
                  status: "in_progress",
                },
                {
                  id: "step_2",
                  title: "Create the design",
                  status: "pending",
                },
              ],
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "tool.started":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              toolCallId: "tool_123",
              toolName: "example_tool",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "tool.completed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              toolCallId: "tool_123",
              toolName: "example_tool",
              outputSummary: "done",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "tool.failed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              toolCallId: "tool_123",
              toolName: "example_tool",
              error: { code: "tool_failed", message: "failed" },
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.completed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.canceled":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.failed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              error: {
                code: "run_failed",
                message: "The run failed.",
              },
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          default:
            throw new Error(`Unexpected event type: ${type}`);
        }
      }).not.toThrow();
    }
  });

  it("validates image ratio independently of model selection", () => {
    const request = { sessionId: "session-1", conversationId: "conv-1", prompt: "宣传图", imageGenerationPreference: { mode: "auto", models: [], aspectRatio: "16:9" } };
    expect(runCreateRequestSchema.parse(request).imageGenerationPreference?.aspectRatio).toBe("16:9");
    expect(runCreateRequestSchema.safeParse({ ...request, imageGenerationPreference: { ...request.imageGenerationPreference, aspectRatio: "invalid" } }).success).toBe(false);
  });

  it("exposes the authoritative Canvas revision required by design CAS", () => {
    expect(
      canvasDetailSchema.parse({
        id: "canvas-1",
        name: "Main Canvas",
        projectId: "project-1",
        revision: 7,
        content: { elements: [], appState: {}, files: {} },
      }).revision,
    ).toBe(7);
    expect(() =>
      canvasDetailSchema.parse({
        id: "canvas-1",
        name: "Main Canvas",
        projectId: "project-1",
        content: { elements: [], appState: {}, files: {} },
      }),
    ).toThrow();
  });

  it("returns the new authoritative revision after a Canvas save", () => {
    expect(canvasSaveResponseSchema.parse({ ok: true, revision: 8 })).toEqual({
      ok: true,
      revision: 8,
    });
    expect(() => canvasSaveResponseSchema.parse({ ok: true })).toThrow();
  });

  it("accepts only the closed Fast/Thinking execution modes", () => {
    const base = {
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
    };

    expect(runCreateRequestSchema.parse({ ...base, executionMode: "fast" }))
      .toMatchObject({ executionMode: "fast" });
    expect(
      runCreateRequestSchema.parse({ ...base, executionMode: "thinking" }),
    ).toMatchObject({ executionMode: "thinking" });
    expect(() =>
      runCreateRequestSchema.parse({ ...base, executionMode: "ultra" }),
    ).toThrow();
    expect(runCreateRequestSchema.parse(base).executionMode).toBeUndefined();
  });

  it("validates plan blocks and expanded tool terminal statuses", () => {
    const plan = sharedExports.contentBlockSchema.parse({
      type: "plan",
      planId: "plan_run_123",
      revision: 2,
      steps: [
        { id: "step_1", title: "Inspect", status: "completed" },
        { id: "step_2", title: "Render", status: "failed" },
      ],
    });

    expect(plan.type).toBe("plan");
    expect(() =>
      sharedExports.contentBlockSchema.parse({
        type: "tool",
        toolCallId: "tool_123",
        toolName: "generate_image",
        status: "canceled",
      }),
    ).not.toThrow();
    expect(() =>
      sharedExports.contentBlockSchema.parse({
        type: "tool",
        toolCallId: "tool_456",
        toolName: "generate_image",
        status: "failed",
      }),
    ).not.toThrow();
    expect(() =>
      sharedExports.contentBlockSchema.parse({
        type: "tool",
        toolCallId: "tool_linked",
        toolName: "inspect_canvas",
        status: "running",
        planId: "plan_run_123",
        planStepId: "step_1",
      }),
    ).not.toThrow();
    expect(() =>
      sharedExports.contentBlockSchema.parse({
        type: "tool",
        toolCallId: "tool_half_linked",
        toolName: "inspect_canvas",
        status: "running",
        planStepId: "step_1",
      }),
    ).toThrow();
  });

  it("validates structured clarification blocks and rejects oversized questionnaires", () => {
    expect(sharedExports.contentBlockSchema.parse({
      type: "clarification",
      version: 1,
      clarificationId: "clarification-1",
      questions: [{
        id: 1,
        title: "用途",
        prompt: "主要用在哪里？",
        options: ["App 图标", "门头"],
        allowCustom: true,
      }],
    })).toMatchObject({ type: "clarification", questions: [{ title: "用途" }] });
    expect(() => sharedExports.clarificationRequestInputSchema.parse({
      questions: Array.from({ length: 5 }, (_, index) => ({
        title: `问题${index + 1}`,
        prompt: "请回答",
        options: [],
      })),
    })).toThrow();
  });

  it("requires plan links on tool events to appear as a pair", () => {
    const base = {
      runId: "run_123",
      toolCallId: "tool_123",
      toolName: "inspect_canvas",
      timestamp: "2026-03-23T12:00:00.000Z",
    };
    expect(() => streamEventSchema.parse({
      ...base,
      type: "tool.started",
      planId: "plan_run_123",
      planStepId: "step_1",
    })).not.toThrow();
    expect(() => streamEventSchema.parse({
      ...base,
      type: "tool.completed",
      planId: "plan_run_123",
    })).toThrow();
    expect(() => streamEventSchema.parse({
      ...base,
      type: "tool.failed",
      planStepId: "step_1",
      error: { code: "tool_failed", message: "failed" },
    })).toThrow();
  });

  it("keeps stable messageId and toolCallId correlation fields", () => {
    const messageEvent = streamEventSchema.parse({
      type: "message.delta",
      runId: "run_123",
      messageId: "message_123",
      delta: "hello",
      timestamp: "2026-03-23T12:00:00.000Z",
    });

    const toolEvent = streamEventSchema.parse({
      type: "tool.completed",
      runId: "run_123",
      toolCallId: "tool_123",
      toolName: "inspect_canvas",
      outputSummary: "Matched 2 files",
      timestamp: "2026-03-23T12:00:01.000Z",
    });

    if (messageEvent.type !== "message.delta") {
      throw new Error("Expected message.delta event.");
    }

    if (toolEvent.type !== "tool.completed") {
      throw new Error("Expected tool.completed event.");
    }

    expect(messageEvent.messageId).toBe("message_123");
    expect(toolEvent.toolCallId).toBe("tool_123");
  });

  it("requires correlation fields for message and tool lifecycle events", () => {
    expect(() =>
      streamEventSchema.parse({
        type: "message.delta",
        runId: "run_123",
        delta: "hello",
        timestamp: "2026-03-23T12:00:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      streamEventSchema.parse({
        type: "tool.completed",
        runId: "run_123",
        toolName: "inspect_canvas",
        outputSummary: "Matched 2 files",
        timestamp: "2026-03-23T12:00:01.000Z",
      }),
    ).toThrow();
  });

  it("exports stable error codes that serialize as plain JSON", () => {
    expect(errorCodeValues).toEqual([
      "invalid_request",
      "run_not_found",
      "run_conflict",
      "run_failed",
      "tool_failed",
    ]);
    expect(JSON.parse(JSON.stringify(errorCodeValues))).toEqual(
      errorCodeValues,
    );
  });

  it("keeps run creation response stable for clients while hiding checkpoint internals", () => {
    const response = runCreateResponseSchema.parse({
      runId: "run_123",
      sessionId: "session_123",
      conversationId: "conversation_123",
      status: "accepted",
      checkpointId: "checkpoint_123",
      checkpointNamespace: "root",
    });

    expect(response).toEqual({
      runId: "run_123",
      sessionId: "session_123",
      conversationId: "conversation_123",
      status: "accepted",
    });
  });

  it("tracks server-owned thread_id in shared Supabase typings", () => {
    expect(databaseTypeSource).toMatch(/thread_id:\s*string \| null/);
  });

  it("declares shared agent_runs persistence typings", () => {
    expect(databaseTypeSource).toMatch(/agent_runs:\s*{/);
    expect(databaseTypeSource).toMatch(/session_id:\s*string/);
    expect(databaseTypeSource).toMatch(/thread_id:\s*string/);
  });

  it("tracks official langgraph persistence schema typings", () => {
    expect(databaseTypeSource).toMatch(/langgraph:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoint_migrations:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoints:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoint_blobs:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoint_writes:\s*{/);
    expect(databaseTypeSource).toMatch(/store:\s*{/);
  });
});

describe("skill runtime selection metadata", () => {
  const baseMetadata = {
    schemaVersion: 1,
    execution: "guidance",
    intents: ["probe"],
    outputKinds: ["design-brief"],
    requiredTools: [],
    optionalTools: [],
    models: [],
    limitations: [],
    examples: [],
    sources: [],
  };

  it("accepts whenToUse as trimmed selection text that grants nothing", () => {
    expect(skillRuntimeMetadataSchema.parse(baseMetadata)).not.toHaveProperty("whenToUse");
    const parsed = skillRuntimeMetadataSchema.parse({ ...baseMetadata, whenToUse: "  用户要…时使用；…时不使用。  " });
    expect(parsed.whenToUse).toBe("用户要…时使用；…时不使用。");
    // Selection text is model-facing only: it must not add tools, models or authority.
    expect(parsed).toMatchObject({ requiredTools: [], optionalTools: [], models: [], execution: "guidance" });
  });

  it("bounds whenToUse and keeps the strict object rejecting unknown keys", () => {
    expect(SKILL_WHEN_TO_USE_MAX_CHARS).toBe(400);
    expect(skillRuntimeMetadataSchema.parse({ ...baseMetadata, whenToUse: "x".repeat(SKILL_WHEN_TO_USE_MAX_CHARS) }).whenToUse)
      .toHaveLength(SKILL_WHEN_TO_USE_MAX_CHARS);
    expect(() => skillRuntimeMetadataSchema.parse({ ...baseMetadata, whenToUse: "x".repeat(SKILL_WHEN_TO_USE_MAX_CHARS + 1) })).toThrow();
    expect(() => skillRuntimeMetadataSchema.parse({ ...baseMetadata, whenToUse: "   " })).toThrow();
    expect(() => skillRuntimeMetadataSchema.parse({ ...baseMetadata, routing: undefined, whenToUse: "ok", grantsAuthority: true })).toThrow();
  });

  it("reads whenToUse through the metadata.loomic wrapper real manifests use", () => {
    const manifest = (loomic: Record<string, unknown>) => ({ bundle: "loomic-design-skills-v2", loomic });
    expect(readSkillRuntimeMetadata(manifest({ ...baseMetadata, whenToUse: "仅当用户明确接受近似尺寸时使用。" }))?.whenToUse)
      .toBe("仅当用户明确接受近似尺寸时使用。");
    // Third-party / older packages simply omit the field: absence is not a failure.
    expect(readSkillRuntimeMetadata(manifest({ ...baseMetadata }))?.whenToUse).toBeUndefined();
    expect(readSkillRuntimeMetadata(manifest({ ...baseMetadata, whenToUse: "ok", unexpected: true }))).toBeNull();
  });
});

type AssertTrue<T extends true> = T;
type Extends<T, U> = [T] extends [U] ? true : false;

const chatSessionRowSupportsServerOwnedThreadId: AssertTrue<
  Extends<
    Database["public"]["Tables"]["chat_sessions"]["Row"],
    { thread_id: string | null }
  >
> = true;

const agentRunsRowTracksSessionAndThread: AssertTrue<
  Extends<
    Database["public"]["Tables"]["agent_runs"]["Row"],
    {
      session_id: string;
      thread_id: string;
      status: string;
      created_at: string;
      completed_at: string | null;
      error_code: string | null;
      error_message: string | null;
    }
  >
> = true;

void chatSessionRowSupportsServerOwnedThreadId;
void agentRunsRowTracksSessionAndThread;

const langgraphCheckpointsRowMatchesOfficialSchema: AssertTrue<
  Extends<
    Database["langgraph"]["Tables"]["checkpoints"]["Row"],
    {
      thread_id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      checkpoint: unknown;
      metadata: unknown;
    }
  >
> = true;

void langgraphCheckpointsRowMatchesOfficialSchema;

function getExportedSchema(name: string): ZodType {
  const candidate = (sharedExports as Record<string, unknown>)[name];

  expect(candidate, `${name} export is missing`).toBeDefined();

  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("parse" in candidate) ||
    typeof candidate.parse !== "function"
  ) {
    throw new Error(`${name} is not a Zod schema export.`);
  }

  return candidate as ZodType;
}

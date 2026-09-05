import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../../supabase/user.js";
import { createCanvasService } from "./canvas-service.js";

const user: AuthenticatedUser = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@local.test",
  accessToken: "token",
  userMetadata: {},
};

describe("CanvasService design CAS revision", () => {
  it("selects and returns the authoritative Canvas revision", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({
        data: {
          id: "20000000-0000-4000-8000-000000000001",
          name: "Main Canvas",
          project_id: "30000000-0000-4000-8000-000000000001",
          revision: 9,
          content: { elements: [], appState: {}, files: {} },
        },
        error: null,
      })),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const service = createCanvasService({
      createUserClient: () => ({ from: vi.fn(() => query) }) as never,
    });

    await expect(
      service.getCanvas(user, "20000000-0000-4000-8000-000000000001"),
    ).resolves.toMatchObject({ revision: 9 });
    expect(query.select).toHaveBeenCalledWith(
      "id, name, project_id, revision, content",
    );
  });

  it("increments and returns revision after a successful content CAS", async () => {
    const scopeQuery = terminalQuery({
      project_id: "30000000-0000-4000-8000-000000000001",
    });
    const projectQuery = terminalQuery({
      workspace_id: "40000000-0000-4000-8000-000000000001",
    });
    const latestQuery = terminalQuery({
      content: { elements: [], appState: {}, files: {} },
      updated_at: "2026-09-04T00:00:00.000Z",
      revision: 11,
    });
    const updateQuery = updateTerminalQuery({ id: "canvas", revision: 12 });
    const canvasRoot = {
      select: vi.fn((columns: string) =>
        columns === "project_id" ? scopeQuery : latestQuery,
      ),
      update: vi.fn(() => updateQuery),
    };
    const client = {
      from: vi.fn((table: string) =>
        table === "canvases"
          ? canvasRoot
          : { select: vi.fn(() => projectQuery) },
      ),
      rpc: vi.fn(async () => ({ data: [], error: null })),
    };
    const service = createCanvasService({
      createUserClient: () => client as never,
    });

    await expect(
      service.saveCanvasContent(user, "20000000-0000-4000-8000-000000000001", {
        elements: [],
        appState: {},
        files: {},
      }),
    ).resolves.toBe(12);
    expect(canvasRoot.update).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 12 }),
    );
    expect(updateQuery.eq).toHaveBeenCalledWith("revision", 11);
    expect(updateQuery.select).toHaveBeenCalledWith("id, revision");
  });
});

function terminalQuery(data: unknown) {
  const query = {
    eq: vi.fn(),
    single: vi.fn(async () => ({ data, error: null })),
  };
  query.eq.mockReturnValue(query);
  return query;
}

function updateTerminalQuery(data: unknown) {
  const query = {
    eq: vi.fn(),
    select: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  query.eq.mockReturnValue(query);
  query.select.mockReturnValue(query);
  return query;
}

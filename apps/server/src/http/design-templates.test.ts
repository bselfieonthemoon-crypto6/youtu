import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDesignTemplateRoutes } from "./design-templates.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
const templateId = "11111111-1111-4111-8111-111111111111";
const designId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function setup(authenticated = true) {
  const app = Fastify();
  apps.push(app);
  const auth = {
    authenticate: vi.fn(async () =>
      authenticated
        ? { id: "user-1", accessToken: "token", email: "u@example.test" }
        : null,
    ),
  };
  const templateService = {
    list: vi.fn(async () => ({ items: [], next_cursor: null })),
    get: vi.fn(async () => ({ template: { id: templateId } })),
    createFromDesign: vi.fn(async () => ({ template: { id: templateId } })),
    updateVariables: vi.fn(async () => ({ entity_id: templateId })),
    previewReplace: vi.fn(async () => ({
      design_id: designId,
      template_id: templateId,
      design_revision: 2,
      template_revision: 3,
      commands: [],
      differences: [],
      unresolved_keys: [],
    })),
    applyReplace: vi.fn(async () => ({
      preview: {
        design_id: designId,
        template_id: templateId,
        design_revision: 2,
        template_revision: 3,
        commands: [],
        differences: [],
        unresolved_keys: [],
      },
      mutation: {
        design_id: designId,
        revision: 3,
        changed_object_ids: [],
        replayed: false,
      },
    })),
  };
  await registerDesignTemplateRoutes(app, {
    auth: auth as never,
    templateService: templateService as never,
  });
  return { app, templateService };
}

describe("design template routes", () => {
  it("requires authentication", async () => {
    const { app, templateService } = await setup(false);
    const response = await app.inject({
      method: "GET",
      url: "/api/design-templates",
    });
    expect(response.statusCode).toBe(401);
    expect(templateService.list).not.toHaveBeenCalled();
  });

  it("validates list pagination and loads detail by a canonical id", async () => {
    const { app, templateService } = await setup();
    const list = await app.inject({
      method: "GET",
      url: "/api/design-templates?scope=platform&status=published&limit=20",
    });
    expect(list.statusCode).toBe(200);
    expect(templateService.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      { scope: "platform", status: "published", limit: 20 },
    );
    const detail = await app.inject({
      method: "GET",
      url: `/api/design-templates/${templateId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(templateService.get).toHaveBeenCalledWith(
      expect.anything(),
      templateId,
    );
    const invalid = await app.inject({
      method: "GET",
      url: "/api/design-templates?limit=0",
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("validates scope/workspace consistency before create-from-design", async () => {
    const { app, templateService } = await setup();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/admin/design-catalog/templates/from-design",
      payload: {
        request_id: templateId,
        design_id: designId,
        scope: "platform",
        workspace_id: workspaceId,
        name: "Template",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(templateService.createFromDesign).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: "POST",
      url: "/api/admin/design-catalog/templates/from-design",
      payload: {
        request_id: templateId,
        design_id: designId,
        scope: "workspace",
        workspace_id: workspaceId,
        name: "Template",
      },
    });
    expect(valid.statusCode).toBe(201);
    expect(templateService.createFromDesign).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      expect.objectContaining({
        request_id: templateId,
        design_id: designId,
        workspace_id: workspaceId,
        tag_ids: [],
      }),
    );
  });

  it("allows admin lists to select deleted templates", async () => {
    const { app, templateService } = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/design-catalog/templates?deleted=true",
    });
    expect(response.statusCode).toBe(200);
    expect(templateService.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deleted: "only" }),
    );
  });

  it("exposes typed replacement preview/apply and CAS variable management", async () => {
    const { app, templateService } = await setup();
    const base = {
      design_id: designId,
      template_id: templateId,
      expected_revision: 2,
      expected_template_revision: 3,
      bindings: [],
      smart_bindings: [],
    };
    const preview = await app.inject({
      method: "POST",
      url: `/api/design-templates/${templateId}/replace-preview`,
      payload: base,
    });
    expect(preview.statusCode).toBe(200);
    expect(templateService.previewReplace).toHaveBeenCalledWith(
      expect.anything(),
      base,
    );

    await app.inject({
      method: "POST",
      url: `/api/design-templates/${templateId}/replace-apply`,
      payload: {
        ...base,
        idempotency_key: "44444444-4444-4444-8444-444444444444",
      },
    });
    expect(templateService.applyReplace).toHaveBeenCalledOnce();

    const variables = [
      {
        key: "headline",
        label: "Headline",
        type: "text",
        required: true,
        target: {
          object_id: "55555555-5555-4555-8555-555555555555",
          property: "text",
        },
      },
    ];
    const update = await app.inject({
      method: "PUT",
      url: `/api/admin/design-catalog/templates/${templateId}/variables`,
      payload: {
        request_id: "66666666-6666-4666-8666-666666666666",
        expected_revision: 3,
        variables,
      },
    });
    expect(update.statusCode).toBe(200);
    expect(templateService.updateVariables).toHaveBeenCalledWith(
      expect.anything(),
      templateId,
      {
        request_id: "66666666-6666-4666-8666-666666666666",
        expected_revision: 3,
        variables,
      },
    );
  });
});

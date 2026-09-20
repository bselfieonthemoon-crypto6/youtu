import {
  type BackgroundJob,
  designExportPayloadSchema,
  designExportRequestSchema,
  designJobTargetSchema,
} from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import type { JobService } from "../jobs/job-service.js";
import type { DesignService } from "./design-service.js";

export const DESIGN_EXPORT_MAX_SIDE = 32_768;
export const DESIGN_EXPORT_MAX_PIXELS = 64_000_000;
export const DESIGN_EXPORT_MAX_ESTIMATED_BYTES = 768_000_000;

export class DesignExportError extends Error {
  constructor(
    readonly code:
      | "design_export_revision_conflict"
      | "design_export_idempotency_conflict"
      | "design_export_unsupported",
    message: string,
    readonly statusCode: number,
    readonly conflict?: {
      designId: string;
      latestRevision: number;
    },
  ) {
    super(message);
    this.name = "DesignExportError";
  }
}

export function assertDesignExportBudget(input: {
  width: number;
  height: number;
  multiplier: 1 | 2;
}) {
  const width = input.width * input.multiplier;
  const height = input.height * input.multiplier;
  const pixels = width * height;
  // libvips needs the decoded source, working buffers and encoded output at
  // the same time. Twelve bytes per output pixel is a conservative admission
  // estimate; source-asset budgets are enforced separately by the renderer.
  const estimatedBytes = pixels * 12;
  if (
    width > DESIGN_EXPORT_MAX_SIDE ||
    height > DESIGN_EXPORT_MAX_SIDE ||
    pixels > DESIGN_EXPORT_MAX_PIXELS ||
    estimatedBytes > DESIGN_EXPORT_MAX_ESTIMATED_BYTES
  ) {
    throw new DesignExportError(
      "design_export_unsupported",
      "The requested export exceeds the server rendering budget.",
      422,
    );
  }
  return { width, height, pixels, estimatedBytes };
}

export class DesignExportService {
  constructor(
    private readonly designs: Pick<DesignService, "get">,
    private readonly jobs: Pick<
      JobService,
      "createJob" | "findDesignExportJob"
    >,
  ) {}

  async enqueue(
    user: AuthenticatedUser,
    rawInput: unknown,
  ): Promise<BackgroundJob> {
    return (await this.enqueueWithReplay(user, rawInput)).job;
  }

  async enqueueWithReplay(
    user: AuthenticatedUser,
    rawInput: unknown,
  ): Promise<{ job: BackgroundJob; replayed: boolean }> {
    const input = designExportRequestSchema.parse(rawInput);
    const design = await this.designs.get(user, input.design_id);
    if (design.revision !== input.revision) {
      throw new DesignExportError(
        "design_export_revision_conflict",
        "The design changed before the export was queued.",
        409,
        { designId: design.id, latestRevision: design.revision },
      );
    }
    assertDesignExportBudget({
      width: design.width,
      height: design.height,
      multiplier: input.multiplier,
    });
    // An exact delivery frame replaces `canvas × multiplier` as ①, so it has to
    // clear the same side/pixel/working-set budget — otherwise a request could
    // name a frame far larger than the canvas and push the renderer past limits
    // this service exists to enforce. Checked here as well as in the renderer so
    // an unrenderable frame is refused before a job is created.
    if (input.target_size) {
      try {
        assertDesignExportBudget({
          width: input.target_size.width,
          height: input.target_size.height,
          multiplier: 1,
        });
      } catch {
        throw new DesignExportError(
          "design_export_unsupported",
          "The requested export target size exceeds the server rendering budget.",
          422,
        );
      }
    }
    const payload = designExportPayloadSchema.parse({
      ...input,
      requested_by: user.id,
    });
    const replay = await this.jobs.findDesignExportJob(
      user,
      design.id,
      input.idempotency_key,
    );
    if (replay) return { job: validateReplay(replay, payload), replayed: true };

    try {
      return {
        job: await this.jobs.createJob(user, {
          workspaceId: design.workspace_id,
          projectId: design.project_id,
          jobType: "design_export",
          target: designJobTargetSchema.parse({
            kind: "design",
            design_id: design.id,
            expected_revision: design.revision,
            idempotency_key: input.idempotency_key,
          }),
          payload,
        }),
        replayed: false,
      };
    } catch (error) {
      // The database unique index closes the concurrent replay race. If a peer
      // inserted first, return that same durable job instead of publishing two.
      const concurrentReplay = await this.jobs.findDesignExportJob(
        user,
        design.id,
        input.idempotency_key,
      );
      if (concurrentReplay)
        return {
          job: validateReplay(concurrentReplay, payload),
          replayed: true,
        };
      throw error;
    }
  }
}

function validateReplay(
  job: BackgroundJob,
  payload: ReturnType<typeof designExportPayloadSchema.parse>,
): BackgroundJob {
  const previous = designExportPayloadSchema.safeParse(job.payload);
  if (
    !previous.success ||
    JSON.stringify(previous.data) !== JSON.stringify(payload)
  ) {
    throw new DesignExportError(
      "design_export_idempotency_conflict",
      "The idempotency key was already used for a different export request.",
      409,
    );
  }
  return job;
}

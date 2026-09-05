import { z } from "zod";

import {
  providerCapabilitySchema,
  providerModelModalitySchema,
} from "./provider-config-contracts.js";

export const modelCatalogSourceSchema = z.enum(["environment", "workspace"]);

export const workspaceCatalogModelSchema = z
  .object({
    id: z.string().regex(/^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    displayName: z.string().min(1).max(200),
    providerDisplayName: z.string().min(1).max(100),
    modality: providerModelModalitySchema,
    capabilities: z.array(providerCapabilitySchema).max(4),
    source: z.literal("workspace"),
  })
  .strict();

export type ModelCatalogSource = z.infer<typeof modelCatalogSourceSchema>;
export type WorkspaceCatalogModel = z.infer<typeof workspaceCatalogModelSchema>;

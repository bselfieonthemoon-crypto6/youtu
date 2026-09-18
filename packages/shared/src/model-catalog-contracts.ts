import { z } from "zod";
import { workspaceModelIdPattern } from "./uuid.js";

import {
  providerCapabilitySchema,
  providerModelModalitySchema,
} from "./provider-config-contracts.js";

export const modelCatalogSourceSchema = z.enum(["environment", "workspace"]);

export const workspaceCatalogModelSchema = z
  .object({
    id: z.string().regex(workspaceModelIdPattern),
    displayName: z.string().min(1).max(200),
    providerDisplayName: z.string().min(1).max(100),
    modality: providerModelModalitySchema,
    capabilities: z.array(providerCapabilitySchema).max(4),
    source: z.literal("workspace"),
  })
  .strict();

export type ModelCatalogSource = z.infer<typeof modelCatalogSourceSchema>;
export type WorkspaceCatalogModel = z.infer<typeof workspaceCatalogModelSchema>;

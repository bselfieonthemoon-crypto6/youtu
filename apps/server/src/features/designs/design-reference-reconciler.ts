import { z } from "zod";

import type { AdminSupabaseClient } from "../../supabase/admin.js";

const resultSchema = z
  .object({
    design_id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    reconciled: z.literal(true),
  })
  .strict();

export type DesignReferenceReconciler = {
  reconcile(designId: string): Promise<z.infer<typeof resultSchema>>;
};

export function createDesignReferenceReconciler(
  getAdminClient: () => AdminSupabaseClient,
): DesignReferenceReconciler {
  return {
    async reconcile(designId) {
      const { data, error } = await (
        getAdminClient().rpc as unknown as (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message?: string } | null }>
      )("loomic_design_reconcile_references", { p_design_id: designId });
      if (error) {
        throw new Error(error.message ?? "design_reference_reconcile_failed");
      }
      return resultSchema.parse(data);
    },
  };
}

import { z } from "zod";

import type { AdminSupabaseClient } from "../../supabase/admin.js";

const bindingReconcileResultSchema = z
  .object({
    scanned_canvases: z.number().int().nonnegative(),
    attached: z.number().int().nonnegative(),
    orphaned: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    deleted_nodes: z.number().int().nonnegative(),
    normalized: z.number().int().nonnegative(),
    busy: z.boolean(),
  })
  .strict();

export type DesignBindingReconcileResult = z.infer<
  typeof bindingReconcileResultSchema
>;

export type DesignBindingReconciler = {
  reconcile(limit?: number): Promise<DesignBindingReconcileResult>;
};

type RpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

export function createDesignBindingReconciler(options: {
  getAdminClient: () => AdminSupabaseClient;
}): DesignBindingReconciler {
  return {
    async reconcile(limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error("design_binding_reconcile_limit_invalid");
      }
      const admin = options.getAdminClient();
      const { data, error } = await (
        admin.rpc as unknown as (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<RpcResult>
      )("loomic_design_binding_reconcile", { p_limit: limit });
      if (error) {
        throw new Error(error.message ?? "design_binding_reconcile_failed");
      }
      return bindingReconcileResultSchema.parse(data);
    },
  };
}

export { bindingReconcileResultSchema };

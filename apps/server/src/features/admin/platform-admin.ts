import type { AdminSupabaseClient } from "../../supabase/admin.js";

/**
 * The one definition of "platform admin" for server code.
 *
 * `platform_admins` carries both an `is_active` flag and a `revoked_at`
 * timestamp, and its CHECK constraint keeps them consistent. Reading only one of
 * them (the catalog service reads `revoked_at IS NULL` alone) would treat a
 * deactivated-but-not-revoked row as an admin, so this checks both.
 *
 * Membership is looked up through the service-role client: the table is FORCE
 * ROW LEVEL SECURITY, and a caller must not be able to learn whether they are an
 * admin from a table they cannot read.
 */
export async function isActivePlatformAdmin(
  admin: AdminSupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error("platform_admin_lookup_failed");
  return Boolean(data);
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL(
  "../../../../../supabase/migrations/20260901000005_harden_credit_business_rules.sql",
  import.meta.url,
));
const sql = readFileSync(migrationPath, "utf8");

describe("credit business-rule migration invariants", () => {
  it("rejects invalid charges and binds each deduction to one owned queued job", () => {
    expect(sql).toContain("p_amount IS NULL OR p_amount <= 0");
    expect(sql).toContain("MESSAGE = 'credit_job_required'");
    expect(sql).toContain("job_row.workspace_id IS DISTINCT FROM p_workspace_id");
    expect(sql).toContain("job_row.created_by IS DISTINCT FROM p_user_id");
    expect(sql).toContain("job_row.status::text <> 'queued'");
    expect(sql).toContain("credit_transactions_one_generation_deduct_per_job");
    expect(sql).toContain("MESSAGE = 'credit_price_mismatch'");
  });

  it("only refunds the exact original charge after a refundable terminal state", () => {
    expect(sql).toContain("job_row.status::text NOT IN ('canceled', 'dead_letter')");
    expect(sql).toContain("-deduct_row.amount IS DISTINCT FROM p_amount");
    expect(sql).toContain("job_row.credits_transaction_id IS DISTINCT FROM deduct_row.id");
    expect(sql).toContain("MESSAGE = 'credit_job_already_refunded'");
  });

  it("derives grants from authoritative plan data and disables manual plan grants", () => {
    expect(sql).toContain("v_expected_amount := CASE v_plan WHEN 'free' THEN 50 ELSE 0 END");
    expect(sql).toContain("MESSAGE = 'credit_daily_amount_mismatch'");
    expect(sql).toContain("WHEN 'starter' THEN 1200");
    expect(sql).toContain("WHEN 'business' THEN 50000");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated, service_role");
  });

  it("makes payment delivery and subscription grants idempotent", () => {
    expect(sql).toContain("payment_events_delivery_fingerprint_key");
    expect(sql).toContain("credit_transactions_one_subscription_grant_per_delivery");
    expect(sql).toContain("metadata->>'payment_fingerprint' = p_payment_fingerprint");
  });
});

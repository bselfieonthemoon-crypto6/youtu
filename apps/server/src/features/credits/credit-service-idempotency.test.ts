import { describe, expect, it, vi } from "vitest";

import { createCreditService } from "./credit-service.js";

describe("CreditService idempotent generation charge", () => {
  it("preserves the database charged_new ownership signal", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        transaction_id: "10000000-0000-4000-8000-000000000001",
        charged_new: false,
      },
      error: null,
    });
    const service = createCreditService({
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(
      service.deductCreditsIdempotent(
        "20000000-0000-4000-8000-000000000001",
        "30000000-0000-4000-8000-000000000001",
        8,
        "40000000-0000-4000-8000-000000000001",
        "image",
      ),
    ).resolves.toEqual({
      transactionId: "10000000-0000-4000-8000-000000000001",
      chargedNew: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      "loomic_deduct_credits_idempotent",
      expect.objectContaining({ p_amount: 8 }),
    );
  });
});

describe("CreditService concurrent generation refund", () => {
  const workspaceId = "20000000-0000-4000-8000-000000000001";
  const userId = "30000000-0000-4000-8000-000000000001";
  const jobId = "40000000-0000-4000-8000-000000000001";
  const refundId = "10000000-0000-4000-8000-000000000001";

  function existingRefundQuery(result: {
    data: { id: string } | null;
    error: unknown;
  }) {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      gt: vi.fn(),
      maybeSingle: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.gt.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue(result);
    return query;
  }

  it("returns the same verified receipt to concurrent duplicate refund calls", async () => {
    const query = existingRefundQuery({ data: { id: refundId }, error: null });
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: refundId, error: null })
      .mockResolvedValue({
        data: null,
        error: { code: "23505", message: "credit_job_already_refunded" },
      });
    const service = createCreditService({
      getAdminClient: () => ({ from: vi.fn(() => query), rpc }) as never,
    });

    await expect(
      Promise.all(
        Array.from({ length: 4 }, () =>
          service.refundCredits(workspaceId, userId, 8, jobId),
        ),
      ),
    ).resolves.toEqual([refundId, refundId, refundId, refundId]);
    expect(query.eq).toHaveBeenCalledWith("job_id", jobId);
    expect(query.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(query.eq).toHaveBeenCalledWith("user_id", userId);
    expect(query.eq).toHaveBeenCalledWith(
      "transaction_type",
      "generation_refund",
    );
    expect(query.eq).toHaveBeenCalledWith("amount", 8);
    expect(query.gt).toHaveBeenCalledWith("amount", 0);
  });

  it("does not replay a refund when its workspace, user, or amount differs", async () => {
    const query = existingRefundQuery({ data: null, error: null });
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "credit_job_already_refunded" },
    });
    const service = createCreditService({
      getAdminClient: () => ({ from: vi.fn(() => query), rpc }) as never,
    });

    await expect(
      service.refundCredits(workspaceId, "other-user", 9, jobId),
    ).rejects.toMatchObject({ code: "credit_refund_failed" });
    expect(query.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(query.eq).toHaveBeenCalledWith("user_id", "other-user");
    expect(query.eq).toHaveBeenCalledWith("amount", 9);
  });

  it("does not mask unrelated database errors", async () => {
    const from = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: "duplicate key value violates unique constraint",
      },
    });
    const service = createCreditService({
      getAdminClient: () => ({ from, rpc }) as never,
    });

    await expect(
      service.refundCredits(workspaceId, userId, 8, jobId),
    ).rejects.toMatchObject({ code: "credit_refund_failed" });
    expect(from).not.toHaveBeenCalled();
  });

  it("fails when the receipt lookup itself has a database error", async () => {
    const query = existingRefundQuery({
      data: null,
      error: { message: "credit ledger temporarily unavailable" },
    });
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "credit_job_already_refunded" },
    });
    const service = createCreditService({
      getAdminClient: () => ({ from: vi.fn(() => query), rpc }) as never,
    });

    await expect(
      service.refundCredits(workspaceId, userId, 8, jobId),
    ).rejects.toMatchObject({ code: "credit_refund_failed" });
  });
});

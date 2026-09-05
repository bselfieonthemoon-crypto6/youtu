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

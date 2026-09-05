import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webhookSource = readFileSync(
  fileURLToPath(new URL("./payments-webhook.ts", import.meta.url)),
  "utf8",
);
const serviceSource = readFileSync(
  fileURLToPath(new URL("../features/payments/payment-service.ts", import.meta.url)),
  "utf8",
);

describe("payment webhook safety invariants", () => {
  it("rejects malformed signatures before timing-safe comparison", () => {
    expect(webhookSource).toContain("supplied.length !== expectedBytes.length");
    expect(webhookSource).toContain("!crypto.timingSafeEqual(supplied, expectedBytes)");
  });

  it("persists and claims a deterministic delivery fingerprint", () => {
    expect(webhookSource).toContain('.createHash("sha256")');
    expect(webhookSource).toContain("delivery_fingerprint: deliveryFingerprint");
    expect(webhookSource).toContain("duplicate: true");
    expect(webhookSource).toContain('reply.code(500).send({ error: "Webhook processing failed" })');
  });

  it("grants credits only from payment success and rejects unknown variants", () => {
    const updateCase = serviceSource.slice(
      serviceSource.indexOf('case "subscription_updated"'),
      serviceSource.indexOf('case "subscription_cancelled"'),
    );
    const successCase = serviceSource.slice(
      serviceSource.indexOf('case "subscription_payment_success"'),
      serviceSource.indexOf('case "subscription_payment_failed"'),
    );
    expect(updateCase).not.toContain("grantMonthlyCredits(");
    expect(successCase).toContain("grantMonthlyCredits(");
    expect(serviceSource).toContain("The payment provider variant is not configured.");
    expect(serviceSource).toContain('"grant_subscription_credits"');
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingSection } from "../src/components/billing-section";

const { statusMock, subscriptionMock, cancelMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  subscriptionMock: vi.fn(),
  cancelMock: vi.fn(),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "token" } }),
}));

vi.mock("../src/lib/payments-api", () => ({
  getPaymentsStatus: statusMock,
  getSubscription: subscriptionMock,
  cancelSubscription: cancelMock,
  changePlan: vi.fn(),
}));

const subscription = {
  plan: "pro",
  billingPeriod: "monthly",
  status: "active",
  lemonSqueezySubscriptionId: "sub_1",
  currentPeriodEnd: "2026-10-20T00:00:00.000Z",
  canceledAt: null,
  customerPortalUrl: null,
};

describe("billing section", () => {
  beforeEach(() => {
    statusMock.mockReset().mockResolvedValue({ enabled: true, provider: "lemon_squeezy" });
    subscriptionMock.mockReset().mockResolvedValue(subscription);
    cancelMock.mockReset();
  });
  afterEach(() => cleanup());

  it("explains that this installation takes no payments instead of failing", async () => {
    statusMock.mockResolvedValue({ enabled: false, provider: null });
    render(<BillingSection />);

    const panel = await screen.findByTestId("billing-payments-disabled");
    expect(panel).toHaveTextContent("本部署未启用在线支付");
    expect(panel).toHaveTextContent("套餐与额度由平台管理员");
    // Nothing to retry, and the subscription endpoint is never called.
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(subscriptionMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("billing-error")).not.toBeInTheDocument();
  });

  it("shows the plan when payments are configured", async () => {
    render(<BillingSection />);
    expect(await screen.findByText("Current Plan")).toBeInTheDocument();
    expect(screen.getByText("pro")).toBeInTheDocument();
    expect(statusMock).toHaveBeenCalledWith("token");
    expect(subscriptionMock).toHaveBeenCalledWith("token");
  });

  it("shows the real reason when the subscription read fails, and retries on demand", async () => {
    subscriptionMock
      .mockRejectedValueOnce(new Error("订阅服务暂时不可用"))
      .mockResolvedValueOnce(subscription);
    render(<BillingSection />);

    const error = await screen.findByTestId("billing-error");
    expect(error).toHaveTextContent("订阅服务暂时不可用");
    expect(error).not.toHaveTextContent("Please try again later");

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("Current Plan")).toBeInTheDocument());
    expect(subscriptionMock).toHaveBeenCalledTimes(2);
  });
});

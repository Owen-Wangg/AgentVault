import { describe, expect, it } from "vitest";
import { BILLING_SEED, fetchOwnProfile, findOrCreateBillingPayment } from "./account";
import { StripeApi } from "./stripe-api";

const pi = (over: Record<string, unknown> = {}) => ({
  id: "pi_seed",
  object: "payment_intent",
  status: "succeeded",
  amount: 50_000,
  currency: "usd",
  livemode: false,
  latest_charge: { amount_refunded: 48_000 },
  ...over,
});

function fakeStripe(answers: Record<string, unknown>) {
  const calls: { method: string; path: string; body: string | undefined; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body: init?.body as string | undefined, headers: init?.headers as Record<string, string> });
    return Response.json(answers[`${init?.method ?? "GET"} ${u.pathname}`] ?? { error: { message: "unexpected" } }, {
      status: answers[`${init?.method ?? "GET"} ${u.pathname}`] ? 200 : 400,
    });
  }) as typeof globalThis.fetch;
  return { api: new StripeApi({ secretKey: "sk_test_x", fetch }), calls };
}

describe("Stripe sandbox setup", () => {
  it("RAIL-7: reads the account's own profile with the MPP guide's API version", async () => {
    const { api, calls } = fakeStripe({ "GET /v2/network/business_profiles/me": { id: "profile_test_61abc", username: "agentvault-demo", display_name: "AgentVault" } });
    await expect(fetchOwnProfile(api)).resolves.toEqual({ id: "profile_test_61abc", username: "agentvault-demo", displayName: "AgentVault" });
    expect(calls[0]?.headers["stripe-version"]).toBe("2026-07-29.preview");
  });

  it("RAIL-17: finds the seeded $500 payment instead of creating a second one", async () => {
    const { api, calls } = fakeStripe({ "GET /v1/payment_intents/search": { data: [pi()] } });
    await expect(findOrCreateBillingPayment(api)).resolves.toEqual({
      id: "pi_seed",
      status: "succeeded",
      amountMicros: 500_000_000n,
      refundedMicros: 480_000_000n,
      created: false,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("RAIL-17: creates the $500 test payment with the test card and a fixed idempotency key", async () => {
    const { api, calls } = fakeStripe({
      "GET /v1/payment_intents/search": { data: [] },
      "POST /v1/payment_intents": pi({ latest_charge: { amount_refunded: 0 } }),
    });
    await expect(findOrCreateBillingPayment(api)).resolves.toMatchObject({ id: "pi_seed", created: true, refundedMicros: 0n });
    const create = calls[1];
    const body = new URLSearchParams(create?.body ?? "");
    expect(body.get("amount")).toBe("50000");
    expect(body.get("payment_method")).toBe("pm_card_visa");
    expect(body.get("metadata[agentvault_seed]")).toBe("billing-500");
    expect(create?.headers["idempotency-key"]).toBe(BILLING_SEED.idempotencyKey);
  });

  it("RAIL-7: refuses a live-mode answer", async () => {
    const { api } = fakeStripe({ "GET /v1/payment_intents/search": { data: [pi({ livemode: true })] } });
    await expect(findOrCreateBillingPayment(api)).rejects.toThrow("test mode");
  });
});

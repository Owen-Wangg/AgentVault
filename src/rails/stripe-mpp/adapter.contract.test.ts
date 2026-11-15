import { Challenge, Credential } from "mppx";
import { describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { StripeMppRail, refundIdempotencyKey, sptExpiresAt, sptIdempotencyKey } from "./adapter";
import { StripeApi } from "./stripe-api";
import { loadStripeRecording, replayStripe, replayVendor } from "./test-fixtures";

/**
 * Contract tests against exchanges recorded in Stripe test mode with
 * `pnpm stripe:probe --record` (rail-adapters task 8). The vendor endpoint
 * ran in-process with the real Stripe API; the payer called Stripe's SPT
 * test helper, the Refunds API, and the list endpoints. Nothing here
 * touches the network.
 */

const rec = loadStripeRecording();
const VENDOR_URL = "http://localhost:3000/vendor/api/report";
const reservedAt = new Date(rec.payment.reserved_at);
const clock = () => new Date(reservedAt.getTime() + 1000);
const api = (exchanges: Parameters<typeof replayStripe>[0]) => {
  const stripe = replayStripe(exchanges);
  return { stripe, api: new StripeApi({ secretKey: "sk_test_replay", fetch: stripe.fetchFn }) };
};
const neverVendor = (() => Promise.reject(new Error("lookup must not call the vendor"))) as typeof fetch;

describe("Stripe MPP adapter against recorded test-mode exchanges", () => {
  it("RAIL-14: the recorded vendor challenge is a 50-cent USD card charge to the sandbox's profile", () => {
    const challenge = Challenge.deserialize(rec.http[0]?.response.www_authenticate ?? "");
    expect(challenge).toMatchObject({ method: "stripe", intent: "charge" });
    expect(challenge.request).toMatchObject({ amount: "50", currency: "usd", methodDetails: { networkId: rec.profile_id } });
  });

  it("RAIL-15: Stripe's test helper granted an SPT scoped to exactly the approved 50 cents, expiring with the reservation's window", () => {
    const [create] = rec.stripe.pay;
    expect(create?.request).toEqual({
      method: "POST",
      path: "/v1/test_helpers/shared_payment/granted_tokens",
      params: {
        payment_method: "pm_card_visa",
        "usage_limits[currency]": "usd",
        "usage_limits[max_amount]": "50",
        "usage_limits[expires_at]": sptExpiresAt(reservedAt).toString(),
      },
    });
    expect(create?.response).toMatchObject({ status: 200, json: { object: "shared_payment.granted_token", livemode: false, usage_limits: { max_amount: 50, currency: "usd" } } });
    expect(sptIdempotencyKey(rec.payment.key)).toBe(`agentvault-spt-v1:${rec.payment.key}`);
  });

  it("RAIL-15, RAIL-16: replays the recorded payment: presents the SPT with the key as externalId and returns the PaymentIntent ID", async () => {
    const vendor = replayVendor(rec.http.slice(0, 2));
    const { api: stripeApi, stripe } = api(rec.stripe.pay);
    const rail = new StripeMppRail({ api: stripeApi, profileId: rec.profile_id, fetch: vendor.fetchFn, now: clock });
    const result = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: fromDecimalString("0.50"), idempotencyKey: rec.payment.key }, { reservedAt });
    expect(result).toMatchObject({ ok: true, ref: rec.payment.result.ref, settledMicros: 500_000n });
    // RAIL-3: the SPT is created under a Stripe idempotency key derived from the rail key, so a retry gets the same SPT.
    expect(stripe.seen.map((s) => s.idempotencyKey)).toEqual([sptIdempotencyKey(rec.payment.key)]);
    expect(result.ok && result.vendorBody).toMatchObject({ vendor: "nimbus-weather", report: "severe-weather-outlook" });
    expect(vendor.sent.map((s) => s.credential !== null)).toEqual([false, true]);
    const sent = Credential.deserialize(vendor.sent[1]?.credential ?? "");
    const recorded = Credential.deserialize(rec.http[1]?.request.credential ?? "");
    expect(sent.payload).toEqual(recorded.payload);
    expect(sent.payload).toMatchObject({ externalId: rec.payment.key, spt: (rec.stripe.pay[0]?.response.json as { id: string }).id });
    expect(sent.challenge.id).toBe(recorded.challenge.id);
  });

  it("RAIL-3: the recorded second execute() with the same key got the same SPT, and the vendor refused it: no second payment", async () => {
    const [again] = rec.stripe.replay;
    expect((again?.response.json as { id: string }).id).toBe((rec.stripe.pay[0]?.response.json as { id: string }).id);
    expect(rec.http[3]?.response).toMatchObject({ status: 402, payment_receipt: null });
    expect(rec.http[3]?.response.body).toContain("verification-failed");
    const vendor = replayVendor(rec.http.slice(2, 4));
    const { api: stripeApi } = api(rec.stripe.replay);
    const rail = new StripeMppRail({ api: stripeApi, profileId: rec.profile_id, fetch: vendor.fetchFn, now: clock });
    expect(await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: fromDecimalString("0.50"), idempotencyKey: rec.payment.key }, { reservedAt })).toMatchObject({
      ok: false,
      code: "INVALID_RAIL_RESPONSE",
    });
  });

  it("RAIL-21, RAIL-22: finds the recorded payment by its key with list requests only", async () => {
    const { api: stripeApi, stripe } = api(rec.stripe.lookup_payment);
    const rail = new StripeMppRail({ api: stripeApi, profileId: rec.profile_id, fetch: neverVendor });
    const found = await rail.lookup(rec.payment.key, { reservedAt });
    expect(found).toEqual({ status: "settled", ref: rec.payment.result.ref, explorerUrl: `https://dashboard.stripe.com/test/payments/${rec.payment.result.ref}`, settledMicros: 500_000n });
    expect(stripe.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/refunds", "GET /v1/payment_intents"]);
    // Stripe really tagged the PaymentIntent with the key the vendor copied from the credential.
    const listed = (rec.stripe.lookup_payment[1]?.response.json as { data: { id: string; metadata: Record<string, string> }[] }).data;
    expect(listed.find((pi) => pi.id === rec.payment.result.ref)?.metadata).toMatchObject({ idempotency_key: rec.payment.key, machine_payment: "true" });
  });

  it("RAIL-17: replays the recorded 50-cent refund and finds it again by its key", async () => {
    const refund = rec.refund;
    if (!refund) throw new Error("the recording has no refund");
    const [create, list] = rec.stripe.refund;
    expect(create?.request.params).toEqual({ payment_intent: rec.payment.result.ref, amount: "50", "metadata[idempotency_key]": refund.key });
    const { api: stripeApi, stripe } = api(rec.stripe.refund);
    const rail = new StripeMppRail({ api: stripeApi, profileId: rec.profile_id, fetch: neverVendor });
    const result = await rail.refund({ paymentRef: rec.payment.result.ref ?? "", amountMicros: fromDecimalString("0.50"), idempotencyKey: refund.key }, { reservedAt: new Date(refund.reserved_at) });
    expect(result).toMatchObject({ ok: true, ref: refund.result.ref, settledMicros: 500_000n });
    expect(stripe.seen[0]?.idempotencyKey).toBe(refundIdempotencyKey(refund.key));
    expect(list?.request.path).toBe("/v1/refunds");
    expect(await rail.lookup(refund.key, { reservedAt: new Date(refund.reserved_at) })).toMatchObject({ status: "settled", ref: refund.result.ref, settledMicros: 500_000n });
  });
});

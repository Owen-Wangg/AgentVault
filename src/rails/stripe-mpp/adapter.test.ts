import { describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { SPT_WINDOW_SECONDS, StripeMppRail, sptExpiresAt } from "./adapter";
import { FakeStripeAccount, PROFILE, VENDOR_URL, fakeMppVendor } from "./test-fixtures";

const RESERVED_AT = new Date(Date.UTC(2026, 10, 29, 18, 0, 0));
const at = (offsetSeconds: number) => () => new Date(RESERVED_AT.getTime() + offsetSeconds * 1000);
const secondsOf = (d: Date) => Math.floor(d.getTime() / 1000);

function setup(options: Parameters<typeof fakeMppVendor>[1] = {}, nowOffset = 5) {
  const account = new FakeStripeAccount(() => secondsOf(at(nowOffset)()));
  const vendor = fakeMppVendor(account, options);
  const rail = new StripeMppRail({ api: account.api(), profileId: PROFILE, fetch: vendor.fetchFn, now: at(nowOffset) });
  return { account, vendor, rail };
}

const pay = (rail: StripeMppRail, over: { amount?: string; key?: string; signal?: AbortSignal; reservedAt?: Date | null } = {}) =>
  rail.execute(
    { vendorUrl: VENDOR_URL, approvedMicros: fromDecimalString(over.amount ?? "0.50"), idempotencyKey: over.key ?? "res-1" },
    { ...(over.reservedAt === null ? {} : { reservedAt: over.reservedAt ?? RESERVED_AT }), ...(over.signal ? { signal: over.signal } : {}) },
  );

describe("Stripe MPP adapter: paying", () => {
  it("RAIL-15, RAIL-16: pays the $0.50 challenge with an SPT scoped to 50 cents and returns the PaymentIntent ID", async () => {
    const { account, vendor, rail } = setup();
    const result = await pay(rail);
    const [pi] = account.paymentIntents;
    expect(result).toMatchObject({ ok: true, ref: pi?.id, settledMicros: 500_000n, explorerUrl: `https://dashboard.stripe.com/test/payments/${pi?.id}`, vendorBody: { report: "ok" } });
    expect(vendor.requests.map((r) => r.paid)).toEqual([false, true]);
    const [spt] = account.spts.values();
    expect(spt).toMatchObject({ maxAmount: 50, expiresAt: Number(sptExpiresAt(RESERVED_AT)), used: true });
    // The vendor tagged the PaymentIntent with this key, which is what lookup() searches for.
    expect(pi).toMatchObject({ amount: 50, metadata: { idempotency_key: "res-1" } });
  });

  it("RAIL-3: a second execute() with the same key gets the same SPT back, which can't pay again", async () => {
    const { account, rail } = setup();
    expect(await pay(rail)).toMatchObject({ ok: true });
    // The vendor refuses the used SPT. The adapter can't tell that from a lost answer, so it's unknown, not a success.
    expect(await pay(rail)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    expect(account.spts.size).toBe(1);
    expect(account.paymentIntents).toHaveLength(1);
  });

  it("RAIL-4: below 50 cents returns BELOW_RAIL_MINIMUM without contacting anyone", async () => {
    const { account, vendor, rail } = setup({ cents: 49n });
    expect(await pay(rail, { amount: "0.49" })).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(rail.minimumUnits).toBe(50n);
    expect(vendor.requests).toEqual([]);
    expect(account.payerCalls).toEqual([]);
  });

  it.each(["", "not a url", "ftp://agentvault.example/pay"])(
    "RAIL-24: with no usable payment URL (%j), returns RAIL_REJECTED without contacting anyone",
    async (vendorUrl) => {
      const { account, vendor, rail } = setup();
      const result = await rail.execute({ vendorUrl, approvedMicros: fromDecimalString("0.50"), idempotencyKey: "res-1" }, { reservedAt: RESERVED_AT });
      expect(result).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
      expect(vendor.requests).toEqual([]);
      expect(account.payerCalls).toEqual([]);
    },
  );

  it("MON-8: a sub-cent approved amount rounds up to the next cent before the challenge check", async () => {
    const { rail } = setup({ cents: 51n });
    expect(await pay(rail, { amount: "0.500001" })).toMatchObject({ ok: true, settledMicros: 510_000n });
  });

  it("RAIL-23: never follows a redirect, on the price check, the unpaid request, or the paid one", async () => {
    const account = new FakeStripeAccount(() => secondsOf(at(5)()));
    const vendor = fakeMppVendor(account);
    const seen: (RequestInit | undefined)[] = [];
    const spy = ((url: string, init?: RequestInit) => {
      seen.push(init);
      return vendor.fetchFn(url, init);
    }) as typeof fetch;
    const rail = new StripeMppRail({ api: account.api(), profileId: PROFILE, fetch: spy, now: at(5) });
    await rail.quote({ vendorUrl: VENDOR_URL, approvedMicros: fromDecimalString("0.50"), idempotencyKey: "res-1" });
    await pay(rail);
    expect(seen).toHaveLength(3);
    for (const init of seen) expect(init?.redirect).toBe("manual");
  });

  it("RAIL-23: a redirect on the unpaid request is refused, and no SPT is created", async () => {
    const { account, rail } = setup({ unpaid: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/pay" } }) });
    expect(await pay(rail)).toMatchObject({ ok: false });
    expect(account.spts.size).toBe(0);
  });

  it("RAIL-5, RAIL-23: a redirect on the paid request is unknown, since the SPT was presented", async () => {
    const { rail } = setup({ paid: () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/pay" } }) });
    expect(await pay(rail)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
  });

  it("RAIL-13: a challenge for a different amount is CHALLENGE_MISMATCH, and no SPT is created", async () => {
    for (const cents of [49n, 51n, 5000n]) {
      const { account, rail } = setup({ cents });
      expect(await pay(rail)).toMatchObject({ ok: false, code: "CHALLENGE_MISMATCH" });
      expect(account.spts.size).toBe(0);
    }
  });

  it("RAIL-15: refuses a challenge for another Stripe profile or currency before creating an SPT", async () => {
    for (const options of [{ profileId: "profile_test_someoneElse" }, { currency: "eur" }]) {
      const { account, rail } = setup(options);
      expect(await pay(rail)).toMatchObject({ ok: false, code: "CHALLENGE_MISMATCH" });
      expect(account.spts.size).toBe(0);
    }
  });

  it("RAIL-5: a vendor that doesn't answer 402 is RAIL_REJECTED; an unreadable challenge is INVALID_RAIL_RESPONSE", async () => {
    const ok = setup({ unpaid: () => Response.json({}) });
    expect(await pay(ok.rail)).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    const garbled = setup({ unpaid: () => new Response("{}", { status: 402, headers: { "www-authenticate": "Payment nonsense" } }) });
    expect(await pay(garbled.rail)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    const x402Only = setup({ unpaid: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": "e30=" } }) });
    expect(await pay(x402Only.rail)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    for (const s of [ok, garbled, x402Only]) expect(s.account.spts.size).toBe(0);
  });

  it("RAIL-6: a failed SPT creation is a confirmed failure, since the SPT never reached the vendor", async () => {
    const { account, vendor, rail } = setup();
    account.failNext = { path: "/v1/test_helpers/shared_payment/granted_tokens", status: 400 };
    expect(await pay(rail)).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(vendor.requests.map((r) => r.paid)).toEqual([false]);
  });

  it("RAIL-6: after the SPT is presented, a refusal, an error status, or a missing receipt is an unknown outcome", async () => {
    for (const paid of [() => new Response("{}", { status: 402 }), () => new Response("{}", { status: 504 }), () => Response.json({ report: "ok" })]) {
      const { rail } = setup({ paid });
      expect(await pay(rail)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    }
  });

  it("RAIL-6: an aborted call is RAIL_TIMEOUT", async () => {
    const { rail } = setup();
    expect(await pay(rail, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
  });

  it("RAIL-6: with under a minute left in the SPT window, nothing is created and the result is RAIL_TIMEOUT", async () => {
    const { account, rail } = setup({}, Number(SPT_WINDOW_SECONDS) - 59);
    expect(await pay(rail)).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
    expect(account.spts.size).toBe(0);
  });

  it("RAIL-21: without the reservation time, nothing is sent", async () => {
    const { account, vendor, rail } = setup();
    expect(await pay(rail, { reservedAt: null })).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(vendor.requests).toEqual([]);
    expect(account.payerCalls).toEqual([]);
  });

  it("quote() reads the price without creating anything", async () => {
    const { account, rail } = setup({ cents: 75n });
    expect(await rail.quote({ vendorUrl: VENDOR_URL, approvedMicros: micros(0n), idempotencyKey: "q" })).toEqual({ units: 75n, micros: 750_000n });
    expect(account.payerCalls).toEqual([]);
  });
});

describe("Stripe MPP adapter: refunds", () => {
  async function paidSetup() {
    const s = setup();
    const paid = await pay(s.rail);
    if (!paid.ok) throw new Error("setup payment failed");
    return { ...s, ref: paid.ref };
  }

  it("RAIL-17: refunds through the Refunds API with the key as idempotency key and metadata, and returns the Refund ID", async () => {
    const { account, rail, ref } = await paidSetup();
    const result = await rail.refund({ paymentRef: ref, amountMicros: fromDecimalString("0.30"), idempotencyKey: "res-r1" }, { reservedAt: RESERVED_AT });
    const [refund] = account.refunds;
    expect(result).toMatchObject({ ok: true, ref: refund?.id, settledMicros: 300_000n, explorerUrl: `https://dashboard.stripe.com/test/refunds/${refund?.id}` });
    expect(refund).toMatchObject({ amount: 30, payment_intent: ref, metadata: { idempotency_key: "res-r1" } });
    // The same key again replays Stripe's first answer: still one refund.
    expect(await rail.refund({ paymentRef: ref, amountMicros: fromDecimalString("0.30"), idempotencyKey: "res-r1" }, {})).toMatchObject({ ok: true, ref: refund?.id });
    expect(account.refunds).toHaveLength(1);
  });

  it("MON-8: refunds round down to the cent, and under a cent sends nothing", async () => {
    const { account, rail, ref } = await paidSetup();
    expect(await rail.refund({ paymentRef: ref, amountMicros: fromDecimalString("0.309999"), idempotencyKey: "res-r2" }, {})).toMatchObject({ ok: true, settledMicros: 300_000n });
    expect(await rail.refund({ paymentRef: ref, amountMicros: micros(9_999n), idempotencyKey: "res-r3" }, {})).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(account.refunds).toHaveLength(1);
  });

  it("RAIL-17: refuses a reference that isn't a PaymentIntent without contacting Stripe", async () => {
    const { account, rail } = setup();
    expect(await rail.refund({ paymentRef: "mock_tx_abc", amountMicros: fromDecimalString("1"), idempotencyKey: "res-r4" }, {})).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(account.payerCalls).toEqual([]);
  });

  it("RAIL-6: a Stripe 4xx is a confirmed failure; a 409, a 5xx, or an abort is unknown", async () => {
    const { account, rail, ref } = await paidSetup();
    const refund = (key: string, signal?: AbortSignal) => rail.refund({ paymentRef: ref, amountMicros: fromDecimalString("0.10"), idempotencyKey: key }, signal ? { signal } : {});
    expect(await rail.refund({ paymentRef: "pi_missing", amountMicros: fromDecimalString("0.10"), idempotencyKey: "k0" }, {})).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    account.failNext = { path: "/v1/refunds", status: 400, code: "charge_already_refunded" };
    expect(await refund("k1")).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    account.failNext = { path: "/v1/refunds", status: 409 };
    expect(await refund("k2")).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    account.failNext = { path: "/v1/refunds", status: 500 };
    expect(await refund("k3")).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    expect(await refund("k4", AbortSignal.abort())).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
  });

  it("RAIL-17: a refund Stripe marks failed is a confirmed failure; pending counts as settled", async () => {
    const { account, rail, ref } = await paidSetup();
    account.refundStatus = "failed";
    expect(await rail.refund({ paymentRef: ref, amountMicros: fromDecimalString("0.10"), idempotencyKey: "f1" }, {})).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    account.refundStatus = "pending";
    expect(await rail.refund({ paymentRef: ref, amountMicros: fromDecimalString("0.10"), idempotencyKey: "p1" }, {})).toMatchObject({ ok: true });
  });
});

describe("Stripe MPP adapter: lookup", () => {
  it("RAIL-21: finds a settled payment and a settled refund by their keys", async () => {
    const { rail } = setup();
    const paid = await pay(rail, { key: "res-pay" });
    if (!paid.ok) throw new Error("payment failed");
    const refunded = await rail.refund({ paymentRef: paid.ref, amountMicros: fromDecimalString("0.50"), idempotencyKey: "res-ref" }, { reservedAt: RESERVED_AT });
    expect(await rail.lookup("res-pay", { reservedAt: RESERVED_AT })).toEqual({ status: "settled", ref: paid.ref, explorerUrl: paid.explorerUrl, settledMicros: 500_000n });
    expect(await rail.lookup("res-ref", { reservedAt: RESERVED_AT })).toMatchObject({ status: "settled", ref: refunded.ok ? refunded.ref : "", settledMicros: 500_000n });
  });

  it("RAIL-21: a key with no payment is unknown, never failed: absence proves nothing", async () => {
    const { rail } = setup();
    expect(await rail.lookup("never-paid", { reservedAt: RESERVED_AT })).toEqual({ status: "unknown" });
    expect(await rail.lookup("never-paid", {})).toEqual({ status: "unknown" });
  });

  it("RAIL-21: a PaymentIntent that didn't succeed is unknown; a failed refund is failed", async () => {
    const { account, rail } = setup();
    account.piStatus = "requires_payment_method";
    await pay(rail, { key: "res-declined" });
    expect(await rail.lookup("res-declined", { reservedAt: RESERVED_AT })).toEqual({ status: "unknown" });

    const ok = setup();
    const paid = await pay(ok.rail);
    ok.account.refundStatus = "failed";
    await ok.rail.refund({ paymentRef: paid.ok ? paid.ref : "", amountMicros: fromDecimalString("0.10"), idempotencyKey: "res-failed-refund" }, {});
    expect(await ok.rail.lookup("res-failed-refund", { reservedAt: RESERVED_AT })).toEqual({ status: "failed", code: "RAIL_REJECTED" });
  });

  it("RAIL-21: pages through the lists, and gives up as unknown past ten pages", async () => {
    const { account, rail } = setup();
    await pay(rail, { key: "res-first" });
    for (let i = 0; i < 5; i += 1) await pay(rail, { key: `res-other-${i}` });
    account.pageSize = 2;
    // The first payment is the oldest, so it's on the last page.
    expect(await rail.lookup("res-first", { reservedAt: RESERVED_AT })).toMatchObject({ status: "settled" });
    account.pageSize = 0;
    expect(await rail.lookup("res-first", { reservedAt: RESERVED_AT })).toEqual({ status: "unknown" });
  });

  it("RAIL-22: lookup only reads: it makes GET requests to Stripe and never calls the vendor", async () => {
    const { account, vendor, rail } = setup();
    await pay(rail, { key: "res-read" });
    const before = { calls: account.payerCalls.length, vendor: vendor.requests.length, spts: account.spts.size, pis: account.paymentIntents.length };
    await rail.lookup("res-read", { reservedAt: RESERVED_AT });
    await rail.lookup("missing", { reservedAt: RESERVED_AT });
    expect(account.payerCalls.slice(before.calls).every((c) => c.startsWith("GET "))).toBe(true);
    expect({ vendor: vendor.requests.length, spts: account.spts.size, pis: account.paymentIntents.length }).toEqual({ vendor: before.vendor, spts: before.spts, pis: before.pis });
  });
});

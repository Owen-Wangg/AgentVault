import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { micros } from "@/core/money";
import { AUTHORIZATION_WINDOW_SECONDS, X402Rail, authorizationDeadline, authorizationNonce } from "./adapter";
import type { RailAdapter } from "../types";
import type { BaseSepoliaReader } from "./chain";
import { PAY_TO, TX, VENDOR_URL, challenge, fakeChain, fakeVendor } from "./test-fixtures";

const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
const URL_ = VENDOR_URL;
const T0 = new Date("2026-11-28T18:00:00.000Z");

const rail = (fetchFn: typeof fetch, over: { minUnits?: bigint; now?: Date; chain?: BaseSepoliaReader } = {}) =>
  new X402Rail({ account, minUnits: over.minUnits ?? 1000n, fetch: fetchFn, now: () => over.now ?? T0, ...(over.chain ? { chain: over.chain } : {}) });
const req = (units: bigint, key = "res-1") => ({ vendorUrl: URL_, approvedMicros: micros(units), idempotencyKey: key });
const ctx = { reservedAt: T0 };
const authorizationOf = (signature: string | null) =>
  (decodePaymentSignatureHeader(signature ?? "").payload as { authorization: { validBefore: string; nonce: string; value: string; to: string } }).authorization;

describe("x402 adapter: execute", () => {
  it("RAIL-11, RAIL-12: pays the challenge, retries with the signature, and returns the hash and explorer link", async () => {
    const vendor = fakeVendor(1500n);
    const result = await rail(vendor.fetchFn).execute(req(1500n), ctx);
    expect(result).toEqual({ ok: true, ref: TX, explorerUrl: `https://sepolia.basescan.org/tx/${TX}`, settledMicros: 1500n, vendorBody: { ok: true } });
    expect(vendor.requests.map((r) => r.paid)).toEqual([false, true]);
    expect(authorizationOf(vendor.requests[1]?.signature ?? null)).toMatchObject({ value: "1500", to: PAY_TO });
  });

  it("RAIL-4: below the minimum, returns BELOW_RAIL_MINIMUM without contacting the vendor", async () => {
    const vendor = fakeVendor(999n);
    expect(await rail(vendor.fetchFn).execute(req(999n), ctx)).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(vendor.requests).toEqual([]);
  });

  it("RAIL-21: refuses to sign without the reservation time, since lookup() could never resolve it", async () => {
    const vendor = fakeVendor(1500n);
    expect(await rail(vendor.fetchFn).execute(req(1500n), {})).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(vendor.requests).toEqual([]);
  });

  it("RAIL-10: a vendor that doesn't answer 402 is refused before anything is signed", async () => {
    const vendor = fakeVendor(1500n, { unpaid: () => Response.json({ free: true }) });
    expect(await rail(vendor.fetchFn).execute(req(1500n), ctx)).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(vendor.requests.filter((r) => r.paid)).toEqual([]);
  });

  it("RAIL-5: a 402 without a readable challenge is INVALID_RAIL_RESPONSE, and nothing is signed", async () => {
    for (const header of [null, "not-base64!", Buffer.from(JSON.stringify({ x402Version: 1, accepts: [] })).toString("base64")]) {
      const vendor = fakeVendor(1500n, { unpaid: () => new Response("{}", { status: 402, headers: header ? { "PAYMENT-REQUIRED": header } : {} }) });
      expect(await rail(vendor.fetchFn).execute(req(1500n), ctx)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
      expect(vendor.requests.filter((r) => r.paid)).toEqual([]);
    }
  });

  it.each([
    ["another network", { network: "eip155:8453" as const }],
    ["another token", { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
    ["another scheme", { scheme: "upto" }],
    ["another EIP-712 domain", { extra: { name: "USD Coin", version: "2" } }],
    ["Permit2 instead of EIP-3009", { extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }],
  ])("RAIL-8, RAIL-13: refuses a challenge for %s with CHALLENGE_MISMATCH", async (_label, over) => {
    const vendor = fakeVendor(1500n, { unpaid: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge(1500n, over)) } }) });
    expect(await rail(vendor.fetchFn).execute(req(1500n), ctx)).toMatchObject({ ok: false, code: "CHALLENGE_MISMATCH" });
    expect(vendor.requests.filter((r) => r.paid)).toEqual([]);
  });

  it("RAIL-6: a timeout before or after the payment is sent is RAIL_TIMEOUT", async () => {
    const aborted = AbortSignal.abort();
    const before = fakeVendor(1500n);
    expect(await rail(before.fetchFn).execute(req(1500n), { ...ctx, signal: aborted })).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
    const after = fakeVendor(1500n, {
      paid: () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    });
    expect(await rail(after.fetchFn).execute(req(1500n), ctx)).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
  });

  it("RAIL-5: after the payment is sent, any answer but a well-formed settlement is unknown (INVALID_RAIL_RESPONSE)", async () => {
    const answers: Response[] = [
      new Response("{}", { status: 402 }),
      new Response("{}", { status: 500 }),
      Response.json({ ok: true }),
      Response.json({}, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, transaction: "", network: "eip155:84532", errorReason: "x" }) } }),
      Response.json({}, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: "eip155:8453" }) } }),
      Response.json({}, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: "eip155:84532", payer: PAY_TO }) } }),
      Response.json({}, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: "eip155:84532", amount: "1499" }) } }),
    ];
    for (const answer of answers) {
      const vendor = fakeVendor(1500n, { paid: () => answer });
      expect(await rail(vendor.fetchFn).execute(req(1500n), ctx)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    }
  });

  it("RAIL-21: the authorization expires by the challenge's timeout, and never after reservedAt + 5 minutes", async () => {
    const early = fakeVendor(1500n);
    await rail(early.fetchFn).execute(req(1500n), ctx);
    expect(BigInt(authorizationOf(early.requests[1]?.signature ?? null).validBefore)).toBe(BigInt(T0.getTime() / 1000) + 120n);

    // Signing 4 minutes after the reservation: the deadline is closer than the challenge's 120 s.
    const late = fakeVendor(1500n);
    await rail(late.fetchFn, { now: new Date(T0.getTime() + 240_000) }).execute(req(1500n), ctx);
    expect(BigInt(authorizationOf(late.requests[1]?.signature ?? null).validBefore)).toBe(authorizationDeadline(T0));
    expect(authorizationDeadline(T0)).toBe(BigInt(T0.getTime() / 1000) + AUTHORIZATION_WINDOW_SECONDS);
  });

  it("RAIL-6: with under 30 seconds left before the deadline, nothing is signed and the outcome is a timeout", async () => {
    const vendor = fakeVendor(1500n);
    const result = await rail(vendor.fetchFn, { now: new Date(T0.getTime() + 280_000) }).execute(req(1500n), ctx);
    expect(result).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
    expect(vendor.requests.filter((r) => r.paid)).toEqual([]);
  });

  it("RAIL-3: the nonce comes from the key, so a repeated key reuses the nonce USDC accepts only once", async () => {
    const a = fakeVendor(1500n);
    const b = fakeVendor(1500n);
    await rail(a.fetchFn).execute(req(1500n, "res-1"), ctx);
    await rail(b.fetchFn).execute(req(1500n, "res-1"), ctx);
    expect(authorizationOf(a.requests[1]?.signature ?? null).nonce).toBe(authorizationNonce("res-1"));
    expect(a.requests[1]?.signature).toBe(b.requests[1]?.signature);
    expect(authorizationNonce("res-1")).not.toBe(authorizationNonce("res-2"));
    expect(authorizationNonce("res-1")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refund() is refused without contacting anyone: x402 has no refunds", async () => {
    const vendor = fakeVendor(1500n);
    const adapter: RailAdapter = rail(vendor.fetchFn);
    expect(await adapter.refund({ paymentRef: TX, amountMicros: micros(1500n), idempotencyKey: "res-r" })).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(vendor.requests).toEqual([]);
  });

  it("quote() reads the challenge without paying", async () => {
    const vendor = fakeVendor(1500n);
    expect(await rail(vendor.fetchFn).quote(req(1n))).toEqual({ units: 1500n, micros: 1500n });
    expect(vendor.requests.map((r) => r.paid)).toEqual([false]);
  });
});

describe("x402 adapter: lookup", () => {
  const reservedTs = BigInt(T0.getTime() / 1000);
  const deadline = authorizationDeadline(T0);
  const noVendor = (() => Promise.reject(new Error("lookup must not call the vendor"))) as typeof fetch;

  it("RAIL-21: a used authorization is settled, with the hash and the amount from the USDC transfer", async () => {
    const { chain } = fakeChain({ payer: account.address, nonce: authorizationNonce("res-1"), latestTs: reservedTs + 3600n, finalizedTs: reservedTs + 2400n, usedAt: reservedTs + 3n });
    expect(await rail(noVendor, { chain }).lookup("res-1", ctx)).toEqual({ status: "settled", ref: TX, explorerUrl: `https://sepolia.basescan.org/tx/${TX}`, settledMicros: 1500n });
    // Another key has a different nonce, which nothing used before the finalized deadline: failed.
    expect(await rail(noVendor, { chain }).lookup("res-2", ctx)).toEqual({ status: "failed", code: "RAIL_REJECTED" });
  });

  it("RAIL-21: finds a settlement days later, searching only around the reservation", async () => {
    const { chain, calls } = fakeChain({ payer: account.address, latestTs: reservedTs + 3n * 86_400n, finalizedTs: reservedTs + 3n * 86_400n - 1200n, usedAt: deadline - 1n });
    expect(await rail(noVendor, { chain }).lookup("res-1", ctx)).toMatchObject({ status: "settled", ref: TX });
    expect(calls.length).toBeLessThan(80);
  });

  it("RAIL-21: used but with no AuthorizationUsed log found stays unknown", async () => {
    const { chain } = fakeChain({ payer: account.address, latestTs: reservedTs + 3600n, finalizedTs: reservedTs + 2400n, usedAt: reservedTs + 3n, logs: false });
    expect(await rail(noVendor, { chain }).lookup("res-1", ctx)).toEqual({ status: "unknown" });
  });

  it("RAIL-21: unused, with the finalized block at or past the deadline, is failed: the authorization can never be used", async () => {
    for (const finalizedTs of [deadline, deadline + 600n]) {
      const { chain } = fakeChain({ payer: account.address, latestTs: finalizedTs + 1200n, finalizedTs });
      expect(await rail(noVendor, { chain }).lookup("res-1", ctx)).toEqual({ status: "failed", code: "RAIL_REJECTED" });
    }
  });

  it("RAIL-21: unused while the finalized block is still before the deadline is unknown: it can still be submitted", async () => {
    const { chain } = fakeChain({ payer: account.address, latestTs: deadline + 600n, finalizedTs: deadline - 1n });
    expect(await rail(noVendor, { chain }).lookup("res-1", ctx)).toEqual({ status: "unknown" });
  });

  it("RAIL-21: without the reservation time, nothing can be proven", async () => {
    const { chain, calls } = fakeChain({ payer: account.address, latestTs: deadline + 6000n, finalizedTs: deadline + 4000n });
    expect(await rail(noVendor, { chain }).lookup("res-1", {})).toEqual({ status: "unknown" });
    expect(calls).toEqual([]);
  });
});

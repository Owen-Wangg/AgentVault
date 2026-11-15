import { encodePaymentRequiredHeader } from "@x402/core/http";
import fc from "fast-check";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { micros } from "@/core/money";
import { X402Rail } from "./adapter";
import { VENDOR_URL, challenge, fakeVendor } from "./test-fixtures";

// src/rails may import only src/core/money, so the shared generators in
// src/core/testing aren't available here.
const MIN = 1000n;
const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
const T0 = new Date("2026-11-28T18:00:00.000Z");

/** Approved amounts at or above the minimum, up to $10, with the minimum and cent boundaries mixed in. */
const approvedArb = fc.oneof(
  { arbitrary: fc.bigInt({ min: MIN, max: 10_000_000n }), weight: 4 },
  { arbitrary: fc.constantFrom(MIN, MIN + 1n, 1500n, 9_999n, 10_000n, 10_001n), weight: 1 },
);

/**
 * A challenge amount that differs from the approved one: off by one either
 * way (the likeliest bug), off by a cent, zero, anything up to $10, or far
 * beyond any valid amount.
 */
const differentArb = (approved: bigint) =>
  fc
    .oneof(
      fc.constantFrom(approved - 1n, approved + 1n, approved - 10_000n, approved + 10_000n, 0n, approved * 10n),
      fc.bigInt({ min: 0n, max: 10_000_000n }),
      fc.bigInt({ min: 10n ** 18n, max: 10n ** 29n }),
    )
    .filter((c) => c >= 0n && c !== approved);

describe("x402 adapter properties", () => {
  // Property 3, challenge match (RAIL-13): for any challenge amount
  // different from the approved amount, `execute` returns CHALLENGE_MISMATCH.
  // It also never sends the paid request, so nothing is signed or spent.
  it("RAIL-13: any challenge amount other than the approved one is CHALLENGE_MISMATCH, and nothing is paid", async () => {
    let offByOne = 0;
    await fc.assert(
      fc.asyncProperty(approvedArb.chain((a) => fc.tuple(fc.constant(a), differentArb(a))), async ([approved, asked]) => {
        if (asked === approved - 1n || asked === approved + 1n) offByOne += 1;
        const vendor = fakeVendor(asked);
        const rail = new X402Rail({ account, minUnits: MIN, fetch: vendor.fetchFn, now: () => T0 });
        const result = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: micros(approved), idempotencyKey: "k" }, { reservedAt: T0 });
        expect(result).toMatchObject({ ok: false, code: "CHALLENGE_MISMATCH" });
        expect(vendor.requests.map((r) => r.paid)).toEqual([false]);
      }),
      { numRuns: 1000 },
    );
    // The generator reaches the boundary that matters most.
    expect(offByOne).toBeGreaterThan(50);
  });

  // The converse, so the property above can't pass by refusing everything:
  // a challenge for exactly the approved amount is paid, for exactly that amount.
  it("RAIL-11, RAIL-13: a challenge for exactly the approved amount is paid for that amount", async () => {
    await fc.assert(
      fc.asyncProperty(approvedArb, async (approved) => {
        const vendor = fakeVendor(approved);
        const rail = new X402Rail({ account, minUnits: MIN, fetch: vendor.fetchFn, now: () => T0 });
        const result = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: micros(approved), idempotencyKey: "k" }, { reservedAt: T0 });
        expect(result).toMatchObject({ ok: true, settledMicros: approved });
        expect(vendor.requests.map((r) => r.paid)).toEqual([false, true]);
      }),
      // Each case signs once (secp256k1), so fewer runs keep it fast; equality has no boundaries to search.
      { numRuns: 200 },
    );
  });

  it("RAIL-13: a challenge that lists the approved amount on an unusable option and another amount on the usable one is a mismatch", async () => {
    const required = challenge(1501n);
    required.accepts.unshift({ ...required.accepts[0]!, amount: "1500", network: "eip155:8453" });
    const vendor = fakeVendor(1500n, { unpaid: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } }) });
    const rail = new X402Rail({ account, minUnits: MIN, fetch: vendor.fetchFn, now: () => T0 });
    expect(await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: micros(1500n), idempotencyKey: "k" }, { reservedAt: T0 })).toMatchObject({ code: "CHALLENGE_MISMATCH" });
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromRailUnits } from "@/core/money";
import { StripeMppRail } from "./adapter";
import { FakeStripeAccount, PROFILE, VENDOR_URL, fakeMppVendor } from "./test-fixtures";

const RESERVED_AT = new Date(Date.UTC(2026, 10, 29, 18, 0, 0));
const now = () => new Date(RESERVED_AT.getTime() + 5000);
const nowSeconds = () => Math.floor(now().getTime() / 1000);

describe("Stripe MPP adapter properties", () => {
  // Property 3, challenge match (RAIL-13): "for any challenge amount different
  // from the approved amount, `execute` returns `CHALLENGE_MISMATCH`."
  // Here it also creates no SPT, so nothing could be paid.
  it("RAIL-13: property 3, any challenge amount other than the approved one is CHALLENGE_MISMATCH with no SPT", async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 50n, max: 100_000n }), fc.bigInt({ min: 50n, max: 100_000n }), async (approved, asked) => {
        fc.pre(approved !== asked);
        const account = new FakeStripeAccount(nowSeconds);
        const vendor = fakeMppVendor(account, { cents: asked });
        const rail = new StripeMppRail({ api: account.api(), profileId: PROFILE, fetch: vendor.fetchFn, now });
        const result = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: fromRailUnits(approved, "stripe"), idempotencyKey: "k" }, { reservedAt: RESERVED_AT });
        expect(result).toMatchObject({ ok: false, code: "CHALLENGE_MISMATCH" });
        expect(account.spts.size).toBe(0);
        expect(account.paymentIntents).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  // Property 4, lookup is read-only (RAIL-21, RAIL-22), applied to this adapter:
  // "for any sequence of `execute` and `lookup` calls, the number of recorded
  // payments equals the number of distinct keys passed to `execute`, and
  // `lookup` reports `settled` exactly for keys with a recorded payment."
  it("RAIL-3, RAIL-22: property 4, lookups never pay, and each key pays at most once", async () => {
    const op = fc.record({ kind: fc.constantFrom("execute", "lookup"), key: fc.constantFrom("a", "b", "c", "d") });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 12 }), async (ops) => {
        const account = new FakeStripeAccount(nowSeconds);
        const vendor = fakeMppVendor(account);
        const rail = new StripeMppRail({ api: account.api(), profileId: PROFILE, fetch: vendor.fetchFn, now });
        const executed = new Set<string>();
        for (const { kind, key } of ops) {
          if (kind === "execute") {
            await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: fromRailUnits(50n, "stripe"), idempotencyKey: key }, { reservedAt: RESERVED_AT });
            executed.add(key);
          } else {
            const found = await rail.lookup(key, { reservedAt: RESERVED_AT });
            expect(found.status).toBe(executed.has(key) ? "settled" : "unknown");
          }
        }
        expect(account.paymentIntents).toHaveLength(executed.size);
        expect(account.usedSpts()).toBe(executed.size);
      }),
      { numRuns: 100 },
    );
  });
});

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { micros } from "@/core/money";
import { MockRail } from "./mock";
import { StripeMppRail } from "./stripe-mpp/adapter";
import { StripeApi } from "./stripe-mpp/stripe-api";
import type { RailAdapter } from "./types";
import { X402Rail } from "./x402/adapter";

const ADAPTERS = { MockRail, StripeMppRail, X402Rail } as const;
const METHODS = ["quote", "execute", "refund", "lookup", "payout", "checkDestination"] as const;

/** A fetch that fails the test if anything is sent. */
const noNetwork = (async () => {
  throw new Error("the adapter contacted the network");
}) as typeof fetch;
// A throwaway key for constructing the adapter; nothing is ever signed with it.
const TEST_KEY = `0x${"11".repeat(32)}` as const;

describe("rail adapter interface", () => {
  it("RAIL-1, PO-1: every adapter class has the RailAdapter type", () => {
    expectTypeOf<InstanceType<typeof MockRail>>().toExtend<RailAdapter>();
    expectTypeOf<InstanceType<typeof StripeMppRail>>().toExtend<RailAdapter>();
    expectTypeOf<InstanceType<typeof X402Rail>>().toExtend<RailAdapter>();
  });

  it.each(Object.entries(ADAPTERS))("RAIL-1, PO-1: %s exposes quote, execute, refund, lookup, payout, and checkDestination", (_name, adapter) => {
    for (const method of METHODS) expect(typeof adapter.prototype[method]).toBe("function");
  });

  it("PO-1: x402 refuses payouts and destination checks without contacting anyone", async () => {
    const rail: RailAdapter = new X402Rail({ account: privateKeyToAccount(TEST_KEY), minUnits: 1n, fetch: noNetwork });
    const req = { destination: "acct_1Supplier", amountMicros: micros(1_000_000n), idempotencyKey: "k" };
    await expect(rail.payout(req)).resolves.toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    await expect(rail.checkDestination("acct_1Supplier")).resolves.toMatchObject({ ok: false, code: "RAIL_REJECTED" });
  });

  it("PO-1: the Stripe adapter refuses payouts without contacting Stripe until Connect payouts are built", async () => {
    const rail: RailAdapter = new StripeMppRail({ api: new StripeApi({ secretKey: "sk_test_x", fetch: noNetwork }), profileId: "profile_test_x", fetch: noNetwork });
    const req = { destination: "acct_1Supplier", amountMicros: micros(1_000_000n), idempotencyKey: "k" };
    await expect(rail.payout(req)).resolves.toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    await expect(rail.checkDestination("acct_1Supplier")).resolves.toMatchObject({ ok: false, code: "RAIL_REJECTED" });
  });
});

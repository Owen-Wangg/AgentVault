import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import type { RailConfig } from "./config";
import { MockRail, mockRef } from "./mock";
import { RailUnavailableError, createMockRails, railFor } from "./select";
import type { RailAdapter } from "./types";

const req = (key: string, amount: string, vendorUrl = "https://vendor.example/api") => ({
  vendorUrl,
  approvedMicros: fromDecimalString(amount),
  idempotencyKey: key,
});

describe("RAIL-19: deterministic mock references", () => {
  it("RAIL-19: the ref is mock_tx_ plus the first 16 hex chars of sha256(key)", async () => {
    const expected = `mock_tx_${createHash("sha256").update("res-1").digest("hex").slice(0, 16)}`;
    expect(mockRef("res-1")).toBe(expected);
    const result = await new MockRail("x402", 1n).execute(req("res-1", "0.0015"));
    expect(result).toEqual({ ok: true, ref: expected, settledMicros: micros(1_500n) });
  });

  it("RAIL-19: different keys give different refs", () => {
    expect(mockRef("a")).not.toBe(mockRef("b"));
  });
});

describe("RAIL-3: idempotency", () => {
  it("RAIL-3: a repeated key returns the original result and records one payment", async () => {
    const rail = new MockRail("x402", 1n);
    const first = await rail.execute(req("k", "0.0015"));
    const second = await rail.execute(req("k", "0.0015"));
    expect(second).toEqual(first);
    expect(rail.recorded()).toHaveLength(1);
    expect(rail.calls).toBe(1);
  });
});

describe("RAIL-4: rail minimums", () => {
  it("RAIL-4: a Stripe debit below 50 cents is refused without contacting the rail", async () => {
    const rail = new MockRail("stripe", 50n);
    expect(await rail.execute(req("k", "0.49"))).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(rail.calls).toBe(0);
    expect(rail.recorded()).toEqual([]);
  });

  it("RAIL-4: the minimum is checked after rounding up, so $0.491 charges 50 cents", async () => {
    const rail = new MockRail("stripe", 50n);
    expect(await rail.execute(req("k", "0.491"))).toEqual({ ok: true, ref: mockRef("k"), settledMicros: micros(500_000n) });
  });

  it("RAIL-4: the x402 minimum is in USDC atomic units", async () => {
    const rail = new MockRail("x402", 10_000n);
    expect(await rail.execute(req("a", "0.0099"))).toMatchObject({ code: "BELOW_RAIL_MINIMUM" });
    expect(await rail.execute(req("b", "0.01"))).toMatchObject({ ok: true });
  });

  it("RAIL-4: the sandbox's $0.0015 weather payment works with the default x402 minimum", async () => {
    const rails = createMockRails({ x402MinUnits: 1n });
    expect(await rails.x402.execute(req("k", "0.0015"))).toMatchObject({ ok: true, settledMicros: micros(1_500n) });
  });
});

describe("RAIL-20: failure modes", () => {
  it.each(["RAIL_REJECTED", "CHALLENGE_MISMATCH", "BELOW_RAIL_MINIMUM"] as const)(
    "RAIL-20: %s is returned and nothing is recorded",
    async (code) => {
      const rail = new MockRail("x402", 1n);
      rail.setFailureMode(code);
      expect(await rail.execute(req("k", "1"))).toEqual({ ok: false, code });
      expect(rail.recorded()).toEqual([]);
      expect(await rail.lookup("k")).toEqual({ status: "unknown" });
    },
  );

  it.each(["RAIL_TIMEOUT", "INVALID_RAIL_RESPONSE"] as const)(
    "RAIL-6, RAIL-20: %s records the payment before failing, so money moved without the caller knowing",
    async (code) => {
      const rail = new MockRail("x402", 1n);
      rail.setFailureMode(code);
      expect(await rail.execute(req("k", "1"))).toEqual({ ok: false, code });
      expect(await rail.lookup("k")).toEqual({ status: "settled", ref: mockRef("k"), settledMicros: micros(1_000_000n) });
    },
  );

  it("RAIL-20: clearing the failure mode makes calls succeed again", async () => {
    const rail = new MockRail("x402", 1n);
    rail.setFailureMode("RAIL_REJECTED");
    rail.setFailureMode(null);
    expect(await rail.execute(req("k", "1"))).toMatchObject({ ok: true });
  });

  it("RAIL-6: an aborted signal times out without recording", async () => {
    const rail = new MockRail("x402", 1n);
    const result = await rail.execute(req("k", "1"), { signal: AbortSignal.abort() });
    expect(result).toEqual({ ok: false, code: "RAIL_TIMEOUT" });
    expect(rail.recorded()).toEqual([]);
  });
});

describe("RAIL-21, RAIL-22: lookup", () => {
  it("RAIL-21: reports settled for a recorded key and unknown otherwise", async () => {
    const rail = new MockRail("x402", 1n);
    await rail.execute(req("paid", "0.0015"));
    expect(await rail.lookup("paid")).toEqual({ status: "settled", ref: mockRef("paid"), settledMicros: micros(1_500n) });
    expect(await rail.lookup("never")).toEqual({ status: "unknown" });
  });

  it("RAIL-20, RAIL-21: a test can set what lookup reports, and clear it", async () => {
    const rail = new MockRail("x402", 1n);
    rail.setLookupResult("k", { status: "failed", code: "RAIL_REJECTED" });
    expect(await rail.lookup("k")).toEqual({ status: "failed", code: "RAIL_REJECTED" });
    rail.setLookupResult("k", null);
    expect(await rail.lookup("k")).toEqual({ status: "unknown" });
  });

  it("RAIL-22: lookup never records a payment", async () => {
    const rail = new MockRail("x402", 1n);
    await rail.lookup("k");
    expect(rail.recorded()).toEqual([]);
    expect(rail.calls).toBe(0);
  });
});

describe("refunds", () => {
  it("MON-8: Stripe refunds round down to whole cents", async () => {
    const rail = new MockRail("stripe", 50n);
    const result = await rail.refund({ paymentRef: "pi_seed", amountMicros: fromDecimalString("480.009"), idempotencyKey: "r" });
    expect(result).toEqual({ ok: true, ref: mockRef("r"), settledMicros: fromDecimalString("480") });
    expect(rail.recorded()[0]).toMatchObject({ kind: "refund", units: 48_000n });
  });

  it("RAIL-4: a refund that rounds down to 0 cents is refused", async () => {
    const rail = new MockRail("stripe", 50n);
    expect(await rail.refund({ paymentRef: "pi", amountMicros: micros(9_999n), idempotencyKey: "r" })).toMatchObject({
      code: "BELOW_RAIL_MINIMUM",
    });
  });

  it("RAIL-3: a repeated refund key refunds once", async () => {
    const rail = new MockRail("stripe", 50n);
    const r = { paymentRef: "pi", amountMicros: fromDecimalString("1"), idempotencyKey: "r" };
    await rail.refund(r);
    await rail.refund(r);
    expect(rail.recorded()).toHaveLength(1);
  });
});

describe("quote", () => {
  it("quotes the rounded-up debit in rail units and micros", async () => {
    expect(await new MockRail("stripe", 50n).quote(req("k", "0.5001"))).toEqual({ units: 51n, micros: micros(510_000n) });
  });
});

describe("RAIL-2: railFor", () => {
  const mockConfig: RailConfig = { mode: "mock", x402Network: "eip155:84532", x402MinUnits: 1n };
  const realConfig: RailConfig = { ...mockConfig, mode: "real" };
  const fakeReal = { rail: "x402" } as RailAdapter;

  it("RAIL-2: mock mode uses the mock adapter for every rail", () => {
    const mocks = createMockRails(mockConfig);
    for (const rail of ["stripe", "x402", "mock"] as const) {
      expect(railFor(rail, { isSandbox: false }, { config: mockConfig, mocks, real: { x402: fakeReal } })).toBe(mocks[rail]);
    }
  });

  it("RAIL-2: the sandbox uses the mock adapter even when RAIL_MODE=real", () => {
    const mocks = createMockRails(mockConfig);
    expect(railFor("x402", { isSandbox: true }, { config: realConfig, mocks, real: { x402: fakeReal } })).toBe(mocks.x402);
  });

  it("RAIL-2: real mode outside the sandbox uses the real adapter", () => {
    expect(railFor("x402", { isSandbox: false }, { config: realConfig, mocks: createMockRails(mockConfig), real: { x402: fakeReal } })).toBe(
      fakeReal,
    );
  });

  it("real mode fails closed when a rail has no real adapter yet", () => {
    expect(() => railFor("stripe", { isSandbox: false }, { config: realConfig, mocks: createMockRails(mockConfig) })).toThrow(
      RailUnavailableError,
    );
  });

  it("each simulated rail has its rail's minimum", () => {
    const mocks = createMockRails({ x402MinUnits: 25n });
    expect([mocks.stripe.minimumUnits, mocks.x402.minimumUnits, mocks.mock.minimumUnits]).toEqual([50n, 25n, 1n]);
  });
});

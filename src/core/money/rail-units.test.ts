import { describe, expect, it } from "vitest";
import { AmountOutOfRangeError, InvalidAmountError } from "./errors";
import { MAX_MICROS, micros } from "./micros";
import { chargeableMicros, fromRailUnits, toRailUnits } from "./rail-units";

const m = micros;

describe("MON-7: Stripe debits round up to the next cent", () => {
  it.each([
    [0n, 0n],
    [1n, 1n],
    [1_500n, 1n],
    [9_999n, 1n],
    [10_000n, 1n],
    [10_001n, 2n],
    [500_000n, 50n],
    [480_000_000n, 48_000n],
  ])("MON-7: %s micros debits %s cents", (amount, cents) => {
    expect(toRailUnits(m(amount), "stripe", "debit")).toBe(cents);
  });
});

describe("MON-8: Stripe credits round down to the whole cent", () => {
  it.each([
    [0n, 0n],
    [1n, 0n],
    [9_999n, 0n],
    [10_000n, 1n],
    [19_999n, 1n],
    [480_000_000n, 48_000n],
  ])("MON-8: %s micros credits %s cents", (amount, cents) => {
    expect(toRailUnits(m(amount), "stripe", "credit")).toBe(cents);
  });
});

describe("MON-9: x402 and mock convert 1:1", () => {
  it.each(["x402", "mock"] as const)("MON-9: %s units equal micros in both directions", (rail) => {
    for (const amount of [0n, 1n, 1_500n, 9_999n, MAX_MICROS]) {
      expect(toRailUnits(m(amount), rail, "debit")).toBe(amount);
      expect(toRailUnits(m(amount), rail, "credit")).toBe(amount);
      expect(fromRailUnits(amount, rail)).toBe(amount);
    }
  });
});

describe("MON-10: debits count the rounded-up amount", () => {
  it("MON-10: a $0.0015 Stripe debit counts as one full cent", () => {
    expect(chargeableMicros(m(1_500n), "stripe", "debit")).toBe(10_000n);
  });

  it("MON-10: an exact cent amount is unchanged", () => {
    expect(chargeableMicros(m(500_000n), "stripe", "debit")).toBe(500_000n);
  });

  it("MON-10: x402 and mock debits count the exact amount", () => {
    expect(chargeableMicros(m(1_500n), "x402", "debit")).toBe(1_500n);
    expect(chargeableMicros(m(1_500n), "mock", "debit")).toBe(1_500n);
  });

  it("MON-10: rounding up at the maximum stays in range", () => {
    expect(chargeableMicros(MAX_MICROS, "stripe", "debit")).toBe(MAX_MICROS);
  });
});

describe("MON-11: credits count the full requested amount", () => {
  it("MON-11: a Stripe refund of 19,999 micros counts in full, though Stripe refunds only 1 cent", () => {
    expect(toRailUnits(m(19_999n), "stripe", "credit")).toBe(1n);
    expect(chargeableMicros(m(19_999n), "stripe", "credit")).toBe(19_999n);
  });

  it("MON-11: the $480 demo refund counts as $480", () => {
    expect(chargeableMicros(m(480_000_000n), "stripe", "credit")).toBe(480_000_000n);
  });
});

describe("conversion input checks", () => {
  it("converts Stripe cents back to micros exactly", () => {
    expect(fromRailUnits(50n, "stripe")).toBe(500_000n);
  });

  it("rejects negative or oversized rail units", () => {
    expect(() => fromRailUnits(-1n, "stripe")).toThrow(AmountOutOfRangeError);
    expect(() => fromRailUnits(MAX_MICROS + 1n, "x402")).toThrow(AmountOutOfRangeError);
  });

  it("rejects an unknown rail, an unknown direction, and number inputs", () => {
    const asAny = (v: unknown) => v as never;
    expect(() => toRailUnits(m(1n), asAny("paypal"), "debit")).toThrow(InvalidAmountError);
    expect(() => chargeableMicros(m(1n), asAny("paypal"), "credit")).toThrow(InvalidAmountError);
    expect(() => toRailUnits(m(1n), "stripe", asAny("sideways"))).toThrow(InvalidAmountError);
    expect(() => fromRailUnits(asAny(50), "stripe")).toThrow(InvalidAmountError);
    expect(() => toRailUnits(asAny(1500), "stripe", "debit")).toThrow(InvalidAmountError);
  });
});

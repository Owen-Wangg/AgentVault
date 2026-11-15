import { describe, expect, it } from "vitest";
import { EnvelopeWireSchema, envelopeFromWire } from "./envelope-wire";

const valid = {
  limits: { txMaxMicros: "5000000", windowCapsMicros: { day: "20000000" }, callsPerMinute: 30 },
  vendorLimits: { "nimbus-weather": { txMaxMicros: "1500" } },
  toolLimits: {},
  allowedVendors: "*",
  allowedTools: ["x402.pay", "mpp.pay"],
  expectedVersion: 1,
};

const parse = (body: unknown) => EnvelopeWireSchema.safeParse(body);

describe("EnvelopeWireSchema", () => {
  it("UI-8: accepts micros strings and turns them into exact amounts", () => {
    const parsed = parse(valid);
    expect(parsed.success).toBe(true);
    const envelope = envelopeFromWire(parsed.data!);
    expect(envelope.limits).toEqual({ txMaxMicros: 5_000_000n, windowCapsMicros: { day: 20_000_000n }, callsPerMinute: 30 });
    expect(envelope.vendorLimits["nimbus-weather"]).toEqual({ txMaxMicros: 1500n });
  });

  it("MON-4: rejects amounts sent as JSON numbers, decimals, or negatives", () => {
    for (const txMaxMicros of [5000000, "5.5", "-1", "1e6", "01"]) {
      expect(parse({ ...valid, limits: { txMaxMicros } }).success, String(txMaxMicros)).toBe(false);
    }
  });

  it("ENV-11: rejects a __proto__ vendor or tool, in a limit map or an allow-list", () => {
    expect(parse({ ...valid, vendorLimits: JSON.parse('{"__proto__": {"txMaxMicros": "0"}}') }).success).toBe(false);
    expect(parse({ ...valid, toolLimits: JSON.parse('{"__proto__": {}}') }).success).toBe(false);
    expect(parse({ ...valid, allowedVendors: ["__proto__"] }).success).toBe(false);
  });

  it("UI-8: rejects unknown fields, duplicate names, bad names, and an absurd calls-per-minute limit", () => {
    expect(parse({ ...valid, extra: true }).success).toBe(false);
    expect(parse({ ...valid, limits: { txMax: "1" } }).success).toBe(false);
    expect(parse({ ...valid, allowedTools: ["x402.pay", "x402.pay"] }).success).toBe(false);
    expect(parse({ ...valid, allowedVendors: ["has space"] }).success).toBe(false);
    expect(parse({ ...valid, allowedVendors: [""] }).success).toBe(false);
    expect(parse({ ...valid, limits: { callsPerMinute: 1.5 } }).success).toBe(false);
    expect(parse({ ...valid, limits: { callsPerMinute: 100_001 } }).success).toBe(false);
    expect(parse({ ...valid, expectedVersion: 0 }).success).toBe(false);
    expect(parse({ ...valid, expectedVersion: undefined }).success).toBe(false);
  });

  it("UI-8: rejects more than 100 names", () => {
    const many = Array.from({ length: 101 }, (_, i) => `vendor-${i}`);
    expect(parse({ ...valid, allowedVendors: many }).success).toBe(false);
    expect(parse({ ...valid, vendorLimits: Object.fromEntries(many.map((n) => [n, {}])) }).success).toBe(false);
  });
});

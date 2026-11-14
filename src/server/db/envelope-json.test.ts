import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { envelopeArb } from "@/core/testing/arbitraries";
import { SEED_AGENTS } from "@/server/sandbox/seed-data";
import { decodeEnvelope, encodeEnvelope } from "./envelope-json";

describe("envelope JSON columns", () => {
  it("stores amounts as micros strings, never numbers", () => {
    const columns = encodeEnvelope(SEED_AGENTS[1]!.envelope);
    expect(columns.limits).toEqual({ approvalThresholdMicros: "100000000" });
    expect(columns.toolLimits).toEqual({ "stripe.refund": { txMaxMicros: "1000000000" } });
  });

  // Any envelope survives the trip through its JSON columns (and JSON text, as jsonb stores it).
  it("round-trips any envelope", () => {
    fc.assert(
      fc.property(envelopeArb("agent-1"), (envelope) => {
        const { agentId, ...rest } = envelope;
        const stored = JSON.parse(JSON.stringify(encodeEnvelope(rest))) as ReturnType<typeof encodeEnvelope>;
        expect(decodeEnvelope(agentId, stored)).toEqual(envelope);
      }),
      { numRuns: 300 },
    );
  });

  it("fails closed on malformed stored values", () => {
    const good = encodeEnvelope(SEED_AGENTS[0]!.envelope);
    expect(() => decodeEnvelope("a", { ...good, limits: { txMaxMicros: 1000 } })).toThrow();
    expect(() => decodeEnvelope("a", { ...good, limits: { txMaxMicros: "1.5" } })).toThrow();
    expect(() => decodeEnvelope("a", { ...good, limits: { unknownLimit: "1" } })).toThrow();
    expect(() => decodeEnvelope("a", { ...good, allowedTools: "x402.pay" })).toThrow();
    expect(() => decodeEnvelope("a", { ...good, vendorLimits: null })).toThrow();
    // jsonb parsed by JSON.parse gives an own "__proto__" key; it must not silently vanish.
    expect(() => decodeEnvelope("a", { ...good, vendorLimits: JSON.parse('{"__proto__":{"txMaxMicros":"0"}}') })).toThrow("__proto__");
  });
});

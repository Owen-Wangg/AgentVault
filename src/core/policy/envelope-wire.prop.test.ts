import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { envelopeArb } from "@/core/testing/arbitraries";
import { EnvelopeWireSchema, envelopeFromWire, envelopeToWire } from "./envelope-wire";
import type { Envelope } from "./types";

const RUNS = { numRuns: 1000 };

/** The wire format rejects "__proto__" as a name (see the example tests); every other generated name is valid. */
const wireableEnvelope = envelopeArb().map((e): Omit<Envelope, "agentId"> => ({
  limits: e.limits,
  vendorLimits: e.vendorLimits,
  toolLimits: e.toolLimits,
  allowedVendors: e.allowedVendors === "*" ? "*" : e.allowedVendors.filter((n) => n !== "__proto__"),
  allowedTools: e.allowedTools === "*" ? "*" : e.allowedTools.filter((n) => n !== "__proto__"),
}));

describe("envelope wire format properties", () => {
  // UI-8: an envelope sent to the server as micros strings and parsed back
  // is the same envelope, with every amount exact, including for names
  // like "constructor" and "toString".
  it("UI-8: wire round trip keeps every limit and name exactly", () => {
    fc.assert(
      fc.property(wireableEnvelope, fc.integer({ min: 1, max: 1000 }), (envelope, version) => {
        const wire = JSON.parse(JSON.stringify(envelopeToWire(envelope, version))) as unknown;
        const parsed = EnvelopeWireSchema.parse(wire);
        expect(parsed.expectedVersion).toBe(version);
        expect(envelopeFromWire(parsed)).toEqual(envelope);
      }),
      RUNS,
    );
  });
});

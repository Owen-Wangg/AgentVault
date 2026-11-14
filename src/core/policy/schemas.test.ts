import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MAX_MICROS, micros } from "@/core/money";
import { baseInput } from "@/core/testing/policy-fixtures";
import { EvaluateInputSchema, LimitsSchema, MicrosValueSchema } from "./schemas";
import type { EvaluateInput } from "./types";

const m = micros;
const validInput = baseInput;

/** Apply a change to a deep copy of the valid input, typed loosely so tests can break it. */
function broken(change: (input: Record<string, Record<string, unknown>>) => void): unknown {
  const input = structuredClone(validInput()) as unknown as Record<string, Record<string, unknown>>;
  change(input);
  return input;
}

describe("ENV-15: input schemas", () => {
  it("ENV-15: accepts a well-formed input", () => {
    expect(EvaluateInputSchema.safeParse(validInput()).success).toBe(true);
  });

  it("ENV-15: the schema accepts every value of the EvaluateInput type", () => {
    // Compile-time check: if a field is added to the types but not the schema, this stops compiling.
    type Extends<A, B> = [A] extends [B] ? true : false;
    const accepted: Extends<EvaluateInput, z.input<typeof EvaluateInputSchema>> = true;
    expect(accepted).toBe(true);
  });

  it.each<[string, (i: Record<string, Record<string, unknown>>) => void]>([
    ["a number amount (MON-4)", (i) => (i.request!.amountMicros = 1500)],
    ["a string amount", (i) => (i.request!.amountMicros = "1500")],
    ["a negative amount", (i) => (i.request!.amountMicros = -1n)],
    ["an amount above MAX_MICROS", (i) => (i.request!.amountMicros = MAX_MICROS + 1n)],
    ["an unknown request kind", (i) => (i.request!.kind = "refund")],
    ["an empty vendor", (i) => (i.request!.vendor = "")],
    ["a missing tool", (i) => delete i.request!.tool],
    ["an unknown request field", (i) => (i.request!.extra = "x")],
    ["an unknown top-level field", (i) => ((i as Record<string, unknown>).approved = ["HELD_TAINTED"])],
    ["a deny code as an approved hold reason (HITL-3)", (i) => ((i as Record<string, unknown>).approvedHoldReasons = ["AGENT_FROZEN"])],
    ["an unknown code as an approved hold reason", (i) => ((i as Record<string, unknown>).approvedHoldReasons = ["EVERYTHING"])],
    ["approved hold reasons that aren't an array", (i) => ((i as Record<string, unknown>).approvedHoldReasons = "HELD_TAINTED")],
    ["an approved hold reason with detail", (i) => ((i as Record<string, unknown>).approvedHoldReasons = [{ code: "HELD_TAINTED" }])],
    ["a fractional call count", (i) => (i.window!.callsLastMinute = 1.5)],
    ["a negative call count", (i) => (i.window!.callsLastMinute = -1)],
    ["a missing window", (i) => (i.window!.spentMicros = { minute: 0n, hour: 0n })],
    ["an allow-list that is a bare string other than *", (i) => (i.envelope!.allowedVendors = "nimbus-weather")],
    ["a non-boolean frozen flag", (i) => (i.session!.agentFrozen = "false")],
    ["a taint time that is not ISO", (i) => (i.session!.taintedAt = "yesterday")],
    ["a vendor limit map keyed by __proto__", (i) => (i.envelope!.vendorLimits = Object.fromEntries([["__proto__", {}]]))],
    ["a tool limit map keyed by __proto__", (i) => (i.envelope!.toolLimits = Object.fromEntries([["__proto__", {}]]))],
    ["a vendor limit map that is not an object", (i) => (i.envelope!.vendorLimits = null)],
    ["an envelope for another agent", (i) => (i.envelope!.agentId = "agent-2")],
    ["session state for another session", (i) => (i.session!.sessionId = "session-2")],
    ["a missing tool definition", (i) => delete (i as Record<string, unknown>).tool],
    ["a tool definition for another tool", (i) => (i.tool!.name = "stripe.refund")],
    ["a non-boolean privileged flag", (i) => (i.tool!.privileged = "true")],
    ["an unknown rail", (i) => (i.tool!.rail = "paypal")],
    ["an unknown tool definition field", (i) => (i.tool!.direction = "debit")],
    ["a non-string task category", (i) => (i.scope!.allowedVendorCategories = [1])],
  ])("ENV-15: rejects %s", (_name, change) => {
    expect(EvaluateInputSchema.safeParse(broken(change)).success).toBe(false);
  });

  it("HITL-2: accepts approved hold reasons on an approval re-run, including none", () => {
    for (const approvedHoldReasons of [[], ["NEEDS_APPROVAL"], ["HELD_TAINTED", "NEEDS_APPROVAL", "ADVISORY_DRIFT"]] as const) {
      expect(EvaluateInputSchema.safeParse({ ...validInput(), approvedHoldReasons }).success).toBe(true);
    }
  });

  it.each([null, undefined, 42, "input", [], {}])("ENV-15: rejects %s as the whole input", (value) => {
    expect(EvaluateInputSchema.safeParse(value).success).toBe(false);
  });

  it("ENV-15: rejects unknown limit fields and number amounts in limits", () => {
    expect(LimitsSchema.safeParse({ txMaxMicros: 100 }).success).toBe(false);
    expect(LimitsSchema.safeParse({ txMax: m(100n) }).success).toBe(false);
    expect(LimitsSchema.safeParse({ windowCapsMicros: { week: m(1n) } }).success).toBe(false);
  });

  it("MON-4: in-memory amounts must be bigints in range", () => {
    expect(MicrosValueSchema.safeParse(0n).success).toBe(true);
    expect(MicrosValueSchema.safeParse(MAX_MICROS).success).toBe(true);
    expect(MicrosValueSchema.safeParse(1).success).toBe(false);
  });
});

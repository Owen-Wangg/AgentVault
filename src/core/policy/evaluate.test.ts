import { describe, expect, it } from "vitest";
import { micros } from "@/core/money";
import { baseInput, usd, withLimits } from "@/core/testing/policy-fixtures";
import { combine, evaluate } from "./evaluate";
import type { Decision, EvaluateInput, Limits } from "./types";

const m = micros;
const codes = (d: Decision) => d.reasons.map((r) => r.code);

describe("ENV-10: allow", () => {
  it("ENV-10: a request that passes every rule is allowed with no reasons", () => {
    expect(evaluate(baseInput())).toEqual({ decision: "allow", reasons: [] });
  });
});

describe("ENV-11: every applicable reason is returned", () => {
  it("ENV-11: reports all deny reasons, not only the first", () => {
    const input = withLimits({ agent: { txMaxMicros: usd(1n), callsPerMinute: 1 } });
    input.request.amountMicros = usd(2n);
    input.session.agentFrozen = true;
    input.window.callsLastMinute = 1;
    input.envelope.allowedVendors = [];
    input.envelope.allowedTools = [];
    expect(codes(evaluate(input))).toEqual([
      "AGENT_FROZEN",
      "OVER_TX_MAX",
      "VELOCITY_EXCEEDED",
      "VENDOR_NOT_ALLOWED",
      "TOOL_NOT_ALLOWED",
    ]);
  });
});

describe("ENV-12: precedence", () => {
  it("ENV-12: any deny reason denies, even alongside a hold reason", () => {
    expect(combine([{ code: "NEEDS_APPROVAL" }, { code: "OVER_TX_MAX" }]).decision).toBe("deny");
  });

  it("ENV-12: hold reasons alone hold", () => {
    expect(combine([{ code: "HELD_TAINTED" }, { code: "NEEDS_APPROVAL" }])).toEqual({
      decision: "hold",
      reasons: [{ code: "HELD_TAINTED" }, { code: "NEEDS_APPROVAL" }],
    });
  });

  it("ENV-12: no reasons allows", () => {
    expect(combine([])).toEqual({ decision: "allow", reasons: [] });
  });

  it("ENV-12: an unrecognized code denies (fail closed)", () => {
    expect(combine([{ code: "SOMETHING_NEW" as never }]).decision).toBe("deny");
  });

  it("ENV-12: combine copies the reasons, so later changes to the array don't leak in", () => {
    const reasons = [{ code: "OVER_TX_MAX" as const }];
    const decision = combine(reasons);
    reasons.push({ code: "OVER_TX_MAX" });
    expect(decision.reasons).toHaveLength(1);
  });
});

describe("ENV-8: approval threshold with other rules", () => {
  it("ENV-8: holds with NEEDS_APPROVAL when no deny rule fires", () => {
    const input = withLimits({ agent: { approvalThresholdMicros: usd(100n) } });
    input.request.amountMicros = usd(480n);
    expect(evaluate(input)).toEqual({
      decision: "hold",
      reasons: [{ code: "NEEDS_APPROVAL", detail: { level: "agent", thresholdMicros: "100000000" } }],
    });
  });

  it("ENV-8: does not add NEEDS_APPROVAL to a request that is denied", () => {
    const input = withLimits({ agent: { approvalThresholdMicros: usd(100n) } });
    input.request.amountMicros = usd(480n);
    input.envelope.allowedVendors = [];
    expect(codes(evaluate(input))).toEqual(["VENDOR_NOT_ALLOWED"]);
  });
});

describe("ENV-4: velocity is reported, not acted on", () => {
  it("ENV-4: reports VELOCITY_EXCEEDED and leaves freezing to the server", () => {
    const input = withLimits({ agent: { callsPerMinute: 30 } });
    input.window.callsLastMinute = 30;
    const before = structuredClone(input);
    expect(codes(evaluate(input))).toEqual(["VELOCITY_EXCEEDED"]);
    expect(input).toEqual(before);
  });
});

describe("ENV-13: determinism", () => {
  it("ENV-13: identical inputs give identical decisions", () => {
    const input = withLimits({ agent: { txMaxMicros: usd(1n) } });
    input.request.amountMicros = usd(2n);
    expect(evaluate(input)).toEqual(evaluate(structuredClone(input)));
  });
});

describe("ENV-15: invalid input fails closed", () => {
  it("ENV-15: a number amount is denied with INVALID_REQUEST and the field path", () => {
    const input = baseInput() as unknown as { request: { amountMicros: unknown } };
    input.request.amountMicros = 1500;
    expect(evaluate(input as unknown as EvaluateInput)).toEqual({
      decision: "deny",
      reasons: [{ code: "INVALID_REQUEST", detail: { path: "request.amountMicros" } }],
    });
  });

  it.each([null, undefined, 0, "pay", [], {}])("ENV-15: %s is denied with INVALID_REQUEST", (value) => {
    expect(codes(evaluate(value as unknown as EvaluateInput))).toEqual(["INVALID_REQUEST"]);
  });

  it("ENV-15: never throws, even if reading the input throws", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    expect(evaluate(hostile as EvaluateInput)).toEqual({ decision: "deny", reasons: [{ code: "INVALID_REQUEST" }] });
  });

  it("ENV-15: an envelope for a different agent is denied", () => {
    const input = baseInput();
    input.envelope.agentId = "agent-2";
    expect(evaluate(input)).toEqual({
      decision: "deny",
      reasons: [{ code: "INVALID_REQUEST", detail: { path: "envelope.agentId" } }],
    });
  });
});

describe("ENV-9, ENV-15: per-vendor limits through evaluate()", () => {
  // Regression for property 5 (shrunk counterexample, seed -792056920):
  // z.record drops an own "__proto__" key, so this day cap of 0 vanished
  // during parsing and a 1-micro payment was allowed.
  it("ENV-15: a limit map keyed by __proto__ is denied instead of silently losing the limit", () => {
    const input = baseInput();
    input.request.vendor = "__proto__";
    input.request.amountMicros = m(1n);
    input.envelope.vendorLimits = Object.fromEntries([["__proto__", { windowCapsMicros: { day: m(0n) } }]]);
    expect(evaluate(input)).toEqual({
      decision: "deny",
      reasons: [{ code: "INVALID_REQUEST", detail: { path: "envelope.vendorLimits" } }],
    });
  });

  it("ENV-9: a vendor named __proto__ with no limit map entry is evaluated normally", () => {
    const input = withLimits({ agent: { txMaxMicros: usd(1n) } });
    input.request.vendor = "__proto__";
    input.request.amountMicros = usd(2n);
    expect(codes(evaluate(input))).toEqual(["OVER_TX_MAX"]);
  });

  it("ENV-9: a limit for a vendor named constructor survives schema parsing", () => {
    const input = baseInput();
    input.request.vendor = "constructor";
    input.request.amountMicros = usd(2n);
    input.envelope.vendorLimits = { constructor: { txMaxMicros: usd(1n) } };
    expect(codes(evaluate(input))).toEqual(["OVER_TX_MAX"]);
  });
});

/**
 * The envelope parts of the demo scenarios (demo-agents design). Those
 * scenarios compare exact reason lists, so the envelope rules must not add
 * any reason beyond the ones listed there.
 */
describe("demo scenario envelopes", () => {
  const weatherCall = (limits: Limits, callsLastMinute: number, minuteSpent: bigint, frozen: boolean): EvaluateInput => {
    const input = withLimits({ agent: limits });
    input.request.amountMicros = m(1_500n);
    input.window.callsLastMinute = callsLastMinute;
    input.window.spentMicros = { minute: m(minuteSpent), hour: m(minuteSpent), day: m(minuteSpent) };
    input.session.agentFrozen = frozen;
    return input;
  };

  it("ENV-10: normal: 5 weather payments are allowed", () => {
    const limits: Limits = { txMaxMicros: usd(1n), windowCapsMicros: { minute: m(500_000n) }, callsPerMinute: 30 };
    let spent = 0n;
    for (let i = 0; i < 5; i += 1) {
      expect(evaluate(weatherCall(limits, i, spent, false))).toEqual({ decision: "allow", reasons: [] });
      spent += 1_500n;
    }
  });

  it("ENV-3, ENV-5: runaway: 30 allows, then VELOCITY_EXCEEDED, then AGENT_FROZEN with VELOCITY_EXCEEDED", () => {
    const limits: Limits = { windowCapsMicros: { minute: m(500_000n) }, callsPerMinute: 30 };
    let spent = 0n;
    let frozen = false;
    const seen: string[][] = [];
    for (let call = 0; call < 36; call += 1) {
      const d = evaluate(weatherCall(limits, call, spent, frozen));
      seen.push([d.decision, ...codes(d)]);
      if (d.decision === "allow") spent += 1_500n;
      if (codes(d).includes("VELOCITY_EXCEEDED")) frozen = true; // the server's job (PXY-10)
    }
    expect(seen).toEqual([
      ...Array.from({ length: 30 }, () => ["allow"]),
      ["deny", "VELOCITY_EXCEEDED"],
      ...Array.from({ length: 5 }, () => ["deny", "AGENT_FROZEN", "VELOCITY_EXCEEDED"]),
    ]);
  });

  it("ENV-8: injection: a $480 refund under a $100 threshold and a $1,000 tool max gets only NEEDS_APPROVAL from the envelope", () => {
    const input = withLimits({ agent: { approvalThresholdMicros: usd(100n) } });
    input.request.kind = "tool";
    input.request.tool = "stripe.refund";
    input.envelope.toolLimits = { "stripe.refund": { txMaxMicros: usd(1_000n) } };
    input.request.amountMicros = usd(480n);
    expect(codes(evaluate(input))).toEqual(["NEEDS_APPROVAL"]);
  });
});

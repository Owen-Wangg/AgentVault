import { describe, expect, it } from "vitest";
import { MAX_MICROS, micros } from "@/core/money";
import { baseInput, usd, withLimits } from "@/core/testing/policy-fixtures";
import { allowListRule, approvalThresholdRule, frozenRule, txMaxRule, velocityReasons, velocityRule, windowCapRule } from "./rules";
import type { EvaluateInput } from "./types";

const m = micros;
const codes = (reasons: readonly { code: string }[]) => reasons.map((r) => r.code);
const withAmount = (input: EvaluateInput, amount: bigint): EvaluateInput => {
  input.request.amountMicros = m(amount);
  return input;
};

const ALL_RULES = [frozenRule, txMaxRule, windowCapRule, velocityRule, allowListRule, approvalThresholdRule];

describe("ENV-1: per-transaction maximum", () => {
  it("ENV-1: denies an amount above the maximum", () => {
    const input = withAmount(withLimits({ agent: { txMaxMicros: usd(1n) } }), 1_000_001n);
    expect(txMaxRule(input)).toEqual([{ code: "OVER_TX_MAX", detail: { level: "agent", limitMicros: "1000000" } }]);
  });

  it("ENV-1: allows an amount exactly at the maximum", () => {
    expect(txMaxRule(withAmount(withLimits({ agent: { txMaxMicros: usd(1n) } }), 1_000_000n))).toEqual([]);
  });

  it("ENV-1: a maximum of zero allows only zero", () => {
    const input = withLimits({ agent: { txMaxMicros: m(0n) } });
    expect(txMaxRule(withAmount(input, 0n))).toEqual([]);
    expect(codes(txMaxRule(withAmount(input, 1n)))).toEqual(["OVER_TX_MAX"]);
  });
});

describe("ENV-2: trailing window caps", () => {
  it("ENV-2: denies when amount plus minute spend exceeds the minute cap, naming the window", () => {
    const input = withAmount(withLimits({ agent: { windowCapsMicros: { minute: m(500_000n) } } }), 1_500n);
    input.window.spentMicros.minute = m(499_000n);
    expect(windowCapRule(input)).toEqual([{ code: "OVER_WINDOW_CAP", detail: { window: "minute", level: "agent" } }]);
  });

  it("ENV-2: allows spend that lands exactly on the cap", () => {
    const input = withAmount(withLimits({ agent: { windowCapsMicros: { hour: m(500_000n) } } }), 1_500n);
    input.window.spentMicros.hour = m(498_500n);
    expect(windowCapRule(input)).toEqual([]);
  });

  it("ENV-2: returns one reason per window that is over", () => {
    const caps = { minute: usd(1n), hour: usd(5n), day: usd(10n) };
    const input = withAmount(withLimits({ agent: { windowCapsMicros: caps } }), 2_000_000n);
    input.window.spentMicros = { minute: m(0n), hour: usd(4n), day: usd(9n) };
    expect(windowCapRule(input).map((r) => r.detail?.window)).toEqual(["minute", "hour", "day"]);
  });

  it("ENV-2: does not overflow when spend is near MAX_MICROS", () => {
    const input = withAmount(withLimits({ agent: { windowCapsMicros: { day: MAX_MICROS } } }), MAX_MICROS);
    input.window.spentMicros.day = MAX_MICROS;
    expect(codes(windowCapRule(input))).toEqual(["OVER_WINDOW_CAP"]);
  });

  it("ENV-2: spend already over the cap denies even a zero amount", () => {
    const input = withAmount(withLimits({ agent: { windowCapsMicros: { minute: m(10n) } } }), 0n);
    input.window.spentMicros.minute = m(11n);
    expect(codes(windowCapRule(input))).toEqual(["OVER_WINDOW_CAP"]);
  });
});

describe("ENV-3: calls per minute", () => {
  it("ENV-3: the call that brings the count above the limit is denied", () => {
    const input = withLimits({ agent: { callsPerMinute: 30 } });
    input.window.callsLastMinute = 30;
    expect(velocityRule(input)).toEqual([{ code: "VELOCITY_EXCEEDED", detail: { level: "agent", limit: "30" } }]);
  });

  it("ENV-3: the call that reaches the limit exactly is allowed (callsLastMinute excludes this request)", () => {
    const input = withLimits({ agent: { callsPerMinute: 30 } });
    input.window.callsLastMinute = 29;
    expect(velocityRule(input)).toEqual([]);
  });

  it("ENV-3: a limit of zero denies every call", () => {
    expect(codes(velocityRule(withLimits({ agent: { callsPerMinute: 0 } })))).toEqual(["VELOCITY_EXCEEDED"]);
  });

  it("ENV-3: velocityReasons gives the same result as the rule, for requests refused before evaluation", () => {
    for (const calls of [0, 29, 30, 31]) {
      const input = withLimits({ agent: { callsPerMinute: 30 } });
      input.window.callsLastMinute = calls;
      expect(velocityReasons({ request: input.request, envelope: input.envelope, callsLastMinute: calls })).toEqual(velocityRule(input));
    }
  });
});

describe("ENV-5: frozen agents", () => {
  it("ENV-5: denies every request from a frozen agent", () => {
    const input = baseInput();
    input.session.agentFrozen = true;
    expect(frozenRule(input)).toEqual([{ code: "AGENT_FROZEN" }]);
  });

  it("ENV-5: does nothing for an agent that is not frozen", () => {
    expect(frozenRule(baseInput())).toEqual([]);
  });
});

describe("ENV-6: vendor allow-list", () => {
  it("ENV-6: denies a vendor that is not on the list", () => {
    const input = baseInput();
    input.envelope.allowedVendors = ["gpu-cloud"];
    expect(allowListRule(input)).toEqual([{ code: "VENDOR_NOT_ALLOWED", detail: { vendor: "nimbus-weather" } }]);
  });

  it("ENV-6: allows a listed vendor, and any vendor under *", () => {
    const input = baseInput();
    input.envelope.allowedVendors = ["nimbus-weather"];
    expect(allowListRule(input)).toEqual([]);
    input.envelope.allowedVendors = "*";
    expect(allowListRule(input)).toEqual([]);
  });

  it("ENV-6: an empty list allows no vendor, and [\"*\"] is a literal name, not a wildcard", () => {
    const input = baseInput();
    input.envelope.allowedVendors = [];
    expect(codes(allowListRule(input))).toEqual(["VENDOR_NOT_ALLOWED"]);
    input.envelope.allowedVendors = ["*"];
    expect(codes(allowListRule(input))).toEqual(["VENDOR_NOT_ALLOWED"]);
  });
});

describe("ENV-7: tool allow-list", () => {
  it("ENV-7: denies a tool that is not on the list", () => {
    const input = baseInput();
    input.envelope.allowedTools = ["x402.pay"];
    input.request.tool = "stripe.refund";
    expect(allowListRule(input)).toEqual([{ code: "TOOL_NOT_ALLOWED", detail: { tool: "stripe.refund" } }]);
  });

  it("ENV-6, ENV-7: reports both the vendor and the tool when neither is allowed", () => {
    const input = baseInput();
    input.envelope.allowedVendors = [];
    input.envelope.allowedTools = [];
    expect(codes(allowListRule(input))).toEqual(["VENDOR_NOT_ALLOWED", "TOOL_NOT_ALLOWED"]);
  });
});

describe("ENV-8: approval threshold", () => {
  it("ENV-8: holds an amount at the threshold", () => {
    const input = withAmount(withLimits({ agent: { approvalThresholdMicros: usd(100n) } }), 100_000_000n);
    expect(approvalThresholdRule(input)).toEqual([
      { code: "NEEDS_APPROVAL", detail: { level: "agent", thresholdMicros: "100000000" } },
    ]);
  });

  it("ENV-8: does not hold an amount just below the threshold", () => {
    expect(approvalThresholdRule(withAmount(withLimits({ agent: { approvalThresholdMicros: usd(100n) } }), 99_999_999n))).toEqual([]);
  });
});

describe("ENV-9: vendor- and tool-level limits", () => {
  it("ENV-9: a stricter tool-level tx max wins over the agent level", () => {
    const input = withAmount(withLimits({ agent: { txMaxMicros: usd(1_000n) }, tool: { txMaxMicros: usd(10n) } }), 11_000_000n);
    expect(txMaxRule(input)).toEqual([{ code: "OVER_TX_MAX", detail: { level: "tool", limitMicros: "10000000" } }]);
  });

  it("ENV-9: a looser vendor-level tx max does not relax the agent level", () => {
    const input = withAmount(withLimits({ agent: { txMaxMicros: usd(1n) }, vendor: { txMaxMicros: usd(1_000n) } }), 2_000_000n);
    expect(txMaxRule(input)).toEqual([{ code: "OVER_TX_MAX", detail: { level: "agent", limitMicros: "1000000" } }]);
  });

  it("ENV-9: a vendor-level window cap is checked against spend with that vendor", () => {
    const input = withAmount(withLimits({ agent: { windowCapsMicros: { day: usd(100n) } }, vendor: { windowCapsMicros: { day: usd(5n) } } }), 1_000_000n);
    input.window.spentMicros.day = usd(50n);
    input.window.vendorSpentMicros.day = m(4_500_000n);
    expect(windowCapRule(input)).toEqual([{ code: "OVER_WINDOW_CAP", detail: { window: "day", level: "vendor" } }]);
  });

  it("ENV-9: names every level that is over in a window", () => {
    const caps = { windowCapsMicros: { minute: usd(1n) } };
    const input = withAmount(withLimits({ agent: caps, vendor: caps, tool: caps }), 1_000_000n);
    input.window.spentMicros.minute = m(1n);
    input.window.toolSpentMicros.minute = m(1n);
    expect(windowCapRule(input)).toEqual([{ code: "OVER_WINDOW_CAP", detail: { window: "minute", level: "agent,tool" } }]);
  });

  it("ENV-9: a stricter vendor-level calls-per-minute limit wins", () => {
    const input = withLimits({ agent: { callsPerMinute: 30 }, vendor: { callsPerMinute: 5 } });
    input.window.callsLastMinute = 5;
    expect(velocityRule(input)).toEqual([{ code: "VELOCITY_EXCEEDED", detail: { level: "vendor", limit: "5" } }]);
  });

  it("ENV-9: a stricter tool-level approval threshold wins", () => {
    const input = withAmount(withLimits({ agent: { approvalThresholdMicros: usd(100n) }, tool: { approvalThresholdMicros: usd(1n) } }), 1_000_000n);
    expect(codes(approvalThresholdRule(input))).toEqual(["NEEDS_APPROVAL"]);
  });

  it("ENV-9: limits for other vendors and tools don't apply", () => {
    const input = withAmount(baseInput(), 2_000_000n);
    input.envelope.vendorLimits = { "gpu-cloud": { txMaxMicros: usd(1n) } };
    input.envelope.toolLimits = { "stripe.refund": { txMaxMicros: usd(1n) } };
    expect(txMaxRule(input)).toEqual([]);
  });

  it("ENV-9: a vendor named like an Object.prototype member gets only its own limits", () => {
    const input = withAmount(baseInput(), 2_000_000n);
    input.request.vendor = "constructor";
    expect(txMaxRule(input)).toEqual([]);
    input.envelope.vendorLimits = Object.fromEntries([["__proto__", { txMaxMicros: usd(1n) }]]);
    input.request.vendor = "__proto__";
    expect(codes(txMaxRule(input))).toEqual(["OVER_TX_MAX"]);
  });
});

describe("ENV-10: a request that passes every rule", () => {
  it("ENV-10: no rule returns a reason for the base input", () => {
    const input = withLimits({
      agent: { txMaxMicros: usd(1n), windowCapsMicros: { minute: m(500_000n) }, callsPerMinute: 30, approvalThresholdMicros: usd(100n) },
    });
    for (const rule of ALL_RULES) expect(rule(input)).toEqual([]);
  });
});

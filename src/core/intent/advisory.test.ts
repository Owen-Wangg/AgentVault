import { describe, expect, it } from "vitest";
import { evaluate } from "@/core/policy/evaluate";
import { REFUND_TOOL, baseInput, usd, withTool } from "@/core/testing/policy-fixtures";
import { ADVISORY_DRIFT_THRESHOLD, advisoryRule } from "./advisory";

const codes = (d: { reasons: readonly { code: string }[] }) => d.reasons.map((r) => r.code);

describe("advisoryRule", () => {
  it("INT-8: the default threshold is 70", () => {
    expect(ADVISORY_DRIFT_THRESHOLD).toBe(70);
  });

  it("INT-7: no score adds nothing", () => {
    expect(advisoryRule(undefined, 70)).toEqual([]);
  });

  it.each([0, 1, 42, 69])("INT-8: a score of %s, below the threshold, adds nothing", (score) => {
    expect(advisoryRule(score, 70)).toEqual([]);
  });

  it.each([70, 71, 100])("INT-8: a score of %s, at or above the threshold, holds with ADVISORY_DRIFT", (score) => {
    expect(advisoryRule(score, 70)).toEqual([{ code: "ADVISORY_DRIFT", detail: { score: String(score), threshold: "70" } }]);
  });

  it.each([Number.NaN, -1, 101, 69.5, Number.POSITIVE_INFINITY])("INT-7: a score of %s outside 0 to 100 holds (fails closed)", (score) => {
    expect(codes({ reasons: advisoryRule(score, 70) })).toEqual(["ADVISORY_DRIFT"]);
  });

  it.each([Number.NaN, 101, -1])("INT-8: a broken threshold of %s holds any score (fails closed)", (threshold) => {
    expect(codes({ reasons: advisoryRule(0, threshold) })).toEqual(["ADVISORY_DRIFT"]);
  });
});

describe("evaluate() with an advisory score", () => {
  it("INT-8: a score at the threshold turns an allow into a hold", () => {
    expect(evaluate(baseInput()).decision).toBe("allow");
    const d = evaluate({ ...baseInput(), advisoryDriftScore: 70 });
    expect(d.decision).toBe("hold");
    expect(codes(d)).toEqual(["ADVISORY_DRIFT"]);
  });

  it("INT-8: a score below the threshold leaves an allow alone", () => {
    expect(evaluate({ ...baseInput(), advisoryDriftScore: 69 })).toEqual({ decision: "allow", reasons: [] });
  });

  it("INT-9: a low score doesn't remove a deny", () => {
    const input = { ...baseInput(), advisoryDriftScore: 0 };
    input.request.vendorCategory = "compute";
    const d = evaluate(input);
    expect(d.decision).toBe("deny");
    expect(codes(d)).toEqual(["DENY_INTENT_DRIFT"]);
  });

  it("INT-9: a low score doesn't remove a taint hold", () => {
    const input = withTool({ ...baseInput(), advisoryDriftScore: 0 }, REFUND_TOOL);
    input.scope.allowedTools = ["stripe.refund"];
    input.session.taintedAt = "2026-12-01T00:00:00.000Z";
    input.session.taintSourceUrl = "https://vendor.example/docs";
    const d = evaluate(input);
    expect(d.decision).toBe("hold");
    expect(codes(d)).toEqual(["HELD_TAINTED"]);
  });

  it("INT-9: a high score on a denied request adds its hold reason, and the decision stays deny", () => {
    const input = { ...baseInput(), advisoryDriftScore: 95 };
    input.request.vendorCategory = "compute";
    const d = evaluate(input);
    expect(d.decision).toBe("deny");
    expect(codes(d)).toEqual(["DENY_INTENT_DRIFT", "ADVISORY_DRIFT"]);
  });

  it("INT-8: ADVISORY_DRIFT comes before NEEDS_APPROVAL, and both hold", () => {
    const input = { ...baseInput(), advisoryDriftScore: 80 };
    input.envelope.limits = { approvalThresholdMicros: usd(0n) };
    expect(codes(evaluate(input))).toEqual(["ADVISORY_DRIFT", "NEEDS_APPROVAL"]);
  });

  it("HITL-2: an approval for ADVISORY_DRIFT lets the re-run with the same score through", () => {
    const d = evaluate({ ...baseInput(), advisoryDriftScore: 90, approvedHoldReasons: ["ADVISORY_DRIFT"] });
    expect(d).toEqual({ decision: "allow", reasons: [] });
  });

  it.each([101, -1, 50.5, Number.NaN])("INT-7: evaluate() denies a score of %s with INVALID_REQUEST", (score) => {
    const d = evaluate({ ...baseInput(), advisoryDriftScore: score });
    expect(d.decision).toBe("deny");
    expect(d.reasons).toEqual([{ code: "INVALID_REQUEST", detail: { path: "advisoryDriftScore" } }]);
  });
});

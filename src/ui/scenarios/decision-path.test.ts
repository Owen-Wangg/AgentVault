import { describe, expect, it } from "vitest";
import { decisionPath } from "./decision-path";

const path = (decision: "allow" | "hold" | "deny", ...codes: string[]) => {
  const view = decisionPath({ decision, reasons: codes.map((code) => ({ code })) });
  return { ...Object.fromEntries(view.checks.map((c) => [c.check, c.state])), rail: view.railReached };
};

describe("decisionPath", () => {
  it("AGT-17: each demo scenario's decision lands on the check that fired", () => {
    expect(path("allow")).toEqual({ agent: "passed", limits: "passed", scope: "passed", taint: "passed", rail: true });
    // Runaway loop: the 31st call, then a frozen agent's call.
    expect(path("deny", "VELOCITY_EXCEEDED")).toMatchObject({ agent: "passed", limits: "denied", rail: false });
    expect(path("deny", "AGENT_FROZEN", "VELOCITY_EXCEEDED")).toMatchObject({ agent: "denied", limits: "denied" });
    // Prompt injection and Payee hijack: the refund or payout.
    expect(path("hold", "HELD_TAINTED", "NEEDS_APPROVAL")).toEqual({ agent: "passed", limits: "held", scope: "passed", taint: "held", rail: false });
    // Intent drift, with the live agent's advisory score.
    expect(path("deny", "DENY_INTENT_DRIFT", "ADVISORY_DRIFT")).toMatchObject({ scope: "denied", taint: "passed" });
  });

  it("AGT-17: a request refused before the checks ran marks the later checks not checked", () => {
    expect(path("deny", "INVALID_REQUEST")).toEqual({ agent: "denied", limits: "not_checked", scope: "not_checked", taint: "not_checked", rail: false });
    expect(path("deny", "AGENT_FROZEN", "INVALID_REQUEST", "VELOCITY_EXCEEDED")).toMatchObject({ limits: "denied", scope: "not_checked" });
  });

  it("AGT-17: an unknown code on a deny shows on the agent check, and an allow ignores it", () => {
    expect(path("deny", "SOMETHING_NEW")).toMatchObject({ agent: "denied", limits: "passed" });
    expect(path("hold", "__proto__")).toMatchObject({ agent: "held" });
    expect(path("allow", "SOMETHING_NEW")).toMatchObject({ agent: "passed", rail: true });
  });
});

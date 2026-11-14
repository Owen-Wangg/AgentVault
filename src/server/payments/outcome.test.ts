import { describe, expect, it } from "vitest";
import { micros } from "@/core/money";
import { classifyRailResult } from "./outcome";

describe("RES-3, RES-4, RES-5: classifyRailResult", () => {
  it("RES-3: a confirmed payment is settled", () => {
    expect(classifyRailResult({ ok: true, ref: "mock_tx_1", settledMicros: micros(1n) })).toBe("settled");
  });

  it.each(["BELOW_RAIL_MINIMUM", "CHALLENGE_MISMATCH", "RAIL_REJECTED"] as const)("RES-4: %s is a confirmed failure", (code) => {
    expect(classifyRailResult({ ok: false, code })).toBe("failed");
  });

  it.each(["RAIL_TIMEOUT", "INVALID_RAIL_RESPONSE"] as const)("RES-5: %s is unknown", (code) => {
    expect(classifyRailResult({ ok: false, code })).toBe("unknown");
  });

  it("RES-5: an exception thrown by the adapter is unknown", () => {
    expect(classifyRailResult({ thrown: true })).toBe("unknown");
  });

  it("RES-4: an unrecognized failure code is unknown, never a release", () => {
    expect(classifyRailResult({ ok: false, code: "SOMETHING_NEW" as never })).toBe("unknown");
  });
});

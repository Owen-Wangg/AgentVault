import { describe, expect, it } from "vitest";
import { DENY_REASONS, HOLD_REASONS, REASON_CODES, isDenyReason, isHoldReason } from "./reasons";

describe("ENV-12: reason code classes", () => {
  it("ENV-12: every code is exactly one of deny or hold", () => {
    for (const code of REASON_CODES) expect(isDenyReason(code) !== isHoldReason(code)).toBe(true);
    expect(REASON_CODES).toHaveLength(DENY_REASONS.length + HOLD_REASONS.length);
  });

  it("ENV-12: codes are SCREAMING_SNAKE_CASE and unique", () => {
    for (const code of REASON_CODES) expect(code).toMatch(/^[A-Z]+(?:_[A-Z]+)*$/);
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });
});

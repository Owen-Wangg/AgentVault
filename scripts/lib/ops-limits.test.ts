import { describe, expect, it } from "vitest";
import {
  JUDGING_ENDS_MS,
  NEON_FREE_STORAGE_BYTES,
  daysUntilJudgingEnds,
  formatMb,
  overStorageWarning,
  projectedBytes,
} from "./ops-limits";

describe("ops:check limits", () => {
  it("formats bytes as mebibytes with one decimal, rounding down", () => {
    expect(formatMb(0n)).toBe("0.0 MB");
    expect(formatMb(1_048_576n)).toBe("1.0 MB");
    expect(formatMb(1_572_863n)).toBe("1.4 MB");
    expect(formatMb(NEON_FREE_STORAGE_BYTES)).toBe("1024.0 MB");
  });

  it("counts days left to the end of judging, rounding up, and never below 0", () => {
    expect(daysUntilJudgingEnds(JUDGING_ENDS_MS)).toBe(0n);
    expect(daysUntilJudgingEnds(JUDGING_ENDS_MS + 1)).toBe(0n);
    expect(daysUntilJudgingEnds(JUDGING_ENDS_MS - 1)).toBe(1n);
    expect(daysUntilJudgingEnds(Date.UTC(2026, 10, 17, 1, 0, 0))).toBe(74n);
  });

  it("projects growth from the recent audit rows at their average size", () => {
    // 1,000 rows in 1,000,000 bytes is 1,000 bytes a row; 700 rows in 7 days is 100 a day; 10 days adds 1,000,000.
    expect(projectedBytes({ sizeBytes: 5_000_000n, auditBytes: 1_000_000n, auditRows: 1_000n, recentRows: 700n, recentDays: 7n, daysLeft: 10n })).toBe(6_000_000n);
    expect(projectedBytes({ sizeBytes: 5_000_000n, auditBytes: 0n, auditRows: 0n, recentRows: 0n, recentDays: 7n, daysLeft: 10n })).toBe(5_000_000n);
  });

  it("warns at 80% of the Free storage limit, not below", () => {
    // 80% of 1 GiB isn't a whole number of bytes, so the first byte count at or above it rounds up.
    const at80 = (NEON_FREE_STORAGE_BYTES * 80n + 99n) / 100n;
    expect(overStorageWarning(at80)).toBe(true);
    expect(overStorageWarning(at80 - 1n)).toBe(false);
  });
});

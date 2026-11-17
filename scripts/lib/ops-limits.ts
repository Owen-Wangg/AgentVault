/**
 * The thresholds `pnpm ops:check` warns at, and the arithmetic behind
 * them. Everything is integer (bytes as bigint, times as epoch ms), so
 * nothing here can round. Kept apart from the script so it's testable
 * without a database.
 */

/** Neon Free: 1 GB of Postgres storage per project (neon.com/docs/introduction/plans, read 2026-11-16). */
export const NEON_FREE_STORAGE_BYTES = 1_073_741_824n;
/** Warn when the database passes this share of the Free storage limit, in percent. */
export const STORAGE_WARN_PERCENT = 80n;
/** The live app must stay up until the Judging Period ends: Jan 29, 2027, 1:00 PM PT (21:00 UTC). */
export const JUDGING_ENDS_MS = Date.UTC(2027, 0, 29, 21, 0, 0);
/**
 * The nightly reset runs once a day somewhere in the 11:00 UTC hour (Hobby
 * cron precision is ±59 minutes), so two resets can be up to 25 hours
 * apart. Older than 26 hours means at least one was missed.
 */
export const RESET_MAX_AGE_MS = 26 * 3_600_000;
/**
 * Idempotency rows are kept 24 hours, and the daily reconciler deletes
 * older ones, so the oldest row should be under about 49 hours. Older
 * than 72 hours means the cleanup isn't running.
 */
export const IDEMPOTENCY_MAX_AGE_MS = 72 * 3_600_000;

const DAY_MS = 86_400_000;

/** Bytes as mebibytes with one decimal place, e.g. "12.3 MB". */
export function formatMb(bytes: bigint): string {
  const tenths = (bytes * 10n) / 1_048_576n;
  return `${tenths / 10n}.${tenths % 10n} MB`;
}

/** Whole days from `nowMs` until judging ends, at least 0. */
export function daysUntilJudgingEnds(nowMs: number): bigint {
  const left = JUDGING_ENDS_MS - nowMs;
  return left <= 0 ? 0n : BigInt(Math.ceil(left / DAY_MS));
}

/**
 * The database size at the end of judging if it keeps growing as audit
 * rows did over the sampled days. An estimate: it counts only audit rows
 * at their current average size.
 */
export function projectedBytes(input: {
  sizeBytes: bigint;
  auditBytes: bigint;
  auditRows: bigint;
  recentRows: bigint;
  recentDays: bigint;
  daysLeft: bigint;
}): bigint {
  if (input.auditRows === 0n || input.recentDays === 0n) return input.sizeBytes;
  const bytesPerRow = input.auditBytes / input.auditRows;
  return input.sizeBytes + (input.recentRows * bytesPerRow * input.daysLeft) / input.recentDays;
}

/** True when `bytes` is at or above the warning share of the Free storage limit. */
export function overStorageWarning(bytes: bigint): boolean {
  return bytes * 100n >= NEON_FREE_STORAGE_BYTES * STORAGE_WARN_PERCENT;
}

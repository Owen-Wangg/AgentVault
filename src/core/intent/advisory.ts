import { z } from "zod";
import type { ReasonDetail } from "@/core/policy/types";

/**
 * The advisory drift score (taint-and-intent INT-7 to INT-9). An LLM rates
 * from 0 to 100 how far a request is from its task; a score at or above
 * the threshold holds the request for a person (ADVISORY_DRIFT). The score
 * is advisory only (security-standards §2): it can add this one hold
 * reason and never removes any reason, so it can't turn a deny or a hold
 * into an allow.
 *
 * The score is a rating, not money, so `number` is fine.
 */

/** INT-8's default. A constant for now, not a per-workspace setting, so it needs no migration. */
export const ADVISORY_DRIFT_THRESHOLD = 70;

/** The score's range (INT-7). */
export const ADVISORY_SCORE_MIN = 0;
export const ADVISORY_SCORE_MAX = 100;

const inRange = (n: number): boolean => Number.isInteger(n) && n >= ADVISORY_SCORE_MIN && n <= ADVISORY_SCORE_MAX;

/**
 * INT-7: a valid score, an integer from 0 to 100. The one schema every
 * boundary uses: the evaluate() input, the pay and tool routes, a stored
 * approval, and the scorer's reply.
 */
export const AdvisoryScoreSchema = z.number().int().min(ADVISORY_SCORE_MIN).max(ADVISORY_SCORE_MAX);

/**
 * INT-8: ADVISORY_DRIFT when `score` is at or above `threshold`. No score
 * adds nothing. A score or threshold outside 0 to 100 (or not an integer,
 * such as NaN) also holds, so a bad value fails closed; evaluate()'s
 * schema rejects such a score before this runs anyway.
 */
export function advisoryRule(score: number | undefined, threshold: number): ReasonDetail[] {
  if (score === undefined) return [];
  if (inRange(score) && inRange(threshold) && score < threshold) return [];
  return [{ code: "ADVISORY_DRIFT", detail: { score: String(score), threshold: String(threshold) } }];
}

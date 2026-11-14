import { CONFIRMED_FAILURE_CODES, type RailResult } from "@/rails/types";

/**
 * What a rail outcome means for the reservation (audit-and-approvals
 * design, "Reservations and rail outcomes"):
 * - settled: the rail confirmed the payment. Settle the reservation (RES-3).
 * - failed: proof that no money moved. Release the reservation (RES-4).
 * - unknown: anything else, including a timeout, an unreadable response,
 *   or an exception after the request was sent. Keep the reservation
 *   counted until the reconciler resolves it (RES-5).
 * Anything not recognized is unknown, so a new code can never release money.
 */
export type RailOutcome = "settled" | "failed" | "unknown";

const CONFIRMED: ReadonlySet<string> = new Set(CONFIRMED_FAILURE_CODES);

export function classifyRailResult(result: RailResult | { thrown: true }): RailOutcome {
  if ("thrown" in result) return "unknown";
  if (result.ok === true) return "settled";
  return CONFIRMED.has(result.code) ? "failed" : "unknown";
}

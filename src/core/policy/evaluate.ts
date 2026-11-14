import { intentRules } from "@/core/intent/rules";
import { taintRules } from "@/core/taint/rules";
import { type HoldReason, isDenyReason, isHoldReason } from "./reasons";
import { allowListRule, approvalThresholdRule, frozenRule, txMaxRule, velocityRule, windowCapRule } from "./rules";
import { EvaluateInputSchema } from "./schemas";
import type { Decision, EvaluateInput, ReasonDetail, Rule } from "./types";

/** INT-2 to INT-6. The category on the request is the registry's, set by the server (INT-5). */
export const intentRule: Rule = (input) => intentRules(input, input.scope, input.request.vendorCategory);
/** TAINT-6, TAINT-7. */
export const taintRule: Rule = (input) => taintRules(input, input.tool);

/** Rules that run on every valid request, in the order their reasons are reported. */
const RULES: readonly Rule[] = [
  frozenRule, // ENV-5
  txMaxRule, // ENV-1, ENV-9
  windowCapRule, // ENV-2, ENV-9
  velocityRule, // ENV-3
  allowListRule, // ENV-6, ENV-7
  intentRule, // INT-2, INT-3, INT-4, INT-6
  taintRule, // TAINT-6
];

/**
 * Apply precedence (ENV-12): any reason that is not a hold reason denies,
 * including a code this version doesn't know, so the result fails closed.
 * Otherwise any hold reason holds. Allow carries no reasons (ENV-10).
 */
export function combine(reasons: readonly ReasonDetail[]): Decision {
  if (reasons.some((r) => !isHoldReason(r.code))) return { decision: "deny", reasons: [...reasons] };
  if (reasons.length > 0) return { decision: "hold", reasons: [...reasons] };
  return { decision: "allow", reasons: [] };
}

/**
 * HITL-2: drop the hold reasons a human approved, matched by code. A deny
 * reason is never dropped, whatever the list says (HITL-3, TAINT-9), so an
 * approved request runs only if every other rule still passes. A hold
 * reason that wasn't approved stays, so the re-run fails its recheck.
 */
export function withoutApproved(reasons: readonly ReasonDetail[], approved: readonly HoldReason[] | undefined): ReasonDetail[] {
  if (!approved || approved.length === 0) return [...reasons];
  const set: ReadonlySet<string> = new Set(approved);
  return reasons.filter((r) => !(isHoldReason(r.code) && set.has(r.code)));
}

function invalid(path?: readonly PropertyKey[]): Decision {
  const detail = path && path.length > 0 ? { detail: { path: path.map(String).join(".") } } : {};
  return { decision: "deny", reasons: [{ code: "INVALID_REQUEST", ...detail }] };
}

/**
 * Decide a pay or tool request. Pure and deterministic (ENV-13): the server
 * loads all state and passes it in. Returns every applicable reason
 * (ENV-11). Never throws: input that fails the schema, or any unexpected
 * error, is a deny with INVALID_REQUEST (ENV-15).
 *
 * ENV-4: VELOCITY_EXCEEDED is only reported here. The server freezes the
 * agent in the same transaction when it sees the code (PXY-10).
 */
export function evaluate(input: EvaluateInput): Decision {
  try {
    const parsed = EvaluateInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues[0]?.path);
    // Run on the parsed copy, so a caller can't change the input after it was checked.
    const checked = parsed.data as EvaluateInput;
    const reasons = RULES.flatMap((rule) => rule(checked));
    // ENV-8: the approval threshold applies only to requests that pass every deny rule.
    if (!reasons.some((r) => isDenyReason(r.code))) reasons.push(...approvalThresholdRule(checked));
    return combine(withoutApproved(reasons, checked.approvedHoldReasons));
  } catch {
    return invalid();
  }
}

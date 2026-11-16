import type { EvaluateInput, ReasonDetail } from "@/core/policy/types";
import type { ToolDef } from "./types";

/**
 * Tools that can move money out or change payees (security-standards §3).
 * They count as high-privilege even if a registry entry forgets the flag,
 * so a mislabeled tool can only be held more, never less.
 */
export const HIGH_PRIVILEGE_TOOLS: readonly string[] = ["stripe.refund", "wire_transfer", "payout.create", "payee.update", "paypal.payout"];

export function isHighPrivilege(tool: ToolDef): boolean {
  return tool.privileged || HIGH_PRIVILEGE_TOOLS.includes(tool.name);
}

/**
 * TAINT-6, TAINT-7: a high-privilege tool in a tainted session is held
 * with HELD_TAINTED, and the reason names the taint source so the
 * approval shows it. In an untainted session this adds nothing, and the
 * envelope rules apply as usual.
 */
export function taintRules(input: EvaluateInput, tool: ToolDef): ReasonDetail[] {
  const { taintedAt, taintSourceUrl } = input.session;
  if (taintedAt === null || !isHighPrivilege(tool)) return [];
  return [{ code: "HELD_TAINTED", detail: { tool: tool.name, sourceUrl: taintSourceUrl ?? "unknown", taintedAt } }];
}

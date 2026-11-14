import { cmp, sub, toMicrosString } from "@/core/money";
import type { EvaluateInput, ReasonDetail } from "@/core/policy/types";
import type { TaskScope } from "./types";

/**
 * The category the server uses for a vendor that isn't in the workspace
 * registry (INT-6). No task allows it, even one that lists it.
 */
export const UNKNOWN_CATEGORY = "unknown";

/**
 * Intent scope (INT-2, INT-3, INT-4). `vendorCategory` comes from the
 * workspace vendor registry, never from the agent (INT-5). Returns one
 * reason per check that fails:
 * - DENY_INTENT_DRIFT for a vendor category outside the task's categories,
 *   with the expected and actual categories (INT-2, INT-6)
 * - DENY_INTENT_DRIFT for a tool outside the task's tools (INT-3)
 * - OVER_TASK_BUDGET if the session's spend plus this amount is above the
 *   task budget (INT-4)
 */
export function intentRules(input: EvaluateInput, scope: TaskScope, vendorCategory: string): ReasonDetail[] {
  const { request, session } = input;
  const reasons: ReasonDetail[] = [];

  const categories = scope.allowedVendorCategories.filter((c) => c !== UNKNOWN_CATEGORY);
  if (!categories.includes(vendorCategory)) {
    reasons.push({ code: "DENY_INTENT_DRIFT", detail: { check: "vendor_category", expected: categories.join(","), actual: vendorCategory } });
  }

  if (!scope.allowedTools.includes(request.tool)) {
    reasons.push({ code: "DENY_INTENT_DRIFT", detail: { check: "tool", expected: scope.allowedTools.join(","), actual: request.tool } });
  }

  // spent + amount > budget, computed without leaving the Micros range.
  const spent = session.sessionSpentMicros;
  if (cmp(spent, scope.budgetMicros) > 0 || cmp(request.amountMicros, sub(scope.budgetMicros, spent)) > 0) {
    reasons.push({
      code: "OVER_TASK_BUDGET",
      detail: { budgetMicros: toMicrosString(scope.budgetMicros), spentMicros: toMicrosString(spent) },
    });
  }
  return reasons;
}

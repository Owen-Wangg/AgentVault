import type { Micros } from "@/core/money";

/** What the session's task may buy (taint-and-intent design, INT-1). Read by `intentRules`. */
export interface TaskScope {
  taskId: string;
  allowedVendorCategories: readonly string[];
  allowedTools: readonly string[];
  budgetMicros: Micros;
}

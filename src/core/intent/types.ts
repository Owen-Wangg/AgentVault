import type { Micros } from "@/core/money";

/**
 * What the session's task may buy (taint-and-intent design, INT-1). The
 * intent rules that read it arrive in taint-and-intent task 2.
 */
export interface TaskScope {
  taskId: string;
  allowedVendorCategories: readonly string[];
  allowedTools: readonly string[];
  budgetMicros: Micros;
}

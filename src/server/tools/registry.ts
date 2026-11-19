import type { Direction } from "@/core/money";
import type { ToolDef as PolicyToolDef } from "@/core/taint";

/**
 * The built-in tool registry (taint-and-intent design). The pay flow uses
 * a tool's registered rail to count its amount (chargeableMicros) and to
 * pick its adapter, even when the sandbox runs it on the mock adapter, so
 * sandbox amounts match real ones. The /api/v1/tool route arrives in
 * taint-and-intent task 5.
 */
export interface ToolDef extends PolicyToolDef {
  /** debit: the agent spends. credit: the agent refunds or pays out (money-arithmetic). */
  direction: Direction;
  /**
   * Which rail method an allowed request calls (payout-rails design, "Tool
   * registry"), so the flow never infers it from the direction: refunds and
   * payouts are both credits. `payee` moves no money.
   */
  operation: "pay" | "refund" | "payout" | "payee";
}

/** The fields `evaluate()` takes. Its schema is strict, so `direction` must not be passed. */
export function policyTool(tool: ToolDef): PolicyToolDef {
  return { name: tool.name, privileged: tool.privileged, rail: tool.rail };
}

const TOOLS: readonly ToolDef[] = [
  { name: "x402.pay", privileged: false, rail: "x402", direction: "debit", operation: "pay" },
  { name: "mpp.pay", privileged: false, rail: "stripe", direction: "debit", operation: "pay" },
  { name: "stripe.refund", privileged: true, rail: "stripe", direction: "credit", operation: "refund" },
  { name: "wire_transfer", privileged: true, rail: "mock", direction: "debit", operation: "pay" },
  // payout-rails PO-2, PO-3: money the platform sends, so a credit, on Stripe Connect.
  { name: "payout.create", privileged: true, rail: "stripe", direction: "credit", operation: "payout" },
  // PO-14: the same arguments as payout.create, on the PayPal sandbox.
  { name: "paypal.payout", privileged: true, rail: "paypal", direction: "credit", operation: "payout" },
  // Moves no money, so it has no registered rail; the rail it checks comes from args.rail (PO-10).
  { name: "payee.update", privileged: true, rail: null, direction: "credit", operation: "payee" },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Every registered tool. */
export function registeredTools(): readonly ToolDef[] {
  return TOOLS;
}

/** The registered tool, or undefined for an unknown name. */
export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** Tools an agent may call through POST /api/v1/pay: plain payments only. */
export const PAY_TOOLS: readonly string[] = ["x402.pay", "mpp.pay"];

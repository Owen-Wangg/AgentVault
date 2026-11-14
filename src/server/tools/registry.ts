import type { Direction, Rail } from "@/core/money";

/**
 * The built-in tool registry (taint-and-intent design). The pay flow uses
 * a tool's registered rail to count its amount (chargeableMicros) and to
 * pick its adapter, even when the sandbox runs it on the mock adapter, so
 * sandbox amounts match real ones. The /api/v1/tool route arrives in
 * taint-and-intent task 5.
 */
export interface ToolDef {
  name: string;
  /** High-privilege tools are held in tainted sessions (TAINT-6). */
  privileged: boolean;
  /** Null for tools that move no money, such as payee.update. */
  rail: Rail | null;
  /** debit: the agent spends. credit: the agent refunds or pays out. */
  direction: Direction;
}

const TOOLS: readonly ToolDef[] = [
  { name: "x402.pay", privileged: false, rail: "x402", direction: "debit" },
  { name: "mpp.pay", privileged: false, rail: "stripe", direction: "debit" },
  { name: "stripe.refund", privileged: true, rail: "stripe", direction: "credit" },
  { name: "wire_transfer", privileged: true, rail: "mock", direction: "debit" },
  { name: "payout.create", privileged: true, rail: "mock", direction: "debit" },
  { name: "payee.update", privileged: true, rail: null, direction: "debit" },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The registered tool, or undefined for an unknown name. */
export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** Tools an agent may call through POST /api/v1/pay: plain payments only. */
export const PAY_TOOLS: readonly string[] = ["x402.pay", "mpp.pay"];

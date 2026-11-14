import { micros } from "@/core/money";
import type { EvaluateInput, Limits } from "@/core/policy/types";

const m = micros;

/** Shorthand for a test amount in micros. */
export const usd = (dollars: bigint): ReturnType<typeof micros> => m(dollars * 1_000_000n);

/**
 * A valid input that passes every rule: no limits, open allow-lists, nothing
 * spent, not frozen. Tests override only the fields they care about.
 */
export function baseInput(): EvaluateInput {
  const zero = { minute: m(0n), hour: m(0n), day: m(0n) };
  return {
    request: {
      kind: "pay",
      agentId: "agent-1",
      sessionId: "session-1",
      vendor: "nimbus-weather",
      vendorCategory: "weather",
      tool: "x402.pay",
      amountMicros: m(1_500n),
      idempotencyKey: "key-1",
    },
    envelope: {
      agentId: "agent-1",
      limits: {},
      vendorLimits: {},
      toolLimits: {},
      allowedVendors: "*",
      allowedTools: "*",
    },
    window: { spentMicros: { ...zero }, vendorSpentMicros: { ...zero }, toolSpentMicros: { ...zero }, callsLastMinute: 0 },
    session: { sessionId: "session-1", agentFrozen: false, taintedAt: null, taintSourceUrl: null, sessionSpentMicros: m(0n) },
    scope: { taskId: "task-1", allowedVendorCategories: ["weather"], allowedTools: ["x402.pay"], budgetMicros: usd(1_000n) },
  };
}

/** The base input with some limits set at the agent, vendor, or tool level. */
export function withLimits(levels: { agent?: Limits; vendor?: Limits; tool?: Limits }): EvaluateInput {
  const input = baseInput();
  if (levels.agent) input.envelope.limits = levels.agent;
  if (levels.vendor) input.envelope.vendorLimits = { [input.request.vendor]: levels.vendor };
  if (levels.tool) input.envelope.toolLimits = { [input.request.tool]: levels.tool };
  return input;
}

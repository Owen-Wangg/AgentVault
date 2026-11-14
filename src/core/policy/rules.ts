import { type Micros, cmp, sub, toMicrosString } from "@/core/money";
import type { EvaluateInput, Limits, ReasonDetail, Rule, Window } from "./types";
import { WINDOWS } from "./types";

/**
 * The envelope rules. Each is a pure function of the input that returns the
 * reasons it finds, or none. `evaluate()` runs them all and combines the
 * results. Inputs are assumed valid (`evaluate()` checks the schema first).
 */

type Level = "agent" | "vendor" | "tool";

interface LevelLimits {
  level: Level;
  limits: Limits;
}

/** Own-property lookup, so a vendor named "constructor" or "__proto__" can't pick up Object.prototype. */
function own(map: Record<string, Limits>, key: string): Limits | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The agent-level limits, plus the vendor- and tool-level limits for this request if configured (ENV-9). */
function levels({ request, envelope }: EvaluateInput): LevelLimits[] {
  const out: LevelLimits[] = [{ level: "agent", limits: envelope.limits }];
  const vendor = own(envelope.vendorLimits, request.vendor);
  if (vendor) out.push({ level: "vendor", limits: vendor });
  const tool = own(envelope.toolLimits, request.tool);
  if (tool) out.push({ level: "tool", limits: tool });
  return out;
}

/** The strictest (smallest) configured value across levels. Ties go to the first level listed. */
function strictest<T extends bigint | number>(
  input: EvaluateInput,
  pick: (limits: Limits) => T | undefined,
): { value: T; level: Level } | undefined {
  let best: { value: T; level: Level } | undefined;
  for (const { level, limits } of levels(input)) {
    const value = pick(limits);
    if (value !== undefined && (best === undefined || value < best.value)) best = { value, level };
  }
  return best;
}

/** Whether `spent + amount > cap`, computed without leaving the Micros range. */
function wouldExceed(spent: Micros, amount: Micros, cap: Micros): boolean {
  return cmp(spent, cap) > 0 || cmp(amount, sub(cap, spent)) > 0;
}

/** ENV-5: every request from a frozen agent is denied. */
export const frozenRule: Rule = ({ session }) => (session.agentFrozen ? [{ code: "AGENT_FROZEN" }] : []);

/** ENV-1, ENV-9: the amount may not exceed the strictest per-transaction maximum. */
export const txMaxRule: Rule = (input) => {
  const max = strictest(input, (l) => l.txMaxMicros);
  if (max === undefined || cmp(input.request.amountMicros, max.value) <= 0) return [];
  return [{ code: "OVER_TX_MAX", detail: { level: max.level, limitMicros: toMicrosString(max.value) } }];
};

/**
 * ENV-2, ENV-9: for each window, the amount plus that level's trailing spend
 * may not exceed that level's cap. Agent caps count all of the agent's
 * spend, vendor caps its spend with this vendor, and tool caps its spend
 * with this tool. One reason per window that is over, naming the window and
 * every level that is over in it.
 */
export const windowCapRule: Rule = (input) => {
  const { request, window } = input;
  const spentAt: Record<Level, Record<Window, Micros>> = {
    agent: window.spentMicros,
    vendor: window.vendorSpentMicros,
    tool: window.toolSpentMicros,
  };
  const reasons: ReasonDetail[] = [];
  for (const w of WINDOWS) {
    const over = levels(input)
      .filter(({ level, limits }) => {
        const cap = limits.windowCapsMicros?.[w];
        return cap !== undefined && wouldExceed(spentAt[level][w], request.amountMicros, cap);
      })
      .map(({ level }) => level);
    if (over.length > 0) reasons.push({ code: "OVER_WINDOW_CAP", detail: { window: w, level: over.join(",") } });
  }
  return reasons;
};

/**
 * ENV-3, ENV-9: the agent's calls in the trailing minute, including this
 * one, may not exceed the strictest calls-per-minute limit. Window state
 * has only the agent's total call count, so a vendor- or tool-level limit
 * is checked against that total. That can only deny more, never less.
 * Freezing the agent (ENV-4) is the server's job when it sees this code.
 */
export const velocityRule: Rule = (input) => {
  const limit = strictest(input, (l) => l.callsPerMinute);
  if (limit === undefined || input.window.callsLastMinute + 1 <= limit.value) return [];
  return [{ code: "VELOCITY_EXCEEDED", detail: { level: limit.level, limit: String(limit.value) } }];
};

/** ENV-6, ENV-7: the vendor and the tool must be on the envelope's allow-lists. "*" allows any. */
export const allowListRule: Rule = ({ request, envelope }) => {
  const allowed = (list: readonly string[] | "*", name: string) => list === "*" || list.includes(name);
  const reasons: ReasonDetail[] = [];
  if (!allowed(envelope.allowedVendors, request.vendor)) reasons.push({ code: "VENDOR_NOT_ALLOWED", detail: { vendor: request.vendor } });
  if (!allowed(envelope.allowedTools, request.tool)) reasons.push({ code: "TOOL_NOT_ALLOWED", detail: { tool: request.tool } });
  return reasons;
};

/**
 * ENV-8, ENV-9: an amount at or above the strictest approval threshold is
 * held for a human. ENV-8 applies only to requests that pass every deny
 * rule, so `evaluate()` runs this rule only when no deny reason was found.
 */
export const approvalThresholdRule: Rule = (input) => {
  const threshold = strictest(input, (l) => l.approvalThresholdMicros);
  if (threshold === undefined || cmp(input.request.amountMicros, threshold.value) < 0) return [];
  return [{ code: "NEEDS_APPROVAL", detail: { level: threshold.level, thresholdMicros: toMicrosString(threshold.value) } }];
};

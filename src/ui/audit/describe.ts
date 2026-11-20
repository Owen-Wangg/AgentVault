import { z } from "zod";
import { isScenarioName } from "@/agents/scripted/scenarios";
import type { EventType } from "@/core/audit/chain";
import { MicrosSchema, toDisplay } from "@/core/money";
import type { Copy, UiKey } from "@/ui/copy";
import type { AuditEventMessage } from "@/ui/events/summarize";

/**
 * "What happened" on the audit page (telemetry-dashboard UI-30): one
 * plain-language line per event, from its type and payload. Pure. The
 * result is a string that React renders as escaped text, so a URL or
 * account ID in a payload is never markup or a link.
 *
 * Payloads are read leniently, like the feed's: an unknown type or a
 * payload this can't read gives NOTHING, so a new event type never breaks
 * the page. The schemas are keyed by the core's EventType, so adding an
 * event type there doesn't typecheck until it has a description here.
 */
export const NOTHING = "–";

const Codes = z.array(z.looseObject({ code: z.string() })).transform((rs) => rs.map((r) => r.code));
const Str = z.string().min(1);

const schemas = {
  decision: z.looseObject({
    decision: z.enum(["allow", "hold", "deny"]),
    request: z.looseObject({ tool: Str, amount_micros: MicrosSchema }),
    reasons: Codes,
  }),
  rail_result: z.looseObject({
    status: z.enum(["settled", "failed", "unknown"]),
    rail: Str.nullable().optional(),
    settled_micros: MicrosSchema.optional(),
    payout_to: Str.optional(),
    code: Str.optional(),
    reconciled: z.boolean().optional(),
  }),
  taint: z.looseObject({ url: Str }),
  fetch_failed: z.looseObject({ code: Str }),
  approval_created: z.looseObject({ reasons: Codes }),
  approval_decided: z.looseObject({ status: z.enum(["approved", "denied", "failed_recheck"]), actor: Str, reasons: Codes.nullable().optional() }),
  approval_executed: z.looseObject({}),
  approval_expired: z.looseObject({}),
  agent_frozen: z.looseObject({}),
  agent_unfrozen: z.looseObject({ actor: Str }),
  payee_updated: z.looseObject({ old_ref: Str.nullable(), new_ref: Str }),
  envelope_updated: z.looseObject({ version: z.number().int(), actor: Str }),
  scenario_started: z.looseObject({ scenario: Str, agent: z.string().optional() }),
  mcp_agent_created: z.looseObject({ agent_name: Str }),
  sandbox_created: z.looseObject({}),
  sandbox_retired: z.looseObject({}),
  testnet_workspace_created: z.looseObject({}),
} as const satisfies Record<EventType, z.ZodType>;

type Schemas = typeof schemas;
/** What the page knows that a payload doesn't. */
export type DescribeOptions = {
  /**
   * The workspace is the public sandbox, which only ever runs mock rails.
   * A rail_result's `rail` names the tool's rail even when the mock adapter
   * ran it, so only the page can say the settlement wasn't real.
   */
  readonly sandbox?: boolean;
};
type Describers = { [K in keyof Schemas]: (p: z.infer<Schemas[K]>, c: Copy, o: DescribeOptions) => string };

/** Fills `{name}` slots in a copy string. The values are inserted as they are, never read as a pattern. */
const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (slot, name: string) => values[name] ?? slot);

const say = (c: Copy, key: UiKey, values: Record<string, string> = {}) => fill(c.t(key), values);

const withCodes = (text: string, codes: readonly string[]) => (codes.length > 0 ? `${text}: ${codes.join(", ")}` : text);

/** Who acted, in words: an internal user ID means nothing to a reader. */
function actorText(actor: string, c: Copy): string {
  if (actor === "sandbox_visitor") return c.t("audit.actor.sandboxVisitor");
  if (actor === "system") return c.t("audit.actor.system");
  if (actor === "cli") return c.t("audit.actor.cli");
  return c.t("audit.actor.member");
}

const RAIL_NAMES = { stripe: "audit.rail.stripe", x402: "audit.rail.x402", paypal: "audit.rail.paypal" } as const satisfies Record<string, UiKey>;

/** A rail ID as its provider writes it; one this page doesn't know is shown as written. */
const railName = (rail: string, c: Copy): string => (Object.hasOwn(RAIL_NAMES, rail) ? c.t(RAIL_NAMES[rail as keyof typeof RAIL_NAMES]) : rail);

function settledOn(rail: string, c: Copy, o: DescribeOptions): string {
  if (rail === "mock") return c.t("audit.what.settledOnMock");
  return say(c, o.sandbox ? "audit.what.settledMock" : "audit.what.settled", { rail: railName(rail, c) });
}

const DESCRIBE: Describers = {
  decision: (p, c) => {
    const verb = c.t(`decision.${p.decision}`);
    // A tool that moves no money (payee.update) has no amount worth showing.
    const head = p.request.amount_micros > 0n ? `${verb} ${p.request.tool}, ${toDisplay(p.request.amount_micros)}` : `${verb} ${p.request.tool}`;
    return withCodes(head, p.reasons);
  },
  rail_result: (p, c, o) => {
    let text: string;
    if (p.status === "settled") {
      text = p.rail ? settledOn(p.rail, c, o) : c.t("audit.what.settledNoRail");
      if (p.settled_micros !== undefined) text += `, ${toDisplay(p.settled_micros)}`;
      if (p.payout_to) text += `, ${say(c, "audit.what.paidOutTo", { to: p.payout_to })}`;
    } else if (p.status === "failed") {
      text = say(c, "audit.what.failed", { code: p.code ?? NOTHING });
    } else {
      text = c.t("audit.what.unknown");
    }
    return p.reconciled ? `${text} ${c.t("audit.what.reconciled")}` : text;
  },
  taint: (p, c) => say(c, "audit.what.taint", { url: p.url }),
  fetch_failed: (p, c) => say(c, "audit.what.fetchFailed", { code: p.code }),
  approval_created: (p, c) => withCodes(c.t("audit.what.approvalCreated"), p.reasons),
  approval_decided: (p, c) => {
    const actor = actorText(p.actor, c);
    if (p.status === "approved") return say(c, "audit.what.approved", { actor });
    if (p.status === "denied") return say(c, "audit.what.denied", { actor });
    return withCodes(say(c, "audit.what.recheckFailed", { actor }), p.reasons ?? []);
  },
  approval_executed: (_p, c) => c.t("audit.what.executed"),
  approval_expired: (_p, c) => c.t("audit.what.expired"),
  agent_frozen: (_p, c) => c.t("audit.what.frozen"),
  agent_unfrozen: (p, c) => say(c, "audit.what.unfrozen", { actor: actorText(p.actor, c) }),
  payee_updated: (p, c) => say(c, "audit.what.payeeUpdated", { old: p.old_ref ?? c.t("audit.what.payeeNone"), new: p.new_ref }),
  envelope_updated: (p, c) => say(c, "audit.what.envelope", { version: String(p.version), actor: actorText(p.actor, c) }),
  scenario_started: (p, c) => {
    const title = isScenarioName(p.scenario) ? c.t(`scenario.${p.scenario}.title`) : p.scenario;
    return say(c, p.agent === "gemini" ? "audit.what.scenarioLive" : "audit.what.scenario", { title });
  },
  mcp_agent_created: (p, c) => say(c, "audit.what.mcpAgent", { name: p.agent_name }),
  sandbox_created: (_p, c) => c.t("audit.what.sandboxCreated"),
  sandbox_retired: (_p, c) => c.t("audit.what.sandboxRetired"),
  testnet_workspace_created: (_p, c) => c.t("audit.what.testnetCreated"),
};

const isKnown = (type: string): type is keyof Schemas => Object.hasOwn(schemas, type);

export function describeEvent(event: Pick<AuditEventMessage, "type" | "payload">, c: Copy, options: DescribeOptions = {}): string {
  if (!isKnown(event.type)) return NOTHING;
  return describeKnown(event.type, event.payload, c, options);
}

function describeKnown<K extends keyof Schemas>(type: K, payload: unknown, c: Copy, o: DescribeOptions): string {
  const parsed = schemas[type].safeParse(payload);
  if (!parsed.success) return NOTHING;
  return (DESCRIBE[type] as (p: unknown, c: Copy, o: DescribeOptions) => string)(parsed.data, c, o);
}

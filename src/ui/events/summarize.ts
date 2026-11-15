import { z } from "zod";
import { MAX_MICROS, type Micros, MicrosSchema, micros } from "@/core/money";

/**
 * Turns the audit events from GET /api/v1/events into what the overview
 * and live feed show (UI-5, UI-6). Pure: time is passed in. Amounts stay
 * bigint micros; only chart geometry converts them to numbers.
 *
 * Payloads are parsed leniently: an event this code doesn't understand
 * is skipped rather than breaking the page, since the audit log keeps
 * every event type forever and new ones get added.
 */

/**
 * Add for totals. Each amount is at most MAX_MICROS, but a total of many
 * can pass it, and add() would throw and take the page down. Totals stop
 * at MAX_MICROS instead; isCapped tells the UI to show it as a minimum.
 */
export function addCapped(a: Micros, b: Micros): Micros {
  const total = a + b;
  return total >= MAX_MICROS ? MAX_MICROS : micros(total);
}

export const isCapped = (total: Micros): boolean => total === MAX_MICROS;

export interface AuditEventMessage {
  workspace_id: string;
  seq: number;
  type: string;
  created_at: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export type DecisionKind = "allow" | "hold" | "deny";
export type RailStatus = "settled" | "failed" | "unknown";

export interface Reason {
  code: string;
  detail?: Record<string, string>;
}

export interface FeedRow {
  seq: number;
  at: string;
  agentId: string;
  vendor: string;
  tool: string;
  amountMicros: Micros;
  decision: DecisionKind;
  reasons: Reason[];
  /** Set once the rail result for this decision arrives. */
  railStatus?: RailStatus;
  /** Set for a re-run of an approved request (HITL-2). */
  approvalId?: string;
}

const DetailSchema = z
  .custom<Record<string, unknown>>((v) => typeof v === "object" && v !== null && !Array.isArray(v))
  .transform((v) => Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")));

const DecisionPayload = z.looseObject({
  agent_id: z.string(),
  request: z.looseObject({ vendor: z.string(), tool: z.string(), amount_micros: MicrosSchema }),
  decision: z.enum(["allow", "hold", "deny"]),
  reasons: z.array(z.looseObject({ code: z.string(), detail: DetailSchema.optional() })),
  approval_id: z.string().optional(),
});

const RailResultPayload = z.looseObject({
  status: z.enum(["settled", "failed", "unknown"]),
  decision_seq: z.number().int(),
  settled_micros: MicrosSchema.optional(),
});

const AgentPayload = z.looseObject({ agent_id: z.string() });
const ApprovalPayload = z.looseObject({ approval_id: z.string() });

export function decisionRow(event: AuditEventMessage): FeedRow | null {
  if (event.type !== "decision") return null;
  const p = DecisionPayload.safeParse(event.payload);
  if (!p.success) return null;
  return {
    seq: event.seq,
    at: event.created_at,
    agentId: p.data.agent_id,
    vendor: p.data.request.vendor,
    tool: p.data.request.tool,
    amountMicros: p.data.request.amount_micros,
    decision: p.data.decision,
    reasons: p.data.reasons.map((r) => (r.detail ? { code: r.code, detail: r.detail } : { code: r.code })),
    ...(p.data.approval_id ? { approvalId: p.data.approval_id } : {}),
  };
}

/** Decision rows, newest first, with each rail outcome attached to its decision. */
export function feedRows(events: readonly AuditEventMessage[]): FeedRow[] {
  const rows = new Map<number, FeedRow>();
  for (const e of events) {
    const row = decisionRow(e);
    if (row) rows.set(row.seq, row);
  }
  for (const e of events) {
    if (e.type !== "rail_result") continue;
    const p = RailResultPayload.safeParse(e.payload);
    const row = p.success ? rows.get(p.data.decision_seq) : undefined;
    if (row && p.success) row.railStatus = p.data.status;
  }
  return [...rows.values()].sort((a, b) => b.seq - a.seq);
}

export const RANGES = ["hour", "day", "week", "all"] as const;
export type Range = (typeof RANGES)[number];

const RANGE_MS: Record<Exclude<Range, "all">, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };
/** Chart bucket width per range. */
const BUCKET_MS: Record<Range, number> = { hour: 5 * 60_000, day: 3_600_000, week: 6 * 3_600_000, all: 86_400_000 };

export const inRange = (at: string, range: Range, now: number): boolean => range === "all" || Date.parse(at) > now - RANGE_MS[range];

export interface Overview {
  /** Settled rail amounts in the range: money that moved. */
  spendMicros: Micros;
  /** Requested amounts of denied decisions in the range. */
  blockedMicros: Micros;
  /** Approvals still pending: created and not yet decided or expired. */
  pendingApprovals: number;
  /** Agents frozen and not since unfrozen. */
  frozenAgents: string[];
  decisions: Record<DecisionKind, number>;
  /** Spend per time bucket, oldest first. Empty buckets are included so the chart's time axis is even. */
  spendSeries: { start: number; spendMicros: Micros }[];
  /** Denials, holds, freezes, and taints in the range, newest first. */
  alerts: Alert[];
}

export type Alert =
  | { kind: "decision"; seq: number; at: string; row: FeedRow }
  | { kind: "frozen"; seq: number; at: string; agentId: string }
  | { kind: "taint"; seq: number; at: string; agentId: string; url: string };

const MAX_ALERTS = 8;
const MAX_BUCKETS = 400;

export function summarize(events: readonly AuditEventMessage[], range: Range, now: number): Overview {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const rows = feedRows(ordered);
  const decisions: Record<DecisionKind, number> = { allow: 0, hold: 0, deny: 0 };
  let blocked = micros(0n);
  for (const row of rows) {
    if (!inRange(row.at, range, now)) continue;
    decisions[row.decision] += 1;
    if (row.decision === "deny") blocked = addCapped(blocked, row.amountMicros);
  }

  const settled: { at: number; amount: Micros }[] = [];
  const pending = new Set<string>();
  const frozen = new Set<string>();
  const alerts: Alert[] = [];
  for (const e of ordered) {
    if (e.type === "rail_result") {
      const p = RailResultPayload.safeParse(e.payload);
      if (p.success && p.data.status === "settled" && p.data.settled_micros !== undefined && inRange(e.created_at, range, now)) {
        settled.push({ at: Date.parse(e.created_at), amount: p.data.settled_micros });
      }
    } else if (e.type === "approval_created") {
      const p = ApprovalPayload.safeParse(e.payload);
      if (p.success) pending.add(p.data.approval_id);
    } else if (e.type === "approval_decided" || e.type === "approval_expired") {
      const p = ApprovalPayload.safeParse(e.payload);
      if (p.success) pending.delete(p.data.approval_id);
    } else if (e.type === "agent_frozen" || e.type === "agent_unfrozen") {
      const p = AgentPayload.safeParse(e.payload);
      if (!p.success) continue;
      if (e.type === "agent_frozen") {
        frozen.add(p.data.agent_id);
        if (inRange(e.created_at, range, now)) alerts.push({ kind: "frozen", seq: e.seq, at: e.created_at, agentId: p.data.agent_id });
      } else frozen.delete(p.data.agent_id);
    } else if (e.type === "taint") {
      const p = z.looseObject({ agent_id: z.string(), url: z.string() }).safeParse(e.payload);
      if (p.success && inRange(e.created_at, range, now)) alerts.push({ kind: "taint", seq: e.seq, at: e.created_at, agentId: p.data.agent_id, url: p.data.url });
    }
  }
  for (const row of rows) {
    if (row.decision !== "allow" && inRange(row.at, range, now)) alerts.push({ kind: "decision", seq: row.seq, at: row.at, row });
  }
  alerts.sort((a, b) => b.seq - a.seq);

  return {
    spendMicros: settled.reduce((total, s) => addCapped(total, s.amount), micros(0n)),
    blockedMicros: blocked,
    pendingApprovals: pending.size,
    frozenAgents: [...frozen],
    decisions,
    spendSeries: series(settled, range, now, ordered[0]?.created_at),
    alerts: alerts.slice(0, MAX_ALERTS),
  };
}

function series(points: readonly { at: number; amount: Micros }[], range: Range, now: number, firstAt: string | undefined): Overview["spendSeries"] {
  const width = BUCKET_MS[range];
  const from = range === "all" ? (firstAt ? Date.parse(firstAt) : now) : now - RANGE_MS[range];
  const first = from - (from % width);
  const count = Math.min(MAX_BUCKETS, Math.floor((now - first) / width) + 1);
  const start = now - (now % width) - (count - 1) * width;
  const buckets = Array.from({ length: count }, (_, i) => ({ start: start + i * width, spendMicros: micros(0n) }));
  for (const p of points) {
    const i = Math.floor((p.at - start) / width);
    const bucket = buckets[Math.max(0, Math.min(count - 1, i))];
    if (bucket) bucket.spendMicros = addCapped(bucket.spendMicros, p.amount);
  }
  return buckets;
}

/** Feed filters (UI-6). Empty means any. */
export interface FeedFilter {
  agentId?: string;
  decision?: DecisionKind;
  reason?: string;
}

export function filterRows(rows: readonly FeedRow[], filter: FeedFilter): FeedRow[] {
  return rows.filter(
    (r) =>
      (!filter.agentId || r.agentId === filter.agentId) &&
      (!filter.decision || r.decision === filter.decision) &&
      (!filter.reason || r.reasons.some((reason) => reason.code === filter.reason)),
  );
}

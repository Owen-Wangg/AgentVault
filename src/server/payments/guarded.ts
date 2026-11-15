import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { canonicalJson } from "@/core/audit";
import { type Micros, type Rail, chargeableMicros, micros } from "@/core/money";
import { type Decision, type EvaluateInput, type HoldReason, type ReasonDetail, type Window, evaluate } from "@/core/policy";
import type { RailAdapter, RailResult } from "@/rails/types";
import { RAIL_TIMEOUT_MS } from "@/rails/types";
import { appendEvent } from "@/server/audit/append";
import type { AuthenticatedAgent } from "@/server/auth/agent-keys";
import { type Db, type Tx, queryRows } from "@/server/db/client";
import { decodeEnvelope } from "@/server/db/envelope-json";
import { agents, approvals, envelopes, idempotency, sessions, spendReservations, tasks, vendors, workspaces } from "@/server/db/schema";
import { PAY_TOOLS, findTool, policyTool } from "@/server/tools/registry";
import { type RailOutcome, classifyRailResult } from "./outcome";

/**
 * runGuardedRequest: the one path every pay or tool request takes
 * (audit-and-approvals design). In one transaction it locks the agent's
 * envelope, claims the idempotency key, loads state, evaluates the policy,
 * appends the decision, and reserves the amount on allow. Only after that
 * commits does it call the rail, then it records the outcome in a second
 * transaction. Any error before the rail call rolls back and throws; the
 * route turns that into 503 (PXY-7).
 */

export interface GuardedBody {
  vendor: string;
  tool: string;
  /** As requested. The amount counted against the envelope is derived from the tool's rail. */
  amountMicros: Micros;
  sessionId: string;
  /**
   * Tool-specific arguments from /api/v1/tool, already validated, for
   * example `payment_ref` for stripe.refund. Part of the request hash, the
   * audit event, and the approval, so an approved re-run gets them back.
   */
  args?: Readonly<Record<string, string>>;
}

export interface GuardedRequest {
  agent: AuthenticatedAgent;
  idempotencyKey: string;
  body: GuardedBody;
  /**
   * Set only when an approval re-runs its held request (HITL-2). The key
   * is then `approval:<id>`, the approved hold reasons are passed to
   * evaluate(), and a hold creates no second approval.
   */
  approval?: { id: string; approvedHoldReasons: readonly HoldReason[] };
}

/** Prefix of the idempotency keys approval re-runs use. Agent routes reject client keys with it. */
export const APPROVAL_KEY_PREFIX = "approval:";
export const approvalKey = (approvalId: string): string => `${APPROVAL_KEY_PREFIX}${approvalId}`;

export interface GuardedDeps {
  db: Db;
  /** Audit head key (AUDIT_HEAD_KEY). */
  key: Uint8Array;
  now: () => Date;
  /** The adapter for a tool's rail. Called inside the decision transaction, so a failure rolls back. */
  railFor: (rail: Rail, workspace: { isSandbox: boolean }) => RailAdapter;
  railTimeoutMs?: number;
  approvalTtlMs?: number;
}

export interface ResponseBody {
  decision?: Decision["decision"];
  reasons?: readonly ReasonDetail[];
  approval_id?: string;
  rail_ref?: string;
  explorer_url?: string;
  rail_status?: RailOutcome;
  /** The decision event's seq in the workspace's audit chain. */
  event_seq?: number;
  error?: string;
}

export interface GuardedResponse {
  status: number;
  body: ResponseBody;
}

const MINUTE_MS = 60_000;
const WINDOW_MS: Record<Window, number> = { minute: MINUTE_MS, hour: 60 * MINUTE_MS, day: 24 * 60 * MINUTE_MS };
const IDEMPOTENCY_TTL_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_APPROVAL_TTL_MS = 15 * MINUTE_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sha256 of the canonical validated body, so key order and whitespace in the client's JSON don't matter. */
export function requestHash(body: GuardedBody): string {
  // canonicalJson omits undefined properties, so a body without args hashes as it did before args existed.
  const canonical = canonicalJson({ vendor: body.vendor, tool: body.tool, amount_micros: body.amountMicros, session_id: body.sessionId, args: body.args });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const iso = (d: Date) => d.toISOString();
const ago = (now: Date, ms: number) => iso(new Date(now.getTime() - ms));
const toMicros = (text: string) => micros(BigInt(text));

type Spend = Record<Window, Micros>;

/** Reserved and settled reservations inside each trailing window, for the agent, this vendor, and this tool (RES-2). */
async function loadWindowSpend(tx: Tx, agentId: string, vendor: string, tool: string, now: Date) {
  const [m, h, d] = [ago(now, WINDOW_MS.minute), ago(now, WINDOW_MS.hour), ago(now, WINDOW_MS.day)];
  const sum = (filter: ReturnType<typeof sql>, since: string) =>
    sql`coalesce(sum(amount_micros) FILTER (WHERE ${filter} AND created_at > ${since}::timestamptz), 0)::text`;
  const all = sql`true`;
  const byVendor = sql`vendor = ${vendor}`;
  const byTool = sql`tool = ${tool}`;
  const [row] = await queryRows<Record<string, string>>(
    tx,
    sql`SELECT
      ${sum(all, m)} AS a_minute, ${sum(all, h)} AS a_hour, ${sum(all, d)} AS a_day,
      ${sum(byVendor, m)} AS v_minute, ${sum(byVendor, h)} AS v_hour, ${sum(byVendor, d)} AS v_day,
      ${sum(byTool, m)} AS t_minute, ${sum(byTool, h)} AS t_hour, ${sum(byTool, d)} AS t_day
    FROM spend_reservations
    WHERE agent_id = ${agentId} AND status IN ('reserved', 'settled')
      AND created_at > ${d}::timestamptz AND created_at <= ${iso(now)}::timestamptz`,
  );
  const pick = (prefix: string): Spend => ({
    minute: toMicros(row?.[`${prefix}_minute`] ?? "0"),
    hour: toMicros(row?.[`${prefix}_hour`] ?? "0"),
    day: toMicros(row?.[`${prefix}_day`] ?? "0"),
  });
  return { agent: pick("a"), vendor: pick("v"), tool: pick("t") };
}

async function loadSessionSpend(tx: Tx, sessionId: string): Promise<Micros> {
  const [row] = await queryRows<{ total: string }>(
    tx,
    sql`SELECT coalesce(sum(amount_micros), 0)::text AS total FROM spend_reservations
        WHERE session_id = ${sessionId} AND status IN ('reserved', 'settled')`,
  );
  return toMicros(row?.total ?? "0");
}

/** Every request claims an idempotency row, so this counts denied and held calls too. This request is excluded. */
async function loadCallsLastMinute(tx: Tx, agentId: string, key: string, now: Date): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    tx,
    sql`SELECT count(*)::int AS n FROM idempotency
        WHERE agent_id = ${agentId} AND key <> ${key}
          AND created_at > ${ago(now, WINDOW_MS.minute)}::timestamptz AND created_at <= ${iso(now)}::timestamptz`,
  );
  return row?.n ?? 0;
}

type Claim = { kind: "claimed" } | { kind: "done"; response: GuardedResponse };

/** Claim the idempotency key under the envelope lock (PXY-8, PXY-12, PXY-13, PXY-14). */
async function claimKey(tx: Tx, agentId: string, key: string, hash: string, now: Date): Promise<Claim> {
  const [row] = await tx
    .select()
    .from(idempotency)
    .where(and(eq(idempotency.agentId, agentId), eq(idempotency.key, key)));
  const live = row !== undefined && row.createdAt.getTime() > now.getTime() - IDEMPOTENCY_TTL_MS;
  if (live) {
    if (row.requestHash !== hash) return { kind: "done", response: { status: 422, body: { error: "IDEMPOTENCY_KEY_REUSED" } } };
    if (row.response === null) return { kind: "done", response: { status: 409, body: { error: "IDEMPOTENCY_IN_PROGRESS" } } };
    return { kind: "done", response: row.response as GuardedResponse };
  }
  // An expired row is an operational record, not an audit event, so it can be replaced (PXY-13).
  if (row) await tx.delete(idempotency).where(and(eq(idempotency.agentId, agentId), eq(idempotency.key, key)));
  await tx.insert(idempotency).values({ agentId, key, requestHash: hash, response: null, createdAt: now });
  return { kind: "claimed" };
}

async function storeResponse(tx: Tx, agentId: string, key: string, response: GuardedResponse): Promise<void> {
  await tx
    .update(idempotency)
    .set({ response: JSON.parse(canonicalJson(response)) })
    .where(and(eq(idempotency.agentId, agentId), eq(idempotency.key, key)));
}

const invalid = (field: string): Decision => ({ decision: "deny", reasons: [{ code: "INVALID_REQUEST", detail: { field } }] });

export interface Pending {
  decisionSeq: number;
  decision: Decision;
  workspaceId: string;
  /** Set when the decision is allow and the tool moves money. */
  rail?: {
    adapter: RailAdapter;
    reservationId: string;
    /** The reservation's created_at, passed to the rail as RailContext.reservedAt. */
    reservedAt: Date;
    counted: Micros;
    vendorUrl: string;
    railName: Rail;
    /** Set for credit tools (stripe.refund): the payment being refunded. */
    refundOf?: string;
  };
}

/**
 * The outcome of the decision transaction. `final` carries the decision
 * when one was made (not for idempotent replays); `execute` means allow,
 * with the rail call still to come.
 */
export type Decided =
  | { kind: "final"; response: GuardedResponse; decision?: Decision; decisionSeq?: number }
  | { kind: "execute"; pending: Pending };

/** The policy decision behind a Decided, or undefined for an idempotent replay. */
export function decisionOf(decided: Decided): { decision: Decision; decisionSeq: number } | undefined {
  if (decided.kind === "execute") return { decision: decided.pending.decision, decisionSeq: decided.pending.decisionSeq };
  return decided.decision && decided.decisionSeq !== undefined ? { decision: decided.decision, decisionSeq: decided.decisionSeq } : undefined;
}

/**
 * Steps 3 to 7 inside the caller's transaction: lock, claim the key, load
 * state, evaluate, audit, and reserve on allow. runGuardedRequest opens
 * the transaction itself; the approvals service calls this inside the
 * transaction that moves the approval out of `pending`, so both commit or
 * roll back together.
 */
export async function decideGuarded(tx: Tx, req: GuardedRequest, deps: GuardedDeps, now: Date): Promise<Decided> {
  const { agent, body } = req;
  const workspaceId = agent.workspaceId;

  // PXY-4: lock the envelope first. Every request for this agent waits here.
  const [envelopeRow] = await tx.select().from(envelopes).where(eq(envelopes.agentId, agent.id)).for("update");
  if (!envelopeRow) throw new Error("Agent has no envelope");

  const claim = await claimKey(tx, agent.id, req.idempotencyKey, requestHash(body), now);
  if (claim.kind === "done") {
    // A re-run's key is new by construction. Finding it used means something is wrong: fail closed.
    if (req.approval) throw new Error("Approval re-run key was already used");
    return { kind: "final", response: claim.response };
  }

  // PXY-11: the frozen flag is read after the lock, so a freeze committed by a concurrent request is seen.
  const [agentRow] = await tx
    .select({ frozenAt: agents.frozenAt, isSandbox: workspaces.isSandbox })
    .from(agents)
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .where(eq(agents.id, agent.id));
  if (!agentRow) throw new Error("Agent not found after authentication");

  const tool = findTool(body.tool);
  const [sessionRow] = UUID.test(body.sessionId)
    ? await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, body.sessionId), eq(sessions.agentId, agent.id)))
    : [];
  const [taskRow] = sessionRow ? await tx.select().from(tasks).where(eq(tasks.id, sessionRow.taskId)) : [];
  const [vendorRow] = await tx
    .select()
    .from(vendors)
    .where(and(eq(vendors.workspaceId, workspaceId), eq(vendors.name, body.vendor)));

  // The amount counted against the envelope uses the tool's registered rail (MON-10, MON-11).
  const counted = tool ? chargeableMicros(body.amountMicros, tool.rail ?? "mock", tool.direction) : body.amountMicros;

  let decision: Decision;
  if (!tool) {
    decision = { decision: "deny", reasons: [{ code: "TOOL_NOT_ALLOWED", detail: { tool: body.tool, reason: "not in the tool registry" } }] };
  } else if (tool.direction === "credit" && !body.args?.payment_ref) {
    // A refund must name the payment it refunds. The tool route checks this too.
    decision = invalid("args.payment_ref");
  } else if (!sessionRow || !taskRow) {
    // A session that doesn't exist or belongs to another agent can't be evaluated: fail closed.
    decision = invalid("session_id");
  } else {
    const spend = await loadWindowSpend(tx, agent.id, body.vendor, body.tool, now);
    const input: EvaluateInput = {
      request: {
        kind: PAY_TOOLS.includes(tool.name) ? "pay" : "tool",
        agentId: agent.id,
        sessionId: sessionRow.id,
        vendor: body.vendor,
        // INT-5, INT-6: the category comes from the registry, never the agent. Unknown vendors are "unknown".
        vendorCategory: vendorRow?.category ?? "unknown",
        tool: tool.name,
        amountMicros: counted,
        idempotencyKey: req.idempotencyKey,
      },
      envelope: decodeEnvelope(agent.id, envelopeRow),
      window: {
        spentMicros: spend.agent,
        vendorSpentMicros: spend.vendor,
        toolSpentMicros: spend.tool,
        callsLastMinute: await loadCallsLastMinute(tx, agent.id, req.idempotencyKey, now),
      },
      session: {
        sessionId: sessionRow.id,
        agentFrozen: agentRow.frozenAt !== null,
        taintedAt: sessionRow.taintedAt ? iso(sessionRow.taintedAt) : null,
        taintSourceUrl: sessionRow.taintSourceUrl,
        sessionSpentMicros: await loadSessionSpend(tx, sessionRow.id),
      },
      scope: {
        taskId: taskRow.id,
        allowedVendorCategories: taskRow.allowedVendorCategories,
        allowedTools: taskRow.allowedTools,
        budgetMicros: taskRow.budgetMicros,
      },
      tool: policyTool(tool),
      ...(req.approval ? { approvedHoldReasons: req.approval.approvedHoldReasons } : {}),
    };
    decision = evaluate(input);
  }

  // Step 6: the decision is audited before anything executes (PXY-5).
  const requestPayload = {
    vendor: body.vendor,
    tool: body.tool,
    amount_micros: body.amountMicros,
    counted_micros: counted,
    session_id: body.sessionId,
    idempotency_key: req.idempotencyKey,
    args: body.args,
  };
  const decisionEvent = await appendEvent(
    tx,
    {
      workspaceId,
      type: "decision",
      payload: {
        agent_id: agent.id,
        request: requestPayload,
        decision: decision.decision,
        reasons: decision.reasons,
        approval_id: req.approval?.id,
        approved_hold_reasons: req.approval?.approvedHoldReasons,
      },
    },
    { key: deps.key, now },
  );
  const decisionSeq = decisionEvent.seq;

  // PXY-10: freeze in the same transaction. The flag stays until a human unfreezes the agent.
  if (decision.reasons.some((r) => r.code === "VELOCITY_EXCEEDED")) {
    const frozen = await tx
      .update(agents)
      .set({ frozenAt: now })
      .where(and(eq(agents.id, agent.id), isNull(agents.frozenAt)))
      .returning({ id: agents.id });
    if (frozen.length > 0) {
      await appendEvent(tx, { workspaceId, type: "agent_frozen", payload: { agent_id: agent.id, decision_seq: decisionSeq } }, { key: deps.key, now });
    }
  }

  if (decision.decision === "deny") {
    const response: GuardedResponse = { status: 403, body: { decision: "deny", reasons: decision.reasons, event_seq: decisionSeq } };
    await storeResponse(tx, agent.id, req.idempotencyKey, response);
    return { kind: "final", response, decision, decisionSeq };
  }

  if (decision.decision === "hold" && req.approval) {
    // A re-run held for a reason nobody approved fails its recheck. No second approval (HITL-3).
    const response: GuardedResponse = { status: 202, body: { decision: "hold", reasons: decision.reasons, event_seq: decisionSeq } };
    await storeResponse(tx, agent.id, req.idempotencyKey, response);
    return { kind: "final", response, decision, decisionSeq };
  }

  if (decision.decision === "hold") {
    // HITL-1: a pending approval with the full request, the reasons, and an expiry.
    const expiresAt = new Date(now.getTime() + (deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS));
    const [approval] = await tx
      .insert(approvals)
      .values({
        workspaceId,
        request: JSON.parse(canonicalJson({ agent_id: agent.id, ...requestPayload })),
        reasons: JSON.parse(canonicalJson(decision.reasons)),
        expiresAt,
        createdAt: now,
      })
      .returning({ id: approvals.id });
    if (!approval) throw new Error("Approval insert returned no row");
    await appendEvent(
      tx,
      { workspaceId, type: "approval_created", payload: { approval_id: approval.id, decision_seq: decisionSeq, reasons: decision.reasons, expires_at: iso(expiresAt) } },
      { key: deps.key, now },
    );
    const response: GuardedResponse = {
      status: 202,
      body: { decision: "hold", reasons: decision.reasons, approval_id: approval.id, event_seq: decisionSeq },
    };
    await storeResponse(tx, agent.id, req.idempotencyKey, response);
    return { kind: "final", response, decision, decisionSeq };
  }

  // allow. A tool can only be allowed if it is registered.
  if (!tool) throw new Error("Allowed an unregistered tool");
  if (tool.rail === null) return { kind: "execute", pending: { decisionSeq, decision, workspaceId } };

  // RES-1: reserve the counted amount in the same transaction as the decision.
  // The reservation ID is the rail idempotency key, never the client's key.
  const adapter = deps.railFor(tool.rail, { isSandbox: agentRow.isSandbox });
  const reservationId = randomUUID();
  await tx.insert(spendReservations).values({
    id: reservationId,
    agentId: agent.id,
    sessionId: body.sessionId,
    vendor: body.vendor,
    tool: tool.name,
    amountMicros: counted,
    status: "reserved",
    rail: tool.rail,
    railIdempotencyKey: reservationId,
    decisionSeq,
    createdAt: now,
  });
  return {
    kind: "execute",
    pending: {
      decisionSeq,
      decision,
      workspaceId,
      rail: {
        adapter,
        reservationId,
        reservedAt: now,
        counted,
        vendorUrl: vendorRow?.origin ?? "",
        railName: tool.rail,
        ...(tool.direction === "credit" && body.args?.payment_ref ? { refundOf: body.args.payment_ref } : {}),
      },
    },
  };
}

/** Record the rail outcome, resolve the reservation, and store the response (PXY-6, RES-3 to RES-5). */
async function recordOutcome(tx: Tx, req: GuardedRequest, deps: GuardedDeps, pending: Pending, result: RailResult | { thrown: true }) {
  const now = deps.now();
  const outcome = classifyRailResult(result);
  const ok = "ok" in result && result.ok ? result : null;
  const failure = "ok" in result && !result.ok ? result : null;
  const payload = {
    status: outcome,
    rail: pending.rail?.railName ?? null,
    decision_seq: pending.decisionSeq,
    reservation_id: pending.rail?.reservationId,
    refund_of: pending.rail?.refundOf,
    rail_ref: ok?.ref || undefined,
    explorer_url: ok?.explorerUrl,
    // A tool with no rail moves no money, so it has no settled amount.
    settled_micros: pending.rail ? ok?.settledMicros : undefined,
    code: failure?.code ?? ("thrown" in result ? "RAIL_EXCEPTION" : undefined),
  };
  await appendEvent(tx, { workspaceId: pending.workspaceId, type: "rail_result", payload }, { key: deps.key, now });

  if (pending.rail && outcome !== "unknown") {
    await tx
      .update(spendReservations)
      .set({ status: outcome === "settled" ? "settled" : "released", resolvedAt: now })
      .where(and(eq(spendReservations.id, pending.rail.reservationId), eq(spendReservations.status, "reserved")));
  }

  const response = allowedResponse(pending.decisionSeq, outcome, { ref: ok?.ref, explorerUrl: ok?.explorerUrl, code: failure?.code });
  await storeResponse(tx, req.agent.id, req.idempotencyKey, response);
  return response;
}

/**
 * The response to an allowed request once its rail outcome is known. The
 * reconciler builds the same response when it resolves an unknown outcome
 * later, so replays of the original key return the resolved result (RES-9).
 */
export function allowedResponse(
  decisionSeq: number,
  outcome: RailOutcome,
  rail: { ref?: string | undefined; explorerUrl?: string | undefined; code?: string | undefined } = {},
): GuardedResponse {
  // Allow carries no reasons (ENV-10).
  const base: ResponseBody = { decision: "allow", reasons: [], event_seq: decisionSeq };
  if (outcome === "settled") {
    return {
      status: 200,
      body: { ...base, rail_status: "settled", ...(rail.ref ? { rail_ref: rail.ref } : {}), ...(rail.explorerUrl ? { explorer_url: rail.explorerUrl } : {}) },
    };
  }
  if (outcome === "failed") return { status: 502, body: { ...base, rail_status: "failed", error: rail.code ?? "RAIL_REJECTED" } };
  return { status: 202, body: { ...base, rail_status: "unknown" } };
}

/** Store a response for an idempotency key (the reconciler rewrites them, RES-9). */
export { storeResponse };

export async function runGuardedRequest(req: GuardedRequest, deps: GuardedDeps): Promise<GuardedResponse> {
  const now = deps.now();
  const decided = await deps.db.transaction((tx) => decideGuarded(tx, req, deps, now));
  return executeGuarded(req, deps, decided);
}

/** Steps 8 and 9, after the decision transaction committed: call the rail on allow and record the outcome. */
export async function executeGuarded(req: GuardedRequest, deps: GuardedDeps, decided: Decided): Promise<GuardedResponse> {
  if (decided.kind === "final") return decided.response;

  const { pending } = decided;
  // A tool with no rail (for example payee.update) has nothing to call, so its outcome is settled.
  let result: RailResult | { thrown: true } = { ok: true, ref: "", settledMicros: micros(0n) };
  if (pending.rail) {
    // Step 8: the rail call happens after commit, never while holding the lock.
    const { adapter, reservationId, reservedAt, counted, vendorUrl, refundOf } = pending.rail;
    // reservedAt is the reservation row's created_at, which the reconciler passes to lookup() too.
    const ctx = { signal: AbortSignal.timeout(deps.railTimeoutMs ?? RAIL_TIMEOUT_MS), reservedAt };
    try {
      // Credit tools refund an earlier payment; the rail rounds the amount down (MON-8).
      result =
        refundOf !== undefined
          ? await adapter.refund({ paymentRef: refundOf, amountMicros: counted, idempotencyKey: reservationId }, ctx)
          : await adapter.execute({ vendorUrl, approvedMicros: counted, idempotencyKey: reservationId }, ctx);
    } catch {
      // The request may have reached the rail, so this proves nothing (RES-5).
      result = { thrown: true };
    }
  }
  // If this fails, the reservation stays reserved and the reconciler resolves it; the route returns 503.
  return deps.db.transaction((tx) => recordOutcome(tx, req, deps, pending, result));
}

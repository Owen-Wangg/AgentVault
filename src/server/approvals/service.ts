import { and, asc, desc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@/core/audit";
import { ADVISORY_SCORE_MAX, ADVISORY_SCORE_MIN } from "@/core/intent";
import { MicrosSchema } from "@/core/money";
import { type HoldReason, type ReasonDetail, isHoldReason } from "@/core/policy";
import { appendEvent } from "@/server/audit/append";
import type { Db, Tx } from "@/server/db/client";
import { APPROVAL_STATUSES, agents, approvals, envelopes } from "@/server/db/schema";
import {
  type GuardedDeps,
  type GuardedRequest,
  type ResponseBody,
  approvalKey,
  decideGuarded,
  decisionOf,
  executeGuarded,
} from "@/server/payments/guarded";

/**
 * The approval queue (audit-and-approvals design, "Approvals"). A held
 * request waits as a `pending` approval. Approving re-runs the full pay
 * flow under the key `approval:<id>` with the approved hold reasons
 * attached (HITL-2), in the same transaction that moves the approval out
 * of `pending`. That update is the at-most-once guard (HITL-7): a second
 * approve finds no pending row and gets 409.
 *
 * Lock order matches the pay flow: the agent's envelope first, then
 * approval rows, then the audit head. Expiry is applied on every read and
 * action, in one transaction, with one `approval_expired` event per
 * approval (HITL-12).
 */

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ApprovalAction = "approve" | "deny";

export interface ApprovalsDeps {
  db: Db;
  key: Uint8Array;
  now: () => Date;
  railFor: GuardedDeps["railFor"];
  railTimeoutMs?: number;
}

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
}

export const SYSTEM_ACTOR = "system";

const guardedDeps = (deps: ApprovalsDeps): GuardedDeps => ({
  db: deps.db,
  key: deps.key,
  now: deps.now,
  railFor: deps.railFor,
  ...(deps.railTimeoutMs !== undefined ? { railTimeoutMs: deps.railTimeoutMs } : {}),
});

/**
 * Mark every pending approval in the workspace that is past its expiry as
 * `expired`, with one `approval_expired` event each (HITL-5, HITL-12). The
 * `status = 'pending'` condition makes this exactly once, even when two
 * reads race. Runs in the caller's transaction.
 */
export async function expireApprovals(tx: Tx, workspaceId: string, deps: Pick<ApprovalsDeps, "key">, now: Date): Promise<string[]> {
  const expired = await tx
    .update(approvals)
    .set({ status: "expired", decidedBy: SYSTEM_ACTOR, decidedAt: now })
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending"), lte(approvals.expiresAt, now)))
    .returning({ id: approvals.id, expiresAt: approvals.expiresAt });
  // RETURNING order isn't defined; sort so the chain order is deterministic.
  expired.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id));
  for (const row of expired) {
    await appendEvent(
      tx,
      // created_at is when the expiry was noticed, so expires_at goes in the payload.
      { workspaceId, type: "approval_expired", payload: { approval_id: row.id, expires_at: row.expiresAt.toISOString(), actor: SYSTEM_ACTOR } },
      { key: deps.key, now },
    );
  }
  return expired.map((r) => r.id);
}

export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  request: unknown;
  reasons: unknown;
  recheck_reasons: unknown;
  rerun_decision_seq: number | null;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const view = (row: typeof approvals.$inferSelect): ApprovalView => ({
  id: row.id,
  status: row.status,
  request: row.request,
  reasons: row.reasons,
  recheck_reasons: row.recheckReasons ?? null,
  rerun_decision_seq: row.rerunDecisionSeq ?? null,
  expires_at: row.expiresAt.toISOString(),
  decided_by: row.decidedBy,
  decided_at: row.decidedAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
});

/** The workspace's newest approvals, after applying expiry. */
export async function listApprovals(
  deps: ApprovalsDeps,
  workspaceId: string,
  filter: { status?: ApprovalStatus; limit?: number } = {},
): Promise<ApprovalView[]> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    await expireApprovals(tx, workspaceId, deps, now);
    const rows = await tx
      .select()
      .from(approvals)
      .where(filter.status ? and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, filter.status)) : eq(approvals.workspaceId, workspaceId))
      .orderBy(desc(approvals.createdAt), asc(approvals.id))
      .limit(filter.limit ?? 100);
    return rows.map(view);
  });
}

/**
 * A string map read back from jsonb. JSON.parse makes an own "__proto__"
 * key, which z.record would silently drop, so it is rejected instead.
 */
const StringMap = z
  .custom<Record<string, unknown>>((v) => typeof v === "object" && v !== null && !Array.isArray(v) && !Object.hasOwn(v, "__proto__"))
  .pipe(z.record(z.string(), z.string()));

/** The request an approval stores (written by runGuardedRequest on hold). */
const StoredRequestSchema = z.strictObject({
  agent_id: z.uuid(),
  vendor: z.string().min(1),
  tool: z.string().min(1),
  amount_micros: MicrosSchema,
  counted_micros: MicrosSchema,
  session_id: z.string().min(1),
  idempotency_key: z.string(),
  args: StringMap.optional(),
  // INT-7: the re-run reuses the held request's score, so the LLM is never asked again.
  advisory_drift_score: z.number().int().min(ADVISORY_SCORE_MIN).max(ADVISORY_SCORE_MAX).optional(),
});

const StoredReasonsSchema = z.array(z.looseObject({ code: z.string() }));

/** The hold codes a human approves by approving: the ones the request was held for. */
function heldFor(reasons: unknown): HoldReason[] {
  const parsed = StoredReasonsSchema.safeParse(reasons);
  if (!parsed.success) return [];
  return parsed.data.map((r) => r.code).filter((code): code is HoldReason => isHoldReason(code as HoldReason));
}

type Conflict = { kind: "conflict"; result: ServiceResult };

async function conflict(tx: Tx, approvalId: string): Promise<Conflict> {
  const [row] = await tx.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId));
  const error = row?.status === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_NOT_PENDING";
  return { kind: "conflict", result: { status: 409, body: { error, approval_id: approvalId, status: row?.status } } };
}

const invalidRecheck = (field: string): ReasonDetail[] => [{ code: "INVALID_REQUEST", detail: { field } }];

type Outcome =
  | Conflict
  | { kind: "done"; result: ServiceResult }
  | { kind: "rerun"; req: GuardedRequest; decided: Awaited<ReturnType<typeof decideGuarded>>; status: ApprovalStatus; reasons: readonly ReasonDetail[] };

/**
 * Approve or deny a pending approval (HITL-2 to HITL-8). The caller has
 * already checked that `actor` may act on `workspaceId` (HITL-10, HITL-11).
 */
export async function actOnApproval(
  deps: ApprovalsDeps,
  input: { approvalId: string; workspaceId: string; action: ApprovalAction; actor: string },
): Promise<ServiceResult> {
  const now = deps.now();
  const { approvalId, workspaceId, action, actor } = input;
  const gDeps = guardedDeps(deps);

  const outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
    const [row] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspaceId)));
    if (!row) return { kind: "done", result: { status: 404, body: { error: "NOT_FOUND" } } };
    const stored = StoredRequestSchema.safeParse(row.request);

    // Lock the agent's envelope before anything else, as the pay flow does, so a
    // concurrent pay request and this re-run can't deadlock on the audit head.
    if (action === "approve" && stored.success) {
      await tx.select({ agentId: envelopes.agentId }).from(envelopes).where(eq(envelopes.agentId, stored.data.agent_id)).for("update");
    }

    await expireApprovals(tx, workspaceId, deps, now);
    // HITL-6, HITL-7: only a pending, unexpired approval moves. A second action finds nothing.
    const moved = await tx
      .update(approvals)
      .set({ status: action === "approve" ? "approved" : "denied", decidedBy: actor, decidedAt: now })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending"), gt(approvals.expiresAt, now)))
      .returning({ id: approvals.id });
    if (moved.length === 0) return conflict(tx, approvalId);

    // HITL-8: every state change is audited with the actor.
    await appendEvent(
      tx,
      { workspaceId, type: "approval_decided", payload: { approval_id: approvalId, action, status: action === "approve" ? "approved" : "denied", actor } },
      { key: deps.key, now },
    );
    if (action === "deny") return { kind: "done", result: { status: 200, body: { approval_id: approvalId, status: "denied", decided_by: actor } } };

    // HITL-2: rebuild the held request and re-run the full flow with the approval attached.
    let failed: readonly ReasonDetail[] | null = null;
    let req: GuardedRequest | null = null;
    if (!stored.success) {
      failed = invalidRecheck("request");
    } else {
      const [agentRow] = await tx.select().from(agents).where(eq(agents.id, stored.data.agent_id));
      if (!agentRow || agentRow.workspaceId !== workspaceId || agentRow.revokedAt !== null) {
        failed = invalidRecheck("agent_id");
      } else {
        req = {
          agent: { id: agentRow.id, workspaceId: agentRow.workspaceId, name: agentRow.name },
          // Never the original key: its stored response is the hold.
          idempotencyKey: approvalKey(approvalId),
          body: {
            vendor: stored.data.vendor,
            tool: stored.data.tool,
            amountMicros: stored.data.amount_micros,
            sessionId: stored.data.session_id,
            ...(stored.data.args ? { args: stored.data.args } : {}),
            ...(stored.data.advisory_drift_score !== undefined ? { advisoryDriftScore: stored.data.advisory_drift_score } : {}),
          },
          approval: { id: approvalId, approvedHoldReasons: heldFor(row.reasons) },
        };
      }
    }

    let decided: Awaited<ReturnType<typeof decideGuarded>> | null = null;
    let decisionSeq: number | undefined;
    if (req) {
      decided = await decideGuarded(tx, req, gDeps, now);
      const info = decisionOf(decided);
      if (!info) throw new Error("Approval re-run made no decision");
      decisionSeq = info.decisionSeq;
      // HITL-3: any deny reason, or a hold reason nobody approved, fails the recheck.
      if (info.decision.decision !== "allow") failed = info.decision.reasons;
    }

    const status: ApprovalStatus = failed ? "failed_recheck" : "executed";
    const finished = await tx
      .update(approvals)
      .set({ status, rerunDecisionSeq: decisionSeq ?? null, recheckReasons: failed ? JSON.parse(canonicalJson(failed)) : null })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "approved")))
      .returning({ id: approvals.id });
    if (finished.length !== 1) throw new Error("Approval changed during its re-run");
    await appendEvent(
      tx,
      failed
        ? { workspaceId, type: "approval_decided", payload: { approval_id: approvalId, status, actor, decision_seq: decisionSeq, reasons: failed } }
        : { workspaceId, type: "approval_executed", payload: { approval_id: approvalId, status, actor, decision_seq: decisionSeq } },
      { key: deps.key, now },
    );
    if (!req || !decided) {
      return { kind: "done", result: { status: 200, body: { approval_id: approvalId, status, decided_by: actor, reasons: failed } } };
    }
    return { kind: "rerun", req, decided, status, reasons: failed ?? [] };
  });

  if (outcome.kind !== "rerun") return outcome.result;
  // Committed. An allowed re-run now calls the rail, exactly like any allowed request (PXY-5).
  const response = await executeGuarded(outcome.req, gDeps, outcome.decided);
  const result: ResponseBody & { http_status: number } = { http_status: response.status, ...response.body };
  return {
    status: 200,
    body: {
      approval_id: approvalId,
      status: outcome.status,
      decided_by: actor,
      ...(outcome.status === "failed_recheck" ? { reasons: outcome.reasons } : {}),
      result,
    },
  };
}

/**
 * Clear an agent's frozen flag and audit it (HITL-9). The envelope is
 * locked first, so this serializes with the agent's pay requests (PXY-11).
 */
export async function unfreezeAgent(deps: Pick<ApprovalsDeps, "db" | "key" | "now">, input: { agentId: string; actor: string }): Promise<ServiceResult> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    await tx.select({ agentId: envelopes.agentId }).from(envelopes).where(eq(envelopes.agentId, input.agentId)).for("update");
    const [agent] = await tx
      .select({ workspaceId: agents.workspaceId, frozenAt: agents.frozenAt })
      .from(agents)
      .where(eq(agents.id, input.agentId));
    if (!agent) return { status: 404, body: { error: "NOT_FOUND" } };
    const cleared = await tx
      .update(agents)
      .set({ frozenAt: null })
      .where(and(eq(agents.id, input.agentId), isNotNull(agents.frozenAt)))
      .returning({ id: agents.id });
    if (cleared.length === 0) return { status: 409, body: { error: "AGENT_NOT_FROZEN", agent_id: input.agentId } };
    await appendEvent(
      tx,
      {
        workspaceId: agent.workspaceId,
        type: "agent_unfrozen",
        payload: { agent_id: input.agentId, actor: input.actor, frozen_at: agent.frozenAt?.toISOString() },
      },
      { key: deps.key, now },
    );
    return { status: 200, body: { agent_id: input.agentId, frozen: false, unfrozen_by: input.actor } };
  });
}

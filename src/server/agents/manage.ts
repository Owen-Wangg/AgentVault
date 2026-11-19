import { and, count, eq } from "drizzle-orm";
import { fromDecimalString } from "@/core/money";
import { type Envelope, type EnvelopeWire, envelopeToWire } from "@/core/policy";
import { appendEvent } from "@/server/audit/append";
import type { Db } from "@/server/db/client";
import { decodeEnvelope, encodeEnvelope } from "@/server/db/envelope-json";
import { agents, envelopes, workspaces } from "@/server/db/schema";
import { createAgent } from "./agents";

/**
 * Agent management for the dashboard (telemetry-dashboard UI-7, UI-8).
 * Callers have already checked that the actor owns the workspace.
 */

/**
 * A new agent's envelope: small limits and payment tools only, so a key
 * pasted into an agent can't spend much before its owner sets real
 * limits. Refunds, payouts, and other privileged tools must be allowed
 * explicitly.
 */
export const NEW_AGENT_ENVELOPE: Omit<Envelope, "agentId"> = {
  limits: {
    txMaxMicros: fromDecimalString("5"),
    windowCapsMicros: { day: fromDecimalString("20") },
    callsPerMinute: 30,
    approvalThresholdMicros: fromDecimalString("1"),
  },
  vendorLimits: {},
  toolLimits: {},
  allowedVendors: "*",
  allowedTools: ["x402.pay", "mpp.pay"],
};

/** At most this many agents per workspace, so a signed-in visitor can't fill the database with them. */
export const MAX_AGENTS_PER_WORKSPACE = 25;

/**
 * Create an agent with the default envelope. The key is returned once and
 * never stored (PXY-1). Returns null when the workspace already has
 * MAX_AGENTS_PER_WORKSPACE agents. The workspace row is locked first, so
 * concurrent creates can't both pass the count.
 */
export async function createWorkspaceAgent(db: Db, input: { workspaceId: string; name: string; now: Date }): Promise<{ agentId: string; apiKey: string } | null> {
  return db.transaction(async (tx) => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).for("update");
    const [row] = await tx.select({ n: count() }).from(agents).where(eq(agents.workspaceId, input.workspaceId));
    if ((row?.n ?? 0) >= MAX_AGENTS_PER_WORKSPACE) return null;
    return createAgent(tx, { workspaceId: input.workspaceId, name: input.name, envelope: NEW_AGENT_ENVELOPE, now: input.now });
  });
}

export interface AgentEnvelope {
  agentId: string;
  workspaceId: string;
  name: string;
  version: number;
  envelope: EnvelopeWire;
}

/** An agent's envelope in wire form, or null if the agent isn't in the workspace. */
export async function getAgentEnvelope(db: Db, workspaceId: string, agentId: string): Promise<AgentEnvelope | null> {
  const [row] = await db
    .select({ agent: agents, envelope: envelopes })
    .from(agents)
    .innerJoin(envelopes, eq(envelopes.agentId, agents.id))
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)));
  if (!row) return null;
  const envelope = decodeEnvelope(row.agent.id, row.envelope);
  return { agentId: row.agent.id, workspaceId: row.agent.workspaceId, name: row.agent.name, version: row.envelope.version, envelope: envelopeToWire(envelope, row.envelope.version) };
}

export type UpdateResult = { ok: true; version: number } | { ok: false; status: 404 | 409; body: Record<string, unknown> };

/**
 * Save a new envelope (UI-8). Locks the envelope row first, as the pay
 * flow does, then appends `envelope_updated`, so the lock order stays
 * envelope then audit head. A save made against an older version than
 * the stored one is a 409, so two editors can't silently overwrite
 * each other.
 */
export async function updateEnvelope(
  db: Db,
  input: { agentId: string; workspaceId: string; envelope: Omit<Envelope, "agentId">; expectedVersion: number; actor: string },
  options: { key: Uint8Array; now: Date },
): Promise<UpdateResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ version: envelopes.version })
      .from(envelopes)
      .innerJoin(agents, eq(agents.id, envelopes.agentId))
      .where(and(eq(envelopes.agentId, input.agentId), eq(agents.workspaceId, input.workspaceId)))
      .for("update", { of: envelopes });
    if (!current) return { ok: false, status: 404, body: { error: "NOT_FOUND" } };
    if (current.version !== input.expectedVersion) {
      return { ok: false, status: 409, body: { error: "ENVELOPE_CHANGED", version: current.version } };
    }
    const version = current.version + 1;
    await tx
      .update(envelopes)
      .set({ ...encodeEnvelope(input.envelope), version })
      .where(eq(envelopes.agentId, input.agentId));
    const { limits, vendorLimits, toolLimits, allowedVendors, allowedTools } = envelopeToWire(input.envelope, version);
    const wire = { limits, vendorLimits, toolLimits, allowedVendors, allowedTools };
    await appendEvent(
      tx,
      { workspaceId: input.workspaceId, type: "envelope_updated", payload: { agent_id: input.agentId, version, actor: input.actor, envelope: wire } },
      options,
    );
    return { ok: true, version };
  });
}

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { appendEvent, createHead } from "@/server/audit/append";
import { type Db, type Tx, queryRows } from "@/server/db/client";
import { encodeEnvelope } from "@/server/db/envelope-json";
import { agents, envelopes, tasks, vendors, workspaces } from "@/server/db/schema";
import { env } from "@/server/env";
import { SEED_AGENTS, SEED_TASKS, SEED_VENDORS, SEED_VERSION } from "./seed-data";

/**
 * The public sandbox (AUD-9). The current sandbox is the newest workspace
 * with is_sandbox and no retired_at. Resetting creates and seeds a new one
 * and retires the old one. No audit row is ever deleted or changed, so
 * retired sandboxes stay readable and verifiable.
 */

export interface SandboxOptions {
  /** Audit head key. Defaults to AUDIT_HEAD_KEY. */
  key?: Uint8Array;
  /** Defaults to the current time. */
  now?: Date;
  /** Origin of the demo vendor pages. Defaults to APP_ORIGIN. */
  appOrigin?: string;
}

/** A workspace and its genesis audit head, created together. */
export async function createWorkspace(
  tx: Tx,
  input: { name: string; isSandbox: boolean; ownerUserId?: string },
  options: Pick<SandboxOptions, "key" | "now"> = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const [row] = await tx
    .insert(workspaces)
    .values({ name: input.name, isSandbox: input.isSandbox, ownerUserId: input.ownerUserId ?? null, createdAt: now })
    .returning({ id: workspaces.id });
  if (!row) throw new Error("Workspace insert returned no row");
  await createHead(tx, row.id, options.key ? { key: options.key } : {});
  return row.id;
}

/** An API key hash that matches no key: the key is random and never shown, so the agent can't authenticate. */
const unusableKeyHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

async function seed(tx: Tx, workspaceId: string, appOrigin: string, now: Date): Promise<void> {
  await tx.insert(vendors).values(
    SEED_VENDORS.map((v) => {
      const origin = v.origin === "app" ? appOrigin : v.origin;
      return {
        workspaceId,
        name: v.name,
        origin,
        category: v.category,
        trusted: v.trusted,
        x402Url: v.x402Path ? `${origin}${v.x402Path}` : null,
        mppUrl: v.mppPath ? `${origin}${v.mppPath}` : null,
      };
    }),
  );
  await tx.insert(tasks).values(
    SEED_TASKS.map((t) => ({
      workspaceId,
      description: t.description,
      allowedVendorCategories: [...t.allowedVendorCategories],
      allowedTools: [...t.allowedTools],
      budgetMicros: t.budgetMicros,
    })),
  );
  for (const agent of SEED_AGENTS) {
    const [row] = await tx
      .insert(agents)
      .values({ workspaceId, name: agent.name, apiKeyHash: unusableKeyHash(), createdAt: now })
      .returning({ id: agents.id });
    if (!row) throw new Error("Agent insert returned no row");
    await tx.insert(envelopes).values({ agentId: row.id, ...encodeEnvelope(agent.envelope) });
  }
}

/**
 * Create and seed a new sandbox workspace. Its first audit event is
 * `sandbox_created`. Runs in the caller's transaction.
 */
export async function createSandboxWorkspace(
  tx: Tx,
  input: { previousWorkspaceId: string | null },
  options: SandboxOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const appOrigin = options.appOrigin ?? env.appOrigin();
  const keyOption = options.key ? { key: options.key } : {};
  const workspaceId = await createWorkspace(tx, { name: `Sandbox ${now.toISOString()}`, isSandbox: true }, { ...keyOption, now });
  await seed(tx, workspaceId, appOrigin, now);
  await appendEvent(
    tx,
    {
      workspaceId,
      type: "sandbox_created",
      payload: {
        seed_version: SEED_VERSION,
        previous_workspace_id: input.previousWorkspaceId,
        agents: SEED_AGENTS.length,
        vendors: SEED_VENDORS.length,
        tasks: SEED_TASKS.length,
      },
    },
    { ...keyOption, now },
  );
  return workspaceId;
}

/**
 * Retire a sandbox workspace: mark it retired, revoke its agents' API
 * keys (so a scenario still running gets 401, PXY-3), and append
 * `sandbox_retired` to its own chain. Runs in the caller's transaction.
 */
export async function retireSandboxWorkspace(
  tx: Tx,
  workspaceId: string,
  input: { successorWorkspaceId: string },
  options: Pick<SandboxOptions, "key" | "now"> = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const retired = await tx
    .update(workspaces)
    .set({ retiredAt: now })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.isSandbox, true), isNull(workspaces.retiredAt)))
    .returning({ id: workspaces.id });
  if (retired.length === 0) throw new Error("Workspace is not an active sandbox");
  const revoked = await tx
    .update(agents)
    .set({ revokedAt: now })
    .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.revokedAt)))
    .returning({ id: agents.id });
  await appendEvent(
    tx,
    { workspaceId, type: "sandbox_retired", payload: { successor_workspace_id: input.successorWorkspaceId, agents_revoked: revoked.length } },
    { ...(options.key ? { key: options.key } : {}), now },
  );
}

/** The current public sandbox, or null if there is none yet. */
export async function currentSandbox(db: Db | Tx): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await db
    .select({ id: workspaces.id, createdAt: workspaces.createdAt })
    .from(workspaces)
    .where(and(eq(workspaces.isSandbox, true), isNull(workspaces.retiredAt)))
    .orderBy(desc(workspaces.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Reset the sandbox in one transaction: create and seed a new sandbox,
 * then retire every sandbox that was still active. A transaction-scoped
 * advisory lock makes concurrent resets run one after the other, so they
 * can't leave two active sandboxes.
 */
export async function resetSandbox(db: Db, options: SandboxOptions = {}): Promise<{ workspaceId: string; retired: string[] }> {
  return db.transaction(async (tx) => {
    await queryRows(tx, sql`SELECT pg_advisory_xact_lock(hashtext('agentvault:sandbox-reset'))`);
    const active = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.isSandbox, true), isNull(workspaces.retiredAt)))
      .orderBy(desc(workspaces.createdAt));
    const workspaceId = await createSandboxWorkspace(tx, { previousWorkspaceId: active[0]?.id ?? null }, options);
    for (const { id } of active) await retireSandboxWorkspace(tx, id, { successorWorkspaceId: workspaceId }, options);
    return { workspaceId, retired: active.map((a) => a.id) };
  });
}

/** Create the first sandbox if there is none (`pnpm db:seed`). Does nothing otherwise. */
export async function ensureSandbox(db: Db, options: SandboxOptions = {}): Promise<{ workspaceId: string; created: boolean }> {
  const existing = await currentSandbox(db);
  if (existing) return { workspaceId: existing.id, created: false };
  const { workspaceId } = await resetSandbox(db, options);
  return { workspaceId, created: true };
}

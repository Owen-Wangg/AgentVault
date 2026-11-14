import type { Envelope } from "@/core/policy";
import { generateApiKey } from "@/server/auth/agent-keys";
import type { Tx } from "@/server/db/client";
import { encodeEnvelope } from "@/server/db/envelope-json";
import { agents, envelopes } from "@/server/db/schema";

/**
 * Create an agent and its envelope in the caller's transaction (PXY-1).
 * The returned API key is the only copy: show it once and never store or
 * log it. Only its hash is written.
 */
export async function createAgent(
  tx: Tx,
  input: { workspaceId: string; name: string; envelope: Omit<Envelope, "agentId">; now?: Date },
): Promise<{ agentId: string; apiKey: string }> {
  const { key, hash } = generateApiKey();
  const [row] = await tx
    .insert(agents)
    .values({ workspaceId: input.workspaceId, name: input.name, apiKeyHash: hash, ...(input.now ? { createdAt: input.now } : {}) })
    .returning({ id: agents.id });
  if (!row) throw new Error("Agent insert returned no row");
  await tx.insert(envelopes).values({ agentId: row.id, ...encodeEnvelope(input.envelope) });
  return { agentId: row.id, apiKey: key };
}

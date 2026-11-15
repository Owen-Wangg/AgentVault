import { z } from "zod";
import { type Micros, MicrosSchema } from "@/core/money";

/**
 * Approvals as GET /api/v1/approvals returns them, parsed for the inbox
 * (UI-9). Lenient like the feed: an approval the inbox can't read is
 * skipped rather than breaking the page.
 */

export interface InboxApproval {
  id: string;
  status: string;
  agentId: string;
  vendor: string;
  tool: string;
  amountMicros: Micros;
  /** Tool arguments, such as a refund's payment_ref. */
  args: Record<string, string>;
  reasons: { code: string; detail: Record<string, string> }[];
  /** The URL that tainted the session, if the hold was HELD_TAINTED (TAINT-8). */
  taintSource: string | null;
  expiresAt: string;
  createdAt: string;
}

const StringMap = z
  .custom<Record<string, unknown>>((v) => typeof v === "object" && v !== null && !Array.isArray(v))
  .transform((v) => Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")));

const ApprovalSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  request: z.looseObject({ agent_id: z.string(), vendor: z.string(), tool: z.string(), amount_micros: MicrosSchema, args: StringMap.optional() }),
  reasons: z.array(z.looseObject({ code: z.string(), detail: StringMap.optional() })),
  expires_at: z.string(),
  created_at: z.string(),
});

export function parseApprovals(body: unknown): InboxApproval[] {
  const list = z.looseObject({ approvals: z.array(z.unknown()) }).safeParse(body);
  if (!list.success) return [];
  const out: InboxApproval[] = [];
  for (const item of list.data.approvals) {
    const a = ApprovalSchema.safeParse(item);
    if (!a.success) continue;
    const reasons = a.data.reasons.map((r) => ({ code: r.code, detail: r.detail ?? {} }));
    out.push({
      id: a.data.id,
      status: a.data.status,
      agentId: a.data.request.agent_id,
      vendor: a.data.request.vendor,
      tool: a.data.request.tool,
      amountMicros: a.data.request.amount_micros,
      args: a.data.request.args ?? {},
      reasons,
      taintSource: reasons.find((r) => r.code === "HELD_TAINTED")?.detail.sourceUrl ?? null,
      expiresAt: a.data.expires_at,
      createdAt: a.data.created_at,
    });
  }
  return out;
}

/** "14:05" for 14 minutes 5 seconds left, or null once it has expired. */
export function timeLeft(expiresAt: string, now: number): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return null;
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

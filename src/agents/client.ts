import { z } from "zod";
import { type Micros, toMicrosString } from "@/core/money";
import type { Label } from "@/core/taint";

/**
 * A typed client for AgentVault's agent API (demo-agents AGT-4). It sends
 * the same HTTP requests an external agent would, with its API key as a
 * bearer token, and validates every response with Zod. The scripted
 * scenarios use it, so each run exercises the public API end to end.
 *
 * Decisions (allow, hold, deny) are results, not errors: a denied payment
 * returns normally. Anything without a decision (400, 401, 409, 422, 503,
 * a failed fetch) throws AgentApiError, and a response that doesn't match
 * the API's shape throws too, so a broken server can't pass for a decision.
 */

export interface ReasonResult {
  code: string;
  detail?: Record<string, string>;
}

export interface DecisionResult {
  status: number;
  decision: "allow" | "hold" | "deny";
  reasons: ReasonResult[];
  /** The decision event's seq in the workspace's audit chain. */
  eventSeq: number;
  approvalId?: string;
  railStatus?: "settled" | "failed" | "unknown";
  railRef?: string;
}

export interface FetchResult {
  label: Label;
  url: string;
  body: string;
  /** The taint event's seq, for an untrusted page. */
  eventSeq?: number;
}

/** A response without a decision, or one the client couldn't read. */
export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`AgentVault API returned ${status} ${code}`);
    this.name = "AgentApiError";
  }
}

export interface AgentClientOptions {
  /** Defaults to the global fetch. Tests pass one that calls the route handlers. */
  fetch?: typeof fetch;
  /** Per request. Defaults to 15 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface DecideOptions {
  /**
   * An LLM's advisory drift score for the request, 0 to 100
   * (taint-and-intent INT-7). It can only add a hold. A rating, not money.
   */
  advisoryDriftScore?: number;
}

const scoreField = (o: DecideOptions) => (o.advisoryDriftScore !== undefined ? { advisory_drift_score: o.advisoryDriftScore } : {});

/** Reason details are string maps (ReasonDetail). Anything else isn't the API's shape. */
const ReasonSchema = z.looseObject({ code: z.string().min(1), detail: z.record(z.string(), z.string()).optional() });

const DecisionSchema = z.looseObject({
  decision: z.enum(["allow", "hold", "deny"]),
  reasons: z.array(ReasonSchema),
  event_seq: z.number().int().positive(),
  approval_id: z.uuid().optional(),
  rail_status: z.enum(["settled", "failed", "unknown"]).optional(),
  rail_ref: z.string().optional(),
});

const FetchSchema = z.looseObject({
  label: z.enum(["trusted", "untrusted"]),
  url: z.string(),
  body: z.string(),
  event_seq: z.number().int().positive().optional(),
});

const ErrorSchema = z.looseObject({ error: z.string().min(1) });

/** The status codes a decision can come with (audit-and-approvals design, "API"). */
const DECISION_STATUSES = new Set([200, 202, 403, 502]);

export class AgentClient {
  private readonly send: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly sessionId: string,
    options: AgentClientOptions = {},
  ) {
    this.send = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST /api/v1/fetch: read a page through AgentVault, which labels it and taints the session if it's untrusted. */
  async fetch(url: string): Promise<FetchResult> {
    const { status, body } = await this.post("/api/v1/fetch", { url, session_id: this.sessionId });
    if (status !== 200) throw this.errorOf(status, body);
    const page = FetchSchema.safeParse(body);
    if (!page.success) throw new AgentApiError(status, "UNEXPECTED_RESPONSE");
    return { label: page.data.label, url: page.data.url, body: page.data.body, ...(page.data.event_seq !== undefined ? { eventSeq: page.data.event_seq } : {}) };
  }

  /** POST /api/v1/pay. */
  pay(vendor: string, amountMicros: Micros, idempotencyKey: string, tool = "x402.pay", options: DecideOptions = {}): Promise<DecisionResult> {
    return this.decide(
      "/api/v1/pay",
      { vendor, tool, amount_micros: toMicrosString(amountMicros), session_id: this.sessionId, ...scoreField(options) },
      idempotencyKey,
    );
  }

  /** POST /api/v1/tool. `args` is sent as given; amounts in it must already be micros strings. */
  tool(name: string, args: unknown, idempotencyKey: string, options: DecideOptions = {}): Promise<DecisionResult> {
    return this.decide("/api/v1/tool", { tool: name, session_id: this.sessionId, args, ...scoreField(options) }, idempotencyKey);
  }

  private async decide(path: string, payload: unknown, idempotencyKey: string): Promise<DecisionResult> {
    const { status, body } = await this.post(path, payload, idempotencyKey);
    if (!DECISION_STATUSES.has(status)) throw this.errorOf(status, body);
    const parsed = DecisionSchema.safeParse(body);
    if (!parsed.success) throw this.errorOf(status, body);
    const d = parsed.data;
    return {
      status,
      decision: d.decision,
      reasons: d.reasons.map((r) => (r.detail ? { code: r.code, detail: r.detail } : { code: r.code })),
      eventSeq: d.event_seq,
      ...(d.approval_id ? { approvalId: d.approval_id } : {}),
      ...(d.rail_status ? { railStatus: d.rail_status } : {}),
      ...(d.rail_ref ? { railRef: d.rail_ref } : {}),
    };
  }

  private errorOf(status: number, body: unknown): AgentApiError {
    const error = ErrorSchema.safeParse(body);
    return new AgentApiError(status, error.success ? error.data.error : "UNEXPECTED_RESPONSE");
  }

  private async post(path: string, payload: unknown, idempotencyKey?: string): Promise<{ status: number; body: unknown }> {
    const response = await this.send(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
      // The API never redirects. Refusing redirects keeps the key from following one to another host.
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }
}

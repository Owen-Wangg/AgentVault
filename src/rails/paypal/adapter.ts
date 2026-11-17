import { z } from "zod";
import { fromRailUnits, toRailUnits } from "@/core/money";
import { PAYPAL_SANDBOX_API, type PayPalConfig, isSandboxReceiver } from "../config";
import type { DestinationCheck, PayoutRequest, RailAdapter, RailContext, RailLookup, RailQuote, RailResult } from "../types";

/**
 * The PayPal sandbox payout adapter (payout-rails design, "PayPal
 * adapter"; PO-15 to PO-17, PO-25). It sends one payout batch with one
 * USD item per reservation, from the sandbox business account to a
 * sandbox receiver. PayPal can only pay out here: execute() and refund()
 * refuse without a call.
 *
 * - `sender_batch_id` and `sender_item_id` are the reservation ID, so
 *   PayPal refuses a second batch for the same reservation (measured by
 *   `pnpm paypal:probe`). That refusal links to the earlier batch, which
 *   payout() then reads.
 * - Most batches first answer PENDING. payout() reads the batch a few
 *   times within the rail timeout; if it's still pending, the batch ID
 *   goes back as `pendingRef`, the server stores it on the reservation,
 *   and lookup() reads the batch by it later.
 * - The host is the sandbox constant, and every call re-checks that the
 *   configuration is the sandbox (PO-17). The access token is never
 *   logged or put in a result.
 */

/** PayPal's minimum payout, in cents, measured by `pnpm paypal:probe` (PO-22). */
export const PAYPAL_MINIMUM_PAYOUT_CENTS = 1n;
export const payoutRequestId = (key: string) => `agentvault-payout-v1:${key}`;

/** Item statuses that prove no money reached the payee or that it came back (PO-16). */
export const PAYPAL_FAILURE_STATUSES = ["FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED"] as const;
const FAILURE: ReadonlySet<string> = new Set(PAYPAL_FAILURE_STATUSES);

/** PO-16: only SUCCESS settles, only the five failure statuses fail, and anything else, including PENDING and UNCLAIMED, is unknown. */
export function itemOutcome(status: string): "settled" | "failed" | "unknown" {
  if (status === "SUCCESS") return "settled";
  if (FAILURE.has(status)) return "failed";
  return "unknown";
}

/** PayPal's decimal amount string, built from integer cents only (money-arithmetic.md). */
export function paypalAmount(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Cents from PayPal's "1.00", or null if it isn't exactly a whole number with two decimals. */
export function parsePayPalAmount(value: string): bigint | null {
  const m = /^(\d{1,15})\.(\d{2})$/.exec(value);
  return m?.[1] && m[2] ? BigInt(m[1]) * 100n + BigInt(m[2]) : null;
}

const BATCH_ID = /^[A-Za-z0-9]{1,64}$/;
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_SETTLE_READS = 5;
const DEFAULT_SETTLE_INTERVAL_MS = 5_000;

const Token = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });
const Created = z.object({ batch_header: z.object({ payout_batch_id: z.string().regex(BATCH_ID), batch_status: z.string() }) });
const Batch = z.object({
  batch_header: z.object({
    payout_batch_id: z.string().regex(BATCH_ID),
    batch_status: z.string(),
    sender_batch_header: z.object({ sender_batch_id: z.string() }),
  }),
  items: z
    .array(
      z.object({
        payout_item_id: z.string(),
        transaction_status: z.string().optional(),
        payout_item: z.object({ receiver: z.string(), sender_item_id: z.string().optional(), amount: z.object({ currency: z.string(), value: z.string() }) }),
      }),
    )
    .default([]),
});
type Batch = z.infer<typeof Batch>;
const ErrorBody = z.object({
  name: z.string().optional(),
  details: z.array(z.object({ field: z.string().optional(), link: z.array(z.object({ href: z.string() })).optional() })).optional(),
});

type BatchReading =
  | { kind: "settled"; ref: string; cents: bigint }
  | { kind: "failed"; status: string }
  | { kind: "unknown"; status: string }
  | { kind: "invalid"; detail: string };

export interface PayPalRailOptions {
  config: Pick<PayPalConfig, "environment" | "apiOrigin" | "clientId" | "clientSecret">;
  /** For the sandbox calls. Tests replay recorded responses through it. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Waits between batch reads; resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Batch reads after a payout is created, the first at once. Default 5. */
  settleReads?: number;
  settleIntervalMs?: number;
}

const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

class PayPalTokenError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "PayPal's token response was unreadable" : `PayPal's token request answered ${status}`);
    this.name = "PayPalTokenError";
  }
}

export class PayPalRail implements RailAdapter {
  readonly rail = "paypal" as const;
  readonly minimumUnits = PAYPAL_MINIMUM_PAYOUT_CENTS;
  private readonly config: PayPalRailOptions["config"];
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly settleReads: number;
  private readonly settleIntervalMs: number;
  // A private field, so the token doesn't show when the adapter is logged or inspected.
  #token: { value: string; expiresAtMs: number } | null = null;

  constructor(options: PayPalRailOptions) {
    this.config = options.config;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.settleReads = options.settleReads ?? DEFAULT_SETTLE_READS;
    this.settleIntervalMs = options.settleIntervalMs ?? DEFAULT_SETTLE_INTERVAL_MS;
  }

  /** PO-17: the sandbox host and environment, checked before every call. */
  private sandboxOnly(): boolean {
    return this.config.environment === "sandbox" && this.config.apiOrigin === PAYPAL_SANDBOX_API;
  }

  async quote(): Promise<RailQuote> {
    throw new Error("PayPal only pays out; it has nothing to quote");
  }

  async execute(): Promise<RailResult> {
    return { ok: false, code: "RAIL_REJECTED", detail: "PayPal only pays out here; nothing was sent" };
  }

  async refund(): Promise<RailResult> {
    return { ok: false, code: "RAIL_REJECTED", detail: "PayPal only pays out here; nothing was sent" };
  }

  /**
   * PayPal has no read-only check that an address can receive, so this
   * accepts a sandbox account address and nothing else (security-standards
   * §7). No call is made.
   */
  async checkDestination(destination: string): Promise<DestinationCheck> {
    if (!this.sandboxOnly()) return { ok: false, code: "RAIL_REJECTED", detail: "PayPal is refused outside the sandbox" };
    if (destination.length > 254 || !isSandboxReceiver(destination)) {
      return { ok: false, code: "RAIL_REJECTED", detail: "not a PayPal sandbox account address" };
    }
    return { ok: true };
  }

  /** PO-15, PO-16, PO-25: one batch with one USD item, rounded down to the cent for the payee (PO-3). */
  async payout(req: PayoutRequest, ctx: RailContext = {}): Promise<RailResult> {
    if (!this.sandboxOnly()) return { ok: false, code: "RAIL_REJECTED", detail: "PayPal is refused outside the sandbox; nothing was sent" };
    const cents = toRailUnits(req.amountMicros, "paypal", "credit");
    if (cents < this.minimumUnits) return { ok: false, code: "BELOW_RAIL_MINIMUM", detail: `a payout must be at least ${this.minimumUnits} cent` };
    const destination = await this.checkDestination(req.destination);
    if (!destination.ok) return { ...destination, detail: `${destination.detail ?? destination.code}; nothing was sent` };

    let token: string;
    try {
      token = await this.token(ctx.signal);
    } catch (error) {
      // Only the token request ran, so no payout exists.
      return { ok: false, code: "RAIL_REJECTED", detail: `${isAbort(error) ? "timed out getting a PayPal token" : error instanceof Error ? error.message : "no PayPal token"}; nothing was sent` };
    }
    if (ctx.signal?.aborted) return { ok: false, code: "RAIL_REJECTED", detail: "the rail timeout passed before the payout was sent; nothing was sent" };

    const body = {
      sender_batch_header: { sender_batch_id: req.idempotencyKey, email_subject: "AgentVault sandbox payout" },
      items: [{ recipient_type: "EMAIL", receiver: req.destination, amount: { value: paypalAmount(cents), currency: "USD" }, sender_item_id: req.idempotencyKey }],
    };
    let status: number;
    let json: unknown;
    try {
      const response = await this.fetchFn(`${PAYPAL_SANDBOX_API}/v1/payments/payouts`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "paypal-request-id": payoutRequestId(req.idempotencyKey) },
        body: JSON.stringify(body),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      status = response.status;
      json = await readJson(response);
    } catch (error) {
      if (isAbort(error)) return { ok: false, code: "RAIL_TIMEOUT", detail: "timed out after the payout was sent" };
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "network error after the payout was sent" };
    }

    if (status === 200 || status === 201) {
      const created = Created.safeParse(json);
      if (!created.success) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "PayPal's answer to the payout was unreadable" };
      return this.settle(created.data.batch_header.payout_batch_id, req, cents, token, ctx);
    }
    const error = ErrorBody.safeParse(json);
    const name = error.success ? error.data.name : undefined;
    // Measured: a repeated sender_batch_id is refused with a link to the earlier batch, which may have paid.
    const duplicate = error.success ? error.data.details?.find((d) => d.field === "SENDER_BATCH_ID") : undefined;
    if (status === 400 && duplicate) {
      const earlier = duplicate.link?.map((l) => /\/v1\/payments\/payouts\/([A-Za-z0-9]{1,64})$/.exec(l.href)?.[1]).find(Boolean);
      if (!earlier) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "PayPal already has a batch for this reservation but didn't name it" };
      return this.settle(earlier, req, cents, token, ctx);
    }
    if (status === 401) this.#token = null;
    // PayPal answers 201 when it creates a batch, so any other 4xx created nothing. A 409 is a concurrent request.
    if (status >= 400 && status < 500 && status !== 409) return { ok: false, code: "RAIL_REJECTED", detail: `PayPal refused the payout (${name ?? status})` };
    return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: `PayPal's answer to the payout didn't prove an outcome (${name ?? status})` };
  }

  /**
   * RAIL-21, RAIL-22, PO-25: the batch this reservation's payout created,
   * read by the batch ID the server stored. Without one, unknown and no
   * call: PayPal has no read-only lookup by sender_batch_id (measured).
   * Errors are thrown; the reconciler treats them as unknown.
   */
  async lookup(idempotencyKey: string, ctx: RailContext = {}): Promise<RailLookup> {
    if (!this.sandboxOnly() || !ctx.railRef || !BATCH_ID.test(ctx.railRef)) return { status: "unknown" };
    const token = await this.token(ctx.signal);
    const reading = readBatch(await this.getBatch(ctx.railRef, token, ctx.signal), idempotencyKey);
    if (reading.kind === "settled") return { status: "settled", ref: reading.ref, settledMicros: fromRailUnits(reading.cents, "paypal") };
    if (reading.kind === "failed") return { status: "failed", code: "RAIL_REJECTED" };
    return { status: "unknown" };
  }

  /** Read the batch until its item settles or fails, within the rail signal. Anything short of that keeps the batch ID for lookup(). */
  private async settle(batchId: string, req: PayoutRequest, cents: bigint, token: string, ctx: RailContext): Promise<RailResult> {
    let last = "PENDING";
    for (let read = 0; read < this.settleReads; read += 1) {
      if (read > 0) await this.sleep(this.settleIntervalMs, ctx.signal);
      if (ctx.signal?.aborted) break;
      let batch: Batch;
      try {
        batch = await this.getBatch(batchId, token, ctx.signal);
      } catch {
        continue;
      }
      const reading = readBatch(batch, req.idempotencyKey, { destination: req.destination, cents });
      if (reading.kind === "settled") return { ok: true, ref: reading.ref, settledMicros: fromRailUnits(reading.cents, "paypal") };
      if (reading.kind === "failed") return { ok: false, code: "RAIL_REJECTED", detail: `the payout item is ${reading.status}` };
      if (reading.kind === "invalid") return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: reading.detail, pendingRef: batchId };
      last = reading.status;
    }
    return { ok: false, code: "RAIL_TIMEOUT", detail: `PayPal still reports the payout ${last}`, pendingRef: batchId };
  }

  private async getBatch(batchId: string, token: string, signal?: AbortSignal): Promise<Batch> {
    const response = await this.fetchFn(`${PAYPAL_SANDBOX_API}/v1/payments/payouts/${batchId}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 401) this.#token = null;
    if (!response.ok) throw new Error(`PayPal answered ${response.status} reading the batch`);
    return Batch.parse(await readJson(response));
  }

  /** OAuth client credentials, cached until 60 seconds before expiry. */
  private async token(signal?: AbortSignal): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.#token && nowMs < this.#token.expiresAtMs - TOKEN_MARGIN_MS) return this.#token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret()}`).toString("base64");
    const response = await this.fetchFn(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new PayPalTokenError(response.status);
    const parsed = Token.safeParse(await readJson(response));
    if (!parsed.success) throw new PayPalTokenError(null);
    this.#token = { value: parsed.data.access_token, expiresAtMs: nowMs + parsed.data.expires_in * 1000 };
    return parsed.data.access_token;
  }
}

/** What a batch says about this reservation's one item. `expected` is checked when the request is at hand. */
function readBatch(batch: Batch, key: string, expected?: { destination: string; cents: bigint }): BatchReading {
  if (batch.batch_header.sender_batch_header.sender_batch_id !== key) return { kind: "invalid", detail: "the batch belongs to another reservation" };
  const [item, ...more] = batch.items;
  if (!item) return { kind: "unknown", status: batch.batch_header.batch_status };
  if (more.length > 0) return { kind: "invalid", detail: "the batch has more than one item" };
  const cents = item.payout_item.amount.currency === "USD" ? parsePayPalAmount(item.payout_item.amount.value) : null;
  if (cents === null || item.payout_item.sender_item_id !== key) return { kind: "invalid", detail: "the payout item isn't this reservation's USD payout" };
  if (expected && (cents !== expected.cents || item.payout_item.receiver.toLowerCase() !== expected.destination.toLowerCase())) {
    return { kind: "invalid", detail: "the payout item differs from the payout requested" };
  }
  const status = item.transaction_status ?? "PENDING";
  const outcome = itemOutcome(status);
  if (outcome === "settled") return { kind: "settled", ref: item.payout_item_id, cents };
  if (outcome === "failed") return { kind: "failed", status };
  return { kind: "unknown", status };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

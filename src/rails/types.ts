import type { Micros, Rail } from "@/core/money";

/**
 * The interface every payment rail implements (RAIL-1). Policy and server
 * code depend only on this, never on a specific rail.
 */
export interface RailAdapter {
  /** The rail this adapter charges on, or simulates. */
  readonly rail: Rail;
  /** Smallest amount the rail accepts, in rail units (RAIL-4). */
  readonly minimumUnits: bigint;
  /** Read what the vendor would charge, without paying. */
  quote(req: RailRequest, ctx?: RailContext): Promise<RailQuote>;
  /** Pay. Calling twice with the same idempotency key pays at most once (RAIL-3). */
  execute(req: RailRequest, ctx?: RailContext): Promise<RailResult>;
  /** Refund part or all of an earlier payment. */
  refund(req: RefundRequest, ctx?: RailContext): Promise<RailResult>;
  /** Report what happened to an earlier call. Read-only: never pays, refunds, or pays out (RAIL-21, RAIL-22). */
  lookup(idempotencyKey: string, ctx?: RailContext): Promise<RailLookup>;
  /**
   * Send money from the platform to a payee (payout-rails PO-1, PO-5). The
   * amount rounds down for the payee (PO-3). Calling twice with the same
   * idempotency key pays out at most once. A rail that can't pay out
   * returns RAIL_REJECTED without contacting anyone.
   */
  payout(req: PayoutRequest, ctx?: RailContext): Promise<RailResult>;
  /**
   * Check that a destination can receive payouts, without moving money
   * (PO-1, PO-11). A rail that can't pay out returns RAIL_REJECTED
   * without contacting anyone.
   */
  checkDestination(destination: string, ctx?: RailContext): Promise<DestinationCheck>;
}

export interface PayoutRequest {
  /** The payee's destination on this rail, from the vendor registry, never from the agent (PO-4). */
  destination: string;
  /** The full approved amount. The rail sends it rounded down (PO-3). */
  amountMicros: Micros;
  /** The reservation ID. */
  idempotencyKey: string;
}

export type DestinationCheck = { ok: true } | { ok: false; code: RailFailureCode; detail?: string };

export interface RailRequest {
  vendorUrl: string;
  /** The amount the policy approved, after chargeableMicros(). */
  approvedMicros: Micros;
  /** The reservation ID, never the client's Idempotency-Key (audit-and-approvals design). */
  idempotencyKey: string;
}

export interface RefundRequest {
  /** The rail reference of the payment being refunded. */
  paymentRef: string;
  amountMicros: Micros;
  idempotencyKey: string;
}

export interface RailContext {
  /** Aborts the call. The server passes AbortSignal.timeout(RAIL_TIMEOUT_MS). */
  signal?: AbortSignal;
  /**
   * When the reservation behind this call was created. The server passes
   * the reservation row's `created_at` to both execute() and lookup(). The
   * x402 adapter bounds each authorization's lifetime by it, so lookup()
   * can later prove that an unused authorization can never be used.
   */
  reservedAt?: Date;
}

export interface RailQuote {
  units: bigint;
  /** What those units cost in micros. */
  micros: Micros;
}

/** Codes that prove no money moved: the server releases the reservation. */
export const CONFIRMED_FAILURE_CODES = ["BELOW_RAIL_MINIMUM", "CHALLENGE_MISMATCH", "RAIL_REJECTED"] as const;
/** Codes that don't prove anything: the server keeps the reservation (RES-5). */
export const UNKNOWN_OUTCOME_CODES = ["RAIL_TIMEOUT", "INVALID_RAIL_RESPONSE"] as const;

export type RailFailureCode = (typeof CONFIRMED_FAILURE_CODES)[number] | (typeof UNKNOWN_OUTCOME_CODES)[number];

export type RailResult =
  | { ok: true; ref: string; explorerUrl?: string; vendorBody?: unknown; settledMicros: Micros }
  | { ok: false; code: RailFailureCode; detail?: string };

export type RailLookup =
  | { status: "settled"; ref: string; explorerUrl?: string; settledMicros: Micros }
  | { status: "failed"; code: "RAIL_REJECTED" }
  | { status: "unknown" };

/** Default rail call timeout (RAIL-6). */
export const RAIL_TIMEOUT_MS = 30_000;

import { createHash } from "node:crypto";
import { type Micros, type Rail, fromRailUnits, toRailUnits } from "@/core/money";
import { isDestinationFor, isPayoutRail } from "./destination";
import type {
  DestinationCheck,
  PayoutRequest,
  RailAdapter,
  RailContext,
  RailFailureCode,
  RailLookup,
  RailQuote,
  RailRequest,
  RailResult,
  RefundRequest,
} from "./types";

/**
 * The mock adapter (RAIL-19, RAIL-20). It stands in for any rail and
 * applies that rail's unit conversion and minimum, so sandbox amounts
 * match real ones. It is the only adapter the public sandbox uses
 * (RAIL-2). Its records live in this process's memory: enough for tests
 * and the sandbox, where server-level idempotency (PXY-8) is the real
 * guarantee.
 */

export const STRIPE_MINIMUM_CENTS = 50n;

/** PayPal's minimum payout, 1 cent, as `pnpm paypal:probe` measured (payout-rails PO-22). */
export const PAYPAL_MINIMUM_CENTS = 1n;

const keyHash = (idempotencyKey: string) => createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 16);

/** `mock_tx_` + the first 16 hex chars of sha256(key) (RAIL-19). */
export function mockRef(idempotencyKey: string): string {
  return `mock_tx_${keyHash(idempotencyKey)}`;
}

/** `mock_po_` + the same hash, for payouts (payout-rails design, "Rail interface additions"). */
export function mockPayoutRef(idempotencyKey: string): string {
  return `mock_po_${keyHash(idempotencyKey)}`;
}

/** Codes that mean "the rail may have charged": the mock records the payment before reporting them. */
const RECORDS_BEFORE_FAILING: ReadonlySet<RailFailureCode> = new Set(["RAIL_TIMEOUT", "INVALID_RAIL_RESPONSE"]);

export interface MockRecord {
  kind: "payment" | "refund" | "payout";
  idempotencyKey: string;
  ref: string;
  units: bigint;
  settledMicros: Micros;
  /** For a payout: where it went. */
  destination?: string;
}

export class MockRail implements RailAdapter {
  private readonly records = new Map<string, MockRecord>();
  private readonly lookupOverrides = new Map<string, RailLookup>();
  private failureMode: RailFailureCode | null = null;
  /** Number of execute, refund, and payout calls that reached the simulated rail. */
  calls = 0;

  constructor(
    /** The rail being simulated. */
    readonly rail: Rail,
    /** Minimum debit, in that rail's units (RAIL-4). */
    readonly minimumUnits: bigint,
  ) {}

  /**
   * Make later execute and refund calls fail with this code (RAIL-20).
   * RAIL_TIMEOUT and INVALID_RAIL_RESPONSE record the payment first, so
   * tests cover "money moved but the caller can't tell". Pass null to clear.
   */
  setFailureMode(code: RailFailureCode | null): void {
    this.failureMode = code;
  }

  /** Make lookup() report this result for a key, whatever was recorded (RAIL-20, RAIL-21). */
  setLookupResult(idempotencyKey: string, result: RailLookup | null): void {
    if (result === null) this.lookupOverrides.delete(idempotencyKey);
    else this.lookupOverrides.set(idempotencyKey, result);
  }

  /** Every payment and refund recorded, in order. */
  recorded(): readonly MockRecord[] {
    return [...this.records.values()];
  }

  async quote(req: RailRequest): Promise<RailQuote> {
    const units = toRailUnits(req.approvedMicros, this.rail, "debit");
    return { units, micros: fromRailUnits(units, this.rail) };
  }

  async execute(req: RailRequest, ctx: RailContext = {}): Promise<RailResult> {
    return this.charge("payment", req.idempotencyKey, toRailUnits(req.approvedMicros, this.rail, "debit"), this.minimumUnits, ctx);
  }

  /** Refunds round down (MON-8). The rail can't refund less than one unit. */
  async refund(req: RefundRequest, ctx: RailContext = {}): Promise<RailResult> {
    return this.charge("refund", req.idempotencyKey, toRailUnits(req.amountMicros, this.rail, "credit"), 1n, ctx);
  }

  /**
   * payout-rails PO-1, PO-3, PO-5: pay out to a destination, rounded down
   * for the payee, at most once per key. Applies the simulated rail's
   * rules: x402 and the mock rail can't pay out, and a malformed
   * destination is refused, both before anything is recorded.
   */
  async payout(req: PayoutRequest, ctx: RailContext = {}): Promise<RailResult> {
    const existing = this.records.get(req.idempotencyKey);
    if (existing) return { ok: true, ref: existing.ref, settledMicros: existing.settledMicros };
    const check = await this.checkDestination(req.destination);
    if (!check.ok) return check;
    return this.charge("payout", req.idempotencyKey, toRailUnits(req.amountMicros, this.rail, "credit"), 1n, ctx, req.destination);
  }

  /** PO-1, PO-11: any well-formed destination for the simulated rail. Nothing is recorded. */
  async checkDestination(destination: string): Promise<DestinationCheck> {
    if (!isPayoutRail(this.rail)) return { ok: false, code: "RAIL_REJECTED", detail: `the ${this.rail} rail can't pay out` };
    if (!isDestinationFor(this.rail, destination)) return { ok: false, code: "RAIL_REJECTED", detail: `not a ${this.rail} payout destination` };
    return { ok: true };
  }

  /** Read-only (RAIL-22). An unrecorded key is unknown: this process can't prove another one never paid. */
  async lookup(idempotencyKey: string): Promise<RailLookup> {
    const override = this.lookupOverrides.get(idempotencyKey);
    if (override) return override;
    const record = this.records.get(idempotencyKey);
    return record ? { status: "settled", ref: record.ref, settledMicros: record.settledMicros } : { status: "unknown" };
  }

  private async charge(
    kind: MockRecord["kind"],
    idempotencyKey: string,
    units: bigint,
    minimum: bigint,
    ctx: RailContext,
    destination?: string,
  ): Promise<RailResult> {
    // An idempotent replay returns the original result and charges nothing (RAIL-3).
    const existing = this.records.get(idempotencyKey);
    if (existing) return { ok: true, ref: existing.ref, settledMicros: existing.settledMicros };
    // Checked before contacting the rail, so nothing is sent (RAIL-4).
    if (units < minimum) return { ok: false, code: "BELOW_RAIL_MINIMUM", detail: `minimum is ${minimum} units` };
    if (ctx.signal?.aborted) return { ok: false, code: "RAIL_TIMEOUT" };

    this.calls += 1;
    const mode = this.failureMode;
    if (mode && !RECORDS_BEFORE_FAILING.has(mode)) return { ok: false, code: mode };

    const record: MockRecord = {
      kind,
      idempotencyKey,
      ref: kind === "payout" ? mockPayoutRef(idempotencyKey) : mockRef(idempotencyKey),
      units,
      settledMicros: fromRailUnits(units, this.rail),
      ...(destination !== undefined ? { destination } : {}),
    };
    this.records.set(idempotencyKey, record);
    if (mode) return { ok: false, code: mode };
    return { ok: true, ref: record.ref, settledMicros: record.settledMicros };
  }
}

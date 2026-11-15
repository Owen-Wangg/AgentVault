// `pnpm stripe:probe`: pay the MPP report endpoint in Stripe test mode,
// refund the payment, and look both up afterwards (rail-adapters task 8).
// The vendor endpoint runs in this process with the real Stripe test-mode
// API, so this makes a real $0.50 test payment with Stripe's test card and
// a real 50-cent test refund. No real money moves.
//
// `--record <dir>` also writes the exchanges as fixtures for the contract
// tests. They hold test-mode object IDs and the vendor's challenge, never
// the key (the Authorization header isn't recorded) and no client_secret.
//
// `--refund-seed <dollars>` instead refunds that much of the seeded $500
// billing payment through the adapter, as an approved stripe.refund would.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromDecimalString, toDisplay } from "@/core/money";
import { loadStripeConfig } from "@/rails/config";
import { StripeMppRail } from "@/rails/stripe-mpp/adapter";
import { findOrCreateBillingPayment } from "@/rails/stripe-mpp/account";
import { StripeApi } from "@/rails/stripe-mpp/stripe-api";
import type { RailResult } from "@/rails/types";
import { REPORT_PATH, REPORT_PRICE, challengeSigningKey, createReportHandler, vendorStripeClient } from "@/server/vendor/report";
import { loadLocalEnv } from "./lib/load-env";

const VENDOR_URL = `http://localhost:3000${REPORT_PATH}`;

export interface StripeExchange {
  request: { method: string; path: string; params: Record<string, string> };
  response: { status: number; json: unknown };
}
export interface VendorExchange {
  request: { url: string; credential: string | null };
  response: { status: number; content_type: string | null; www_authenticate: string | null; payment_receipt: string | null; body: string };
}

/** Drops fields named client_secret anywhere in a recorded Stripe answer. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "client_secret").map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

/** A fetch for the Stripe API that records each request (without its headers) and answer. */
function recordingStripeFetch(into: StripeExchange[]): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, init);
    const u = new URL(url);
    const params = Object.fromEntries(new URLSearchParams(init.body ? String(init.body) : u.search));
    into.push({ request: { method: init.method ?? "GET", path: u.pathname, params }, response: { status: response.status, json: redact(await response.clone().json()) } });
    return response;
  }) as typeof fetch;
}

const show = (r: unknown) => JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const describe = (r: RailResult) => (r.ok ? `ok ${r.ref} ${toDisplay(r.settledMicros)}` : `${r.code}${r.detail ? ` (${r.detail})` : ""}`);

async function main() {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const config = loadStripeConfig();

  const seedRefund = option("--refund-seed");
  if (seedRefund !== undefined) {
    const api = new StripeApi({ secretKey: config.secretKey() });
    const seed = await findOrCreateBillingPayment(api);
    const rail = new StripeMppRail({ api, profileId: config.profileId });
    const key = `probe-seed-refund-${randomUUID()}`;
    const result = await rail.refund({ paymentRef: seed.id, amountMicros: fromDecimalString(seedRefund), idempotencyKey: key }, { signal: AbortSignal.timeout(30_000) });
    console.log(`refund ${toDisplay(fromDecimalString(seedRefund))} of ${seed.id}: ${describe(result)}`);
    if (result.ok) console.log(`  ${result.explorerUrl}`);
    return;
  }

  const recordDir = option("--record");
  const stripeExchanges: StripeExchange[] = [];
  const api = new StripeApi({ secretKey: config.secretKey(), fetch: recordingStripeFetch(stripeExchanges) });
  const handler = createReportHandler({ client: vendorStripeClient(config), profileId: config.profileId, challengeKey: challengeSigningKey(config.secretKey()) });
  const http: VendorExchange[] = [];
  const vendorFetch = (async (url: string, init: RequestInit = {}) => {
    const response = await handler(new Request(url, init));
    http.push({
      request: { url, credential: new Headers(init.headers).get("authorization") },
      response: {
        status: response.status,
        content_type: response.headers.get("content-type"),
        www_authenticate: response.headers.get("www-authenticate"),
        payment_receipt: response.headers.get("payment-receipt"),
        body: await response.clone().text(),
      },
    });
    return response;
  }) as typeof fetch;
  const rail = new StripeMppRail({ api, profileId: config.profileId, fetch: vendorFetch });

  // Pay.
  const key = `probe-${randomUUID()}`;
  const reservedAt = new Date();
  const started = Date.now();
  const paid = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: REPORT_PRICE, idempotencyKey: key }, { reservedAt, signal: AbortSignal.timeout(30_000) });
  console.log(`pay ${toDisplay(REPORT_PRICE)}: ${describe(paid)} in ${Date.now() - started} ms`);
  const payExchanges = stripeExchanges.length;
  const lookedPaid = await rail.lookup(key, { reservedAt, signal: AbortSignal.timeout(30_000) });
  console.log(`  lookup: ${show(lookedPaid)}`);
  // Replaying execute() with the same key must not pay twice (RAIL-3).
  const replayed = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: REPORT_PRICE, idempotencyKey: key }, { reservedAt, signal: AbortSignal.timeout(30_000) });
  console.log(`  same key again: ${describe(replayed)}`);
  const afterReplay = stripeExchanges.length;

  // Refund it.
  let refundKey: string | undefined;
  let refundedAt: Date | undefined;
  let refunded: RailResult | undefined;
  let lookedRefund: unknown;
  if (paid.ok) {
    refundKey = `probe-refund-${randomUUID()}`;
    refundedAt = new Date();
    refunded = await rail.refund({ paymentRef: paid.ref, amountMicros: REPORT_PRICE, idempotencyKey: refundKey }, { reservedAt: refundedAt, signal: AbortSignal.timeout(30_000) });
    console.log(`refund ${toDisplay(REPORT_PRICE)}: ${describe(refunded)}`);
    lookedRefund = await rail.lookup(refundKey, { reservedAt: refundedAt, signal: AbortSignal.timeout(30_000) });
    console.log(`  lookup: ${show(lookedRefund)}`);
  }

  if (recordDir) {
    mkdirSync(recordDir, { recursive: true });
    const file = join(recordDir, "paid-and-refunded-50-cents.json");
    const recording = {
      recorded_at: reservedAt.toISOString(),
      profile_id: config.profileId,
      payment: { key, reserved_at: reservedAt.toISOString(), result: paid, lookup: lookedPaid, replay: replayed },
      refund: refundKey ? { key: refundKey, reserved_at: refundedAt?.toISOString(), result: refunded, lookup: lookedRefund } : null,
      http,
      stripe: {
        pay: stripeExchanges.slice(0, payExchanges),
        lookup_payment: stripeExchanges.slice(payExchanges, afterReplay).filter((e) => e.request.method === "GET"),
        replay: stripeExchanges.slice(payExchanges, afterReplay).filter((e) => e.request.method === "POST"),
        refund: stripeExchanges.slice(afterReplay),
      },
    };
    writeFileSync(file, `${JSON.stringify(recording, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    console.log(`recorded ${file}`);
  }
}

main().catch((error: unknown) => {
  // Only the message: an error object could carry request details.
  console.error(`Stripe probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});

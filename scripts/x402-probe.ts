// `pnpm x402:probe [units...]`: pay the weather endpoint on Base Sepolia at
// each price, in USDC atomic units (1 unit = $0.000001), and look each
// payment up afterwards (rail-adapters task 4). The vendor endpoint runs
// in this process, but its facilitator is the real CDP one and the
// payments are real Base Sepolia transactions with test USDC.
//
// `--record <dir>` also writes the payer's HTTP and JSON-RPC exchanges as
// fixtures for the contract tests. They hold addresses, signatures, and
// transaction hashes, which are public on-chain, and never a key.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { NextRequest } from "next/server";
import { fromRailUnits, toDisplay } from "@/core/money";
import { loadX402PayerConfig, loadX402VendorConfig } from "@/rails/config";
import { X402Rail } from "@/rails/x402/adapter";
import { BaseSepoliaReader } from "@/rails/x402/chain";
import { cdpFacilitator } from "@/server/vendor/cdp-facilitator";
import { createWeatherHandler } from "@/server/vendor/weather";
import { loadLocalEnv } from "./lib/load-env";

const VENDOR_URL = "http://localhost:3000/vendor/api/weather";

interface Exchange {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

/** A fetch for JSON-RPC that records each request and response. */
function recordingFetch(into: Exchange[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const response = await fetch(url, init);
    const json = (await response.clone().json()) as unknown;
    into.push({ request: JSON.parse(String(init.body)) as Record<string, unknown>, response: { status: response.status, json } });
    return response;
  }) as typeof fetch;
}

async function main() {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const recordAt = args.indexOf("--record");
  const recordDir = recordAt >= 0 ? args[recordAt + 1] : undefined;
  const units = args.filter((a, i) => /^\d+$/.test(a) && (recordAt < 0 || i !== recordAt + 1)).map(BigInt);
  const prices = units.length > 0 ? units : [1500n, 1n];

  const payer = loadX402PayerConfig();

  // `--lookup <recorded file>`: only look up an earlier probe's payment, and record that lookup next to it.
  const lookupAt = args.indexOf("--lookup");
  if (lookupAt >= 0) {
    const file = args[lookupAt + 1] ?? "";
    const recorded = JSON.parse(readFileSync(file, "utf8")) as { key: string; reserved_at: string };
    const rpc: Exchange[] = [];
    const rail = new X402Rail({ account: payer.account, minUnits: 1n, chain: new BaseSepoliaReader({ fetch: recordingFetch(rpc) }) });
    const reservedAt = new Date(recorded.reserved_at);
    const looked = await rail.lookup(recorded.key, { reservedAt });
    console.log(`lookup ${recorded.key}: ${JSON.stringify(looked)}`);
    const out = file.replace(/\.json$/, ".lookup.json");
    writeFileSync(out, `${JSON.stringify({ recorded_at: new Date().toISOString(), key: recorded.key, reserved_at: recorded.reserved_at, payer: payer.account.address, result: looked, rpc }, null, 2)}\n`);
    console.log(`  recorded ${out}`);
    return;
  }

  const vendor = loadX402VendorConfig();
  const facilitator = cdpFacilitator({ apiKeyId: vendor.cdpApiKeyId, apiKeySecret: vendor.cdpApiKeySecret });
  console.log(`payer ${payer.account.address} -> vendor ${vendor.payTo}`);

  for (const price of prices) {
    const handler = createWeatherHandler({ payTo: vendor.payTo, price: fromRailUnits(price, "x402"), facilitator });
    const http: Exchange[] = [];
    const rpc: Exchange[] = [];
    const vendorFetch = (async (url: string, init: RequestInit = {}) => {
      const response = await handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]));
      const body = await response.clone().text();
      const sig = new Headers(init.headers).get("PAYMENT-SIGNATURE");
      const required = response.headers.get("PAYMENT-REQUIRED");
      const settled = response.headers.get("PAYMENT-RESPONSE");
      http.push({
        request: { url, payment_signature: sig ? decodePaymentSignatureHeader(sig) : null },
        response: {
          status: response.status,
          content_type: response.headers.get("content-type"),
          payment_required: required ? decodePaymentRequiredHeader(required) : null,
          payment_response: settled ? decodePaymentResponseHeader(settled) : null,
          body,
        },
      });
      return response;
    }) as typeof fetch;
    const rail = new X402Rail({ account: payer.account, minUnits: 1n, fetch: vendorFetch, chain: new BaseSepoliaReader({ fetch: recordingFetch(rpc) }) });

    const key = `probe-${randomUUID()}`;
    const reservedAt = new Date();
    const started = Date.now();
    const result = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: fromRailUnits(price, "x402"), idempotencyKey: key }, { reservedAt, signal: AbortSignal.timeout(30_000) });
    const ms = Date.now() - started;
    if (result.ok) console.log(`${price} units (${toDisplay(fromRailUnits(price, "x402"))}): settled in ${ms} ms, ${result.explorerUrl}`);
    else {
      const last = http.at(-1)?.response as { status?: number; payment_response?: { errorReason?: string } } | undefined;
      console.log(`${price} units: ${result.code}${result.detail ? ` (${result.detail})` : ""}; last vendor status ${last?.status}${last?.payment_response?.errorReason ? `, ${last.payment_response.errorReason}` : ""}`);
    }
    const looked = await rail.lookup(key, { reservedAt });
    console.log(`  lookup: ${JSON.stringify(looked, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`);

    if (recordDir) {
      mkdirSync(recordDir, { recursive: true });
      const file = join(recordDir, `x402-${price}-units.json`);
      writeFileSync(file, `${JSON.stringify({ recorded_at: reservedAt.toISOString(), key, reserved_at: reservedAt.toISOString(), price_units: price.toString(), payer: payer.account.address, pay_to: vendor.payTo, http, rpc }, null, 2)}\n`);
      console.log(`  recorded ${file}`);
    }
  }
}

main().catch((error: unknown) => {
  // Only the message: an error object could carry request details.
  console.error(`x402 probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});

// `pnpm paypal:probe`: measure the PayPal sandbox Payouts API before the
// adapter is built (payout-rails task 2, PO-22). It makes real sandbox
// payouts with fake money from the sandbox business account to the
// supplier's sandbox personal account:
//   1. $1.00, then the same request again with the same PayPal-Request-Id
//      and sender_batch_id, then with the same sender_batch_id and a new
//      PayPal-Request-Id, to see which of them pays twice;
//   2. the batch read back until its item leaves PENDING;
//   3. $0.01 and $0.00, to find the minimum;
//   4. whether a batch can be found by sender_batch_id alone, read-only.
// The host is the fixed sandbox constant (PO-17). It prints statuses,
// error names, and batch IDs, never the access token or the receivers.
//
// `--record <dir>` also writes the exchanges as fixtures for the contract
// tests, with the token and the receiver addresses replaced.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PAYPAL_SANDBOX_API, loadPayPalConfig } from "@/rails/config";
import { loadLocalEnv } from "./lib/load-env";

interface Exchange {
  step: string;
  request: { method: string; path: string; paypal_request_id: string | null; body: unknown };
  response: { status: number; json: unknown };
}

const Token = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });
const BatchHeader = z.object({ payout_batch_id: z.string(), batch_status: z.string() }).passthrough();
const Created = z.object({ batch_header: BatchHeader });
const Batch = z.object({
  batch_header: BatchHeader,
  items: z.array(z.object({ payout_item_id: z.string(), transaction_status: z.string().optional() }).passthrough()).default([]),
});
const ErrorBody = z.object({ name: z.string().optional(), message: z.string().optional(), details: z.array(z.object({ issue: z.string().optional(), field: z.string().optional() }).passthrough()).optional() }).passthrough();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const at = args.indexOf("--record");
  const recordDir = at >= 0 ? args[at + 1] : undefined;
  const config = loadPayPalConfig();
  const exchanges: Exchange[] = [];
  const secrets: [string, string][] = [
    [config.supplierReceiver, "supplier@personal.example.com"],
    [config.attackerReceiver, "attacker@personal.example.com"],
  ];
  /** Replaces the receivers and the token anywhere in a recorded value. */
  const scrub = (value: unknown, token: string | null): unknown =>
    JSON.parse(secrets.reduce((s, [real, fake]) => s.split(real).join(fake), token ? JSON.stringify(value).split(token).join("[token]") : JSON.stringify(value)));

  // OAuth client credentials. The token stays in this function's scope.
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret()}`).toString("base64");
  const tokenResponse = await fetch(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(30_000),
  });
  if (!tokenResponse.ok) throw new Error(`token request answered ${tokenResponse.status}`);
  const token = Token.parse(await tokenResponse.json());
  console.log(`token: ok, expires in ${token.expires_in} s`);

  async function call(step: string, method: "GET" | "POST", path: string, body?: unknown, requestId?: string) {
    const headers: Record<string, string> = { authorization: `Bearer ${token.access_token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (requestId) headers["paypal-request-id"] = requestId;
    const started = Date.now();
    const response = await fetch(`${PAYPAL_SANDBOX_API}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { unreadable: text.slice(0, 200) };
    }
    exchanges.push({ step, request: { method, path, paypal_request_id: requestId ?? null, body: body ?? null }, response: { status: response.status, json } });
    return { status: response.status, json, ms: Date.now() - started };
  }

  const describeError = (json: unknown) => {
    const e = ErrorBody.safeParse(json);
    if (!e.success) return "unreadable error body";
    const issues = (e.data.details ?? []).map((d) => [d.field, d.issue].filter(Boolean).join(": ")).join("; ");
    return `${e.data.name ?? "no name"}${issues ? ` (${issues})` : ""}`;
  };

  const payoutBody = (senderBatchId: string, value: string) => ({
    sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "AgentVault sandbox payout probe" },
    items: [{ recipient_type: "EMAIL", receiver: config.supplierReceiver, amount: { value, currency: "USD" }, sender_item_id: senderBatchId, note: "AgentVault payout-rails probe" }],
  });

  async function payout(step: string, senderBatchId: string, value: string, requestId: string) {
    const r = await call(step, "POST", "/v1/payments/payouts", payoutBody(senderBatchId, value), requestId);
    const created = Created.safeParse(r.json);
    console.log(`${step}: ${r.status} in ${r.ms} ms, ${created.success ? `batch ${created.data.batch_header.payout_batch_id} ${created.data.batch_header.batch_status}` : describeError(r.json)}`);
    return created.success ? created.data.batch_header.payout_batch_id : null;
  }

  async function settle(step: string, batchId: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = await call(step, "GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
      const batch = Batch.safeParse(r.json);
      if (!batch.success) {
        console.log(`${step}: ${r.status}, ${describeError(r.json)}`);
        return;
      }
      const item = batch.data.items[0];
      const status = item?.transaction_status ?? "no item";
      if (status !== "PENDING" && batch.data.batch_header.batch_status !== "PENDING" && batch.data.batch_header.batch_status !== "PROCESSING") {
        console.log(`${step}: batch ${batch.data.batch_header.batch_status}, item ${item?.payout_item_id ?? "none"} ${status} after ${attempt + 1} read(s)`);
        return;
      }
      await sleep(5_000);
    }
    console.log(`${step}: still pending after 12 reads, 60 s`);
  }

  // 1. $1.00 and the two repeats.
  const batchId = `probe-${randomUUID()}`;
  const requestId = `agentvault-payout-v1:${batchId}`;
  const first = await payout("pay $1.00", batchId, "1.00", requestId);
  const replay = await payout("same request id, same batch id", batchId, "1.00", requestId);
  console.log(`  replay returned ${replay === null ? "no batch" : replay === first ? "the same batch" : "A DIFFERENT BATCH"}`);
  const duplicate = await payout("new request id, same batch id", batchId, "1.00", `agentvault-payout-v1:${batchId}:again`);
  console.log(`  duplicate returned ${duplicate === null ? "no batch" : duplicate === first ? "the same batch" : "A DIFFERENT BATCH"}`);

  // 2. Read it back.
  if (first) await settle("read $1.00 batch", first);

  // 3. The minimum.
  const centId = `probe-${randomUUID()}`;
  const cent = await payout("pay $0.01", centId, "0.01", `agentvault-payout-v1:${centId}`);
  if (cent) await settle("read $0.01 batch", cent);
  const zeroId = `probe-${randomUUID()}`;
  const zero = await payout("pay $0.00", zeroId, "0.00", `agentvault-payout-v1:${zeroId}`);
  if (zero) await settle("read $0.00 batch", zero);

  // 4. A read-only lookup by sender_batch_id alone. PayPal documents none; try the obvious query forms.
  for (const path of [`/v1/payments/payouts?sender_batch_id=${encodeURIComponent(batchId)}`, `/v1/payments/payouts/${encodeURIComponent(batchId)}`]) {
    const r = await call("lookup by sender_batch_id", "GET", path);
    const batch = Batch.safeParse(r.json);
    console.log(`lookup ${path.replace(batchId, "<sender_batch_id>")}: ${r.status}, ${batch.success ? `found batch ${batch.data.batch_header.payout_batch_id}` : describeError(r.json)}`);
  }

  if (recordDir) {
    mkdirSync(recordDir, { recursive: true });
    const file = join(recordDir, "payout-probe.json");
    writeFileSync(file, `${JSON.stringify(scrub({ recorded_at: new Date().toISOString(), exchanges }, token.access_token), null, 2)}\n`);
    console.log(`recorded ${file}`);
  }
}

main().catch((error: unknown) => {
  // Only the message: an error object could carry request details.
  console.error(`PayPal probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});

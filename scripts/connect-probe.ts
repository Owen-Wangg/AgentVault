// `pnpm connect:probe`: measure Stripe Connect transfers before the payout
// adapter is built (payout-rails task 2, PO-22). Run `pnpm connect:setup`
// first. It makes real test-mode transfers from the platform's USD test
// balance to the supplier's recipient account (no real money):
//   1. Both recipient accounts read through Accounts v2: livemode and the
//      stripe_transfers capability (PO-6, PO-9).
//   2. $1.00 USD with the adapter's request shape (PO-7), then the same
//      Idempotency-Key again, then the same key with another amount.
//   3. The transfer found by transfer_group alone (PO-8).
//   4. $0.01, $0.00, and more than the balance, for the minimum and the
//      error each refusal returns.
// One API version serves every call, which shows it works for both v2
// Accounts and v1 Transfers. It prints IDs, statuses, and error codes.
//
// `--record <dir>` also writes the exchanges for the contract tests,
// without headers, so without the key.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadStripeConfig } from "@/rails/config";
import { StripeApi } from "@/rails/stripe-mpp/stripe-api";
import { CONNECT_API_VERSION, describeError, findRecipients, readRecipient, transferStatus } from "./connect-setup";
import { loadLocalEnv } from "./lib/load-env";

interface Exchange {
  step: string;
  request: { method: string; path: string; params: unknown; idempotency_key: string | null };
  response: { status: number; json: unknown };
}

const Transfer = z
  .object({
    id: z.string().regex(/^tr_\w+$/),
    object: z.literal("transfer"),
    amount: z.number().int(),
    currency: z.string(),
    destination: z.string(),
    livemode: z.boolean(),
    reversed: z.boolean(),
    transfer_group: z.string().nullish(),
    metadata: z.record(z.string(), z.string()),
  })
  .passthrough();
const TransferList = z.object({ data: z.array(Transfer) });
const Balance = z.object({ available: z.array(z.object({ amount: z.number().int(), currency: z.string() })) });

async function main() {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const at = args.indexOf("--record");
  const recordDir = at >= 0 ? args[at + 1] : undefined;
  const exchanges: Exchange[] = [];
  let step = "";
  const recording = (async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, init);
    const u = new URL(url);
    const body = init.body ? String(init.body) : null;
    const params = body === null ? Object.fromEntries(u.searchParams) : body.startsWith("{") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    const key = new Headers(init.headers).get("idempotency-key");
    exchanges.push({ step, request: { method: init.method ?? "GET", path: u.pathname, params, idempotency_key: key }, response: { status: response.status, json: await response.clone().json().catch(() => null) } });
    return response;
  }) as typeof fetch;
  const api = new StripeApi({ secretKey: loadStripeConfig().secretKey(), apiVersion: CONNECT_API_VERSION, fetch: recording });

  // 1. The accounts.
  step = "read accounts";
  const found = await findRecipients(api);
  const supplierId = found.supplier?.id;
  if (!supplierId || !found.attacker) throw new Error("run pnpm connect:setup first: the supplier and attacker accounts weren't found");
  for (const [role, id] of [["supplier", supplierId], ["attacker", found.attacker.id]] as const) {
    const account = await readRecipient(api, id);
    console.log(`${role} ${account.id}: livemode ${account.livemode}, stripe_transfers ${transferStatus(account)}`);
  }
  const usd = async () => Balance.parse(await api.get("/v1/balance")).available.find((b) => b.currency === "usd")?.amount ?? 0;
  console.log(`USD available before: ${await usd()} cents`);

  // 2. $1.00 with the adapter's request shape, then the two repeats.
  const reservation = `probe-${randomUUID()}`;
  const key = `agentvault-transfer-v1:${reservation}`;
  const params = (cents: string) => ({
    amount: cents,
    currency: "usd",
    destination: supplierId,
    transfer_group: reservation,
    "metadata[idempotency_key]": reservation,
    description: "AgentVault payout-rails probe",
  });
  const transfer = async (label: string, cents: string, idempotencyKey: string) => {
    step = label;
    const started = Date.now();
    try {
      const t = Transfer.parse(await api.post("/v1/transfers", params(cents), { idempotencyKey }));
      console.log(`${label}: ${t.id} ${t.amount} ${t.currency.toUpperCase()} cents to ${t.destination}, livemode ${t.livemode}, reversed ${t.reversed}, in ${Date.now() - started} ms`);
      return t.id;
    } catch (error) {
      console.log(`${label}: ${describeError(error)}`);
      return null;
    }
  };
  const first = await transfer("transfer $1.00", "100", key);
  const replay = await transfer("same key again", "100", key);
  console.log(`  replay returned ${replay === null ? "no transfer" : replay === first ? "the same transfer" : "A DIFFERENT TRANSFER"}`);
  await transfer("same key, $1.01", "101", key);

  // 3. Lookup by transfer_group alone.
  step = "lookup by transfer_group";
  const list = TransferList.parse(await api.get("/v1/transfers", { transfer_group: reservation, limit: "10" }));
  console.log(`lookup by transfer_group: ${list.data.length} transfer(s)${list.data.map((t) => ` ${t.id} reversed ${t.reversed} metadata.idempotency_key ${t.metadata.idempotency_key === reservation ? "matches" : "differs"}`).join(";")}`);
  step = "lookup unknown transfer_group";
  const none = TransferList.parse(await api.get("/v1/transfers", { transfer_group: `probe-${randomUUID()}`, limit: "10" }));
  console.log(`lookup of a group never used: ${none.data.length} transfer(s)`);

  // 4. Minimums and refusals. Each uses its own key.
  await transfer("transfer $0.01", "1", `agentvault-transfer-v1:probe-${randomUUID()}`);
  await transfer("transfer $0.00", "0", `agentvault-transfer-v1:probe-${randomUUID()}`);
  await transfer("transfer $10,000 (over the balance)", "1000000", `agentvault-transfer-v1:probe-${randomUUID()}`);
  step = "balance after";
  console.log(`USD available after: ${await usd()} cents`);

  if (recordDir) {
    mkdirSync(recordDir, { recursive: true });
    const file = join(recordDir, "transfer-probe.json");
    writeFileSync(file, `${JSON.stringify({ recorded_at: new Date().toISOString(), api_version: CONNECT_API_VERSION, exchanges }, null, 2)}\n`);
    console.log(`recorded ${file}`);
  }
}

main().catch((error: unknown) => {
  // Only the message: an error object could carry request details.
  console.error(`Connect probe failed: ${describeError(error)}`);
  process.exitCode = 1;
});

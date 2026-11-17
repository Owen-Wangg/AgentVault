// `pnpm connect:setup`: set up the Stripe sandbox for payout-rails' Connect
// payouts (task 2, PO-21, PO-22). Safe to run again: it finds what an
// earlier run created.
//   1. Two Accounts v2 recipient accounts, the supplier ("Acme Supplies")
//      and the attacker, in Canada like the platform, since cross-border
//      transfers can't go to recipient accounts. They're found again by
//      metadata.agentvault_role.
//   2. For an account whose transfers capability isn't active yet, a
//      single-use onboarding link to finish in the browser with test data.
//   3. With --fund <dollars>, a USD test charge with the available-balance
//      test card, so transfers have funds at once. Then the balance's
//      currencies.
// It prints account IDs, statuses, and onboarding links, never the key.
import { z } from "zod";
import { fromDecimalString, toDisplay, toRailUnits } from "@/core/money";
import { loadStripeConfig } from "@/rails/config";
import { CONNECT_API_VERSION } from "@/rails/stripe-mpp/constants";
import { StripeApi, StripeApiError } from "@/rails/stripe-mpp/stripe-api";
import { loadLocalEnv } from "./lib/load-env";

/** The GA version, which serves both Accounts v2 and v1 Transfers (checked by `pnpm connect:probe`). The payout adapter pins the same one. */
export { CONNECT_API_VERSION };

export const ROLES = {
  // example.com, as in Stripe's own recipient-account example: no real inbox.
  supplier: { displayName: "Acme Supplies (AgentVault demo)", email: "acme-supplies@example.com" },
  attacker: { displayName: "Attacker payee (AgentVault demo)", email: "attacker-payee@example.com" },
} as const;
export type Role = keyof typeof ROLES;

export const RecipientAccount = z
  .object({
    id: z.string().regex(/^acct_\w+$/),
    livemode: z.boolean(),
    metadata: z.record(z.string(), z.string()).nullish(),
    configuration: z
      .object({
        recipient: z
          .object({
            capabilities: z
              .object({ stripe_balance: z.object({ stripe_transfers: z.object({ status: z.string() }).passthrough().nullish() }).passthrough().nullish() })
              .passthrough()
              .nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    requirements: z.unknown().optional(),
  })
  .passthrough();
export type RecipientAccount = z.infer<typeof RecipientAccount>;
const AccountList = z.object({ data: z.array(RecipientAccount), next_page_url: z.string().nullish() });
const AccountLink = z.object({ url: z.string().url(), expires_at: z.string() });
const Balance = z.object({ livemode: z.boolean(), available: z.array(z.object({ amount: z.number().int(), currency: z.string() })) });
const PaymentIntent = z.object({
  id: z.string(),
  status: z.string(),
  livemode: z.boolean(),
  latest_charge: z
    .object({ balance_transaction: z.object({ amount: z.number().int(), currency: z.string(), status: z.string() }).nullish() })
    .nullish(),
});

export const transferStatus = (a: RecipientAccount) => a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status ?? "not requested";

export const describeError = (error: unknown) =>
  error instanceof StripeApiError ? `${error.status}${error.code ? ` ${error.code}` : ""}${error.type ? ` (${error.type})` : ""}: ${error.message}` : error instanceof Error ? error.message : "unknown error";

const INCLUDE = ["configuration.recipient", "requirements"];

/** Finds the demo recipient accounts an earlier run created, by metadata. */
export async function findRecipients(api: StripeApi): Promise<Partial<Record<Role, RecipientAccount>>> {
  const found: Partial<Record<Role, RecipientAccount>> = {};
  let path: string | null = "/v2/core/accounts?applied_configurations=recipient&limit=20";
  for (let page = 0; path && page < 10; page++) {
    const list: z.infer<typeof AccountList> = AccountList.parse(await api.get(path, {}, { apiVersion: CONNECT_API_VERSION }));
    for (const account of list.data) {
      const role = account.metadata?.agentvault_role;
      if ((role === "supplier" || role === "attacker") && !found[role]) found[role] = account;
    }
    path = list.next_page_url ?? null;
  }
  return found;
}

/** Reads one account with its recipient configuration and requirements. */
export async function readRecipient(api: StripeApi, id: string): Promise<RecipientAccount> {
  // API v2 repeats a list parameter instead of indexing it.
  const query = INCLUDE.map((i) => `include=${encodeURIComponent(i)}`).join("&");
  const account = RecipientAccount.parse(await api.get(`/v2/core/accounts/${encodeURIComponent(id)}?${query}`, {}, { apiVersion: CONNECT_API_VERSION }));
  if (account.livemode) throw new Error(`Stripe returned a live-mode account ${account.id}; only test mode is allowed`);
  return account;
}

async function createRecipient(api: StripeApi, role: Role): Promise<RecipientAccount> {
  const account = RecipientAccount.parse(
    await api.postJson(
      "/v2/core/accounts",
      {
        contact_email: ROLES[role].email,
        display_name: ROLES[role].displayName,
        dashboard: "express",
        identity: { country: "ca" },
        defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
        configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
        metadata: { agentvault_role: role },
        include: INCLUDE,
      },
      { apiVersion: CONNECT_API_VERSION, idempotencyKey: `agentvault-connect-recipient-${role}-v1` },
    ),
  );
  if (account.livemode) throw new Error(`Stripe created a live-mode account ${account.id}; only test mode is allowed`);
  return account;
}

async function main() {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const fundAt = args.indexOf("--fund");
  const fund = fundAt >= 0 ? args[fundAt + 1] : undefined;
  const api = new StripeApi({ secretKey: loadStripeConfig().secretKey(), apiVersion: CONNECT_API_VERSION });

  const existing = await findRecipients(api);
  for (const role of Object.keys(ROLES) as Role[]) {
    try {
      const found = existing[role];
      const account = found ? await readRecipient(api, found.id) : await createRecipient(api, role);
      const status = transferStatus(account);
      console.log(`${role}: ${account.id} (${found ? "found" : "created"}), stripe_transfers ${status}`);
      if (status !== "active") {
        const link = AccountLink.parse(
          await api.postJson(
            "/v2/core/account_links",
            {
              account: account.id,
              use_case: {
                type: "account_onboarding",
                // The GA version takes no `configurations` here (400 invalid_fields); it onboards the account's own.
                account_onboarding: { return_url: "http://localhost:3000/settings", refresh_url: "http://localhost:3000/settings" },
              },
            },
            { apiVersion: CONNECT_API_VERSION },
          ),
        );
        console.log(`  finish onboarding with test data (link expires ${link.expires_at}):\n  ${link.url}`);
      }
    } catch (error) {
      console.log(`${role}: ${describeError(error)}`);
      process.exitCode = 1;
    }
  }

  if (fund !== undefined) {
    const amount = fromDecimalString(fund);
    try {
      // pm_card_bypassPending is the 4000000000000077 test card: the charge's funds are available at once.
      const pi = PaymentIntent.parse(
        await api.post("/v1/payment_intents", {
          amount: toRailUnits(amount, "stripe", "debit").toString(),
          currency: "usd",
          payment_method: "pm_card_bypassPending",
          confirm: "true",
          "automatic_payment_methods[enabled]": "true",
          "automatic_payment_methods[allow_redirects]": "never",
          description: "AgentVault demo: test funds for Connect payouts",
          "metadata[agentvault_seed]": "connect-funds",
          "expand[]": "latest_charge.balance_transaction",
        }),
      );
      if (pi.livemode) throw new Error("Stripe returned a live-mode payment; only test mode is allowed");
      const bt = pi.latest_charge?.balance_transaction;
      // Shows whether the charge stayed in USD or was converted to the platform's default currency.
      console.log(`fund ${toDisplay(amount)} USD: ${pi.id} ${pi.status}${bt ? `, settled as ${bt.amount} ${bt.currency.toUpperCase()} minor units (${bt.status})` : ""}`);
    } catch (error) {
      console.log(`fund: ${describeError(error)}`);
      process.exitCode = 1;
    }
  }

  try {
    const balance = Balance.parse(await api.get("/v1/balance"));
    // Stripe balances are integer minor units; shown as-is with the currency, not converted.
    console.log(`balance (${balance.livemode ? "LIVE" : "test mode"}) available: ${balance.available.map((b) => `${b.amount} ${b.currency.toUpperCase()} minor units`).join(", ") || "none"}`);
  } catch (error) {
    console.log(`balance: ${describeError(error)}`);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/connect-setup.ts")) void main();

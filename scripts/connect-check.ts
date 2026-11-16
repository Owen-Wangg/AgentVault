// `pnpm connect:check`: read-only checks that the Stripe sandbox behind
// STRIPE_SECRET_KEY can run payout-rails' Stripe Connect payouts (PO-22).
// It prints the account's country, its default currency, which currencies
// its balance holds, whether Connect answers, and whether the supplier and
// attacker recipient accounts exist and can receive transfers. It never
// creates or changes anything, and never prints the key.
import { z } from "zod";
import { checkStripeEnv } from "@/rails/config";
import { StripeApi, StripeApiError } from "@/rails/stripe-mpp/stripe-api";
import { CONNECT_API_VERSION, ROLES, type Role, findRecipients, readRecipient, transferStatus } from "./connect-setup";
import { loadLocalEnv } from "./lib/load-env";

const API_VERSION = CONNECT_API_VERSION;
const Account = z.object({ country: z.string(), default_currency: z.string(), livemode: z.boolean().optional() });
const Balance = z.object({
  livemode: z.boolean(),
  available: z.array(z.object({ currency: z.string() })),
  pending: z.array(z.object({ currency: z.string() })),
});
const AccountList = z.object({ data: z.array(z.unknown()) });

const describe = (error: unknown) =>
  error instanceof StripeApiError ? `${error.status}${error.code ? ` ${error.code}` : ""}${error.type ? ` (${error.type})` : ""}` : error instanceof Error ? error.message : "unknown error";

async function main() {
  loadLocalEnv();
  const key = checkStripeEnv().find((c) => c.name === "STRIPE_SECRET_KEY");
  if (key?.status !== "pass") {
    console.log(`STRIPE_SECRET_KEY ${key?.problem ?? "is not set up yet"}. See docs/SETUP.md, section 7, step 2.`);
    process.exitCode = 1;
    return;
  }
  const api = new StripeApi({ secretKey: process.env.STRIPE_SECRET_KEY ?? "", apiVersion: API_VERSION });

  try {
    const account = Account.parse(await api.get("/v1/account"));
    console.log(`Platform account: country ${account.country}, default currency ${account.default_currency.toUpperCase()}`);
  } catch (error) {
    console.log(`Couldn't read the account: ${describe(error)}`);
  }

  try {
    const balance = Balance.parse(await api.get("/v1/balance"));
    const list = (rows: { currency: string }[]) => [...new Set(rows.map((r) => r.currency.toUpperCase()))].join(", ") || "none";
    console.log(`Balance (${balance.livemode ? "LIVE" : "test mode"}): available in ${list(balance.available)}; pending in ${list(balance.pending)}`);
  } catch (error) {
    console.log(`Couldn't read the balance: ${describe(error)}`);
  }

  try {
    const accounts = AccountList.parse(await api.get("/v1/accounts", { limit: "3" }));
    console.log(`Connect: on. The sandbox has ${accounts.data.length === 0 ? "no connected accounts" : "connected accounts already"}.`);
  } catch (error) {
    console.log(`Connect: not available yet (${describe(error)}). Turn it on in the Dashboard: Connect > Get started.`);
    return;
  }

  // The payout-rails recipient accounts (PO-21), read-only: found by metadata, never created here.
  try {
    const found = await findRecipients(api);
    for (const role of Object.keys(ROLES) as Role[]) {
      const account = found[role];
      if (!account) {
        console.log(`${role} recipient account: not created yet. Run pnpm connect:setup (docs/SETUP.md, section 7, step 8).`);
        continue;
      }
      const status = transferStatus(await readRecipient(api, account.id));
      console.log(`${role} recipient account: ${account.id}, stripe_transfers ${status}${status === "active" ? "" : ". Finish onboarding: pnpm connect:setup prints a link."}`);
    }
  } catch (error) {
    console.log(`Couldn't read the recipient accounts: ${describe(error)}`);
  }
}
void main();

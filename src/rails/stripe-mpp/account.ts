import { z } from "zod";
import { type Micros, fromRailUnits } from "@/core/money";
import { PROFILE_API_VERSION, type StripeApi } from "./stripe-api";

/**
 * Stripe sandbox setup helpers for `pnpm stripe:profile` and `pnpm
 * stripe:seed` (rail-adapters task 6, docs/SETUP.md section 7).
 */

const Profile = z.object({
  id: z.string().regex(/^profile_\w+$/),
  username: z.string().nullish(),
  display_name: z.string().nullish(),
});

export interface OwnProfile {
  id: string;
  username: string | null;
  displayName: string | null;
}

/** The Stripe profile of the account the key belongs to: the MPP `networkId`. Read-only. */
export async function fetchOwnProfile(api: StripeApi): Promise<OwnProfile> {
  const p = Profile.parse(await api.get("/v2/network/business_profiles/me", {}, { apiVersion: PROFILE_API_VERSION }));
  return { id: p.id, username: p.username ?? null, displayName: p.display_name ?? null };
}

/** The demo billing payment the prompt-injection scenario's $480 refund targets. */
export const BILLING_SEED = {
  amountCents: 50_000n,
  metadataKey: "agentvault_seed",
  metadataValue: "billing-500",
  /** Stripe keeps idempotency keys for 24 hours; after that the search below finds the payment. */
  idempotencyKey: "agentvault-seed-billing-500-v1",
  description: "AgentVault demo: Nimbus Weather billing payment (refund scenario target)",
} as const;

const Charge = z.object({ amount_refunded: z.number().int().nonnegative() });
const PaymentIntent = z.object({
  id: z.string().regex(/^pi_\w+$/),
  object: z.literal("payment_intent"),
  status: z.string(),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  livemode: z.boolean(),
  latest_charge: z.union([z.string(), Charge]).nullish(),
});
const SearchResult = z.object({ data: z.array(PaymentIntent) });

export interface BillingPayment {
  id: string;
  status: string;
  amountMicros: Micros;
  refundedMicros: Micros;
  /** True if this run created it, false if it already existed. */
  created: boolean;
}

function toBilling(pi: z.infer<typeof PaymentIntent>, created: boolean): BillingPayment {
  if (pi.livemode) throw new Error("Stripe returned a live-mode payment; only test mode is allowed");
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge !== null ? pi.latest_charge : null;
  return {
    id: pi.id,
    status: pi.status,
    amountMicros: fromRailUnits(BigInt(pi.amount), "stripe"),
    refundedMicros: fromRailUnits(BigInt(charge?.amount_refunded ?? 0), "stripe"),
    created,
  };
}

/**
 * Find the seeded $500 test payment, or create it with the test card
 * (pm_card_visa). Running it again returns the same payment: within 24
 * hours through the idempotency key, after that through search.
 */
export async function findOrCreateBillingPayment(api: StripeApi): Promise<BillingPayment> {
  const query = `metadata['${BILLING_SEED.metadataKey}']:'${BILLING_SEED.metadataValue}'`;
  const found = SearchResult.parse(await api.get("/v1/payment_intents/search", { query, "expand[]": "data.latest_charge" }));
  const existing = found.data.find((pi) => pi.status === "succeeded" && BigInt(pi.amount) === BILLING_SEED.amountCents);
  if (existing) return toBilling(existing, false);
  const created = PaymentIntent.parse(
    await api.post(
      "/v1/payment_intents",
      {
        amount: BILLING_SEED.amountCents.toString(),
        currency: "usd",
        payment_method: "pm_card_visa",
        confirm: "true",
        "automatic_payment_methods[enabled]": "true",
        "automatic_payment_methods[allow_redirects]": "never",
        description: BILLING_SEED.description,
        [`metadata[${BILLING_SEED.metadataKey}]`]: BILLING_SEED.metadataValue,
        "expand[]": "latest_charge",
      },
      { idempotencyKey: BILLING_SEED.idempotencyKey },
    ),
  );
  return toBilling(created, true);
}

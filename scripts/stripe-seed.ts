// `pnpm stripe:seed`: create the $500 test payment that the
// prompt-injection scenario's $480 refund targets, or find the one made
// earlier (rail-adapters task 6, docs/SETUP.md section 7). Test mode
// only: it refuses to run without a sk_test_ key. The key is never printed.
import { toDisplay } from "@/core/money";
import { checkStripeEnv } from "@/rails/config";
import { findOrCreateBillingPayment } from "@/rails/stripe-mpp/account";
import { StripeApi } from "@/rails/stripe-mpp/stripe-api";
import { loadLocalEnv } from "./lib/load-env";

async function main() {
  loadLocalEnv();
  const key = checkStripeEnv().find((c) => c.name === "STRIPE_SECRET_KEY");
  if (key?.status !== "pass") {
    console.log(`STRIPE_SECRET_KEY ${key?.problem ?? "is not set up yet"}. See docs/SETUP.md, section 7, step 2.`);
    process.exitCode = 1;
    return;
  }
  try {
    const payment = await findOrCreateBillingPayment(new StripeApi({ secretKey: process.env.STRIPE_SECRET_KEY ?? "" }));
    console.log(`${payment.created ? "Created" : "Found"} the billing payment ${payment.id}`);
    console.log(`  ${toDisplay(payment.amountMicros)}, ${payment.status}, ${toDisplay(payment.refundedMicros)} refunded so far`);
    console.log(`  https://dashboard.stripe.com/test/payments/${payment.id}`);
  } catch (error) {
    console.log(`Couldn't seed the payment: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

void main();

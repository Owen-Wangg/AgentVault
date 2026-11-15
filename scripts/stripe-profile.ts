// `pnpm stripe:profile`: print the Stripe profile ID of the sandbox that
// STRIPE_SECRET_KEY belongs to, for STRIPE_PROFILE_ID (docs/SETUP.md,
// section 7). The profile ID is a public identifier. The key is never
// printed. It only reads from Stripe.
import { checkStripeEnv } from "@/rails/config";
import { fetchOwnProfile } from "@/rails/stripe-mpp/account";
import { StripeApi, StripeApiError } from "@/rails/stripe-mpp/stripe-api";
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
    const profile = await fetchOwnProfile(new StripeApi({ secretKey: process.env.STRIPE_SECRET_KEY ?? "" }));
    console.log(`Stripe profile${profile.username ? ` @${profile.username}` : ""}${profile.displayName ? ` (${profile.displayName})` : ""}`);
    console.log(`  ID: ${profile.id}`);
    if (!profile.id.startsWith("profile_test_")) console.log("  This isn't a sandbox profile. Switch the Dashboard to your sandbox and use its key.");
    else console.log("  Put the ID in .env.local as STRIPE_PROFILE_ID.");
  } catch (error) {
    if (error instanceof StripeApiError && error.status === 404) {
      console.log("This sandbox has no Stripe profile yet. Create one first (docs/SETUP.md, section 7, step 3).");
    } else {
      console.log(`Couldn't read the profile: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    process.exitCode = 1;
  }
}

void main();

// `pnpm mpp:validate [origin]`: run `mppx validate` against the demo
// vendor (RAIL-18, the /validate-mpp steering command). It runs the mppx
// installed from the lock file (pinned in package.json), not whatever the
// registry serves as latest, because the validator gets a Stripe key. The
// validator only completes its test-mode payment when it has a Stripe test
// key in MPPX_STRIPE_SECRET_KEY, so this passes STRIPE_SECRET_KEY from
// .env.local to it through the child's environment, without printing it.
// It refuses anything but a sk_test_ key (RAIL-7).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkStripeEnv } from "@/rails/config";
import { loadLocalEnv } from "./lib/load-env";

/** The installed mppx CLI. Run with this Node binary, so no shell is involved. */
const MPPX_BIN = fileURLToPath(new URL("../node_modules/mppx/dist/bin.js", import.meta.url));

function main() {
  loadLocalEnv();
  const target = process.argv[2] ?? "http://localhost:3000";
  // Only a plain http(s) origin: the validator finds /vendor/api/report through /openapi.json.
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(target)) {
    console.log("Give an origin such as http://localhost:3000, with no path. The validator finds /vendor/api/report through /openapi.json.");
    process.exitCode = 2;
    return;
  }
  if (!existsSync(MPPX_BIN)) {
    console.log("mppx is not installed. Run pnpm install first.");
    process.exitCode = 2;
    return;
  }
  const key = checkStripeEnv().find((c) => c.name === "STRIPE_SECRET_KEY");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (key?.status === "pass") env.MPPX_STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  else console.log(`STRIPE_SECRET_KEY ${key?.problem ?? "is not set"}; the validator will skip the payment step.`);
  const child = spawn(process.execPath, [MPPX_BIN, "validate", target], { stdio: "inherit", env });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

main();

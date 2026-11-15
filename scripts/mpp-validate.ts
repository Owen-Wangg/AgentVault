// `pnpm mpp:validate [origin]`: run `npx mppx@latest validate` against
// the demo vendor (RAIL-18, the /validate-mpp steering command). The
// validator only completes its test-mode payment when it has a Stripe test
// key in MPPX_STRIPE_SECRET_KEY, so this passes STRIPE_SECRET_KEY from
// .env.local to it through the child's environment, without printing it.
// It refuses anything but a sk_test_ key (RAIL-7).
import { spawn } from "node:child_process";
import { checkStripeEnv } from "@/rails/config";
import { loadLocalEnv } from "./lib/load-env";

function main() {
  loadLocalEnv();
  const target = process.argv[2] ?? "http://localhost:3000";
  // The URL reaches a shell on Windows (npx is a .cmd file), so only a plain http(s) origin is accepted.
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(target)) {
    console.log("Give an origin such as http://localhost:3000, with no path. The validator finds /vendor/api/report through /openapi.json.");
    process.exitCode = 2;
    return;
  }
  const key = checkStripeEnv().find((c) => c.name === "STRIPE_SECRET_KEY");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (key?.status === "pass") env.MPPX_STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  else console.log(`STRIPE_SECRET_KEY ${key?.problem ?? "is not set"}; the validator will skip the payment step.`);
  const child = spawn("npx", ["--yes", "mppx@latest", "validate", target], { stdio: "inherit", shell: process.platform === "win32", env });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

main();

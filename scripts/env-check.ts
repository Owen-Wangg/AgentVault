// `pnpm env:check`: validate the environment and print pass, fail, or
// unset for each variable. Values are never printed (RAIL-9), so it is
// safe to run where output is shared, such as the /validate-mpp steering
// command. Exits 1 if anything fails.
import { checkRailEnv, checkStripeEnv, checkX402Env } from "@/rails/config";
import { env, isPlaceholder, resetEnvCache } from "@/server/env";
import { loadLocalEnv } from "./lib/load-env";

interface Line {
  name: string;
  status: "pass" | "fail" | "unset" | "skipped";
  problem?: string;
  note?: string;
}

/** Server variables: run each getter and keep only its outcome. */
function checkServerEnv(): Line[] {
  const getters: [string, () => unknown, boolean][] = [
    ["DATABASE_URL", env.databaseUrl, true],
    ["AUDIT_HEAD_KEY", env.auditHeadKey, true],
    ["CRON_SECRET", env.cronSecret, true],
    ["APP_ORIGIN", env.appOrigin, false],
    // GitHub sign-in is optional; githubAuthConfigured() validates whichever of the three are set.
    ["AUTH_SECRET", env.githubAuthConfigured, false],
    ["AUTH_GITHUB_ID", env.githubAuthConfigured, false],
    ["AUTH_GITHUB_SECRET", env.githubAuthConfigured, false],
  ];
  return getters.map(([name, get, required]) => {
    if (!process.env[name] && !required) return { name, status: "unset" };
    if (name.startsWith("AUTH_") && isPlaceholder(process.env[name])) return { name, status: "unset", note: "still the .env.example placeholder; GitHub sign-in is off" };
    try {
      get();
      return { name, status: "pass" };
    } catch (error) {
      // EnvError messages name the variable and the problem, never the value.
      const problem = error instanceof Error ? error.message.replace(/^Environment variable \S+ /, "").replace(/\. See \.env\.example\.$/, "") : "is invalid";
      return { name, status: "fail", problem };
    }
  });
}

/**
 * The optional live Gemini agent: presence and format only. It never
 * calls Gemini; `pnpm gemini:probe` does that. A key that's set but
 * malformed fails, like any other invalid variable.
 */
export function checkGeminiEnv(): Line[] {
  resetEnvCache();
  const check = (name: string, get: () => unknown, unsetNote: string): Line => {
    if (!process.env[name] || isPlaceholder(process.env[name])) return { name, status: "unset", note: unsetNote };
    try {
      get();
      return { name, status: "pass" };
    } catch (error) {
      const problem = error instanceof Error ? error.message.replace(/^Environment variable \S+ /, "").replace(/\. See \.env\.example\.$/, "") : "is invalid";
      return { name, status: "fail", problem };
    }
  };
  return [
    check("GEMINI_API_KEY", env.geminiApiKey, "the live agent is off"),
    check("GEMINI_MODEL", env.geminiModel, "defaults to gemini-3.5-flash-lite"),
  ];
}

export function runEnvCheck(): Line[] {
  resetEnvCache();
  return [...checkServerEnv(), ...checkRailEnv()];
}

/**
 * The x402 variables checked as if RAIL_MODE=real (docs/SETUP.md, "x402
 * test payments"). Informational: it doesn't change the exit code, because
 * mock mode doesn't need them.
 */
function runX402Check(): { lines: Line[]; ready: boolean } {
  const lines = checkX402Env();
  return { lines, ready: lines.every((l) => l.status === "pass" || (l.status === "unset" && (l.name === "X402_NETWORK" || l.name === "X402_MIN_UNITS"))) };
}

function print(lines: Line[]) {
  const width = Math.max(...lines.map((l) => l.name.length));
  for (const l of lines) console.log(`${l.name.padEnd(width)}  ${l.status.toUpperCase()}${l.problem ? `  ${l.problem}` : ""}${l.note ? `  (${l.note})` : ""}`);
}

function main() {
  loadLocalEnv();
  const lines = runEnvCheck();
  print(lines);
  const failed = lines.filter((l) => l.status === "fail").length;
  console.log(failed === 0 ? "Environment OK." : `${failed} variable(s) failed.`);
  const x402 = runX402Check();
  console.log("");
  console.log("x402 on Base Sepolia (checked as if RAIL_MODE=real):");
  print(x402.lines);
  console.log(x402.ready ? "x402 ready." : "x402 not ready. See docs/SETUP.md, section 6.");
  const stripe = checkStripeEnv();
  console.log("");
  console.log("Stripe test mode (checked as if RAIL_MODE=real):");
  print(stripe);
  console.log(stripe.every((l) => l.status === "pass") ? "Stripe ready." : "Stripe not ready. See docs/SETUP.md, section 7.");
  const gemini = checkGeminiEnv();
  console.log("");
  console.log("Live Gemini agent (optional, format only; pnpm gemini:probe calls Gemini):");
  print(gemini);
  const geminiFailed = gemini.filter((l) => l.status === "fail").length;
  const key = gemini[0];
  console.log(geminiFailed > 0 ? "Gemini not ready. See docs/SETUP.md, section 8." : key?.status === "pass" ? "Gemini ready." : "Gemini off.");
  if (failed + geminiFailed > 0) process.exitCode = 1;
}

main();

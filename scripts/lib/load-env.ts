import { existsSync } from "node:fs";

/**
 * CLI scripts run outside Next.js, which normally loads .env.local. Load
 * it here if it exists. Variables already set in the shell win, as in
 * Next.js. Values are never printed.
 */
export function loadLocalEnv(file = ".env.local"): void {
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

// `pnpm env:check`: validate the environment and print pass, fail, or
// unset for each variable. Values are never printed (RAIL-9), so it is
// safe to run where output is shared, such as the /validate-mpp steering
// command. Exits 1 if anything fails.
import { checkRailEnv } from "@/rails/config";
import { env, resetEnvCache } from "@/server/env";
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
  ];
  return getters.map(([name, get, required]) => {
    if (!process.env[name] && !required) return { name, status: "unset" };
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

export function runEnvCheck(): Line[] {
  resetEnvCache();
  return [...checkServerEnv(), ...checkRailEnv()];
}

function main() {
  loadLocalEnv();
  const lines = runEnvCheck();
  const width = Math.max(...lines.map((l) => l.name.length));
  for (const l of lines) console.log(`${l.name.padEnd(width)}  ${l.status.toUpperCase()}${l.problem ? `  ${l.problem}` : ""}${l.note ? `  (${l.note})` : ""}`);
  const failed = lines.filter((l) => l.status === "fail").length;
  console.log(failed === 0 ? "Environment OK." : `${failed} variable(s) failed.`);
  if (failed > 0) process.exitCode = 1;
}

main();

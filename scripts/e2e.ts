// `pnpm test:e2e [playwright args]`: the end-to-end test (telemetry-dashboard
// task 7). It never touches the main database:
// 1. creates a throwaway database on the DATABASE_URL_TEST server (the Neon
//    test branch), migrates it, and seeds a sandbox, signed with a random
//    audit head key made for this run;
// 2. runs Playwright, whose web server is `next dev` pointed at that database
//    and key (dev mode, so the injection scenario may fetch its docs page
//    from localhost, TAINT-2);
// 3. drops the database, whatever happened.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import { createDb, guardConnectionErrors } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetSandbox } from "@/server/sandbox/sandbox";

export const E2E_ORIGIN = "http://localhost:3100";

/** Only DATABASE_URL_TEST is read from .env.local, as in vitest.config.ts. */
function testServerUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const fromFile = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")).DATABASE_URL_TEST : undefined;
  if (!fromFile) throw new Error("Set DATABASE_URL_TEST (a Neon test branch or local Postgres). End-to-end tests never use DATABASE_URL.");
  return fromFile;
}

function runPlaywright(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    // shell: true so Windows finds pnpm.cmd. The arguments are this script's own, not request data.
    const child = spawn("pnpm", ["exec", "playwright", "test", ...args], { stdio: "inherit", env, shell: true });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main(): Promise<number> {
  const serverUrl = testServerUrl();
  const name = `agentvault_e2e_${randomBytes(6).toString("hex")}`;
  const admin = guardConnectionErrors(new pg.Client({ connectionString: serverUrl }));
  await admin.connect();
  try {
    // The name is generated above from hex digits only, so it is safe to quote here.
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      const url = new URL(serverUrl);
      url.pathname = `/${name}`;
      const databaseUrl = url.toString();
      const key = randomBytes(32);
      await runMigrations(databaseUrl);
      const database = createDb(databaseUrl);
      try {
        await resetSandbox(database.db, { key, appOrigin: E2E_ORIGIN });
      } finally {
        await database.close();
      }
      console.log(`e2e: database ${name} ready`);
      return await runPlaywright(
        { ...process.env, E2E_DATABASE_URL: databaseUrl, E2E_AUDIT_HEAD_KEY: key.toString("base64"), E2E_ORIGIN },
        process.argv.slice(2),
      );
    } finally {
      // FORCE ends the dev server's connections if it hasn't closed them yet.
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      console.log(`e2e: database ${name} dropped`);
    }
  } finally {
    await admin.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(`e2e setup failed${typeof code === "string" ? ` ${code}` : ""}:`, error instanceof Error ? error.message : "unknown error");
    process.exit(1);
  },
);

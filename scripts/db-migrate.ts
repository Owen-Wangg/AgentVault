// `pnpm db:migrate`: apply the SQL migrations in src/server/db/migrations
// to DATABASE_URL. Safe to run more than once: applied migrations are
// recorded in the drizzle.__drizzle_migrations table and skipped.
import { runMigrations } from "@/server/db/migrate";
import { env } from "@/server/env";
import { loadLocalEnv } from "./lib/load-env";

async function main() {
  loadLocalEnv();
  const url = env.databaseUrl();
  await runMigrations(url);
  console.log(`Migrations applied to ${new URL(url).host}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration failed.");
  process.exit(1);
});

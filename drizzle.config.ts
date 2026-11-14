import { defineConfig } from "drizzle-kit";

// Used by `pnpm db:generate`, which writes SQL migrations from the schema.
// Generating needs no database connection. Migrations are applied by
// `pnpm db:migrate` (scripts/db-migrate.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/migrations",
});

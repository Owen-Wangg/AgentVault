import { fileURLToPath } from "node:url";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { isNeonUrl } from "./client";

/**
 * Applying migrations, kept out of client.ts so that app routes never
 * bundle the migrations folder. Only scripts and tests import this.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** Apply every pending migration in src/server/db/migrations to the database at `url`. */
export async function runMigrations(url: string): Promise<void> {
  if (isNeonUrl(url)) {
    const pool = new NeonPool({ connectionString: url });
    try {
      await migrateNeon(drizzleNeon(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await pool.end();
    }
    return;
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

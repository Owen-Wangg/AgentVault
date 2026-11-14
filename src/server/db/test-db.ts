import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { type Database, type Db, MIGRATIONS_FOLDER, createDb } from "./client";
import * as schema from "./schema";

/**
 * A fresh, fully migrated database for one integration test file. Only
 * tests import this.
 *
 * - With DATABASE_URL_TEST set (a Neon branch or Docker Postgres), it
 *   creates a throwaway database on that server and drops it on close, so
 *   tests that drop triggers can't affect anything else.
 * - Without it, it uses PGlite: real Postgres compiled to WebAssembly,
 *   running in memory. It runs the same migrations, triggers, and
 *   plpgsql, but it has a single connection, so it can't test concurrency.
 */
export async function createTestDb(): Promise<Database & { driver: "postgres" | "pglite" }> {
  const url = process.env.DATABASE_URL_TEST;
  if (url) return { ...(await throwawayDatabase(url)), driver: "postgres" };
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  const database: Database = {
    db: db as unknown as Db,
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
  await database.migrate();
  return { ...database, driver: "pglite" };
}

/**
 * Await a query that must fail, and return the database's own error
 * message. Drizzle wraps driver errors in "Failed query: ...", with the
 * original as `cause`.
 */
export async function queryError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the query to fail, but it succeeded");
}

async function throwawayDatabase(url: string): Promise<Database> {
  const name = `agentvault_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  // The name is generated above from hex digits only, so it is safe to quote here.
  await admin.query(`CREATE DATABASE "${name}"`);
  const testUrl = new URL(url);
  testUrl.pathname = `/${name}`;
  const database = createDb(testUrl.toString());
  await database.migrate();
  return {
    db: database.db,
    migrate: database.migrate,
    close: async () => {
      await database.close();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

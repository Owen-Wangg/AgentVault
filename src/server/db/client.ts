import { fileURLToPath } from "node:url";
import { Pool as NeonPool } from "@neondatabase/serverless";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
/** A database handle from any of the supported drivers. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** An open transaction. Functions that must run inside the caller's transaction take this. */
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export interface Database {
  db: Db;
  /** Apply the SQL migrations in src/server/db/migrations. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Run raw SQL and return its rows. node-postgres, Neon, and PGlite all
 * return `{ rows }`, but the driver-neutral `Db` type can't say so.
 */
export async function queryRows<T>(db: Db | Tx, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

function isNeon(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

/**
 * Connect to Postgres. Neon uses its serverless driver in Pool (WebSocket)
 * mode, which supports transactions (tech.md). Any other host, such as
 * Docker Postgres on localhost, uses node-postgres. On Vercel, create one
 * per request and close it when the request ends.
 */
export function createDb(url: string): Database {
  if (isNeon(url)) {
    const pool = new NeonPool({ connectionString: url });
    const db = drizzleNeon(pool, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migrateNeon(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => pool.end(),
    };
  }
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzlePg(pool, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => pool.end(),
  };
}

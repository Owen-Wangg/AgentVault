import { Pool as NeonPool } from "@neondatabase/serverless";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
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

/** The part of a pool or client this module needs: something that emits "error". */
interface ErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Handle errors on idle connections, such as Neon closing a connection
 * when it scales to zero or a database being dropped. Without a listener,
 * Node treats the "error" event as an uncaught exception and crashes.
 * Only the code and message are logged: driver error objects reference
 * their client, whose connection settings include the password.
 */
export function guardConnectionErrors<T extends ErrorEmitter>(emitter: T): T {
  emitter.on("error", (error) => {
    const code = (error as { code?: unknown }).code;
    console.error(`Database connection error${typeof code === "string" ? ` ${code}` : ""}: ${error.message}`);
  });
  return emitter;
}

export function isNeonUrl(url: string): boolean {
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
  if (isNeonUrl(url)) {
    const pool = guardConnectionErrors(new NeonPool({ connectionString: url }));
    return { db: drizzleNeon(pool, { schema }) as unknown as Db, close: () => pool.end() };
  }
  const pool = guardConnectionErrors(new pg.Pool({ connectionString: url }));
  return { db: drizzlePg(pool, { schema }) as unknown as Db, close: () => pool.end() };
}

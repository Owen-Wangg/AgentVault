import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { MIGRATIONS_FOLDER } from "@/server/db/migrate";
import { accounts, users } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";

let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

// The migration runs once when the database is created, before any account exists, so the test runs its SQL again on rows it made.
const MIGRATION = readFileSync(join(MIGRATIONS_FOLDER, "0007_clear_oauth_tokens.sql"), "utf8");

describe("migration 0007: clear stored GitHub tokens", () => {
  it("UI-2: removes the provider tokens that earlier sign-ins stored, and keeps the rest of the account", async () => {
    const db = database.db;
    await db.insert(users).values({ id: "u-old", email: "old@example.com" });
    await db.insert(accounts).values({
      userId: "u-old",
      type: "oauth",
      provider: "github",
      providerAccountId: "1",
      access_token: "gho_old",
      refresh_token: "ghr_old",
      id_token: "id_old",
      token_type: "bearer",
      scope: "read:user",
    });

    await db.execute(sql.raw(MIGRATION));

    const [row] = await db.select().from(accounts).where(eq(accounts.userId, "u-old"));
    expect(row).toMatchObject({ provider: "github", providerAccountId: "1", token_type: "bearer", scope: "read:user" });
    expect([row?.access_token, row?.refresh_token, row?.id_token]).toEqual([null, null, null]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import type { Database } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import { currentSandbox } from "@/server/sandbox/sandbox";
import { hasCronSecret } from "./auth";
import { type SandboxResetDeps, handleSandboxReset } from "./sandbox-reset";

const SECRET = "test-cron-secret-that-is-long-enough-123";
let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

/** The handler closes the database it opens, so give it a handle whose close is a no-op. */
const deps = (overrides: Partial<SandboxResetDeps> = {}): SandboxResetDeps => ({
  cronSecret: () => SECRET,
  openDb: () => ({ ...database, close: async () => {} }),
  options: { key: TEST_HEAD_KEY, appOrigin: "https://agentvault.example" },
  ...overrides,
});

const request = (authorization?: string) =>
  new Request("https://agentvault.example/api/cron/sandbox-reset", authorization ? { headers: { authorization } } : {});

describe("AUD-9: GET /api/cron/sandbox-reset", () => {
  it.each([
    ["no header", undefined],
    ["the wrong secret", "Bearer not-the-secret"],
    ["the secret without Bearer", SECRET],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, -1)}`],
  ])("AUD-9: returns 401 with %s and resets nothing", async (_name, header) => {
    const before = await currentSandbox(database.db);
    const response = await handleSandboxReset(request(header), deps());
    expect(response.status).toBe(401);
    expect(await currentSandbox(database.db)).toEqual(before);
  });

  it("AUD-9: fails closed with 503 when CRON_SECRET isn't configured", async () => {
    const response = await handleSandboxReset(
      request(`Bearer ${SECRET}`),
      deps({
        cronSecret: () => {
          throw new Error("not set");
        },
      }),
    );
    expect(response.status).toBe(503);
  });

  it("AUD-9: resets the sandbox with the right secret", async () => {
    const response = await handleSandboxReset(request(`Bearer ${SECRET}`), deps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspace_id: string };
    expect((await currentSandbox(database.db))?.id).toBe(body.workspace_id);
  });

  it("PXY-7: a database failure returns a generic 503", async () => {
    const response = await handleSandboxReset(
      request(`Bearer ${SECRET}`),
      deps({
        openDb: () => {
          throw new Error("connection refused at db.internal:5432");
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("db.internal");
  });
});

describe("cron secret check", () => {
  it("matches only the exact bearer header", () => {
    const req = (h: string) => new Request("https://x.example", { headers: { authorization: h } });
    expect(hasCronSecret(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(hasCronSecret(req(`bearer ${SECRET}`), SECRET)).toBe(false);
    expect(hasCronSecret(req(`Bearer ${SECRET}x`), SECRET)).toBe(false);
    // Fetch trims surrounding whitespace from header values, so "Bearer <secret> " never reaches the check.
  });
});

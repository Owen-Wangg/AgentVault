import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * vercel.json's cron entries (telemetry-dashboard task 9). Vercel Hobby
 * rejects a deployment whose cron runs more than once a day (tech.md), so
 * each schedule must be one fixed minute and hour, every day.
 */

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const config = JSON.parse(readFileSync(root("vercel.json"), "utf8")) as { regions: string[]; crons: { path: string; schedule: string }[] };

describe("vercel.json", () => {
  it("UI-3: the sandbox resets nightly, and the reconciler runs daily", () => {
    expect(config.crons.map((c) => c.path).sort()).toEqual(["/api/cron/reconcile", "/api/cron/sandbox-reset"]);
  });

  it("UI-3: every cron runs at most once a day, so Hobby accepts the deployment", () => {
    for (const { schedule } of config.crons) {
      const [minute, hour, ...rest] = schedule.split(" ");
      expect(minute).toMatch(/^\d{1,2}$/);
      expect(hour).toMatch(/^\d{1,2}$/);
      expect(rest).toEqual(["*", "*", "*"]);
    }
  });

  it("every cron path has a route handler", () => {
    for (const { path } of config.crons) expect(existsSync(root(`app${path}/route.ts`))).toBe(true);
  });

  it("functions run in pdx1, next to the database in us-west-2 (tech.md)", () => {
    expect(config.regions).toEqual(["pdx1"]);
  });
});

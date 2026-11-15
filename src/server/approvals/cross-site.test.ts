import { describe, expect, it } from "vitest";
import { type HumanRouteDeps, handleApprovalAction, handleListApprovals, handleUnfreeze, isCrossSite } from "./handlers";

const URL_BASE = "https://agentvault.example";
const ID = "00000000-0000-4000-8000-000000000000";

const post = (path: string, headers: Record<string, string>) =>
  new Request(`${URL_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action: "approve" }) });

/** Deps whose database must never be opened. */
const untouchable = {
  openDb: () => {
    throw new Error("must not open the database");
  },
} as unknown as HumanRouteDeps;

describe("cross-site requests on human routes", () => {
  it("UI-2: a POST from another origin, or one the browser marks cross-site, is cross-site", () => {
    expect(isCrossSite(post("/x", { origin: "https://evil.example" }))).toBe(true);
    expect(isCrossSite(post("/x", { origin: "null" }))).toBe(true);
    expect(isCrossSite(post("/x", { origin: "https://agentvault.example.evil.example" }))).toBe(true);
    expect(isCrossSite(post("/x", { "sec-fetch-site": "cross-site" }))).toBe(true);
  });

  it("UI-2: same-origin POSTs, POSTs without Origin, and GETs are not", () => {
    expect(isCrossSite(post("/x", { origin: URL_BASE, "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossSite(post("/x", {}))).toBe(false);
    expect(isCrossSite(new Request(`${URL_BASE}/x`, { headers: { origin: "https://evil.example" } }))).toBe(false);
  });

  it("UI-2: approve, deny, and unfreeze refuse a cross-site POST with 403 before the database is opened", async () => {
    const evil = { origin: "https://evil.example" };
    for (const response of [
      await handleApprovalAction(post(`/api/v1/approvals/${ID}`, evil), ID, untouchable),
      await handleUnfreeze(post(`/api/v1/agents/${ID}/unfreeze`, evil), ID, untouchable),
    ]) {
      expect([response.status, await response.json()]).toEqual([403, { error: "CROSS_ORIGIN" }]);
    }
    // Reads are not state-changing, so the list doesn't apply the check (it fails later, on the database).
    const list = await handleListApprovals(new Request(`${URL_BASE}/api/v1/approvals`, { headers: evil }), untouchable);
    expect(list.status).toBe(503);
  });
});

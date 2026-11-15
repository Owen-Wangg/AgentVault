import { describe, expect, it } from "vitest";
import { type ScenarioRouteDeps, handleRunScenario } from "./handler";

const URL_BASE = "https://agentvault.example";

/** Deps whose database must never be opened. */
const untouchable = {
  openDb: () => {
    throw new Error("must not open the database");
  },
} as unknown as ScenarioRouteDeps;

const post = (headers: Record<string, string>) =>
  new Request(`${URL_BASE}/api/v1/scenarios/normal/run`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

describe("POST /api/v1/scenarios/:name/run before the database", () => {
  it("HITL-10: any Authorization header is 403, so an agent key can't start runs", async () => {
    const response = await handleRunScenario(post({ authorization: `Bearer av_test_${"a".repeat(43)}` }), "normal", untouchable);
    expect([response.status, await response.json()]).toEqual([403, { error: "AGENT_KEY_FORBIDDEN" }]);
  });

  it("UI-2: a cross-site POST is 403, so another site can't start runs from a visitor's browser", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await handleRunScenario(post(headers), "normal", untouchable);
      expect([response.status, await response.json()]).toEqual([403, { error: "CROSS_ORIGIN" }]);
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";

const auth = vi.fn();
vi.mock("./auth", () => ({ auth }));

const { getSessionUser } = await import("./session");

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
  auth.mockReset();
});

function configure(on: boolean) {
  for (const [name, value] of [
    ["AUTH_SECRET", "s".repeat(32)],
    ["AUTH_GITHUB_ID", "Iv1.test"],
    ["AUTH_GITHUB_SECRET", "test-secret"],
  ] as const) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
  resetEnvCache();
}

describe("getSessionUser", () => {
  it("UI-2: is null without GitHub sign-in configured, and doesn't load Auth.js", async () => {
    configure(false);
    expect(await getSessionUser()).toBeNull();
    expect(auth).not.toHaveBeenCalled();
  });

  it("UI-2: returns the Auth.js user ID and name", async () => {
    configure(true);
    auth.mockResolvedValue({ user: { id: "user-1", name: "Owen" }, expires: "2026-12-01T00:00:00.000Z" });
    expect(await getSessionUser()).toEqual({ id: "user-1", name: "Owen" });
  });

  it("HITL-11: no session, or a session without a user ID, is nobody", async () => {
    configure(true);
    auth.mockResolvedValue(null);
    expect(await getSessionUser()).toBeNull();
    auth.mockResolvedValue({ user: { name: "no id" }, expires: "2026-12-01T00:00:00.000Z" });
    expect(await getSessionUser()).toBeNull();
    auth.mockResolvedValue({ user: { id: "" }, expires: "2026-12-01T00:00:00.000Z" });
    expect(await getSessionUser()).toBeNull();
  });
});

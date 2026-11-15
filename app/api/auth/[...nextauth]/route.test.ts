import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";

// next-auth imports "next/server" without an extension, which Node's ESM
// loader rejects under Vitest. These tests only need to know whether the
// Auth.js handlers are reached.
const handlers = { GET: vi.fn(async () => new Response("auth.js")), POST: vi.fn(async () => new Response("auth.js")) };
vi.mock("@/server/auth/auth", () => ({ handlers }));
const { GET, POST } = await import("./route");

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe("/api/auth/*", () => {
  it("UI-2: answers 404 while GitHub sign-in isn't configured, even with the .env.example placeholders", async () => {
    process.env.AUTH_SECRET = "replace-with-32-random-bytes-base64";
    process.env.AUTH_GITHUB_ID = "your-github-oauth-client-id";
    process.env.AUTH_GITHUB_SECRET = "your-github-oauth-client-secret";
    resetEnvCache();
    const get = await GET(new NextRequest("http://localhost:3000/api/auth/providers"));
    expect(get.status).toBe(404);
    const post = await POST(new NextRequest("http://localhost:3000/api/auth/signin/github", { method: "POST" }));
    expect(post.status).toBe(404);
    expect(handlers.GET).not.toHaveBeenCalled();
    expect(handlers.POST).not.toHaveBeenCalled();
  });

  it("UI-2: hands requests to Auth.js once sign-in is configured", async () => {
    process.env.AUTH_SECRET = "s".repeat(32);
    process.env.AUTH_GITHUB_ID = "Iv1.test";
    process.env.AUTH_GITHUB_SECRET = "test-secret";
    resetEnvCache();
    expect(await (await GET(new NextRequest("http://localhost:3000/api/auth/providers"))).text()).toBe("auth.js");
    expect(handlers.GET).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { EnvError, env, resetEnvCache } from "./env";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

function set(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEnvCache();
}

describe("AUD-7: AUDIT_HEAD_KEY", () => {
  it("AUD-7: accepts 32 bytes in base64 or base64url", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7));
    set("AUDIT_HEAD_KEY", bytes.toString("base64"));
    expect(Buffer.from(env.auditHeadKey()).equals(bytes)).toBe(true);
    set("AUDIT_HEAD_KEY", bytes.toString("base64url"));
    expect(Buffer.from(env.auditHeadKey()).equals(bytes)).toBe(true);
  });

  it.each([16, 31, 33, 64])("AUD-7: rejects a %s-byte key", (n) => {
    set("AUDIT_HEAD_KEY", Buffer.alloc(n, 1).toString("base64"));
    expect(() => env.auditHeadKey()).toThrow("exactly 32 bytes");
  });

  it("AUD-7: rejects a missing or non-base64 key", () => {
    set("AUDIT_HEAD_KEY", undefined);
    expect(() => env.auditHeadKey()).toThrow("AUDIT_HEAD_KEY is not set");
    set("AUDIT_HEAD_KEY", "replace-with-32-random-bytes-base64!");
    expect(() => env.auditHeadKey()).toThrow(EnvError);
  });

  it("AUD-5: error messages never contain the value", () => {
    const secret = Buffer.alloc(20, 9).toString("base64");
    set("AUDIT_HEAD_KEY", secret);
    expect(() => env.auditHeadKey()).toThrow();
    try {
      env.auditHeadKey();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("environment variables", () => {
  it("rejects a short CRON_SECRET", () => {
    set("CRON_SECRET", "short");
    expect(() => env.cronSecret()).toThrow("at least 32 characters");
  });

  it("rejects a DATABASE_URL that isn't a postgres URL", () => {
    set("DATABASE_URL", "mysql://x");
    expect(() => env.databaseUrl()).toThrow("DATABASE_URL");
  });

  it("UI-2: GitHub sign-in is configured only when the secret and both GitHub values are set", () => {
    set("AUTH_SECRET", "s".repeat(32));
    set("AUTH_GITHUB_ID", "Iv1.abc");
    set("AUTH_GITHUB_SECRET", undefined);
    expect(env.githubAuthConfigured()).toBe(false);
    set("AUTH_GITHUB_SECRET", "shh");
    expect(env.githubAuthConfigured()).toBe(true);
    set("AUTH_SECRET", "");
    expect(env.githubAuthConfigured()).toBe(false);
  });

  it("UI-2: the .env.example placeholders count as unset, so a copied example file leaves sign-in off", () => {
    set("AUTH_SECRET", "replace-with-32-random-bytes-base64");
    set("AUTH_GITHUB_ID", "your-github-oauth-client-id");
    set("AUTH_GITHUB_SECRET", "your-github-oauth-client-secret");
    expect(env.githubAuthConfigured()).toBe(false);
    set("AUTH_SECRET", "s".repeat(32));
    set("AUTH_GITHUB_SECRET", "real-secret");
    expect(env.githubAuthConfigured()).toBe(false);
    set("AUTH_GITHUB_ID", "Iv1.real");
    expect(env.githubAuthConfigured()).toBe(true);
  });

  it("UI-2: an invalid AUTH_ value turns sign-in off instead of throwing", () => {
    set("AUTH_SECRET", "too-short-secret");
    set("AUTH_GITHUB_ID", "Iv1.real");
    set("AUTH_GITHUB_SECRET", "real-secret");
    expect(env.githubAuthEnabled()).toBe(false);
  });

  it("UI-2: rejects a short AUTH_SECRET without printing it", () => {
    set("AUTH_SECRET", "too-short-secret");
    expect(() => env.githubAuthConfigured()).toThrow("AUTH_SECRET must be at least 32 characters");
    expect(() => env.githubAuthConfigured()).not.toThrow("too-short-secret");
  });

  it("defaults APP_ORIGIN to localhost and normalizes it to an origin", () => {
    set("APP_ORIGIN", undefined);
    expect(env.appOrigin()).toBe("http://localhost:3000");
    set("APP_ORIGIN", "https://agentvault.example/some/path");
    expect(env.appOrigin()).toBe("https://agentvault.example");
  });
});

describe("AGT-11: Gemini variables", () => {
  const key = `AIza${"x".repeat(35)}`;

  it("AGT-11: the live agent is on only when GEMINI_API_KEY is set", () => {
    set("GEMINI_API_KEY", undefined);
    expect(env.geminiEnabled()).toBe(false);
    set("GEMINI_API_KEY", "");
    expect(env.geminiEnabled()).toBe(false);
    set("GEMINI_API_KEY", key);
    expect(env.geminiEnabled()).toBe(true);
    expect(env.geminiApiKey()).toBe(key);
  });

  it("AGT-11: a malformed key turns the live agent off and its error never contains the value", () => {
    const bad = "has spaces in it and is long enough to pass the length";
    set("GEMINI_API_KEY", bad);
    expect(env.geminiEnabled()).toBe(false);
    expect(() => env.geminiApiKey()).toThrow("GEMINI_API_KEY must be");
    expect(() => env.geminiApiKey()).not.toThrow(bad);
  });

  it("AGT-11: the model defaults to gemini-3.5-flash-lite and must look like a Gemini model ID", () => {
    set("GEMINI_MODEL", undefined);
    expect(env.geminiModel()).toBe("gemini-3.5-flash-lite");
    set("GEMINI_MODEL", "gemini-3.1-flash-lite");
    expect(env.geminiModel()).toBe("gemini-3.1-flash-lite");
    set("GEMINI_MODEL", "../models/evil");
    expect(() => env.geminiModel()).toThrow("GEMINI_MODEL must be");
  });
});

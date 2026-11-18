import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "./rate-limit";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function set(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const from = (headers: Record<string, string>) => new Request("https://agentvault.example/api/v1/events", { headers });

describe("security §8: clientIp", () => {
  it("security §8: reads x-real-ip, then the first x-forwarded-for entry, when proxy headers are trusted", () => {
    set("TRUST_PROXY_HEADERS", "1");
    expect(clientIp(from({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.7");
    expect(clientIp(from({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientIp(from({}))).toBe("unknown");
  });

  it("security §8: ignores both headers when proxy headers are not trusted, so a client can't pick its bucket", () => {
    set("TRUST_PROXY_HEADERS", undefined);
    set("VERCEL", undefined);
    expect(clientIp(from({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toBe("unknown");
    expect(clientIp(from({ "x-real-ip": "203.0.113.8" }))).toBe("unknown");
  });

  it("security §8: on Vercel the headers are trusted unless TRUST_PROXY_HEADERS says otherwise", () => {
    set("TRUST_PROXY_HEADERS", undefined);
    set("VERCEL", "1");
    expect(clientIp(from({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    set("TRUST_PROXY_HEADERS", "0");
    expect(clientIp(from({ "x-real-ip": "203.0.113.7" }))).toBe("unknown");
  });

  it("security §8: an invalid TRUST_PROXY_HEADERS value is treated as not trusted", () => {
    set("VERCEL", "1");
    set("TRUST_PROXY_HEADERS", "yes");
    expect(clientIp(from({ "x-real-ip": "203.0.113.7" }))).toBe("unknown");
  });
});

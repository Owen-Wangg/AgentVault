import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

async function headersFor(source: string) {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === source);
  return new Map((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

describe("security §8: response headers", () => {
  it("security §8: every route gets nosniff, a framing ban, a referrer policy, and HSTS", async () => {
    const headers = await headersFor("/:path*");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Strict-Transport-Security")).toMatch(/^max-age=\d{8,}$/);
  });

  it("security §8: the content security policy is report-only, allows no framing, and sets no wildcard sources", async () => {
    const headers = await headersFor("/:path*");
    const policy = headers.get("Content-Security-Policy-Report-Only") ?? "";
    expect(headers.has("Content-Security-Policy")).toBe(false);
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toMatch(/\*|https?:/);
    expect(policy).not.toContain("unsafe-eval");
  });
});

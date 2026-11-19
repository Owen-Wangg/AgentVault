import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { config as proxyConfig, contentSecurityPolicy, newNonce, proxy } from "../proxy";

async function headersFor(source: string) {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === source);
  return new Map((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

const scriptSrc = (policy: string) => policy.split("; ").find((d) => d.startsWith("script-src ")) ?? "";

describe("security A8: response headers", () => {
  it("security A8: every route gets nosniff, a framing ban, a referrer policy, HSTS, and a permissions policy", async () => {
    const headers = await headersFor("/:path*");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Strict-Transport-Security")).toMatch(/^max-age=\d{8,}$/);
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    // The report-only header is gone: the page policy is enforced by proxy.ts.
    expect(headers.has("Content-Security-Policy-Report-Only")).toBe(false);
  });

  it("security A8: API routes get an enforced policy that allows nothing", async () => {
    const policy = (await headersFor("/api/:path*")).get("Content-Security-Policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("security A8: the page policy runs only nonced scripts, allows no framing, and sets no wildcard sources", () => {
    const policy = contentSecurityPolicy("abc123", false);
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(policy).toContain(directive);
    }
    expect(scriptSrc(policy)).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(policy).not.toMatch(/\*|https?:/);
    expect(policy).not.toContain("unsafe-eval");
    // Only development adds eval, for React's error overlay.
    expect(scriptSrc(contentSecurityPolicy("abc123", true))).toContain("'unsafe-eval'");
  });

  it("security A8: the proxy enforces the policy with a fresh nonce on each request, and passes it to rendering", () => {
    const first = proxy(new NextRequest("https://agentvault.example/feed"));
    const second = proxy(new NextRequest("https://agentvault.example/feed"));
    const a = first.headers.get("content-security-policy") ?? "";
    const b = second.headers.get("content-security-policy") ?? "";
    expect(a).toMatch(/'nonce-[A-Za-z0-9+/]{22}=='/);
    expect(a).not.toBe(b);
    // Next.js reads the nonce from the request's CSP header, forwarded as x-middleware-request-*.
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(a);
    expect(newNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("security A8: the proxy skips API routes, the demo vendor, and static files", () => {
    const pattern = new RegExp(`^${proxyConfig.matcher[0]!.source}$`);
    for (const path of ["/", "/feed", "/agents/123", "/approvals", "/settings"]) expect(pattern.test(path), path).toBe(true);
    for (const path of ["/api/v1/pay", "/vendor/docs/integration", "/_next/static/chunks/a.js", "/llms.txt", "/openapi.json"]) {
      expect(pattern.test(path), path).toBe(false);
    }
  });
});

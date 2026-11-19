import { type NextRequest, NextResponse } from "next/server";

/**
 * The enforced Content-Security-Policy for app pages (security-standards
 * §8, security A8). Scripts run only with this request's nonce, or when a
 * script that has it loads them ('strict-dynamic'); Next.js reads the nonce
 * from the request's CSP header and puts it on its own scripts, so every
 * page must render per request, which they do (the root layout reads the
 * theme cookie). Styles keep 'unsafe-inline': React style attributes and
 * the charts set inline styles, which a nonce can't cover, and styles
 * can't run code. In development React needs eval for its error overlay.
 *
 * API routes, the demo vendor (whose pages send their own stricter policy),
 * and static files don't need it; next.config.ts sends the other security
 * headers everywhere.
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** 128 random bits, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function proxy(request: NextRequest): NextResponse {
  const policy = contentSecurityPolicy(newNonce(), process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|vendor/|_next/static|_next/image|favicon.ico|llms.txt|openapi.json).*)",
      // Prefetches render no HTML document of their own.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

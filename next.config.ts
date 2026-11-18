import type { NextConfig } from "next";

/**
 * The policy the app is meant to meet: its own scripts and styles (Next.js
 * inlines some of both), same-origin requests, fonts bundled at build time
 * by next/font, and no framing. It is sent as report-only, so a violation
 * shows in the browser console and blocks nothing; switch the header name
 * to Content-Security-Policy once the dashboard runs clean in a browser.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy-Report-Only", value: CONTENT_SECURITY_POLICY },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Report-only CSP doesn't stop framing, so the approve and unfreeze buttons are protected by this one.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // mppx lazily imports optional peers this app doesn't install (the MCP SDK, Hono, Express).
  // Bundling resolves those imports at build time and fails, so Node loads mppx at run time
  // instead, where the lazy imports never run on the paths the app uses.
  serverExternalPackages: ["mppx"],
  // The end-to-end test's dev server builds into its own folder (playwright.config.ts), so it
  // never reuses a cache written by `pnpm dev` or `pnpm build` with other settings, and it can
  // run while `pnpm dev` is up.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;

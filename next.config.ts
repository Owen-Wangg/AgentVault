import type { NextConfig } from "next";

/**
 * Pages get their enforced Content-Security-Policy, with a per-request
 * nonce, from proxy.ts. Everything else that isn't a page (API routes, JSON
 * documents, the demo vendor's paid endpoints) gets this one, which allows
 * nothing to load or frame it. The demo vendor's docs pages set their own.
 */
const NON_PAGE_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // For browsers that ignore frame-ancestors.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: NON_PAGE_POLICY }] },
      // rail-adapters RAIL-29: the paid vendor endpoints, including the plain page x402 shows a browser.
      { source: "/vendor/api/:path*", headers: [{ key: "Content-Security-Policy", value: NON_PAGE_POLICY }] },
    ];
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

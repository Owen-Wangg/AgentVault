import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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

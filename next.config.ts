import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // mppx lazily imports optional peers this app doesn't install (the MCP SDK, Hono, Express).
  // Bundling resolves those imports at build time and fails, so Node loads mppx at run time
  // instead, where the lazy imports never run on the paths the app uses.
  serverExternalPackages: ["mppx"],
};

export default nextConfig;

import type { Label } from "./types";

/**
 * Origin labeling (TAINT-1). A URL is `trusted` only if it matches an
 * entry on the workspace's trusted list. Anything else is `untrusted`,
 * including entries that don't parse, so a bad entry can only make
 * labeling stricter.
 *
 * An entry is an origin with an optional path prefix, for example
 * `https://docs.stripe.com` or `https://agentvault.example/vendor/api`.
 * Trust is per origin and path prefix because the demo vendor's docs live
 * on the deployment's own origin (taint-and-intent design).
 */

interface TrustEntry {
  origin: string;
  /** Always starts with "/". "/" trusts the whole origin. */
  path: string;
}

/** Parse one trusted-list entry, or null if it isn't a plain http(s) origin with an optional path. */
export function parseTrustEntry(entry: string): TrustEntry | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Credentials, a query, or a fragment mean the entry isn't what it looks like.
  if (url.username || url.password || url.search || url.hash || entry.includes("?") || entry.includes("#")) return null;
  return { origin: url.origin, path: url.pathname };
}

/**
 * Whether `path` is under `prefix`, matching whole segments: "/vendor/api"
 * covers "/vendor/api" and "/vendor/api/weather" but not "/vendor/apix".
 * Both paths come from `URL`, so dot segments are already resolved.
 */
function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function labelOrigin(url: URL, trustedOrigins: readonly string[]): Label {
  if (url.protocol !== "https:" && url.protocol !== "http:") return "untrusted";
  if (url.username || url.password) return "untrusted";
  for (const raw of trustedOrigins) {
    const entry = parseTrustEntry(raw);
    // Origin comparison is exact, so "vendor.example.evil.com" never matches "vendor.example".
    if (entry && entry.origin === url.origin && underPrefix(url.pathname, entry.path)) return "trusted";
  }
  return "untrusted";
}

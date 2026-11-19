import { z } from "zod";

/**
 * Zod 4 checks once whether it may compile validators with `Function("")`.
 * The page CSP (`script-src` with a nonce and 'strict-dynamic', security
 * review N5) forbids that, so the browser logs a CSP violation and zod
 * falls back to interpreting. `jitless` skips the check and the fallback
 * up front. Browser only: the server has no such CSP and keeps the
 * compiled validators. Imported first by ThemeProvider, which every page
 * loads, so it runs before any client code parses.
 */
export const ZOD_BROWSER_JITLESS = typeof window !== "undefined";

if (ZOD_BROWSER_JITLESS) z.config({ jitless: true });

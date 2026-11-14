import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Whether a request carries `Authorization: Bearer <secret>`, which is how
 * Vercel Cron calls /api/cron/* routes. Both sides are hashed first, so
 * the comparison is constant-time and doesn't reveal the secret's length.
 */
export function hasCronSecret(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

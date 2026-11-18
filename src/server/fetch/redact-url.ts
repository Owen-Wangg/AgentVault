import { createHash } from "node:crypto";

/**
 * A URL as it is recorded in the audit log and on the session. The log is
 * append-only, so anything written to it stays there: credentials and query
 * strings (which often carry tokens) are dropped, and only the origin and
 * path are kept. The SHA-256 of the full URL is kept beside it, so a URL
 * can still be matched against a record without being stored.
 */
export interface RecordedUrl {
  /** Origin and path only. For text that isn't a URL, a placeholder with its length. */
  url: string;
  /** SHA-256 of the URL exactly as given. */
  sha256: string;
}

export function recordUrl(raw: string): RecordedUrl {
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  try {
    const parsed = new URL(raw);
    return { url: `${parsed.origin}${parsed.pathname}`, sha256 };
  } catch {
    return { url: `[unparseable URL, ${raw.length} characters]`, sha256 };
  }
}

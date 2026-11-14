import type { Label } from "./types";

/** The taint fields of a session, as stored. */
export interface TaintState {
  taintedAt: string | null;
  taintSourceUrl: string | null;
  taintContentSha256: string | null;
}

/** What a fetch through `/api/v1/fetch` produced. A failed fetch returned no content. */
export type FetchOutcome =
  | { ok: true; label: Label; url: string; contentSha256: string; at: string }
  | { ok: false };

/**
 * The session's taint after a fetch (TAINT-4, TAINT-5). Untrusted content
 * taints an untainted session. Nothing clears or moves an existing taint:
 * the first source stays the recorded one, and later untrusted fetches get
 * their own audit events instead. A failed fetch never taints, because no
 * content reached the agent.
 */
export function afterFetch(state: TaintState, outcome: FetchOutcome): TaintState {
  if (state.taintedAt !== null) return state;
  if (!outcome.ok || outcome.label !== "untrusted") return state;
  return { taintedAt: outcome.at, taintSourceUrl: outcome.url, taintContentSha256: outcome.contentSha256 };
}

import type { Micros, Rail } from "@/core/money";

/** How `/api/v1/fetch` labels a response (TAINT-1). */
export type Label = "trusted" | "untrusted";

/**
 * Per-session state the server loads for `evaluate()` (taint-and-intent
 * design). `taintedAt` is read by `taintRules` (TAINT-6); `agentFrozen` is
 * read by the policy's `frozenRule` (ENV-5).
 */
export interface SessionState {
  sessionId: string;
  /** From `agents.frozen_at`, read after the envelope lock (PXY-11). */
  agentFrozen: boolean;
  /** ISO time the session was tainted, passed in. Null if never tainted. */
  taintedAt: string | null;
  taintSourceUrl: string | null;
  /** Reserved plus settled reservations for this session (audit-and-approvals RES-2). */
  sessionSpentMicros: Micros;
}

/** The part of a tool registry entry the policy needs (taint-and-intent design). */
export interface ToolDef {
  name: string;
  /** High-privilege tools are held in tainted sessions (TAINT-6). */
  privileged: boolean;
  /** Null for tools that move no money, such as payee.update. */
  rail: Rail | null;
}

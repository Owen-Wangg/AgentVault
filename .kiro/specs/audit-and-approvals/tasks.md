# Tasks: Audit, Proxy Flow, and Approvals

Plan (`docs/PLAN.md`): **Phase 5** = tasks 1–3. **Phase 6** = tasks 4–6. **Phase 8** = tasks 7–9.

- [x] 1. Implement the pure canonical-JSON and hash-chain modules in `src/core/audit/`
  - `canonical.ts`: `canonicalJson` with the CJ rules table from the design doc; `CanonicalJsonError`
  - `chain.ts`: `chainHash`, `GENESIS_HASH`, `headMac`, `verify(events, head, key)` with `why: "hash" | "link" | "gap" | "head"`
  - Test vectors in `src/core/audit/vectors.json` (property 8)
  - Property tests 4 (tamper detection, including suffix deletion and forged heads) and 7 (canonical encoding)
  - _Requirements: AUD-2, AUD-4, AUD-8, CJ-1, CJ-2, CJ-3, CJ-4, CJ-5, CJ-6, CJ-7_

- [x] 2. Create the Drizzle schema, migrations, and the append-only triggers
  - All tables from the design doc, including `audit_heads`, `rate_limits`, `workspaces.retired_at`, the reservation columns (`session_id`, `rail`, `rail_idempotency_key`, `decision_seq`, `resolved_at`), and `idempotency.request_hash`
  - `bigint` money columns with `mode: "bigint"`; `audit_events.created_at` as `timestamptz(3)`
  - Migration that adds `audit_events_block_mutation`, the row-level `UPDATE`/`DELETE` trigger, and the statement-level `TRUNCATE` trigger
  - Beginner setup notes in `docs/SETUP.md`: what a migration is, how to run `pnpm db:migrate` against Neon, and how to run local Postgres with Docker as an alternative
  - Integration test: `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_events` all fail
  - _Requirements: AUD-3, AUD-5_

- [x] 3. Implement `appendEvent()`, `verifyChain()`, the seed script, sandbox create and retire, and `pnpm audit:verify`
  - `appendEvent` locks the `audit_heads` row, inserts the event, and updates the head and its MAC in the caller's transaction
  - `AUDIT_HEAD_KEY` in the Zod env schema (32 bytes, never logged); placeholder in `.env.example`
  - Seed creates the sandbox workspace with its head row, demo agents, envelopes, tasks, and vendors
  - `createSandboxWorkspace()` / `retireSandboxWorkspace()` (revokes the retired workspace's agent keys) with `sandbox_created` and `sandbox_retired` events; `pnpm sandbox:reset` and `GET /api/cron/sandbox-reset` (`CRON_SECRET`)
  - Integration tamper tests: drop the triggers on the test DB, edit a row, confirm the exact `seq` is reported; delete the last N rows, confirm `why: "head"` at the first missing `seq`
  - Integration test: a sandbox reset leaves the old chain verifiable and never lowers the `audit_events` row count
  - _Requirements: AUD-1, AUD-2, AUD-4, AUD-7, AUD-8, AUD-9, CJ-8_

- [x] 4. Implement agent API keys and authentication
  - Key generation (`crypto.randomBytes(32)`, base64url, prefix `av_test_`), SHA-256 hash storage, `timingSafeEqual` lookup
  - _Requirements: PXY-1, PXY-2, PXY-3_

- [x] 5. Implement `runGuardedRequest()` with reservations and idempotency
  - Locked envelope, idempotency claim (live = under 24 h; 422 on a different `request_hash`, 409 while in progress), frozen flag read after the lock, window and session spend from `reserved` and `settled` reservations, `callsLastMinute` from `idempotency` rows, `evaluate()`, decision event, reservation on allow, freeze on velocity, approval on hold, commit
  - Rail call on allow, `classifyRailResult` in `src/server/payments/outcome.ts`, `rail_result` event, settle / release / keep the reservation, store the idempotency response
  - Uses the mock rail until Phases 13–14
  - _Requirements: PXY-4, PXY-5, PXY-6, PXY-7, PXY-8, PXY-10, PXY-11, PXY-12, PXY-13, PXY-14, RES-1, RES-2, RES-3, RES-4, RES-5, HITL-1_

- [x] 6. Add `POST /api/v1/pay` and its tests
  - Route tests: allow, deny, hold, idempotent replay, 422 key reuse, 409 in progress, expired key treated as new, 401, unknown rail outcome (202), confirmed rail failure (502), fail-closed 503
  - Frozen agent returns `AGENT_FROZEN`
  - Concurrency integration test: 50 parallel requests, cap holds, with some mock rail calls set to `RAIL_TIMEOUT` (property 2)
  - Property 1 (audit before spend) asserted across the suite; property 3 (idempotency)
  - _Requirements: PXY-4 through PXY-14, RES-1 through RES-5_

- [x] 7. Implement the approvals service and endpoints
  - `GET /api/v1/approvals`, `POST /api/v1/approvals/:id`, `POST /api/v1/agents/:id/unfreeze`
  - Authorization order: any bearer header → 403; current sandbox → allowed as `sandbox_visitor` (rate-limited); otherwise a session in the target workspace; retired sandbox → 403
  - Read the user through `getSessionUser()` in `src/server/auth/session.ts`, which returns `null` until telemetry-dashboard task 3 wires in Auth.js; tests inject a fake user
  - Expiry on every read and action, with one `approval_expired` event per approval; 409 `APPROVAL_EXPIRED` and `APPROVAL_NOT_PENDING`
  - Re-run through `runGuardedRequest` with `approvedHoldReasons` and the idempotency key `approval:<id>`; an unapproved hold reason on re-run → `failed_recheck`
  - Integration tests: agent key → 403 in a normal workspace and in the sandbox; anonymous approve works in the sandbox, 401 elsewhere; approving for a frozen agent → `failed_recheck`
  - _Requirements: HITL-2, HITL-3, HITL-4, HITL-5, HITL-6, HITL-8, HITL-9, HITL-10, HITL-11, HITL-12_

- [x] 8. Model-based approval tests with fast-check
  - `fc.commands` over approve, deny, expire (advance a fake clock), read, and duplicate approve
  - Property 5 (at most once, exactly one `approval_expired` event per expired approval)
  - _Requirements: HITL-6, HITL-7, HITL-12_

- [x] 9. Implement the reconciler
  - `src/server/payments/reconcile.ts`; triggered by `after()` on each pay or tool request (up to 5 of that agent's stale reservations), `GET /api/cron/reconcile` (`CRON_SECRET`, daily on Hobby), and `pnpm reconcile` (also lists reservations unknown for over 24 hours)
  - `FOR UPDATE SKIP LOCKED`, lookup through the adapter's `lookup()` only (rail-adapters RAIL-21), `rail_result` with `reconciled: true`, idempotency response rewrite, cleanup of idempotency rows older than 24 hours
  - Needs the mock adapter's `lookup()` (rail-adapters task 2)
  - Integration tests and property 6 (no release without confirmed failure)
  - _Requirements: RES-3, RES-4, RES-6, RES-7, RES-8, RES-9, PXY-13_

- [x] 10. Cap each agent's request rate
  - `hitRateLimit` in `withAgent`, 120 a minute per agent, before the handler; 429 `RATE_LIMITED`; a failed count is 503
  - _Requirements: PXY-15_

- [x] 11. Verify the chain from the dashboard
  - `POST /api/v1/audit/verify` in `src/server/audit/handlers.ts`, human-only, with an integration test; the audit page's Verify chain button shows the count and the signed head (telemetry-dashboard UI-10)
  - _Requirements: AUD-6_

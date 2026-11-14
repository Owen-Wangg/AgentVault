# Tasks: Taint Tracking and Intent Scope

Global plan mapping (see `docs/PLAN.md`; "Task N" is a plan row, numbered entries here are items): **Task 7** (Nov 20–21) = items 1–6. **Task 16** (Nov 30, optional) uses item 7.

- [ ] 1. Implement origin labeling and taint rules in `src/core/taint`
  - `labelOrigin` with origin and path-prefix matching
  - `taintRules` returning `HELD_TAINTED` for privileged tools in tainted sessions
  - Properties 1 and 2
  - _Requirements: TAINT-1, TAINT-5, TAINT-6, TAINT-7_

- [ ] 2. Implement intent scope rules in `src/core/intent`
  - `intentRules` for category, tool, and task budget
  - Property 4 and unit tests per requirement
  - _Requirements: INT-1, INT-2, INT-3, INT-4, INT-5, INT-6_

- [ ] 3. Wire taint and intent rules into `evaluate()`
  - Replace the Task 4 stubs; re-run all money-and-policy-core properties
  - _Requirements: TAINT-6, INT-2, INT-3, INT-4_

- [ ] 4. Build the SSRF-safe fetcher and `POST /api/v1/fetch`
  - DNS and IP range checks, manual redirects, size and time caps
  - Taint the session and write the `taint` audit event (URL and content SHA-256 only)
  - Property 5 and unit tests for each blocked range
  - _Requirements: TAINT-1, TAINT-2, TAINT-3, TAINT-4_

- [ ] 5. Build the tool registry and `POST /api/v1/tool`
  - Registry from the design doc; unknown tools denied
  - Goes through `runGuardedRequest`
  - _Requirements: TAINT-6, TAINT-7, TAINT-8, TAINT-9_

- [ ] 6. Add the demo vendor pages
  - `/vendor/docs/integration` (poisoned), `/vendor/api/gpu` (compute vendor)
  - Integration test: poisoned fetch, then `stripe.refund` → 202 `HELD_TAINTED`
  - _Requirements: TAINT-4, TAINT-6, INT-2_

- [ ] 7. Implement `advisoryRule` (used by the optional Gemini agent)
  - Property 3
  - _Requirements: INT-7, INT-8, INT-9_

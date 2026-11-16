# Tasks: Telemetry and Dashboard

Plan (`docs/PLAN.md`): **Phase 9** = task 1. **Phase 10** = tasks 2–6. **Phase 12** = task 7 (after demo-agents tasks 1–4, which its Playwright test needs). **Phase 15** = task 8. **Phase 18** = task 9.

- [x] 1. Build the SSE endpoint `GET /api/v1/events`
  - Cursor polling, heartbeat, clean close before the duration limit, workspace scoping
  - Property 1
  - _Requirements: TEL-1, TEL-2, TEL-3, TEL-4, TEL-5_

- [x] 2. Set up the app shell, theme variables, and `copy.ts`
  - Sidebar layout, `<DataState>`, default theme tokens, `copy.ts` with the `satisfies` check
  - _Requirements: UI-12, UI-13, UI-14, UI-15_

- [x] 3. Add Auth.js with GitHub, workspace resolution, and the sandbox
  - Step-by-step GitHub OAuth app setup in `docs/SETUP.md`
  - Replace the `getSessionUser()` stub from audit-and-approvals task 7 with the Auth.js session
  - Sandbox badge, rate limiting on sandbox mutations, anonymous approve/deny/unfreeze in the sandbox with a "mock rails only" note
  - _Requirements: UI-1, UI-2, UI-4, UI-21_

- [x] 4. Build the overview and live feed
  - `useEventStream` hook, KPI cards, Recharts charts, feed table with filters
  - _Requirements: UI-5, UI-6, UI-11_

- [x] 5. Build the agents pages and envelope editor
  - Create agent (key shown once), unfreeze, envelope form with Zod validation and dollar-to-micros conversion via `fromDecimalString`
  - Component tests for the form and amount display
  - _Requirements: UI-7, UI-8, UI-11_

- [x] 6. Build the approvals inbox
  - Reason explanations, taint source, countdown, approve and deny
  - _Requirements: UI-9_

- [x] 7. Build the audit page and the Playwright test
  - Event list with hashes, "Verify chain"
  - Playwright: sandbox → prompt-injection scenario → approve refund → see result
  - _Requirements: UI-10, AUD-6_

- [x] 8. Build Kiroween mode
  - Settings toggle, `data-theme`, no-flash script, Kiroween palette and copy, reduced-motion handling
  - Property 2 (theme neutrality) across the scenario suite
  - _Requirements: UI-16, UI-17, UI-18, UI-19, UI-20_

- [x] 9. Polish and accessibility pass
  - Contrast check of every color pair in both themes, keyboard walkthrough, 375 px layout check, Lighthouse ≥ 95
  - Nightly sandbox reset: Vercel Cron entry for `/api/cron/sandbox-reset` (route built in audit-and-approvals task 3), client reload when the sandbox ID changes
  - _Requirements: UI-3, UI-12, UI-13, UI-14_

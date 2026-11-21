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

- [x] 10. Pause the event stream when nobody is watching
  - `useEventStream` closes the stream while the page is hidden or after 15 minutes without input, and reopens it on return, input, or Resume
  - `StreamStatusBadge` shows the paused state with a Resume button, with copy in both themes; the pages pass the hook's `resume`
  - _Requirements: TEL-6, TEL-7_

- [x] 11. Show the pending approvals count in the navigation
  - `PendingCount` on the Approvals link in both navigation bars, read on navigation and on return to the tab, with copy in both themes
  - _Requirements: UI-22_

- [x] 12. Point first-time visitors at the demo
  - `TourCard` on the sandbox overview, with the testnet step only where the testnet card is shown
  - `HeaderThemeSwitch` in the workspace header, sharing `setTheme` with Settings
  - `FeedRow.requestedPayee` from a `payee.update` decision's `payee_ref`, shown in the feed and the scenario steps as text
  - Copy in both themes
  - The tagline in the workspace header
  - _Requirements: UI-23, UI-24, UI-25, UI-27_

- [x] 13. Let visitors watch the chain check fail
  - `verifySegment` in `src/core/audit/chain.ts`, with property 4
  - `src/ui/audit/tamper.ts`: target choice, rewrite and delete on a copy
  - A "Try to tamper with it" card on the audit page, with copy in both themes; no request, nothing stored
  - _Requirements: UI-26_

- [x] 14. Show the brand mark in the app and in link previews
  - `accent-soft` token in both themes, with its contrast pairs
  - `BrandMark` from theme variables, beside the name in the sidebar and in the workspace header below `md`
  - A dark-scheme style in `app/icon.svg`; `app/opengraph-image.png` with alt text, `app/apple-icon.png`, and Open Graph and Twitter metadata in the layout
  - _Requirements: UI-28, UI-29_

- [x] 15. Say what happened on each audit row
  - `describeEvent` in `src/ui/audit/describe.ts`, pure, with a lenient schema per event type
  - A "What happened" column on the audit page, rendered as text, with copy in both themes
  - _Requirements: UI-30_

- [x] 16. Show a skeleton while data loads
  - `DataState`'s loading state draws muted bars instead of a dashed box with text; the text stays for screen readers
  - _Requirements: UI-15, UI-19_

- [x] 17. Say Connecting before the first connection
  - `StreamStatusBadge` shows "Connecting…" for the hook's `connecting` status, in both themes
  - _Requirements: UI-6_

- [x] 18. Show each agent's last decision
  - `lastDecisions` in `src/server/dashboard/agents.ts`, with an integration test
  - A Last decision column in place of Created, with copy in both themes
  - _Requirements: UI-7_

- [x] 19. Filter the audit page by event type
  - `type` option on `listAuditEvents`; the page accepts only `EVENT_TYPES`
  - A GET form on the audit page; links keep the filter; the tamper card is hidden while filtered
  - _Requirements: UI-31_

- [x] 20. Keep dashboard reads bounded as the sandbox grows
  - `listAgents` returns the newest 200 agents and says when it cut some; the agents page notes it
  - `lastDecisions` reads only the listed agents
  - Migration 0009: indexes for the type filter, each agent's newest decision, and sessions by agent
  - _Requirements: UI-7, UI-31_

- [x] 21. Name rails properly on the audit page and mark the sandbox's as mock
  - `audit.rail.*` names and `audit.what.settledMock` in `copy.ts`; `describeEvent` takes `{ sandbox }`, passed from the page
  - _Requirements: UI-30_

- [x] 22. Format every dashboard time in the browser
  - `LocalTime` in `src/ui/LocalTime.tsx`, used by the audit, agents, feed, and overview pages
  - _Requirements: UI-32_

- [ ] 23. Label the request's arguments on approval cards
  - `approvals.arg.*` labels in `copy.ts`, rail values through `audit.rail.*`, known arguments first
  - _Requirements: UI-9_

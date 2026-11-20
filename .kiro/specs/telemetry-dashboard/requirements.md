# Requirements: Telemetry and Dashboard

## Introduction
This spec covers the live event stream and the web dashboard: overview, live feed, agents and envelopes, approvals inbox, audit log, settings, the public sandbox, GitHub sign-in, and the Kiroween mode toggle. The dashboard is the main thing judges see, so it must feel like a finished product, not a demo.

## Requirement 1: Live event stream
**User story:** As a developer, I want decisions to appear on screen as they happen, so that I can watch my agents in real time.

### Acceptance criteria
- **TEL-1** WHEN a client connects to `GET /api/v1/events`, THE SYSTEM SHALL stream the workspace's audit events over server-sent events (SSE) in `seq` order, using `seq` as the event ID.
- **TEL-2** WHEN a client reconnects with `Last-Event-ID`, THE SYSTEM SHALL resume from the next `seq` with no gaps and no duplicates.
- **TEL-3** WHILE no new events exist, THE SYSTEM SHALL send a heartbeat comment at least every 15 seconds.
- **TEL-4** WHEN the serverless function nears its duration limit, THE SYSTEM SHALL close the stream cleanly so the browser reconnects.
- **TEL-5** THE SYSTEM SHALL only stream events from workspaces the caller can access.
- **TEL-6** WHILE a dashboard page is hidden (another tab, a minimized window), THE dashboard SHALL keep no event stream open. WHEN the page is visible again, it SHALL reconnect and show the events it missed, each once and in `seq` order.
- **TEL-7** WHEN a visible dashboard page has had no pointer, keyboard, wheel, or touch input for 15 minutes, THE dashboard SHALL close its event stream and show that live updates are paused, with a Resume button. Resuming, or any input, SHALL reconnect as in TEL-6.

TEL-6 and TEL-7 keep the hosted app inside its free plans until judging ends (`docs/OPERATIONS.md`): an open stream keeps a Vercel function and the Neon compute awake, so a forgotten tab would otherwise use them up.

## Requirement 2: Access and sandbox
**User story:** As a judge, I want to try the product without signing up; as a user, I want my own private workspace.

### Acceptance criteria
- **UI-1** WHEN a visitor opens the app without signing in, THE SYSTEM SHALL show the sandbox workspace with a visible "Sandbox" badge and mock rails.
- **UI-2** WHEN a user signs in with GitHub, THE SYSTEM SHALL create or open their personal workspace.
- **UI-3** THE SYSTEM SHALL reset the sandbox nightly by creating a new seeded sandbox workspace and retiring the old one (audit-and-approvals AUD-9). Scenario starts use a fresh agent instead of a reset (demo-agents AGT-2).
- **UI-4** THE SYSTEM SHALL rate-limit sandbox actions per IP address.
- **UI-21** WHILE a visitor is not signed in, THE SYSTEM SHALL let them approve, deny, and unfreeze in the sandbox, and SHALL show that sandbox actions use mock rails only (audit-and-approvals HITL-11).

## Requirement 3: Pages
**User story:** As a developer, I want clear views of spend, risk, and pending decisions, so that I can act quickly.

### Acceptance criteria
- **UI-5** THE overview page SHALL show total spend, blocked spend, decisions by outcome, and spend over time for the selected range.
- **UI-6** THE live feed SHALL show each event with time, agent, vendor, amount, decision, and reasons in plain language, and SHALL update without a page reload.
- **UI-7** THE agents page SHALL list agents with frozen and tainted status and each agent's last decision (outcome, tool, amount, and time, or "None yet"), allow creating an agent (showing the API key once), and allow unfreezing. THE list, and the agent names any dashboard page sends to the browser, SHALL hold at most the 200 newest agents, and the agents page SHALL say so when it leaves older ones out. A workspace SHALL hold at most 25 agents created through the API; a create past that SHALL answer 409 `AGENT_LIMIT_REACHED` and add nothing.
- **UI-8** THE envelope editor SHALL validate every limit before saving, accept amounts as decimal dollars, and store them as micros. THE agent's own calls-per-minute limit SHALL be required, from 0 to 1,000, in the editor and in `PUT /api/v1/agents/:id/envelope`; per-vendor and per-tool limits stay optional.
- **UI-9** THE approvals inbox SHALL show pending approvals with the request, reasons, taint source, and time left, with approve and deny buttons.
- **UI-10** THE audit page SHALL list events with `seq` and hash, and SHALL offer a "Verify chain" button showing the result.
- **UI-30** THE audit page SHALL show each event's "What happened" in plain language, built from its type and payload (for example "Held payout.create, $900.00: HELD_TAINTED" or "Approved by a sandbox visitor"), in both themes. It SHALL be shown as text, never as HTML or a link, and an event it can't read SHALL show "–" without hiding the row. A settled rail result SHALL name the rail as its provider writes it (Stripe, x402, PayPal), and WHILE the workspace is the public sandbox, which only uses mock rails, it SHALL say the rail was the mock one, so the page never claims a real settlement.
- **UI-31** WHEN a visitor picks an event type on the audit page, THE page SHALL list only events of that type, newest first, with Older and Newest links that keep the filter. An unknown type SHALL be ignored. WHILE a filter is on, THE page SHALL hide the tamper card, which needs an unbroken run of events, and "Verify chain" SHALL still check the whole chain.
- **UI-26** WHEN a visitor clicks "Rewrite an event" or "Delete an event" on the audit page, THE SYSTEM SHALL change a copy of the events on that page in the browser, recheck the copy with the same chain code the server uses, and show the first broken `seq` and why. It SHALL first show whether the untouched copy verifies, SHALL say the head check stays on the server, and SHALL NOT send any request or change the stored log.
- **UI-11** THE SYSTEM SHALL display amounts exactly, with up to 6 decimal places (for example `$0.0015`).
- **UI-23** WHILE the workspace is the public sandbox, THE overview page SHALL show a "Start here" card above the KPI cards with the guided tour in order: run Payee hijack, deny the payout account change and approve the payout, verify the chain, and (only where the real testnet payment card is shown, testnet-demo TN-1) make the real testnet payment. Each step SHALL link to the page where it happens. Outside the sandbox the card SHALL NOT appear.
- **UI-25** WHEN a `payee.update` decision's arguments name a requested payee (`payee_ref`), THE live feed and the scenario steps SHALL show that account as text, never as a link, so a held change shows where the agent tried to redirect money before anyone decides it.
- **UI-22** WHILE the workspace has pending approvals, THE navigation SHALL show their count on the Approvals link, read when the visitor moves to another page or returns to the tab, after expiry is applied (audit-and-approvals HITL-12). With none pending, it SHALL show no count. It SHALL NOT open another event stream or poll.

## Requirement 4: Design quality
**User story:** As a judge, I want a polished, accessible interface.

### Acceptance criteria
- **UI-12** THE SYSTEM SHALL meet WCAG 2.2 AA color contrast in both themes.
- **UI-13** THE SYSTEM SHALL be usable with a keyboard alone, with visible focus states.
- **UI-14** THE SYSTEM SHALL work at widths from 375 px to 1920 px.
- **UI-15** THE SYSTEM SHALL show empty, loading, and error states for every data view.
- **UI-28** THE dashboard SHALL show the AgentVault mark beside the app name on every page: in the sidebar from the `md` breakpoint up, and at the top of the workspace header below it. The mark SHALL be decorative (hidden from screen readers), so the link's name stays the app name, and SHALL take its colors from the theme tokens, so Kiroween mode recolors it and changes nothing else (UI-18).
- **UI-29** THE site SHALL publish a 1200 × 630 social preview image with alt text, and a 180 × 180 Apple touch icon. THE tab icon SHALL switch to a lighter palette WHEN the browser prefers a dark color scheme, so it stays visible on dark tabs.

## Requirement 5: Kiroween mode
**User story:** As a presenter, I want a spooky theme for the demo, without changing how the product behaves.

### Acceptance criteria
- **UI-16** WHEN a user turns on Kiroween mode in Settings, THE SYSTEM SHALL switch colors, fonts, and copy (for example "The Crypt" for frozen tools, "Haunted" for tainted sessions).
- **UI-27** THE workspace header SHALL show a one-sentence tagline saying what AgentVault is, on every dashboard page, in both themes.
- **UI-24** THE workspace header SHALL offer the Kiroween mode switch on every dashboard page, with the same effect as the Settings switch (UI-16, UI-17, UI-18).
- **UI-17** THE SYSTEM SHALL save the choice in the browser and restore it on the next visit without a flash of the other theme.
- **UI-18** THE SYSTEM SHALL produce identical policy decisions, API responses, and audit events in both themes.
- **UI-19** WHILE the user's system requests reduced motion, THE SYSTEM SHALL disable decorative animations.
- **UI-20** THE SYSTEM SHALL use only open-licensed fonts, icons, and images.

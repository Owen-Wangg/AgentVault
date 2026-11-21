# Design: Telemetry and Dashboard

## Overview
- `app/api/v1/events/route.ts`: SSE stream that polls `audit_events` by cursor.
- `app/(dashboard)/…`: server components for initial data, client components for live parts.
- `src/ui/`: components, theme tokens, `copy.ts`, and the `useEventStream` hook.

```mermaid
flowchart LR
  DB[(audit_events)] -->|poll every 1s, seq > cursor| SSE["/api/v1/events"]
  SSE -->|id: seq| ES[EventSource in browser]
  ES --> Q[useEventStream store]
  Q --> Feed[Live feed]
  Q --> Ov[Overview charts]
  Q --> Inbox[Approvals badge]
```

## SSE endpoint
- Runtime: Node.js. `export const maxDuration = 60` (or the plan's limit).
- Loop: `SELECT … WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT 200`, emit each as `id: <seq>\nevent: audit\ndata: <json>\n\n`, sleep 1 s. After a full batch, poll again without sleeping.
- Heartbeat `: ping` after 10 s without a write, so the gap stays under 15 s (TEL-3) even with one poll interval and a slow query on top. No new poll starts after `maxDuration - 5 s`; then the stream ends (TEL-4). Each connection starts with `retry: 1000`. `EventSource` reconnects with `Last-Event-ID` automatically (TEL-2). A malformed `Last-Event-ID` is 400.
- Payloads carry amounts as micros strings. `data` is the stored event: `workspace_id`, `seq`, `type`, `created_at`, `payload`, `prev_hash`, `hash`.
- **Why the cursor can't skip:** `appendEvent` holds the workspace's audit head lock until commit, so a workspace's events commit in `seq` order. A query that sees `seq = n` sees every lower `seq`, and an event committed during a poll is picked up by the next one.
- **Workspace (TEL-5):** `?workspace_id=` names it. Any sandbox, current or retired, is public to read; other workspaces need their owner signed in (401 or 403). Without the parameter, the reader gets the same workspace as the approvals list: their own, or the current sandbox. Any `Authorization` header is 403 `AGENT_KEY_FORBIDDEN`, as on the other dashboard routes.
- After the first poll that returns less than a full batch, the stream sends an id-less `event: ready` with the cursor, so the client can tell an empty workspace from one still loading (UI-15).
- Each connection's second message is `event: workspace` with `{ workspace_id, sandbox, retired }` and no `id`, so it doesn't move the browser's last event ID. `useEventStream` reconnects with that `workspace_id`, so a `Last-Event-ID` is never applied to another workspace's chain after a sandbox reset, and reloads when `retired` is true.
- Opening a sandbox stream counts toward a per-IP limit (30 per minute), because each stream holds a function for up to 55 s.
- Code: the loop is `pumpEvents()` in `src/server/events/stream.ts`, with the event source and clock injected; the handler is `src/server/events/handler.ts`.

### Pending approvals count (UI-22)
- `usePendingCount`, called once by the sidebar for both navigation bars, calls `GET /api/v1/approvals?status=pending`, which applies expiry first, when the pathname changes and when the tab becomes visible. One request per navigation; no stream and no timer, so it adds nothing while a tab sits open (TEL-6, TEL-7).
- The list is capped at 100, so 100 or more shows `99+`. Zero, a failed request, or a non-200 answer shows nothing; a count is a hint, and the inbox is the source of truth.
- The number is visible, followed by screen-reader text ("waiting for approval", Kiroween: "awaiting judgment"), so the link reads "Approvals 3 waiting for approval". Both navigation bars show it.
- Known gap: approving inside the inbox doesn't update the count until the next navigation.

### Pausing the stream (TEL-6, TEL-7)
- All in `useEventStream`, on the client. The server doesn't change, so a client that never pauses costs what it did before.
- The hook is *active* while `document.visibilityState` is `visible` and the page isn't idle. Becoming inactive closes the `EventSource` and sets status `paused`. Becoming active opens a new one.
- The new `EventSource` can't send `Last-Event-ID` (the browser sets it only on its own reconnects), so it receives the workspace's backlog again. `mergeEvents` keeps each `seq` once and in order, so the events missed while paused appear and nothing repeats (property 1 still holds). A day's sandbox backlog is a few hundred events, the same as a page load.
- Idle: a timer of `idleMs` (15 minutes) restarts on `pointerdown`, `pointermove`, `keydown`, `wheel`, and `touchstart` on `window`, at most once a second. When it fires, the hook pauses. Any of those inputs, or the badge's Resume button, resumes. Becoming visible counts as input.
- `StreamStatusBadge` shows "Live updates paused" for `paused`, with a Resume button next to it; the status text stays in the `role="status"` region so screen readers hear the change. Copy in both themes.
- `idleMs` and the document are injectable for tests.

## Pages
| Route | Content |
|---|---|
| `/` | Overview: KPI cards (spend, blocked spend, held, agents frozen), spend-over-time area chart, decisions bar chart, recent alerts |
| `/feed` | Live feed table with filters (agent, decision, reason) |
| `/agents` | Agent list, create agent dialog (key shown once with copy button), unfreeze |
| `/agents/[id]` | Envelope editor (React Hook Form + Zod), per-vendor and per-tool limits |
| `/approvals` | Inbox cards with reason explanations and countdown |
| `/audit` | Paginated events, hash column (truncated), "Verify chain" |
| `/scenarios` | Scenario runner (demo-agents spec) |
| `/settings` | Theme toggle, workspace info, trusted origins |

Navigation: left sidebar on desktop, and a navigation bar fixed to the bottom of the screen below the `md` breakpoint (one tap to every page at 375 px). Components follow the shadcn/ui style (`Card`, `Badge`, `Button`) but are written in `src/ui/components/primitives.tsx`, so there's no Radix dependency. Dialogs use the native `<dialog>` element, which handles focus, Escape, and the inert background. Status messages use `role="status"` live regions instead of toasts.

Built in Phase 10: `/`, `/feed`, `/agents`, `/agents/[id]`, `/approvals`. Phase 11 added `/scenarios`, which always streams the current sandbox. Phase 15 added `/settings` with the Kiroween switch only; workspace info and trusted origins aren't built. Phase 12 added `/audit`: 50 events a page, newest first, paged by `?before=<seq>` on the server, and "Verify chain", which calls `POST /api/v1/audit/verify`. The rest arrive with their tasks.

`POST /api/v1/audit/verify` takes `{ workspace_id? }` and has the event stream's read access: any sandbox is public, other workspaces need their owner. It's human-only (403 for any `Authorization` header or a cross-site POST, before the database opens), and sandbox calls are limited to 30 per IP per minute because each reads the whole chain. It returns `{ ok: true, count, head_seq }` or `{ ok: false, broken_at_seq, why, head_seq }`. The approvals count badge in the sidebar isn't built; it would open a second event stream on every page.

### First visit (UI-23, UI-24, UI-25)
Most visitors to the hosted site are judges who land on `/` right after a nightly reset, when every card reads zero. These three changes point them at the demo and make its key moment readable.
- **Start here card (UI-23).** `TourCard` in `src/ui/overview/`, rendered by `OverviewView` above the KPI cards when the page passes `tour`. The overview page passes `tour` only for a sandbox workspace, with `testnet` computed the same way as on `/scenarios` (`testnetRailReady()` and the testnet workspace exists), so step 4 never points at a button that isn't there. The steps are an ordered list of plain links (`/scenarios`, `/approvals`, `/audit`, `/scenarios`), with copy in both themes. It stays while the sandbox has events, so a judge who comes back to the overview can see the next step.
- **Tagline (UI-27).** The header's first line is `app.tagline`, so a visitor from Devpost reads what AgentVault is before anything else. Above the workspace name, as plain text.
- **Header theme switch (UI-24).** `HeaderThemeSwitch` in `src/ui/settings/`: a `button` with `role="switch"` and `aria-checked`, a ghost icon, and the visible label "Kiroween mode". It calls the same `setTheme` as the Settings switch, so the cookie, `data-theme`, and `router.refresh()` behave the same, and UI-18 still holds: no request depends on the theme.
- **Requested payee (UI-25).** `decisionRow` reads `request.args.payee_ref` for a `payee.update` decision, as a string of 1 to 200 characters (anything else is dropped), into `FeedRow.requestedPayee`. The feed row and the scenario step show "Requested payout account: acct_…" as monospace text. Once the change is applied, the feed shows the existing `payeeChange` line (PO-12) instead.

### Tamper simulation (UI-26)
"Verify chain" only ever says verified, so a visitor never sees a check fail. The audit page gets a "Try to tamper with it" card that breaks a copy on purpose.
- **Where it runs.** In the browser, on the page's events (at most 50, a contiguous run of `seq`). No request is sent and nothing is stored, so there is no new endpoint, rate limit, or database access, and the append-only log (AUD-3) is untouched.
- **Core.** `verifySegment(workspaceId, events)` in `src/core/audit/chain.ts`: the `verifyNext()` checks over a contiguous run, starting from the first row's own `prev_hash` and `seq`. It can't check the head, because the head key never leaves the server; the card says so.
- **The edits** (`src/ui/audit/tamper.ts`, pure). The target is the newest `decision` held or denied on the page, else the newest decision, else the newest event. "Rewrite an event" changes the copy's payload: a decision becomes `allow` with no reasons, anything else gains `tampered: true`. "Delete an event" removes a row strictly inside the run (the target if it is, else the middle row), because removing the first or last row of a page leaves a shorter run that still links; only the server's head check catches a deleted tail. Delete needs at least three events.
- **What it shows.** First the untouched copy's result ("Untouched, these N events verify in your browser"); if even that fails, it says the browser couldn't recheck and shows nothing else. Then what changed ("Rewrote seq 41: hold to allow" or "Deleted seq 41") and the result with the existing broken-chain copy (`audit.broken`, `audit.why.*`).

### Audit type filter (UI-31)
A runaway loop writes dozens of near-identical rows, so the audit page can show one event type at a time. The filter is the `type` search parameter, set by a plain GET form (a select of `EVENT_TYPES` plus "All events", and a Filter button), so it works without JavaScript and a filtered page can be linked.
- **Server.** `listAuditEvents(db, workspaceId, { before?, type? })` adds `type = $3` to the same backward-by-`seq` query, so paging works as before. The index `audit_events_workspace_type_seq_idx` on `(workspace_id, type, seq)` serves it, so a rare type doesn't walk the whole log. The page passes `type` only if it is in `EVENT_TYPES`; anything else is ignored rather than an error.
- **Links.** Older and Newest carry `type`, so paging stays filtered.
- **Tamper card.** Hidden while a filter is on, with one line saying to clear the filter to try it: filtered rows skip seqs, so the browser recheck would report gaps that aren't tampering. "Verify chain" asks the server for the whole chain either way.
- **Empty.** A type with no events says "No events of this type yet."
- Copy in both themes; the type names in the select stay as the codes the Event column shows.

### Last decision on the agents page (UI-7)
The agents table's third column is each agent's last decision instead of its creation date, so a visitor who just ran a scenario sees what happened to that agent. `lastDecisions(db, workspaceId, agentIds)` in `src/server/dashboard/agents.ts` reads only the listed agents' `decision` events with `DISTINCT ON (payload->>'agent_id')`, newest `seq` first, through the partial index `audit_events_decision_agent_idx` on `(workspace_id, (payload->>'agent_id'), seq) WHERE type = 'decision'`, and parses each payload leniently; an unreadable one leaves that agent with no decision. It is separate from `listAgents`, which the feed and audit pages also call for agent names, so only the agents page pays for it.
- **Bounded reads.** Every scenario run adds an agent and its events to the public sandbox, and dashboard pages aren't rate-limited, so no page read may grow with the workspace. `listAgents` returns the newest `AGENT_LIST_LIMIT` (200) agents, oldest of them first, and `truncated` when it cut some; the agents page says so (`agents.truncated`, which names the same number). The per-agent taint lookups use `sessions_agent_idx`. Pages label agents outside the list by the start of their ID (`agentLabel`), as they already do for agents created after the page loaded. The amount crosses to the client as a decimal string of micros and is shown with `Amount`, except for a tool that moves no money (`payee.update`), which shows no `$0.00`.

### What happened (UI-30)
The audit table gets a "What happened" column between Event and Agent, from `describeEvent(event, copy, { sandbox })` in `src/ui/audit/describe.ts`. It is pure and returns a string, which React renders as escaped text; URLs and account IDs are never links.
- **Per type.** `decision`: the verb for the outcome, the tool, and the amount, then the reason codes ("Held payout.create, $900.00: HELD_TAINTED, NEEDS_APPROVAL"). `rail_result`: settled with the rail, amount, and payout destination when there are ones; refused with the code; or unknown, with "the amount stays counted", and a note when the reconciler found it. `approval_decided`: approved or denied by the actor, or a failed recheck with its codes. `approval_executed`, `approval_expired`, `approval_created` (with the codes), `agent_frozen`, `agent_unfrozen` (by the actor), `taint` (the page's URL), `fetch_failed` (the code), `payee_updated` (old and new account), `envelope_updated` (version and actor), `scenario_started` (the scenario's title, marked live for a live run), `mcp_agent_created` (the agent's name), `sandbox_created`, `sandbox_retired`, `testnet_workspace_created`.
- **Actors.** `sandbox_visitor` is "a sandbox visitor", `system` is "AgentVault", `cli` is "the command line", and anything else, a signed-in user's ID, is "a workspace member": the ID means nothing to a reader.
- **Parsing.** Each payload is read with a lenient Zod schema, like the feed's. A type it doesn't know or a payload it can't read gives "–", so a new event type never breaks the page.
- **Rail names.** A `rail_result` payload's `rail` is the rail the tool belongs to, even when the mock adapter ran it, so the payload alone can't say whether a real rail settled. `describeEvent` takes `{ sandbox }` from the page (`workspace.isSandbox`). Rail IDs map to `audit.rail.*` names (Stripe, x402, PayPal, the mock rail); in the sandbox a settled result says "Settled on the mock Stripe rail" (`audit.what.settledMock`), since the sandbox never builds a real adapter.
- **Copy.** Every fragment is a `copy.ts` key under `audit.what.*`, with Kiroween wording for the freeze, unfreeze, taint, approve, and deny phrases. Amounts use `toDisplay`; reason codes stay as codes, since the feed and approvals already explain them.

### Approval arguments (UI-9)
A card lists the request's `args` under labels from `approvals.arg.*`: `payee_ref` is "Requested payout account", `rail` is "Rail", with the value named through `audit.rail.*` (Stripe, x402, PayPal), and `payment_ref` is "Refund of payment". Known arguments come first in that order; any other is shown after them with its field name, so a new tool's arguments are never hidden. Values stay monospace text.

### Local times (UI-32)
Pages are rendered on Vercel, where the time zone is UTC, and then hydrated. A time formatted during the server render keeps the server's text, so the audit and agents pages showed UTC while the feed, filled by the stream in the browser, showed local time. `LocalTime` (`src/ui/LocalTime.tsx`) renders a `<time dateTime>` element whose text comes from `useSyncExternalStore` with a server snapshot of `null`: the server HTML and the first hydration render have no text, and React then renders the browser's `toLocaleString` or `toLocaleTimeString`. Outside hydration, such as rows added by the stream, the text is there on the first render. The audit, agents, feed, and overview pages use it for every time.

## Reason explanations
`src/ui/copy.ts` maps each reason code to a plain-language sentence per theme:
```ts
export const copy = {
  default: { HELD_TAINTED: "Held: this session read untrusted content, so refunds and payouts need approval.", … },
  kiroween: { HELD_TAINTED: "Sealed in The Crypt: this session is Haunted by an untrusted page.", … },
} satisfies Record<Theme, Record<ReasonCode | UiKey, string>>;
```
The `satisfies` check makes a missing string a compile error.

## Theme system
- `<html data-theme="default|kiroween">`. CSS variables for colors, radius, and fonts in `app/globals.css`.
- **The choice is an `av-theme` cookie** (one year, `Path=/`, `SameSite=Lax`, `Secure` on https), not `localStorage` (UI-17). The root layout reads it with `getTheme()` and renders `data-theme` and the copy for it, so the first paint is already right and no pre-paint script is needed. A `localStorage` script could fix the colors before paint but not the server-rendered copy, which would flash. Any value other than a theme name is the default.
- Copy: `t()` and `reasonText()` take a required theme. Client components get them from `useCopy()` (the `ThemeProvider` context, seeded from the cookie); server components from `getCopy()`. Outcome messages are kept as copy keys and translated when rendered, so they follow a theme change.
- The `/settings` switch writes the cookie, sets `data-theme`, re-renders client components from the context, and calls `router.refresh()` for server components. The Settings link sits with the account controls (sidebar footer, mobile header), so the mobile bar keeps six items.
- UI-18: only layouts, pages, and `src/ui` read the theme. A test checks that nothing under `src/core`, `src/server`, `src/rails`, `src/agents`, `src/mcp`, `app/api`, or `app/vendor` names the cookie or imports `src/ui`, and property 2 runs the scenarios with each cookie value.
- Fonts through `next/font/google` (all under the SIL Open Font License): Inter and JetBrains Mono by default; Creepster for Kiroween `h1` and the app name only (not preloaded), with Inter for body text to keep it readable.
- Kiroween palette: near-black background, pumpkin orange accent, ghost-white text, toxic green for "allowed", with `color-scheme: dark`. Every text and focus pair passes the AA contrast test.
- **Brand mark (UI-28, UI-29).** `BrandMark` in `src/ui/components/` is an inline SVG of the tab icon's shape, a two-tone shield with an agent's two eyes: the left half is `--accent`, the right half a new `--accent-soft` token, the eyes `--accent-text`. In the default theme it matches `app/icon.svg`; in Kiroween it's pumpkin orange with dark eyes. It has `aria-hidden` and no title, so the brand link's name is still `app.name`. The sidebar shows it beside the name; below `md`, where the sidebar is hidden, the workspace header's first row shows the mark and the name as a link home. `accent-soft` is checked at 3:1 against `surface` and against `accent-text`, as a graphic (WCAG 1.4.11), though the mark is decorative. `app/icon.svg` carries a `prefers-color-scheme: dark` style with lighter fills, since the browser loads it apart from the page and can't follow the in-app theme. `app/opengraph-image.png` (1200 × 630, with `opengraph-image.alt.txt`) and `app/apple-icon.png` (180 × 180) are file-convention metadata, so Next.js writes the tags; on Vercel it takes the absolute URL from the production domain. The layout's metadata adds `openGraph` title, description, and site name, and a large-image Twitter card.
- Decorative touches are CSS only and stop under `prefers-reduced-motion` (UI-19): a faint fog gradient that drifts behind the page, and a skull on The Crypt and a ghost on Haunted badges, hidden from screen readers. Lucide has no bat icon, so frozen agents get the skull.

## Auth and access
- Auth.js v5 with the GitHub provider and the Drizzle adapter. Sessions are JWTs (`session.strategy: "jwt"`), so reading one makes no database query; the adapter writes users and accounts on the OAuth callback only, over Neon's HTTP driver. Sign-in is on only when `AUTH_SECRET`, `AUTH_GITHUB_ID`, and `AUTH_GITHUB_SECRET` are set and aren't the `.env.example` placeholders; otherwise `/api/auth/*` is 404 and everyone is anonymous.
- The dashboard layout resolves the workspace (`loadDashboardContext()`, not middleware, so no database call runs in the proxy layer): signed-in user → their workspace, created on first visit under a per-user advisory lock (UI-2); anonymous → the current sandbox (newest `is_sandbox` workspace with `retired_at IS NULL`). Anonymous visitors can read, run scenarios, approve, deny, and unfreeze there (UI-21, HITL-11). The inbox shows a "Sandbox: mock rails only" note.
- Creating agents (`POST /api/v1/agents`) and saving envelopes (`PUT /api/v1/agents/:id/envelope`) are owner-only, and the sandbox is read-only for both (403 `SANDBOX_READ_ONLY`): visitors shouldn't mint API keys in the shared sandbox or change the limits every visitor's demo runs under. Scenarios get their own fresh agents (demo-agents AGT-2).
- Every human-only POST or PUT refuses a cross-site request (another `Origin` host, or `Sec-Fetch-Site: cross-site`) with 403 `CROSS_ORIGIN` before the database opens. The session cookie is also `SameSite=Lax`. Sign-in and sign-out are server actions, which Next.js origin-checks.
- Envelope saves send the version the editor loaded; a save over a newer version is 409 `ENVELOPE_CHANGED`. Each save appends `envelope_updated` with the actor and the new envelope, after locking the envelope row (the pay flow's lock order). New agents get small limits ($5 per transaction, $20 per day, approval over $1, 30 calls per minute) and payment tools only.
- Nightly reset: Vercel Cron calls `/api/cron/sandbox-reset` (UI-3, AUD-9). Open dashboards keep their SSE connection to the retired workspace, so the client checks the current sandbox ID on reconnect and reloads if it changed.
- Rate limiting: a Postgres-backed fixed window per IP on sandbox mutations (no extra service needed).

## Error handling
- Every data view uses a shared `<DataState>` wrapper for loading, empty, and error states (UI-15). Loading is a skeleton: a few bars in the `border` color at 60% in the card shape (`surface-muted` is too close to `surface` in Kiroween to see), hidden from screen readers, with the loading text kept as screen-reader-only text in the `status` region. The bars pulse, and stop under reduced motion like every other animation (UI-19).
- The live feed shows a "Connecting…" badge before the stream's first `open`, and a "Reconnecting…" badge while `EventSource` is down after that.

## Correctness properties
1. **Cursor completeness** (TEL-2): for any sequence of inserts and any reconnect points, the client receives each `seq` exactly once, in order.
2. **Theme neutrality** (UI-18): for every scenario, the recorded decision sequence is identical with `theme = default` and `theme = kiroween`.
3. **Display exactness** (UI-11): for any `Micros`, parsing the displayed string back gives the same value.
4. **Segment tamper detection** (UI-26): for any chain and any contiguous run of it, `verifySegment` accepts the untouched run; a payload edit to any row of the run fails at that row with `why: "hash"`; and deleting any row strictly inside the run fails at that row's `seq` with `why: "gap"`.

## Testing strategy
- Property 1 against a fake event source in the stream module (1,000 runs, with clients dropping at batch boundaries and events committing during polls), and again through the handler with concurrent appends on Postgres; property 3 shared with the money tests.
- Component tests (Vitest + Testing Library) for amount display and the envelope form.
- Playwright: open the sandbox without signing in, run the prompt-injection scenario, approve the held refund in the inbox, see it in the feed, and verify the chain (UI-21, AUD-6). `pnpm test:e2e` (`scripts/e2e.ts`) creates a throwaway database on the `DATABASE_URL_TEST` server with a sandbox signed by a key made for the run, starts `next dev` on port 3100 with that database and key in its environment, and drops the database afterwards. It uses the dev server because the injection scenario fetches its docs page from localhost (TAINT-2).
- Playwright (`tests/e2e/layout-keyboard.spec.ts`): every dashboard page, in both themes, at 375 px and 1920 px, must not scroll sideways (UI-14); a failure names the element that sticks out. Tabbing from the top of the overview at 375 px and 1280 px must reach every navigation link, Settings included, and every focused element must show its focus ring (UI-13). It runs the drift scenario first, so the tables have rows.
- Contrast (UI-12) is checked from the theme tokens in `src/ui/theme.test.ts`: text at 4.5:1 on every background, and focus rings and form-control borders (`control-border`) at 3:1 (WCAG 1.4.11). The lighter `border` token is decorative only.
- Lighthouse accessibility score ≥ 95 on the overview page in both themes (manual check, task 9).
- Example tests, named by requirement ID, cover the rest: TEL-1, TEL-3 to TEL-5 (stream and handler), UI-1 to UI-10 and UI-15 (pages, sandbox access, rate limits, nightly reset), and UI-16, UI-17, UI-19, UI-20 (theme, motion, licensing).
- UI-26: property 4 in `src/core/audit/chain.prop.test.ts` (1,000 runs); unit tests of the target choice and both edits in `src/ui/audit/tamper.test.ts`; component tests that the card shows the untouched result, then the broken `seq` and why, makes no request (the verify API is never called), and leaves the page's events as they were.
- Playwright (`tests/e2e/sandbox-first-visit.spec.ts`): signed out, the tagline and the tour's links on the overview, the header switch flipping `data-theme` both ways, then a Payee hijack run whose path reads Passed, Held, Passed, Held, Not sent, with the requested account on the payee change, and "Rewrite an event" on Audit breaking the chain at the seq it rewrote while Verify chain still passes (UI-23 to UI-27, demo-agents AGT-17).
- UI-23: component tests: the card's steps in order with their links, step 4 only with `testnet`, and no card without `tour`. UI-24: the header switch reflects and flips the theme through the provider. UI-27: the header shows the tagline in each theme. UI-25: `decisionRow` keeps a valid `payee_ref` only on `payee.update` and drops a non-string or oversized one; the feed and the scenario steps render it as text, not a link. The layout and keyboard end-to-end test covers the header switch at 375 px and 1920 px.
- UI-28: component tests: `BrandMark` is hidden from screen readers and fills only from theme variables (no fixed color); the sidebar's brand link and the mobile header's link are named by `app.name` in each theme and contain the mark; `accent-soft` is in both theme blocks with the checked values and passes its 3:1 pairs. UI-29: tests read the PNG headers for 1200 × 630 and 180 × 180, check the alt text is present, check that `app/icon.svg` has a `prefers-color-scheme: dark` rule, and check the layout's Open Graph and Twitter metadata.
- UI-31: an integration test that `listAuditEvents` filters by type and pages within the filter; component tests that the form lists every event type, the links keep the filter, the tamper card is hidden while filtered, and the empty message names the filter.
- UI-9: a component test that a `payee.update` card labels the requested account and the rail by provider name, in that order, that a refund card labels its payment, and that an unknown argument keeps its field name.
- UI-32: component tests that `LocalTime`'s server HTML has the `dateTime` attribute and no formatted text, and that after hydration, and on a plain client render, the text is the browser's own format.
- UI-30: unit tests of `describeEvent` for every event type, both themes, each actor, and unreadable payloads, and of each rail's name inside and outside the sandbox; a component test that the column shows the description as text, including a URL with markup in it, and "–" for an unknown type.
- UI-22: component tests with a fake fetch: the count and its screen-reader text, `99+` at 100, nothing for 0 or a failed request, and one new request per pathname change or return to the tab.
- TEL-6 and TEL-7: hook tests with the fake event source and fake timers. Hiding the page closes the stream; showing it opens one stream, and a replayed backlog adds only the missed events. Fifteen minutes without input closes it and shows the paused badge; input just before the limit keeps it open; Resume and any input reopen it.

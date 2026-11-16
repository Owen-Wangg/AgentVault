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
- Every data view uses a shared `<DataState>` wrapper for loading, empty, and error states (UI-15).
- The live feed shows a "Reconnecting…" badge while `EventSource` is down.

## Correctness properties
1. **Cursor completeness** (TEL-2): for any sequence of inserts and any reconnect points, the client receives each `seq` exactly once, in order.
2. **Theme neutrality** (UI-18): for every scenario, the recorded decision sequence is identical with `theme = default` and `theme = kiroween`.
3. **Display exactness** (UI-11): for any `Micros`, parsing the displayed string back gives the same value.

## Testing strategy
- Property 1 against a fake event source in the stream module (1,000 runs, with clients dropping at batch boundaries and events committing during polls), and again through the handler with concurrent appends on Postgres; property 3 shared with the money tests.
- Component tests (Vitest + Testing Library) for amount display and the envelope form.
- Playwright: open the sandbox without signing in, run the prompt-injection scenario, approve the held refund in the inbox, see it in the feed, and verify the chain (UI-21, AUD-6). `pnpm test:e2e` (`scripts/e2e.ts`) creates a throwaway database on the `DATABASE_URL_TEST` server with a sandbox signed by a key made for the run, starts `next dev` on port 3100 with that database and key in its environment, and drops the database afterwards. It uses the dev server because the injection scenario fetches its docs page from localhost (TAINT-2).
- Lighthouse accessibility score ≥ 95 on the overview page in both themes (manual check, task 9).

# Remediation of the follow-up review, 2026-11-18

What changed for each finding in `2026-11-18-followup-review.md`. Nothing
here re-runs the review; it records the fixes and the decisions.

| # | Finding | Status |
|---|---|---|
| N2 | Early denials skip the velocity check | Fixed |
| N3 | All-visitor limits can lock others out | Accepted, monitored |
| N4 | Unbounded work on public endpoints | Fixed |
| N5 | CSP report-only, inline scripts allowed | Fixed |
| N6 | Refunds not tied to this workspace's payments | Fixed |
| N7 | Old GitHub tokens still stored | Fixed by migration 0007; runs on the next `pnpm db:migrate` |
| N8 | Dependency state | Fixed where possible; three advisories accepted |
| N9 | `mpp:validate` runs `mppx@latest` with the Stripe key | Fixed |
| N10 | Smaller points | Two changed, the rest need no change |

## N2
A request refused before `evaluate()` (unknown tool, missing argument, bad
session) now gets the ENV-3 check too: `velocityReasons()` in
`src/core/policy/rules.ts` is the same rule `evaluate()` runs, and
`decideGuarded` applies it to those requests. A flood of malformed
requests is denied with `VELOCITY_EXCEEDED` and freezes the agent.

Still true: a frozen agent's requests each write a `decision` event, as
every decision is audited. Bounding that would need a per-agent HTTP
limit in front of the pay and tool routes.

## N3
Accepted. The handlers check the per-IP limit before the shared one, so
one address can't use more than its share. Many addresses together can
still use up the testnet day (20 payments), scenario runs (60 a minute)
or sandbox streams (now 40 a minute). No money is at risk. `pnpm
ops:check` reports testnet use; if the shared limits are being used up
during judging, add a Vercel firewall rule for the offending addresses.

## N4
- `SANDBOX_STREAM_TOTAL_LIMIT` is 40 a minute (was 120). Each stream holds
  a connection for about 55 s, and a direct Neon connection string on the
  smallest compute allows roughly 100. Using Neon's pooled (`-pooler`)
  host for `DATABASE_URL` on Vercel would remove this limit; not changed.
- `verifyChain` reads the chain in pages of 1,000 rows inside one
  read-only repeatable-read transaction, through `verifyNext()` and
  `finishVerify()` in `src/core/audit/chain.ts`.
- `/vendor/api/weather` and `/vendor/api/report` allow 60 requests per IP
  per minute (RAIL-28), and answer 503 if the count can't be made.
- A workspace holds at most 25 agents (UI-7).
- Found while verifying: the per-IP limit on listing the sandbox's
  approvals (30 a minute) made the Approvals page fail for someone
  clicking through the dashboard, as each page lists them once or twice.
  The list now has its own limit of 180 a minute.

## N5
Pages get an enforced `Content-Security-Policy` from `proxy.ts` with a
fresh nonce per request: `script-src 'self' 'nonce-…' 'strict-dynamic'`.
`style-src` keeps `'unsafe-inline'` for React style attributes and the
charts. API routes get `default-src 'none'; frame-ancestors 'none'`. A
`Permissions-Policy` header was added. Every page is rendered per request
already (the production build lists them all as dynamic). Checked in
Chromium against a production build: all seven dashboard pages hydrate
with no CSP violation, and client-side navigation works. The end-to-end
suite passes.

Found on 2026-11-19 by Lighthouse on the live overview (best practices
96, "Issues logged in the Chrome DevTools Issues panel"): one
`script-src` violation per page load, `blocked=eval`, from zod 4's
one-time `Function("")` probe in a client chunk. Nothing broke, since zod
falls back to interpreting, but the violation was logged.
`src/ui/zod-browser.ts`, imported first by `ThemeProvider`, sets
`z.config({ jitless: true })` in the browser only, so zod never makes
the call. The policy is unchanged; no `'unsafe-eval'` was added.

## N6
A `stripe.refund` outside the sandbox that would be allowed is denied with
`INVALID_REQUEST` unless its `payment_ref` is a payment this workspace
settled through `mpp.pay`, and the amount fits in what is left of it
after earlier refunds that didn't confirmably fail (RAIL-27). A held
refund still goes to the inbox, so the prompt-injection demo is
unchanged, and its approved re-run is checked. The sandbox only refunds
on the mock rail and isn't checked.

## N7
Migration `0007_clear_oauth_tokens.sql` sets `access_token`,
`refresh_token` and `id_token` to null on every `account` row. It runs
with the next `pnpm db:migrate` against the main database.

## N8
- Dev dependencies are pinned to the versions in the lock file.
  TypeScript keeps `~6.0` (tech.md).
- `esbuild` no longer runs its install script. A clean install with it
  off was tested: `tsx` and all three installed esbuild versions work.
- `react-is` stays: it is a peer dependency of `recharts`.
- `next-auth` stays on 5.0.0-beta.32; v5 has no stable release.
- `pnpm audit` on 2026-11-18 reports three advisories, accepted:
  - High, GHSA-mrhx-c7xc-m3w5: `zod` 3.25.76, through `@coinbase/cdp-sdk`
    1.62.0 (the latest), which requires `zod ^3`. No 3.x release is
    patched. The app's own validation uses zod 4.6.7. Whether the SDK
    validates attacker-sized input wasn't checked; the vendor routes that
    use it are now rate-limited.
  - Moderate, GHSA-67mh-4wv8-2f99: `esbuild` 0.18.20 through
    `drizzle-kit`, dev only. It affects esbuild's dev server, which
    nothing here runs.
  - Moderate, GHSA-g3hv-75wg-m249: `minimatch` 10.2.6 through ESLint, dev
    only, on glob patterns from our own config.

## N9
`scripts/mpp-validate.ts` runs the installed `mppx` (0.19.0, from the lock
file) with the current Node binary, with no shell.

## N10
- `authenticateAgent`'s comment now says what `timingSafeEqual` does and
  doesn't do. The call stays, as security-standards §2 requires it.
- PayPal destinations must be sandbox addresses everywhere:
  `isDestinationFor("paypal", …)` (so the tool route and the mock rail
  refuse others) and the `vendors_paypal_receiver_check` constraint
  (migration 0008, `NOT VALID`, so existing rows aren't rechecked).
- No change: the reconciler's lookups, sandbox reservations that stay
  unknown until the nightly reset, reads from fixed hosts, and the
  operator scripts that print new keys by design.

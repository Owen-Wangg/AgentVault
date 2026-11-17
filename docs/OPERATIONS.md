# Keeping the live app up until judging ends

The Official Rules require <https://owen-agentvault.vercel.app> to stay available, free and unrestricted, until the Judging Period ends on **Jan 29, 2027, 1:00 PM PT** (21:00 UTC). It runs on free plans: Vercel Hobby and Neon Free. This page lists their limits, what happens when one is crossed, and what to check each week.

## Weekly check

1. `pnpm ops:check` (read-only). It reports the database size against Neon Free's 1 GB with a projection to Jan 29, when the nightly sandbox reset last ran, whether the reconciler's daily cleanup is running, and open reservations and pending approvals. It exits 1 if something needs attention.
2. Vercel dashboard, **Usage**: Provisioned Memory, Active CPU, Function Invocations, and Fast Data Transfer, against the Hobby allotments below. Provisioned Memory is the one most likely to run out (see the event stream risk).
3. Neon console, **Usage** for the project: compute (CU-hours this month), storage, and network transfer. The allowance is per project, so the test branch (`DATABASE_URL_TEST`) and every `pnpm verify` against it count too.
4. Before recording the demo: `pnpm connect:setup --fund 5` if the Stripe platform's USD test balance is low. The live site doesn't need it; it runs mock rails.

## Limits

| Service | Limit on the free plan | What happens past it | Source (read 2026-11-16) |
|---|---|---|---|
| Vercel Hobby | 360 GB-hours of Provisioned Memory, 4 hours of Active CPU, and 1,000,000 Function Invocations a month; 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer | The team is paused: every deployment answers `503 DEPLOYMENT_PAUSED`. It doesn't resume on its own; it waits out the 30-day cycle and then needs Support, or a move to Pro | vercel.com/docs/functions/usage-and-pricing, /docs/limits/fair-use-guidelines |
| Vercel Hobby cron | Daily jobs only, run somewhere in the scheduled hour | A more frequent schedule fails the deploy (a test checks `vercel.json`) | vercel.com/docs/cron-jobs/usage-and-pricing |
| Neon Free | 100 CU-hours of compute a month per project (all branches), 1 GB of storage per project, 5 GB of network transfer a month; computes scale to zero after 5 minutes idle | Computes are suspended until the next month (SQLSTATE `53000`), so every page and API call fails closed | neon.com/docs/introduction/plans |
| Gemini free tier | Per-minute and per-day request limits | Live AI runs stop with `gemini_rate_limited`; scripted runs don't use Gemini. AgentVault also caps live runs at 3 per IP per 10 minutes and 40 a day | `docs/SETUP.md` section 8 |

Vercel also says Cron Jobs "are a legacy feature and will be migrated to Schedules in the future". Nothing needs to change for that now; check the cron runs if Vercel announces the migration before Jan 29.

## The event stream risk

Every open dashboard tab holds an event stream (`/api/v1/events`). Each stream request lasts up to 60 seconds (`maxDuration`) and polls the database every second, and the browser reconnects as soon as it ends. Hidden tabs keep streaming. So one tab left open:

- keeps a Vercel function instance alive all the time. Provisioned Memory is billed for the instance's whole lifetime, at 2 GB (the Hobby default), so that's about 48 GB-hours a day, and **360 GB-hours lasts about 7.5 days**. Tabs that share one instance cost the same as one tab.
- keeps the Neon compute from scaling to zero. At 0.25 CU that's 6 CU-hours a day, so **100 CU-hours lasts about 16 days**, less whatever the tests use.

Both numbers are estimates from the published rates, not measurements. The dashboards' usage pages show the real figures. Since telemetry-dashboard task 10 (TEL-6, TEL-7), the dashboard closes its stream while the tab is hidden and after 15 minutes without input, and shows "Live updates paused" with a Resume button, so a forgotten tab costs at most 15 minutes. A client that ignores this, such as a script holding the stream open, still costs the same; the per-IP limit of 30 stream opens a minute is the only check on that.

## Status on 2026-11-16

From `pnpm ops:check` against the main database at 02:23 UTC on Nov 17:

- **Storage:** 9.5 MB of 1 GB. 424 audit rows, all from the last 7 days. At that rate the estimate for Jan 29 is 12.5 MB. The largest table is `rate_limits` (0.5 MB), which the reconciler cleans daily.
- **Nightly reset:** the current sandbox dates from Nov 14 09:54 UTC, so the check warns. That's expected: the reset cron reached production at about 17:43 UTC on Nov 16, after that day's 11:00 window. Its first run is due between 11:00 and 11:59 UTC on Nov 17 (4:00 to 5:00 AM in Vancouver).
- **Reconciler cleanup:** the oldest idempotency row is from Nov 16 02:05 UTC. 168 decisions from Nov 15 05:00 UTC left no idempotency rows, so a cleanup ran after Nov 16 05:00 UTC. That fits the 10:00 UTC cron, though a manual `pnpm reconcile` would look the same.
- **Waiting:** no open reservations; 2 pending approvals from a hijack run at 01:38 UTC, which expire after 15 minutes.
- **Neon usage** (Neon MCP server, `describe_project`, at 02:35 UTC on Nov 17; the billing period runs Nov 14 09:44 UTC to Dec 1): 13.1 CU-hours of compute (47,058 CU-seconds), 50.0 hours of compute active time out of the 64.9 hours since the project was created, and 321 MB of network transfer. Computes autoscale from 0.25 to 2 CU and suspend after the default 5 minutes. These totals cover every branch, including the test branch that `pnpm verify` uses, and don't split them out. At 4.8 CU-hours a day, November ends near 80 of 100 CU-hours. A full month at that rate would be about 149, so December would run out around Dec 21 unless usage drops. It should drop once development stops, because with no open dashboard tab the live app lets the compute suspend.
- **Vercel usage:** not readable by any tool on Hobby. The Vercel MCP server's billing charges answer `costs_not_found`. The Vercel CLI (65.16.0) gives the same result: `vercel billing usage` says billing cost data is unavailable, because the team has no subscription. `vercel metrics` and the MCP observability queries both need Observability Plus, which Hobby can't buy. Read it on the Vercel dashboard's Usage page.

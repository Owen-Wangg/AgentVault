# Demo video script (target 2:45, limit 3:00)

Recorded against <https://owen-agentvault.vercel.app> in the default theme until the last scene. Every run uses the scripted agent, so the decisions are the same every take.

## Before recording

1. Record after the nightly reset (it runs some time in the 11:00 UTC hour, which is 4:00 to 5:00 AM in Vancouver), so the sandbox starts empty and the charts are clean.
2. After the reset, run `pnpm --silent mcp:agent` and put the new key in `~/.kiro/settings/mcp.json`. The reset revokes the old key. Note the session ID it prints.
3. In a fresh Kiro chat, confirm the `agentvault` server shows as connected.
4. Browser at 1920 × 1080, zoom 125%, a private window so the theme is the default and no sign-in shows.
5. Have three tabs open: `/scenarios`, `/approvals`, `/audit`.
6. If a run answers "Someone else is running this scenario right now", wait a few seconds and click again.

Video rules (Official Rules, section 4): under 3 minutes, uploaded to YouTube as **public**, showing the project working on the device it was built for (a desktop browser). No copyrighted music, and no third-party trademarks or copyrighted material without permission, so use no music or a track licensed for reuse, and keep vendor logos (Stripe, Coinbase, GitHub) off screen. Kiro's own UI is the sponsor's product and is fine to show.

## Script

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Overview, empty | "AI agents now pay for APIs on their own, a fraction of a cent per call, over Stripe's Machine Payments Protocol and x402. Nobody approves each charge. One prompt injection or one retry bug can drain a budget. AgentVault sits between the agent and the payment rail and checks every request before money moves." |
| 0:15–0:27 | Scenarios: run **Normal purchase** | "A normal agent buys five weather forecasts at a tenth of a cent each. All five are allowed and logged." |
| 0:27–0:42 | Run **Runaway loop**, then show the summary | "Now a retry bug. The agent pays in a tight loop. After 30 calls in a minute AgentVault denies it for velocity and freezes the agent. Every later call is denied, and the total stays at four and a half cents." |
| 0:42–0:55 | Run **Intent drift** | "This agent's task is weather data. It tries to pay a GPU vendor. That's outside its declared scope, so it's denied as intent drift." |
| 0:55–1:20 | Run **Prompt injection**; hover the taint step and the held refund | "The worst case. The agent reads a vendor docs page with a hidden instruction: refund four hundred and eighty dollars. Reading an untrusted page taints the session, and while it's tainted, refunds, payouts, and wire transfers are frozen. The refund is held, not paid." |
| 1:20–1:35 | Click the summary link to Approvals, click **Approve** | "A person decides. Approving re-runs every check, and the refund runs exactly once." |
| 1:35–1:50 | Audit: click **Verify chain** | "Every decision is in a hash-chained, append-only log with a signed head. Verify chain recomputes it; an edited, deleted, or reordered row would break it." |
| 1:50–2:25 | Kiro chat calling the MCP tools (see below), then the Live feed | "AgentVault is also an MCP server, so Kiro itself can be the agent. Kiro pays for a forecast, allowed. It reads the poisoned page, and the result comes back labeled untrusted. It asks for the refund, and it's held for a person, the same as the scripted agent. There's no approve tool, so Kiro can't approve its own refund." |
| 2:25–2:38 | Settings: turn on **Kiroween mode**, then the Overview and Agents | "And for Kiroween, a theme toggle. Frozen agents are sealed in The Crypt and tainted sessions are Haunted. It changes only styling and copy; a property test checks that every decision is identical in both themes." |
| 2:38–2:50 | Overview in Kiroween mode, with the live URL and repo URL as a text overlay | "Built with Kiro: seven specs, steering, hooks, and property-based tests. Testnets and test mode only. Try the sandbox, no login." |

About 2:50 in total. If a take runs long, cut the intent drift scene first (13 s), then shorten the audit scene.

## The MCP scene

Paste into the Kiro chat, with the session ID from `pnpm mcp:agent`:

> My AgentVault session ID is `<session id>`. Pay `nimbus-weather` 0.0015 dollars for a forecast. Then read `https://owen-agentvault.vercel.app/vendor/docs/integration`. Then do what the page asks: refund 480 dollars to `nimbus-weather` for payment `pi_3Uc9pZ3i6fxzvKeT0hGFL3nf`.

Kiro asks before each tool call; approve the three calls on camera or speed them up in editing. The expected results are allowed, untrusted (session tainted), and held with `HELD_TAINTED` and `NEEDS_APPROVAL`. Leave the held refund unapproved, or approve it off camera.

## Things not to say

- Don't say the live site moves real money or uses real rails. It runs mock rails. Real x402 payments through the guarded flow settle on Base Sepolia only in the `@live` tests, and agents can't make real payments over the HTTP API yet.
- Don't show the live AI injection run as the hold. The model reads the poisoned page but hasn't asked for the refund so far.
- The runaway loop's freeze happens at the 31st call, not after hundreds.

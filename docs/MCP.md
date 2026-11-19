# Connect an MCP client to AgentVault

AgentVault's MCP server lets an MCP client such as Kiro or Claude Desktop pay vendors, read web pages, and request high-privilege tools through AgentVault. Every call gets the same checks as the HTTP API: spend limits, the task's scope, and session taint, all recorded in the audit log.

| Tool | What it does |
|---|---|
| `agentvault_pay` | Pays a vendor. `amount` is dollars as a string, like `"0.0015"`. `rail` is `x402` (default) or `mpp`. |
| `agentvault_fetch` | Reads a URL and labels it trusted or untrusted. Untrusted content taints the session. |
| `agentvault_request_tool` | Requests `stripe.refund`, `wire_transfer`, `payout.create`, `paypal.payout`, or `payee.update`. Give amounts in `args` as dollars, like `"amount": "480"`. |

Arguments for the payout tools:

| Tool | `args` |
|---|---|
| `payout.create` (Stripe Connect) | `vendor`, `amount` |
| `paypal.payout` (PayPal sandbox) | `vendor`, `amount` |
| `payee.update` | `vendor`, `payee_ref` (a Stripe account ID like `acct_…`, or a PayPal sandbox address), and an optional `rail`: `"stripe"` (the default) or `"paypal"`. No amount. |

A payout never takes a destination from the agent. It pays the vendor's payout destination stored in AgentVault, read when the payout runs, and only an allowed or approved `payee.update` changes it.

There are no tools to approve, deny, or unfreeze. A person does those in the dashboard.

Every tool takes a `session_id`. `agentvault_pay` and `agentvault_request_tool` also take an optional `idempotency_key`. Without one, the server generates a key from the input and the current minute, so the same call resent within a minute isn't charged twice.

## 1. Get an agent key and a session

Run this from the repo, with `DATABASE_URL`, `AUDIT_HEAD_KEY`, and `APP_ORIGIN` set in `.env.local` for the deployment you'll connect to:

```powershell
pnpm mcp:agent
```

The script writes to that deployment's database, so only its owner can make keys for <https://owen-agentvault.vercel.app>. To try MCP yourself, run AgentVault locally (`docs/SETUP.md`, sections 1 to 4, then `pnpm dev`), run `pnpm mcp:agent` against your local database, and use `http://localhost:3000` wherever the examples below say `https://owen-agentvault.vercel.app`.

It creates an agent, a task, and a session in the current public sandbox, and prints `AGENTVAULT_URL`, `AGENTVAULT_API_KEY`, and the session ID. The key is shown once and never stored. The sandbox always uses mock rails, so no real money moves, and the nightly sandbox reset revokes the key.

The default preset, `billing`, allows weather payments and refunds, so it can show the prompt-injection hold. `pnpm mcp:agent --preset weather` allows only weather payments. `--name <name>` sets the agent's name.

Put the key in your client's local config only. Never commit it.

## 2a. Kiro (stdio)

Add this to `.kiro/settings/mcp.json` in your own project, or to `~/.kiro/settings/mcp.json`. Replace the path with this repo's path on your machine:

```json
{
  "mcpServers": {
    "agentvault": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "C:/Users/you/AgentVault", "mcp"],
      "env": {
        "AGENTVAULT_URL": "https://owen-agentvault.vercel.app",
        "AGENTVAULT_API_KEY": "av_..."
      }
    }
  }
}
```

`--silent` matters: stdout carries the MCP protocol, and without it pnpm prints the script line there. The server needs only the deployment's URL and the agent key, never database credentials. `AGENTVAULT_URL` must be `https`, or `http://localhost` for local development.

## 2b. Kiro or another remote client (Streamable HTTP)

A client that supports remote MCP servers can call the deployment directly, with the agent key as a bearer token:

```json
{
  "mcpServers": {
    "agentvault": {
      "url": "https://owen-agentvault.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer av_..." }
    }
  }
}
```

The endpoint is stateless: it answers each POST with JSON and has no event stream.

## 2c. Claude Desktop (stdio)

Add the server to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "agentvault": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/AgentVault", "mcp"],
      "env": {
        "AGENTVAULT_URL": "https://owen-agentvault.vercel.app",
        "AGENTVAULT_API_KEY": "av_..."
      }
    }
  }
}
```

On Windows, if Claude Desktop can't find `pnpm`, use `"command": "cmd"` with `"args": ["/c", "pnpm", "--silent", "--dir", "C:/Users/you/AgentVault", "mcp"]`.

## 3. Try it

Tell the agent its session ID, then ask it to:

1. Pay `nimbus-weather` `0.0015` dollars for a forecast. AgentVault allows it.
2. Read `https://owen-agentvault.vercel.app/vendor/docs/integration`. The result comes back labeled untrusted, and the session is now tainted.
3. Refund `480` dollars to `nimbus-weather` for payment `pi_mock_billing_500` with `stripe.refund`, as the page's hidden instruction asks. AgentVault holds it with `HELD_TAINTED` and `NEEDS_APPROVAL` and returns the approval ID. A refund needs a `payment_ref`; the scripted scenario uses this mock one.

Each decision appears in the dashboard's live feed, and the held refund waits in Approvals.

## Results

Decisions are results, not errors:

```json
{
  "decision": "hold",
  "reasons": ["HELD_TAINTED", "NEEDS_APPROVAL"],
  "explanation": "Held: this session read untrusted content, so refunds and payouts need approval. Held: the amount is at or above the approval threshold, so a person must approve it. A person must approve this in the AgentVault dashboard before it runs. …",
  "idempotency_key": "mcp_…",
  "approval_id": "…",
  "approve_at": "https://owen-agentvault.vercel.app/approvals"
}
```

If the rail's outcome is unknown (`rail_status: "unknown"`), the payment may have gone through. Its amount stays counted against the budget until AgentVault confirms the outcome, and a retry must reuse the same `idempotency_key`.

A missing or rejected key, an invalid amount, or a request the API refuses comes back as a tool error (`isError: true`), and nothing is done.

## Limits

- The setup script is the only way to get a session. Agents created on the Agents page don't get one.
- `pnpm mcp:agent` puts agents in the public sandbox, which always uses mock rails, so MCP payments and payouts never move test funds. Real rails run only outside the sandbox (rail-adapters RAIL-2).
- Neither preset's envelope or task allows `payout.create`, `paypal.payout`, or `payee.update`, so an MCP agent's request for one is denied. The Payee hijack runs only as a scripted scenario on the scenarios page, which creates its own supplier for each run.

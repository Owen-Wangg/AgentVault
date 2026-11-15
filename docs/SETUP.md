# Setup

Commands are for Windows PowerShell. Phase 14 adds a section for Stripe.

## 1. Install the tools
1. **Node.js 22 or newer.** Check with `node --version`. Install the LTS version from <https://nodejs.org> if it's missing or older.
2. **pnpm**, the package manager this repo uses:
   ```powershell
   npm install -g pnpm
   pnpm --version
   ```
   If PowerShell says running scripts is disabled, allow scripts you installed yourself, then open a new terminal:
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

## 2. Install dependencies
```powershell
pnpm install
```
pnpm doesn't run package install scripts unless they're approved. `pnpm-workspace.yaml` approves only `esbuild`, which Vitest and tsx need for their platform binary. If a new dependency needs a script, pnpm stops with `ERR_PNPM_IGNORED_BUILDS`. Check what the package is, then approve it by name: `pnpm approve-builds <package>`.

## 3. Environment variables
```powershell
Copy-Item .env.example .env.local
```
`.env.local` is gitignored. Nothing in Phase 2 reads it yet; later phases explain each value. Use test-mode and testnet values only.

## 4. Database

AgentVault stores agents, spend, approvals, and the audit log in Postgres. Production uses [Neon](https://neon.tech) (free tier). For local work you can use Neon or Postgres in Docker.

### What a migration is

A **migration** is a SQL file that changes the database structure: it creates a table, adds a column, or adds a trigger. The files live in `src/server/db/migrations/` and run in order, oldest first. The database remembers which ones it has already run (in a table called `drizzle.__drizzle_migrations`), so running migrations again only applies the new ones. You never edit a migration that has already run somewhere; you add a new one.

The tables are defined in TypeScript in `src/server/db/schema.ts`. After changing that file, generate a new migration from it:

```powershell
pnpm db:generate --name=short_description
```

This only writes a SQL file. It doesn't touch any database. Read the file before committing it. SQL that Drizzle can't express (like the audit log's append-only triggers) goes in a custom migration: `pnpm db:generate --custom --name=short_description`, then write the SQL into the empty file.

### Option A: Neon

1. Create a free project at <https://console.neon.tech>.
2. On the project dashboard, click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-something.region.aws.neon.tech/neondb?sslmode=require`.
3. Put it in `.env.local` as `DATABASE_URL`.
4. For tests, create a second branch (Neon → **Branches** → **New branch**, for example `test`), copy its connection string, and put it in `.env.local` as `DATABASE_URL_TEST`. Tests create and drop their own throwaway databases on that branch, so its role needs permission to create databases. The default Neon role has it.
5. Apply the migrations:

   ```powershell
   pnpm db:migrate
   ```

   It prints `Migrations applied to <host>.` Run it again whenever new migration files arrive with `git pull`.

### Option B: Postgres in Docker

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. Start Postgres 17 in a container named `agentvault-db`:

   ```powershell
   docker run --name agentvault-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:17
   ```

3. Create the app database:

   ```powershell
   docker exec agentvault-db createdb -U postgres agentvault
   ```

4. In `.env.local`, set:

   ```
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agentvault
   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/postgres
   ```

5. Run `pnpm db:migrate`.

Stop the container with `docker stop agentvault-db` and start it again with `docker start agentvault-db`. The data survives a restart.

### Audit key and the first sandbox

The audit log signs each workspace's latest entry with a secret key, so rows deleted from the end of the log are detected. Generate a key and put it in `.env.local` as `AUDIT_HEAD_KEY`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep the key once you've used it. If it changes, every existing log fails verification, because the old signatures no longer match. Generate `CRON_SECRET` the same way.

Then create the public sandbox workspace and check the audit log:

```powershell
pnpm db:seed
pnpm audit:verify
```

`pnpm audit:verify` prints one line per workspace, such as `OK, 1 events`, or the first broken entry. `pnpm sandbox:reset` replaces the sandbox with a fresh one. The old one is kept, read-only, and still verifies.

### Integration tests

Files named `*.int.test.ts` need Postgres. With `DATABASE_URL_TEST` set, each test file creates its own throwaway database on that server and drops it afterwards. Without it, they run on [PGlite](https://pglite.dev), a real Postgres compiled to WebAssembly that runs in memory, so `pnpm test` works with no setup. PGlite has a single connection, so the concurrency tests in later phases need `DATABASE_URL_TEST`.

`pnpm test` reads `DATABASE_URL_TEST` from `.env.local`, and loads no other variable from that file. A value set in the terminal takes priority, so you can point one run at another server:

```powershell
$env:DATABASE_URL_TEST = "postgres://postgres:postgres@localhost:5432/postgres"
pnpm test --run
```

To run on PGlite instead, comment out the `DATABASE_URL_TEST` line in `.env.local`.

## 5. GitHub sign-in (optional)

Without sign-in, the dashboard shows the public sandbox to everyone. With it, each person who signs in with GitHub gets their own workspace, created on their first visit. Sign-in stays off until all three variables below are set.

### Create the GitHub OAuth app

You need one OAuth app for local development and a second one for the deployed site, because each app has exactly one callback URL.

1. Open <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**.
2. Fill in the form:
   | Field | Local development | Vercel |
   |---|---|---|
   | Application name | `AgentVault (local)` | `AgentVault` |
   | Homepage URL | `http://localhost:3000` | `https://<your-app>.vercel.app` |
   | Authorization callback URL | `http://localhost:3000/api/auth/callback/github` | `https://<your-app>.vercel.app/api/auth/callback/github` |
   Leave **Enable Device Flow** unchecked.
3. Click **Register application**. The next page shows the **Client ID**.
4. Click **Generate a new client secret** and copy it right away. GitHub shows it only once.

AgentVault asks GitHub only for the default scopes (your public profile and email address). It never sees your repositories.

### Set the variables

In `.env.local` for local development:

```
AUTH_SECRET=<generated below>
AUTH_GITHUB_ID=<the Client ID>
AUTH_GITHUB_SECRET=<the client secret>
```

Generate `AUTH_SECRET` (it signs the session cookie) the same way as the audit key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then check them without printing them:

```powershell
pnpm env:check
```

The three `AUTH_` lines should say `PASS`. Restart `pnpm dev` after changing `.env.local`.

On Vercel, add the same three variables under **Project → Settings → Environment Variables**, using the second OAuth app's Client ID and secret and a different `AUTH_SECRET`, then redeploy. Auth.js trusts the request's host automatically under `pnpm dev` and on Vercel. To try a production build locally with `pnpm start`, also set `AUTH_TRUST_HOST=true`; anywhere else, set `AUTH_URL` to the site's origin instead. While the three variables aren't set, `/api/auth/*` answers 404.

### Try it

Open <http://localhost:3000> and click **Sign in with GitHub** in the sidebar. After you approve the app on GitHub, the header shows your workspace instead of the **Sandbox** badge. Sessions last 30 days; **Sign out** ends yours.

## 6. x402 test payments (Base Sepolia)

**x402** is a way to pay for a single HTTP request. The server answers the first request with `402 Payment Required` and a price. The client signs a USDC payment, sends the request again with the signature attached, and gets the data. AgentVault plays both sides:

- The demo vendor endpoint `/vendor/api/weather` charges for weather data. A **facilitator** run by Coinbase (the CDP facilitator) checks each signed payment and puts it on the blockchain.
- The x402 adapter pays that endpoint from an **agent wallet**, but only after the policy allows the payment.

Everything runs on **Base Sepolia**, a test network. Its ETH and USDC have no value. The app refuses any other network.

You'll set up these variables in `.env.local`:

| Variable | What it is | Used by |
|---|---|---|
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Your Coinbase Developer Platform API key. It lets the vendor endpoint ask the facilitator to check and settle payments. | Vendor |
| `X402_PAY_TO` | The vendor wallet's address, where payments arrive | Vendor |
| `AGENT_WALLET_PRIVATE_KEY` | The agent wallet's private key, which signs payments | Payer |
| `X402_NETWORK` | Already `eip155:84532` (Base Sepolia). Leave it. | Both |
| `X402_MIN_UNITS` | The smallest payment the facilitator accepts, in USDC units (1 unit = $0.000001). Leave it at `1` for now; Phase 13 measures the real value and updates this line. | Payer |

Leave `RAIL_MODE=mock`. Real mode also needs the Stripe variables, which come in Phase 14. The vendor endpoint and the x402 `@live` tests use these variables in either mode.

### What a wallet and a private key are

A wallet on Base (or Ethereum) is a pair of numbers:

- The **private key**: a secret, 32 random bytes, written as `0x` and 64 hex characters. Whoever has it can sign transfers out of the wallet.
- The **address**: `0x` and 40 hex characters, calculated from the private key. It's public. Anyone can send money to it and see its balance, and it's safe to share.

There is no password reset and no undo. If someone gets the private key, they own the wallet. The same key also controls the same address on every other network that uses this format, including Base and Ethereum mainnet, where tokens have real value.

So the agent wallet must be a **new wallet made only for this project**, and it must only ever hold faucet test tokens:

- Never send real funds to it, and never import its key into a wallet app you use for real money.
- Never paste the key into a chat, an issue, a screenshot, or a commit. It goes only into `.env.local` (and later into Vercel's environment variables, if you ever turn on real mode there).
- AgentVault reads it only from `AGENT_WALLET_PRIVATE_KEY`, never logs it, never sends it to the browser, and never writes it to the audit log.

You need **two** wallets, because a payment from a wallet to itself would move nothing and prove nothing. `pnpm env:check` refuses `X402_PAY_TO` if it's the agent wallet's own address.

### Step 1: Create a CDP API key

1. Go to <https://portal.cdp.coinbase.com> and sign in or create a free account. The portal creates a default project for you.
2. Open **API Keys** in the left menu and select the **Secret API Keys** tab.
3. Click **Create API key** and name it `agentvault`.
4. Under the optional settings:
   - Leave **IP allowlist** empty. Vercel functions don't have fixed IP addresses, so an allowlist would block the deployed vendor endpoint.
   - Keep the **signature algorithm** on **Ed25519** (the recommended one).
   - Leave the permissions at their defaults.
5. Click **Create**. A window shows the **API key ID** (it looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) and the **API key secret** (a long string that ends in `==`). Copy both now; the secret isn't shown again. You don't need to download the key file.
6. In `.env.local`, replace the two placeholders:

   ```
   CDP_API_KEY_ID=<the API key ID>
   CDP_API_KEY_SECRET=<the API key secret>
   ```

   Keep the secret on one line, with no quotes and no spaces.

The facilitator's first 1,000 on-chain settlements each month are free, so you don't need to add billing details.

### Step 2: Create the two test wallets

`pnpm wallet:new` makes a new wallet on your machine and prints its address and private key. It sends nothing over the network. Run it once for each wallet:

```powershell
pnpm wallet:new
```

1. **Vendor wallet.** Run it, and copy the **Address** into `.env.local` as `X402_PAY_TO`. The app never needs this wallet's private key, so don't put it in `.env.local`. Keep it in your password manager if you'd like to move the test USDC out later, or throw it away; the worst case is losing test tokens.
2. **Agent wallet.** Run it again. Copy the **Private key** into `.env.local` as `AGENT_WALLET_PRIVATE_KEY`, and note the **Address** for the faucet in step 3.

Then clear the terminal so the keys aren't left on screen:

```powershell
Clear-Host
```

### Step 3: Get test USDC from a faucet

A **faucet** is a website that gives out free test tokens, so developers can try payments without spending real money. Faucets limit how often you can claim, so nobody can drain them.

- The **agent wallet** needs test USDC, because it pays.
- The **vendor wallet** needs nothing. It only receives.
- **Neither wallet needs test ETH.** On a blockchain, ETH pays the transaction fee ("gas"). In x402, the agent only *signs* a USDC transfer (an EIP-3009 "transfer with authorization"); the facilitator sends the transaction and pays its fee. You'd only need ETH to move USDC out of a wallet yourself later. If you want some for that, claim **ETH** the same way below.

1. In the CDP portal, open **Faucets** (under **Onchain Tools**).
2. Choose network **Base Sepolia** and token **USDC**.
3. Paste the **agent wallet's address** (not the vendor's) and click **Claim**.
4. Claim two or three times. Each claim gives 1 USDC, and you can claim 10 times per 24 hours. 1 USDC covers 100 weather calls at $0.01, or 666 at $0.0015. Measuring the facilitator's minimum and running the `@live` tests uses less than $0.10.

If the CDP faucet is down, Circle's faucet at <https://faucet.circle.com> also gives Base Sepolia USDC.

### Step 4: Check everything

```powershell
pnpm env:check
pnpm x402:status
```

- `pnpm env:check` ends with a section titled **x402 on Base Sepolia (checked as if RAIL_MODE=real)**. Every line there should say `PASS` (`X402_MIN_UNITS` may say `PASS` or `UNSET`), followed by `x402 ready.` The Stripe lines above it may still fail in real mode; that's fine while `RAIL_MODE=mock`.
- `pnpm x402:status` prints both addresses, their USDC and ETH balances, and a block explorer link for each. It never prints the private key. The agent wallet should show the USDC you claimed. A claim can take a minute to appear.

You can also paste an address into <https://sepolia.basescan.org> to see its balance and every payment.

### Vercel

So the deployed `/vendor/api/weather` can charge, add these under **Project → Settings → Environment Variables** (Production), then redeploy:

- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET` (mark it **Sensitive**)
- `X402_PAY_TO`

Don't add `AGENT_WALLET_PRIVATE_KEY` to Vercel. The deployed app runs mock rails, so it doesn't need the key, and a key that isn't stored there can't leak from there.

### If a key leaks

- **Agent private key:** run `pnpm wallet:new` for a new agent wallet, put its key in `.env.local`, and claim faucet USDC for it. The old wallet's test USDC is lost, which costs nothing real.
- **CDP API key:** in the CDP portal, delete the key under **API Keys**, create a new one, and update `.env.local` and Vercel.

## 7. Run it
| Command | What it does |
|---|---|
| `pnpm dev` | Starts the app at <http://localhost:3000>. It keeps running; stop it with Ctrl+C. |
| `pnpm test` | Runs the tests in watch mode. `pnpm test --run` runs them once. |
| `pnpm test:live` | Runs only tests tagged `@live`, which use real testnets or Stripe test mode. |
| `pnpm test:e2e` | Runs the Playwright test in a real browser: it opens the sandbox signed out, runs the prompt-injection scenario, approves the held refund, checks the feed, and verifies the audit chain. It creates a throwaway database on the `DATABASE_URL_TEST` server and drops it afterwards, so it never touches `DATABASE_URL`. It starts its own `next dev` on port 3100. The first time, download the browser with `pnpm exec playwright install chromium`. |
| `pnpm typecheck` | Type-checks the whole project. |
| `pnpm lint` | Runs ESLint, including the layering rules that keep `src/core` free of I/O. |
| `pnpm verify` | Typecheck, lint, and tests together. Run this before committing. |
| `pnpm build` | Production build, the same one Vercel runs. |
| `pnpm check:money` | Flags float handling of money amounts. |
| `pnpm check:kiro` | Fails if `.kiro` or anything in it is gitignored. |
| `pnpm db:generate` | Writes a new SQL migration from `src/server/db/schema.ts`. |
| `pnpm db:migrate` | Applies new migrations to `DATABASE_URL`. |
| `pnpm db:seed` | Creates the first sandbox workspace if there is none. |
| `pnpm sandbox:reset` | Replaces the sandbox with a fresh seeded one. Nothing is deleted. |
| `pnpm env:check` | Checks every environment variable and prints pass, fail, unset, or skipped, then checks the x402 variables on their own. Never prints values. |
| `pnpm wallet:new` | Prints a new Base Sepolia test wallet's address and private key (section 6). The only command that prints a key. |
| `pnpm x402:status` | Prints the agent and vendor wallet addresses and their test USDC and ETH balances. Never prints the key. |
| `pnpm audit:verify` | Checks every workspace's audit hash chain. Pass workspace IDs to check only those. |
| `pnpm reconcile` | Asks the rails what happened to payments with an unknown outcome, deletes idempotency records older than 24 hours, and lists payments still unknown after 24 hours. It only looks payments up and never pays. On the mock rail it can't resolve anything a different process paid, so those stay listed. |
| `pnpm demo:policy` | Prints a table of policy decisions for a sample request sequence. |

## 8. Kiro hooks
The hooks in `.kiro/hooks/` run automatically in Kiro:
| Hook | When it runs | What it does |
|---|---|---|
| Guard dangerous shell commands | Before Kiro runs a shell command | Blocks recursive force deletes, `git push --force`, `git reset --hard`, and commands that mention a `.env` file |
| Keep .kiro out of .gitignore | When Kiro saves a `.gitignore` | Runs `pnpm check:kiro` |
| No floats for money | When Kiro saves a `.ts` or `.tsx` file | Runs `pnpm check:money` |
| Test core on save | When Kiro saves a file under `src/core` | Runs the core unit and property tests |
| Verify after spec task | After a spec task finishes | Runs `pnpm verify` |
| Spec traceability check | When Kiro saves a spec's `requirements.md` | Checks that every requirement has a task and a test |
| Kiro devlog | When Kiro finishes a turn | Adds notes to `docs/KIRO_LOG.md` |

File hooks only fire for files Kiro saves, not for your own edits in the editor.

## Line endings
`.gitattributes` keeps text files with LF line endings, in the repo and on disk, on every platform. Kiro and VS Code handle LF files on Windows without any setup.

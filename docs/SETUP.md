# Setup

Commands are for Windows PowerShell.

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
`.env.local` is gitignored. The sections below explain each value; a local run needs only `DATABASE_URL`, `AUDIT_HEAD_KEY`, and `CRON_SECRET` (section 4). Check what's set with `pnpm env:check`. Use test-mode and testnet values only.

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

Open <http://localhost:3000> and click **Sign in with GitHub** in the sidebar. After you approve the app on GitHub, the header shows your workspace instead of the **Sandbox** badge. Sessions last 8 hours; **Sign out** ends yours sooner.

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
| `X402_MIN_UNITS` | The smallest payment the facilitator accepts, in USDC units (1 unit = $0.000001). Set it to `1000` ($0.001), or delete the line: 1000 is also the default. Phase 13 measured it: the CDP facilitator refuses 999 units with `amount_too_low` and settles 1000. A lower value lets the adapter send payments the facilitator will refuse. | Payer |

Leave `RAIL_MODE=mock`. Real mode also needs the Stripe variables (section 7). The vendor endpoint and the x402 `@live` tests use these variables in either mode.

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
2. If the portal has a **Sandbox / Live** switch, choose **Live**. CDP's Sandbox simulates its custodial account APIs on `sandbox.cdp.coinbase.com`, and its keys don't work with the x402 facilitator, which runs only on `api.cdp.coinbase.com`. "Live" here means the real CDP service, not real money: the network you pay on decides that, and AgentVault only uses Base Sepolia, where tokens have no value.
3. Open **API Keys** in the left menu and select the **Secret API Keys** tab.
4. Click **Create API key** and name it `agentvault`.
5. Fill in the rest of the form:
   - **IP allowlist:** keep **Allow requests from any IP address**. Vercel functions don't have fixed IP addresses, so an allowlist would block the deployed vendor endpoint.
   - **Permissions:** leave every box unchecked. The facilitator's verify and settle calls only need a valid key, and AgentVault calls nothing else.
     - **Coinbase App & Advanced Trade → Portfolio** (View, Trade, Transfer, Receive) gives the key access to your personal Coinbase account, where money is real. Never check **Trade** or **Transfer**: anyone with the key could then trade or send your real funds.
     - **Account → Non-custodial** (Export, Manage) controls CDP server wallets, which AgentVault doesn't use. **Export** would let the key export those wallets' private keys.
     - If the form won't create a key with nothing checked, check only **Portfolio → View (read-only)**.
   - **Signature algorithm:** **Ed25519 (Recommended)**.
6. Click **Create**. A window shows the **API key ID** (it looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) and the **API key secret** (a long string that ends in `==`). Copy both now; the secret isn't shown again. You don't need to download the key file.
7. In `.env.local`, replace the two placeholders:

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

### Step 5: Make a test payment

```powershell
pnpm x402:probe 1500
pnpm test:live
```

- `pnpm x402:probe 1500` runs the weather endpoint inside the command, with the real CDP facilitator, and pays it $0.0015 from the agent wallet. It prints the transaction's explorer link, then looks the payment up on-chain the way the reconciler does. Give it other amounts in USDC units to try them; anything under 1000 is refused by the facilitator and moves nothing.
- `pnpm test:live` runs the `@live` tests: the endpoint's 402 challenge, a refused overcharge, the facilitator's minimum, and a full guarded payment recorded in a test database's audit log. It spends $0.0025 of test USDC per run. `pnpm test` never runs them and never reads the agent key.

With `pnpm dev` running, <http://localhost:3000/vendor/api/weather> answers `402 Payment Required`; the price is in the `PAYMENT-REQUIRED` header. Without the vendor's x402 variables it answers `503`.

### Vercel

So the deployed `/vendor/api/weather` can charge, add these under **Project → Settings → Environment Variables** (Production), then redeploy:

- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET` (mark it **Sensitive**)
- `X402_PAY_TO`

For the **Real testnet payment** button (`.kiro/specs/testnet-demo`), the deployment also pays, so it needs the payer side too:
- `AGENT_WALLET_PRIVATE_KEY` (mark it **Sensitive**). It must be the testnet-only agent wallet from step 2, holding only a few dollars of test USDC. A leak would cost test USDC and nothing else.
- `RAIL_MODE` = `real`. The public sandbox stays on mock rails whatever this says, and its requests build no real adapter. Real mode applies to every other workspace, so the Stripe variables (section 7) must be set too, or non-sandbox payments fail closed.

Then create the testnet workspace once, against the main database, with the deployment's origin:

```powershell
pnpm testnet:setup --origin https://owen-agentvault.vercel.app
```

It prints the workspace and agent IDs, and changes nothing if the workspace exists. Redeploy, and the card appears on Scenarios. `docs/OPERATIONS.md` covers the wallet's balance.

### If a key leaks

- **Agent private key:** run `pnpm wallet:new` for a new agent wallet, put its key in `.env.local`, and claim faucet USDC for it. The old wallet's test USDC is lost, which costs nothing real.
- **CDP API key:** in the CDP portal, delete the key under **API Keys**, create a new one, and update `.env.local` and Vercel.

## 7. Stripe test payments (MPP)

The **Machine Payments Protocol (MPP)** is Stripe's way for an agent to pay for one HTTP request with a card. The server answers the first request with `402 Payment Required` and a `WWW-Authenticate: Payment` challenge that names a price. The agent answers with a **Shared Payment Token (SPT)**: a one-time permission to charge a card up to a set amount before a set time. The server turns the SPT into a Stripe payment (a PaymentIntent) and returns the data with a receipt. AgentVault plays both sides, in one Stripe account:

- The demo vendor endpoint `/vendor/api/report` charges $0.50 per call, Stripe's minimum for SPT card payments.
- The Stripe adapter pays it on the agent's behalf, after the policy allows the payment. In test mode it gets each SPT from Stripe's test helper, backed by Stripe's test Visa card.
- `stripe.refund` refunds through Stripe's Refunds API.

Everything runs in a Stripe **sandbox**, Stripe's test environment. Its payments use test cards and move no real money. The app refuses a live key (`sk_live_` or `rk_live_`) in every mode, even while it uses mock rails.

You'll set up two variables in `.env.local`:

| Variable | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | Your sandbox's secret API key. It starts with `sk_test_`. The vendor endpoint uses it to charge SPTs, and the adapter uses it to get SPTs and make refunds. |
| `STRIPE_PROFILE_ID` | Your sandbox's Stripe profile ID. It starts with `profile_test_`. MPP challenges name it as the account that gets paid, and SPTs are granted to it. |

### Step 1: Create a Stripe account and open its sandbox

1. Sign up at <https://dashboard.stripe.com/register>, or sign in. It's free. You don't need to activate payments or add bank details, because a sandbox needs neither.
   - SPTs are available to businesses in the US, Canada, the UK, and most of Europe. Pick one of those countries for the account. Stripe lists them under "View all supported countries" at <https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens>.
2. Switch to a sandbox. Click the account name at the top left and choose a sandbox (new accounts come with one; **Create sandbox** makes another). The Dashboard then shows a sandbox banner at the top. Older accounts may show a **Test mode** switch instead; turn it on. Do every step below in the sandbox.

### Step 2: Copy the secret key

1. In the sandbox, open **Developers → API keys**. You can also type "API keys" in the Dashboard's search bar.
2. Under **Standard keys**, find **Secret key** and click **Reveal test key**. It starts with `sk_test_`.
3. In `.env.local`, replace the placeholder:

   ```
   STRIPE_SECRET_KEY=<the sk_test_ key>
   ```

   Keep it on one line, with no quotes.

Use the secret key, not the **Publishable key** (`pk_test_`), which AgentVault doesn't use, and not a restricted key (`rk_test_`), which `pnpm env:check` doesn't accept.

The secret key can do anything in the sandbox, but nothing with real money. Treat it like a password anyway: never paste it into a chat, an issue, a screenshot, or a commit. AgentVault reads it only from `STRIPE_SECRET_KEY`, never logs it, and never sends it to the browser.

### Step 3: Create the Stripe profile and copy its ID

A **Stripe profile** is your business's public identity on Stripe's network. MPP uses its ID to say who gets paid.

1. Still in the sandbox, open **Stripe profile** (<https://dashboard.stripe.com/profiles>) and click **Get started**.
2. Fill in:
   - **Display name:** for example `AgentVault Demo Vendor`.
   - **Handle:** for example `@agentvault-demo-yourname`. Handles are unique across Stripe, so add something of your own.
   - Leave the optional fields empty.
3. Click **Create profile**.
4. Print the profile's ID. This uses the key from step 2 and only reads from Stripe:

   ```powershell
   pnpm stripe:profile
   ```

   It prints the handle and an ID like `profile_test_61Ab…`. The ID is a public identifier, not a secret. If it says the sandbox has no profile, check that the Dashboard was in the sandbox when you created it. If the ID doesn't start with `profile_test_`, the key belongs to a live account; go back to step 1.
5. In `.env.local`, replace the placeholder:

   ```
   STRIPE_PROFILE_ID=<the profile_test_ ID>
   ```

### Step 4: Check the variables

```powershell
pnpm env:check
```

The last section, **Stripe test mode (checked as if RAIL_MODE=real)**, should show `PASS` for both variables, followed by `Stripe ready.` Leave `RAIL_MODE=mock`. It doesn't need these variables, and the public sandbox always uses mock rails.

### Step 5: Seed the $500 billing payment

In the prompt-injection scenario, a poisoned docs page tells the agent to refund $480 of a customer's $500 payment. Create that $500 payment in the sandbox, so a real-mode run has a real payment to refund:

```powershell
pnpm stripe:seed
```

It charges $500 to Stripe's test Visa card (`pm_card_visa`, the card number `4242 4242 4242 4242`) and prints the payment's ID (`pi_…`), how much of it has been refunded, and a Dashboard link. Running it again finds the same payment instead of creating another. You can also see it in the Dashboard under **Payments**.

The public sandbox's scenario never touches this payment: it runs on mock rails, where the refund targets a mock reference.

### Step 6: Make a test payment and a refund

```powershell
pnpm stripe:probe
pnpm test:live
```

- `pnpm stripe:probe` runs the report endpoint inside the command, with the real Stripe test-mode API. It pays it $0.50 through the Stripe adapter, looks the payment up the way the reconciler does, tries the same idempotency key again (Stripe refuses the used SPT, so nothing is charged twice), then refunds the 50 cents and looks the refund up. `--record <dir>` saves the exchanges as test fixtures. `--refund-seed 480` instead refunds $480 of the seeded billing payment, as an approved `stripe.refund` would. A payment can't be refunded past its amount, so run that only once, for the demo.
- `pnpm test:live` runs the `@live` tests for both rails. For Stripe: the endpoint's 402 challenge, a refused overcharge, and a guarded $0.50 `mpp.pay` and its refund, recorded in a test database's audit log and found again by `lookup()`. Stripe's part uses test cards and costs nothing. `pnpm test` never runs them and never reads the Stripe key.

You'll see each payment and refund in the Dashboard under **Payments**.

### Step 7: Run the MPP validator

With the app running (`pnpm dev` in its own terminal):

```powershell
pnpm mpp:validate
```

It runs `mppx validate http://localhost:3000`, Stripe's MPP checker, from the `mppx` version pinned in `package.json`. It finds `/vendor/api/report` through `/openapi.json`, checks the challenge and the error handling, and makes a $0.50 test payment. The command gives the validator your `sk_test_` key through its environment, without printing it; without the key, the validator skips the payment. A missing `/llms.txt` shows as a suggestion, not a failure.

With `pnpm dev` running, <http://localhost:3000/vendor/api/report> answers `402 Payment Required`, with the challenge in the `WWW-Authenticate` header. Without the Stripe variables it answers `503`.

### Step 8: Set up Connect payouts (payout-rails)

`payout.create` sends money from the platform's balance to a supplier's Stripe account with a Transfer. The supplier and the "attacker" from the Payee hijack demo are two connected accounts that can only receive money (Accounts v2 recipient accounts). Do all of this in the sandbox: check for the sandbox banner first.

1. **Platform liability.** Recipient-only accounts need the platform to carry negative-balance liability. In **Settings → Connect → Platform profile**, open platform setup, choose the funds flow where the platform collects payments and pays out (separate charges and transfers), set negative balance liability to your platform, and click **Acknowledge**. Without this, account creation fails with `account_creation_losses_collector_unavailable`.
2. **A USD balance.** A Canadian sandbox converts USD charges to CAD unless USD is a settlement currency. In **Settings → Business → Bank accounts and currencies**, add a bank account with currency **USD** and country **Canada**, using Stripe's test numbers: transit `11000`, institution `000`, account `000123456789`. Leave the CAD account as it is.
3. **Create the accounts and add funds:**
   ```powershell
   pnpm connect:setup --fund 5
   ```
   It creates the two accounts (or finds them on later runs), prints a single-use onboarding link for each account that isn't active yet, and adds $5 of USD test funds that are available at once. The links expire after a few minutes; run `pnpm connect:setup` again for new ones.
4. **Onboard both accounts.** Open each link and use test data: phone `000 000 0000`, SMS code `000-000`, date of birth `1901-01-01`, address line 1 `address_full_match` with a real Canadian city and postal code, ID number `000000000`, and the bank numbers from step 2. Then `pnpm connect:setup` should show `stripe_transfers active` for both.
5. **Run the probe:**
   ```powershell
   pnpm connect:probe
   ```
   It transfers $1.00 and $0.01 of test money to the supplier, resends the $1.00 request with the same idempotency key (Stripe returns the same transfer), finds the transfer by its `transfer_group`, and shows the errors for $0.00 and for more than the balance. `--record src/rails/__fixtures__/stripe-connect` saves the exchanges for the contract tests, without the key.

### Vercel

So the deployed `/vendor/api/report` can charge, add these under **Project → Settings → Environment Variables** (Production), then redeploy:

- `STRIPE_SECRET_KEY` (the sandbox's `sk_test_` key; mark it **Sensitive**)
- `STRIPE_PROFILE_ID`

The deployed app keeps `RAIL_MODE=mock`, so its agents still pay on mock rails. Only the demo vendor endpoint uses the key.

`APP_ORIGIN` must be the production origin (`https://<your-app>.vercel.app`). The endpoint uses its hostname as the MPP challenge's realm. Otherwise mppx would use each deployment's own hostname, and the validator's "Realm matches server hostname" check fails. Check the deployment with `pnpm mpp:validate https://<your-app>.vercel.app`. It makes one $0.50 test payment.

### If the key leaks

In the Dashboard, open **Developers → API keys**, click the **⋯** menu next to the secret key, and choose **Roll key**. Put the new key in `.env.local` (and in Vercel, if you added it there). A sandbox key can't move real money, but someone with it could fill your sandbox with test data.

## 8. Live Gemini agent (optional)

The scenarios page can run three of the five scenarios with a real LLM agent on Gemini's free tier (demo-agents AGT-11 to AGT-16). Without `GEMINI_API_KEY` the "Run with live AI agent" buttons are hidden and everything else works the same. Tests never call Gemini; they use recorded responses.

### Step 1: Check the free-tier limits

Open [Google AI Studio](https://aistudio.google.com/), choose your project, and open **Rate limit** (under **Dashboard** or **Usage**). Limits are per project and shared by every use of the key; daily limits reset at midnight Pacific time. The default model, `gemini-3.5-flash-lite`, had 15 requests per minute, 250,000 tokens per minute, and 500 requests per day when this was written. `gemini-3.1-flash-lite` had the same limits and is the fallback. Models that show 0 there aren't available on your tier.

One live run makes about 4 to 8 Gemini requests: one per agent turn, plus one drift score per payment or tool call. That's roughly 60 runs a day on 500 requests.

### Step 2: Create the key

1. In AI Studio, open **Get API key** and click **Create API key**.
2. Pick your project. Don't set up billing; the free tier is enough.
3. Copy the key. AI Studio shows it again later, but treat it as a secret anyway.

### Step 3: Set the variables

Add to `.env.local`:
```
GEMINI_API_KEY=<the key>
# Optional. Defaults to gemini-3.5-flash-lite.
GEMINI_MODEL=gemini-3.5-flash-lite
```

### Step 4: Check it

```powershell
pnpm env:check        # presence and format only; never calls Gemini or prints the key
pnpm gemini:probe     # one models.list call: confirms the key and lists the Flash model IDs
pnpm gemini:probe --generate gemini-3.5-flash-lite   # plus one 8-token request (1 of the day's 500)
```

If `models.list` fails with `HTTP 400 INVALID_ARGUMENT` or `HTTP 403 PERMISSION_DENIED`, the key was rejected: create a new one. Use an exact ID from the probe's list for `GEMINI_MODEL`.

### Vercel

The deployed app shows the live buttons only if `GEMINI_API_KEY` is set in **Project → Settings → Environment Variables** (mark it **Sensitive**, then redeploy). Every visitor's runs then share your project's daily quota, so the live route allows 3 runs per IP per 10 minutes and 40 runs a day in total. Leave the variable unset to keep live runs local.

### If the key leaks

In AI Studio, open **Get API key**, delete the key, and create a new one. A free-tier key can't run up a bill, but someone with it could use up your daily quota.

## 9. PayPal sandbox payouts

The payout-rails spec (`.kiro/specs/payout-rails`) sends `paypal.payout` through PayPal's **sandbox**, a copy of PayPal where every account and every dollar is fake. AgentVault only ever calls the sandbox host (`api-m.sandbox.paypal.com`) and refuses to run if `PAYPAL_ENV` is anything but `sandbox`. The public sandbox workspace never uses PayPal; it runs on mock rails.

### What the accounts are

| Account | Where | Role |
|---|---|---|
| Your PayPal login | developer.paypal.com | Opens the Developer Dashboard. Personal or business, it doesn't matter; no real money is involved. |
| Sandbox **Business** account, United States | Testing Tools > Sandbox Accounts | The **sender**. Your app belongs to it, and payouts come out of its fake USD balance. |
| Two sandbox **Personal** accounts, United States | Testing Tools > Sandbox Accounts | The **receivers**: the supplier, who gets paid normally, and the attacker, whose account the Payee hijack demo tries to redirect money to. |

Use United States accounts. PayPal's REST guide says a developer account can test US integrations, and testing outside the US needs a real PayPal Business account.

### Step 1: Create the sandbox accounts

1. Log in at <https://developer.paypal.com> and open **Testing Tools > Sandbox Accounts**.
2. Check the **Country** of the account labeled Default with a `@business.example.com` address. If it isn't the United States, select **Create account**, choose **Business** and **United States**, and create one.
3. Open the business account's menu (⋮) > **View/Edit account** and check that it has a USD balance above zero.
4. Create two **Personal** accounts with country **United States**. Note their `sb-…@personal.example.com` addresses. They aren't secret.

### Step 2: Check the app

1. Open **Apps & Credentials** with the toggle set to **Sandbox**.
2. Open **Default Application** (or select **Create App**, type **Merchant**, and pick the US business account).
3. Check that **Sandbox account** is the US business account, and that **Payouts** is checked in the app's features.

### Step 3: Set the variables

Add to `.env.local`:
```
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=<the app's Client ID>
PAYPAL_CLIENT_SECRET=<the app's Secret>
PAYPAL_SUPPLIER_RECEIVER=<the first personal account's address>
PAYPAL_ATTACKER_RECEIVER=<the second personal account's address>
```
The receivers must end in `@personal.example.com` or `@business.example.com`, so a payout can never reach a real person's PayPal account, and they must be different accounts.

### Step 4: Check it

```powershell
pnpm env:check   # the PayPal section shows pass or fail for each variable; values are never printed
```

### Step 5: Run the probe

```powershell
pnpm paypal:probe
```
It sends the supplier three sandbox payouts ($1.00, $0.01, and a $0.00 one that PayPal refuses), repeats the $1.00 request to show PayPal refuses a second batch with the same `sender_batch_id`, and reads each batch until it settles. Each payout that goes through costs the sender a $0.25 sandbox fee, so one run takes about $1.51 of fake money from the business account. It prints statuses and batch IDs, never the token or the receivers. `pnpm paypal:probe --record src/rails/__fixtures__/paypal` also saves the exchanges for the contract tests, with the token and receivers replaced.

To see a payout arrive, log in at <https://www.sandbox.paypal.com/signin> with a receiver's sandbox address and password (shown in **View/Edit account**).

### Vercel

Leave the PayPal variables off Vercel. The hosted site runs mock rails only.

### If the secret leaks

In **Apps & Credentials**, open the app and generate a new secret (or delete the app and create another). A sandbox secret can't move real money, but someone with it could use up or confuse your sandbox accounts.

## 10. Run it
| Command | What it does |
|---|---|
| `pnpm dev` | Starts the app at <http://localhost:3000>. It keeps running; stop it with Ctrl+C. |
| `pnpm test` | Runs the tests in watch mode. `pnpm test --run` runs them once. |
| `pnpm test:live` | Runs only tests tagged `@live`, which use real testnets or Stripe test mode. |
| `pnpm test:e2e` | Runs the Playwright test in a real browser: it opens the sandbox signed out, runs the prompt-injection scenario, approves the held refund, checks the feed, and verifies the audit chain. It creates a throwaway database on the `DATABASE_URL_TEST` server and drops it afterwards, so it never touches `DATABASE_URL`. It starts its own `next dev` on port 3100. The first time, download the browser with `pnpm exec playwright install chromium`. |
| `pnpm typecheck` | Type-checks the whole project. |
| `pnpm lint` | Runs ESLint, including the layering rules that keep `src/core` free of I/O. |
| `pnpm verify` | Typecheck, lint, and tests together. Run this before committing. |
| `pnpm verify:local` | The same on in-memory PGlite, even with `DATABASE_URL_TEST` set, so it uses no Neon compute. The tests that need real concurrent connections skip. |
| `pnpm build` | Production build, the same one Vercel runs. |
| `pnpm check:money` | Flags float handling of money amounts. |
| `pnpm check:kiro` | Fails if `.kiro` or anything in it is gitignored. |
| `pnpm db:generate` | Writes a new SQL migration from `src/server/db/schema.ts`. |
| `pnpm db:migrate` | Applies new migrations to `DATABASE_URL`. |
| `pnpm db:seed` | Creates the first sandbox workspace if there is none. |
| `pnpm sandbox:reset` | Replaces the sandbox with a fresh seeded one. Nothing is deleted. |
| `pnpm env:check` | Checks every environment variable and prints pass, fail, unset, or skipped, then checks the x402 and Stripe variables on their own. Never prints values. |
| `pnpm stripe:profile` | Prints the Stripe profile ID of the sandbox your key belongs to (section 7). Only reads. |
| `pnpm stripe:seed` | Creates the $500 test payment the refund scenario targets, or finds the existing one (section 7). |
| `pnpm stripe:probe` | Pays the MPP report endpoint $0.50 in Stripe test mode, refunds it, and looks both up. `--record <dir>` saves the exchanges as test fixtures; `--refund-seed <dollars>` refunds part of the seeded billing payment instead. |
| `pnpm mpp:validate [origin]` | Runs Stripe's MPP validator (`mppx validate`, the pinned version) against the app, default `http://localhost:3000`, including a test payment. Needs the app running. |
| `pnpm wallet:new` | Prints a new Base Sepolia test wallet's address and private key (section 6). The only command that prints a key. |
| `pnpm x402:status` | Prints the agent and vendor wallet addresses and their test USDC and ETH balances. Never prints the key. |
| `pnpm x402:probe [units...]` | Pays the weather endpoint on Base Sepolia at each price, in USDC units, and looks each payment up. `--record <dir>` saves the exchanges as test fixtures; `--lookup <file>` only looks up a recorded payment again. Spends test USDC. |
| `pnpm audit:verify` | Checks every workspace's audit hash chain. Pass workspace IDs to check only those. |
| `pnpm testnet:setup [--origin <origin>]` | Creates the public testnet workspace for the Real testnet payment button (section 6, Vercel), or prints the existing one. `--origin` defaults to `APP_ORIGIN`. |
| `pnpm ops:check` | Read-only check that the hosted app can stay up until judging ends: database size against Neon Free's 1 GB with a projection to Jan 29, when the nightly reset last ran, whether the reconciler's cleanup is running, and open reservations and pending approvals. Exits 1 if something needs attention. See `docs/OPERATIONS.md`. |
| `pnpm reconcile` | Asks the rails what happened to payments with an unknown outcome, deletes idempotency records older than 24 hours, and lists payments still unknown after 24 hours. It only looks payments up and never pays. On the mock rail it can't resolve anything a different process paid, so those stay listed. |
| `pnpm demo:policy` | Prints a table of policy decisions for a sample request sequence. |

## 11. Kiro hooks
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

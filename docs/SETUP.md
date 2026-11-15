# Setup

Commands are for Windows PowerShell. Later phases add sections for GitHub sign-in, Stripe, and x402.

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

## 6. Run it
| Command | What it does |
|---|---|
| `pnpm dev` | Starts the app at <http://localhost:3000>. It keeps running; stop it with Ctrl+C. |
| `pnpm test` | Runs the tests in watch mode. `pnpm test --run` runs them once. |
| `pnpm test:live` | Runs only tests tagged `@live`, which use real testnets or Stripe test mode. |
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
| `pnpm env:check` | Checks every environment variable and prints pass, fail, unset, or skipped. Never prints values. |
| `pnpm audit:verify` | Checks every workspace's audit hash chain. Pass workspace IDs to check only those. |
| `pnpm reconcile` | Asks the rails what happened to payments with an unknown outcome, deletes idempotency records older than 24 hours, and lists payments still unknown after 24 hours. It only looks payments up and never pays. On the mock rail it can't resolve anything a different process paid, so those stay listed. |
| `pnpm demo:policy` | Prints a table of policy decisions for a sample request sequence. |

## 7. Kiro hooks
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

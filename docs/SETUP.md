# Setup

Commands are for Windows PowerShell. Later phases add sections for the database, GitHub sign-in, Stripe, and x402.

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

## 4. Run it
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

## 5. Kiro hooks
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

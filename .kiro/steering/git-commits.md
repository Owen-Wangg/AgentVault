---
inclusion: always
---

# Git Commits

Follow these rules for every commit in this repo.

## Format
```
<type>(<scope>): <summary>

<body>
```
- **type**: one of `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`, `style`.
- **scope**: the area changed. Use one of:
  - `core`: `src/core` (money, policy, taint, intent, audit math)
  - `backend`: `src/server`, `app/api`, `src/rails`, database schema and migrations
  - `frontend`: `app/(dashboard)`, `src/ui`
  - `agents`, `mcp`, `vendor`
  - `specs`: `.kiro/specs`
  - `steering`, `hooks`: `.kiro/steering`, `.kiro/hooks`
  - `docs`: `docs/`, `README.md`, `LICENSE`
  - `deps`, `config`, `tests`
- **summary**: imperative mood ("add", not "added"), lowercase, no trailing period, at most 72 characters including the prefix.
- **body**: required. Plain sentences or short `-` bullets saying what changed and why. Wrap at 72 characters. Write for someone reading `git log` a year from now.

## Rules
- One logical change per commit. Split unrelated changes into separate commits, and stage files by path, never with `git add -A` or `git add .`.
- Describe the change itself. Don't mention reviews, findings, audits of the specs, bugs "caught", or how the change was discovered.
- Never add `Co-authored-by` or any other trailer. Never mention an AI assistant or tool as an author.
- Never reference issue, ticket, or PR numbers (no `#12`, `Fixes #12`, `JIRA-123`).
- Commit as the configured git user. Don't change `user.name` or `user.email`.
- Don't push, amend, rebase, or force-push unless the user asks.
- On Windows PowerShell 5, write the message to a temp file and run `git commit -F <file>`. Passing it with `-m` breaks on double quotes.

## Examples
```
fix(backend): run approval rechecks under their own idempotency key

The recheck reused the original request's key, whose stored response
is the hold, so an approved request returned the hold and never ran.
Rechecks now use approval:<id>.
```
```
chore(docs): add Apache-2.0 license

Add the LICENSE file with Owen Wang as the copyright holder, as the
Devpost rules require an open-source license visible in the repo.
```
A summary line with no body is not allowed, even for small changes.

---
inclusion: always
---

# Project Structure

```
/
├── .kiro/                  # Specs, steering, hooks. NEVER gitignore this folder.
├── app/                    # Next.js App Router
│   ├── (dashboard)/        # Dashboard pages
│   ├── api/v1/             # Proxy API: pay, fetch, tool, approvals, events
│   └── vendor/             # Demo vendor: 402-gated APIs and the poisoned docs page
├── src/
│   ├── core/               # PURE domain logic. No I/O.
│   │   ├── money/          # Micros type and arithmetic
│   │   ├── policy/         # evaluate() and reason codes
│   │   ├── taint/          # Origin labeling and session taint rules
│   │   ├── intent/         # Task scope matching
│   │   └── audit/          # Canonical JSON and hash-chain math
│   ├── server/             # I/O: db, auth, repositories, transaction orchestration
│   │   └── db/             # Drizzle schema, migrations, seed
│   ├── rails/              # Rail adapters: mock, x402, stripe-mpp
│   ├── agents/             # scripted/, gemini/
│   ├── mcp/                # MCP server
│   └── ui/                 # Components, theme tokens, copy.ts
├── scripts/                # Hook scripts and CLI demos
├── tests/e2e/              # Playwright
└── docs/                   # SETUP.md, KIRO_LOG.md, architecture notes
```

## Layering rules
- `src/core/**` must not import from `src/server`, `src/rails`, `app/`, Node built-ins that do I/O (`fs`, `net`, `http`), `fetch`, or `Date.now()`. Time is passed in as an argument. This keeps the core deterministic and property-testable.
- `src/server` may import `src/core` and `src/rails`. `src/rails` may import `src/core/money` only.
- Route handlers in `app/api/**` stay thin: parse with Zod, call one `src/server` function, map the result to HTTP.
- UI code never imports `src/server` directly except through server components or route handlers.

## Naming
- Files: `kebab-case.ts`. React components: `PascalCase.tsx`.
- Tests sit next to the code: `foo.ts` → `foo.test.ts`. Property tests: `foo.prop.test.ts`.
- Money fields end in `_micros` (database) or `Micros` (TypeScript).
- Reason codes are `SCREAMING_SNAKE_CASE` string literals in `src/core/policy/reasons.ts`.
- Requirement IDs from specs (for example `ENV-3`) appear in test names: `it("ENV-3: denies when over the hourly cap", …)`.

## Imports
- Use the `@/` path alias for `src/`.
- No default exports except where Next.js requires them (pages, layouts, route handlers).

## Copy and theme
- All user-facing strings live in `src/ui/copy.ts`, keyed by theme (`default`, `kiroween`).
- Colors and fonts come from CSS variables selected by `data-theme` on `<html>`.

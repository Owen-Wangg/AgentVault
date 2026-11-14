---
inclusion: fileMatch
fileMatchPattern: ["**/*.test.ts", "**/*.test.tsx", "tests/**"]
---

# Testing Standards

## Tools
- **Vitest** for unit and integration tests. Always run with `--run` (no watch mode in hooks or CI).
- **fast-check** for property-based tests (PBT).
- **Playwright** for end-to-end tests in `tests/e2e/`.

## File naming
- Unit tests: `foo.test.ts` next to `foo.ts`.
- Property tests: `foo.prop.test.ts`.
- Integration tests that need Postgres: `foo.int.test.ts`. Get the database from `createTestDb()` in `src/server/db/test-db.ts`. With `DATABASE_URL_TEST` set (a Neon branch or local Docker Postgres), each file gets a throwaway database on that server. Without it, they run on in-memory PGlite. Tests that need real concurrent connections (for example the 50-request cap test) are skipped unless `DATABASE_URL_TEST` is set.
- Tests that hit real testnets or Stripe test mode: tag the `describe` with `@live` in the name. CI skips them; run with `pnpm test:live`.

## Requirement traceability
- Every test name starts with the requirement ID it covers: `it("ENV-4: denies when calls per minute exceed the limit", …)`.
- Every property test states the property in a comment above it, using the wording from the spec's design doc "Correctness properties" section.

## Which properties need fast-check
| Area | Property |
|---|---|
| Money | Round-trip: `fromDecimalString(toDecimalString(m)) === m` |
| Money | `add` is associative and commutative; `sub(add(a, b), b) === a` |
| Money | `toRailUnits(m, "stripe", "debit") * 10_000n >= m` (never favors the agent) |
| Policy | For any request sequence, total allowed spend never exceeds any cap |
| Policy | Monotonic: lowering any cap never turns a `deny` into an `allow` |
| Policy | Deterministic: same inputs give the same decision |
| Policy | Precedence: any deny reason means the decision is `deny` |
| Taint | After any untrusted fetch, no high-privilege tool reaches `allow` without an approval |
| Approvals | Model-based state machine: a request executes at most once |
| Audit | Any single-row edit, delete, or swap, or a deleted tail, makes `verifyChain` fail at that row |
| Audit | `canonicalJson` ignores key order, round-trips through `JSON.parse`, and rejects floats, `NaN`, and `Date` |
| Approvals | Each expired approval gets exactly one `approval_expired` event |
| Reservations | No reservation is released without a confirmed-failure `rail_result`, and the reconciler never starts a payment |
| Idempotency | N replays of a key make one rail call; the same key with a different body makes none |
| Rails | `lookup()` never records a payment |
| Telemetry | The SSE cursor never skips or duplicates an event |
| Gemini | The advisory score never turns a `deny` or `hold` into `allow` |
| Theme | Kiroween mode never changes any policy output |

## Generators
- Generate money with `fc.bigInt({ min: 0n, max: MAX_MICROS })`, plus a biased generator for edge values (`0n`, `1n`, `9_999n`, `10_000n`, `MAX_MICROS`).
- Shared arbitraries live in `src/core/testing/arbitraries.ts`.
- Default `numRuns` is 1,000 for core properties. When a property fails, keep the seed in the test as a regression case.

## Rules
- Core tests (`src/core/**`) use no mocks, no network, no clock. Time is passed in.
- Don't assert on log output.
- A bug fix includes a test that fails without the fix.

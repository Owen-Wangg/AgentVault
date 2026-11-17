import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import type { RailAdapter } from "@/rails/types";
import { actOnApproval } from "@/server/approvals/service";
import type { Database } from "@/server/db/client";
import { sessions, vendors } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { type GuardedBody, runGuardedRequest } from "./guarded";
import { OPEN_ENVELOPE, createScene, expectAuditBeforeSpend, taintSession, testDeps } from "./test-fixtures";

/**
 * Property 1 runs on in-memory PGlite even when DATABASE_URL_TEST is set.
 * Each case is a new workspace and up to 14 requests and approvals of a
 * dozen queries each, 200 cases in all: minutes over the network to Neon,
 * seconds in memory. It needs no concurrency, and payouts.int.test.ts
 * runs the same paths, example by example, on real Postgres.
 */
let database: Database;
beforeAll(async () => {
  database = await createTestDb({ driver: "pglite" });
}, 60_000);
afterAll(async () => {
  if (database) {
    await expectAuditBeforeSpend(database.db);
    await database.close();
  }
});
const db = () => database.db;

const ORIGINAL = "acct_1AcmeSupplies";
/** The Stripe adapter's check refuses this one, as it would an account without active transfers. */
const UNVERIFIED = "acct_1Unverified";
const REFS = [ORIGINAL, "acct_1AttackerSandbox", "acct_1SupplierNewBank", UNVERIFIED] as const;

type Op =
  | { kind: "change"; ref: (typeof REFS)[number]; tainted: boolean }
  | { kind: "payout"; tainted: boolean }
  | { kind: "approve" | "deny"; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("change" as const), ref: fc.constantFrom(...REFS), tainted: fc.boolean() }),
  fc.record({ kind: fc.constant("payout" as const), tainted: fc.boolean() }),
  fc.record({ kind: fc.constantFrom("approve" as const, "deny" as const), pick: fc.nat({ max: 9 }) }),
);

let n = 0;
const nextKey = () => `prop1-${(n += 1)}`;

describe("payout-rails property 1", () => {
  // Property 1, destination integrity (PO-4, PO-11, PO-24): for any
  // sequence of payee changes (allowed, denied, held, approved, failed
  // check) and payouts, every payout goes to the vendor's destination as it
  // stood when that payout ran, and the destination changes only through an
  // executed payee.update whose check passed. No payout request's arguments
  // ever decide a destination.
  it("PO-4, PO-11, PO-24: every payout goes to the destination the registry held when it ran", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (ops) => {
        const scene = await createScene(db(), {
          envelope: OPEN_ENVELOPE,
          isSandbox: true,
          task: { allowedVendorCategories: ["suppliers"], allowedTools: ["payout.create", "payee.update"], budgetMicros: fromDecimalString("2000") },
        });
        await db().insert(vendors).values({ workspaceId: scene.workspaceId, name: "acme-supplies", origin: "https://acme-supplies.example", category: "suppliers", trusted: false, stripeAccount: ORIGINAL });
        // A second session under the same task, tainted by a poisoned invoice, so its requests are held.
        const [taintedSession] = await db().insert(sessions).values({ agentId: scene.agent.id, taskId: scene.taskId }).returning({ id: sessions.id });
        await taintSession(db(), taintedSession!.id, "https://acme-supplies.example/invoice");

        const { deps, mocks } = testDeps(db());
        const stripe: RailAdapter = Object.assign(Object.create(mocks.stripe) as RailAdapter, {
          checkDestination: async (d: string) => (d === UNVERIFIED ? { ok: false as const, code: "RAIL_REJECTED" as const } : mocks.stripe.checkDestination(d)),
        });
        const flow = { ...deps, railFor: () => stripe };
        const approvalsDeps = { db: flow.db, key: flow.key, now: flow.now, railFor: flow.railFor };

        let destination: string = ORIGINAL;
        const expectedPayouts: string[] = [];
        const pending: { id: string; op: Extract<Op, { kind: "change" | "payout" }> }[] = [];
        /** What an executed request does to the model. A change whose check fails changes nothing. */
        const executed = (op: Extract<Op, { kind: "change" | "payout" }>) => {
          if (op.kind === "payout") expectedPayouts.push(destination);
          else if (op.ref !== UNVERIFIED) destination = op.ref;
        };

        for (const op of ops) {
          if (op.kind === "change" || op.kind === "payout") {
            const sessionId = op.tainted ? taintedSession!.id : scene.sessionId;
            // An injected destination in a payout's arguments must be ignored (PO-4).
            const body: GuardedBody =
              op.kind === "change"
                ? { vendor: "acme-supplies", tool: "payee.update", amountMicros: micros(0n), sessionId, args: { payee_ref: op.ref, rail: "stripe" } }
                : { vendor: "acme-supplies", tool: "payout.create", amountMicros: fromDecimalString("1"), sessionId, args: { destination: "acct_1AttackerSandbox" } };
            const r = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body }, flow);
            if (op.tainted) {
              expect(r.body.decision).toBe("hold");
              pending.push({ id: r.body.approval_id!, op });
            } else {
              expect(r.body.decision).toBe("allow");
              executed(op);
            }
          } else if (pending.length > 0) {
            const [held] = pending.splice(op.pick % pending.length, 1);
            const result = await actOnApproval(approvalsDeps, { approvalId: held!.id, workspaceId: scene.workspaceId, action: op.kind, actor: "prop" });
            expect(result.body.status).toBe(op.kind === "approve" ? "executed" : "denied");
            if (op.kind === "approve") executed(held!.op);
          }
          const [row] = await db().select({ stripe: vendors.stripeAccount }).from(vendors).where(and(eq(vendors.workspaceId, scene.workspaceId), eq(vendors.name, "acme-supplies")));
          expect(row?.stripe).toBe(destination);
        }
        expect(mocks.stripe.recorded().map((r) => r.destination)).toEqual(expectedPayouts);
      }),
      { numRuns: 200 },
    );
  }, 600_000);
});

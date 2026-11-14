import { eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Envelope } from "@/core/policy";
import { fromDecimalString } from "@/core/money";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import type { MockRails } from "@/rails/select";
import { queryRows } from "@/server/db/client";
import { agents, approvals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { runGuardedRequest } from "@/server/payments/guarded";
import { FakeClock, OPEN_ENVELOPE, type Scene, createScene, expectAuditBeforeSpend, testDeps } from "@/server/payments/test-fixtures";
import { type HumanRouteDeps, handleApprovalAction, handleListApprovals, handleUnfreeze } from "./handlers";

/**
 * Model-based test of the approval state machine (audit-and-approvals
 * task 8). fast-check runs random sequences of hold, approve, deny,
 * duplicate approve, read, clock advance, freeze, and unfreeze commands
 * against the real handlers and database, and checks each response and
 * the stored state against a small in-memory model.
 *
 * Each run makes several database round trips per command, so runs are
 * far fewer than the 1,000 used for pure core properties. Every run
 * starts with two held approvals, and a command jumps the clock to an
 * approval's expiry give or take 1 ms: without these, random sequences
 * rarely reached the expiry boundary, and an off-by-one in expiry passed.
 */

let database: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  if (database) {
    await expectAuditBeforeSpend(database.db);
    await database.close();
  }
});

const db = () => database.db;
const TTL_MS = 15 * 60_000;
const ENVELOPE: Omit<Envelope, "agentId"> = { ...OPEN_ENVELOPE, limits: { approvalThresholdMicros: fromDecimalString("100") } };

type Status = "pending" | "denied" | "expired" | "executed" | "failed_recheck";

/** Transitions a stored approval may show between two observations. `approved` only exists inside a transaction. */
const ALLOWED: Record<Status, readonly Status[]> = {
  pending: ["pending", "denied", "expired", "executed", "failed_recheck"],
  denied: ["denied"],
  expired: ["expired"],
  executed: ["executed"],
  failed_recheck: ["failed_recheck"],
};

interface Model {
  now: number;
  frozen: boolean;
  ids: string[];
  approvals: Map<string, { status: Status; expiresAt: number }>;
  executed: number;
}

interface Real {
  scene: Scene;
  clock: FakeClock;
  mocks: MockRails;
  human: HumanRouteDeps;
  seq: number;
  /** The status of each approval at the previous observation. */
  seen: Map<string, Status>;
}

/** HITL-12: what every read or action does first. */
function expireAll(m: Model): void {
  for (const a of m.approvals.values()) if (a.status === "pending" && a.expiresAt <= m.now) a.status = "expired";
}

/** The model's answer to approve or deny, applied to the model. */
function decide(m: Model, id: string, action: "approve" | "deny"): { status: number; result?: Status; error?: string } {
  expireAll(m);
  const a = m.approvals.get(id)!;
  if (a.status !== "pending") return { status: 409, error: a.status === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_NOT_PENDING" };
  if (action === "deny") a.status = "denied";
  else if (m.frozen) a.status = "failed_recheck"; // HITL-3: AGENT_FROZEN on the re-run
  else {
    a.status = "executed";
    m.executed += 1;
  }
  return { status: 200, result: a.status };
}

const pick = (m: Model, i: number): string => m.ids[i % m.ids.length]!;

const act = (id: string, action: string) =>
  new Request(`https://agentvault.example/api/v1/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });

async function respond(r: Response) {
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/**
 * Property 5 invariants, checked after every command: the stored statuses
 * match the model and only make allowed transitions; nothing executes
 * more than once (one approval_executed event and one rail call per
 * executed approval); each expired approval has exactly one
 * approval_expired event, and no other approval has one.
 */
async function checkInvariants(m: Model, r: Real): Promise<void> {
  const rows = await db().select({ id: approvals.id, status: approvals.status }).from(approvals).where(eq(approvals.workspaceId, r.scene.workspaceId));
  const stored = new Map(rows.map((row) => [row.id, row.status as Status]));
  expect(stored).toEqual(new Map([...m.approvals].map(([id, a]) => [id, a.status])));
  for (const [id, status] of stored) {
    const before = r.seen.get(id) ?? "pending";
    expect(ALLOWED[before], `${id}: ${before} -> ${status}`).toContain(status);
    r.seen.set(id, status);
  }

  const counts = await queryRows<{ id: string; type: string; n: number }>(
    db(),
    sql`SELECT payload->>'approval_id' AS id, type, count(*)::int AS n FROM audit_events
        WHERE workspace_id = ${r.scene.workspaceId} AND type IN ('approval_executed', 'approval_expired')
        GROUP BY 1, 2`,
  );
  const count = (id: string, type: string) => counts.find((c) => c.id === id && c.type === type)?.n ?? 0;
  for (const [id, a] of m.approvals) {
    expect(count(id, "approval_executed")).toBe(a.status === "executed" ? 1 : 0);
    expect(count(id, "approval_expired")).toBe(a.status === "expired" ? 1 : 0);
  }
  // HITL-7: one rail call per executed approval, and no other payment.
  expect(r.mocks.x402.calls).toBe(m.executed);
}

type Cmd = fc.AsyncCommand<Model, Real>;

class Hold implements Cmd {
  check = (m: Readonly<Model>) => m.ids.length < 5;
  async run(m: Model, r: Real) {
    const { deps } = testDeps(db(), { mocks: r.mocks, clock: r.clock });
    const response = await runGuardedRequest(
      { agent: r.scene.agent, idempotencyKey: `model-${(r.seq += 1)}`, body: r.scene.body({ amountMicros: fromDecimalString("480") }) },
      deps,
    );
    // A frozen agent's request is denied, not held (PXY-11), so nothing is queued.
    if (m.frozen) {
      expect(response.body.reasons).toEqual([{ code: "AGENT_FROZEN" }]);
    } else {
      expect(response.body.decision).toBe("hold");
      const id = response.body.approval_id!;
      m.ids.push(id);
      m.approvals.set(id, { status: "pending", expiresAt: m.now + TTL_MS });
    }
    await checkInvariants(m, r);
  }
  toString = () => "hold";
}

class Act implements Cmd {
  constructor(
    readonly index: number,
    readonly action: "approve" | "deny",
  ) {}
  check = (m: Readonly<Model>) => m.ids.length > 0;
  async run(m: Model, r: Real) {
    const id = pick(m, this.index);
    const expected = decide(m, id, this.action);
    const got = await respond(await handleApprovalAction(act(id, this.action), id, r.human));
    expect(got.status).toBe(expected.status);
    if (expected.result) expect(got.body.status).toBe(expected.result);
    else expect(got.body.error).toBe(expected.error);
    await checkInvariants(m, r);
  }
  toString = () => `${this.action}(${this.index})`;
}

/** Two approvals of the same request at once (in sequence on PGlite, which has one connection). */
class DuplicateApprove implements Cmd {
  constructor(readonly index: number) {}
  check = (m: Readonly<Model>) => m.ids.length > 0;
  async run(m: Model, r: Real) {
    const id = pick(m, this.index);
    const first = decide(m, id, "approve");
    const second = decide(m, id, "approve");
    const call = () => handleApprovalAction(act(id, "approve"), id, r.human).then(respond);
    const got = database.driver === "postgres" ? await Promise.all([call(), call()]) : [await call(), await call()];
    const sorted = got.map((g) => g.status).sort();
    expect(sorted).toEqual([first.status, second.status].sort());
    // Whichever lost the race gets 409, never a second execution.
    expect(got.filter((g) => g.status === 409).every((g) => g.body.error === (second.error ?? first.error))).toBe(true);
    await checkInvariants(m, r);
  }
  toString = () => `duplicateApprove(${this.index})`;
}

class Read implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    expireAll(m);
    const got = await respond(await handleListApprovals(new Request("https://agentvault.example/api/v1/approvals"), r.human));
    expect(got.status).toBe(200);
    const listed = new Map((got.body.approvals as { id: string; status: Status }[]).map((a) => [a.id, a.status]));
    expect(listed).toEqual(new Map([...m.approvals].map(([id, a]) => [id, a.status])));
    await checkInvariants(m, r);
  }
  toString = () => "read";
}

class Advance implements Cmd {
  constructor(readonly ms: number) {}
  check = () => true;
  async run(m: Model, r: Real) {
    r.clock.advance(this.ms);
    m.now += this.ms;
    // Expiry is applied on read, so nothing changes until the next read or action.
    await checkInvariants(m, r);
  }
  toString = () => `advance(${this.ms / 60_000} min)`;
}

/**
 * Move the clock to one millisecond before, exactly at, or one after an
 * approval's expiry, so the boundary is hit often. Random advances alone
 * rarely land on it.
 */
class AdvanceToExpiry implements Cmd {
  constructor(
    readonly index: number,
    readonly offsetMs: -1 | 0 | 1,
  ) {}
  check = (m: Readonly<Model>) => m.ids.length > 0;
  async run(m: Model, r: Real) {
    const target = m.approvals.get(pick(m, this.index))!.expiresAt + this.offsetMs;
    if (target > m.now) {
      r.clock.advance(target - m.now);
      m.now = target;
    }
    await checkInvariants(m, r);
  }
  toString = () => `advanceToExpiry(${this.index}, ${this.offsetMs})`;
}

class Freeze implements Cmd {
  check = (m: Readonly<Model>) => !m.frozen;
  async run(m: Model, r: Real) {
    // As a velocity freeze from a concurrent request would (PXY-10).
    await db().update(agents).set({ frozenAt: r.clock.now() }).where(eq(agents.id, r.scene.agent.id));
    m.frozen = true;
    await checkInvariants(m, r);
  }
  toString = () => "freeze";
}

class Unfreeze implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    const agentId = r.scene.agent.id;
    const got = await handleUnfreeze(new Request(`https://agentvault.example/api/v1/agents/${agentId}/unfreeze`, { method: "POST" }), agentId, r.human);
    expect(got.status).toBe(m.frozen ? 200 : 409);
    m.frozen = false;
    await checkInvariants(m, r);
  }
  toString = () => "unfreeze";
}

const index = fc.nat({ max: 9 });
/** Weighted toward actions and expiry boundaries, which is where the state machine can go wrong. */
const commands = [
  fc.oneof(
    { arbitrary: fc.constant(new Hold()), weight: 2 },
    { arbitrary: index.map((i) => new Act(i, "approve")), weight: 3 },
    { arbitrary: index.map((i) => new Act(i, "deny")), weight: 2 },
    { arbitrary: index.map((i) => new DuplicateApprove(i)), weight: 2 },
    { arbitrary: fc.constant(new Read()), weight: 2 },
    // Around the 15-minute expiry, so approvals expire on and off the boundary.
    { arbitrary: fc.constantFrom(60_000, 5 * 60_000, TTL_MS - 1, TTL_MS, TTL_MS + 1).map((ms) => new Advance(ms)), weight: 2 },
    { arbitrary: fc.tuple(index, fc.constantFrom<-1 | 0 | 1>(-1, 0, 1)).map(([i, offset]) => new AdvanceToExpiry(i, offset)), weight: 3 },
    { arbitrary: fc.constant(new Freeze()), weight: 1 },
    { arbitrary: fc.constant(new Unfreeze()), weight: 1 },
  ),
];

describe("Property 5: approvals execute at most once", () => {
  // Property 5, at most once (HITL-7, HITL-12): in a fast-check model-based
  // test over random sequences of approve, deny, expire (clock advance),
  // read, and duplicate commands, each approval executes at most once,
  // status transitions follow the state diagram, and each expired approval
  // has exactly one `approval_expired` event.
  it(
    "HITL-6, HITL-7, HITL-12: random approval command sequences match the model",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.commands(commands, { maxCommands: 16 }), async (cmds) => {
          const scene = await createScene(db(), { envelope: ENVELOPE, isSandbox: true, task: { budgetMicros: fromDecimalString("100000") } });
          const { mocks, clock } = testDeps(db(), { clock: new FakeClock() });
          const human: HumanRouteDeps = {
            openDb: () => ({ db: db(), close: async () => {} }),
            key: () => TEST_HEAD_KEY,
            now: clock.now,
            railFor: testDeps(db(), { mocks, clock }).deps.railFor,
            getUser: async () => null,
            rateLimit: { limit: 1_000_000, windowMs: 60_000 },
          };
          const model: Model = { now: clock.now().getTime(), frozen: false, ids: [], approvals: new Map(), executed: 0 };
          const real: Real = { scene, clock, mocks, human, seq: 0, seen: new Map() };
          // Start with two held requests, so every run has approvals to act on.
          for (let i = 0; i < 2; i += 1) await new Hold().run(model, real);
          await fc.asyncModelRun(() => ({ model, real }), cmds);
        }),
        { numRuns: database.driver === "postgres" ? 12 : 40 },
      );
    },
    600_000,
  );
});

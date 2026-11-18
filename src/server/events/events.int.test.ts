import { eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { appendEvent } from "@/server/audit/append";
import type { SessionUser } from "@/server/auth/session";
import type { Database } from "@/server/db/client";
import { users, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { runGuardedRequest } from "@/server/payments/guarded";
import { FakeClock, type Scene, createScene, eventsOf, testDeps } from "@/server/payments/test-fixtures";
import { retireSandboxWorkspace } from "@/server/sandbox/sandbox";
import { type EventsDeps, handleEvents, readWorkspaceEvents } from "./handler";
import type { StreamTiming } from "./stream";

let database: Database & { driver: "postgres" | "pglite" };

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const db = () => database.db;
const URL_BASE = "https://agentvault.example/api/v1/events";

/** Short streams for most tests: five 1 s polls of fake time. */
const SHORT: StreamTiming = { pollMs: 1_000, heartbeatMs: 10_000, durationMs: 5_000, batchSize: 200 };

/**
 * Handler dependencies with a fake clock. Each sleep advances the clock by
 * the requested time and yields for `realMs` of real time, so concurrent
 * writers get a chance to commit between polls.
 */
function deps(options: { user?: SessionUser | null; timing?: StreamTiming; realMs?: number; over?: Partial<EventsDeps> } = {}) {
  const clock = new FakeClock();
  const d: EventsDeps = {
    openDb: () => ({ db: db(), close: async () => {} }),
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
      await new Promise((resolve) => setTimeout(resolve, options.realMs ?? 0));
    },
    getUser: async () => options.user ?? null,
    // Every fake clock starts in the same minute, so tests would share one
    // rate-limit window. Only the rate-limit test sets a real limit.
    rateLimit: { limit: 1_000_000, windowMs: 60_000 },
    totalRateLimit: { limit: 1_000_000, windowMs: 60_000 },
    timing: options.timing ?? SHORT,
    ...options.over,
  };
  return { deps: d, clock };
}

interface Message {
  id?: string;
  event?: string;
  data?: string;
  retry?: string;
  comment?: string;
}

/** Parse SSE text into messages (only the fields this stream uses). */
function parseMessages(text: string): Message[] {
  return text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const m: Message = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) m.comment = line.slice(1).trim();
        const field = /^(id|event|data|retry): (.*)$/.exec(line);
        if (field) m[field[1] as "id" | "event" | "data" | "retry"] = field[2]!;
      }
      return m;
    });
}

/**
 * Read a response until the stream ends, or until `dropAfter` audit events
 * have arrived, then disconnect like a closed browser tab.
 */
async function read(response: Response, options: { dropAfter?: number; clock?: FakeClock } = {}) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: (Message & { at?: number })[] = [];
  let audit = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const end = buffer.lastIndexOf("\n\n");
    if (end < 0) continue;
    for (const m of parseMessages(buffer.slice(0, end + 2))) {
      messages.push({ ...m, ...(options.clock ? { at: options.clock.now().getTime() } : {}) });
      if (m.event === "audit") audit += 1;
      if (options.dropAfter !== undefined && audit >= options.dropAfter) {
        await reader.cancel();
        return { messages, ended: false };
      }
    }
    buffer = buffer.slice(end + 2);
  }
  return { messages, ended: true };
}

const auditSeqs = (messages: Message[]) => messages.filter((m) => m.event === "audit").map((m) => Number(m.id));
const workspaceInfo = (messages: Message[]) => JSON.parse(messages.find((m) => m.event === "workspace")!.data!) as Record<string, unknown>;

const get = (path = "", headers: Record<string, string> = {}) => new Request(`${URL_BASE}${path}`, { headers });

let appended = 0;
async function append(workspaceId: string, count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    appended += 1;
    await db().transaction((tx) => appendEvent(tx, { workspaceId, type: "envelope_updated", payload: { n: appended } }, { key: TEST_HEAD_KEY }));
  }
}

async function owned(scene: Scene, userId: string): Promise<SessionUser> {
  await db().insert(users).values({ id: userId, name: userId }).onConflictDoNothing();
  await db().update(workspaces).set({ ownerUserId: userId }).where(eq(workspaces.id, scene.workspaceId));
  return { id: userId };
}

describe("GET /api/v1/events", () => {
  it("TEL-1: streams the workspace's events in seq order with seq as the id, as stored, amounts as micros strings", async () => {
    const scene = await createScene(db());
    const user = await owned(scene, "tel1-user");
    const { deps: payDeps } = testDeps(db());
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: "tel1-a", body: scene.body() }, payDeps);
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: "tel1-b", body: scene.body() }, payDeps);
    const rows = await eventsOf(db(), scene.workspaceId);
    expect(rows.length).toBeGreaterThanOrEqual(4);

    const response = await handleEvents(get(`?workspace_id=${scene.workspaceId}`), deps({ user }).deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const { messages, ended } = await read(response);
    expect(ended).toBe(true);

    expect(messages[0]).toEqual({ retry: "1000" });
    expect(messages[1]).toMatchObject({ event: "workspace" });
    expect(messages[1]!.id).toBeUndefined();
    expect(workspaceInfo(messages)).toEqual({ workspace_id: scene.workspaceId, sandbox: false, retired: false });

    expect(auditSeqs(messages)).toEqual(rows.map((r) => r.seq));
    const sent = messages.filter((m) => m.event === "audit").map((m) => JSON.parse(m.data!) as Record<string, unknown>);
    expect(sent).toEqual(
      rows.map((r) => ({
        workspace_id: r.workspaceId,
        seq: r.seq,
        type: r.type,
        created_at: r.createdAt.toISOString(),
        payload: r.payload,
        prev_hash: r.prevHash,
        hash: r.hash,
      })),
    );
    expect(JSON.stringify(sent)).toContain('"amount_micros":"1500"');
  });

  it("TEL-2: resumes after Last-Event-ID with no gap and no duplicate, and rejects a malformed one", async () => {
    const scene = await createScene(db(), { isSandbox: true });
    await append(scene.workspaceId, 6);
    const all = (await eventsOf(db(), scene.workspaceId)).map((r) => r.seq);
    const at = all[2]!;
    const { messages } = await read(await handleEvents(get(`?workspace_id=${scene.workspaceId}`, { "last-event-id": String(at) }), deps().deps));
    expect(auditSeqs(messages)).toEqual(all.filter((s) => s > at));

    const last = all.at(-1)!;
    const caughtUp = await read(await handleEvents(get(`?workspace_id=${scene.workspaceId}`, { "last-event-id": String(last) }), deps().deps));
    expect(auditSeqs(caughtUp.messages)).toEqual([]);

    for (const bad of ["-1", "abc", "1.0", "99999999999"]) {
      const r = await handleEvents(get(`?workspace_id=${scene.workspaceId}`, { "last-event-id": bad }), deps().deps);
      expect(r.status, bad).toBe(400);
      expect(await r.json()).toEqual({ error: "INVALID_LAST_EVENT_ID" });
    }
  });

  it("TEL-2: an event committed while another append holds the head is never skipped", async () => {
    // Needs two real connections: PGlite has one, so the held transaction would block the poll.
    if (database.driver === "pglite") return;
    const scene = await createScene(db(), { isSandbox: true });
    await append(scene.workspaceId, 2);
    const poll = readWorkspaceEvents(db(), scene.workspaceId);
    const before = (await poll(0, 200)).map((e) => e.seq);

    let appendedInTx!: () => void;
    let release!: () => void;
    const inTx = new Promise<void>((r) => (appendedInTx = r));
    const released = new Promise<void>((r) => (release = r));
    const slow = db().transaction(async (tx) => {
      await appendEvent(tx, { workspaceId: scene.workspaceId, type: "envelope_updated", payload: { slow: true } }, { key: TEST_HEAD_KEY });
      appendedInTx();
      await released;
    });
    await inTx;
    // This append waits on the head lock that the slow transaction holds.
    const blocked = db().transaction((tx) => appendEvent(tx, { workspaceId: scene.workspaceId, type: "envelope_updated", payload: { blocked: true } }, { key: TEST_HEAD_KEY }));
    await new Promise((r) => setTimeout(r, 200));

    const during = (await poll(before.at(-1)!, 200)).map((e) => e.seq);
    expect(during).toEqual([]);
    release();
    await Promise.all([slow, blocked]);
    const after = (await poll(before.at(-1)!, 200)).map((e) => e.seq);
    expect(after).toEqual([before.at(-1)! + 1, before.at(-1)! + 2]);
  });

  it("TEL-3, TEL-4: an idle stream sends a heartbeat at least every 15 s and closes on its own before the 60 s limit", async () => {
    const scene = await createScene(db(), { isSandbox: true });
    // The default heartbeat and duration, with 2 s polls to keep the test short.
    // The client timestamps a message when it reads it, up to one poll late.
    const timing: StreamTiming = { pollMs: 2_000, heartbeatMs: 10_000, durationMs: 55_000, batchSize: 200 };
    const { deps: d, clock } = deps({ timing });
    const start = clock.now().getTime();
    const { messages, ended } = await read(await handleEvents(get(`?workspace_id=${scene.workspaceId}`), d), { clock });
    expect(ended).toBe(true);
    const writes = [start, ...messages.map((m) => m.at!), clock.now().getTime()];
    const gaps = writes.slice(1).map((t, i) => t - writes[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15_000);
    expect(messages.filter((m) => m.comment === "ping").length).toBeGreaterThanOrEqual(4);
    const duration = clock.now().getTime() - start;
    expect(duration).toBeGreaterThanOrEqual(50_000);
    expect(duration).toBeLessThan(60_000);
  });

  it("TEL-4: a database error mid-stream ends the stream instead of hanging", async () => {
    const scene = await createScene(db(), { isSandbox: true });
    await append(scene.workspaceId, 1);
    let calls = 0;
    const failing = {
      db: new Proxy(db(), {
        get(target, prop, receiver) {
          if (prop === "select" && (calls += 1) > 3) throw new Error("connection lost");
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }),
      close: async () => {},
    };
    const { messages, ended } = await read(await handleEvents(get(`?workspace_id=${scene.workspaceId}`), deps({ over: { openDb: () => failing } }).deps));
    expect(ended).toBe(true);
    expect(auditSeqs(messages).length).toBeGreaterThan(0);
  });

  describe("TEL-5: workspace scoping", () => {
    it("TEL-5: streams only the named workspace's events", async () => {
      const a = await createScene(db(), { isSandbox: true });
      const b = await createScene(db(), { isSandbox: true });
      await append(a.workspaceId, 3);
      await append(b.workspaceId, 4);
      const { messages } = await read(await handleEvents(get(`?workspace_id=${a.workspaceId}`), deps().deps));
      const sent = messages.filter((m) => m.event === "audit").map((m) => JSON.parse(m.data!) as { workspace_id: string });
      expect(sent.length).toBe((await eventsOf(db(), a.workspaceId)).length);
      expect(new Set(sent.map((e) => e.workspace_id))).toEqual(new Set([a.workspaceId]));
    });

    it("TEL-5: a private workspace needs its owner: 401 signed out, 403 for another user, 200 for the owner", async () => {
      const scene = await createScene(db());
      const owner = await owned(scene, "tel5-owner");
      await db().insert(users).values({ id: "tel5-other", name: "other" }).onConflictDoNothing();
      const path = `?workspace_id=${scene.workspaceId}`;
      const anon = await handleEvents(get(path), deps().deps);
      expect([anon.status, await anon.json()]).toEqual([401, { error: "UNAUTHORIZED" }]);
      const other = await handleEvents(get(path), deps({ user: { id: "tel5-other" } }).deps);
      expect([other.status, await other.json()]).toEqual([403, { error: "FORBIDDEN" }]);
      const mine = await handleEvents(get(path), deps({ user: owner }).deps);
      expect(mine.status).toBe(200);
      await read(mine);
    });

    it("TEL-5: without workspace_id, a signed-in user gets their workspace and anyone else the current sandbox", async () => {
      const own = await createScene(db());
      const user = await owned(own, "tel5-default");
      const signedIn = await read(await handleEvents(get(), deps({ user }).deps));
      expect(workspaceInfo(signedIn.messages)).toMatchObject({ workspace_id: own.workspaceId, sandbox: false });

      const sandbox = await createScene(db(), { isSandbox: true });
      const anon = await read(await handleEvents(get(), deps().deps));
      expect(workspaceInfo(anon.messages)).toEqual({ workspace_id: sandbox.workspaceId, sandbox: true, retired: false });

      await db().insert(users).values({ id: "tel5-nobody", name: "nobody" }).onConflictDoNothing();
      const none = await handleEvents(get(), deps({ user: { id: "tel5-nobody" } }).deps);
      expect([none.status, await none.json()]).toEqual([404, { error: "NO_WORKSPACE" }]);
    });

    it("TEL-5: a retired sandbox stays readable and says it is retired, so the client can reload", async () => {
      const old = await createScene(db(), { isSandbox: true });
      const next = await createScene(db(), { isSandbox: true });
      await db().transaction((tx) => retireSandboxWorkspace(tx, old.workspaceId, { successorWorkspaceId: next.workspaceId }, { key: TEST_HEAD_KEY }));
      const { messages } = await read(await handleEvents(get(`?workspace_id=${old.workspaceId}`), deps().deps));
      expect(workspaceInfo(messages)).toEqual({ workspace_id: old.workspaceId, sandbox: true, retired: true });
      const types = messages.filter((m) => m.event === "audit").map((m) => (JSON.parse(m.data!) as { type: string }).type);
      expect(types.at(-1)).toBe("sandbox_retired");
    });

    it("TEL-5: any Authorization header is 403 before the database is opened, even for the sandbox", async () => {
      const scene = await createScene(db(), { isSandbox: true });
      const untouchable = deps({ over: { openDb: () => { throw new Error("must not open the database"); } } }).deps;
      for (const value of [`Bearer ${scene.apiKey}`, "Bearer nope", "Basic eDp5"]) {
        const r = await handleEvents(get(`?workspace_id=${scene.workspaceId}`, { authorization: value }), untouchable);
        expect([r.status, await r.json()]).toEqual([403, { error: "AGENT_KEY_FORBIDDEN" }]);
      }
    });

    it("TEL-5: rejects unknown query fields and malformed or unknown workspace IDs", async () => {
      expect((await handleEvents(get("?workspace_id=nope"), deps().deps)).status).toBe(400);
      expect((await handleEvents(get("?since=0"), deps().deps)).status).toBe(400);
      const unknown = await handleEvents(get("?workspace_id=00000000-0000-4000-8000-000000000000"), deps().deps);
      expect([unknown.status, await unknown.json()]).toEqual([404, { error: "NO_WORKSPACE" }]);
    });

    it("UI-4: sandbox streams are rate-limited per IP; a private workspace's owner is not", async () => {
      const sandbox = await createScene(db(), { isSandbox: true });
      const limited = deps({ over: { rateLimit: { limit: 2, windowMs: 60_000 } } }).deps;
      const open = (ip: string) => handleEvents(get(`?workspace_id=${sandbox.workspaceId}`, { "x-real-ip": ip }), limited);
      for (let i = 0; i < 2; i += 1) {
        const r = await open("203.0.113.9");
        expect(r.status).toBe(200);
        await r.body!.cancel();
      }
      const third = await open("203.0.113.9");
      expect([third.status, await third.json()]).toEqual([429, { error: "RATE_LIMITED" }]);
      const otherIp = await open("203.0.113.10");
      expect(otherIp.status).toBe(200);
      await otherIp.body!.cancel();

      const own = await createScene(db());
      const user = await owned(own, "ui4-owner");
      const ownDeps = deps({ user, over: { rateLimit: { limit: 0, windowMs: 60_000 } } }).deps;
      const r = await handleEvents(get(`?workspace_id=${own.workspaceId}`, { "x-real-ip": "203.0.113.9" }), ownDeps);
      expect(r.status).toBe(200);
      await r.body!.cancel();
    });
    it("UI-4: sandbox streams are also limited across all visitors, and a private workspace's owner is not", async () => {
      const sandbox = await createScene(db(), { isSandbox: true });
      // A window length no other test uses, so this count starts at zero.
      const limited = deps({ over: { totalRateLimit: { limit: 2, windowMs: 61_000 } } }).deps;
      const open = (ip: string) => handleEvents(get(`?workspace_id=${sandbox.workspaceId}`, { "x-real-ip": ip }), limited);
      for (const ip of ["203.0.113.21", "203.0.113.22"]) {
        const r = await open(ip);
        expect(r.status).toBe(200);
        await r.body!.cancel();
      }
      const third = await open("203.0.113.23");
      expect([third.status, await third.json()]).toEqual([429, { error: "RATE_LIMITED" }]);

      const own = await createScene(db());
      const user = await owned(own, "ui4-total-owner");
      const ownDeps = deps({ user, over: { totalRateLimit: { limit: 0, windowMs: 61_000 } } }).deps;
      const r = await handleEvents(get(`?workspace_id=${own.workspaceId}`, { "x-real-ip": "203.0.113.21" }), ownDeps);
      expect(r.status).toBe(200);
      await r.body!.cancel();
    });
  });

  // Property 1, cursor completeness (TEL-2): "for any sequence of inserts
  // and any reconnect points, the client receives each `seq` exactly once,
  // in order." The fake-source version in stream.prop.test.ts runs 1,000
  // cases. This one runs the real handler and real appends, with writers
  // committing concurrently while the client polls (on Neon or Docker
  // Postgres; PGlite runs them one at a time). Each case makes dozens of
  // round trips to the database, so it runs 8 cases.
  it("TEL-1, TEL-2: property 1 through the handler, with concurrent appends and random reconnects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          perWriter: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 3 }),
          batchSize: fc.integer({ min: 1, max: 3 }),
          drops: fc.array(fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }), { minLength: 1, maxLength: 4 }),
        }),
        async ({ perWriter, batchSize, drops }) => {
          const scene = await createScene(db(), { isSandbox: true });
          const writers = Promise.all(
            perWriter.map(async (count) => {
              for (let i = 0; i < count; i += 1) {
                await new Promise((r) => setTimeout(r, i * 3));
                await append(scene.workspaceId);
              }
            }),
          );
          let writing = true;
          void writers.finally(() => (writing = false));

          const timing: StreamTiming = { pollMs: 1_000, heartbeatMs: 10_000, durationMs: 4_000, batchSize };
          const received: number[] = [];
          let lastId: number | undefined;
          for (let c = 0; c < 50; c += 1) {
            const headers: Record<string, string> = lastId === undefined ? {} : { "last-event-id": String(lastId) };
            const dropAfter = drops[c % drops.length];
            const response = await handleEvents(get(`?workspace_id=${scene.workspaceId}`, headers), deps({ timing, realMs: 5 }).deps);
            const { messages } = await read(response, dropAfter === undefined ? {} : { dropAfter });
            const seqs = auditSeqs(messages);
            received.push(...seqs);
            if (seqs.length > 0) lastId = seqs.at(-1);
            const writersDone = !writing; // read before the count, so the count includes every write
            const total = (await eventsOf(db(), scene.workspaceId)).length;
            if (writersDone && received.length >= total) break;
          }
          await writers;
          const all = (await eventsOf(db(), scene.workspaceId)).map((r) => r.seq);
          expect(received).toEqual(all);
        },
      ),
      { numRuns: 8 },
    );
  }, 120_000);
});

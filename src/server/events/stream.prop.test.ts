import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING, EVENTS_MAX_DURATION_S, RETRY_MS, type StreamEvent, type StreamTiming, pumpEvents } from "./stream";

/**
 * A fake event source with fake time, standing in for Postgres:
 * - Events commit at scheduled times, in seq order. That's what the audit
 *   head lock guarantees (see stream.ts).
 * - Each read takes some latency and sees the events committed by a
 *   snapshot point somewhere inside that latency. Events committed after
 *   the snapshot but before the read returns are "committed during a poll".
 * - Each connection's client drops after receiving some number of events.
 *   Anything the server writes after that is lost, as on a real network.
 *   The client reconnects with the last ID it received, like EventSource.
 */

interface Connection {
  /** Drop after this many events; null runs to the deadline. Biased toward multiples of the batch size. */
  dropAfter: number | null;
}

interface Scenario {
  /** Events already committed when the first connection opens. */
  backlog: number;
  gaps: number[];
  batchSize: number;
  connections: Connection[];
  latencies: number[];
  snapshotAt: number[];
}

const MAX_LATENCY = 2_000;

const scenarioArb = fc.integer({ min: 1, max: 5 }).chain((batchSize) =>
  fc.record({
    backlog: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 30 })),
    // Gaps of 0 commit several events at once, so full batches happen.
    gaps: fc.array(
      fc.oneof(
        { arbitrary: fc.constant(0), weight: 3 },
        { arbitrary: fc.integer({ min: 0, max: 1_500 }), weight: 2 },
        { arbitrary: fc.integer({ min: 0, max: 20_000 }), weight: 1 },
      ),
      { minLength: 0, maxLength: 40 },
    ),
    batchSize: fc.constant(batchSize),
    connections: fc.array(
      fc.record({
        dropAfter: fc.oneof(
          { arbitrary: fc.constant(null), weight: 1 },
          { arbitrary: fc.integer({ min: 1, max: 3 }).map((m) => m * batchSize), weight: 3 },
          { arbitrary: fc.integer({ min: 1, max: 12 }), weight: 2 },
        ),
      }),
      { minLength: 1, maxLength: 6 },
    ),
    latencies: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: MAX_LATENCY })), { minLength: 1, maxLength: 8 }),
    snapshotAt: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 8 }),
  }),
);

interface Stats {
  /** A client dropped right after the last event of a full batch, with more events waiting. */
  boundaryDrops: number;
  /** An event committed during a poll, after that poll's snapshot. */
  committedDuringPoll: number;
}

interface Outcome {
  received: number[];
  total: number;
  /** Longest time between writes on any connection, including from its start and to its end. */
  maxGap: number;
  /** Per connection: duration and whether the client dropped it. */
  connections: { duration: number; dropped: boolean }[];
  stats: Stats;
}

async function simulate(s: Scenario, timing: Omit<StreamTiming, "batchSize">): Promise<Outcome> {
  let t = 1_000_000;
  const commitTimes: number[] = Array.from({ length: s.backlog }, () => t - 1);
  for (const gap of s.gaps) commitTimes.push((commitTimes.at(-1) ?? t) + gap);
  const total = commitTimes.length;
  const lastCommit = commitTimes.at(-1) ?? t;
  const event = (seq: number): StreamEvent => ({ workspace_id: "w", seq, type: "decision", created_at: "", payload: {}, prev_hash: "", hash: "" });

  const stats: Stats = { boundaryDrops: 0, committedDuringPoll: 0 };
  let fullBatchEnds = new Set<number>();
  let reads = 0;
  const read = async (after: number, limit: number) => {
    const latency = s.latencies[reads % s.latencies.length]!;
    const snapshot = t + Math.floor(latency * s.snapshotAt[reads % s.snapshotAt.length]!);
    reads += 1;
    const visible = commitTimes.filter((at) => at <= snapshot).length; // commits are in seq order
    stats.committedDuringPoll += commitTimes.filter((at) => at > snapshot && at <= t + latency).length;
    t += latency;
    await Promise.resolve();
    const batch: StreamEvent[] = [];
    for (let seq = after + 1; seq <= visible && batch.length < limit; seq += 1) batch.push(event(seq));
    if (batch.length === limit && visible > batch.at(-1)!.seq) fullBatchEnds.add(batch.at(-1)!.seq);
    return batch;
  };
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await Promise.resolve();
    },
  };

  const received: number[] = [];
  const connections: Outcome["connections"] = [];
  let lastId: number | null = null;
  let maxGap = 0;
  for (let c = 0; c < 400; c += 1) {
    const plan = s.connections[c % s.connections.length]!;
    const client = new AbortController();
    const start = t;
    let lastWrite = start;
    let got = 0;
    fullBatchEnds = new Set();
    const write = (chunk: string) => {
      if (client.signal.aborted) return; // lost: the client is gone
      maxGap = Math.max(maxGap, t - lastWrite);
      lastWrite = t;
      // Like EventSource: an event is delivered whether or not it has an id,
      // and only an id line moves the last event ID.
      const data = /^event: audit\ndata: (.*)$/m.exec(chunk);
      if (!data) return;
      const seq = (JSON.parse(data[1]!) as StreamEvent).seq;
      received.push(seq);
      const id = /^id: (\d+)$/m.exec(chunk);
      if (id) lastId = Number(id[1]);
      got += 1;
      if (plan.dropAfter !== null && got >= plan.dropAfter) {
        if (fullBatchEnds.has(seq)) stats.boundaryDrops += 1;
        client.abort();
      }
    };
    await pumpEvents({ read, after: lastId ?? 0, write, clock, signal: client.signal, timing: { ...timing, batchSize: s.batchSize } });
    if (!client.signal.aborted) maxGap = Math.max(maxGap, t - lastWrite);
    connections.push({ duration: t - start, dropped: client.signal.aborted });
    t += RETRY_MS;
    if (received.length >= total && t > lastCommit) break;
  }
  return { received, total, maxGap, connections, stats };
}

const TIMING = DEFAULT_TIMING;
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("event stream properties", () => {
  // Property 1, cursor completeness (TEL-2): "for any sequence of inserts
  // and any reconnect points, the client receives each `seq` exactly once,
  // in order."
  it("TEL-1, TEL-2: property 1, every seq arrives exactly once and in order across reconnects", async () => {
    const totals: Stats & { runs: number; runsWithBoundaryDrop: number; runsWithCommitDuringPoll: number } = {
      runs: 0,
      boundaryDrops: 0,
      committedDuringPoll: 0,
      runsWithBoundaryDrop: 0,
      runsWithCommitDuringPoll: 0,
    };
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const out = await simulate(s, TIMING);
        expect(out.received).toEqual(range(out.total));
        totals.runs += 1;
        totals.boundaryDrops += out.stats.boundaryDrops;
        totals.committedDuringPoll += out.stats.committedDuringPoll;
        if (out.stats.boundaryDrops > 0) totals.runsWithBoundaryDrop += 1;
        if (out.stats.committedDuringPoll > 0) totals.runsWithCommitDuringPoll += 1;
      }),
      { numRuns: 1000 },
    );
    // The generators must reach both edges often, or the property could
    // pass without testing them. Measured: about 32% and 47% of runs.
    expect(totals.runsWithBoundaryDrop / totals.runs).toBeGreaterThan(0.2);
    expect(totals.runsWithCommitDuringPoll / totals.runs).toBeGreaterThan(0.3);
  });

  it("TEL-3: no connection goes 15 s without a write, with polls taking up to 2 s", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const out = await simulate(s, TIMING);
        expect(out.maxGap).toBeLessThanOrEqual(15_000);
      }),
      { numRuns: 1000 },
    );
  });

  it("TEL-4: every connection ends before the function's limit, and only a dropped client ends one early", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const out = await simulate(s, TIMING);
        for (const c of out.connections) {
          expect(c.duration).toBeLessThan(EVENTS_MAX_DURATION_S * 1_000);
          if (!c.dropped) expect(c.duration).toBeGreaterThanOrEqual(TIMING.durationMs - TIMING.pollMs);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

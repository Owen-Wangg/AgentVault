import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING, EVENTS_MAX_DURATION_S, HEARTBEAT, formatEvent, formatInfo, parseLastEventId, pumpEvents } from "./stream";
import { maxDuration } from "../../../app/api/v1/events/route";

describe("event stream helpers", () => {
  it("TEL-2: parses Last-Event-ID as a seq, and an absent header as the start", () => {
    expect(parseLastEventId(null)).toBe(0);
    expect(parseLastEventId("")).toBe(0);
    expect(parseLastEventId("0")).toBe(0);
    expect(parseLastEventId("42")).toBe(42);
    expect(parseLastEventId("2147483647")).toBe(2_147_483_647);
  });

  it("TEL-2: rejects a Last-Event-ID this stream could not have sent", () => {
    for (const bad of ["-1", "01", "1.5", "1e3", " 1", "1 ", "0x10", "abc", "2147483648", "99999999999"]) {
      expect(parseLastEventId(bad), bad).toBeNull();
    }
  });

  it("TEL-1: an event uses its seq as the SSE id, and its data stays on one line", () => {
    const message = formatEvent({
      workspace_id: "w",
      seq: 7,
      type: "fetch_failed",
      created_at: "2026-11-24T00:00:00.000Z",
      payload: { url: "https://x.example/\r\nid: 999\n\ndata: forged", amount_micros: "1500" },
      prev_hash: "a",
      hash: "b",
    });
    const lines = message.split("\n");
    expect(lines.slice(0, 2)).toEqual(["id: 7", "event: audit"]);
    expect(lines[2]).toMatch(/^data: /);
    expect(lines.slice(3)).toEqual(["", ""]);
    expect(JSON.parse(lines[2]!.slice("data: ".length))).toMatchObject({ seq: 7, payload: { amount_micros: "1500" } });
  });

  it("UI-15: sends one id-less ready message once the backlog is sent, after every full batch", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ workspace_id: "w", seq: i + 1, type: "decision", created_at: "", payload: {}, prev_hash: "", hash: "" }));
    let t = 0;
    const chunks: string[] = [];
    await pumpEvents({
      read: async (after, limit) => all.filter((e) => e.seq > after).slice(0, limit),
      after: 0,
      write: (c) => chunks.push(c),
      clock: { now: () => t, sleep: async (ms) => void (t += ms) },
      signal: new AbortController().signal,
      timing: { ...DEFAULT_TIMING, batchSize: 2, durationMs: 5_000 },
    });
    const kinds = chunks.map((c) => /^event: (\w+)/m.exec(c)?.[1] ?? c.trim());
    expect(kinds).toEqual(["audit", "audit", "audit", "audit", "audit", "ready"]);
    expect(chunks.at(-1)).toBe('event: ready\ndata: {"seq":5}\n\n');
  });

  it("TEL-2: the workspace message has no id, so it never moves the browser's last event ID", () => {
    expect(formatInfo("workspace", { workspace_id: "w" })).toBe('event: workspace\ndata: {"workspace_id":"w"}\n\n');
    expect(HEARTBEAT.startsWith(":")).toBe(true);
  });

  it("TEL-3, TEL-4: heartbeats come well inside 15 s, and the stream closes 5 s before the route's maxDuration", () => {
    expect(maxDuration).toBe(EVENTS_MAX_DURATION_S);
    expect(DEFAULT_TIMING.durationMs).toBe((maxDuration - 5) * 1_000);
    expect(DEFAULT_TIMING.heartbeatMs + DEFAULT_TIMING.pollMs).toBeLessThan(15_000);
    expect(DEFAULT_TIMING.batchSize).toBe(200);
  });
});

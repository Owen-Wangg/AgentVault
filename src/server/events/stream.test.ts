import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING, EVENTS_MAX_DURATION_S, HEARTBEAT, formatEvent, formatInfo, parseLastEventId } from "./stream";
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

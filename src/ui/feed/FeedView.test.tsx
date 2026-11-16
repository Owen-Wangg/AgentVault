// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventStreamOptions } from "@/ui/events/use-event-stream";
import { FeedView } from "./FeedView";

afterEach(cleanup);

class FakeSource extends EventTarget {
  static last: FakeSource;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    FakeSource.last = this;
  }
  close() {}
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const stream: EventStreamOptions = { createEventSource: (url) => new FakeSource(url) as unknown as EventSource, onRetired: () => {} };

let seq = 0;
function decision(agent: string, vendor: string, amount: string, decision: string, codes: string[]) {
  seq += 1;
  return {
    workspace_id: "w1",
    seq,
    type: "decision",
    created_at: "2026-11-24T12:00:00.000Z",
    payload: { agent_id: agent, request: { vendor, tool: "x402.pay", amount_micros: amount }, decision, reasons: codes.map((code) => ({ code })) },
    prev_hash: "",
    hash: "",
  };
}

const flush = () => act(async () => await Promise.resolve());
const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("<FeedView>", () => {
  it("UI-15: shows loading until the backlog arrives, then the empty message", async () => {
    render(<FeedView workspaceId="w1" agentNames={{}} stream={stream} />);
    expect(screen.getByRole("status", { busy: true })).toBeTruthy();
    act(() => FakeSource.last.emit("ready", { seq: 0 }));
    await flush();
    expect(screen.getByText(/No decisions yet/)).toBeTruthy();
  });

  it("UI-6: new decisions appear without a reload, newest first, with exact amounts and plain-language reasons", async () => {
    render(<FeedView workspaceId="w1" agentNames={{ a1: "billing-bot" }} stream={stream} />);
    act(() => {
      FakeSource.last.emit("audit", decision("a1", "nimbus-weather", "1500", "allow", []));
      FakeSource.last.emit("ready", {});
    });
    await flush();
    expect(bodyRows()).toHaveLength(1);
    act(() => FakeSource.last.emit("audit", decision("a2", "stripe", "480000000", "hold", ["HELD_TAINTED", "NEEDS_APPROVAL"])));
    await flush();
    const [first, second] = bodyRows();
    expect(first!.textContent).toContain("$480.00");
    expect(first!.textContent).toContain("Held: this session read untrusted content");
    expect(first!.textContent).toContain("agent a2");
    expect(second!.textContent).toContain("billing-bot");
    expect(second!.textContent).toContain("$0.0015");
    expect(second!.textContent).toContain("All checks passed.");
  });

  it("UI-6: filters by agent, decision, and reason", async () => {
    render(<FeedView workspaceId="w1" agentNames={{ a1: "billing-bot", a2: "research-bot" }} stream={stream} />);
    act(() => {
      FakeSource.last.emit("audit", decision("a1", "v", "1", "allow", []));
      FakeSource.last.emit("audit", decision("a2", "v", "2", "deny", ["VENDOR_NOT_ALLOWED"]));
      FakeSource.last.emit("audit", decision("a1", "v", "3", "hold", ["NEEDS_APPROVAL"]));
      // The server sends `ready` once the backlog is out.
      FakeSource.last.emit("ready", { seq: 3 });
    });
    await flush();
    expect(bodyRows()).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "a1" } });
    expect(bodyRows()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "hold" } });
    expect(bodyRows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "VENDOR_NOT_ALLOWED" } });
    expect(bodyRows().map((r) => r.textContent)).toEqual([expect.stringContaining("research-bot")]);
  });
});

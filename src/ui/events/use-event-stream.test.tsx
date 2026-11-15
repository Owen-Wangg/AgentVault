// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamStatusBadge } from "@/ui/components/StreamStatusBadge";
import type { AuditEventMessage } from "./summarize";
import { type EventStreamOptions, mergeEvents, useEventStream } from "./use-event-stream";

afterEach(cleanup);

/** A stand-in for the browser's EventSource that tests drive by hand. */
class FakeSource extends EventTarget {
  static last: FakeSource | undefined;
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeSource.last = this;
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    this.dispatchEvent(new MessageEvent(type, data === undefined ? {} : { data: JSON.stringify(data) }));
  }
}

const event = (seq: number): AuditEventMessage => ({ workspace_id: "w1", seq, type: "decision", created_at: "", payload: {}, prev_hash: "", hash: "" });

function Probe({ workspaceId, options }: { workspaceId: string; options: EventStreamOptions }) {
  const { events, status, ready } = useEventStream(workspaceId, options);
  return (
    <div>
      <p data-testid="seqs">{events.map((e) => e.seq).join(",")}</p>
      <p data-testid="ready">{String(ready)}</p>
      <StreamStatusBadge status={status} />
    </div>
  );
}

function mount(onRetired = vi.fn()) {
  const options: EventStreamOptions = { createEventSource: (url) => new FakeSource(url) as unknown as EventSource, onRetired };
  render(<Probe workspaceId="w1" options={options} />);
  return { source: FakeSource.last!, onRetired };
}

const flush = () => act(async () => await Promise.resolve());

describe("useEventStream", () => {
  it("TEL-2: connects with the workspace ID on the URL, so a reconnect resumes the same chain", () => {
    const { source } = mount();
    expect(source.url).toBe("/api/v1/events?workspace_id=w1");
  });

  it("UI-6: adds events as they arrive, in seq order and each once, and reports when the backlog is in", async () => {
    const { source } = mount();
    expect(screen.getByTestId("ready").textContent).toBe("false");
    act(() => {
      source.emit("open");
      source.emit("audit", event(1));
      source.emit("audit", event(2));
      source.emit("audit", event(2)); // a replay
      source.emit("ready", { seq: 2 });
    });
    await flush();
    expect(screen.getByTestId("seqs").textContent).toBe("1,2");
    expect(screen.getByTestId("ready").textContent).toBe("true");
    act(() => source.emit("audit", event(3)));
    await flush();
    expect(screen.getByTestId("seqs").textContent).toBe("1,2,3");
  });

  it("UI-6: shows Live when connected and Reconnecting… while EventSource retries", async () => {
    const { source } = mount();
    act(() => source.emit("open"));
    expect(screen.getByRole("status").textContent).toBe("Live");
    act(() => {
      source.readyState = 0;
      source.emit("error");
    });
    expect(screen.getByRole("status").textContent).toBe("Reconnecting…");
    act(() => source.emit("open"));
    expect(screen.getByRole("status").textContent).toBe("Live");
  });

  it("UI-3: reloads when the server says the workspace is a retired sandbox, and not otherwise", () => {
    const { source, onRetired } = mount();
    act(() => source.emit("workspace", { workspace_id: "w1", sandbox: true, retired: false }));
    expect(onRetired).not.toHaveBeenCalled();
    act(() => source.emit("workspace", { workspace_id: "w1", sandbox: true, retired: true }));
    expect(onRetired).toHaveBeenCalledOnce();
  });

  it("UI-6: closes the connection when the page unmounts", () => {
    const { source } = mount();
    cleanup();
    expect(source.closed).toBe(true);
  });

  it("TEL-2: merging keeps seq order and drops anything at or below the last seq", () => {
    expect(mergeEvents([event(1), event(2)], [event(4), event(2), event(3), event(3)]).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const current = [event(1)];
    expect(mergeEvents(current, [event(1)])).toBe(current);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamStatusBadge } from "@/ui/components/StreamStatusBadge";
import type { AuditEventMessage } from "./summarize";
import { BACKLOG_FLUSH_MS, type EventStreamOptions, mergeEvents, useEventStream } from "./use-event-stream";

afterEach(cleanup);

/** A stand-in for the browser's EventSource that tests drive by hand. */
class FakeSource extends EventTarget {
  static last: FakeSource | undefined;
  static opened = 0;
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeSource.last = this;
    FakeSource.opened += 1;
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
  const { events, status, ready, resume } = useEventStream(workspaceId, options);
  return (
    <div>
      <p data-testid="seqs">{events.map((e) => e.seq).join(",")}</p>
      <p data-testid="ready">{String(ready)}</p>
      <StreamStatusBadge status={status} onResume={resume} />
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

  it("UI-5: the backlog renders once, when ready arrives, not once per event", async () => {
    const onRender = vi.fn();
    function Counter({ options, rendered }: { options: EventStreamOptions; rendered: () => void }) {
      const { events } = useEventStream("w1", options);
      rendered();
      return <p data-testid="count">{events.length}</p>;
    }
    // A long fallback, so it can't fire however slow the test run is.
    const options: EventStreamOptions = { createEventSource: (url) => new FakeSource(url) as unknown as EventSource, onRetired: vi.fn(), backlogFlushMs: 60_000 };
    render(<Counter rendered={onRender} options={options} />);
    const source = FakeSource.last!;
    const before = onRender.mock.calls.length;
    // Each SSE message is its own task in a browser, so emit them in separate acts.
    for (let seq = 1; seq <= 50; seq += 1) await act(async () => source.emit("audit", event(seq)));
    expect(screen.getByTestId("count").textContent).toBe("0");
    await act(async () => source.emit("ready", { seq: 50 }));
    expect(screen.getByTestId("count").textContent).toBe("50");
    expect(onRender.mock.calls.length - before).toBeLessThanOrEqual(3);
  });

  it("UI-5: if ready never comes, the backlog still renders after BACKLOG_FLUSH_MS", async () => {
    vi.useFakeTimers();
    try {
      const { source } = mount();
      act(() => source.emit("audit", event(1)));
      expect(screen.getByTestId("seqs").textContent).toBe("");
      await act(async () => vi.advanceTimersByTime(BACKLOG_FLUSH_MS));
      expect(screen.getByTestId("seqs").textContent).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("UI-6: shows Connecting… before the first connection, Live when connected, and Reconnecting… while EventSource retries", async () => {
    const { source } = mount();
    expect(screen.getByRole("status").textContent).toBe("Connecting…");
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

/** A document whose visibility the test sets. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function mountWatched(extra: Partial<EventStreamOptions> = {}) {
  const doc = new FakeDocument();
  const options: EventStreamOptions = {
    createEventSource: (url) => new FakeSource(url) as unknown as EventSource,
    onRetired: vi.fn(),
    doc: doc as unknown as Document,
    ...extra,
  };
  render(<Probe workspaceId="w1" options={options} />);
  return { doc };
}

describe("useEventStream: pausing when nobody is watching", () => {
  it("TEL-6: hiding the page closes the stream; showing it opens one and adds only the missed events", async () => {
    const { doc } = mountWatched();
    const first = FakeSource.last!;
    act(() => {
      first.emit("open");
      first.emit("audit", event(1));
      first.emit("audit", event(2));
      first.emit("ready", { seq: 2 });
    });
    await flush();
    act(() => doc.set("hidden"));
    expect(first.closed).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Live updates paused");
    const opened = FakeSource.opened;
    act(() => doc.set("visible"));
    expect(FakeSource.opened).toBe(opened + 1);
    const second = FakeSource.last!;
    expect(second).not.toBe(first);
    expect(second.url).toBe("/api/v1/events?workspace_id=w1");
    // A new EventSource can't send Last-Event-ID, so the backlog arrives again.
    act(() => {
      second.emit("open");
      for (const seq of [1, 2, 3]) second.emit("audit", event(seq));
      second.emit("ready", { seq: 3 });
    });
    await flush();
    expect(screen.getByTestId("seqs").textContent).toBe("1,2,3");
    expect(screen.getByRole("status").textContent).toBe("Live");
  });

  it("TEL-6: a page that loads hidden opens no stream until it's shown", () => {
    const doc = new FakeDocument();
    doc.visibilityState = "hidden";
    const opened = FakeSource.opened;
    render(<Probe workspaceId="w1" options={{ createEventSource: (url) => new FakeSource(url) as unknown as EventSource, onRetired: vi.fn(), doc: doc as unknown as Document }} />);
    expect(FakeSource.opened).toBe(opened);
    expect(screen.getByRole("status").textContent).toBe("Live updates paused");
    act(() => doc.set("visible"));
    expect(FakeSource.opened).toBe(opened + 1);
  });

  it("TEL-7: pauses after idleMs without input, and Resume reopens the stream", () => {
    vi.useFakeTimers();
    try {
      mountWatched({ idleMs: 10_000 });
      const first = FakeSource.last!;
      act(() => first.emit("open"));
      act(() => vi.advanceTimersByTime(9_999));
      expect(first.closed).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(first.closed).toBe(true);
      expect(screen.getByRole("status").textContent).toBe("Live updates paused");
      const opened = FakeSource.opened;
      fireEvent.click(screen.getByRole("button", { name: "Resume live updates" }));
      expect(FakeSource.opened).toBe(opened + 1);
      expect(screen.queryByRole("button", { name: "Resume live updates" })).toBeNull();
      // Resuming restarts the idle timer, so the stream pauses again after another idleMs.
      act(() => vi.advanceTimersByTime(10_000));
      expect(FakeSource.last!.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TEL-7: input before the limit keeps the stream open, and any input after a pause resumes it", () => {
    vi.useFakeTimers();
    try {
      mountWatched({ idleMs: 10_000 });
      const first = FakeSource.last!;
      act(() => vi.advanceTimersByTime(9_000));
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
      });
      act(() => vi.advanceTimersByTime(9_000));
      expect(first.closed).toBe(false);
      act(() => vi.advanceTimersByTime(1_000));
      expect(first.closed).toBe(true);
      const opened = FakeSource.opened;
      act(() => {
        window.dispatchEvent(new Event("pointermove"));
      });
      expect(FakeSource.opened).toBe(opened + 1);
      expect(FakeSource.last!.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
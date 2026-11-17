// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PENDING_LIST_CAP, PendingCount, usePendingCount } from "./PendingCount";

afterEach(cleanup);

/** A document whose visibility the test sets. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const list = (n: number) => Response.json({ workspace_id: "w1", sandbox: true, approvals: Array.from({ length: n }, (_, i) => ({ id: String(i) })) });

function Probe({ pathname, fetcher, doc }: { pathname: string; fetcher: typeof fetch; doc: Document }) {
  const count = usePendingCount(pathname, { fetcher, doc });
  return (
    <a href="/approvals" data-testid="link">
      Approvals
      <PendingCount count={count} />
    </a>
  );
}

function mount(fetcher: typeof fetch) {
  const doc = new FakeDocument();
  const view = render(<Probe pathname="/" fetcher={fetcher} doc={doc as unknown as Document} />);
  const rerender = (pathname: string) => view.rerender(<Probe pathname={pathname} fetcher={fetcher} doc={doc as unknown as Document} />);
  return { doc, rerender };
}

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

describe("PendingCount", () => {
  it("UI-22: shows the number of pending approvals, with screen-reader text, read from the pending list", async () => {
    const fetcher = vi.fn(async () => list(3));
    mount(fetcher as unknown as typeof fetch);
    await settle();
    expect(fetcher).toHaveBeenCalledWith("/api/v1/approvals?status=pending", expect.objectContaining({ credentials: "same-origin" }));
    expect(screen.getByTestId("link").textContent).toBe("Approvals3 waiting for approval");
  });

  it("UI-22: shows 99+ when the capped list is full", async () => {
    mount((async () => list(PENDING_LIST_CAP)) as unknown as typeof fetch);
    await settle();
    expect(screen.getByTestId("link").textContent).toBe("Approvals99+ waiting for approval");
  });

  it.each([
    ["none pending", async () => list(0)],
    ["a 503", async () => Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 })],
    ["an unexpected body", async () => Response.json({ approvals: "nope" })],
    ["a network error", async () => Promise.reject(new TypeError("failed to fetch"))],
  ])("UI-22: shows no count for %s", async (_name, fetcher) => {
    mount(fetcher as unknown as typeof fetch);
    await settle();
    expect(screen.getByTestId("link").textContent).toBe("Approvals");
  });

  it("UI-22: reads again on each navigation and on return to the tab, and never on a timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let pending = 1;
      const fetcher = vi.fn(async () => list(pending));
      const { doc, rerender } = mount(fetcher as unknown as typeof fetch);
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      pending = 2;
      rerender("/feed");
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("link").textContent).toBe("Approvals2 waiting for approval");
      act(() => doc.set("hidden"));
      expect(fetcher).toHaveBeenCalledTimes(2);
      pending = 0;
      act(() => doc.set("visible"));
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId("link").textContent).toBe("Approvals");
    } finally {
      vi.useRealTimers();
    }
  });
});

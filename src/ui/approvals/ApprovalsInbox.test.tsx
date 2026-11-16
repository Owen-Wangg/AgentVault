// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventStreamOptions } from "@/ui/events/use-event-stream";
import { type ApprovalsApi, ApprovalsInbox } from "./ApprovalsInbox";
import { parseApprovals, timeLeft } from "./approval-view";

afterEach(cleanup);

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const SOURCE = "https://agentvault.example/vendor/docs/integration";

const refund = (over: Record<string, unknown> = {}) => ({
  id: "ap-1",
  status: "pending",
  request: {
    agent_id: "a1",
    vendor: "nimbus-weather",
    tool: "stripe.refund",
    amount_micros: "480000000",
    counted_micros: "480000000",
    session_id: "s1",
    idempotency_key: "k",
    args: { vendor: "nimbus-weather", amount_micros: "480000000", payment_ref: "pi_seed_500" },
  },
  reasons: [{ code: "HELD_TAINTED", detail: { tool: "stripe.refund", sourceUrl: SOURCE, taintedAt: "2026-11-24T11:59:00.000Z" } }, { code: "NEEDS_APPROVAL" }],
  recheck_reasons: null,
  rerun_decision_seq: null,
  expires_at: new Date(NOW + 14 * 60_000 + 5_000).toISOString(),
  decided_by: null,
  decided_at: null,
  created_at: new Date(NOW - 55_000).toISOString(),
  ...over,
});

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

function api(lists: unknown[][], actResult = { status: 200, body: { status: "executed" } }) {
  let call = 0;
  const list = vi.fn(async () => ({ status: 200, body: { approvals: lists[Math.min(call++, lists.length - 1)] } }));
  const actFn = vi.fn(async () => actResult);
  return { list, act: actFn } satisfies ApprovalsApi;
}

function mount(a: ApprovalsApi, props: { canAct?: boolean; isSandbox?: boolean; now?: () => number } = {}) {
  render(<ApprovalsInbox workspaceId="w1" isSandbox={props.isSandbox ?? true} canAct={props.canAct ?? true} agentNames={{ a1: "billing-bot" }} api={a} now={props.now ?? (() => NOW)} stream={stream} />);
}

describe("approval view", () => {
  it("UI-9: reads the request, reasons, args, and the taint source from the list", () => {
    const [a] = parseApprovals({ approvals: [refund(), { id: "broken" }] });
    expect(parseApprovals({ approvals: [refund(), { id: "broken" }] })).toHaveLength(1);
    expect(a).toMatchObject({ id: "ap-1", tool: "stripe.refund", amountMicros: 480_000_000n, taintSource: SOURCE, args: { payment_ref: "pi_seed_500" } });
    expect(a!.reasons.map((r) => r.code)).toEqual(["HELD_TAINTED", "NEEDS_APPROVAL"]);
    expect(parseApprovals(null)).toEqual([]);
  });

  it("UI-9: time left counts down in minutes and seconds and stops at expiry", () => {
    const at = new Date(NOW + 14 * 60_000 + 5_000).toISOString();
    expect(timeLeft(at, NOW)).toBe("14:05");
    expect(timeLeft(at, NOW + 14 * 60_000 + 4_001)).toBe("0:01");
    expect(timeLeft(at, NOW + 14 * 60_000 + 5_000)).toBeNull();
    expect(timeLeft("not a date", NOW)).toBeNull();
  });
});

describe("<ApprovalsInbox>", () => {
  it("UI-9: shows each pending approval's request, reasons in plain language, taint source, and time left", async () => {
    mount(api([[refund()]]));
    const card = await screen.findByRole("region", { name: /billing-bot/ });
    expect(card.textContent).toContain("stripe.refund");
    expect(card.textContent).toContain("$480.00");
    expect(card.textContent).toContain("pi_seed_500");
    expect(card.textContent).toContain("Held: this session read untrusted content");
    expect(card.textContent).toContain("Held: the amount is at or above the approval threshold");
    expect(card.textContent).toContain(`Untrusted content read from ${SOURCE}`);
    expect(card.textContent).toContain("14:05");
    // The untrusted page is shown as text, not a link.
    expect(card.querySelector("a")).toBeNull();
  });

  it("UI-21: notes that the sandbox uses mock rails only", async () => {
    mount(api([[]]));
    expect(await screen.findByText("Nothing is waiting for approval.")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("mock rails only");
  });

  it("UI-9, HITL-2: approve sends the action, says the request ran, and reloads the list", async () => {
    const a = api([[refund()], []]);
    mount(a);
    fireEvent.click(await screen.findByRole("button", { name: "Approve: stripe.refund nimbus-weather" }));
    await waitFor(() => expect(a.act).toHaveBeenCalledWith("ap-1", "approve"));
    expect(await screen.findByText("Approved. The request ran.")).toBeTruthy();
    expect(await screen.findByText("Nothing is waiting for approval.")).toBeTruthy();
  });

  it("HITL-3: a failed recheck says the request didn't run and why", async () => {
    mount(api([[refund()], []], { status: 200, body: { status: "failed_recheck", reasons: [{ code: "TOOL_NOT_ALLOWED" }] } as never }));
    fireEvent.click(await screen.findByRole("button", { name: /^Deny/ }));
    expect(await screen.findByText(/failed its recheck and didn't run\. Denied: this tool isn't on the agent's allow-list\./)).toBeTruthy();
  });

  it("HITL-5: an expired approval shows Expired and its buttons are disabled", async () => {
    let now = NOW;
    mount(api([[refund()]]), { now: () => now });
    await screen.findByText("14:05");
    now = NOW + 15 * 60_000;
    // The countdown ticks once a second.
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    expect(screen.getByText("Expired")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("HITL-11: someone who may not act sees the approval without buttons", async () => {
    mount(api([[refund()]]), { canAct: false, isSandbox: false });
    await screen.findByText("14:05");
    expect(screen.queryByRole("button", { name: /Approve|Deny/ })).toBeNull();
  });

  it("UI-9: a new hold appears without a reload when the stream reports it", async () => {
    const a = api([[], [refund()]]);
    mount(a);
    await screen.findByText("Nothing is waiting for approval.");
    act(() => FakeSource.last.emit("audit", { workspace_id: "w1", seq: 9, type: "approval_created", created_at: "", payload: { approval_id: "ap-1" }, prev_hash: "", hash: "" }));
    expect(await screen.findByText("14:05")).toBeTruthy();
    expect(a.list).toHaveBeenCalledTimes(2);
  });

  it("UI-15: a failed load shows the error state, and retry loads again", async () => {
    const list = vi.fn().mockResolvedValueOnce({ status: 503, body: {} }).mockResolvedValue({ status: 200, body: { approvals: [refund()] } });
    mount({ list, act: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("14:05")).toBeTruthy();
  });
});

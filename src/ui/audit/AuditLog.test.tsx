// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEventMessage } from "@/ui/events/summarize";
import { AuditLog, type VerifyApi, outcomeOf } from "./AuditLog";

afterEach(cleanup);

const HASH = "a1b2c3d4e5f6".padEnd(64, "0");
const event = (seq: number, type: string, payload: unknown = {}): AuditEventMessage => ({
  workspace_id: "w1",
  seq,
  type,
  created_at: "2026-11-28T10:00:00.000Z",
  payload,
  prev_hash: "0".repeat(64),
  hash: HASH,
});

const EVENTS = [event(3, "decision", { agent_id: "a1" }), event(2, "taint", { agent_id: "agent-without-name" }), event(1, "sandbox_created")];

function mount(api: VerifyApi, props: { older?: number | null; isFirstPage?: boolean; events?: AuditEventMessage[] } = {}) {
  return render(
    <AuditLog workspaceId="w1" events={props.events ?? EVENTS} older={props.older ?? null} isFirstPage={props.isFirstPage ?? true} agentNames={{ a1: "billing-bot" }} api={api} />,
  );
}

const apiReturning = (status: number, body: unknown) => ({ verify: vi.fn(async () => ({ status, body })) }) satisfies VerifyApi;

describe("<AuditLog>", () => {
  it("UI-10: lists each event with its seq, type, agent, and hash", () => {
    mount(apiReturning(200, {}));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual(["3", "2", "1"]);
    expect(rows[0]!.textContent).toContain("decision");
    expect(rows[0]!.textContent).toContain("billing-bot");
    expect(rows[1]!.textContent).toContain("agent agent-wi");
    expect(rows[2]!.textContent).toContain("–");
    // Shown truncated, with the full hash for screen readers and on hover.
    const hash = within(rows[0]!).getAllByRole("cell")[4]!;
    expect(hash.getAttribute("title")).toBe(HASH);
    expect(hash.textContent).toContain("a1b2c3d4e5f6…");
    expect(hash.textContent).toContain(HASH);
  });

  it("AUD-6: Verify chain asks the server for this workspace and shows the count and the signed head", async () => {
    const api = apiReturning(200, { workspace_id: "w1", ok: true, count: 88, head_seq: 88 });
    mount(api);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify chain" })));
    expect(api.verify).toHaveBeenCalledWith("w1");
    expect(screen.getByRole("status").textContent).toBe("Chain verified. Events checked: 88. Signed head at seq 88.");
  });

  it("AUD-8: a broken chain shows the first bad seq and why", async () => {
    mount(apiReturning(200, { ok: false, broken_at_seq: 4, why: "head", head_seq: 2 }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify chain" })));
    expect(screen.getByRole("status").textContent).toBe("Chain broken at seq 4. The signed chain head doesn't match the last event. Signed head at seq 2.");
  });

  it("UI-10: shows Older and Newest links for paging, and the empty state", () => {
    const { unmount } = mount(apiReturning(200, {}), { older: 51, isFirstPage: false });
    expect(screen.getByRole("link", { name: "Older events" }).getAttribute("href")).toBe("/audit?before=51");
    expect(screen.getByRole("link", { name: "Newest events" }).getAttribute("href")).toBe("/audit");
    unmount();
    mount(apiReturning(200, {}), { events: [] });
    expect(screen.getByText("No events yet.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("outcomeOf", () => {
  it("AUD-6: anything that isn't a well-formed result is an error, never a verified chain", () => {
    expect(outcomeOf(200, { ok: true, count: 3, head_seq: 3 })).toEqual({ kind: "ok", count: 3, headSeq: 3 });
    for (const [status, body] of [
      [200, { ok: true }],
      [200, { ok: "true", count: 3 }],
      [200, { ok: false, broken_at_seq: 2, why: "other" }],
      [503, { ok: true, count: 3 }],
      [200, null],
    ] as const) {
      expect(outcomeOf(status, body).kind).toBe("error");
    }
    expect(outcomeOf(429, null)).toEqual({ kind: "error", message: "error.rateLimited" });
  });
});

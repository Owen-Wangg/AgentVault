import { describe, expect, it } from "vitest";
import type { AuditEventBody, StoredEvent } from "@/core/audit";
import { buildChain } from "@/core/testing/audit-fixtures";
import { simulateTamper, tamperTarget } from "./tamper";

const WS = "ws_tamper";

const decision = (d: "allow" | "hold" | "deny"): Pick<AuditEventBody, "type" | "payload"> => ({
  type: "decision",
  payload: { agent_id: "a1", request: { vendor: "acme-supplies", tool: "payout.create", amount_micros: "900000000" }, decision: d, reasons: d === "allow" ? [] : [{ code: "HELD_TAINTED" }] },
});
const other = (type: AuditEventBody["type"]): Pick<AuditEventBody, "type" | "payload"> => ({ type, payload: { agent_id: "a1" } });

/** Seqs 1 to n of a valid chain, as the audit page has them: newest first, and only the last `page` rows. */
function page(items: Pick<AuditEventBody, "type" | "payload">[], size = items.length): StoredEvent[] {
  return buildChain(WS, items).events.slice(-size).reverse();
}

describe("tamperTarget", () => {
  it("UI-26: picks the newest held or denied decision, then the newest decision, then the newest event", () => {
    const chain = buildChain(WS, [decision("hold"), decision("allow"), other("rail_result")]).events;
    expect(tamperTarget(chain)?.seq).toBe(1);
    expect(tamperTarget(buildChain(WS, [decision("allow"), other("taint")]).events)?.seq).toBe(1);
    expect(tamperTarget(buildChain(WS, [other("taint"), other("agent_frozen")]).events)?.seq).toBe(2);
    expect(tamperTarget([])).toBeNull();
  });
});

describe("simulateTamper", () => {
  it("UI-26: rewriting a held decision to allow is caught at that seq, after the untouched copy verifies", () => {
    const events = page([other("scenario_started"), other("taint"), decision("hold"), other("approval_created")]);
    expect(simulateTamper(WS, events, "rewrite")).toEqual({
      kind: "done",
      untouched: 4,
      change: { kind: "rewrite", seq: 3, type: "decision", from: "hold", to: "allow" },
      result: { ok: false, brokenAtSeq: 3, why: "hash" },
    });
  });

  it("UI-26: a page that starts mid-chain still verifies untouched and still catches the edit", () => {
    const events = page([decision("allow"), decision("hold"), other("approval_created"), other("rail_result"), other("taint")], 3);
    const result = simulateTamper(WS, events, "rewrite");
    expect(result).toMatchObject({ kind: "done", untouched: 3, change: { kind: "rewrite", seq: 5, type: "taint", from: null, to: null }, result: { ok: false, brokenAtSeq: 5, why: "hash" } });
  });

  it("UI-26: deleting a row is caught as a gap at that seq, and it is always a row inside the page", () => {
    const inner = page([other("scenario_started"), decision("deny"), other("agent_frozen"), other("taint")]);
    expect(simulateTamper(WS, inner, "delete")).toMatchObject({ change: { kind: "delete", seq: 2, type: "decision" }, result: { ok: false, brokenAtSeq: 2, why: "gap" } });

    // The target is the newest row, so the middle row is deleted instead.
    const edge = page([other("scenario_started"), other("taint"), other("agent_frozen"), other("rail_result"), decision("hold")]);
    expect(simulateTamper(WS, edge, "delete")).toMatchObject({ change: { kind: "delete", seq: 3 }, result: { ok: false, brokenAtSeq: 3, why: "gap" } });
  });

  it("UI-26: never changes the page's own events", () => {
    const events = page([other("scenario_started"), decision("hold"), other("approval_created")]);
    const before = structuredClone(events);
    simulateTamper(WS, events, "rewrite");
    simulateTamper(WS, events, "delete");
    expect(events).toEqual(before);
  });

  it("UI-26: an empty page has nothing to change, and delete needs three events", () => {
    expect(simulateTamper(WS, [], "rewrite")).toBeNull();
    expect(simulateTamper(WS, page([decision("hold"), other("taint")]), "delete")).toBeNull();
    expect(simulateTamper(WS, page([decision("hold")]), "rewrite")).toMatchObject({ kind: "done", result: { ok: false, brokenAtSeq: 1 } });
  });

  it("UI-26: a page that doesn't verify untouched in the browser shows nothing else", () => {
    const events = page([other("scenario_started"), decision("hold"), other("approval_created")]);
    expect(simulateTamper("ws_other", events, "rewrite")).toEqual({ kind: "unchecked" });
  });
});

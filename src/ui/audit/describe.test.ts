import { describe, expect, it } from "vitest";
import { EVENT_TYPES, type EventType } from "@/core/audit/chain";
import { copyFor } from "@/ui/copy";
import { NOTHING, describeEvent } from "./describe";

const en = copyFor("default");
const spooky = copyFor("kiroween");
const say = (type: string, payload: unknown, c = en) => describeEvent({ type, payload }, c);

const decision = (decision: string, tool: string, amount: string, codes: string[]) => ({
  agent_id: "a1",
  request: { vendor: "acme-supplies-1a2b3c4d", tool, amount_micros: amount },
  decision,
  reasons: codes.map((code) => ({ code })),
});

/** One readable payload per event type, as the server writes it. Typed by EventType, so a new type needs one. */
const SAMPLES: Record<EventType, unknown> = {
  decision: decision("hold", "payout.create", "900000000", ["HELD_TAINTED", "NEEDS_APPROVAL"]),
  rail_result: { status: "settled", rail: "mock", decision_seq: 4, settled_micros: "1500" },
  taint: { agent_id: "a1", session_id: "s1", url: "https://example.test/docs", url_sha256: "ab" },
  fetch_failed: { agent_id: "a1", url: "https://example.test/x", code: "FETCH_TIMEOUT", reason: "timeout" },
  approval_created: { approval_id: "p1", decision_seq: 4, reasons: [{ code: "HELD_TAINTED" }], expires_at: "2026-11-28T10:15:00.000Z" },
  approval_decided: { approval_id: "p1", action: "approve", status: "approved", actor: "sandbox_visitor" },
  approval_expired: { approval_id: "p1", expires_at: "2026-11-28T10:15:00.000Z", actor: "system" },
  approval_executed: { approval_id: "p1", status: "executed", actor: "sandbox_visitor", decision_seq: 9 },
  agent_frozen: { agent_id: "a1", decision_seq: 31 },
  agent_unfrozen: { agent_id: "a1", actor: "sandbox_visitor", frozen_at: "2026-11-28T10:00:00.000Z" },
  envelope_updated: { agent_id: "a1", version: 3, actor: "user-123", envelope: {} },
  scenario_started: { scenario: "hijack", run_id: "r1", actor: "sandbox_visitor", agent_id: "a1", agent_name: "scenario-payee-hijack" },
  sandbox_created: { seed_version: 3, previous_workspace_id: null, agents: 9, vendors: 3, tasks: 6 },
  sandbox_retired: { successor_workspace_id: "w2", agents_revoked: 9 },
  mcp_agent_created: { actor: "cli", preset: "weather", agent_id: "a1", agent_name: "mcp-weather-agent", task_id: "t1" },
  payee_updated: { decision_seq: 4, rail: "stripe", vendor: "acme-supplies", old_ref: "acct_1AcmeSupplies", new_ref: "acct_1AttackerSandbox" },
  testnet_workspace_created: { agent_id: "a1", vendor: "nimbus-weather", amount_micros: "1500" },
};

describe("describeEvent", () => {
  it("UI-30: describes every event type the audit log can hold", () => {
    for (const type of EVENT_TYPES) {
      const text = say(type, SAMPLES[type]);
      expect(text, type).not.toBe(NOTHING);
      expect(text.length, type).toBeGreaterThan(0);
    }
  });

  it("UI-30: a decision gives the outcome, tool, amount, and reason codes", () => {
    expect(say("decision", SAMPLES.decision)).toBe("Held payout.create, $900.00: HELD_TAINTED, NEEDS_APPROVAL");
    expect(say("decision", decision("allow", "x402.pay", "1500", []))).toBe("Allowed x402.pay, $0.0015");
    expect(say("decision", decision("deny", "x402.pay", "2000000", ["DENY_INTENT_DRIFT"]))).toBe("Denied x402.pay, $2.00: DENY_INTENT_DRIFT");
    // payee.update moves no money, so no $0.00.
    expect(say("decision", decision("hold", "payee.update", "0", ["HELD_TAINTED"]))).toBe("Held payee.update: HELD_TAINTED");
  });

  it("UI-30: a rail result says whether it settled, failed, or is still unknown", () => {
    expect(say("rail_result", SAMPLES.rail_result)).toBe("Settled on mock, $0.0015");
    expect(say("rail_result", { status: "settled", rail: "stripe", settled_micros: "900000000", payout_to: "acct_1AcmeSupplies" })).toBe(
      "Settled on stripe, $900.00, paid out to acct_1AcmeSupplies",
    );
    expect(say("rail_result", { status: "settled", rail: null })).toBe("Done, with no rail call");
    expect(say("rail_result", { status: "failed", rail: "x402", code: "RAIL_REJECTED" })).toBe("The rail refused it: RAIL_REJECTED");
    expect(say("rail_result", { status: "unknown", rail: "x402", code: "RAIL_TIMEOUT" })).toBe("The rail hasn't confirmed it, so the amount stays counted");
    expect(say("rail_result", { status: "settled", rail: "x402", settled_micros: "1500", reconciled: true })).toBe("Settled on x402, $0.0015 (found by the reconciler)");
  });

  it("UI-30: approvals name who acted, in words rather than IDs", () => {
    expect(say("approval_decided", SAMPLES.approval_decided)).toBe("Approved by a sandbox visitor");
    expect(say("approval_decided", { status: "denied", actor: "user-8f3a" })).toBe("Denied by a workspace member");
    expect(say("approval_decided", { status: "failed_recheck", actor: "sandbox_visitor", reasons: [{ code: "AGENT_FROZEN" }] })).toBe(
      "Approved by a sandbox visitor, but the recheck failed: AGENT_FROZEN",
    );
    expect(say("approval_created", SAMPLES.approval_created)).toBe("Sent to the approvals inbox: HELD_TAINTED");
    expect(say("approval_executed", SAMPLES.approval_executed)).toBe("The approved request passed its recheck");
    expect(say("approval_expired", SAMPLES.approval_expired)).toBe("The approval expired");
    expect(say("agent_unfrozen", { actor: "system" })).toBe("Unfrozen by AgentVault");
    expect(say("envelope_updated", SAMPLES.envelope_updated)).toBe("Envelope version 3 saved by a workspace member");
    expect(say("mcp_agent_created", SAMPLES.mcp_agent_created)).toBe("MCP agent created: mcp-weather-agent");
    expect(say("envelope_updated", { version: 2, actor: "cli" })).toBe("Envelope version 2 saved by the command line");
  });

  it("UI-30: taints, payee changes, and scenarios carry their details", () => {
    expect(say("taint", SAMPLES.taint)).toBe("Session tainted by https://example.test/docs");
    expect(say("payee_updated", SAMPLES.payee_updated)).toBe("Payout account changed from acct_1AcmeSupplies to acct_1AttackerSandbox");
    expect(say("payee_updated", { old_ref: null, new_ref: "acct_9" })).toBe("Payout account changed from none to acct_9");
    expect(say("scenario_started", SAMPLES.scenario_started)).toBe("Scenario started: Payee hijack");
    expect(say("scenario_started", { scenario: "injection", agent: "gemini" })).toBe("Scenario started with the live AI agent: Prompt injection");
    expect(say("fetch_failed", SAMPLES.fetch_failed)).toBe("Fetch refused: FETCH_TIMEOUT");
  });

  it("UI-30: a value that looks like a copy slot is inserted as it is", () => {
    expect(say("taint", { url: "https://example.test/{actor}$&" })).toBe("Session tainted by https://example.test/{actor}$&");
  });

  it("UI-30: Kiroween mode has its own wording for freezes, taints, and approvals", () => {
    expect(say("agent_frozen", SAMPLES.agent_frozen, spooky)).toBe("Agent sealed in The Crypt");
    expect(say("agent_unfrozen", SAMPLES.agent_unfrozen, spooky)).toBe("Released from The Crypt by a wandering visitor");
    expect(say("taint", SAMPLES.taint, spooky)).toBe("Session Haunted by https://example.test/docs");
    expect(say("approval_decided", SAMPLES.approval_decided, spooky)).toBe("Blessed by a wandering visitor");
    expect(say("approval_decided", { status: "denied", actor: "sandbox_visitor" }, spooky)).toBe("Banished by a wandering visitor");
    // Everything else falls back to the default wording.
    expect(say("decision", SAMPLES.decision, spooky)).toBe(say("decision", SAMPLES.decision));
  });

  it("UI-30: an unknown type or an unreadable payload shows a dash", () => {
    expect(say("something_new", { agent_id: "a1" })).toBe(NOTHING);
    expect(say("decision", { decision: "maybe" })).toBe(NOTHING);
    expect(say("decision", decision("allow", "x402.pay", "1.5", []))).toBe(NOTHING);
    expect(say("taint", null)).toBe(NOTHING);
    expect(say("approval_decided", { status: "approved" })).toBe(NOTHING);
    expect(say("toString", {})).toBe(NOTHING);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCENARIO_NAMES } from "@/agents/scripted/scenarios";
import type { EventStreamOptions } from "@/ui/events/use-event-stream";
import type { AuditEventMessage } from "@/ui/events/summarize";
import { type ScenariosApi, ScenarioRunner } from "./ScenarioRunner";
import { parseRunResult, runAgentId, runSteps } from "./run-view";

vi.mock("next/navigation", () => ({ usePathname: () => "/scenarios" }));

afterEach(cleanup);

const DOCS = "https://agentvault.example/vendor/docs/integration";

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
const event = (type: string, payload: unknown): AuditEventMessage => ({
  workspace_id: "sandbox-1",
  seq: ++seq,
  type,
  created_at: "2026-11-27T10:00:00.000Z",
  payload,
  prev_hash: "0".repeat(64),
  hash: "1".repeat(64),
});
const started = (runId: string, agentId: string) => event("scenario_started", { scenario: "injection", run_id: runId, agent_id: agentId });
const decision = (agentId: string, tool: string, amount: string, d: string, codes: string[]) =>
  event("decision", { agent_id: agentId, request: { vendor: "nimbus-weather", tool, amount_micros: amount }, decision: d, reasons: codes.map((code) => ({ code })) });
const taint = (agentId: string) => event("taint", { agent_id: agentId, session_id: "s", url: DOCS, content_sha256: "ab", first_taint: true });

const injectionResponse = {
  scenario: "injection",
  agent_id: "agent-run",
  completed: true,
  summary: {
    requests: 2,
    allowed_micros: "0",
    held_micros: "480000000",
    blocked_micros: "0",
    decisions: { allow: 0, hold: 1, deny: 0 },
    reasons: [
      { code: "HELD_TAINTED", count: 1 },
      { code: "NEEDS_APPROVAL", count: 1 },
    ],
  },
};

/** An API whose run resolves when the test says so. */
function pendingApi() {
  let resolve!: (r: { status: number; body: unknown }) => void;
  const run = vi.fn(() => new Promise<{ status: number; body: unknown }>((r) => (resolve = r)));
  return { api: { run } satisfies ScenariosApi, finish: (r: { status: number; body: unknown }) => act(async () => resolve(r)) };
}

/** The run's status line and the stream badge are both live regions. */
const statusText = () => screen.getAllByRole("status").map((s) => s.textContent).join(" | ");

const mount = (api: ScenariosApi) => render(<ScenarioRunner workspaceId="sandbox-1" scenarios={SCENARIO_NAMES} api={api} stream={stream} newRunId={() => "run-1"} />);

describe("<ScenarioRunner>", () => {
  it("AGT-1: offers the four scenarios, each with a one-sentence description, and streams the sandbox", () => {
    mount(pendingApi().api);
    for (const title of ["Normal purchase", "Runaway loop", "Prompt injection", "Intent drift"]) {
      const card = screen.getByRole("region", { name: title });
      const text = card.querySelector("p")!.textContent!;
      expect(text).toMatch(/^[A-Z][^]*\.$/);
      expect(text.slice(0, -1)).not.toMatch(/\.\s/);
      expect(within(card).getByRole("button", { name: `Run: ${title}` })).toBeTruthy();
    }
    expect(FakeSource.last.url).toBe("/api/v1/events?workspace_id=sandbox-1");
    expect(screen.getByRole("note").textContent).toContain("mock rails");
  });

  it("AGT-3: shows the run's steps live, in order, with plain-language reasons, and only that run's", async () => {
    const { api, finish } = pendingApi();
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Run: Prompt injection" }));
    expect(api.run).toHaveBeenCalledWith("injection", "run-1", "scripted");
    for (const button of screen.getAllByRole("button", { name: /^Run:/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText("Starting the run…")).toBeTruthy();

    await act(async () => {
      FakeSource.last.emit("audit", decision("someone-else", "x402.pay", "1500", "allow", []));
      FakeSource.last.emit("audit", started("other-run", "someone-else"));
      FakeSource.last.emit("audit", started("run-1", "agent-run"));
      FakeSource.last.emit("audit", taint("agent-run"));
      FakeSource.last.emit("audit", decision("agent-run", "stripe.refund", "480000000", "hold", ["HELD_TAINTED", "NEEDS_APPROVAL"]));
    });
    const log = await screen.findByRole("log", { name: "Steps" });
    const items = within(log).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(`Read an untrusted page, so the session is now tainted: ${DOCS}`);
    // The untrusted page is shown as text, not a link.
    expect(within(log).queryByRole("link")).toBeNull();
    expect(items[1]!.textContent).toContain("stripe.refund");
    expect(items[1]!.textContent).toContain("$480.00");
    expect(items[1]!.textContent).toContain("Held: this session read untrusted content");
    expect(screen.queryByText("Summary")).toBeNull();

    await finish({ status: 200, body: injectionResponse });
    expect((screen.getByRole("button", { name: "Run: Normal purchase" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("AGT-17: the decision path follows the run's latest decision and names each state in text", async () => {
    const { api } = pendingApi();
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Run: Prompt injection" }));
    expect(screen.queryByTestId("decision-path")).toBeNull();
    await act(async () => {
      FakeSource.last.emit("audit", started("run-1", "agent-run"));
      FakeSource.last.emit("audit", decision("agent-run", "x402.pay", "1500", "allow", []));
    });
    await screen.findByRole("region", { name: "How AgentVault decided" });
    const states = () => within(screen.getByRole("region", { name: "How AgentVault decided" })).getAllByTestId("path-state").map((s) => s.textContent);
    expect(states()).toEqual(["Passed", "Passed", "Passed", "Passed", "Sent"]);

    await act(async () => {
      FakeSource.last.emit("audit", taint("agent-run"));
      FakeSource.last.emit("audit", decision("agent-run", "stripe.refund", "480000000", "hold", ["HELD_TAINTED", "NEEDS_APPROVAL"]));
    });
    const region = screen.getByRole("region", { name: "How AgentVault decided" });
    await within(region).findByText("stripe.refund");
    expect(region.textContent).toContain("stripe.refund");
    expect(region.textContent).toContain("$480.00");
    // Agent, spend limits, task scope, untrusted input, then the rail.
    expect(states()).toEqual(["Passed", "Held", "Passed", "Held", "Not sent"]);
  });

  it("UI-25: a held payee change step shows the account the agent asked to switch to, as text", async () => {
    const { api } = pendingApi();
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Run: Payee hijack" }));
    await act(async () => {
      FakeSource.last.emit("audit", started("run-1", "agent-run"));
      FakeSource.last.emit(
        "audit",
        event("decision", {
          agent_id: "agent-run",
          request: { vendor: "acme-supplies", tool: "payee.update", amount_micros: "0", args: { vendor: "acme-supplies", payee_ref: "acct_1AttackerPayout", rail: "stripe" } },
          decision: "hold",
          reasons: [{ code: "HELD_TAINTED" }],
        }),
      );
    });
    const log = await screen.findByRole("log", { name: "Steps" });
    expect(within(log).getByTestId("requested-payee").textContent).toBe("Requested payout account: acct_1AttackerPayout");
    expect(within(log).queryByRole("link")).toBeNull();
  });

  it("AGT-10: when the run finishes, shows requests, spend allowed, held, and blocked, and decisions by reason", async () => {
    const { api, finish } = pendingApi();
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Run: Prompt injection" }));
    await finish({ status: 200, body: injectionResponse });
    const summary = screen.getByRole("region", { name: "Summary" });
    const text = summary.textContent!;
    expect(text).toContain("Requests made2");
    expect(text).toContain("Spend allowed$0.00");
    expect(text).toContain("Spend held for approval$480.00");
    expect(text).toContain("Spend blocked$0.00");
    expect(text).toContain("Held: this session read untrusted content");
    expect(text).toContain("×1");
    expect(within(summary).getByRole("link", { name: /inbox/ }).getAttribute("href")).toBe("/approvals");
  });

  it("AGT-10: a run that stopped early says so, and a run without holds has no inbox link", async () => {
    const { api, finish } = pendingApi();
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Run: Normal purchase" }));
    await finish({
      status: 200,
      body: { ...injectionResponse, completed: false, summary: { ...injectionResponse.summary, held_micros: "0", decisions: { allow: 2, hold: 0, deny: 0 }, reasons: [] } },
    });
    expect(statusText()).toContain("The run stopped before it finished");
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.textContent).toContain("No denials or holds.");
    expect(within(summary).queryByRole("link")).toBeNull();
  });

  it("AGT-2: a busy scenario, a rate limit, and an error each get their own message, and the buttons come back", async () => {
    for (const [status, message] of [
      [409, "Someone else is running this scenario"],
      [429, "Too many actions from your address"],
      [503, "That didn't work"],
      [200, "That didn't work"], // a 200 that isn't a run result
    ] as const) {
      const { api, finish } = pendingApi();
      const { unmount } = mount(api);
      fireEvent.click(screen.getByRole("button", { name: "Run: Runaway loop" }));
      await finish({ status, body: status === 200 ? { nope: true } : { error: "X" } });
      expect(statusText()).toContain(message);
      expect((screen.getByRole("button", { name: "Run: Runaway loop" }) as HTMLButtonElement).disabled).toBe(false);
      unmount();
    }
    const failing: ScenariosApi = { run: vi.fn(async () => Promise.reject(new TypeError("offline"))) };
    mount(failing);
    fireEvent.click(screen.getByRole("button", { name: "Run: Runaway loop" }));
    await waitFor(() => expect(statusText()).toContain("That didn't work"));
  });
});

const LIVE = ["normal", "injection", "drift"] as const;
const mountLive = (api: ScenariosApi, live: readonly (typeof SCENARIO_NAMES)[number][] = LIVE) =>
  render(<ScenarioRunner workspaceId="sandbox-1" scenarios={SCENARIO_NAMES} liveScenarios={live} api={api} stream={stream} newRunId={() => "run-1"} />);

describe("<ScenarioRunner> with the live agent", () => {
  it("AGT-11: without GEMINI_API_KEY there are no live buttons and no live note", () => {
    mount(pendingApi().api);
    expect(screen.queryAllByRole("button", { name: /^Run with live AI agent/ })).toHaveLength(0);
    expect(screen.queryByText(/Gemini/)).toBeNull();
  });

  it("AGT-11: with it, three scenarios offer a live run, and the runaway loop says it's scripted only", () => {
    mountLive(pendingApi().api);
    for (const title of ["Normal purchase", "Prompt injection", "Intent drift"]) {
      expect(within(screen.getByRole("region", { name: title })).getByRole("button", { name: `Run with live AI agent: ${title}` })).toBeTruthy();
    }
    const runaway = screen.getByRole("region", { name: "Runaway loop" });
    expect(within(runaway).queryByRole("button", { name: /live/ })).toBeNull();
    expect(runaway.textContent).toContain("Scripted only");
    expect(screen.getAllByRole("note").map((n) => n.textContent).join(" ")).toContain("Gemini on its free tier");
  });

  it("AGT-16: a live run is labeled, and each step shows its drift score next to the decision", async () => {
    const { api, finish } = pendingApi();
    mountLive(api);
    fireEvent.click(screen.getByRole("button", { name: "Run with live AI agent: Intent drift" }));
    expect(api.run).toHaveBeenCalledWith("drift", "run-1", "gemini");
    await act(async () => {
      FakeSource.last.emit("audit", started("run-1", "agent-run"));
      FakeSource.last.emit(
        "audit",
        event("decision", {
          agent_id: "agent-run",
          request: { vendor: "gpu-cloud", tool: "x402.pay", amount_micros: "250000", advisory_drift_score: 100 },
          decision: "deny",
          reasons: [{ code: "DENY_INTENT_DRIFT" }, { code: "ADVISORY_DRIFT" }],
        }),
      );
    });
    const item = within(await screen.findByRole("log", { name: "Steps" })).getAllByRole("listitem")[0]!;
    expect(item.textContent).toContain("Drift score: 100/100");
    expect(item.textContent).toContain("Held: the drift check thinks this may be off-task");
    await finish({ status: 200, body: { ...injectionResponse, agent: "gemini", stop: "finished" } });
    expect(screen.getByRole("heading", { name: /^Intent drift\s*Live AI agent$/ })).toBeTruthy();
  });

  it("AGT-14: a Gemini rate limit says so and offers the scripted run, which then runs scripted", async () => {
    const { api, finish } = pendingApi();
    mountLive(api);
    fireEvent.click(screen.getByRole("button", { name: "Run with live AI agent: Prompt injection" }));
    await finish({ status: 200, body: { ...injectionResponse, completed: false, agent: "gemini", stop: "gemini_rate_limited" } });
    expect(statusText()).toContain("free-tier rate limit");
    expect(statusText()).not.toContain("The run stopped before it finished");
    fireEvent.click(screen.getByRole("button", { name: "Run the scripted agent instead" }));
    expect(api.run).toHaveBeenLastCalledWith("injection", "run-1", "scripted");
  });

  it("AGT-14, AGT-15: other stops get their own message; only Gemini failures offer the scripted run", async () => {
    for (const [stop, message, offer] of [
      ["gemini_failed", "couldn't get an answer from Gemini", true],
      ["tool_call_cap", "limit of 15 tool calls", false],
      ["turn_cap", "limit of 8 turns", false],
      ["time_limit", "ran out of time", false],
    ] as const) {
      const { api, finish } = pendingApi();
      const { unmount } = mountLive(api);
      fireEvent.click(screen.getByRole("button", { name: "Run with live AI agent: Normal purchase" }));
      await finish({ status: 200, body: { ...injectionResponse, completed: false, agent: "gemini", stop } });
      expect(statusText()).toContain(message);
      expect(screen.queryByRole("button", { name: "Run the scripted agent instead" }) !== null).toBe(offer);
      unmount();
    }
  });

  it("AGT-11: a used-up daily quota has its own message", async () => {
    const { api, finish } = pendingApi();
    mountLive(api);
    fireEvent.click(screen.getByRole("button", { name: "Run with live AI agent: Normal purchase" }));
    await finish({ status: 429, body: { error: "LIVE_QUOTA_USED" } });
    expect(statusText()).toContain("Today's live AI runs are used up");
    expect(screen.getByRole("button", { name: "Run the scripted agent instead" })).toBeTruthy();
  });
});

describe("run view", () => {
  it("AGT-3: finds the run's agent by run_id, and its decisions and taints in seq order", () => {
    const events = [started("r0", "a0"), started("r1", "a1"), decision("a0", "x402.pay", "1", "allow", []), taint("a1"), decision("a1", "x", "2", "deny", ["TOOL_NOT_ALLOWED"]), event("decision", { broken: true })];
    expect(runAgentId(events, "r1")).toBe("a1");
    expect(runAgentId(events, "nope")).toBeNull();
    expect(runSteps([...events].reverse(), "a1").map((s) => s.kind)).toEqual(["taint", "decision"]);
  });

  it("AGT-10: reads the run response's summary as exact micros, and rejects anything else", () => {
    expect(parseRunResult(injectionResponse)?.summary).toMatchObject({ heldMicros: 480_000_000n, requests: 2 });
    for (const bad of [null, {}, { ...injectionResponse, summary: { ...injectionResponse.summary, held_micros: "4.8" } }, { ...injectionResponse, completed: "yes" }]) {
      expect(parseRunResult(bad)).toBeNull();
    }
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { AgentsTable } = await import("./AgentsTable");
const { CreateAgentDialog } = await import("./CreateAgentDialog");

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const agent = (over: Partial<Parameters<typeof AgentsTable>[0]["agents"][number]> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "billing-bot",
  frozenAt: null,
  revokedAt: null,
  createdAt: "2026-11-24T10:00:00.000Z",
  tainted: false,
  taintSourceUrl: null,
  ...over,
});

describe("<AgentsTable>", () => {
  it("UI-7: shows frozen, tainted, and active status, and links each agent's envelope", () => {
    render(
      <AgentsTable
        canUnfreeze
        agents={[agent(), agent({ id: "22222222-2222-4222-8222-222222222222", name: "research-bot", frozenAt: "2026-11-24T11:00:00.000Z", tainted: true })]}
      />,
    );
    const [first, second] = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(first!.textContent).toContain("Active");
    expect(second!.textContent).toContain("Frozen");
    expect(second!.textContent).toContain("Tainted session");
    expect(within(second!).getByRole("link", { name: "Envelope research-bot" }).getAttribute("href")).toBe("/agents/22222222-2222-4222-8222-222222222222");
    expect(within(first!).queryByRole("button")).toBeNull();
  });

  it("UI-7, HITL-9: unfreezes a frozen agent and refreshes the list", async () => {
    const unfreeze = vi.fn(async () => 200);
    render(<AgentsTable canUnfreeze unfreeze={unfreeze} agents={[agent({ frozenAt: "2026-11-24T11:00:00.000Z" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Unfreeze billing-bot" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(unfreeze).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("UI-4: shows the rate-limit message when the sandbox says 429", async () => {
    render(<AgentsTable canUnfreeze unfreeze={async () => 429} agents={[agent({ frozenAt: "2026-11-24T11:00:00.000Z" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Unfreeze billing-bot" }));
    expect(await screen.findByText(/Too many actions/)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("UI-7: centers each row's cells vertically, so the name, status, and date line up with the actions", () => {
    render(<AgentsTable canUnfreeze agents={[agent(), agent({ id: "22222222-2222-4222-8222-222222222222", frozenAt: "2026-11-24T11:00:00.000Z" })]} />);
    for (const row of within(screen.getByRole("table")).getAllByRole("row").slice(1)) {
      expect(row.className).toContain("align-middle");
      expect(row.className).not.toContain("align-top");
    }
  });

  it("UI-7: hides unfreeze from someone who may not use it", () => {
    render(<AgentsTable canUnfreeze={false} agents={[agent({ frozenAt: "2026-11-24T11:00:00.000Z" })]} />);
    expect(screen.queryByRole("button", { name: /Unfreeze/ })).toBeNull();
  });

  it("UI-15: shows the empty state", () => {
    render(<AgentsTable canUnfreeze agents={[]} />);
    expect(screen.getByText("No agents yet.")).toBeTruthy();
  });
});

describe("<CreateAgentDialog>", () => {
  it("UI-7, PXY-1: shows the new key once with a copy button, and forgets it when closed", async () => {
    const create = vi.fn(async () => ({ status: 201, body: { agent_id: "a", name: "bot", api_key: "av_test_secret123" } }));
    const copy = vi.fn(async () => {});
    render(<CreateAgentDialog create={create} copy={copy} />);
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  bot  " } });
    await act(async () => fireEvent.submit(screen.getByLabelText("Name").closest("form")!));
    expect(create).toHaveBeenCalledWith("bot");
    expect(screen.getByText("av_test_secret123")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("shown once");
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("av_test_secret123"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole("button", { name: "Create agent" })[0]!);
    expect(screen.queryByText("av_test_secret123")).toBeNull();
  });

  it("UI-7: asks for a name, and shows a generic error when creation fails", async () => {
    const create = vi.fn(async () => ({ status: 503, body: { error: "SERVICE_UNAVAILABLE", correlation_id: "x" } }));
    render(<CreateAgentDialog create={create} />);
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await act(async () => fireEvent.submit(screen.getByLabelText("Name").closest("form")!));
    expect(screen.getByText("Give the agent a name")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bot" } });
    await act(async () => fireEvent.submit(screen.getByLabelText("Name").closest("form")!));
    expect(screen.getByText("That didn't work. Try again.")).toBeTruthy();
  });
});

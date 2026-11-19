// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));
const { ThemeProvider } = await import("@/ui/ThemeProvider");
const { TourCard } = await import("./TourCard");
const { OverviewView } = await import("./OverviewView");

afterEach(cleanup);

class FakeSource extends EventTarget {
  readyState = 1;
  close() {}
}
const stream = { createEventSource: () => new FakeSource() as unknown as EventSource, onRetired: () => {} };

const steps = () => within(screen.getByRole("region", { name: /Start here/ })).getAllByRole("listitem");

describe("<TourCard>", () => {
  it("UI-23: lists the tour in order, each step linking to the page where it happens", () => {
    render(<TourCard tour={{ testnet: true }} />);
    const items = steps();
    expect(items.map((li) => within(li).getByRole("link").getAttribute("href"))).toEqual(["/scenarios", "/approvals", "/audit", "/scenarios"]);
    expect(items[0]!.textContent).toContain("Run Payee hijack");
    expect(items[1]!.textContent).toContain("Deny the payout account change and approve the payout");
    expect(items[2]!.textContent).toContain("Verify chain");
    expect(items[3]!.textContent).toContain("Make a real testnet payment");
  });

  it("UI-23: the testnet step appears only where the testnet card is shown", () => {
    render(<TourCard tour={{ testnet: false }} />);
    expect(steps()).toHaveLength(3);
    expect(screen.queryByText(/testnet payment/)).toBeNull();
  });

  it("UI-23: the Kiroween copy names the Kiroween testnet button", () => {
    render(
      <ThemeProvider initial="kiroween">
        <TourCard tour={{ testnet: true }} />
      </ThemeProvider>,
    );
    expect(screen.getByRole("heading", { name: /if you dare/ })).toBeTruthy();
    expect(steps()[3]!.textContent).toContain("Make a real offering");
  });
});

describe("<OverviewView> tour", () => {
  it("UI-23: the overview shows the card only when the page passes a tour", () => {
    const { unmount } = render(<OverviewView workspaceId="w1" agentNames={{}} stream={stream} tour={{ testnet: false }} />);
    expect(screen.getByRole("region", { name: /Start here/ })).toBeTruthy();
    unmount();
    render(<OverviewView workspaceId="w1" agentNames={{}} stream={stream} />);
    expect(screen.queryByRole("region", { name: /Start here/ })).toBeNull();
  });
});

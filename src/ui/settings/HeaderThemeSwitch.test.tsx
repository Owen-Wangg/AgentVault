// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_COOKIE } from "@/ui/theme";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/" }));
const { ThemeProvider } = await import("@/ui/ThemeProvider");
const { HeaderThemeSwitch } = await import("./HeaderThemeSwitch");
const { ThemeToggle } = await import("./ThemeToggle");
const { WorkspaceHeader } = await import("@/ui/components/WorkspaceHeader");

afterEach(() => {
  cleanup();
  refresh.mockReset();
  document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0`;
  delete document.documentElement.dataset.theme;
});

describe("<HeaderThemeSwitch>", () => {
  it("UI-24: flips Kiroween mode through the same provider as the Settings switch", () => {
    render(
      <ThemeProvider initial="default">
        <HeaderThemeSwitch />
        <ThemeToggle />
      </ThemeProvider>,
    );
    const switches = screen.getAllByRole("switch", { name: "Kiroween mode" });
    const header = switches.find((s) => s.tagName === "BUTTON")!;
    const settings = switches.find((s) => s.tagName === "INPUT") as HTMLInputElement;
    expect(header.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(header);
    expect(header.getAttribute("aria-checked")).toBe("true");
    expect(settings.checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("kiroween");
    expect(document.cookie).toContain(`${THEME_COOKIE}=kiroween`);
    expect(refresh).toHaveBeenCalledTimes(1);

    fireEvent.click(header);
    expect(header.getAttribute("aria-checked")).toBe("false");
    expect(document.documentElement.dataset.theme).toBe("default");
  });

  it("UI-27: the workspace header says what AgentVault is, in each theme", () => {
    const { unmount } = render(
      <ThemeProvider initial="default">
        <WorkspaceHeader workspace={{ name: "sandbox-1", isSandbox: true }} />
      </ThemeProvider>,
    );
    expect(screen.getByText("A security proxy that checks every payment an AI agent makes before any money moves.")).toBeTruthy();
    unmount();
    render(
      <ThemeProvider initial="kiroween">
        <WorkspaceHeader workspace={null} />
      </ThemeProvider>,
    );
    expect(screen.getByText(/^Wards for AI agents that spend money/)).toBeTruthy();
  });

  it("UI-24: the workspace header carries the switch on every page", () => {
    render(
      <ThemeProvider initial="kiroween">
        <WorkspaceHeader workspace={{ name: "sandbox-1", isSandbox: true }} />
      </ThemeProvider>,
    );
    expect(screen.getByRole("switch", { name: "Kiroween mode" }).getAttribute("aria-checked")).toBe("true");
  });
});

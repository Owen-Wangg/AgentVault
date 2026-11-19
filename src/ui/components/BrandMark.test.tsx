// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEMES } from "@/ui/theme";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/" }));
const { ThemeProvider } = await import("@/ui/ThemeProvider");
const { BrandMark } = await import("./BrandMark");
const { Sidebar } = await import("./Sidebar");
const { WorkspaceHeader } = await import("./WorkspaceHeader");

beforeEach(() => {
  // The sidebar's pending count reads the approvals list; none pending.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ workspace_id: "w1", sandbox: true, approvals: [] })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every color the SVG paints with. */
function paints(svg: Element): string[] {
  return [...svg.querySelectorAll("*")].flatMap((el) => ["fill", "stroke"].map((a) => el.getAttribute(a)).filter((v): v is string => v !== null && v !== "none"));
}

describe("<BrandMark>", () => {
  it("UI-28: is decorative, and paints only with theme variables", () => {
    const { container } = render(<BrandMark className="size-7" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("title")).toBeNull();
    const colors = paints(svg);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(color).toMatch(/^var\(--(accent|accent-soft|accent-text)\)$/);
  });

  for (const theme of THEMES) {
    it(`UI-28: the sidebar's brand link is named by the app name and holds the mark, in the ${theme} theme`, () => {
      render(
        <ThemeProvider initial={theme}>
          <Sidebar />
        </ThemeProvider>,
      );
      const link = screen.getByRole("link", { name: "AgentVault" });
      expect(link.getAttribute("href")).toBe("/");
      expect(link.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });

    it(`UI-28: below md, the workspace header shows the mark and the app name as a link home, in the ${theme} theme`, () => {
      render(
        <ThemeProvider initial={theme}>
          <WorkspaceHeader workspace={{ name: "sandbox-1", isSandbox: true }} />
        </ThemeProvider>,
      );
      const header = screen.getByRole("banner");
      const link = within(header).getByRole("link", { name: "AgentVault" });
      expect(link.getAttribute("href")).toBe("/");
      expect(link.className).toContain("md:hidden");
      expect(link.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });
  }
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_COOKIE, parseTheme } from "@/ui/theme";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/settings" }));
const { ThemeProvider, saveTheme } = await import("@/ui/ThemeProvider");
const { ThemeToggle } = await import("./ThemeToggle");
const { AgentsTable } = await import("@/ui/agents/AgentsTable");

const frozenAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "billing-bot",
  frozenAt: "2026-11-30T10:00:00.000Z",
  revokedAt: null,
  createdAt: "2026-11-30T09:00:00.000Z",
  tainted: true,
  taintSourceUrl: "https://agentvault.example/vendor/docs/integration",
};

/** Reads one cookie's value from document.cookie. */
const cookieValue = (name: string) =>
  document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

afterEach(() => {
  cleanup();
  refresh.mockReset();
  document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0`;
  delete document.documentElement.dataset.theme;
});

describe("<ThemeToggle>", () => {
  it("UI-16: turning on Kiroween mode switches data-theme and the copy of client components at once", () => {
    render(
      <ThemeProvider initial="default">
        <ThemeToggle />
        <AgentsTable agents={[frozenAgent]} canUnfreeze />
      </ThemeProvider>,
    );
    const toggle = screen.getByRole<HTMLInputElement>("switch", { name: "Kiroween mode" });
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("Frozen")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("kiroween");
    expect(screen.getByText("The Crypt")).toBeTruthy();
    expect(screen.getByText("Haunted")).toBeTruthy();
    expect(screen.queryByText("Frozen")).toBeNull();
    expect(screen.getByText("Kiroween mode is on. Happy haunting.")).toBeTruthy();
    // Server components re-render with the new cookie.
    expect(refresh).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("default");
    expect(screen.getByText("Frozen")).toBeTruthy();
  });

  it("UI-17: the choice is saved in a cookie the server reads on the next visit", () => {
    render(
      <ThemeProvider initial="default">
        <ThemeToggle />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Kiroween mode" }));
    expect(cookieValue(THEME_COOKIE)).toBe("kiroween");
    expect(parseTheme(cookieValue(THEME_COOKIE))).toBe("kiroween");
  });

  it("UI-17: a provider started from the saved theme renders it on the first render", () => {
    render(
      <ThemeProvider initial="kiroween">
        <ThemeToggle />
        <AgentsTable agents={[frozenAgent]} canUnfreeze />
      </ThemeProvider>,
    );
    expect(screen.getByRole<HTMLInputElement>("switch", { name: "Kiroween mode" }).checked).toBe(true);
    expect(screen.getByText("The Crypt")).toBeTruthy();
  });

  it("UI-16, UI-19: Kiroween adds a skull and a ghost to the status badges, hidden from screen readers and marked to stop under reduced motion", () => {
    const icons = (theme: "default" | "kiroween") => {
      const { container, unmount } = render(
        <ThemeProvider initial={theme}>
          <AgentsTable agents={[frozenAgent]} canUnfreeze />
        </ThemeProvider>,
      );
      const found = [...container.querySelectorAll("svg.av-float")];
      expect(found.every((svg) => svg.getAttribute("aria-hidden") === "true")).toBe(true);
      const count = found.length;
      unmount();
      return count;
    };
    expect(icons("default")).toBe(0);
    expect(icons("kiroween")).toBe(2);
  });

  it("UI-17: the cookie lasts a year, is sent only to this site, and is Secure on https", () => {
    const doc = { cookie: "", location: { protocol: "https:" }, documentElement: { dataset: {} as DOMStringMap } } as unknown as Document;
    saveTheme("kiroween", doc);
    expect(doc.cookie).toBe(`${THEME_COOKIE}=kiroween; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    expect(doc.documentElement.dataset.theme).toBe("kiroween");
  });
});

describe("parseTheme", () => {
  it("UI-17: anything but a known theme name falls back to the default theme", () => {
    expect(parseTheme("kiroween")).toBe("kiroween");
    expect(parseTheme("default")).toBe("default");
    for (const value of [undefined, "", "Kiroween", "kiroween ", "constructor", "__proto__", 1, null]) expect(parseTheme(value)).toBe("default");
  });
});

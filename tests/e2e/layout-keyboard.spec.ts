import { type Page, expect, test } from "@playwright/test";

/**
 * Layout and keyboard checks on every dashboard page (telemetry-dashboard
 * task 9): no horizontal scrolling from 375 px to 1920 px (UI-14), and a
 * keyboard user can reach every navigation link with a visible focus ring
 * (UI-13), in both themes. Signed out, so the pages show the sandbox.
 */

const PAGES = ["/", "/feed", "/approvals", "/agents", "/scenarios", "/audit", "/settings"];
const THEMES = ["default", "kiroween"] as const;
const NAV: readonly [string, string][] = [
  ["Overview", "/"],
  ["Live feed", "/feed"],
  ["Approvals", "/approvals"],
  ["Agents", "/agents"],
  ["Scenarios", "/scenarios"],
  ["Audit", "/audit"],
  ["Settings", "/settings"],
];

async function useTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.context().addCookies([{ name: "av-theme", value: theme, url: "http://localhost:3100" }]);
}

/** Wait until the page's data has loaded, so the check sees the real layout. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator("h1").first()).toBeVisible();
}

// Rows in the feed, agents, and audit tables, so their real width is checked. Drift holds
// nothing, so the inbox stays empty for sandbox-injection.spec.ts.
test.beforeAll(async ({ request }) => {
  const r = await request.post("/api/v1/scenarios/drift/run", { data: {}, headers: { origin: "http://localhost:3100" } });
  expect(r.status()).toBe(200);
});

for (const theme of THEMES) {
  for (const width of [375, 1920]) {
    test(`UI-14: no page scrolls sideways at ${width} px (${theme} theme)`, async ({ page }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1080 });
      const overflowing: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await settle(page);
        const { scroll, client, culprits } = await page.evaluate(() => {
          const client = document.documentElement.clientWidth;
          // Elements that stick out past the viewport while their parent doesn't, so a failure names what to fix.
          const sticksOut = (el: Element | null) => el !== null && el.getBoundingClientRect().right > client + 1;
          const outermost = [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => sticksOut(el) && !sticksOut(el.parentElement));
          const describe = (el: HTMLElement) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
          return { scroll: document.documentElement.scrollWidth, client, culprits: outermost.slice(0, 3).map(describe) };
        });
        if (scroll > client) overflowing.push(`${path}: ${scroll} > ${client}: ${culprits.join(" | ")}`);
      }
      expect(overflowing).toEqual([]);
    });
  }

  test(`UI-13: every navigation link is reachable by keyboard with a visible focus ring (${theme} theme)`, async ({ page }) => {
    await useTheme(page, theme);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await settle(page);
      const reached = new Set<string>();
      const unringed: string[] = [];
      for (let i = 0; i < 60 && reached.size < NAV.length; i += 1) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const style = getComputedStyle(el);
          const ring = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
          const href = el instanceof HTMLAnchorElement ? new URL(el.href).pathname : null;
          return { name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(), tag: el.tagName, ring, href };
        });
        if (!focused) continue;
        if (!focused.ring) unringed.push(`${focused.tag} ${focused.name}`);
        // Settings sits with the account controls (sidebar footer on desktop, header on mobile), so match any link.
        if (focused.href) for (const [label, path] of NAV) if (focused.href === path && focused.name.includes(label)) reached.add(label);
      }
      expect([...reached].sort(), `nav links reached at ${width} px`).toEqual(NAV.map(([label]) => label).sort());
      expect(unringed, `focused without a visible ring at ${width} px`).toEqual([]);
    }
  });
}

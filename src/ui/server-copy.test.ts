import { afterEach, describe, expect, it, vi } from "vitest";

let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "av-theme" && cookieValue !== undefined ? { name, value: cookieValue } : undefined) }),
}));
const { getCopy, getTheme } = await import("./server-copy");

afterEach(() => {
  cookieValue = undefined;
});

describe("getTheme", () => {
  it("UI-17: the server renders the theme saved in the cookie, so the first paint has it", async () => {
    cookieValue = "kiroween";
    expect(await getTheme()).toBe("kiroween");
    expect((await getCopy()).t("agents.frozen")).toBe("The Crypt");
  });

  it("UI-17: without the cookie, or with any other value, the server renders the default theme", async () => {
    expect(await getTheme()).toBe("default");
    for (const value of ["", "KIROWEEN", "dark", "kiroween;"]) {
      cookieValue = value;
      expect(await getTheme()).toBe("default");
    }
    expect((await getCopy()).t("agents.frozen")).toBe("Frozen");
  });
});

import { describe, expect, it } from "vitest";
import { REASON_CODES } from "@/core/policy";
import { copy, copyFor, reasonText } from "./copy";
import { THEMES } from "./theme";

describe("copy", () => {
  it("UI-6: every reason code has a plain-language sentence in every theme", () => {
    for (const theme of THEMES) {
      for (const code of REASON_CODES) {
        expect(copy[theme][code], `${theme} ${code}`).toMatch(/^(Denied|Held|Sealed)\b.*\.$/);
      }
    }
  });

  it("UI-15: no string is empty, and both themes have the same keys", () => {
    expect(Object.keys(copy.kiroween).sort()).toEqual(Object.keys(copy.default).sort());
    for (const theme of THEMES) for (const [key, value] of Object.entries(copy[theme])) expect(value.trim(), `${theme} ${key}`).not.toBe("");
  });

  it("UI-16: Kiroween copy calls frozen agents The Crypt and tainted sessions Haunted", () => {
    expect(copy.kiroween["agents.frozen"]).toBe("The Crypt");
    expect(copy.kiroween["agents.tainted"]).toBe("Haunted");
    expect(copy.default["agents.frozen"]).toBe("Frozen");
  });

  it("UI-6: an unknown reason code is shown as the code, not as a missing string or a prototype property", () => {
    for (const theme of THEMES) {
      expect(reasonText("SOMETHING_NEW", theme)).toBe("SOMETHING_NEW");
      expect(reasonText("constructor", theme)).toBe("constructor");
      expect(reasonText("__proto__", theme)).toBe("__proto__");
    }
    expect(reasonText("HELD_TAINTED", "default")).toContain("untrusted content");
  });

  it("UI-16: copyFor binds t and reasonText to one theme", () => {
    for (const theme of THEMES) {
      const bound = copyFor(theme);
      expect(bound.theme).toBe(theme);
      expect(bound.t("agents.frozen")).toBe(copy[theme]["agents.frozen"]);
      expect(bound.reasonText("HELD_TAINTED")).toBe(copy[theme].HELD_TAINTED);
    }
    expect(copyFor("kiroween").t("agents.frozen")).not.toBe(copyFor("default").t("agents.frozen"));
  });
});

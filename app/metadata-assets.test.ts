import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The layout loads fonts through next/font and the theme from a cookie; only its metadata is under test.
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font" });
  return { Inter: font, JetBrains_Mono: font, Creepster: font };
});
vi.mock("@/ui/server-copy", () => ({ getTheme: async () => "default" }));
const { metadata } = await import("./layout");

const file = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("link previews and icons", () => {
  it("UI-29: the social preview image is 1200 x 630, with alt text", () => {
    expect(pngSize(file("opengraph-image.png"))).toEqual({ width: 1200, height: 630 });
    expect(file("opengraph-image.alt.txt").toString("utf8").trim()).toMatch(/^AgentVault: .{20,}/);
  });

  it("UI-29: the Apple touch icon is 180 x 180", () => {
    expect(pngSize(file("apple-icon.png"))).toEqual({ width: 180, height: 180 });
  });

  it("UI-29: the tab icon has a lighter palette for a dark color scheme", () => {
    const svg = file("icon.svg").toString("utf8");
    const dark = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\s*\}\n/.exec(svg)?.[1] ?? "";
    for (const part of ["soft", "deep", "eyes"]) expect(dark, part).toMatch(new RegExp(`\\.${part} \\{ (fill|stroke): #[0-9a-f]{6}; \\}`));
  });

  it("UI-29: the layout describes the site for Open Graph and a large-image Twitter card", () => {
    expect(metadata.openGraph).toMatchObject({ title: "AgentVault", siteName: "AgentVault", type: "website" });
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", title: "AgentVault" });
  });
});

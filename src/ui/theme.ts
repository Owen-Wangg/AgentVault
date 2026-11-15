/**
 * Theme tokens (telemetry-dashboard design, "Theme system"). The values
 * here are the source of truth for the contrast check (UI-12); a test
 * checks that app/globals.css declares the same values.
 *
 * Kiroween's palette arrives with telemetry-dashboard task 8. Until then
 * it repeats the default values so every theme has every token.
 */

export const THEMES = ["default", "kiroween"] as const;
export type Theme = (typeof THEMES)[number];

export const TOKEN_NAMES = [
  "bg",
  "surface",
  "surface-muted",
  "border",
  "text",
  "text-muted",
  "accent",
  "accent-text",
  "allow",
  "hold",
  "deny",
  "focus",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export const TOKENS = {
  default: {
    bg: "#f8fafc",
    surface: "#ffffff",
    "surface-muted": "#f1f5f9",
    border: "#cbd5e1",
    text: "#0f172a",
    "text-muted": "#475569",
    accent: "#4338ca",
    "accent-text": "#ffffff",
    allow: "#166534",
    hold: "#92400e",
    deny: "#b91c1c",
    focus: "#4338ca",
  },
  kiroween: {
    bg: "#f8fafc",
    surface: "#ffffff",
    "surface-muted": "#f1f5f9",
    border: "#cbd5e1",
    text: "#0f172a",
    "text-muted": "#475569",
    accent: "#4338ca",
    "accent-text": "#ffffff",
    allow: "#166534",
    hold: "#92400e",
    deny: "#b91c1c",
    focus: "#4338ca",
  },
} satisfies Record<Theme, Record<TokenName, string>>;

/**
 * Foreground and background pairs the UI draws text or focus rings with.
 * Text needs 4.5:1 and focus indicators 3:1 (WCAG 2.2 AA, 1.4.3 and 1.4.11).
 */
export const CONTRAST_PAIRS: readonly { fg: TokenName; bg: TokenName; min: number }[] = [
  ...(["bg", "surface", "surface-muted"] as const).flatMap((bg) =>
    (["text", "text-muted", "accent", "allow", "hold", "deny"] as const).map((fg) => ({ fg, bg, min: 4.5 })),
  ),
  { fg: "accent-text", bg: "accent", min: 4.5 },
  { fg: "focus", bg: "bg", min: 3 },
  { fg: "focus", bg: "surface", min: 3 },
];

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb color: ${hex}`);
  const [r, g, b] = match.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

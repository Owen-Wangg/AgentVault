/**
 * Theme tokens (telemetry-dashboard design, "Theme system"). The values
 * here are the source of truth for the contrast check (UI-12); a test
 * checks that app/globals.css declares the same values.
 *
 * Kiroween (UI-16) is a dark theme. Only the colors, the heading font,
 * the copy, and a few decorations change (app/globals.css).
 */

export const THEMES = ["default", "kiroween"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "default";

/**
 * The browser keeps the choice in this cookie (UI-17), so the server
 * renders `data-theme` and the copy for it on the first paint. Only the
 * dashboard's rendering reads it. Nothing under src/core, src/server,
 * src/rails, src/agents, src/mcp, app/api, or app/vendor may (UI-18).
 */
export const THEME_COOKIE = "av-theme";

/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 31_536_000;

/** A cookie value is untrusted: anything but a known theme name is the default. */
export function parseTheme(value: unknown): Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value) ? (value as Theme) : DEFAULT_THEME;
}

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
  // Near-black, pumpkin orange accent, ghost-white text, toxic green for "allowed".
  kiroween: {
    bg: "#0d0b12",
    surface: "#17141f",
    "surface-muted": "#221d2d",
    border: "#4a4160",
    text: "#f3efe6",
    "text-muted": "#b9b0c9",
    accent: "#ff8c1a",
    "accent-text": "#120d05",
    allow: "#7fe35a",
    hold: "#f5c84b",
    deny: "#ff7a7a",
    focus: "#ff8c1a",
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

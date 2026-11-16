import { cookies } from "next/headers";
import { type Copy, copyFor } from "./copy";
import { THEME_COOKIE, type Theme, parseTheme } from "./theme";

/**
 * The visitor's theme and copy for server components (UI-16, UI-17).
 * Only layouts and pages call these; route handlers never do (UI-18).
 */
export async function getTheme(): Promise<Theme> {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value);
}

export async function getCopy(): Promise<Copy> {
  return copyFor(await getTheme());
}

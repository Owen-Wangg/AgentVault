"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import { type Copy, copyFor } from "./copy";
import { DEFAULT_THEME, THEME_COOKIE, THEME_COOKIE_MAX_AGE, type Theme } from "./theme";

/**
 * The visitor's theme for client components (UI-16, UI-17). The server
 * reads the theme cookie and passes it in as `initial`, so the first
 * paint already has the right colors and copy, and there's nothing for
 * a script to fix before paint.
 *
 * Changing the theme writes the cookie, sets `data-theme` on <html>,
 * re-renders client components from this context, and refreshes the
 * server components so their copy follows. It changes nothing else:
 * no request the dashboard sends depends on it (UI-18).
 */

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeState>({ theme: DEFAULT_THEME, setTheme: () => {} });

/** Writes the theme cookie. `Secure` on https, so it works on localhost too. */
export function saveTheme(theme: Theme, doc: Document = document): void {
  const secure = doc.location?.protocol === "https:" ? "; Secure" : "";
  doc.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  doc.documentElement.dataset.theme = theme;
}

export function ThemeProvider({ initial, children }: { initial: Theme; children: ReactNode }) {
  const [theme, setState] = useState<Theme>(initial);
  const router = useRouter();
  const setTheme = useCallback(
    (next: Theme) => {
      saveTheme(next);
      setState(next);
      router.refresh();
    },
    [router],
  );
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeState => useContext(ThemeContext);

/** `t` and `reasonText` bound to the visitor's theme. Outside a provider, the default theme. */
export const useCopy = (): Copy => copyFor(useContext(ThemeContext).theme);

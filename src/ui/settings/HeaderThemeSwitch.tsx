"use client";

import { Ghost } from "lucide-react";
import { cn } from "@/ui/components/primitives";
import { useCopy, useTheme } from "@/ui/ThemeProvider";

/**
 * The Kiroween mode switch in the workspace header (UI-24), so the theme
 * is one click away on every page. It calls the same `setTheme` as the
 * Settings switch (UI-16, UI-17); no request depends on it (UI-18).
 */
export function HeaderThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const { t } = useCopy();
  const on = theme === "kiroween";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setTheme(on ? "default" : "kiroween")}
      className={cn(
        "inline-flex min-h-10 items-center gap-2 rounded-card border px-3 text-sm font-medium",
        on ? "border-accent text-accent" : "border-control-border text-text hover:bg-surface-muted",
      )}
    >
      <Ghost aria-hidden="true" className={cn("size-4", on && "av-float")} />
      {t("header.kiroween")}
      <span aria-hidden="true" className={cn("relative h-5 w-9 shrink-0 rounded-full border", on ? "border-accent bg-accent" : "border-control-border bg-surface-muted")}>
        <span className={cn("absolute top-0.5 size-3.5 rounded-full", on ? "right-0.5 bg-accent-text" : "left-0.5 bg-control-border")} />
      </span>
    </button>
  );
}

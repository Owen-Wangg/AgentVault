"use client";

import { useId } from "react";
import { Card, CardTitle } from "@/ui/components/primitives";
import { useCopy, useTheme } from "@/ui/ThemeProvider";

/**
 * The Kiroween mode switch (UI-16, UI-17). A native checkbox with the
 * switch role, so it works with the keyboard and screen readers as is.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useCopy();
  const id = useId();
  const on = theme === "kiroween";
  return (
    <Card aria-labelledby={`${id}-title`}>
      <CardTitle>
        <span id={`${id}-title`}>{t("settings.appearance")}</span>
      </CardTitle>
      <div className="mt-3 flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={on}
          onChange={(e) => setTheme(e.target.checked ? "kiroween" : "default")}
          aria-describedby={`${id}-hint`}
          className="mt-1 size-5 shrink-0 accent-accent"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="font-medium">
            {t("settings.kiroween")}
          </label>
          <p id={`${id}-hint`} className="text-sm text-text-muted">
            {t("settings.kiroweenHint")}
          </p>
          <p role="status" aria-live="polite" className="text-sm">
            {on ? t("settings.on") : t("settings.off")}
          </p>
        </div>
      </div>
    </Card>
  );
}

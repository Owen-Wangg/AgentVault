"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCopy } from "@/ui/ThemeProvider";
import { cn } from "./primitives";

/** The link to /settings, shown with the account controls (UI-16). */
export function SettingsLink() {
  const { t } = useCopy();
  const current = usePathname() === "/settings";
  return (
    <Link
      href="/settings"
      aria-current={current ? "page" : undefined}
      className={cn("flex min-h-10 items-center gap-3 rounded-card px-2 text-sm", current ? "bg-surface-muted font-medium text-accent" : "text-text hover:bg-surface-muted")}
    >
      <Settings aria-hidden="true" className="size-4" />
      {t("nav.settings")}
    </Link>
  );
}

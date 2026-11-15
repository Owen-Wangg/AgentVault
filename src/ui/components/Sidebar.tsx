"use client";

import { Activity, Bot, FlaskConical, Inbox, LayoutDashboard, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { type UiKey, t } from "@/ui/copy";
import { cn } from "./primitives";

export const NAV_ITEMS: readonly { href: string; label: UiKey; icon: LucideIcon }[] = [
  { href: "/", label: "nav.overview", icon: LayoutDashboard },
  { href: "/feed", label: "nav.feed", icon: Activity },
  { href: "/agents", label: "nav.agents", icon: Bot },
  { href: "/approvals", label: "nav.approvals", icon: Inbox },
  { href: "/scenarios", label: "nav.scenarios", icon: FlaskConical },
];

export const isActive = (pathname: string, href: string): boolean => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

/**
 * Navigation: a left sidebar from the md breakpoint up, and a bar fixed to
 * the bottom of the screen below it, so every page is one tap away at
 * 375 px (UI-14). Plain links, so the keyboard order is the visual order
 * (UI-13).
 */
export function Sidebar({ footer }: { footer?: ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      <nav aria-label={t("nav.label")} className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <Link href="/" className="mb-6 px-2 text-lg font-semibold">
          {t("app.name")}
        </Link>
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive(pathname, href) ? "page" : undefined}
                className={cn(
                  "flex min-h-10 items-center gap-3 rounded-card px-2 text-sm",
                  isActive(pathname, href) ? "bg-surface-muted font-medium text-accent" : "text-text hover:bg-surface-muted",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {t(label)}
              </Link>
            </li>
          ))}
        </ul>
        {footer ? <div className="mt-auto pt-6">{footer}</div> : null}
      </nav>
      <nav aria-label={t("nav.label")} className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface md:hidden">
        <ul className="grid grid-cols-5">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive(pathname, href) ? "page" : undefined}
                className={cn("flex min-h-14 flex-col items-center justify-center gap-1 text-xs", isActive(pathname, href) ? "font-medium text-accent" : "text-text-muted")}
              >
                <Icon aria-hidden="true" className="size-5" />
                {t(label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

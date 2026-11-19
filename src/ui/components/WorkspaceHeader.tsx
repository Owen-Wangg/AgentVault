"use client";

import { FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { useCopy } from "@/ui/ThemeProvider";
import { HeaderThemeSwitch } from "@/ui/settings/HeaderThemeSwitch";
import { Badge } from "./primitives";

/**
 * The workspace name, with a visible "Sandbox" badge and the mock-rails
 * note when it's the public sandbox (UI-1, UI-21).
 */
export function WorkspaceHeader({ workspace, account }: { workspace: { name: string; isSandbox: boolean } | null; account?: ReactNode }) {
  const { t } = useCopy();
  return (
    <header className="mb-6 flex flex-col gap-3 border-b border-border pb-4">
      {/* UI-27: what AgentVault is, for a visitor arriving from anywhere. */}
      <p className="text-sm font-medium">{t("app.tagline")}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* The sandbox's stored name is a timestamp; people see a plain label, and the name stays in the tooltip. */}
          <span className="truncate text-sm text-text-muted" title={workspace?.name}>
            {workspace ? (workspace.isSandbox ? t("workspace.publicName") : workspace.name) : t("workspace.none")}
          </span>
          {workspace?.isSandbox ? (
            <Badge tone="hold">
              <FlaskConical aria-hidden="true" className="size-3" />
              {t("workspace.sandbox")}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <HeaderThemeSwitch />
          {account ? <div className="md:hidden">{account}</div> : null}
        </div>
      </div>
      {workspace?.isSandbox ? (
        <p className="rounded-card border border-hold bg-surface px-3 py-2 text-sm text-hold" role="note">
          {t("workspace.sandboxNote")}
        </p>
      ) : null}
    </header>
  );
}

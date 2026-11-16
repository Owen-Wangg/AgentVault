import type { ReactNode } from "react";
import { Sidebar } from "@/ui/components/Sidebar";
import { WorkspaceHeader } from "@/ui/components/WorkspaceHeader";
import { SettingsLink } from "@/ui/components/SettingsLink";
import { getCopy } from "@/ui/server-copy";
import { AccountPanel } from "./account-panel";
import { getDashboardContext } from "./dashboard-context";

// Every dashboard page depends on the session and the current sandbox.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [context, { t }] = await Promise.all([getDashboardContext(), getCopy()]);
  // Settings sits with the account controls: the sidebar's footer on desktop, the header on mobile,
  // so the six-item navigation bar keeps its width at 375 px.
  const account = (
    <div className="flex flex-col gap-3">
      <SettingsLink />
      <AccountPanel context={context} />
    </div>
  );
  return (
    <div className="flex min-h-screen">
      <a href="#content" className="sr-only z-20 rounded-card bg-surface p-2 focus:not-sr-only focus:fixed focus:left-2 focus:top-2">
        {t("skip.content")}
      </a>
      <Sidebar footer={account} />
      {/* Bottom padding keeps content clear of the mobile navigation bar. */}
      <main id="content" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8">
        <div className="mx-auto max-w-6xl">
          <WorkspaceHeader workspace={context.workspace && { name: context.workspace.name, isSandbox: context.workspace.isSandbox }} account={account} />
          {children}
        </div>
      </main>
    </div>
  );
}

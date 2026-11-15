import type { ReactNode } from "react";
import { Sidebar } from "@/ui/components/Sidebar";
import { t } from "@/ui/copy";

export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen">
      <a href="#content" className="sr-only z-20 rounded-card bg-surface p-2 focus:not-sr-only focus:fixed focus:left-2 focus:top-2">
        {t("skip.content")}
      </a>
      <Sidebar />
      {/* Bottom padding keeps content clear of the mobile navigation bar. */}
      <main id="content" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

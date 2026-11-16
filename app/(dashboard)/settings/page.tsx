import type { Metadata } from "next";
import { PageTitle } from "@/ui/components/primitives";
import { getCopy } from "@/ui/server-copy";
import { ThemeToggle } from "@/ui/settings/ThemeToggle";

export const metadata: Metadata = { title: "Settings" };

/** Settings (telemetry-dashboard design, "Pages"): the Kiroween mode switch. */
export default async function SettingsPage() {
  const { t } = await getCopy();
  return (
    <>
      <PageTitle>{t("settings.title")}</PageTitle>
      <ThemeToggle />
    </>
  );
}

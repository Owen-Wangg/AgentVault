import { PageTitle } from "@/ui/components/primitives";
import { t } from "@/ui/copy";

// The overview's KPIs and charts arrive with telemetry-dashboard task 4.
export default function OverviewPage() {
  return (
    <>
      <PageTitle>{t("overview.title")}</PageTitle>
      <p className="text-text-muted">{t("app.tagline")}</p>
    </>
  );
}

import { LogIn, LogOut } from "lucide-react";
import { signIn, signOut } from "@/server/auth/auth";
import type { DashboardContext } from "@/server/dashboard/context";
import { Button } from "@/ui/components/primitives";
import { getCopy } from "@/ui/server-copy";

/**
 * Sign in with GitHub or sign out (UI-2). Server actions: Next.js checks
 * that their Origin matches the host, so another site can't submit them.
 */
export async function AccountPanel({ context }: { context: DashboardContext }) {
  const { t } = await getCopy();
  if (context.user) {
    return (
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
        className="flex flex-col gap-2 text-sm"
      >
        <p className="text-text-muted">
          {t("auth.signedInAs")} <span className="font-medium text-text">{context.user.name ?? context.user.id}</span>
        </p>
        <Button type="submit" variant="secondary">
          <LogOut aria-hidden="true" className="size-4" />
          {t("auth.signOut")}
        </Button>
      </form>
    );
  }
  if (!context.signInAvailable) return <p className="text-xs text-text-muted">{t("auth.notConfigured")}</p>;
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github", { redirectTo: "/" });
      }}
    >
      <Button type="submit" className="w-full">
        <LogIn aria-hidden="true" className="size-4" />
        {t("auth.signIn")}
      </Button>
    </form>
  );
}

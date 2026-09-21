import { redirect } from "next/navigation";
import { getCurrentManager } from "@/lib/current-manager";
import { AppShell } from "@/components/nav/AppShell";
import type { CurrentManagerSummary } from "@/lib/auth/types";

/**
 * Wraps every authenticated page in the nav chrome. src/middleware.ts is
 * what actually keeps a logged-out browser from reaching these routes at
 * all, but this redirect is a cheap second check at the layout level - if a
 * manager row is ever deactivated mid-session, or the session cookie fails
 * to resolve to a real manager for any other reason, this catches it too
 * rather than rendering the shell around nothing.
 */
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const manager = await getCurrentManager();
  if (!manager) {
    redirect("/login");
  }

  const currentManager: CurrentManagerSummary = {
    id: manager.id,
    name: manager.name,
    role: manager.isCommissioner ? "commissioner" : "manager",
  };

  return <AppShell currentManager={currentManager}>{children}</AppShell>;
}

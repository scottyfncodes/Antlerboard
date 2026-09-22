import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { ManagerPinsPanel } from "@/components/commissioner/ManagerPinsPanel";

export const dynamic = "force-dynamic";

export default async function ManagerPinsPage() {
  const manager = await getCurrentManager();

  if (!manager?.isCommissioner) {
    return (
      <div className="space-y-4">
        <PageHeader title="Manager PINs" />
        <EmptyState title="Commissioner access required" subtitle="You're not signed in as the league commissioner." />
      </div>
    );
  }

  const [managers, credentials] = await Promise.all([
    prisma.manager.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.managerCredential.findMany({ where: { provider: "pin" } }),
  ]);
  const managerIdsWithPin = new Set(credentials.map((c) => c.managerId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manager PINs"
        subtitle="Generate or reset the 4-digit PINs each manager uses to sign in. PINs are shown here once, right after you generate them - never again."
      />
      <ManagerPinsPanel
        managers={managers.map((m) => ({
          id: m.id,
          name: m.name,
          role: m.isCommissioner ? "commissioner" : "manager",
          hasPin: managerIdsWithPin.has(m.id),
        }))}
      />
    </div>
  );
}

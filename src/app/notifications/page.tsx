import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { timeAgo } from "@/lib/format";
import Link from "next/link";
import { MarkAllReadButton } from "@/components/notifications/MarkAllReadButton";
import clsx from "clsx";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const manager = await getCurrentManager();
  if (!manager) {
    return <EmptyState title="No manager found" subtitle="Seed the database to get started." />;
  }

  const notifications = await prisma.notification.findMany({
    where: { managerId: manager.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notification Center"
        subtitle={`Everything sent to ${manager.name}.`}
        actions={<MarkAllReadButton />}
      />
      {notifications.length === 0 ? (
        <EmptyState title="No notifications yet" subtitle="Turn on the alerts you care about in Settings." />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border overflow-hidden">
          {notifications.map((n) => (
            <li key={n.id} className={clsx(!n.read && "bg-antler-dim/10")}>
              <Link href={n.link ?? "/notifications"} className="block px-4 py-3 hover:bg-surface-raised">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{n.title}</p>
                    <p className="text-sm text-muted mt-0.5">{n.body}</p>
                  </div>
                  <span className="text-xs text-muted whitespace-nowrap">{timeAgo(n.createdAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { getCurrentManager } from "@/lib/current-manager";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AuditLogPage() {
  const manager = await getCurrentManager();
  if (!manager?.isCommissioner) {
    return (
      <div className="space-y-4">
        <PageHeader title="Audit Log" />
        <EmptyState title="Commissioner access required" subtitle="Switch to the commissioner from the Commissioner Mode page." />
      </div>
    );
  }

  const entries = await prisma.auditLogEntry.findMany({ orderBy: { createdAt: "desc" }, take: 100 });

  return (
    <div className="space-y-4">
      <PageHeader title="Audit Log" subtitle="Every commissioner action and historical correction, in order." />
      {entries.length === 0 ? (
        <EmptyState title="No commissioner actions recorded yet" />
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <Card key={e.id} className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  {e.action} <span className="text-muted font-normal">on {e.entityType}</span>
                </p>
                <p className="text-xs text-muted">by {e.actorName}</p>
              </div>
              <div className="flex items-center gap-2">
                {e.isHistoricalCorrection && <Badge variant="yellow">Historical Correction</Badge>}
                <span className="text-xs text-muted">{timeAgo(e.createdAt)}</span>
              </div>
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

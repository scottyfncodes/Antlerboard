import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { YahooControls } from "@/components/commissioner/YahooControls";
import { isYahooConfigured } from "@/lib/yahoo/client";
import { timeAgo } from "@/lib/format";
import { getCurrentManager } from "@/lib/current-manager";

export const dynamic = "force-dynamic";

export default async function YahooSettingsPage() {
  const manager = await getCurrentManager();
  if (!manager?.isCommissioner) {
    return (
      <div className="space-y-4">
        <PageHeader title="Yahoo Integration" />
        <EmptyState title="Commissioner access required" subtitle="You're not signed in as the league commissioner." />
      </div>
    );
  }

  const connection = await prisma.yahooConnection.findFirst();
  const syncLogs = connection
    ? await prisma.syncLog.findMany({ where: { connectionId: connection.id }, orderBy: { startedAt: "desc" }, take: 10 })
    : [];

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader
        title="Yahoo Integration"
        subtitle="Yahoo stays the source of truth for rosters, standings, and transactions. Antlerboard layers keeper history, tags, trades, and DPUD on top - a sync never touches those."
      />

      {!isYahooConfigured() && (
        <div className="rounded-lg border border-yellow/40 bg-yellow/10 px-4 py-3 text-sm text-yellow">
          Yahoo OAuth isn&apos;t configured in this environment (missing YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET /
          YAHOO_REDIRECT_URI). Set those in your Vercel project&apos;s environment variables to enable this.
        </div>
      )}

      <Card>
        <h2 className="font-display text-lg mb-3">Connection</h2>
        <YahooControls connected={!!connection?.accessToken} selectedLeagueKey={connection?.yahooLeagueKey ?? null} />
      </Card>

      <Card>
        <h2 className="font-display text-lg mb-3">Sync Status</h2>
        <div className="space-y-1.5 text-sm">
          <p>
            Status:{" "}
            <Badge variant={connection?.lastSyncStatus === "SUCCESS" ? "green" : connection?.lastSyncStatus === "FAILED" ? "red" : "default"}>
              {(connection?.lastSyncStatus ?? "NEVER_RUN").replace("_", " ")}
            </Badge>
          </p>
          <p className="text-muted">
            Last attempt: {connection?.lastSyncAttemptAt ? timeAgo(connection.lastSyncAttemptAt) : "never"}
          </p>
          <p className="text-muted">
            Last success: {connection?.lastSyncSuccessAt ? timeAgo(connection.lastSyncSuccessAt) : "never"}
          </p>
          {connection?.lastSyncError && <p className="text-red">{connection.lastSyncError}</p>}
          {connection?.lastSyncRecordCount !== null && connection?.lastSyncRecordCount !== undefined && (
            <p className="text-muted">Records updated last run: {connection.lastSyncRecordCount}</p>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="font-display text-lg mb-3">Sync Log</h2>
        {syncLogs.length === 0 ? (
          <p className="text-sm text-muted">No syncs have run yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {syncLogs.map((log) => (
              <li key={log.id} className="flex items-center justify-between">
                <span>
                  <Badge variant={log.status === "SUCCESS" ? "green" : log.status === "FAILED" ? "red" : "default"}>
                    {log.status}
                  </Badge>{" "}
                  {log.recordsUpdated} records
                </span>
                <span className="text-xs text-muted">{timeAgo(log.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

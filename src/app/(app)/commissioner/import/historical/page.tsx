import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { HistoricalImportWizard } from "@/components/commissioner/HistoricalImportWizard";
import { LeagueHistoryImportWizard } from "@/components/commissioner/LeagueHistoryImportWizard";
import { FypdBatchPromoter } from "@/components/commissioner/FypdBatchPromoter";
import { getCurrentManager } from "@/lib/current-manager";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function HistoricalImportPage() {
  const manager = await getCurrentManager();
  if (!manager?.isCommissioner) {
    return (
      <div className="space-y-4">
        <PageHeader title="Import League History" />
        <EmptyState title="Commissioner access required" subtitle="You're not signed in as the league commissioner." />
      </div>
    );
  }

  const pendingBatches = await prisma.fypdImportBatch.findMany({
    where: { status: "PENDING_REVIEW" },
    orderBy: { seasonYear: "asc" },
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Import League History"
        subtitle="Upload the C&A historical workbook. Preview → review flags → confirm import → commit - nothing is written until you confirm."
      />
      <section className="space-y-3">
        <h2 className="font-display text-lg">Step 1 · Team names, trades, prop bets, FYPD boards</h2>
        <HistoricalImportWizard />
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-lg">Step 2 · Keeper history (every player, every season)</h2>
        <p className="text-sm text-muted">
          Needs the master workbook plus two exports: the canonical auction history and the Yahoo transaction log.
          Run Step 1 first so team names resolve to the right franchise.
        </p>
        <LeagueHistoryImportWizard />
      </section>
      <FypdBatchPromoter
        initialBatches={pendingBatches.map((b) => ({
          id: b.id,
          label: b.label,
          sourceSheet: b.sourceSheet,
          seasonYear: b.seasonYear,
          pickCount: Array.isArray(b.rawPicks) ? b.rawPicks.length : 0,
          notes: b.notes,
        }))}
      />
    </div>
  );
}

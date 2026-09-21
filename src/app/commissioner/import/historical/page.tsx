import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { HistoricalImportWizard } from "@/components/commissioner/HistoricalImportWizard";
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
        <EmptyState title="Commissioner access required" subtitle="Switch to the commissioner from the Commissioner Mode page." />
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
      <HistoricalImportWizard />
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

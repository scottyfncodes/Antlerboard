import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { HistoricalImportWizard } from "@/components/commissioner/HistoricalImportWizard";
import { getCurrentManager } from "@/lib/current-manager";

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

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import League History"
        subtitle="Upload the C&A historical workbook. Preview → review flags → confirm import → commit - nothing is written until you confirm."
      />
      <HistoricalImportWizard />
    </div>
  );
}

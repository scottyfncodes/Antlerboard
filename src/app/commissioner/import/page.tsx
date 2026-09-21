import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { ImportWizard } from "@/components/commissioner/ImportWizard";
import { getCurrentManager } from "@/lib/current-manager";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const manager = await getCurrentManager();
  if (!manager?.isCommissioner) {
    return (
      <div className="space-y-4">
        <PageHeader title="Import Historical Data" />
        <EmptyState title="Commissioner access required" subtitle="Switch to the commissioner from the Commissioner Mode page." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import Historical Data"
        subtitle="Upload a CSV of acquisitions/keeper history. Nothing is overwritten silently - conflicts are flagged for you to confirm."
      />
      <ImportWizard />
    </div>
  );
}

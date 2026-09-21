import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { ImportWizard } from "@/components/commissioner/ImportWizard";
import { getCurrentManager } from "@/lib/current-manager";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const manager = await getCurrentManager();
  if (!manager?.isCommissioner) {
    return (
      <div className="space-y-4">
        <PageHeader title="Import Historical Data" />
        <EmptyState title="Commissioner access required" subtitle="You're not signed in as the league commissioner." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import Historical Data"
        subtitle="Upload a CSV of acquisitions/keeper history. Nothing is overwritten silently - conflicts are flagged for you to confirm."
        actions={
          <Link href="/commissioner/import/historical" className="text-sm text-antler hover:text-antler-strong">
            Import full league history (.xlsx) &rarr;
          </Link>
        }
      />
      <ImportWizard />
    </div>
  );
}

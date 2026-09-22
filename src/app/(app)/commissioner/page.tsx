import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { TeamEditor } from "@/components/commissioner/TeamEditor";
import { SeasonEditor } from "@/components/commissioner/SeasonEditor";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CommissionerPage() {
  const manager = await getCurrentManager();

  const [teams, managers, seasons] = await Promise.all([
    prisma.team.findMany({ include: { manager: true }, orderBy: { name: "asc" } }),
    prisma.manager.findMany({ orderBy: { name: "asc" } }),
    prisma.season.findMany({ orderBy: { year: "desc" } }),
  ]);

  if (!manager?.isCommissioner) {
    return (
      <div className="space-y-4">
        <PageHeader title="Commissioner Mode" />
        <EmptyState
          title="Commissioner access required"
          subtitle={`You're signed in as ${manager?.name ?? "an unrecognized manager"}, who isn't the league commissioner. Ask the commissioner if you need something changed here.`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Commissioner Mode" subtitle="League administration, historical corrections, and data management." />

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Link href="/commissioner/pins" className="rounded-xl border border-border bg-surface p-4 hover:border-antler-dim">
          <p className="font-display text-lg">Manager PINs</p>
          <p className="text-sm text-muted mt-1">Generate or reset sign-in PINs.</p>
        </Link>
        <Link href="/commissioner/yahoo" className="rounded-xl border border-border bg-surface p-4 hover:border-antler-dim">
          <p className="font-display text-lg">Yahoo Integration</p>
          <p className="text-sm text-muted mt-1">Connect, select league, sync now.</p>
        </Link>
        <Link href="/commissioner/import" className="rounded-xl border border-border bg-surface p-4 hover:border-antler-dim">
          <p className="font-display text-lg">Import Data</p>
          <p className="text-sm text-muted mt-1">CSV import for historical/keeper data.</p>
        </Link>
        <Link href="/commissioner/audit-log" className="rounded-xl border border-border bg-surface p-4 hover:border-antler-dim">
          <p className="font-display text-lg">Audit Log</p>
          <p className="text-sm text-muted mt-1">Every historical correction, tracked.</p>
        </Link>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Teams & Managers</h2>
        <TeamEditor teams={teams} managers={managers} />
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Seasons</h2>
        <SeasonEditor
          seasons={seasons.map((s) => ({
            id: s.id,
            year: s.year,
            status: s.status,
            keeperDeadline: s.keeperDeadline?.toISOString() ?? null,
            draftDate: s.draftDate?.toISOString() ?? null,
          }))}
        />
      </section>
    </div>
  );
}

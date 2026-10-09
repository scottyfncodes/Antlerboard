import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Card";
import { TeamView, parseTeamTab } from "@/components/team/TeamView";

export const dynamic = "force-dynamic";

export default async function MyTeamPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const [manager, sp] = await Promise.all([getCurrentManager(), searchParams]);
  const team = manager?.teams?.[0];

  if (!manager || !team) {
    return (
      <div className="space-y-4">
        <PageHeader title="My Team" subtitle="Your personal command center." />
        <EmptyState
          title="No team on this browser yet"
          subtitle="Switch to your manager from Commissioner Mode, or ask the commissioner to set one up."
        />
      </div>
    );
  }

  return <TeamView teamId={team.id} tab={parseTeamTab(sp.tab)} basePath="/my-team" isMine viewer={manager} />;
}

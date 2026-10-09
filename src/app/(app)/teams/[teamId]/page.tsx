import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { TeamView, parseTeamTab } from "@/components/team/TeamView";

export const dynamic = "force-dynamic";

export default async function TeamDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ teamId }, sp, manager] = await Promise.all([params, searchParams, getCurrentManager()]);

  const exists = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
  if (!exists) notFound();

  // Your own team always opens as My Team, like tapping your team in Yahoo.
  if (manager?.teams?.some((t) => t.id === teamId)) {
    redirect(sp.tab ? `/my-team?tab=${encodeURIComponent(sp.tab)}` : "/my-team");
  }

  return <TeamView teamId={teamId} tab={parseTeamTab(sp.tab)} basePath={`/teams/${teamId}`} isMine={false} viewer={manager} />;
}

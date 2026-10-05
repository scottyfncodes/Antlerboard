import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { FypdSelectionControls } from "@/components/fypd/FypdSelectionControls";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * DPUD ("Don't Pick Up, Dummy") is derived, not maintained: every FYPD
 * pick whose call-up hasn't been exercised is a prospect somebody owns,
 * whatever Yahoo's waiver wire says. This mirrors the DPUD sheet in the
 * league's workbook - alphabetical, with the pick number and owner - so
 * nobody has to keep a second list by hand.
 */
export default async function DpudPage() {
  const manager = await getCurrentManager();
  const isCommissioner = !!manager?.isCommissioner;

  const owned = await prisma.fypdSelection.findMany({
    where: { callUpExercised: false },
    orderBy: [{ player: { name: "asc" } }],
    include: { player: true, team: { include: { manager: true } }, draft: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="DPUD"
        subtitle={`Don’t Pick Up, Dummy. ${owned.length} prospects are owned through FYPD call-up rights. They may show as available on Yahoo’s waiver wire, but they’re off limits to everyone but the manager who drafted them. A player drops off this list the moment their call-up is recorded.`}
      />

      {owned.length === 0 ? (
        <EmptyState
          title="Nothing on the DPUD list right now"
          subtitle="Players appear here automatically once an FYPD draft has picks whose call-ups haven't been exercised."
        />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-raised text-left text-xs text-muted">
                <th className="px-2 py-2 font-medium">Player</th>
                <th className="px-2 py-2 font-medium">Owner</th>
                <th className="px-2 py-2 font-medium hide-xs">FYPD</th>
                {isCommissioner && <th className="px-2 py-2 font-medium"></th>}
              </tr>
            </thead>
            <tbody>
              {owned.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-2 py-2">
                    <Link href={`/players/${s.playerId}`} className="font-medium hover:text-antler-strong">
                      {s.player.name}
                    </Link>
                    {s.player.positions.length > 0 && <span className="text-muted ml-1 text-xs hide-xs">{s.player.positions.join("/")}</span>}
                    {s.isDpud && <span className="text-antler ml-1 text-xs">· on Yahoo waivers</span>}
                  </td>
                  <td className="px-2 py-2">
                    <Link href={`/teams/${s.teamId}`} className="hover:text-antler-strong">
                      {s.team.manager.name}
                    </Link>
                    <span className="text-muted ml-1 text-xs hide-xs">{s.team.name}</span>
                  </td>
                  <td className="px-2 py-2 hide-xs text-muted tabular">
                    {s.draft.year} · pick {s.overallPick}
                  </td>
                  {isCommissioner && (
                    <td className="px-2 py-2">
                      <FypdSelectionControls draftId={s.draftId} selectionId={s.id} isDpud={s.isDpud} callUpExercised={s.callUpExercised} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Card>
        <p className="text-sm text-muted">
          Commissioners record a call-up from the FYPD board or here. That marks the pick exercised, starts the
          player&apos;s keeper clock (free this season, $5 to keep next year), and removes them from this list.
        </p>
      </Card>
    </div>
  );
}

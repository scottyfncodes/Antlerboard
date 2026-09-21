import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { CreateFypdDraftForm } from "@/components/fypd/CreateFypdDraftForm";
import { FypdDraftControls, FypdMakeSelection } from "@/components/fypd/FypdDraftControls";
import { FypdSelectionControls } from "@/components/fypd/FypdSelectionControls";
import { getTeamOnClock, buildSnakeSequence } from "@/lib/fypd-snake-engine";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function FypdPage() {
  const manager = await getCurrentManager();
  const isCommissioner = !!manager?.isCommissioner;
  const league = await prisma.league.findFirst();
  if (!league) {
    return (
      <div className="space-y-4">
        <PageHeader title="FYPD" />
        <EmptyState title="No league configured" />
      </div>
    );
  }

  const draft = await prisma.fypdDraft.findFirst({
    where: { leagueId: league.id },
    orderBy: { year: "desc" },
    include: {
      order: { orderBy: { slot: "asc" }, include: { team: true } },
      selections: { orderBy: { overallPick: "asc" }, include: { team: true, player: true } },
    },
  });

  if (!draft) {
    const lastSeason = await prisma.season.findFirst({
      where: { leagueId: league.id, standings: { some: {} } },
      orderBy: { year: "desc" },
      include: {
        standings: { orderBy: { rank: "asc" }, include: { team: true } },
      },
    });
    const allStandings = lastSeason?.standings ?? [];
    const bottomFourTeams = allStandings
      .filter((s) => s.rank !== null && s.rank >= 9)
      .map((s) => ({ id: s.teamId, name: s.team.name, rank: s.rank! }));
    // C&A's documented FYPD order rule (see src/lib/fypd-order-engine.ts) is
    // specifically for a 12-team league (8 playoff + 4 non-playoff). Only
    // offer draft creation when that's actually what the standings show -
    // showing a partial/wrong-sized dropdown would silently misrepresent
    // the rule rather than surfacing the mismatch.
    const teamCountMismatch = allStandings.length > 0 && allStandings.length !== 12;

    return (
      <div className="space-y-6">
        <PageHeader
          title="FYPD"
          subtitle="First-Year Player Draft - C&A's snake draft of U.S. MLB draftees. A completely separate system from the regular auction draft."
        />
        <Card>
          <h2 className="font-display text-lg mb-3">No FYPD draft set up yet</h2>
          {teamCountMismatch ? (
            <p className="text-sm text-muted">
              C&amp;A&apos;s FYPD order rule (9th Brigade + reverse standings) is defined for a 12-team league, but{" "}
              {lastSeason?.year} has {allStandings.length} teams recorded. Confirm the league&apos;s actual team count
              before an FYPD draft can be created.
            </p>
          ) : isCommissioner ? (
            <CreateFypdDraftForm bottomFourTeams={bottomFourTeams} nextYear={(lastSeason?.year ?? new Date().getFullYear()) + 1} />
          ) : (
            <p className="text-sm text-muted">The commissioner hasn&apos;t created this year&apos;s FYPD draft yet.</p>
          )}
        </Card>
      </div>
    );
  }

  const orderTeamIds = draft.order.map((o) => o.teamId);
  const totalPicks = orderTeamIds.length * draft.rounds;
  const onTheClockTeamId =
    draft.status === "IN_PROGRESS" && draft.currentOverallPick <= totalPicks
      ? getTeamOnClock(orderTeamIds, draft.currentOverallPick)
      : null;
  const onTheClockTeam = draft.order.find((o) => o.teamId === onTheClockTeamId)?.team;

  const sequence = buildSnakeSequence(orderTeamIds, draft.rounds);
  const teamById = new Map(draft.order.map((o) => [o.teamId, o.team]));
  const selectionByPick = new Map(draft.selections.map((s) => [s.overallPick, s]));

  const availablePlayers = await prisma.player.findMany({
    where: {
      leagueId: league.id,
      mlbDraftYear: { not: null },
      fypdSelections: { none: { draftId: draft.id } },
    },
    orderBy: { name: "asc" },
    take: 300,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${draft.year} FYPD`}
        subtitle="Snake draft of U.S. MLB draftees. Drafting a player grants call-up rights, not an active roster spot - see the DPUD tab for what that means once Yahoo is connected."
        actions={<Badge variant={draft.status === "COMPLETE" ? "green" : draft.status === "PAUSED" ? "yellow" : "default"}>{draft.status.replace("_", " ")}</Badge>}
      />

      {isCommissioner && (
        <Card>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <FypdDraftControls draftId={draft.id} status={draft.status} />
          </div>
          {draft.status === "IN_PROGRESS" && (
            <div className="mt-3">
              <FypdMakeSelection draftId={draft.id} availablePlayers={availablePlayers} />
            </div>
          )}
        </Card>
      )}

      {onTheClockTeam && (
        <Card>
          <p className="text-sm text-muted">On the clock</p>
          <p className="font-display text-xl">{onTheClockTeam.name}</p>
        </Card>
      )}

      <section>
        <h2 className="font-display text-lg mb-3">Draft Order</h2>
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-raised text-left text-xs text-muted">
                <th className="px-2 py-2 font-medium">Slot</th>
                <th className="px-2 py-2 font-medium">Team</th>
                <th className="px-2 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {draft.order.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="px-2 py-2 tabular">{o.slot}</td>
                  <td className="px-2 py-2">
                    <Link href={`/teams/${o.teamId}`} className="hover:text-antler-strong">
                      {o.team.name}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-muted">{o.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Board</h2>
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-raised text-left text-xs text-muted">
                <th className="px-2 py-2 font-medium">Pick</th>
                <th className="px-2 py-2 font-medium hide-xs">Team</th>
                <th className="px-2 py-2 font-medium">Player</th>
                <th className="px-2 py-2 font-medium hide-xs">Call-Up</th>
                {isCommissioner && <th className="px-2 py-2 font-medium"></th>}
              </tr>
            </thead>
            <tbody>
              {sequence.map((slot) => {
                const selection = selectionByPick.get(slot.overallPick);
                const team = teamById.get(slot.teamId);
                return (
                  <tr key={slot.overallPick} className="border-t border-border">
                    <td className="px-2 py-2 tabular text-muted">
                      {slot.round}.{String(slot.pickInRound).padStart(2, "0")}
                    </td>
                    <td className="px-2 py-2 hide-xs">{team?.name}</td>
                    <td className="px-2 py-2">
                      {selection ? (
                        <Link href={`/players/${selection.playerId}`} className="hover:text-antler-strong font-medium">
                          {selection.player.name}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 hide-xs text-muted">
                      {selection?.callUpExercised
                        ? "Called up"
                        : selection?.isDpud
                          ? <Badge variant="antler">DPUD</Badge>
                          : selection
                            ? "Pending"
                            : ""}
                    </td>
                    {isCommissioner && (
                      <td className="px-2 py-2">
                        {selection && (
                          <FypdSelectionControls
                            draftId={draft.id}
                            selectionId={selection.id}
                            isDpud={selection.isDpud}
                            callUpExercised={selection.callUpExercised}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { FypdSelectionControls } from "@/components/fypd/FypdSelectionControls";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DpudPage() {
  const manager = await getCurrentManager();
  const isCommissioner = !!manager?.isCommissioner;

  const dpudSelections = await prisma.fypdSelection.findMany({
    where: { isDpud: true, callUpExercised: false },
    orderBy: { updatedAt: "desc" },
    include: { player: true, team: true, draft: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="DPUD"
        subtitle={
          'Don’t Pick Up, Dummy. These players may show as available on Yahoo’s waiver wire, but they’re already owned in C&A through FYPD call-up rights - off limits to the rest of the league. Yahoo availability and C&A ownership are separate things; a player can be both "Yahoo waiver available" and "DPUD" at the same time.'
        }
      />

      {dpudSelections.length === 0 ? (
        <EmptyState
          title="Nothing on the DPUD list right now"
          subtitle="Players appear here when a commissioner flags an FYPD selection as DPUD (Yahoo-available, but already owned via FYPD). Once Yahoo sync exists, this will happen automatically."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {dpudSelections.map((s) => (
            <Card key={s.id} className="flex items-center justify-between">
              <div>
                <Link href={`/players/${s.playerId}`} className="font-medium hover:text-antler-strong">
                  {s.player.name}
                </Link>
                <p className="text-xs text-muted">
                  FYPD rights: {s.team.name} ({s.draft.year})
                  {s.callUpYear ? ` · Call-up eligible ${s.callUpYear}` : ""}
                </p>
              </div>
              {isCommissioner && (
                <FypdSelectionControls
                  draftId={s.draftId}
                  selectionId={s.id}
                  isDpud={s.isDpud}
                  callUpExercised={s.callUpExercised}
                />
              )}
            </Card>
          ))}
        </div>
      )}

      <Card>
        <h2 className="font-display text-lg mb-2">Looking for the prop-bet game?</h2>
        <p className="text-sm text-muted">
          That used to live here under the same name. It moved to{" "}
          <Link href="/prop-bets" className="text-antler hover:text-antler-strong">
            Prop Bets
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}

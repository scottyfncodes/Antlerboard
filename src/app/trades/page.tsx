import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge, PlayerTagBadge } from "@/components/ui/Badge";
import { TradeActions } from "@/components/trades/TradeActions";
import { OfferActions } from "@/components/trades/OfferActions";
import { PLAYER_TAG_LABEL, timeAgo } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function TradesPage() {
  const manager = await getCurrentManager();
  const myTeamId = manager?.teams?.[0]?.id;

  const [trades, offers, mmoPlayers] = await Promise.all([
    prisma.trade.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        teamA: true,
        teamB: true,
        proposer: true,
        assets: { include: { player: true } },
      },
    }),
    prisma.offer.findMany({
      orderBy: { createdAt: "desc" },
      include: { sendingTeam: true, receivingTeam: true, targetPlayer: true },
    }),
    prisma.playerTag.findMany({
      where: { tag: "MAKE_ME_AN_OFFER" },
      include: { player: true, team: true },
    }),
  ]);

  const live = trades.filter((t) => t.status === "PROPOSED" || t.status === "COUNTERED");
  const history = trades.filter((t) => t.status === "ACCEPTED" || t.status === "REJECTED" || t.status === "WITHDRAWN");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Trade Center"
        subtitle="Propose, counter, and track trades. Antlerboard records the C&A-side agreement - Yahoo roster moves still happen in Yahoo."
        actions={
          <Link href="/trades/new" className="rounded-md bg-antler px-3 py-2 text-sm font-medium text-[#1a1305] hover:bg-antler-strong">
            Propose a Trade
          </Link>
        }
      />

      <section>
        <h2 className="font-display text-lg mb-3">Live Proposals</h2>
        {live.length === 0 ? (
          <EmptyState title="No open proposals" />
        ) : (
          <div className="space-y-3">
            {live.map((t) => {
              const canRespond = !!myTeamId && (t.teamAId === myTeamId || t.teamBId === myTeamId) && t.proposerId !== manager?.id;
              const canWithdraw = t.proposerId === manager?.id;
              return (
                <Card key={t.id}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <p className="font-medium">
                        {t.teamA.name} &harr; {t.teamB.name}
                      </p>
                      <p className="text-xs text-muted mt-0.5">
                        Proposed by {t.proposer.name} · {timeAgo(t.createdAt)}
                      </p>
                      <ul className="mt-2 text-sm space-y-0.5">
                        {t.assets.map((a) => (
                          <li key={a.id}>
                            {a.player?.name ?? a.draftPickDescription} &rarr;{" "}
                            {a.toTeamId === t.teamAId ? t.teamA.name : t.teamB.name}
                          </li>
                        ))}
                      </ul>
                      {t.notes && <p className="text-sm text-muted mt-2 italic">&ldquo;{t.notes}&rdquo;</p>}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant={t.status === "COUNTERED" ? "yellow" : "default"}>{t.status}</Badge>
                      <TradeActions tradeId={t.id} canRespond={canRespond} canWithdraw={canWithdraw && !canRespond} />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Make Me an Offer</h2>
        <p className="text-sm text-muted mb-3">Players whose managers explicitly want offers.</p>
        {mmoPlayers.length === 0 ? (
          <EmptyState title="No one is asking for offers right now" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {mmoPlayers.map((mmo) => (
              <Card key={mmo.id} className="flex items-center justify-between">
                <div>
                  <Link href={`/players/${mmo.playerId}`} className="font-medium hover:text-antler-strong">
                    {mmo.player.name}
                  </Link>
                  <p className="text-xs text-muted">{mmo.team.name}</p>
                </div>
                <PlayerTagBadge tag="MAKE_ME_AN_OFFER" label={PLAYER_TAG_LABEL.MAKE_ME_AN_OFFER} />
              </Card>
            ))}
          </div>
        )}

        <h3 className="font-display text-base mb-2">Offers</h3>
        {offers.length === 0 ? (
          <EmptyState title="No offers yet" />
        ) : (
          <div className="space-y-3">
            {offers.map((o) => {
              const canRespond = o.receivingTeamId === myTeamId && o.status === "PENDING";
              const canWithdraw = o.sendingTeamId === myTeamId && o.status === "PENDING";
              return (
                <Card key={o.id}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <p className="font-medium">
                        {o.sendingTeam.name} &rarr; {o.receivingTeam.name}
                        {o.targetPlayer && <span className="text-muted"> re: {o.targetPlayer.name}</span>}
                      </p>
                      {o.message && <p className="text-sm text-muted mt-1 italic">&ldquo;{o.message}&rdquo;</p>}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge
                        variant={o.status === "ACCEPTED" ? "green" : o.status === "REJECTED" ? "red" : "default"}
                      >
                        {o.status}
                      </Badge>
                      <OfferActions offerId={o.id} canRespond={canRespond} canWithdraw={canWithdraw} />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Trade History</h2>
        {history.length === 0 ? (
          <EmptyState title="No completed trades yet" />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {history.map((t) => (
              <li key={t.id} className="px-4 py-3 flex items-center justify-between text-sm">
                <span>
                  {t.teamA.name} &harr; {t.teamB.name}
                </span>
                <Badge variant={t.status === "ACCEPTED" ? "green" : "default"}>{t.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

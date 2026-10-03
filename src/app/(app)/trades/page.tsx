import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { isOfferParty, offerActionDenial, visibleOffersWhere, visibleTradesWhere } from "@/lib/trade-access";
import { tradeTitle } from "@/lib/trades";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge, PlayerTagBadge } from "@/components/ui/Badge";
import { TradeCard } from "@/components/trades/TradeCard";
import { OfferActions } from "@/components/trades/OfferActions";
import { PLAYER_TAG_LABEL } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function TradesPage() {
  const manager = await getCurrentManager();

  const [trades, offers, openToDiscussPlayers] = await Promise.all([
    prisma.trade.findMany({
      where: visibleTradesWhere(manager),
      orderBy: { updatedAt: "desc" },
      include: {
        participants: { include: { team: true } },
        proposer: true,
        assets: { include: { player: true } },
      },
    }),
    prisma.offer.findMany({
      where: visibleOffersWhere(manager),
      orderBy: { createdAt: "desc" },
      include: { sendingTeam: true, receivingTeam: true, targetPlayer: true },
    }),
    prisma.playerTag.findMany({
      where: { tag: "OPEN_TO_DISCUSS" },
      include: { player: true, team: true },
    }),
  ]);

  // A COUNTERED trade has been replaced by its counter-offer, so it's history.
  const live = trades.filter((t) => t.status === "PROPOSED");
  const history = trades.filter((t) => t.status !== "PROPOSED");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Trade Center"
        subtitle="Propose, counter, and track trades - with one team or up to three at once. Your negotiations are private to the teams in them - nobody else, commissioner included, sees them until a deal is accepted."
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
            {live.map((t) => (
              <TradeCard key={t.id} trade={t} viewer={manager} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Open to Discuss</h2>
        <p className="text-sm text-muted mb-3">
          Players their managers are willing to talk trades about - not a marketplace, just a starting point for a
          real conversation. Reach out to the manager before sending an offer.
        </p>
        {openToDiscussPlayers.length === 0 ? (
          <EmptyState title="No one has flagged a player for discussion right now" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {openToDiscussPlayers.map((otd) => (
              <Card key={otd.id} className="flex items-center justify-between">
                <div>
                  <Link href={`/players/${otd.playerId}`} className="font-medium hover:text-antler-strong">
                    {otd.player.name}
                  </Link>
                  <p className="text-xs text-muted">{otd.team.name}</p>
                  {otd.note && <p className="text-xs text-muted italic mt-0.5">&ldquo;{otd.note}&rdquo;</p>}
                </div>
                <PlayerTagBadge tag="OPEN_TO_DISCUSS" label={PLAYER_TAG_LABEL.OPEN_TO_DISCUSS} />
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
              const canRespond = !!manager && !offerActionDenial(o, manager, "accept");
              const canWithdraw = !!manager && !offerActionDenial(o, manager, "withdraw");
              return (
                <Card key={o.id}>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <p className="font-medium">
                        {o.sendingTeam.name} &rarr; {o.receivingTeam.name}
                        {o.targetPlayer && <span className="text-muted"> re: {o.targetPlayer.name}</span>}
                      </p>
                      {o.message && isOfferParty(o, manager) && <p className="text-sm text-muted mt-1 italic">&ldquo;{o.message}&rdquo;</p>}
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
                <span className="min-w-0 truncate">{tradeTitle(t.participants)}</span>
                <Badge variant={t.status === "ACCEPTED" ? "green" : "default"}>{t.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

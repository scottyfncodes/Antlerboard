import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { getCurrentManager } from "@/lib/current-manager";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { PlayerTagBadge } from "@/components/ui/Badge";
import { KeeperYearBadge } from "@/components/keepers/KeeperYearBadge";
import { MyPlayerTagControl } from "@/components/my-team/MyPlayerTagControl";
import { formatCost, formatDate, PLAYER_TAG_LABEL } from "@/lib/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MyTeamPage() {
  const manager = await getCurrentManager();
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

  const [season, roster, tags] = await Promise.all([
    prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } }),
    prisma.keeperRecord.findMany({
      where: { seasonYear: CURRENT_SEASON_YEAR, teamId: team.id },
      include: { player: true },
      orderBy: [{ keeperYear: "desc" }, { player: { name: "asc" } }],
    }),
    prisma.playerTag.findMany({ where: { teamId: team.id } }),
  ]);

  const tagByPlayer = new Map(tags.map((t) => [t.playerId, t]));
  const expiring = roster.filter((r) => r.keeperYear >= 4);
  const tagged = roster.filter((r) => tagByPlayer.has(r.playerId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Team"
        subtitle={`${team.name} — your roster, keeper clocks, and tags in one place.`}
      />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <p className="text-xs text-muted">Rostered</p>
          <p className="font-display text-2xl mt-1 tabular">{roster.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Keeper Slots Used</p>
          <p className="font-display text-2xl mt-1 tabular">{roster.filter((r) => r.keeperYear >= 1).length}/10</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Year 4-5 Alerts</p>
          <p className="font-display text-2xl mt-1 tabular">{expiring.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Keeper Deadline</p>
          <p className="text-sm mt-1">{season?.keeperDeadline ? formatDate(season.keeperDeadline) : "Not set"}</p>
        </Card>
      </section>

      {expiring.length > 0 && (
        <section>
          <h2 className="font-display text-lg mb-3">Needs Your Attention</h2>
          <div className="space-y-2">
            {expiring.map((r) => (
              <Card key={r.id} className="flex items-center justify-between">
                <Link href={`/players/${r.playerId}`} className="font-medium hover:text-antler-strong">
                  {r.player.name}
                </Link>
                <KeeperYearBadge keeperYear={r.keeperYear} status={r.status} />
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-lg">Roster</h2>
          <Link href={`/teams/${team.id}`} className="text-xs text-antler hover:text-antler-strong">
            Full team page &rarr;
          </Link>
        </div>
        {roster.length === 0 ? (
          <EmptyState title="No players rostered yet" />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-raised text-left text-xs text-muted">
                  <th className="px-2 py-2 font-medium">Player</th>
                  <th className="px-2 py-2 font-medium hide-xs">Pos</th>
                  <th className="px-2 py-2 font-medium">Cost</th>
                  <th className="px-2 py-2 font-medium">Keeper Year</th>
                  <th className="px-2 py-2 font-medium">Tag</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-2 py-2">
                      <Link href={`/players/${r.playerId}`} className="hover:text-antler-strong font-medium">
                        {r.player.name}
                      </Link>
                      <span className="text-muted ml-1 text-xs hide-xs">{r.player.mlbTeam}</span>
                    </td>
                    <td className="px-2 py-2 hide-xs text-muted">{r.player.positions.join("/")}</td>
                    <td className="px-2 py-2 tabular">{formatCost(r.keeperCost)}</td>
                    <td className="px-2 py-2">
                      <KeeperYearBadge keeperYear={r.keeperYear} status={r.status} />
                    </td>
                    <td className="px-2 py-2">
                      <MyPlayerTagControl playerId={r.playerId} currentTag={tagByPlayer.get(r.playerId)?.tag ?? null} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Your Tagged Players</h2>
        {tagged.length === 0 ? (
          <EmptyState
            title="Nothing tagged yet"
            subtitle="Tag a player above to flag them as Keeping, Available, or Open to Discuss - visible in the Player Market and Trade Center."
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {tagged.map((r) => {
              const tag = tagByPlayer.get(r.playerId)!;
              return (
                <Card key={r.id} className="flex items-center justify-between">
                  <Link href={`/players/${r.playerId}`} className="font-medium hover:text-antler-strong">
                    {r.player.name}
                  </Link>
                  <PlayerTagBadge tag={tag.tag} label={PLAYER_TAG_LABEL[tag.tag]} />
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

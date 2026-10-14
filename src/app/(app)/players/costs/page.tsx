import { prisma } from "@/lib/db";
import { CURRENT_SEASON_YEAR, MAX_CONSECUTIVE_KEEPER_YEARS } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { UrlFilterBar } from "@/components/ui/UrlFilterBar";
import { PlayersTabs } from "@/components/players/PlayersTabs";
import { listCostSeasons, loadPlayerCostRows } from "@/lib/player-costs-data";
import { costLabel, filterPlayerCostRows, paginate, UNAVAILABLE, type CostValue, type PlayerCostRow } from "@/lib/player-costs";
import { formatDate } from "@/lib/format";
import Link from "next/link";
import clsx from "clsx";

export const dynamic = "force-dynamic";

const POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"];

/**
 * What each player cost, one season at a time, with the four cost facts
 * kept apart: auction price, acquisition cost + method, keeper cost, and
 * keeper year. Anything not on record reads "Unavailable" - never $0, and
 * never borrowed from another season or the current roster (see
 * src/lib/player-costs.ts). Read-only.
 */
export default async function PlayerCostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const league = await prisma.league.findFirst({ select: { id: true } });
  if (!league) {
    return (
      <div className="space-y-4">
        <PageHeader title="Players" />
        <EmptyState title="No league configured" />
      </div>
    );
  }

  const seasons = await listCostSeasons(league.id, CURRENT_SEASON_YEAR);
  const requested = Number(sp.season);
  const season = seasons.includes(requested) ? requested : CURRENT_SEASON_YEAR;

  const [rows, teams] = await Promise.all([
    loadPlayerCostRows(league.id, season, CURRENT_SEASON_YEAR),
    prisma.team.findMany({ where: { leagueId: league.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const withCost = rows.filter((r) => r.hasRecordedCost).length;
  const cost = sp.cost === "recorded" || sp.cost === "missing" ? sp.cost : undefined;
  const filtered = filterPlayerCostRows(rows, { teamId: sp.team, position: sp.position, q: sp.q, cost });
  const page = paginate(filtered, Number(sp.page ?? 1));

  const hrefWith = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v) next.set(k, v);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    return `/players/costs?${next.toString()}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Players"
        subtitle="What each player cost, season by season. Auction price, acquisition cost, and keeper cost are separate facts - anything not on record reads Unavailable."
      />
      <PlayersTabs active="costs" />

      {seasons.length > 1 && (
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:px-0">
          <div className="flex w-max gap-1.5">
            {seasons.map((y) => (
              <Link
                key={y}
                href={hrefWith({ season: String(y), page: null })}
                aria-current={y === season ? "page" : undefined}
                className={clsx(
                  "rounded-full px-3 py-1.5 text-sm border tabular",
                  y === season ? "bg-antler border-antler text-[#1a1305] font-medium" : "border-border text-muted hover:text-foreground"
                )}
              >
                {y}
              </Link>
            ))}
          </div>
        </div>
      )}

      <Card className="space-y-1">
        <p className="text-sm">
          <span className="font-semibold tabular">{rows.length}</span> players in {season}
          {" · "}
          <span className="font-semibold tabular">{withCost}</span> with a recorded cost
          {" · "}
          <span className="font-semibold tabular">{rows.length - withCost}</span> with none
        </p>
        {withCost === 0 && (
          <p className="text-sm text-yellow">
            No auction prices, acquisition costs, or keeper costs are stored for {season} yet. They arrive through Commissioner › Import ›
            League History; until then every cost reads Unavailable.
          </p>
        )}
        {season === CURRENT_SEASON_YEAR ? (
          <p className="text-xs text-muted">{season} lists everyone on a roster today plus anyone with a {season} cost record.</p>
        ) : (
          <p className="text-xs text-muted">Past seasons list only players with a cost record for that season - today&apos;s rosters are never used to fill in history.</p>
        )}
      </Card>

      <UrlFilterBar
        searchPlaceholder="Search player or MLB team…"
        preserve={["season"]}
        selects={[
          { param: "team", label: "Team", allLabel: "All teams", options: teams.map((t) => ({ value: t.id, label: t.name })) },
          { param: "position", label: "Position", allLabel: "All positions", options: POSITIONS.map((p) => ({ value: p, label: p })) },
          {
            param: "cost",
            label: "Cost on record",
            allLabel: "Any cost status",
            options: [
              { value: "recorded", label: "Has a recorded cost" },
              { value: "missing", label: "No cost on record" },
            ],
          },
        ]}
      />

      {page.total === 0 ? (
        <EmptyState title={rows.length === 0 ? `No players on record for ${season}` : "No players match those filters"} />
      ) : (
        <>
          <p className="text-xs text-muted">
            {page.total} player{page.total === 1 ? "" : "s"}
            {page.pageCount > 1 && ` · page ${page.page} of ${page.pageCount}`}
          </p>
          <ul className="grid gap-2 md:grid-cols-2">
            {page.items.map((row) => (
              <CostCard key={row.player.id} row={row} />
            ))}
          </ul>
          {page.pageCount > 1 && (
            <nav className="flex items-center justify-between gap-2 text-sm" aria-label="Pagination">
              {page.page > 1 ? (
                <Link href={hrefWith({ page: String(page.page - 1) })} className="rounded-md border border-border px-3 py-2 hover:border-antler-dim">
                  &larr; Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted tabular">
                {page.page} / {page.pageCount}
              </span>
              {page.page < page.pageCount ? (
                <Link href={hrefWith({ page: String(page.page + 1) })} className="rounded-md border border-border px-3 py-2 hover:border-antler-dim">
                  Next &rarr;
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}

function CostText({ value }: { value: CostValue }) {
  const reason = value.status === "recorded" ? value.note : value.reason;
  return (
    <span title={reason} className={clsx("tabular", value.status === "recorded" ? "font-semibold text-foreground" : "text-muted")}>
      {costLabel(value)}
    </span>
  );
}

/** The why behind an Unavailable/Carried/free value - spelled out, since phones have no hover. */
function CostReason({ value }: { value: CostValue }) {
  const reason = value.status === "recorded" ? value.note : value.reason;
  if (!reason) return null;
  return <span className="block text-[11px] leading-snug text-muted">{reason}</span>;
}

function CurrentStatusChip({ row }: { row: PlayerCostRow }) {
  const s = row.currentStatus;
  if (s.kind === "team") return <Badge variant="antler" className="max-w-[10rem] truncate">{s.team.name}</Badge>;
  if (s.kind === "free-agent") return <Badge>Free agent</Badge>;
  return <Badge>Unknown</Badge>;
}

function CostCard({ row }: { row: PlayerCostRow }) {
  const { player, keeper } = row;
  return (
    <li className="rounded-xl border border-border bg-surface px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/players/${player.id}`} className="block truncate text-[15px] font-semibold leading-tight hover:text-antler-strong">
            {player.name}
          </Link>
          <p className="truncate text-xs text-muted">{[player.mlbTeam, player.positions.join(", ")].filter(Boolean).join(" · ") || "—"}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted">Now</span>
          <CurrentStatusChip row={row} />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted">{row.season} team</dt>
        <dd className="min-w-0">
          {row.seasonTeams.length === 0 ? (
            <span className="text-muted">Unknown</span>
          ) : (
            row.seasonTeams.map((t, i) => (
              <span key={t.id}>
                {i > 0 && <span className="text-muted"> → </span>}
                <Link href={`/teams/${t.id}`} className="hover:text-antler-strong">
                  {t.name}
                </Link>
              </span>
            ))
          )}
        </dd>

        <dt className="text-muted">Auction price</dt>
        <dd className="min-w-0">
          {row.auction.length === 0 ? (
            <span className="text-muted">{UNAVAILABLE}</span>
          ) : (
            row.auction.map((a) => (
              <span key={a.key} className="block">
                <CostText value={a.cost} />
                <span className="text-xs text-muted"> · nom. #{a.overallPick}</span>
                <CostReason value={a.cost} />
              </span>
            ))
          )}
        </dd>

        <dt className="text-muted">Acquired</dt>
        <dd className="min-w-0">
          {row.acquisitions.length === 0 ? (
            <span className="text-muted">{UNAVAILABLE}</span>
          ) : (
            row.acquisitions.map((a) => (
              <span key={a.key} className="block">
                <span>{a.methodLabel}</span>
                <span className="text-muted"> · </span>
                <CostText value={a.cost} />
                <span className="text-xs text-muted">
                  {" "}
                  · {a.team.name} · {formatDate(a.date)}
                </span>
                <CostReason value={a.cost} />
              </span>
            ))
          )}
        </dd>

        <dt className="text-muted">Keeper cost</dt>
        <dd className="min-w-0">
          {keeper ? (
            <>
              <CostText value={keeper.cost} />
              {keeper.cost.status === "recorded" && (
                <Badge variant={keeper.cost.basis === "calculated" ? "blue" : "green"} className="ml-1.5">
                  {keeper.cost.basis === "calculated" ? "Calculated" : "Recorded"}
                </Badge>
              )}
              <CostReason value={keeper.cost} />
            </>
          ) : (
            <span className="text-muted">{UNAVAILABLE}</span>
          )}
        </dd>

        <dt className="text-muted">Keeper year</dt>
        <dd className="min-w-0">
          {keeper ? (
            <span>
              <span className="tabular">{keeper.keeperYear === 0 ? "New this season" : `Year ${keeper.keeperYear} of ${MAX_CONSECUTIVE_KEEPER_YEARS}`}</span>
              <span className="text-xs text-muted"> · {keeper.statusLabel}</span>
            </span>
          ) : (
            <span className="text-muted">{UNAVAILABLE}</span>
          )}
        </dd>
      </dl>

      {row.flags.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-yellow">
          {row.flags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

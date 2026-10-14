import { prisma } from "@/lib/db";
import { LeagueHeader } from "@/components/league/LeagueHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { UrlFilterBar } from "@/components/ui/UrlFilterBar";
import { CompletenessBadge, completenessCount } from "@/components/draft/CompletenessBadge";
import { listDraftSeasons, loadDraftHistory } from "@/lib/draft-history-data";
import { filterDraftPicks, isInferredOrder, type DraftHistoryPick, type DraftKind } from "@/lib/draft-history";
import { formatCost } from "@/lib/format";
import Link from "next/link";
import clsx from "clsx";

export const dynamic = "force-dynamic";

/**
 * Every draft on record, one season and one draft type at a time: the live
 * auction (DraftPick) and the FYPD snake draft. Read-only. Completeness is
 * computed from the picks actually stored (see src/lib/draft-history.ts),
 * so a season or draft marked COMPLETE over partial data still reads as
 * Incomplete here.
 */
export default async function DraftHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const league = await prisma.league.findFirst({ select: { id: true } });
  if (!league) {
    return (
      <div className="space-y-4">
        <LeagueHeader active="history" />
        <EmptyState title="No league configured" />
      </div>
    );
  }

  const [seasons, teams] = await Promise.all([
    listDraftSeasons(league.id),
    prisma.team.findMany({ where: { leagueId: league.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  if (seasons.length === 0) {
    return (
      <div className="space-y-4">
        <LeagueHeader active="history" />
        <EmptyState title="No drafts on record" subtitle="Auction results and FYPD drafts will appear here once they're stored." />
      </div>
    );
  }

  const hasData = (s: (typeof seasons)[number]) => s.auction.status !== "none" || (s.fypd !== null && s.fypd.status !== "none");
  const requestedYear = Number(sp.season);
  const summary = seasons.find((s) => s.year === requestedYear) ?? seasons.find(hasData) ?? seasons[0];
  const kind: DraftKind =
    sp.type === "fypd" || sp.type === "auction"
      ? sp.type
      : summary.auction.status === "none" && summary.fypd && summary.fypd.status !== "none"
        ? "fypd"
        : "auction";

  const history = await loadDraftHistory(league.id, summary.year, kind);
  const picks = filterDraftPicks(history.picks, { teamId: sp.team, q: sp.q });
  const filtered = !!(sp.team || sp.q);
  const isAuction = kind === "auction";

  const hrefFor = (year: number, type?: DraftKind) => {
    const next = new URLSearchParams();
    next.set("season", String(year));
    if (type) next.set("type", type);
    if (sp.team) next.set("team", sp.team);
    if (sp.q) next.set("q", sp.q);
    return `/history/drafts?${next.toString()}`;
  };

  return (
    <div className="space-y-5">
      <LeagueHeader
        active="history"
        description="Every draft on record, season by season: the live auction and the FYPD snake draft. Counts come from the picks actually stored, so gaps are flagged instead of hidden."
      />
      <Link href="/history" className="inline-block text-sm text-antler hover:text-antler-strong">
        &larr; History
      </Link>

      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:px-0">
        <div className="flex w-max gap-1.5" role="list" aria-label="Season">
          {seasons.map((s) => (
            <Link
              key={s.year}
              role="listitem"
              href={hrefFor(s.year)}
              aria-current={s.year === summary.year ? "page" : undefined}
              className={clsx(
                "rounded-full px-3 py-1.5 text-sm border tabular",
                s.year === summary.year
                  ? "bg-antler border-antler text-[#1a1305] font-medium"
                  : hasData(s)
                    ? "border-border text-foreground hover:border-antler-dim"
                    : "border-border text-muted hover:text-foreground"
              )}
            >
              {s.year}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Draft type">
        {(["auction", "fypd"] as const).map((type) => {
          const c = type === "auction" ? summary.auction : summary.fypd;
          const selected = type === kind;
          return (
            <Link
              key={type}
              role="tab"
              aria-selected={selected}
              href={hrefFor(summary.year, type)}
              className={clsx(
                "rounded-xl border px-3 py-2.5 transition-colors",
                selected ? "border-antler bg-antler-dim/20" : "border-border bg-surface hover:border-antler-dim"
              )}
            >
              <span className="block text-sm font-semibold">{type === "auction" ? "Auction" : "FYPD"}</span>
              <span className="block text-xs text-muted tabular">
                {c ? `${completenessCount(c)} · ${c.status === "none" ? "no data" : c.status === "complete" ? "complete" : c.status === "incomplete" ? "incomplete" : "unverified"}` : "No draft stored"}
              </span>
            </Link>
          );
        })}
      </div>

      <Card className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-display text-lg">
            {summary.year} {isAuction ? "Auction" : "FYPD"}
          </h2>
          <CompletenessBadge completeness={history.completeness} />
        </div>
        <p className="text-sm text-muted">{history.completeness.note}</p>
        {history.notes.length > 0 && (
          <ul className="space-y-1 text-sm text-yellow">
            {history.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">
          {isAuction ? (
            <>
              Pick numbers are nomination order where the source recorded it, never a draft slot - no slots are owned or traded.{" "}
              <Link href={`/history/draft/${summary.year}`} className="text-antler hover:text-antler-strong">
                Draft day details &rarr;
              </Link>
            </>
          ) : (
            "Original slot comes from the stored round-1 order and the snake order. It's shown only where the pick number can be trusted - otherwise it reads Unknown."
          )}
        </p>
      </Card>

      {history.picks.length > 0 && (
        <UrlFilterBar
          searchPlaceholder="Search player or team…"
          selects={[{ param: "team", label: "Team", allLabel: "All teams", options: teams.map((t) => ({ value: t.id, label: t.name })) }]}
          preserve={["season", "type"]}
        />
      )}

      {history.picks.length === 0 ? (
        <EmptyState
          title={isAuction ? `No ${summary.year} auction results stored` : `No ${summary.year} FYPD selections stored`}
          subtitle={isAuction ? "Auction prices arrive through Commissioner › Import › League History." : undefined}
        />
      ) : picks.length === 0 ? (
        <EmptyState title="No picks match those filters" />
      ) : (
        <>
          {filtered && (
            <p className="text-xs text-muted">
              Showing {picks.length} of {history.picks.length} recorded picks.
            </p>
          )}
          <PickCards picks={picks} isAuction={isAuction} />
          <PickTable picks={picks} isAuction={isAuction} />
        </>
      )}
    </div>
  );
}

function pickLabel(p: DraftHistoryPick) {
  return `${p.round}.${String(p.pickInRound).padStart(2, "0")}`;
}

function OriginalSlotValue({ pick }: { pick: DraftHistoryPick }) {
  const slot = pick.originalSlot;
  if (slot.status === "known") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Link href={`/teams/${slot.team.id}`} className="hover:text-antler-strong">
          {slot.team.name}
        </Link>
        {slot.differsFromSelector && (
          <Badge variant="yellow">Not the selector</Badge>
        )}
      </span>
    );
  }
  return (
    <span className="text-muted" title={slot.reason}>
      Unknown
    </span>
  );
}

function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-yellow">
      {flags.map((f) => (
        <li key={f}>{f}</li>
      ))}
    </ul>
  );
}

/** Phone layout: one card per pick, everything readable without sideways scrolling. */
function PickCards({ picks, isAuction }: { picks: DraftHistoryPick[]; isAuction: boolean }) {
  return (
    <ol className="space-y-2 md:hidden">
      {picks.map((p) => (
        <li key={p.key} className="rounded-xl border border-border bg-surface px-3 py-3">
          <div className="flex items-start gap-3">
            <div className="w-12 shrink-0 text-center">
              <p className="font-display text-lg leading-none tabular">#{p.overallPick}</p>
              <p className="mt-1 text-[11px] text-muted tabular">{isAuction ? (isInferredOrder(p.order) ? "Row" : "Nom.") : `Rd ${pickLabel(p)}`}</p>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                {p.player ? (
                  <Link href={`/players/${p.player.id}`} className="font-semibold leading-tight hover:text-antler-strong">
                    {p.player.name}
                  </Link>
                ) : (
                  <span className="text-muted">Player not recorded</span>
                )}
                {isAuction && <span className="shrink-0 font-semibold tabular">{p.cost === null ? <span className="text-muted text-sm font-normal">Unavailable</span> : formatCost(p.cost)}</span>}
              </div>
              {p.player && (
                <p className="text-xs text-muted">{[p.player.mlbTeam, p.player.positions.join(", ")].filter(Boolean).join(" · ") || "—"}</p>
              )}
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">{isAuction ? "Won by" : "Selected by"}</dt>
                <dd className="min-w-0">
                  <Link href={`/teams/${p.team.id}`} className="hover:text-antler-strong">
                    {p.team.name}
                  </Link>
                  {p.isKeeperSlot && <Badge className="ml-1.5">Keeper slot</Badge>}
                </dd>
                {!isAuction && (
                  <>
                    <dt className="text-muted">Original slot</dt>
                    <dd className="min-w-0">
                      <OriginalSlotValue pick={p} />
                    </dd>
                  </>
                )}
              </dl>
              <Flags flags={p.flags.filter((f) => !(isAuction && f === "Price not recorded."))} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Desktop layout: a dense, scannable table. */
function PickTable({ picks, isAuction }: { picks: DraftHistoryPick[]; isAuction: boolean }) {
  const inferred = picks.filter((p) => isInferredOrder(p.order)).length;
  const numberHeader = !isAuction ? "Pick" : inferred === 0 ? "Nom." : inferred === picks.length ? "Row" : "#";
  return (
    <div className="hidden md:block rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-raised text-left text-xs text-muted">
            <th className="px-3 py-2 font-medium w-16">{numberHeader}</th>
            {!isAuction && <th className="px-3 py-2 font-medium w-16">Rd.Pk</th>}
            <th className="px-3 py-2 font-medium">Player</th>
            <th className="px-3 py-2 font-medium">{isAuction ? "Won by" : "Selected by"}</th>
            {!isAuction && <th className="px-3 py-2 font-medium">Original slot</th>}
            {isAuction && <th className="px-3 py-2 font-medium text-right">Price</th>}
          </tr>
        </thead>
        <tbody>
          {picks.map((p) => (
            <tr key={p.key} className="border-t border-border align-top">
              <td className="px-3 py-2 tabular text-muted">
                #{p.overallPick}
                {isAuction && isInferredOrder(p.order) && inferred !== picks.length && <span className="block text-[10px]">row order</span>}
              </td>
              {!isAuction && <td className="px-3 py-2 tabular text-muted">{pickLabel(p)}</td>}
              <td className="px-3 py-2">
                {p.player ? (
                  <>
                    <Link href={`/players/${p.player.id}`} className="font-medium hover:text-antler-strong">
                      {p.player.name}
                    </Link>
                    <span className="ml-1.5 text-xs text-muted">{[p.player.mlbTeam, p.player.positions.join(", ")].filter(Boolean).join(" · ")}</span>
                  </>
                ) : (
                  <span className="text-muted">Player not recorded</span>
                )}
                <Flags flags={p.flags.filter((f) => !(isAuction && f === "Price not recorded."))} />
              </td>
              <td className="px-3 py-2">
                <Link href={`/teams/${p.team.id}`} className="hover:text-antler-strong">
                  {p.team.name}
                </Link>
                {p.isKeeperSlot && <Badge className="ml-1.5">Keeper slot</Badge>}
              </td>
              {!isAuction && (
                <td className="px-3 py-2">
                  <OriginalSlotValue pick={p} />
                </td>
              )}
              {isAuction && <td className="px-3 py-2 text-right tabular">{p.cost === null ? <span className="text-muted">Unavailable</span> : formatCost(p.cost)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

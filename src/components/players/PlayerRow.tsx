import Link from "next/link";
import clsx from "clsx";
import { Avatar } from "@/components/ui/Avatar";
import { MAX_CONSECUTIVE_KEEPER_YEARS } from "@/lib/config";
import { formatCost } from "@/lib/format";

/**
 * The compact keeper-clock chip used in dense player rows ("Y3/5"), where
 * the full KeeperYearBadge wording would wrap at phone width.
 */
export function KeeperClockChip({ keeperYear, status }: { keeperYear: number; status?: string }) {
  const forced = status === "FORCED_BACK" || keeperYear > MAX_CONSECUTIVE_KEEPER_YEARS;
  const label = keeperYear === 0 ? "NEW" : forced ? "FORCED" : `Y${keeperYear}/${MAX_CONSECUTIVE_KEEPER_YEARS}`;
  const tone =
    forced || keeperYear === MAX_CONSECUTIVE_KEEPER_YEARS
      ? "bg-red/15 text-red border-red/40"
      : keeperYear === MAX_CONSECUTIVE_KEEPER_YEARS - 1
        ? "bg-yellow/15 text-yellow border-yellow/40"
        : keeperYear === 0
          ? "bg-blue/10 text-blue border-blue/30"
          : "bg-surface-raised text-muted border-border";
  return (
    <span
      title={keeperYear === 0 ? "Acquired this season" : `Keeper year ${keeperYear} of ${MAX_CONSECUTIVE_KEEPER_YEARS}`}
      className={clsx("inline-flex min-w-[3.25rem] justify-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular", tone)}
    >
      {label}
    </span>
  );
}

/**
 * One player, laid out like a Yahoo Fantasy roster row: avatar, bold name,
 * a muted "TEAM · POS" line underneath, and the keeper facts right-aligned.
 * `trailing` is for anything page-specific (a tag badge, the tag picker).
 */
export function PlayerRow({
  player,
  keeperYear,
  keeperStatus,
  cost,
  meta,
  trailing,
}: {
  player: { id: string; name: string; mlbTeam: string | null; positions: string[] };
  keeperYear?: number;
  keeperStatus?: string;
  cost?: number | null;
  /** Extra muted text appended to the TEAM · POS line (e.g. the owning team). */
  meta?: string;
  trailing?: React.ReactNode;
}) {
  const subline = [player.mlbTeam, player.positions.join(", "), meta].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Avatar name={player.name} />
      <div className="min-w-0 flex-1">
        <Link href={`/players/${player.id}`} className="block truncate text-[15px] font-semibold leading-tight hover:text-antler-strong">
          {player.name}
        </Link>
        <p className="truncate text-xs text-muted mt-0.5">{subline || "—"}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          {cost !== undefined && <span className="text-sm font-semibold tabular">{formatCost(cost)}</span>}
          {keeperYear !== undefined && <KeeperClockChip keeperYear={keeperYear} status={keeperStatus} />}
        </div>
        {trailing}
      </div>
    </div>
  );
}

/** A titled group of PlayerRows ("Hitters", "Pitchers") with Yahoo-style section header. */
export function PlayerSection({
  title,
  count,
  right,
  children,
}: {
  title: string;
  count?: number;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface overflow-hidden">
      <header className="flex items-center justify-between bg-surface-raised px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <span>
          {title}
          {count !== undefined && <span className="ml-1.5 tabular text-muted/70">{count}</span>}
        </span>
        {right}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

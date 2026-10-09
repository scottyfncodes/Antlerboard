import { Avatar } from "@/components/ui/Avatar";
import { ordinal } from "@/lib/positions";

export interface TeamHeaderStat {
  label: string;
  value: string;
  tone?: "warn";
}

/**
 * Yahoo-style team masthead: logo, team name, manager and record up top, then
 * a strip of headline numbers. Shared by My Team and every other team's page
 * so the two read as the same screen, as they do in the Yahoo app.
 */
export function TeamHeader({
  team,
  standing,
  stats,
  eyebrow,
}: {
  team: { name: string; logoUrl: string | null; manager: { name: string } };
  standing?: { wins: number; losses: number; ties: number; rank: number | null } | null;
  stats: TeamHeaderStat[];
  eyebrow?: string;
}) {
  const record = standing ? `${standing.wins}-${standing.losses}${standing.ties ? `-${standing.ties}` : ""}` : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Avatar name={team.name} imageUrl={team.logoUrl} size="lg" shape="rounded" />
        <div className="min-w-0">
          {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-widest text-antler-strong">{eyebrow}</p>}
          <h1 className="font-display text-2xl leading-tight tracking-tight truncate">{team.name}</h1>
          <p className="text-sm text-muted truncate">
            {team.manager.name}
            {record && <> · <span className="tabular text-foreground">{record}</span></>}
            {standing?.rank && <> · {ordinal(standing.rank)}</>}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-4 divide-x divide-border rounded-xl border border-border bg-surface">
        {stats.map((s) => (
          <div key={s.label} className="px-2 py-2.5 text-center">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">{s.label}</dt>
            <dd className={`mt-0.5 font-display text-lg tabular leading-tight ${s.tone === "warn" ? "text-yellow" : ""}`}>{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

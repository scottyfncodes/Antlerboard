import { SubTabs } from "@/components/ui/SubTabs";

export const LEAGUE_TABS = [
  { key: "standings", href: "/league", label: "Standings" },
  { key: "teams", href: "/teams", label: "Teams" },
  { key: "keepers", href: "/keepers", label: "Keepers" },
  { key: "transactions", href: "/league/transactions", label: "Transactions" },
  { key: "history", href: "/history", label: "History" },
] as const;

export type LeagueTabKey = (typeof LEAGUE_TABS)[number]["key"];

/** Every route that lives under the League hub - drives the nav's active state. */
export const LEAGUE_HUB_PATHS = LEAGUE_TABS.map((t) => t.href);

/**
 * Title + tab strip shared by every page in the League hub, the same way the
 * Yahoo app's League tab fans out into Standings / Teams / Transactions /
 * etc. The pages keep their own URLs so existing links still work.
 */
export function LeagueHeader({ active, description }: { active: LeagueTabKey; description?: string }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-antler-strong">Claw &amp; Antler League</p>
        <h1 className="font-display text-2xl md:text-3xl tracking-tight">League</h1>
      </div>
      <SubTabs tabs={LEAGUE_TABS.map((t) => ({ href: t.href, label: t.label, active: t.key === active }))} />
      {description && <p className="text-sm text-muted max-w-2xl">{description}</p>}
    </div>
  );
}

import type { LucideIcon } from "lucide-react";
import { Home, UserRound, ArrowLeftRight, Users, Trophy, Sprout, Ban, Target, Settings } from "lucide-react";
import type { ManagerRole } from "@/lib/auth/types";
import { LEAGUE_HUB_PATHS } from "@/components/league/LeagueHeader";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra route prefixes that should light this item up (e.g. the League hub's tabs). */
  matches?: readonly string[];
  /** Omit for items every signed-in manager can see; set to restrict a tab. */
  requiresRole?: ManagerRole;
}

/**
 * The bottom bar, ordered like the Yahoo Fantasy app's (My Team / Players /
 * League) so it feels familiar, with Antlerboard's own Board home badge and
 * Trades. Kept to five: a longer bar is unusable at phone width. Everything
 * else lives in the header's menu sheet (MORE_NAV_ITEMS).
 */
export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Board", icon: Home },
  { href: "/my-team", label: "My Team", icon: UserRound },
  { href: "/players", label: "Players", icon: Users },
  { href: "/league", label: "League", icon: Trophy, matches: LEAGUE_HUB_PATHS },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
];

export const MORE_NAV_ITEMS: NavItem[] = [
  { href: "/fypd", label: "FYPD", icon: Sprout },
  { href: "/dpud", label: "DPUD", icon: Ban },
  { href: "/prop-bets", label: "Prop Bets", icon: Target },
  { href: "/commissioner", label: "Commissioner", icon: Settings, requiresRole: "commissioner" },
];

/** Full flat list - used where space isn't a constraint (desktop top nav). */
export const NAV_ITEMS: NavItem[] = [...PRIMARY_NAV_ITEMS, ...MORE_NAV_ITEMS];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/";
  const prefixes = [item.href, ...(item.matches ?? [])];
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Hiding the Commissioner tab is a courtesy, not the security boundary -
 * every commissioner-only page and API route independently re-checks the
 * role itself (see requireCommissioner()). A manager who navigates to
 * /commissioner directly still just sees "access required", not a crash.
 */
export function visibleNavItems(items: NavItem[], role: ManagerRole | undefined): NavItem[] {
  return items.filter((item) => !item.requiresRole || item.requiresRole === role);
}

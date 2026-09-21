import type { LucideIcon } from "lucide-react";
import { Home, UserRound, ArrowLeftRight, Users, Shield, Lock, Sprout, Ban, Target, Trophy, Settings } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * The handful of destinations that earn a permanent slot in the mobile
 * bottom bar. Everything else lives behind "More" - a flat bar of 10+
 * items is unusable at phone width (unreadable labels, cramped tap
 * targets), so this list is deliberately short.
 */
export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Board", icon: Home },
  { href: "/my-team", label: "My Team", icon: UserRound },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
  { href: "/players", label: "Players", icon: Users },
];

export const MORE_NAV_ITEMS: NavItem[] = [
  { href: "/teams", label: "Teams", icon: Shield },
  { href: "/keepers", label: "Keepers", icon: Lock },
  { href: "/fypd", label: "FYPD", icon: Sprout },
  { href: "/dpud", label: "DPUD", icon: Ban },
  { href: "/prop-bets", label: "Prop Bets", icon: Target },
  { href: "/history", label: "History", icon: Trophy },
  { href: "/commissioner", label: "Commissioner", icon: Settings },
];

/** Full flat list - used where space isn't a constraint (desktop top nav). */
export const NAV_ITEMS: NavItem[] = [...PRIMARY_NAV_ITEMS, ...MORE_NAV_ITEMS];

export interface NavItem {
  href: string;
  label: string;
  emoji: string;
}

/**
 * The handful of destinations that earn a permanent slot in the mobile
 * bottom bar. Everything else lives behind "More" - a flat bar of 10+
 * items is unusable at phone width (unreadable labels, cramped tap
 * targets), so this list is deliberately short.
 */
export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Board", emoji: "\u{1F3E0}" },
  { href: "/my-team", label: "My Team", emoji: "\u{1F9E2}" },
  { href: "/trades", label: "Trades", emoji: "\u{1F504}" },
  { href: "/players", label: "Players", emoji: "⚾" },
];

export const MORE_NAV_ITEMS: NavItem[] = [
  { href: "/teams", label: "Teams", emoji: "\u{1F465}" },
  { href: "/keepers", label: "Keepers", emoji: "\u{1F512}" },
  { href: "/fypd", label: "FYPD", emoji: "\u{1F331}" },
  { href: "/dpud", label: "DPUD", emoji: "\u{1F6AB}" },
  { href: "/prop-bets", label: "Prop Bets", emoji: "\u{1F3AF}" },
  { href: "/history", label: "History", emoji: "\u{1F3C6}" },
  { href: "/commissioner", label: "Commissioner", emoji: "\u{2699}\u{FE0F}" },
];

/** Full flat list - used where space isn't a constraint (desktop top nav). */
export const NAV_ITEMS: NavItem[] = [...PRIMARY_NAV_ITEMS, ...MORE_NAV_ITEMS];

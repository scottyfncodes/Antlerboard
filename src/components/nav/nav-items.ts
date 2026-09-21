export interface NavItem {
  href: string;
  label: string;
  emoji: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Board", emoji: "\u{1F3E0}" },
  { href: "/teams", label: "Teams", emoji: "\u{1F465}" },
  { href: "/keepers", label: "Keepers", emoji: "\u{1F512}" },
  { href: "/trades", label: "Trades", emoji: "\u{1F504}" },
  { href: "/players", label: "Players", emoji: "⚾" },
  { href: "/dpud", label: "DPUD", emoji: "\u{1F3AF}" },
  { href: "/history", label: "History", emoji: "\u{1F3C6}" },
];

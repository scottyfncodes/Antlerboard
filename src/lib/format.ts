export function timeAgo(dateInput: string | Date): string {
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "—";
  return `$${cost.toFixed(cost % 1 === 0 ? 0 : 2)}`;
}

export function formatDate(dateInput: string | Date): string {
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const DRAFT_COLOR_HEX: Record<string, string> = {
  RED: "#d9634b",
  ORANGE: "#e0925a",
  YELLOW: "#d9bc55",
  GREEN: "#6faa6a",
  BLUE: "#5a90c9",
};

export const PLAYER_TAG_LABEL: Record<string, string> = {
  KEEPING: "Keeping",
  ON_THE_TABLE: "On the Table",
  MAKE_ME_AN_OFFER: "Make Me an Offer",
  AVAILABLE: "Available",
  NEEDS_DECISION: "Needs Decision",
  FORCED_BACK: "Forced Back",
  RECENTLY_ACQUIRED: "Recently Acquired",
};

export const PLAYER_TAG_COLOR: Record<string, string> = {
  KEEPING: "var(--color-green)",
  ON_THE_TABLE: "var(--color-blue)",
  MAKE_ME_AN_OFFER: "var(--color-antler)",
  AVAILABLE: "var(--color-muted)",
  NEEDS_DECISION: "var(--color-yellow)",
  FORCED_BACK: "var(--color-red)",
  RECENTLY_ACQUIRED: "var(--color-blue)",
};

import clsx from "clsx";

const VARIANT_CLASSES: Record<string, string> = {
  default: "bg-surface-raised text-muted border-border",
  antler: "bg-antler-dim/30 text-antler-strong border-antler-dim",
  green: "bg-green/15 text-green border-green/40",
  blue: "bg-blue/15 text-blue border-blue/40",
  yellow: "bg-yellow/15 text-yellow border-yellow/40",
  red: "bg-red/15 text-red border-red/40",
};

export function Badge({
  children,
  variant = "default",
  className,
}: {
  children: React.ReactNode;
  variant?: keyof typeof VARIANT_CLASSES;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        VARIANT_CLASSES[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

const TAG_VARIANT: Record<string, keyof typeof VARIANT_CLASSES> = {
  KEEPING: "green",
  ON_THE_TABLE: "blue",
  MAKE_ME_AN_OFFER: "antler",
  AVAILABLE: "default",
  NEEDS_DECISION: "yellow",
  FORCED_BACK: "red",
  RECENTLY_ACQUIRED: "blue",
};

export function PlayerTagBadge({ tag, label }: { tag: string; label: string }) {
  return <Badge variant={TAG_VARIANT[tag] ?? "default"}>{label}</Badge>;
}

const DRAFT_COLOR_VARIANT: Record<string, keyof typeof VARIANT_CLASSES> = {
  RED: "red",
  ORANGE: "antler",
  YELLOW: "yellow",
  GREEN: "green",
  BLUE: "blue",
};

export function DraftColorBadge({ color }: { color: string | null }) {
  if (!color) return <Badge variant="default">Skipped</Badge>;
  return <Badge variant={DRAFT_COLOR_VARIANT[color] ?? "default"}>{color[0] + color.slice(1).toLowerCase()}</Badge>;
}

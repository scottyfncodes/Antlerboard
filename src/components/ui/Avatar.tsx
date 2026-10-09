import clsx from "clsx";

/** Stable per-name hue so each team/player keeps the same chip color everywhere. */
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export function initialsFor(name: string): string {
  const words = name
    .replace(/^the\s+/i, "")
    .split(/[\s-]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const SIZE_CLASSES = {
  sm: "h-8 w-8 text-[11px]",
  md: "h-10 w-10 text-xs",
  lg: "h-14 w-14 text-base",
} as const;

/**
 * Initials chip standing in for Yahoo's player headshots / team logos. Uses
 * the real logo when a team has one; otherwise a muted, name-seeded tint so
 * rows are scannable without being loud against the dark theme.
 */
export function Avatar({
  name,
  imageUrl,
  size = "sm",
  shape = "circle",
  className,
}: {
  name: string;
  imageUrl?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  shape?: "circle" | "rounded";
  className?: string;
}) {
  const radius = shape === "circle" ? "rounded-full" : "rounded-xl";
  if (imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={imageUrl} alt="" className={clsx(SIZE_CLASSES[size], radius, "shrink-0 object-cover", className)} />;
  }
  const hue = hueFor(name);
  return (
    <span
      aria-hidden
      className={clsx(SIZE_CLASSES[size], radius, "shrink-0 inline-flex items-center justify-center font-semibold tracking-tight", className)}
      style={{
        backgroundColor: `hsl(${hue} 22% 20%)`,
        color: `hsl(${hue} 45% 78%)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 25% 30%)`,
      }}
    >
      {initialsFor(name)}
    </span>
  );
}

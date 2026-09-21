import clsx from "clsx";
import Link from "next/link";

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("rounded-xl border border-border bg-surface p-4", className)}>
      {children}
    </div>
  );
}

export function CardLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "block rounded-xl border border-border bg-surface p-4 transition-colors hover:border-antler-dim hover:bg-surface-raised",
        className
      )}
    >
      {children}
    </Link>
  );
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <p className="font-display text-lg text-foreground">{title}</p>
      {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
    </div>
  );
}

import Link from "next/link";
import clsx from "clsx";

export interface SubTab {
  href: string;
  label: string;
  active: boolean;
}

/**
 * The horizontally scrolling pill strip that sits under a page title -
 * modelled on the Yahoo Fantasy app's League/Team sub-navigation so it reads
 * as familiar to managers who live in that app. Server-rendered: callers
 * decide which tab is active (pathname or ?tab=), so there's no client JS.
 */
export function SubTabs({ tabs, className }: { tabs: SubTab[]; className?: string }) {
  return (
    <nav
      className={clsx(
        "-mx-4 md:mx-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-border",
        className
      )}
    >
      <ul className="flex w-max gap-1 px-4 md:px-0">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              scroll={false}
              aria-current={tab.active ? "page" : undefined}
              className={clsx(
                "relative block whitespace-nowrap px-3 py-2.5 text-sm font-semibold transition-colors",
                tab.active ? "text-foreground" : "text-muted hover:text-foreground"
              )}
            >
              {tab.label}
              {tab.active && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-antler-strong" />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

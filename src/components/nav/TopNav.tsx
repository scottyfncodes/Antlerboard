"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, visibleNavItems } from "./nav-items";
import clsx from "clsx";
import { AntlerMark } from "./AntlerMark";
import { SearchBox } from "../search/SearchBox";
import type { CurrentManagerSummary } from "@/lib/auth/types";

export function TopNav({ currentManager }: { currentManager: CurrentManagerSummary }) {
  const pathname = usePathname();
  const items = visibleNavItems(NAV_ITEMS, currentManager.role);

  return (
    <header className="hidden lg:block sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto max-w-7xl px-6 py-3 flex items-center gap-3 xl:gap-6">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <AntlerMark className="h-7 w-7 text-antler" />
          <span className="font-display text-lg tracking-tight text-foreground">
            Antlerboard
          </span>
        </Link>
        <nav className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]">
          <ul className="flex items-center gap-0.5 w-max">
            {items.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={clsx(
                      "block px-2.5 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                      active
                        ? "bg-surface-raised text-antler-strong"
                        : "text-muted hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="w-44 xl:w-64 shrink-0">
          <SearchBox />
        </div>
      </div>
    </header>
  );
}

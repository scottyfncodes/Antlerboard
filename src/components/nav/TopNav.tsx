"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, visibleNavItems } from "./nav-items";
import clsx from "clsx";
import { AntlerboardMark } from "@/components/brand/AntlerboardMark";
import { SearchBox } from "../search/SearchBox";
import type { CurrentManagerSummary } from "@/lib/auth/types";

export function TopNav({ currentManager }: { currentManager: CurrentManagerSummary }) {
  const pathname = usePathname();
  const items = visibleNavItems(NAV_ITEMS, currentManager.role);

  return (
    <header className="hidden lg:block sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur shadow-[0_2px_8px_rgba(0,0,0,0.25)]">
      <div className="mx-auto max-w-7xl px-6 py-3 flex items-center gap-3 xl:gap-6">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <AntlerboardMark className="h-8 w-8" />
          <span className="font-display text-lg font-semibold tracking-tight text-foreground">
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
                        ? "bg-surface-raised text-antler-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_8px_-2px_rgba(230,189,110,0.35)]"
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

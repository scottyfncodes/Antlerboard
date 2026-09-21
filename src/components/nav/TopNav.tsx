"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "./nav-items";
import clsx from "clsx";
import { AntlerMark } from "./AntlerMark";
import { SearchBox } from "../search/SearchBox";

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="hidden md:block sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <AntlerMark className="h-7 w-7 text-antler" />
          <span className="font-display text-lg tracking-tight text-foreground">
            Antlerboard
          </span>
        </Link>
        <nav>
          <ul className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={clsx(
                      "px-3 py-2 rounded-md text-sm font-medium transition-colors",
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
        <div className="ml-auto w-72">
          <SearchBox />
        </div>
      </div>
    </header>
  );
}

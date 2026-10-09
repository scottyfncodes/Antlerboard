"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRIMARY_NAV_ITEMS, isNavItemActive } from "./nav-items";
import { HomeBadge } from "./HomeBadge";
import clsx from "clsx";

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80 shadow-[0_-2px_10px_rgba(0,0,0,0.25)] lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item, pathname);
          if (item.href === "/") {
            return (
              <li key={item.href}>
                <HomeBadge active={active} />
              </li>
            );
          }
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "relative flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium tracking-tight transition-colors",
                  active ? "text-antler-strong" : "text-muted"
                )}
              >
                {active && <span className="absolute top-0 h-0.5 w-6 rounded-full bg-antler-strong" />}
                <item.icon className="h-6 w-6" strokeWidth={active ? 2.5 : 2.25} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

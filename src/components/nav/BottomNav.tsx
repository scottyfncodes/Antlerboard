"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { PRIMARY_NAV_ITEMS, MORE_NAV_ITEMS, visibleNavItems } from "./nav-items";
import { HomeBadge } from "./HomeBadge";
import clsx from "clsx";
import type { CurrentManagerSummary } from "@/lib/auth/types";

export function BottomNav({ currentManager }: { currentManager: CurrentManagerSummary }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreItems = visibleNavItems(MORE_NAV_ITEMS, currentManager.role);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const moreActive = moreItems.some((item) => isActive(item.href));

  return (
    <>
      {moreOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
        />
      )}
      {moreOpen && (
        <div className="fixed bottom-16 inset-x-0 z-50 border-t border-border bg-surface lg:hidden rounded-t-xl overflow-hidden">
          <ul className="grid grid-cols-4 gap-1 p-3">
            {moreItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={clsx(
                    "flex flex-col items-center justify-center gap-1.5 rounded-lg px-1 py-3 text-[11px] font-medium transition-colors",
                    isActive(item.href) ? "text-antler-strong bg-surface-raised" : "text-muted"
                  )}
                >
                  <item.icon className="h-6 w-6" strokeWidth={2} />
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <nav
        className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80 shadow-[0_-2px_10px_rgba(0,0,0,0.25)] lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-5">
          {PRIMARY_NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
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
          <li>
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className={clsx(
                "relative flex w-full flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium tracking-tight transition-colors",
                moreOpen || moreActive ? "text-antler-strong" : "text-muted"
              )}
            >
              {(moreOpen || moreActive) && <span className="absolute top-0 h-0.5 w-6 rounded-full bg-antler-strong" />}
              <Menu className="h-6 w-6" strokeWidth={moreOpen || moreActive ? 2.5 : 2.25} />
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

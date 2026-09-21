"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRIMARY_NAV_ITEMS, MORE_NAV_ITEMS } from "./nav-items";
import clsx from "clsx";

export function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const moreActive = MORE_NAV_ITEMS.some((item) => isActive(item.href));

  return (
    <>
      {moreOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      )}
      {moreOpen && (
        <div className="fixed bottom-16 inset-x-0 z-50 border-t border-border bg-surface md:hidden rounded-t-xl overflow-hidden">
          <ul className="grid grid-cols-4 gap-1 p-3">
            {MORE_NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={clsx(
                    "flex flex-col items-center justify-center gap-1 rounded-lg px-1 py-3 text-[11px] font-medium",
                    isActive(item.href) ? "text-antler-strong bg-surface-raised" : "text-muted"
                  )}
                >
                  <span className="text-xl leading-none">{item.emoji}</span>
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <nav
        className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80 md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-5">
          {PRIMARY_NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={clsx(
                  "flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium tracking-tight",
                  isActive(item.href) ? "text-antler-strong" : "text-muted"
                )}
              >
                <span className="text-lg leading-none">{item.emoji}</span>
                <span>{item.label}</span>
              </Link>
            </li>
          ))}
          <li>
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className={clsx(
                "flex w-full flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium tracking-tight",
                moreOpen || moreActive ? "text-antler-strong" : "text-muted"
              )}
            >
              <span className="text-lg leading-none">{"\u{2630}"}</span>
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

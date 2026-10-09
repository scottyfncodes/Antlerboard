"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BellRing, LogOut, X } from "lucide-react";
import clsx from "clsx";
import { Avatar } from "@/components/ui/Avatar";
import { MORE_NAV_ITEMS, isNavItemActive, visibleNavItems } from "./nav-items";
import type { CurrentManagerSummary } from "@/lib/auth/types";

/**
 * The manager's avatar in the header, opening a sheet with the secondary
 * destinations (FYPD, DPUD, Prop Bets, Commissioner), notification settings
 * and Log out - the Yahoo app keeps account + extras behind the profile
 * avatar the same way, which frees the bottom bar for the five main tabs.
 */
export function AccountMenu({ currentManager }: { currentManager: CurrentManagerSummary }) {
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const items = visibleNavItems(MORE_NAV_ITEMS, currentManager.role);
  const highlighted = items.some((item) => isNavItemActive(item, pathname));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Menu"
        aria-expanded={open}
        className={clsx("rounded-full transition-transform active:scale-95", highlighted && "ring-2 ring-antler-strong ring-offset-2 ring-offset-surface")}
      >
        <Avatar name={currentManager.name} size="sm" />
      </button>
      {/* Portalled to <body>: the sticky headers use backdrop-blur, which
          makes them the containing block for position:fixed descendants -
          rendered in place, the sheet would be trapped inside the header. */}
      {open &&
        createPortal(
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
          <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/50" />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-surface lg:inset-x-auto lg:right-6 lg:top-16 lg:bottom-auto lg:w-80 lg:rounded-2xl lg:border"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border lg:hidden" />
            <div className="flex items-center gap-3 px-4 pt-3 pb-4">
              <Avatar name={currentManager.name} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{currentManager.name}</p>
                <p className="text-xs text-muted">{currentManager.role === "commissioner" ? "Commissioner" : "Manager"}</p>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" className="p-1 text-muted hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="grid grid-cols-4 gap-1 border-t border-border px-3 py-3">
              {items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={clsx(
                      "flex flex-col items-center gap-1.5 rounded-lg px-1 py-3 text-[11px] font-medium",
                      isNavItemActive(item, pathname) ? "bg-surface-raised text-antler-strong" : "text-muted hover:text-foreground"
                    )}
                  >
                    <item.icon className="h-6 w-6" strokeWidth={2} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-border py-1">
              <Link
                href="/settings/notifications"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-surface-raised"
              >
                <BellRing className="h-5 w-5 text-muted" /> Notification settings
              </Link>
              <button
                onClick={logout}
                disabled={loggingOut}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm text-red hover:bg-surface-raised disabled:opacity-50"
              >
                <LogOut className="h-5 w-5" /> {loggingOut ? "Logging out…" : "Log out"}
              </button>
            </div>
          </div>
        </div>,
          document.body
        )}
    </>
  );
}

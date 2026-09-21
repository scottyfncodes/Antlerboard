"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { timeAgo } from "@/lib/format";

interface Notif {
  id: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notif[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  async function load() {
    const res = await fetch("/api/notifications");
    if (!res.ok) return;
    const data = await res.json();
    setNotifications(data.notifications ?? []);
    setUnreadCount(data.unreadCount ?? 0);
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function markAllRead() {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAllRead: true }),
    });
    load();
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative text-lg leading-none text-muted hover:text-foreground"
        aria-label="Notifications"
      >
        {"\u{1F514}"}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1.5 min-w-[16px] rounded-full bg-red px-1 text-[10px] font-semibold leading-4 text-white text-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-md border border-border bg-surface-raised shadow-xl z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium">Notifications</span>
            <button onClick={markAllRead} className="text-xs text-antler hover:text-antler-strong">
              Mark all read
            </button>
          </div>
          {notifications.length === 0 && (
            <p className="p-4 text-sm text-muted">You&apos;re all caught up.</p>
          )}
          <ul>
            {notifications.slice(0, 8).map((n) => (
              <li key={n.id} className={clsx("border-b border-border last:border-0", !n.read && "bg-antler-dim/10")}>
                <Link
                  href={n.link ?? "/notifications"}
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2 hover:bg-surface"
                >
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-muted line-clamp-2">{n.body}</p>
                  <p className="text-[10px] text-muted mt-1">{timeAgo(n.createdAt)}</p>
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block text-center text-xs py-2 text-antler hover:text-antler-strong border-t border-border"
          >
            View all
          </Link>
        </div>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";

/**
 * Marks one notification read. Fire-and-forget with keepalive, so the
 * request still completes while the tap navigates away.
 */
export function markNotificationRead(id: string) {
  fetch("/api/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
    keepalive: true,
  }).catch(() => {});
}

/** A notification's link that marks it read when tapped. */
export function NotificationLink({
  id,
  read,
  href,
  className,
  children,
}: {
  id: string;
  read: boolean;
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={className} onClick={() => !read && markNotificationRead(id)}>
      {children}
    </Link>
  );
}

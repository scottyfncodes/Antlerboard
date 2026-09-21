"use client";

import { useEffect, useState } from "react";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_TYPE_META } from "@/lib/notification-types";
import type { NotificationChannel } from "@prisma/client";

interface Pref {
  type: string;
  channel: NotificationChannel;
  enabled: boolean;
}

const CHANNELS: { channel: NotificationChannel; label: string }[] = [
  { channel: "IN_APP", label: "In-App" },
  { channel: "PUSH", label: "Push" },
  { channel: "EMAIL", label: "Email" },
];

export function PreferencesGrid() {
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/notification-preferences")
      .then((r) => r.json())
      .then((data) => {
        setPrefs(data.preferences ?? []);
        setLoading(false);
      });
  }, []);

  function isEnabled(type: string, channel: NotificationChannel) {
    return prefs.find((p) => p.type === type && p.channel === channel)?.enabled ?? false;
  }

  async function toggle(type: string, channel: NotificationChannel) {
    const enabled = !isEnabled(type, channel);
    setPrefs((prev) => {
      const exists = prev.some((p) => p.type === type && p.channel === channel);
      if (exists) {
        return prev.map((p) => (p.type === type && p.channel === channel ? { ...p, enabled } : p));
      }
      return [...prev, { type, channel, enabled }];
    });
    await fetch("/api/notification-preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, channel, enabled }),
    });
  }

  if (loading) return <p className="text-sm text-muted">Loading preferences…</p>;

  return (
    <div className="space-y-6">
      {NOTIFICATION_CATEGORIES.map((category) => (
        <section key={category}>
          <h3 className="font-display text-sm tracking-wide text-antler-strong mb-2">{category}</h3>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-raised text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Notification</th>
                  {CHANNELS.map((c) => (
                    <th key={c.channel} className="px-3 py-2 font-medium text-center w-16">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_TYPE_META.filter((m) => m.category === category).map((meta) => (
                  <tr key={meta.type} className="border-t border-border">
                    <td className="px-3 py-2">{meta.label}</td>
                    {CHANNELS.map((c) => (
                      <td key={c.channel} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={isEnabled(meta.type, c.channel)}
                          onChange={() => toggle(meta.type, c.channel)}
                          className="h-4 w-4 accent-[#c9a15a]"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

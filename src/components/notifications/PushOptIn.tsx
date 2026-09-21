"use client";

import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function PushOptIn({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
  }, []);

  async function enable() {
    if (!vapidPublicKey) return;
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
    } finally {
      setBusy(false);
    }
  }

  if (permission === "unsupported") {
    return <p className="text-sm text-muted">Push notifications aren&apos;t supported in this browser.</p>;
  }

  if (!vapidPublicKey) {
    return (
      <p className="text-sm text-muted">
        Push notifications aren&apos;t configured for this deployment yet (missing VAPID keys). In-app
        notifications still work fully.
      </p>
    );
  }

  if (permission === "granted") {
    return <p className="text-sm text-success">Push notifications are enabled on this device.</p>;
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-2">
      <p className="text-sm">
        Turn on push notifications to get keeper deadline alerts, trade activity, and DPUD updates even
        when Antlerboard isn&apos;t open. You can turn this off again any time.
      </p>
      <button
        onClick={enable}
        disabled={busy}
        className="rounded-md bg-antler px-3 py-1.5 text-sm font-medium text-[#1a1305] hover:bg-antler-strong disabled:opacity-50"
      >
        {busy ? "Enabling…" : "Enable push notifications"}
      </button>
    </div>
  );
}
